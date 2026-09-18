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
//! 只做这一件事：发一个请求、拿回状态码和响应体。不跟重定向、不解析响应头、不改编码。

use std::ffi::c_void;

use windows_sys::Win32::Networking::WinHttp::{
    WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
    WINHTTP_ADDREQ_FLAG_ADD, WINHTTP_FLAG_SECURE, WINHTTP_QUERY_ETAG, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_STATUS_CODE,
};

use crate::encoding::wide;

/// 443。WinHTTP 要的是端口号而不是「默认端口」标记。
const HTTPS_PORT: u16 = 443;

/// 超时（毫秒）：DNS 解析 / 建连 / 发送 / 接收。
/// 登录是用户点完按钮在等的交互，失败得快比让人干等半分钟有用。
const TIMEOUT_RESOLVE: i32 = 5_000;
const TIMEOUT_CONNECT: i32 = 8_000;
const TIMEOUT_SEND: i32 = 10_000;
const TIMEOUT_RECEIVE: i32 = 15_000;

/// 响应体上限。OAuth 回包都是几百字节，超过这个数说明对面不对劲，别一直收。
const MAX_BODY: usize = 1 << 20;

pub struct Response {
    pub status: u16,
    /// 原始字节。JSON 走 `text()`，图片（头像）直接读这个 ——
    /// 用 `String::from_utf8_lossy` 收二进制会把字节改掉，解出来的图是坏的。
    pub body: Vec<u8>,
    /// 响应头里的 ETag（条件请求的增量校验用）。服务端没给时是 None。
    pub etag: Option<String>,
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
    let agent = wide("Workbench");
    let host_w = wide(host);
    let method_w = wide(method);
    let path_w = wide(path);

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
            TIMEOUT_RESOLVE,
            TIMEOUT_CONNECT,
            TIMEOUT_SEND,
            TIMEOUT_RECEIVE,
        );

        let connection = Handle(WinHttpConnect(session.0, host_w.as_ptr(), HTTPS_PORT, 0));
        check(connection.0, &format!("连接 {host} 失败"))?;

        // 第 6 个参数是 Accept 类型列表，传 null 表示默认（application/json 我们自己加）
        let request = Handle(WinHttpOpenRequest(
            connection.0,
            method_w.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ));
        check(request.0, "构造请求失败")?;

        if !headers.is_empty() {
            // WinHTTP 要的是一整块 CRLF 分隔的 header 文本
            let text = headers
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

        let payload = body.unwrap_or("").as_bytes();
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

        // ETag：条件请求的依据。查询要一块缓冲，WinHTTP 需要先问一次尺寸。
        // 这一处失败不算请求失败 —— 服务端没给 ETag 是常有的事，返回 None 交给调用方。
        let mut etag = None;
        let mut etag_size: u32 = 0;
        let _ = WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_ETAG,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut etag_size,
            std::ptr::null_mut(),
        );
        if etag_size > 0 {
            // WINHTTP_QUERY_ETAG 返回的是宽字符，长度按字节给（含结尾的 0）
            let mut buffer = vec![0u16; etag_size as usize];
            let mut length = etag_size;
            let found = WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_ETAG,
                std::ptr::null(),
                buffer.as_mut_ptr() as *mut c_void,
                &mut length,
                std::ptr::null_mut(),
            );
            if found > 0 && length >= 2 {
                // 去掉结尾的 0 再按 UTF-16 收；从 WinHTTP 压回来的值默认就是完整一头的
                etag = Some(utf16_to_string(&buffer));
            }
        }

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

            bytes.extend_from_slice(&chunk[..read as usize]);
            if bytes.len() > MAX_BODY {
                return Err("响应内容过大，已中止".into());
            }
        }

        Ok(Response {
            status,
            body: bytes,
            etag,
        })
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

    /// 真发一个请求。GitHub 的 404 页不需要凭据，也永远存在，正好当靶子。
    /// 没网就跳过 —— 与 sync.rs 里「本机没有 git 就跳过」同一约定。
    #[test]
    fn fetches_a_real_https_endpoint() {
        let response = request(
            "GET",
            "api.github.com",
            "/",
            &[("Accept", "application/json"), ("User-Agent", "Workbench")],
            None,
        );

        let response = match response {
            Ok(response) => response,
            Err(err) => {
                println!("跳过：本机访问不了 api.github.com（{err}）");
                return;
            }
        };

        assert_eq!(response.status, 200);
        assert!(
            response.text().contains("current_user_url"),
            "响应体不像 GitHub 的根接口: {}",
            response.text()
        );
    }

    /// 连不上的域名要报错而不是挂住 —— 超时那一路的兜底
    #[test]
    fn reports_failure_for_an_unreachable_host() {
        let result = request("GET", "this-host-should-not-exist.invalid", "/", &[], None);
        assert!(result.is_err());
    }
}
