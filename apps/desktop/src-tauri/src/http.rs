//! 极简 HTTPS 客户端，走系统自带的 WinHTTP。
//!
//! **为什么是 WinHTTP 而不是 reqwest**：本项目的联网出口只有账号登录和 git 同步两处，
//! 为此引入 reqwest 会连带 hyper / tower / 一整套 TLS 栈进编译图（实测当前 797 个 rlib 里
//! 一个都没有，全是新增），既有违 AGENTS.md 的依赖约束，也会拖慢打包。
//! WinHTTP 的 TLS 与系统代理都由 Windows 提供，代价只是下面这一百多行 FFI。
//!
//! **阻塞式**：与 `proc::run_direct` 起子进程同一风格 —— 调用方都是 `#[tauri::command(async)]`，
//! 函数体落在工作线程上，不占主线程。
//!
//! 只做这一件事：发一个请求、拿回状态码、两个用得上的响应头（ETag / Location）与响应体。
//! 不改编码。旧入口沿用 WinHTTP 默认重定向策略；带机密请求头且不得跳转的调用方必须用
//! `request_url_no_redirects`，在发送前明确关闭自动重定向。

use std::ffi::c_void;

use windows_sys::Win32::Networking::WinHttp::{
    WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
    WINHTTP_ADDREQ_FLAG_ADD, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
    WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_ETAG,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_LOCATION, WINHTTP_QUERY_STATUS_CODE,
};

use crate::encoding::wide;

/// 443 / 80。WinHTTP 要的是端口号而不是「默认端口」标记。
const HTTPS_PORT: u16 = 443;
const HTTP_PORT: u16 = 80;

/// 超时（毫秒）：DNS 解析 / 建连 / 发送 / 接收。
/// 登录是用户点完按钮在等的交互，失败得快比让人干等半分钟有用。
const TIMEOUT_RESOLVE: i32 = 5_000;
const TIMEOUT_CONNECT: i32 = 8_000;
const TIMEOUT_SEND: i32 = 10_000;
const TIMEOUT_RECEIVE: i32 = 15_000;

/// 普通（收完返回）请求用的超时组，与 [`STREAM_TIMEOUTS`] 相对。
const DEFAULT_TIMEOUTS: [i32; 4] = [
    TIMEOUT_RESOLVE,
    TIMEOUT_CONNECT,
    TIMEOUT_SEND,
    TIMEOUT_RECEIVE,
];

/// 响应体上限。OAuth 回包都是几百字节；AI 那边拉一次模型目录（几百个模型、每个一串元数据）
/// 能到几 MB，所以这个阀门给到 8 MiB —— 再大说明对面不对劲，别一直收。
const MAX_BODY: usize = 8 << 20;

pub struct Response {
    pub status: u16,
    /// 原始字节。JSON 走 `text()`，图片（头像）直接读这个 ——
    /// 用 `String::from_utf8_lossy` 收二进制会把字节改掉，解出来的图是坏的。
    pub body: Vec<u8>,
    /// 响应头里的 ETag（条件请求的增量校验用）。服务端没给时是 None。
    pub etag: Option<String>,
    /// 响应头里的 Location（3xx 才有的那一跳）。跟着跳的调用方拿它发下一个请求。
    pub location: Option<String>,
}

