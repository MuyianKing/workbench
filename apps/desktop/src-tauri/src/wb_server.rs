//! 本地 HTTP/1.1 服务：网关的入口那一侧。
//!
//! 只用 `std::net`，一线程一连接，不引框架。理由与 `oauth.rs` 里那个回调服务器一致：
//! 要服务的只有一个本机客户端（Pi），并发是「同时几条对话」的量级，不是互联网服务。
//!
//! **只绑 `127.0.0.1`**：这不只是默认值，是设计。网关带着账号 token，
//! 任何监听 `0.0.0.0` 的版本都不该存在。
//!
//! 解析与写响应都是纯函数式的（吃 `BufRead` / `Write`），所以能用内存缓冲直接单测，
//! 不必真开端口。

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// 一次连接最多服务多少个请求（keep-alive）。客户端复用连接是常态，
/// 但总得有个上限 —— 否则被一个不关连接的对端吊住、线程永不退出。
const MAX_KEEPALIVE: usize = 64;

/// 同时处理的连接上限。对话是长连接，几条并发的额度就够；
/// 再多说明不对劲，直接拒掉比把线程堆爆强。
const MAX_CONNECTIONS: usize = 32;

/// 单次读的超时：决定一个卡住的连接多久后被回收。
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// 请求体上限 16 MiB：比最大的上下文还宽松，但挡得住明显的异常。
const MAX_BODY: usize = 16 << 20;

/// 没带 Content-Length 的请求体最多读这么多（GET 正常没有体）
const MAX_HEAD: usize = 64 << 10;

// ---------- 请求 ----------

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// 不含查询串
    pub path: String,
    /// `?` 之后的部分（含 `&`），没有就是空串
    #[allow(dead_code)]
    pub query: String,
    /// 名字统一小写，方便查
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[allow(dead_code)] // query_param / text 由后续的管理端点接入
impl Request {
    /// 取一个请求头（名字大小写不敏感）。
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// 取一个查询参数。只做最朴素的解码：网关自己那几个参数都不带转义。
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key == name).then_some(value)
        })
    }

    /// 请求体按 UTF-8 看。
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// 从一条流里读一个请求。返回 `Ok(None)` 表示对端正常关闭了连接。
pub fn read_request<R: BufRead>(reader: &mut R) -> Result<Option<Request>, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|err| format!("读取请求行失败: {err}"))?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        // 上一轮 keep-alive 之后可能残留空行
        if trimmed.is_empty() {
            continue;
        }
        break;
    }

    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_uppercase();
    let target = parts.next().unwrap_or("/");
    if method.is_empty() {
        return Err("请求行缺少方法".into());
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.to_string(), String::new()),
    };

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut head_bytes = 0usize;
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|err| format!("读取请求头失败: {err}"))?;
        if read == 0 {
            return Err("请求头被截断".into());
        }
        head_bytes += read;
        if head_bytes > MAX_HEAD {
            return Err("请求头过大".into());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }

    let length = headers
        .iter()
        .find(|(key, _)| key == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err(format!("请求体过大：{length} 字节"));
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|err| format!("读取请求体失败: {err}"))?;
    }

    Ok(Some(Request {
        method,
        path,
        query,
        headers,
        body,
    }))
}

// ---------- 响应 ----------

/// 响应体。流式那一档把写的能力交给闭包 —— 对话就是这样一段一段推出去的。
/// 流式响应的写出闭包：拿一个分块写入器，自己往里推。
pub type StreamWriter = Box<dyn FnOnce(&mut ChunkedWriter<'_>) -> Result<(), String>>;

pub enum Body {
    Bytes(Vec<u8>),
    Stream(StreamWriter),
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Body,
}

impl Response {
    pub fn json(value: &serde_json::Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json; charset=utf-8".to_string(),
            body: Body::Bytes(value.to_string().into_bytes()),
        }
    }

    pub fn text(status: u16, message: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8".to_string(),
            body: Body::Bytes(message.as_bytes().to_vec()),
        }
    }

    /// OpenAI 形状的错误体。
    pub fn error(status: u16, kind: &str, message: &str) -> Self {
        Self::json(&serde_json::json!({
            "error": { "message": message, "type": kind, "code": status }
        }))
        .with_status(status)
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    /// 服务端事件流。
    pub fn sse<F>(emit: F) -> Self
    where
        F: FnOnce(&mut ChunkedWriter<'_>) -> Result<(), String> + 'static,
    {
        Self {
            status: 200,
            content_type: "text/event-stream; charset=utf-8".to_string(),
            body: Body::Stream(Box::new(emit)),
        }
    }
}

/// 分块写。SSE 不能预先给出长度，只能 chunked。
pub struct ChunkedWriter<'a> {
    out: &'a mut dyn Write,
}