impl Response {
    /// 响应体按 UTF-8 当文本看。OAuth 的回包都是 JSON。
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// 句柄的 RAII 包装。WinHTTP 三个句柄都要手动关，而下面有六七处提前返回 ——
/// 挨个手写 close 迟早漏一个，漏的就是句柄泄漏。
///
/// 关闭顺序靠**声明顺序**保证：WinHTTP 要求先关 request 再关 connection 再关 session，
/// 而 Rust 的局部变量正好按声明的逆序析构。
struct Handle(*mut c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

/// 发一个 HTTPS 请求。`host` 不带协议（如 `github.com`），`path` 要带前导斜杠。
pub fn request(
    method: &str,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<Response, String> {
    send(
        &RequestSpec {
            method,
            host,
            port: HTTPS_PORT,
            secure: true,
            path,
            headers,
            body,
            no_redirects: false,
            timeouts: DEFAULT_TIMEOUTS,
        },
        Sink::Buffer { max_body: MAX_BODY },
    )
}

/// 发一个请求到**用户自己填的地址**：http / https 都认，端口与路径照原样走
/// （AI 服务的模型列表那一趟用它 —— 本机服务长这样：`http://localhost:11434/v1`）。
///
/// 与上面那个的差别只有一处：`request` 是「HTTPS + 443 + 主机名」的固定形状（登录那几家的
/// 地址是钉死在代码里的），这一个才需要解析 URL。
pub fn request_url(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<Response, String> {
    request_url_limited(method, url, headers, body, MAX_BODY)
}

/// 同上，只是响应体上限由调用方给：**下技能包**那种几 MB 到几十 MB 的二进制走它
/// （`MAX_BODY` 那个 8 MiB 的阀门是给 JSON 与小图用的）。
pub fn request_url_limited(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
    max_body: usize,
) -> Result<Response, String> {
    let (secure, host, port, path) = split_url(url)?;
    send(
        &RequestSpec {
            method,
            host: &host,
            port,
            secure,
            path: &path,
            headers,
            body,
            no_redirects: false,
            timeouts: DEFAULT_TIMEOUTS,
        },
        Sink::Buffer { max_body },
    )
}

/// 带机密请求头的单次请求：发送前关闭 WinHTTP 自动跳转，3xx 原样返回给调用方拒绝。
/// 独立入口不改变旧调用的系统默认策略。
pub fn request_url_no_redirects(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<Response, String> {
    // 独立入口用现有 url crate 拆分，也支持用户端点里的 IPv6 字面量。
    let parsed = url::Url::parse(url).map_err(|_| "HTTP 地址无效".to_string())?;
    let secure = match parsed.scheme() {
        "https" => true,
        "http" => false,
        _ => return Err("地址要以 http:// 或 https:// 开头".into()),
    };
    let host = parsed.host_str().ok_or("地址里没有主机名")?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = parsed.port_or_known_default().ok_or("HTTP 端口无效")?;
    let mut path = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    send(
        &RequestSpec {
            method,
            host,
            port,
            secure,
            path: &path,
            headers,
            body,
            no_redirects: true,
            timeouts: DEFAULT_TIMEOUTS,
        },
        Sink::Buffer { max_body: MAX_BODY },
    )
}

/// URL → WinHTTP 要的那四样（协议 / 主机 / 端口 / 路径）。只认 http 与 https，
/// 认不出的当场说清楚 —— 这一步的错都来自用户手填的地址，提示要能直接照着改。
/// 查询串（`?a=b`）留在路径里一起给 WinHTTP，它自己会拆。
fn split_url(url: &str) -> Result<(bool, String, u16, String), String> {
    let text = url.trim();
    let (secure, rest) = match text.split_once("://") {
        Some(("https", rest)) => (true, rest),
        Some(("http", rest)) => (false, rest),
        _ => return Err(format!("地址要以 http:// 或 https:// 开头：{url}")),
    };

    // 主机与路径的分界是第一个斜杠；没有路径就是根
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err(format!("地址里没有主机名：{url}"));
    }

    // 端口：只认 `主机:端口` 这一种写法（用户填得出 IPv6 字面量的场合不在这里）
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => match port.parse::<u16>() {
            Ok(port) if !host.is_empty() => (host.to_string(), port),
            _ => return Err(format!("端口不像是数字：{url}")),
        },
        None => (
            authority.to_string(),
            if secure { HTTPS_PORT } else { HTTP_PORT },
        ),
    };

    Ok((secure, host, port, path.to_string()))
}

/// 流式请求的超时（毫秒）：解析 / 建连 / 发送 / 接收。
///
/// 与上面那组分开是必须的：对话的首字节可能等十几秒、整段可能跑几分钟，
/// 15 秒的接收超时会把正常回答打断。这里给到 5 分钟的静默容忍 —— 超过它说明对面
/// 真的不动了，而不是模型在思考。
const STREAM_TIMEOUTS: [i32; 4] = [30_000, 30_000, 60_000, 300_000];

/// 一次请求的固定形状。参数本来有九个，与其继续堆位置参数，不如摆成结构体 ——
/// 调用处也因此读得出哪个是哪个。
struct RequestSpec<'a> {
    method: &'a str,
    host: &'a str,
    port: u16,
    secure: bool,
    path: &'a str,
    headers: &'a [(&'a str, &'a str)],
    body: Option<&'a str>,
    no_redirects: bool,
    timeouts: [i32; 4],
}

/// 响应体往哪儿去。
enum Sink<'a> {
    /// 收完再返回；超过 `max_body` 就中止
    Buffer { max_body: usize },
    /// 边到边交出去。`on_head` 在**正文之前**给出状态码 ——
    /// 流式的调用方要拿状态码决定回给自己客户端的是 200 的流还是一段错误 JSON。
    /// `on_chunk` 返回 false 表示别再读了。
    /// **不设上限**：一段长回答本来就是无限的。
    Stream {
        on_head: &'a mut dyn FnMut(u16),
        on_chunk: &'a mut dyn FnMut(&[u8]) -> bool,
    },
}

impl Sink<'_> {
    /// 状态码到了。只有流式那一档在意。
    fn announce(&mut self, status: u16) {
        if let Sink::Stream { on_head, .. } = self {
            on_head(status);
        }
    }

    /// 收下一片。返回是否继续读。
    fn feed(&mut self, piece: &[u8], seen: &mut Vec<u8>) -> Result<bool, String> {
        match self {
            Sink::Buffer { max_body } => {
                seen.extend_from_slice(piece);
                if seen.len() > *max_body {
                    return Err("响应内容过大，已中止".into());
                }
                Ok(true)
            }
            Sink::Stream { on_chunk, .. } => Ok(on_chunk(piece)),
        }
    }
}

/// 真正发请求的那一段：会话 → 连接 → 请求 → 把响应体交给 `sink`。
fn send(spec: &RequestSpec<'_>, sink: Sink<'_>) -> Result<Response, String> {
    let agent = wide("Workbench");
    let host_w = wide(spec.host);
    let method_w = wide(spec.method);
    let path_w = wide(spec.path);
    let mut sink = sink;

    unsafe {
        let session = Handle(WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        check(session.0, "初始化 HTTP 会话失败")?;
        WinHttpSetTimeouts(
            session.0,
            spec.timeouts[0],
            spec.timeouts[1],
            spec.timeouts[2],
            spec.timeouts[3],
        );

        let connection = Handle(WinHttpConnect(session.0, host_w.as_ptr(), spec.port, 0));
        check(connection.0, &format!("连接 {} 失败", spec.host))?;

        // 第 6 个参数是 Accept 类型列表，传 null 表示默认（application/json 我们自己加）
        let request = Handle(WinHttpOpenRequest(
            connection.0,
            method_w.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            // 只有 https 才要这一位；http 的明文连接加上它反而谈不起来
            if spec.secure {
                WINHTTP_FLAG_SECURE
            } else {
                0
            },
        ));
        check(request.0, "构造请求失败")?;

        if spec.no_redirects {
            let policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
            let set = WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_REDIRECT_POLICY,
                &policy as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );
            // 设置失败就不发送，不能退回可能把 Token 带到另一站的默认策略。
            check_bool(set, "关闭 HTTP 重定向失败")?;
        }

        if !spec.headers.is_empty() {
            // WinHTTP 要的是一整块 CRLF 分隔的 header 文本
            let text = spec
                .headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}"))
                .collect::<Vec<_>>()
                .join("\r\n");
            let text_w = wide(&text);
            // dwHeadersLength 传 -1 表示「按 0 结尾算长度」
            let added = WinHttpAddRequestHeaders(
                request.0,
                text_w.as_ptr(),
                u32::MAX,
                WINHTTP_ADDREQ_FLAG_ADD,
            );
            check_bool(added, "设置请求头失败")?;
        }

        let payload = spec.body.unwrap_or("").as_bytes();
        let sent = WinHttpSendRequest(
            request.0,
            std::ptr::null(),
            0,
            payload.as_ptr() as *const c_void,
            payload.len() as u32,
            payload.len() as u32,
            0,
        );
        check_bool(sent, "发送请求失败")?;

        let received = WinHttpReceiveResponse(request.0, std::ptr::null_mut());
        check_bool(received, "读取响应失败")?;

        let mut status: u32 = 0;
        let mut length = std::mem::size_of::<u32>() as u32;
        let queried = WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            &mut status as *mut u32 as *mut c_void,
            &mut length,
            std::ptr::null_mut(),
        );
        check_bool(queried, "读取状态码失败")?;
        let status = status as u16;

        // ETag 与 Location：查询失败都**不算请求失败** —— 服务端没给某个头是常有的事，
        // 返回 None 交给调用方（Location 只有 3xx 才有，其余时候本来就该是 None）。
        let etag = header(request.0, WINHTTP_QUERY_ETAG);
        let location = header(request.0, WINHTTP_QUERY_LOCATION);

        // 状态码先出去：流式的调用方要凭它决定回 200 还是回错误
        sink.announce(status);

        let mut bytes: Vec<u8> = Vec::new();
        loop {
            let mut available: u32 = 0;
            let probed = WinHttpQueryDataAvailable(request.0, &mut available);
            check_bool(probed, "读取响应长度失败")?;
            if available == 0 {
                break;
            }

            let size = available.min(64 * 1024);
            let mut chunk = vec![0u8; size as usize];
            let mut read: u32 = 0;
            let got = WinHttpReadData(
                request.0,
                chunk.as_mut_ptr() as *mut c_void,
                size,
                &mut read,
            );
            check_bool(got, "读取响应内容失败")?;
            if read == 0 {
                break;
            }

            if !sink.feed(&chunk[..read as usize], &mut bytes)? {
                break;
            }
        }

        Ok(Response {
            status,
            body: bytes,
            etag,
            location,
        })
    }
}