impl ChunkedWriter<'_> {
    /// 写一块并立刻 flush —— 不 flush 的话 SSE 会攒在缓冲区里，
    /// 客户端看到的是「一秒钟蹦出整段回答」。
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let head = format!("{:x}\r\n", bytes.len());
        self.out
            .write_all(head.as_bytes())
            .and_then(|_| self.out.write_all(bytes))
            .and_then(|_| self.out.write_all(b"\r\n"))
            .and_then(|_| self.out.flush())
            .map_err(|err| format!("写出响应失败: {err}"))
    }

    pub fn write_text(&mut self, text: &str) -> Result<(), String> {
        self.write_chunk(text.as_bytes())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.out
            .write_all(b"0\r\n\r\n")
            .and_then(|_| self.out.flush())
            .map_err(|err| format!("结束响应失败: {err}"))
    }
}

/// 拼响应头。抽成纯函数是为了能直接断言（`\r\n` 与大小写这类事只能靠字符串验）。
pub fn response_head(status: u16, content_type: &str, length: Option<usize>, keep_alive: bool) -> String {
    let mut head = String::with_capacity(160);
    head.push_str(&format!("HTTP/1.1 {status} {}\r\n", reason(status)));
    head.push_str(&format!("Content-Type: {content_type}\r\n"));
    match length {
        Some(length) => head.push_str(&format!("Content-Length: {length}\r\n")),
        None => head.push_str("Transfer-Encoding: chunked\r\n"),
    }
    head.push_str("Cache-Control: no-store\r\n");
    if keep_alive {
        head.push_str("Connection: keep-alive\r\n");
    } else {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    head
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

/// 把一个响应写到流里。`keep_alive` 由调用方按请求头决定。
pub fn write_response<W: Write>(
    out: &mut W,
    response: Response,
    keep_alive: bool,
) -> Result<(), String> {
    match response.body {
        Body::Bytes(bytes) => {
            let head = response_head(response.status, &response.content_type, Some(bytes.len()), keep_alive);
            out.write_all(head.as_bytes())
                .and_then(|_| out.write_all(&bytes))
                .and_then(|_| out.flush())
                .map_err(|err| format!("写出响应失败: {err}"))
        }
        Body::Stream(emit) => {
            let head = response_head(response.status, &response.content_type, None, keep_alive);
            out.write_all(head.as_bytes())
                .and_then(|_| out.flush())
                .map_err(|err| format!("写出响应失败: {err}"))?;
            let mut writer = ChunkedWriter { out };
            emit(&mut writer)?;
            writer.finish()
        }
    }
}

// ---------- 服务 ----------

/// 处理函数：吃请求、吐响应。实现方不该在这里阻塞太久，否则会占住这条连接的线程。
pub type Handler = Arc<dyn Fn(&Request) -> Response + Send + Sync>;

pub struct Server {
    stop: Arc<AtomicBool>,
    port: u16,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// 绑端口并起服务线程。端口被占时**当场报错**，不静默换端口 ——
    /// 换掉之后调用方填的地址就成了错的，比起不来更难查。
    pub fn start(port: u16, handler: Handler) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .map_err(|err| format!("端口 {port} 绑不上：{err}（可能已被占用）"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("设置非阻塞失败: {err}"))?;
        // 传 0 时由系统分配：把真实端口记下来，否则界面拿到的会是 0
        let port = listener
            .local_addr()
            .map_err(|err| format!("读取监听端口失败: {err}"))?
            .port();

        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let live = Arc::new(AtomicUsize::new(0));

        let thread = std::thread::Builder::new()
            .name("wb-gateway".into())
            .spawn(move || accept_loop(listener, handler, flag, live))
            .map_err(|err| format!("网关线程起不来: {err}"))?;

        Ok(Self {
            stop,
            port,
            thread: Some(thread),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 停掉服务并等线程退出。重复调用无害。
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(
    listener: TcpListener,
    handler: Handler,
    stop: Arc<AtomicBool>,
    live: Arc<AtomicUsize>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() {
                    // 只服务本机。IPv4 绑定已经挡住了，这层是给意外留的
                    continue;
                }
                if live.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    // 满了就关掉这条新连接，不去排无限长的队
                    continue;
                }
                live.fetch_add(1, Ordering::SeqCst);
                let handler = handler.clone();
                let stop = stop.clone();
                let counter = live.clone();
                let spawned = std::thread::Builder::new()
                    .name("wb-gateway-conn".into())
                    .spawn(move || {
                        serve(stream, handler, stop);
                        counter.fetch_sub(1, Ordering::SeqCst);
                    });
                if spawned.is_err() {
                    live.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn serve(stream: TcpStream, handler: Handler, stop: Arc<AtomicBool>) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    // Windows 上从非阻塞 listener 接来的 socket 会继承非阻塞，
    // 不改回来的话第一次 read 就 WouldBlock，请求被静默丢掉。
    let _ = stream.set_nonblocking(false);

    let mut out = match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);

    for _ in 0..MAX_KEEPALIVE {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let request = match read_request(&mut reader) {
            Ok(Some(request)) => request,
            Ok(None) => return,
            Err(message) => {
                let _ = write_response(&mut out, Response::text(400, &message), false);
                return;
            }
        };

        let keep_alive = request
            .header("connection")
            .map(|value| !value.eq_ignore_ascii_case("close"))
            .unwrap_or(true);
        let response = handler(&request);
        if write_response(&mut out, response, keep_alive).is_err() {
            return;
        }
        if !keep_alive {
            return;
        }
    }
}

/// 本机回环地址（不含路径）。只在需要"就那个 host:port"时用。
pub fn local_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// OpenAI 兼容端点的根：**带 `/v1`**。
///
/// 客户端要填的就是这一个 —— 只给 `host:port` 的话，它会把 `/chat/completions`
/// 拼到根上，请求直接 404。界面与文档一律用这个。
pub fn api_base(port: u16) -> String {
    format!("{}/v1", local_base(port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse(raw: &str) -> Option<Request> {
        let mut cursor = Cursor::new(raw.as_bytes().to_vec());
        read_request(&mut cursor).unwrap()
    }

    #[test]
    fn 解析请求行与查询串() {
        let request = parse("GET /v1/models?realm=workbuddy&x=1 HTTP/1.1\r\nHost: a\r\n\r\n").unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1/models");
        assert_eq!(request.query, "realm=workbuddy&x=1");
        assert_eq!(request.query_param("realm"), Some("workbuddy"));
        assert_eq!(request.query_param("x"), Some("1"));
        assert_eq!(request.query_param("nope"), None);
    }

    #[test]
    fn 请求头名字归一成小写() {
        let request = parse("POST /x HTTP/1.1\r\nContent-Type: application/json\r\n\r\n").unwrap();
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(request.header("Content-Type"), Some("application/json"));
        assert!(request.headers.iter().all(|(key, _)| key == &key.to_ascii_lowercase()));
    }

    #[test]
    fn 按_content_length_读请求体() {
        let request =
            parse("POST /v1/chat/completions HTTP/1.1\r\nContent-Length: 13\r\n\r\n{\"model\":\"x\"}").unwrap();
        assert_eq!(request.text(), "{\"model\":\"x\"}");
    }

    #[test]
    fn 没有请求体时是空的() {
        let request = parse("GET / HTTP/1.1\r\nHost: a\r\n\r\n").unwrap();
        assert!(request.body.is_empty());
        assert_eq!(request.path, "/");
    }

    #[test]
    fn 对端关闭返回_none() {
        let mut cursor = Cursor::new(Vec::new());
        assert!(read_request(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn 请求体过大被拒() {
        let raw = format!(
            "POST /x HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        let mut cursor = Cursor::new(raw.into_bytes());
        let error = read_request(&mut cursor).unwrap_err();
        assert!(error.contains("请求体过大"), "{error}");
    }

    #[test]
    fn 响应头带_content_length_或_chunked() {
        let buffered = response_head(200, "application/json", Some(12), true);
        assert!(buffered.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(buffered.contains("Content-Length: 12\r\n"));
        assert!(buffered.contains("Connection: keep-alive\r\n"));
        assert!(buffered.ends_with("\r\n\r\n"));

        let streamed = response_head(200, "text/event-stream", None, false);
        assert!(streamed.contains("Transfer-Encoding: chunked\r\n"));
        assert!(streamed.contains("Connection: close\r\n"));
        assert_eq!(reason(429), "Too Many Requests");
    }

    #[test]
    fn 普通响应完整写出() {
        let mut out: Vec<u8> = Vec::new();
        write_response(&mut out, Response::json(&serde_json::json!({"ok": true})), false).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Content-Length: 11"), "{text}");
        assert!(text.ends_with("{\"ok\":true}"));
    }

    #[test]
    fn 流式响应用_chunked_分块写出() {
        let mut out: Vec<u8> = Vec::new();
        write_response(
            &mut out,
            Response::sse(|writer| {
                writer.write_text("data: a\n\n")?;
                writer.write_text("data: b\n\n")
            }),
            false,
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Transfer-Encoding: chunked"), "{text}");
        // 每块前面是十六进制长度
        assert!(text.contains("9\r\ndata: a\n\n\r\n"), "{text}");
        assert!(text.contains("9\r\ndata: b\n\n\r\n"), "{text}");
        assert!(text.ends_with("0\r\n\r\n"), "{text}");
    }

    #[test]
    fn 空块不写() {
        let mut out: Vec<u8> = Vec::new();
        write_response(
            &mut out,
            Response::sse(|writer| {
                writer.write_chunk(&[])?;
                writer.write_text("x")
            }),
            false,
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.ends_with("1\r\nx\r\n0\r\n\r\n"), "{text}");
    }

    #[test]
    fn 错误响应是_openai_形状() {
        let response = Response::error(429, "rate_limit_error", "太快了");
        let mut out: Vec<u8> = Vec::new();
        write_response(&mut out, response, false).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("HTTP/1.1 429 Too Many Requests"));
        assert!(text.contains("\"type\":\"rate_limit_error\""));
        assert!(text.contains("太快了"));
    }

    #[test]
    fn 真起一个端口收发一轮() {
        let handler: Handler = Arc::new(|request: &Request| {
            if request.path == "/sse" {
                Response::sse(|writer| {
                    writer.write_text("data: a\r\n\r\n")?;
                    writer.write_text("data: [DONE]\r\n\r\n")
                })
            } else if request.path == "/health" {
                Response::json(&serde_json::json!({"ok": true}))
            } else {
                Response::error(404, "not_found", "没有这条路由")
            }
        });
        let mut server = Server::start(0, handler).unwrap();
        let port = server.port();
        assert_ne!(port, 0, "端口 0 之后要换成系统分配的真实端口");

        // 普通响应
        let reply = roundtrip(port, "GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
        assert!(reply.contains("\"ok\":true"), "{reply}");

        // 流式响应：chunked 分块 + 结束块
        let streamed = roundtrip(port, "GET /sse HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert!(streamed.contains("Transfer-Encoding: chunked"), "{streamed}");
        assert!(streamed.contains("data: a"), "{streamed}");
        assert!(streamed.ends_with("0\r\n\r\n"), "{streamed}");

        // 未知路由
        let missing = roundtrip(port, "GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");

        server.stop();
    }

    fn roundtrip(port: u16, request: &str) -> String {
        use std::io::Read;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        stream.flush().unwrap();

        // 服务端写完就关连接，Windows 上可能给 RST 而不是 FIN —— 两种都当"读完了"，
        // 这才是真实客户端的行为（连接被重置时保留已收到的字节）。
        let mut reply: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => reply.extend_from_slice(&buffer[..read]),
                Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => break,
                Err(err) => panic!("读取失败：{err}"),
            }
        }
        String::from_utf8_lossy(&reply).into_owned()
    }

    #[test]
    fn base_url_只指向回环且带_v1() {
        assert_eq!(local_base(17878), "http://127.0.0.1:17878");
        assert_eq!(api_base(17878), "http://127.0.0.1:17878/v1");
    }
}