/// 流式请求：响应体一到就交给 `on_chunk`，不在内存里攒。
///
/// `on_head` 在正文之前收到状态码 —— 这是流式调用方唯一能"先判断再决定怎么写"的机会。
/// **只返回状态码**：这种调用方式下响应体已经在回调里消费掉了，返回一个空 body 的
/// [`Response`] 只会让调用方以为「响应是空的」。
///
/// 关掉自动重定向：带着账号 token 的请求被 302 到别处是事故，不是便利。
pub fn request_url_stream(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
    on_head: &mut dyn FnMut(u16),
    on_chunk: &mut dyn FnMut(&[u8]) -> bool,
) -> Result<u16, String> {
    let (secure, host, port, path) = split_url(url)?;
    let spec = RequestSpec {
        method,
        host: &host,
        port,
        secure,
        path: &path,
        headers,
        body,
        no_redirects: true,
        timeouts: STREAM_TIMEOUTS,
    };
    let response = send(
        &spec,
        Sink::Stream { on_head, on_chunk },
    )?;
    Ok(response.status)
}

/// 查一个标准响应头（ETag / Location 这类按索引查的）。**查不到不是错误**：返回 None。
fn header(request: *mut c_void, level: u32) -> Option<String> {
    query_header(request, level, std::ptr::null())
}

/// 两步：先问尺寸（WinHTTP 要一块够大的缓冲），再取内容 —— 值本身是宽字符，
/// 长度按字节给（含结尾的 0）。
fn query_header(request: *mut c_void, level: u32, name: *const u16) -> Option<String> {
    unsafe {
        let mut size: u32 = 0;
        let _ = WinHttpQueryHeaders(
            request,
            level,
            name,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
        );
        if size < 2 {
            return None;
        }

        let mut buffer = vec![0u16; size as usize];
        let mut length = size;
        let found = WinHttpQueryHeaders(
            request,
            level,
            name,
            buffer.as_mut_ptr() as *mut c_void,
            &mut length,
            std::ptr::null_mut(),
        );
        if found == 0 || length < 2 {
            return None;
        }
        // 从 WinHTTP 压回来的值默认就是完整一头的，按第一个 0 截断再收
        Some(utf16_to_string(&buffer))
    }
}

/// WinHTTP 查头返回的宽字符缓冲 → UTF-8 String。按第一个 0 截断，
/// 防服务端压回来的缓冲在文本后面还带一段没清干净的尾巴。
fn utf16_to_string(buffer: &[u16]) -> String {
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

/// WinHTTP 的句柄返回值：空句柄即失败，原因在 `GetLastError` 里。
fn check(handle: *mut c_void, what: &str) -> Result<(), String> {
    if handle.is_null() {
        Err(fail(what))
    } else {
        Ok(())
    }
}

/// Win32 的 `BOOL` 返回值：0 即失败
fn check_bool(value: i32, what: &str) -> Result<(), String> {
    if value == 0 {
        Err(fail(what))
    } else {
        Ok(())
    }
}

/// 把 Win32 的错误码翻成一句中文。0 表示「没给出更具体的原因」，
/// 这时只说失败了，别硬编一个「操作成功」出来误导人。
fn fail(what: &str) -> String {
    let err = std::io::Error::last_os_error();
    let code = err.raw_os_error().unwrap_or(0);
    if code == 0 {
        format!("{what}（网络不可达或被防火墙拦下）")
    } else {
        format!("{what}: {err}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真发一个请求。靶子用 example.com：IANA 的保留域名，不需要凭据、不限流，永远 200。
    /// 别换回 GitHub 的根接口 —— 它按 IP 限流未认证请求（60 次/小时），CI 的 runner 是共享 IP，
    /// 常年直接 403，与 WinHTTP 本身好不好使无关。
    /// 没网就跳过 —— 与 sync.rs 里「本机没有 git 就跳过」同一约定。
    #[test]
    fn fetches_a_real_https_endpoint() {
        let response = request(
            "GET",
            "example.com",
            "/",
            &[("User-Agent", "Workbench")],
            None,
        );

        let response = match response {
            Ok(response) => response,
            Err(err) => {
                println!("跳过：本机访问不了 example.com（{err}）");
                return;
            }
        };

        let text = response.text();
        assert_eq!(response.status, 200, "响应不像 example.com: {text}");
        assert!(
            text.contains("Example Domain"),
            "响应体不像 example.com 的首页: {text}"
        );
    }

    /// 连不上的域名要报错而不是挂住 —— 超时那一路的兜底
    #[test]
    fn reports_failure_for_an_unreachable_host() {
        let result = request("GET", "this-host-should-not-exist.invalid", "/", &[], None);
        assert!(result.is_err());
    }

    /// 用户填的地址 → 协议 / 主机 / 端口 / 路径：https 默认 443、http 默认 80，
    /// 带端口的本机服务与带查询串的路径都照原样走
    #[test]
    fn urls_are_split_into_winhttp_parts() {
        let split = |url| split_url(url).unwrap();
        assert_eq!(
            split("https://api.deepseek.com/v1"),
            (true, "api.deepseek.com".into(), 443, "/v1".into())
        );
        assert_eq!(
            split("https://api.deepseek.com/v1/"),
            (true, "api.deepseek.com".into(), 443, "/v1/".into())
        );
        assert_eq!(
            split("https://api.deepseek.com"),
            (true, "api.deepseek.com".into(), 443, "/".into())
        );
        assert_eq!(
            split("http://localhost:11434/v1"),
            (false, "localhost".into(), 11434, "/v1".into())
        );
        assert_eq!(
            split("  http://127.0.0.1:8080/models?limit=10 "),
            (false, "127.0.0.1".into(), 8080, "/models?limit=10".into())
        );

        // 手填错的地址要说清楚错在哪儿（这几个提示会直接显示给用户）
        assert!(split_url("api.deepseek.com/v1").is_err(), "缺协议要挡住");
        assert!(split_url("https:///v1").is_err(), "没有主机名要挡住");
        assert!(split_url("https://x:端口/v1").is_err(), "端口不是数字要挡住");
    }
}
