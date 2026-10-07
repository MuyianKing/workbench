//! 邮箱（163 / 126 / QQ 等用户配置的 IMAP/SMTP 账户，可同时配多个 —— 账户清单在
//! 渲染层，这里一个账户一条命令，收发各一台）：IMAP 收信 + SMTP 发信。
//!
//! **联网边界（重要）**：这是第十条「由用户显式开启」的出口 —— 只有邮箱页的账户
//! 配置里填了邮箱地址与客户端授权码（网易 / QQ 邮箱后台开通 IMAP/SMTP 服务后生成）
//! 才会连接，留空即关闭。连接目标就是用户配置的那两台收发服务器，主机名不设白名单 ——
//! 与 AI 助手的 Base URL 同属「地址由用户给」的出口。授权码走 Windows 凭据管理器
//! （`credentials::store`，DPAPI 按用户加密，按地址一条），不落 JSON、不回渲染层；
//! 邮件 HTML 正文的渲染在 TS 侧禁掉一切外链资源 —— 除收发服务器外，这个功能不产生
//! 任何别的请求。
//!
//! **职责分工与 weather.rs 一致**：这一层只做「TLS + 协议传输」，按命令现连现断
//! （一次会话跑完 LOGOUT，不做常驻连接）；回给渲染层的是结构化摘要与原始报文
//! （base64）。MIME 解析、正文渲染与发信报文构建全在 TS 侧（`@workbench/mail` 包，
//! 有单测、改起来走热更新）。
//!
//! **为什么手写协议**：网易 IMAP 要求客户端先发 `ID` 命令表明身份，社区常用的
//! rust-imap 不支持（不发 ID，SELECT 直接报 `Unsafe Login`）；这里需要的子集也小
//! —— 与其给第三方 crate 打补丁不如自写。TLS 用 `schannel`（系统自带 Schannel 的
//! 纯 FFI 封装，唯一依赖 windows-sys，已在编译图里）：证书校验交给 Windows，与
//! http.rs「TLS 由系统提供」的口径一致。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use schannel::schannel_cred::{Direction, SchannelCred};
use schannel::tls_stream::{Builder as TlsBuilder, HandshakeError, TlsStream};
use serde::Serialize;

use crate::credentials;
use crate::encoding::base64;

/// TCP 连接超时；之后读写各留 60 秒 —— 拉大邮件正文时包多，单次读别太紧
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(60);

/// 发信报文的大小上限。网易自己的收发上限在 50 MB 上下，这里留了余量；
/// 渲染层构建报文时按同一个数把门（`@workbench/mail` 的 `MAX_MESSAGE_BYTES`）。
const MAX_MESSAGE_BYTES: usize = 30 * 1024 * 1024;
/// 拉正文的上限：超了就报「邮件太大」。与 AI 预览栏二进制的 24 MB 同一口径。
const MAX_FETCH_BYTES: usize = 24 * 1024 * 1024;

// ---------- 传输底座：TCP + Schannel TLS ----------

/// 连上 `host:port` 并完成 TLS 握手。证书校验交给 Windows（系统信任库），
/// 解析出的每个地址都试一遍 —— 有 IPv6 解析在前的服务器时不至于一步卡死。
fn tls_connect(host: &str, port: u16) -> Result<TlsStream<TcpStream>, String> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|err| format!("解析服务器地址失败（{host}:{port}）：{err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("服务器地址解析不出任何 IP（{host}:{port}）"));
    }
    let mut last = String::from("未知错误");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                return tls_handshake(host, port, stream);
            }
            Err(err) => last = format!("{addr}：{err}"),
        }
    }
    Err(format!("连不上 {host}:{port}（{last}）"))
}

/// 在一条 TCP 流上完成 TLS 握手：凭据走系统默认（客户端方向，证书对系统信任库验），
/// 域名给 Schannel 做 SNI 与主机名匹配。阻塞流上握手一步到位，Interrupted 只是防御。
fn tls_handshake(host: &str, port: u16, stream: TcpStream) -> Result<TlsStream<TcpStream>, String> {
    let credential = SchannelCred::builder()
        .acquire(Direction::Outbound)
        .map_err(|err| format!("初始化系统 TLS 失败：{err}"))?;
    let mut builder = TlsBuilder::new();
    builder.domain(host);
    let mut handshake = builder.connect(credential, stream);
    loop {
        match handshake {
            Ok(stream) => return Ok(stream),
            Err(HandshakeError::Failure(err)) => {
                return Err(format!("与 {host}:{port} 建立 TLS 连接失败：{err}"))
            }
            Err(HandshakeError::Interrupted(mid)) => handshake = mid.handshake(),
        }
    }
}

/// 给一条流写一行命令（CRLF 收尾）。IMAP 与 SMTP 共用。
fn write_line(stream: &mut impl Write, line: &str) -> Result<(), String> {
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.write_all(b"\r\n"))
        .and_then(|_| stream.flush())
        .map_err(|err| format!("发命令失败：{err}"))
}

// ---------- 参数收敛 ----------

/// 邮箱地址：trim、统一小写 —— 凭据管理器的目标名要稳定，大小写不该劈成两条。
/// mail_watch.rs 登记后台监视清单时也用它收敛。
pub(crate) fn clean_address(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_lowercase();
    if !value.contains('@') || value.len() < 3 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("邮箱地址不对：{raw}"));
    }
    Ok(value)
}

/// 服务器地址：宽容一点 —— 用户从别处粘过来常带着协议头、路径甚至 `:端口`，
/// 都收拾干净；粘了 `host:port` 就以它为准（端口单独的参数作废）。
/// 后台监视清单登记时也用它收敛（mail_watch.rs）。
pub(crate) fn clean_host(raw: &str, fallback_port: u16) -> Result<(String, u16), String> {
    let mut text = raw.trim().to_string();
    if let Some(offset) = text.find("://") {
        text = text[offset + 3..].to_string();
    }
    if let Some(slash) = text.find(['/', '\\']) {
        text.truncate(slash);
    }
    let mut port = fallback_port;
    if let Some(colon) = text.rfind(':') {
        port = text[colon + 1..]
            .trim()
            .parse()
            .map_err(|_| format!("端口不是数字：{}", &text[colon + 1..]))?;
        text.truncate(colon);
    }
    let host = text.trim().to_lowercase();
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("服务器地址不对：{raw}"));
    }
    if port == 0 {
        return Err("端口得在 1-65535 之间".into());
    }
    Ok((host, port))
}

/// 收件人列表：逐个 trim，必须像邮箱地址。渲染层递来的是字符串数组。
fn clean_recipients(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for value in raw {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if !value.contains('@') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(format!("收件人地址不对：{value}"));
        }
        out.push(value.to_lowercase());
    }
    if out.is_empty() {
        return Err("收件人是空的".into());
    }
    Ok(out)
}

/// 凭据管理器里的目标名：一个邮箱一条（`Workbench/mail/<地址>/token`）。
fn credential_target(address: &str) -> String {
    format!("mail/{address}")
}

/// 从凭据管理器取这个邮箱的授权码。没配过就指路 —— 这是邮箱页设置弹层该干的活。
fn auth_code(address: &str) -> Result<String, String> {
    credentials::read(&credential_target(address))
        .ok_or_else(|| format!("还没配置 {address} 的授权码，在邮箱页的设置里填一次"))
}

// ---------- IMAP：命令子集 + literal 感知的读取 ----------

/// 一条 IMAP 会话。命令子集：ID / LOGIN / SELECT INBOX / FETCH / STORE / LOGOUT。
/// 字面量（`{n}\r\n` + n 字节）在读侧就地展开 —— 之后所有解析都对着一份完整缓冲。
struct Imap {
    reader: BufReader<TlsStream<TcpStream>>,
    tag: u32,
}

impl Imap {
    fn connect(host: &str, port: u16) -> Result<Self, String> {
        let stream = tls_connect(host, port)?;
        let mut session = Self {
            reader: BufReader::new(stream),
            tag: 0,
        };
        // 服务端问候（`* OK ...`）：不挑内容，能读到一行就说明会话活着
        session.read_line()?;
        Ok(session)
    }

    fn send_line(&mut self, line: &str) -> Result<(), String> {
        write_line(self.reader.get_mut(), line)
    }

    /// 读一行（CRLF 已去）。行尾若是字面量标记，交给调用方接着读原始字节。
    fn read_line(&mut self) -> Result<Vec<u8>, String> {
        let mut line = Vec::new();
        loop {
            match self.reader.read_until(b'\n', &mut line) {
                Ok(0) => return Err("连接被服务器关闭了".into()),
                Ok(_) => break,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(format!("读服务器的响应失败：{err}")),
            }
        }
        while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
            line.pop();
        }
        Ok(line)
    }

    fn read_exact_bytes(&mut self, count: usize) -> Result<Vec<u8>, String> {
        let mut bytes = vec![0u8; count];
        self.reader
            .read_exact(&mut bytes)
            .map_err(|err| format!("读服务器的响应失败：{err}"))?;
        Ok(bytes)
    }

    /// 发一条命令并读到带 tag 的完成为止。返回的缓冲是字节（literal 原样嵌在里面）：
    /// 邮件正文要一字不差地带回渲染层，过 String 会把非 UTF-8 的字节打碎。
    /// NO / BAD 转成 Err，正文带上服务器的原话。
    fn command(&mut self, cmd: &str) -> Result<Vec<u8>, String> {
        self.tag += 1;
        let tag = format!("A{:03}", self.tag);
        self.send_line(&format!("{tag} {cmd}"))?;
        let mut buffer: Vec<u8> = Vec::new();
        loop {
            let line = self.read_line()?;
            // 行尾的 `{n}` / `{n+}`：读 n 字节就地拼进缓冲，再接着读这一行的后半段
            if let Some(count) = literal_size(&line) {
                let bytes = self.read_exact_bytes(count)?;
                buffer.extend_from_slice(&line);
                buffer.extend_from_slice(&bytes);
                continue;
            }
            if line.starts_with(tag.as_bytes()) {
                let rest = String::from_utf8_lossy(&line[tag.len() + 1..]).trim().to_string();
                let status = rest.split(' ').next().unwrap_or("");
                return match status {
                    "OK" => Ok(buffer),
                    "NO" | "BAD" => Err(rest),
                    _ => Err(format!("服务器回了读不懂的状态：{rest}")),
                };
            }
            buffer.extend_from_slice(&line);
            buffer.push(b'\n');
        }
    }

    /// 登录。授权码不是登录密码 —— 报错文案里要把这条指清楚。
    fn login(&mut self, address: &str, code: &str) -> Result<(), String> {
        self.command(&format!("LOGIN {} {}", imap_quote(address), imap_quote(code)))?;
        Ok(())
    }

    /// 向服务器报客户端身份（RFC 2971）。网易的 IMAP 见不到这条就不给干活。
    fn id(&mut self) -> Result<(), String> {
        self.command("ID (\"name\" \"Workbench\" \"version\" \"1.0\")")?;
        Ok(())
    }

    /// 选中 INBOX，返回里面的邮件总数（SELECT 响应里的 `* n EXISTS`）与
    /// UIDVALIDITY（`* OK [UIDVALIDITY n]`，服务器不报就 None）—— 后台监视靠它
    /// 认「UID 序列是不是换过一茬」，换过就不能拿旧 UID 比新邮件。
    fn select_inbox(&mut self) -> Result<InboxInfo, String> {
        let attempt = self.command("SELECT INBOX");
        let buffer = match attempt {
            Ok(buffer) => buffer,
            // 网易的怪癖：没收到 ID 命令就 SELECT 会吃闭门羹。补一次身份再试。
            Err(err) if is_unsafe_login(&err) => {
                self.id()?;
                self.command("SELECT INBOX")?
            }
            Err(err) => return Err(err),
        };
        let text = String::from_utf8_lossy(&buffer);
        let exists = exists_from_select(&text).ok_or("服务器没报收件箱里的邮件数")?;
        Ok(InboxInfo {
            exists,
            uidvalidity: uidvalidity_from_select(&text),
        })
    }

    /// 拉一段序号区间的邮件摘要（UID / 已读标记 / 头部三件套 / 结构）。
    /// 用序号区间而不是 UID SEARCH —— 列表页只关心「最近 N 封」，序号直接够用。
    fn fetch_summaries(&mut self, start: usize, end: usize) -> Result<Vec<MailSummary>, String> {
        let cmd = format!(
            "FETCH {start}:{end} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODYSTRUCTURE)"
        );
        let buffer = self.command(&cmd)?;
        Ok(parse_mail_summaries(&buffer))
    }

    /// 按 UID 拉一封完整报文。BODY.PEEK 不动 \Seen 标记，已读与否由调用方决定。
    fn fetch_body(&mut self, uid: u64) -> Result<Vec<u8>, String> {
        let buffer = self.command(&format!("UID FETCH {uid} (BODY.PEEK[])"))?;
        match parse_single_body(&buffer) {
            Some((_, body)) if !body.is_empty() => Ok(body),
            Some(_) => Err("这封邮件拉回来是空的".into()),
            None => Err("没拉到这封邮件 —— 可能已被删除，或服务器清理了它".into()),
        }
    }

    /// 标记 / 取消 \Seen。
    fn store_seen(&mut self, uid: u64, seen: bool) -> Result<(), String> {
        let flag = if seen { "+FLAGS" } else { "-FLAGS" };
        self.command(&format!("UID STORE {uid} {flag}.SILENT (\\Seen)"))?;
        Ok(())
    }

    /// 删一批：同一条会话里把要删的都标上 \Deleted，再一次 EXPUNGE 收走。
    /// EXPUNGE 会清掉邮箱里**所有**带 \Deleted 的信 —— 本命令每次独立连接、
    /// 只标这一批，所以收走的就只有它们；单封也走这条路（一个元素的集合）。
    fn delete(&mut self, uids: &[u64]) -> Result<(), String> {
        let set = uid_set(uids);
        if set.is_empty() {
            return Err("没有要删的邮件".into());
        }
        self.command(&format!("UID STORE {set} +FLAGS.SILENT (\\Deleted)"))?;
        self.command("EXPUNGE")?;
        Ok(())
    }

    /// 收尾。失败无所谓 —— 连接本来就要关。
    fn logout(&mut self) {
        let _ = self.command("LOGOUT");
    }
}

/// UID 集合串：升序、去重、滤掉 0（uid 从 1 起），逗号连接 —— `UID STORE 3,5,9 ...`。
/// 元素全是 u64，拼出来必是合法的 uid 集，不存在注入一说了。
fn uid_set(uids: &[u64]) -> String {
    let mut values = uids.to_vec();
    values.sort_unstable();
    values.dedup();
    values.retain(|uid| *uid > 0);
    values
        .iter()
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// IMAP 引号串：反斜杠与双引号要转义。地址与授权码都经这里进 LOGIN。
fn imap_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 行尾的 IMAP 字面量标记：`{123}` 或 LITERAL+ 的 `{123+}`。不是标记返回 None。
fn literal_size(line: &[u8]) -> Option<usize> {
    if line.last() != Some(&b'}') {
        return None;
    }
    let mut cursor = line.len() - 1;
    if cursor > 0 && line[cursor - 1] == b'+' {
        cursor -= 1;
    }
    let digits_end = cursor;
    while cursor > 0 && line[cursor - 1].is_ascii_digit() {
        cursor -= 1;
    }
    if cursor == 0 || digits_end == cursor || line[cursor - 1] != b'{' || digits_end - cursor > 10 {
        return None;
    }
    std::str::from_utf8(&line[cursor..digits_end]).ok()?.parse().ok()
}

/// SELECT 一次拿回的两样：邮件总数与 UIDVALIDITY（监视模块比对新邮件用）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InboxInfo {
    pub exists: usize,
    pub uidvalidity: Option<u64>,
}

/// SELECT 响应里的 `* 42 EXISTS`。
fn exists_from_select(buffer: &str) -> Option<usize> {
    for line in buffer.split('\n') {
        let line = line.trim_end_matches('\r').trim();
        if let Some(rest) = line.strip_suffix(" EXISTS") {
            if let Some(number) = rest.rsplit(' ').next() {
                if let Ok(value) = number.parse::<usize>() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// 网易 SELECT 被拒的招牌错误，补发 ID 重试的依据。
fn is_unsafe_login(message: &str) -> bool {
    message.to_lowercase().contains("unsafe")
}

/// SELECT 响应里的 `* OK [UIDVALIDITY 385752904] UIDs valid`。响应码本身大小写不敏感。
fn uidvalidity_from_select(buffer: &str) -> Option<u64> {
    let lowered = buffer.to_ascii_lowercase();
    let start = lowered.find("[uidvalidity ")? + "[uidvalidity ".len();
    let rest = &lowered[start..];
    let digits: &str = rest.split(|c: char| !c.is_ascii_digit()).next()?;
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// 在字节缓冲里找子串（windows 对短于 needle 的切片会 panic，先把门把住）。
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

// ---------- IMAP 响应的解析（纯函数，可单测） ----------

/// IMAP 响应里括号项的解析结果：原子、字符串（引号串 / 字面量）、嵌套列表。
#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Atom(String),
    Str(Vec<u8>),
    List(Vec<Tok>),
}

/// 从 `input[*pos..]` 解析一个完整项。字面量标记 `{n}` 后面紧跟的 n 个字节
/// 就地取材 —— 读侧已把字面量拼进同一份缓冲。`BODY[...]` 的节说明里有括号
/// （`BODY[HEADER.FIELDS (FROM)]`），原子要读到 `]` 为止，不能按普通括号数。
fn parse_token(input: &[u8], pos: &mut usize) -> Result<Tok, String> {
    while matches!(input.get(*pos), Some(b' ') | Some(b'\r') | Some(b'\n') | Some(b'\t')) {
        *pos += 1;
    }
    match input.get(*pos) {
        None => Err("响应提前结束了".into()),
        Some(b'(') => {
            *pos += 1;
            let mut items = Vec::new();
            loop {
                while matches!(input.get(*pos), Some(b' ') | Some(b'\r') | Some(b'\n') | Some(b'\t')) {
                    *pos += 1;
                }
                if input.get(*pos) == Some(&b')') {
                    *pos += 1;
                    return Ok(Tok::List(items));
                }
                if *pos >= input.len() {
                    return Err("括号没有闭合".into());
                }
                items.push(parse_token(input, pos)?);
            }
        }
        Some(b'"') => {
            *pos += 1;
            let mut value = Vec::new();
            loop {
                match input.get(*pos) {
                    None => return Err("引号串没有闭合".into()),
                    Some(b'"') => {
                        *pos += 1;
                        return Ok(Tok::Str(value));
                    }
                    Some(b'\\') => {
                        *pos += 1;
                        value.push(*input.get(*pos).ok_or("引号串没有闭合")?);
                        *pos += 1;
                    }
                    Some(&byte) => {
                        value.push(byte);
                        *pos += 1;
                    }
                }
            }
        }
        Some(b'{') => {
            let mut cursor = *pos + 1;
            let digits_start = cursor;
            while matches!(input.get(cursor), Some(byte) if byte.is_ascii_digit()) {
                cursor += 1;
            }
            if cursor == digits_start || input.get(cursor) != Some(&b'}') {
                return Err("字面量标记不完整".into());
            }
            let count: usize = std::str::from_utf8(&input[digits_start..cursor])
                .ok()
                .and_then(|digits| digits.parse().ok())
                .ok_or("字面量大小不对")?;
            if count > MAX_FETCH_BYTES {
                return Err(format!("响应里的字面量太大（{count} 字节），超出应用的处理上限"));
            }
            cursor += 1;
            // 生产缓冲里标记与内容是贴着的；多一个 CRLF 也容（恰好两种来源都兼容）
            if input.get(cursor) == Some(&b'\r') && input.get(cursor + 1) == Some(&b'\n') {
                cursor += 2;
            }
            if cursor + count > input.len() {
                return Err("字面量内容不完整".into());
            }
            let value = input[cursor..cursor + count].to_vec();
            *pos = cursor + count;
            Ok(Tok::Str(value))
        }
        Some(_) => {
            let start = *pos;
            if input[start..].len() >= 5 && input[start..start + 5].eq_ignore_ascii_case(b"body[") {
                let end = input[start..]
                    .iter()
                    .position(|&byte| byte == b']')
                    .ok_or("BODY[ 的节说明没有闭合")?;
                *pos = start + end + 1;
            } else {
                while let Some(&byte) = input.get(*pos) {
                    if matches!(byte, b' ' | b'(' | b')' | b'"') {
                        break;
                    }
                    *pos += 1;
                }
            }
            if *pos == start {
                return Err("解析停在了原地".into());
            }
            Ok(Tok::Atom(String::from_utf8_lossy(&input[start..*pos]).into_owned()))
        }
    }
}

fn atom_u64(token: &Tok) -> Option<u64> {
    match token {
        Tok::Atom(text) => text.parse().ok(),
        _ => None,
    }
}

fn tok_bytes(token: &Tok) -> Option<Vec<u8>> {
    match token {
        Tok::Str(bytes) => Some(bytes.clone()),
        _ => None,
    }
}

/// 一封邮件的列表摘要。头部三件套是原始文本（RFC 2047 编码词、名字与地址都在里面），
/// 展示层的拆解在 TS 侧做。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailSummary {
    pub uid: u64,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub seen: bool,
    pub has_attachment: bool,
}

/// 从一段 FETCH 响应里解析全部摘要。按 `FETCH (` 扫描、逐个吃括号项 ——
/// 上一封信的正文 literal 里若恰好出现 `FETCH (`，解析出的东西缺 UID 会被丢弃。
fn parse_mail_summaries(buffer: &[u8]) -> Vec<MailSummary> {
    let mut summaries = Vec::new();
    let mut pos = 0usize;
    while let Some(offset) = find_subslice(&buffer[pos.min(buffer.len())..], b"FETCH (") {
        let start = pos + offset;
        let mut at = start + b"FETCH (".len() - 1;
        match parse_token(buffer, &mut at) {
            Ok(Tok::List(items)) => {
                if let Some(summary) = summary_from_tokens(&items) {
                    summaries.push(summary);
                }
                pos = at;
            }
            // 解析不动就跳过这一处，继续往后找
            _ => pos = at.max(start + 1),
        }
    }
    summaries
}

fn summary_from_tokens(items: &[Tok]) -> Option<MailSummary> {
    let mut uid = None;
    let mut seen = false;
    let mut headers = String::new();
    let mut has_attachment = false;
    let mut index = 0;
    while index < items.len() {
        let name = match &items[index] {
            Tok::Atom(name) => name.clone(),
            _ => {
                index += 1;
                continue;
            }
        };
        let value = items.get(index + 1);
        if name.eq_ignore_ascii_case("UID") {
            uid = value.and_then(atom_u64);
            index += 2;
        } else if name.eq_ignore_ascii_case("FLAGS") {
            if let Some(Tok::List(flags)) = value {
                seen = flags
                    .iter()
                    .any(|flag| matches!(flag, Tok::Atom(text) if text.eq_ignore_ascii_case("\\Seen")));
            }
            index += 2;
        } else if name.to_uppercase().starts_with("BODY[") {
            if let Some(bytes) = value.and_then(tok_bytes) {
                headers = String::from_utf8_lossy(&bytes).into_owned();
            }
            index += 2;
        } else if name.eq_ignore_ascii_case("BODYSTRUCTURE") {
            has_attachment = value.map(structure_has_attachment).unwrap_or(false);
            index += 2;
        } else {
            index += 1;
        }
    }
    Some(MailSummary {
        uid: uid?,
        subject: header_value(&headers, "Subject"),
        from: header_value(&headers, "From"),
        date: header_value(&headers, "Date"),
        seen,
        has_attachment,
    })
}

/// BODYSTRUCTURE 里有没有附件：找 disposition 的 ATTACHMENT（原子或引号串都算 ——
/// 解析器把带引号的串归到 Str）。是启发式 —— 老服务器各有各的写法，宁可漏报
/// 也别把内联图片都标成附件。
fn structure_has_attachment(token: &Tok) -> bool {
    match token {
        Tok::Atom(text) => text.eq_ignore_ascii_case("ATTACHMENT"),
        Tok::Str(bytes) => bytes.eq_ignore_ascii_case(b"ATTACHMENT"),
        Tok::List(items) => items.iter().any(structure_has_attachment),
    }
}

/// 从 HEADER.FIELDS 取回的头部块里取一个字段的值，折行（下一行空格开头）会展开。
fn header_value(block: &str, name: &str) -> String {
    let mut matched = false;
    let mut value = String::new();
    for line in block.split('\n') {
        let line = line.trim_end_matches('\r');
        if matched && !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if matched {
                value.push(' ');
                value.push_str(line.trim());
            }
            continue;
        }
        if let Some(colon) = line.find(':') {
            if line[..colon].trim().eq_ignore_ascii_case(name) {
                matched = true;
                value.push_str(line[colon + 1..].trim());
            }
        }
    }
    value
}

/// 从 `UID FETCH <uid> (BODY.PEEK[])` 的响应里取报文原文。
fn parse_single_body(buffer: &[u8]) -> Option<(u64, Vec<u8>)> {
    let mut pos = 0usize;
    while let Some(offset) = find_subslice(&buffer[pos.min(buffer.len())..], b"FETCH (") {
        let start = pos + offset;
        let mut at = start + b"FETCH (".len() - 1;
        match parse_token(buffer, &mut at) {
            Ok(Tok::List(items)) => {
                let mut uid = None;
                let mut body = None;
                let mut index = 0;
                while index < items.len() {
                    match &items[index] {
                        Tok::Atom(name) if name.eq_ignore_ascii_case("UID") => {
                            uid = items.get(index + 1).and_then(atom_u64);
                        }
                        Tok::Atom(name) if name.to_uppercase().starts_with("BODY[") => {
                            body = items.get(index + 1).and_then(tok_bytes);
                        }
                        _ => {}
                    }
                    index += 1;
                }
                if let (Some(uid), Some(body)) = (uid, body) {
                    return Some((uid, body));
                }
                pos = at;
            }
            _ => pos = at.max(start + 1),
        }
    }
    None
}

// ---------- SMTP：发送 ----------

/// 读一条 SMTP 应答（多行 `250-...` 收在第一个不带 `-` 的行上）。
fn read_smtp_reply<R: BufRead>(reader: &mut R) -> Result<(u16, String), String> {
    let mut text = String::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("发件服务器把连接关了".into()),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(format!("读发件服务器的响应失败：{err}")),
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() < 4 || !line.as_bytes()[0].is_ascii_digit() {
            return Err(format!("发件服务器的响应读不懂：{line}"));
        }
        let code: u16 = line[..3].parse().map_err(|_| format!("发件服务器的响应码读不懂：{line}"))?;
        text.push_str(&line[4..]);
        text.push('\n');
        if line.as_bytes()[3] != b'-' {
            return Ok((code, text));
        }
    }
}

fn smtp_expect<R: BufRead>(reader: &mut R, want: u16, what: &str) -> Result<String, String> {
    let (code, text) = read_smtp_reply(reader)?;
    if code != want {
        return Err(format!("{what}没有通过（服务器回 {code}）：{}", text.trim()));
    }
    Ok(text)
}

/// 连发件服务器、EHLO、AUTH LOGIN（授权码走 base64）。返回还开着的会话供 DATA 用。
fn smtp_login(
    host: &str,
    port: u16,
    address: &str,
    code: &str,
) -> Result<BufReader<TlsStream<TcpStream>>, String> {
    let stream = tls_connect(host, port)?;
    let mut reader = BufReader::new(stream);
    smtp_expect(&mut reader, 220, "连接").map_err(|err| format!("发件服务器没有打招呼：{err}"))?;
    write_line(reader.get_mut(), "EHLO workbench")?;
    smtp_expect(&mut reader, 250, "EHLO")?;
    write_line(reader.get_mut(), "AUTH LOGIN")?;
    smtp_expect(&mut reader, 334, "开始认证")?;
    write_line(reader.get_mut(), &base64(address.as_bytes()))?;
    smtp_expect(&mut reader, 334, "提交邮箱账号")?;
    write_line(reader.get_mut(), &base64(code.as_bytes()))?;
    smtp_expect(&mut reader, 235, "登录（授权码）").map_err(|err| {
        format!(
            "授权码没被发件服务器接受：{err}（核对授权码，并确认邮箱后台开了「IMAP/SMTP 服务」）"
        )
    })?;
    Ok(reader)
}

/// SMTP DATA 阶段的报文：行首的 `.` 都要再垫一个（单独的 `.` 是结束标记），
/// 报文按 CRLF 分行（构建侧 `@workbench/mail` 保证），行尾统一 CRLF 收尾。
fn smtp_data_payload(mime: &str) -> String {
    let normalized = if mime.ends_with("\r\n") {
        mime.to_string()
    } else {
        format!("{mime}\r\n")
    };
    let lines: Vec<&str> = normalized.split("\r\n").collect();
    let mut out = String::with_capacity(normalized.len() + 16);
    // split 后最后一段是空串（报文以 CRLF 收尾），不参与
    for line in &lines[..lines.len() - 1] {
        if line.starts_with('.') {
            out.push('.');
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out
}

/// SMTP 全流程：登录 → MAIL FROM → 逐个 RCPT TO → DATA（点填充）→ QUIT。
fn smtp_deliver(
    host: &str,
    port: u16,
    address: &str,
    code: &str,
    recipients: &[String],
    mime: &str,
) -> Result<(), String> {
    let mut reader = smtp_login(host, port, address, code)?;
    write_line(reader.get_mut(), &format!("MAIL FROM:<{address}>"))?;
    smtp_expect(&mut reader, 250, "发件人（MAIL FROM）")?;
    for recipient in recipients {
        write_line(reader.get_mut(), &format!("RCPT TO:<{recipient}>"))?;
        smtp_expect(&mut reader, 250, &format!("收件人 {recipient}"))?;
    }
    write_line(reader.get_mut(), "DATA")?;
    smtp_expect(&mut reader, 354, "开始输入报文（DATA）")?;
    reader
        .get_mut()
        .write_all(smtp_data_payload(mime).as_bytes())
        .map_err(|err| format!("发报文失败：{err}"))?;
    write_line(reader.get_mut(), ".")?;
    smtp_expect(&mut reader, 250, "投递")?;
    let _ = write_line(reader.get_mut(), "QUIT");
    Ok(())
}

// ---------- 渲染层入口（Tauri 命令） ----------

/// 存 / 覆盖某个邮箱的授权码（进 Windows 凭据管理器，不回显、不落 JSON）。
#[tauri::command(async)]
pub fn mail_key_save(address: String, secret: String) -> Result<(), String> {
    let address = clean_address(&address)?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("授权码不能是空的".into());
    }
    credentials::store(&credential_target(&address), secret)
}

/// 这个邮箱配过授权码没有（只回有没有，界面显示「已配置 / 未配置」）。
#[tauri::command(async)]
pub fn mail_key_state(address: String) -> Result<bool, String> {
    let address = clean_address(&address)?;
    Ok(credentials::read(&credential_target(&address)).is_some())
}

/// 清掉某个邮箱的授权码（本来就没有也算成功，见 credentials::remove）。
#[tauri::command(async)]
pub fn mail_key_clear(address: String) -> Result<(), String> {
    let address = clean_address(&address)?;
    credentials::remove(&credential_target(&address))
}

/// 验证一套收发配置：IMAP 登录 + SELECT INBOX，SMTP 用同一把授权码登录。
/// secret 只在这一趟里作参数用，是否落进凭据管理器由「验证并保存」按钮的调用方决定。
#[tauri::command(async)]
pub fn mail_verify(
    address: String,
    secret: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
) -> Result<(), String> {
    let address = clean_address(&address)?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("授权码是空的，去邮箱后台生成一个再填".into());
    }
    let (imap, iport) = clean_host(&imap_host, imap_port)?;
    let (smtp, sport) = clean_host(&smtp_host, smtp_port)?;
    let mut session =
        Imap::connect(&imap, iport).map_err(|err| format!("收件服务器 {imap}:{iport} 连不上：{err}"))?;
    session
        .login(&address, secret)
        .map_err(|err| format!("收件服务器拒绝登录：{err}（核对授权码，它不是登录密码）"))?;
    session.id().map_err(|err| format!("向收件服务器报身份失败：{err}"))?;
    session
        .select_inbox()
        .map_err(|err| format!("选中收件箱失败：{err}"))?;
    smtp_login(&smtp, sport, &address, secret)?;
    Ok(())
}

/// 现连现断拉一次收件箱最近 `window` 封的摘要（连上 → 选中 → 拉摘要 → LOGOUT）。
/// mail_list 命令与后台监视（mail_watch.rs）走同一套。
pub(crate) fn fetch_recent_summaries(
    address: &str,
    raw_host: &str,
    raw_port: u16,
    window: usize,
) -> Result<(InboxInfo, Vec<MailSummary>), String> {
    let mut session = open_inbox(address, raw_host, raw_port)?;
    let info = session.select_inbox()?;
    let summaries = if info.exists == 0 {
        Vec::new()
    } else {
        let start = info.exists.saturating_sub(window) + 1;
        session.fetch_summaries(start, info.exists)?
    };
    session.logout();
    Ok((info, summaries))
}

/// 收件箱最近 N 封的摘要。每次现连现断 —— 个人用量下一次握手几十毫秒，不值得养常驻连接。
#[tauri::command(async)]
pub fn mail_list(
    address: String,
    imap_host: String,
    imap_port: u16,
    limit: u32,
) -> Result<Vec<MailSummary>, String> {
    let address = clean_address(&address)?;
    let limit = limit.clamp(1, 100) as usize;
    let (_, summaries) = fetch_recent_summaries(&address, &imap_host, imap_port, limit)?;
    Ok(summaries)
}

/// 拉一封完整报文（base64 回传，MIME 解析在 TS 侧）。markSeen 时顺手标已读 ——
/// 失败不拦展示，读信不该因为一个标记失败而看不了。
#[tauri::command(async)]
pub fn mail_fetch_body(
    address: String,
    imap_host: String,
    imap_port: u16,
    uid: u64,
    mark_seen: bool,
) -> Result<String, String> {
    let address = clean_address(&address)?;
    let mut session = open_inbox(&address, &imap_host, imap_port)?;
    session.select_inbox()?;
    let body = session.fetch_body(uid)?;
    if mark_seen {
        let _ = session.store_seen(uid, true);
    }
    session.logout();
    Ok(base64(&body))
}

/// 标记 / 取消一封的已读。
#[tauri::command(async)]
pub fn mail_set_seen(
    address: String,
    imap_host: String,
    imap_port: u16,
    uid: u64,
    seen: bool,
) -> Result<(), String> {
    let address = clean_address(&address)?;
    let mut session = open_inbox(&address, &imap_host, imap_port)?;
    session.select_inbox()?;
    session.store_seen(uid, seen)?;
    session.logout();
    Ok(())
}

/// 删一批：服务器上标 \Deleted 并 EXPUNGE（不可找回 —— 确认在渲染层那一步做过），
/// 右键删单封传一个元素的数组即可。对着不存在的 uid 服务器只会安静地 OK，
/// 本地清单反正已经把它们摘掉了，无碍。
#[tauri::command(async)]
pub fn mail_delete(
    address: String,
    imap_host: String,
    imap_port: u16,
    uids: Vec<u64>,
) -> Result<(), String> {
    let address = clean_address(&address)?;
    if uids.is_empty() {
        return Err("没有要删的邮件".into());
    }
    let mut session = open_inbox(&address, &imap_host, imap_port)?;
    session.select_inbox()?;
    session.delete(&uids)?;
    session.logout();
    Ok(())
}

/// 发一封邮件。mime 是 TS 侧构建好的完整报文（`@workbench/mail` 的 buildMime）；
/// 收件人单独递，服务器侧的 RCPT TO 得一个一个来，谁的地址被拒要说得清。
#[tauri::command(async)]
pub fn mail_send(
    address: String,
    smtp_host: String,
    smtp_port: u16,
    to: Vec<String>,
    mime: String,
) -> Result<(), String> {
    let address = clean_address(&address)?;
    if mime.trim().is_empty() {
        return Err("要发的报文是空的".into());
    }
    if mime.len() > MAX_MESSAGE_BYTES {
        return Err("邮件（含附件）超过 30 MB，发件服务器收不下，拆小一点再试".into());
    }
    let recipients = clean_recipients(&to)?;
    let code = auth_code(&address)?;
    let (host, port) = clean_host(&smtp_host, smtp_port)?;
    smtp_deliver(&host, port, &address, &code, &recipients, &mime)
}

/// 附件下载落盘。路径来自渲染层的「另存为」对话框（用户亲手挑的），数据是
/// MIME 解析出的附件字节（base64）—— 与 vault_key_export 同一个信任模型。
#[tauri::command(async)]
pub fn mail_attachment_save(path: String, data: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("保存路径是空的".into());
    }
    let bytes = crate::encoding::base64_decode(data.trim())
        .ok_or_else(|| "附件数据解不开，重试一次".to_string())?;
    std::fs::write(path, &bytes).map_err(|err| format!("写入文件失败：{err}"))
}

/// 打开收件箱的公共前缀：连 IMAP → 登录 → 报身份。
fn open_inbox(address: &str, raw_host: &str, raw_port: u16) -> Result<Imap, String> {
    let (host, port) = clean_host(raw_host, raw_port)?;
    let code = auth_code(address)?;
    let mut session =
        Imap::connect(&host, port).map_err(|err| format!("收件服务器 {host}:{port} 连不上：{err}"))?;
    session
        .login(address, &code)
        .map_err(|err| format!("登录收件服务器被拒：{err}（核对邮箱地址与授权码 —— 授权码在邮箱后台「POP3/SMTP/IMAP」里生成，不是登录密码）"))?;
    session.id().map_err(|err| format!("向服务器报身份失败：{err}"))?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // ----- 字面量标记 -----

    #[test]
    fn literal_marker_sizes() {
        assert_eq!(literal_size(b"* 3 FETCH (BODY[] {88}"), Some(88));
        assert_eq!(literal_size(b"... {1234+}"), Some(1234));
        assert_eq!(literal_size(b"A001 OK LOGIN completed"), None);
        assert_eq!(literal_size(b"* 42 EXISTS"), None);
        // 没有数字、数字过长都不算标记
        assert_eq!(literal_size(b"... {}"), None);
        assert_eq!(literal_size(b"... {12345678901234}"), None);
    }

    // ----- 括号项解析 -----

    /// 按生产侧 command() 的拼法构造一段带字面量的 FETCH 响应：
    /// 行本体（CRLF 已去）+ 字面量原始字节 + 后半行。
    fn sample_fetch_buffer() -> Vec<u8> {
        let headers = "From: Alice <alice@example.com>\r\nSubject: =?utf-8?B?6YKu5Lu2?=\r\nDate: Mon, 5 Oct 2026 10:00:00 +0800\r\n\r\n";
        let mut buffer = b"* 3 FETCH (UID 7 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {".to_vec();
        buffer.extend_from_slice(headers.len().to_string().as_bytes());
        buffer.extend_from_slice(b"}");
        buffer.extend_from_slice(headers.as_bytes());
        buffer.extend_from_slice(
            b" BODYSTRUCTURE (\"MIXED\" (\"BOUNDARY\" \"b1\") NIL NIL (\"ATTACHMENT\" (\"FILENAME\" \"a.pdf\"))))\n",
        );
        buffer
    }

    #[test]
    fn parses_a_full_fetch_response() {
        let summaries = parse_mail_summaries(&sample_fetch_buffer());
        assert_eq!(summaries.len(), 1);
        let summary = &summaries[0];
        assert_eq!(summary.uid, 7);
        assert!(summary.seen);
        assert!(summary.has_attachment);
        assert_eq!(summary.subject, "=?utf-8?B?6YKu5Lu2?=");
        assert_eq!(summary.from, "Alice <alice@example.com>");
        assert_eq!(summary.date, "Mon, 5 Oct 2026 10:00:00 +0800");
    }

    #[test]
    fn unread_mail_without_attachment_is_recognized() {
        let mut buffer = b"* 1 FETCH (UID 2 FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {".to_vec();
        let headers = "From: bob@example.com\r\nSubject: hi\r\nDate: Tue, 6 Oct 2026 09:00:00 +0800\r\n\r\n";
        buffer.extend_from_slice(headers.len().to_string().as_bytes());
        buffer.extend_from_slice(b"}");
        buffer.extend_from_slice(headers.as_bytes());
        buffer.extend_from_slice(b" BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"7BIT\" 12 1))\n");
        let summaries = parse_mail_summaries(&buffer);
        assert_eq!(summaries.len(), 1);
        assert!(!summaries[0].seen);
        assert!(!summaries[0].has_attachment);
        assert_eq!(summaries[0].uid, 2);
    }

    /// 正文 literal 里恰好出现 `FETCH (` 不能带出假摘要，也不能挡住后面的真摘要
    #[test]
    fn fetch_keyword_inside_a_literal_does_not_confuse_the_parser() {
        let decoy_headers = "From: x@y.com\r\nSubject: FETCH (UID 999\r\n\r\n";
        let mut buffer = b"* 1 FETCH (UID 1 FLAGS (\\Seen) BODY[HEADER.FIELDS (SUBJECT)] {".to_vec();
        buffer.extend_from_slice(decoy_headers.len().to_string().as_bytes());
        buffer.extend_from_slice(b"}");
        buffer.extend_from_slice(decoy_headers.as_bytes());
        buffer.extend_from_slice(b" BODYSTRUCTURE (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 5 1))\n");
        buffer.extend_from_slice(b"* 2 FETCH (UID 5 FLAGS () BODY[HEADER.FIELDS (SUBJECT)] {");
        let headers2 = "Subject: real\r\n\r\n";
        buffer.extend_from_slice(headers2.len().to_string().as_bytes());
        buffer.extend_from_slice(b"}");
        buffer.extend_from_slice(headers2.as_bytes());
        buffer.extend_from_slice(b" BODYSTRUCTURE (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 5 1))\n");
        let summaries = parse_mail_summaries(&buffer);
        let uids: Vec<u64> = summaries.iter().map(|summary| summary.uid).collect();
        assert_eq!(uids, vec![1, 5]);
    }

    #[test]
    fn header_values_unfold_continuation_lines() {
        let block = "Subject: 很长的主题\r\n 折行接着写\r\nFrom: a@b.com\r\n\r\n";
        assert_eq!(header_value(block, "Subject"), "很长的主题 折行接着写");
        assert_eq!(header_value(block, "From"), "a@b.com");
        assert_eq!(header_value(block, "To"), "");
        // 大小写不敏感
        assert_eq!(header_value("subject: x\r\n\r\n", "SUBJECT"), "x");
    }

    #[test]
    fn parse_single_body_returns_raw_bytes() {
        let body_bytes = "From: a@b.com\r\n\r\n正文\r\n".as_bytes().to_vec();
        let mut buffer = b"* 1 FETCH (UID 42 BODY[] {".to_vec();
        buffer.extend_from_slice(body_bytes.len().to_string().as_bytes());
        buffer.extend_from_slice(b"}");
        buffer.extend_from_slice(&body_bytes);
        buffer.extend_from_slice(b")\n");
        let (uid, body) = parse_single_body(&buffer).expect("应该解析得出");
        assert_eq!(uid, 42);
        assert_eq!(body, body_bytes);
    }

    #[test]
    fn exists_line_is_found() {
        assert_eq!(exists_from_select("* 42 EXISTS\n* 1 RECENT\nA003 OK done"), Some(42));
        assert_eq!(exists_from_select("* 0 EXISTS\n"), Some(0));
        assert_eq!(exists_from_select("A003 OK done"), None);
    }

    #[test]
    fn uidvalidity_is_parsed_from_select() {
        assert_eq!(
            uidvalidity_from_select("* OK [UIDVALIDITY 385752904] UIDs valid\n* 42 EXISTS\n"),
            Some(385752904)
        );
        // 响应码大小写不敏感
        assert_eq!(uidvalidity_from_select("* OK [UidValidity 7] ok"), Some(7));
        assert_eq!(uidvalidity_from_select("* 42 EXISTS\n"), None);
        assert_eq!(uidvalidity_from_select("* OK [UIDVALIDITY ] empty"), None);
    }

    #[test]
    fn unsafe_login_is_detected_case_insensitively() {
        assert!(is_unsafe_login("NO SELECT Unsafe Login. Please contact kefu@188.com"));
        assert!(is_unsafe_login("unsafe login"));
        assert!(!is_unsafe_login("NO [AUTHENTICATIONFAILED] ..."));
    }

    #[test]
    fn imap_quoting_escapes_specials() {
        assert_eq!(imap_quote("user@example.com"), "\"user@example.com\"");
        assert_eq!(imap_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(imap_quote("a\\b"), "\"a\\\\b\"");
    }

    // ----- UID 集合 -----

    #[test]
    fn uid_set_sorts_dedups_and_drops_zero() {
        assert_eq!(uid_set(&[9, 3, 5]), "3,5,9");
        assert_eq!(uid_set(&[5, 3, 5, 3]), "3,5");
        assert_eq!(uid_set(&[0, 7, 0]), "7");
        assert_eq!(uid_set(&[42]), "42");
        assert_eq!(uid_set(&[]), "");
    }

    // ----- 参数收敛 -----

    #[test]
    fn addresses_are_trimmed_and_lowercased() {
        assert_eq!(clean_address(" User@163.COM ").unwrap(), "user@163.com");
        assert!(clean_address("no-at-sign").is_err());
        assert!(clean_address("a b@163.com").is_err());
    }

    #[test]
    fn hosts_survive_pasted_schemes_paths_and_ports() {
        assert_eq!(clean_host("imap.163.com", 993).unwrap(), ("imap.163.com".into(), 993));
        assert_eq!(
            clean_host("ssl://IMAP.163.com:993/", 465).unwrap(),
            ("imap.163.com".into(), 993)
        );
        assert_eq!(clean_host("smtp.163.com\\x", 465).unwrap(), ("smtp.163.com".into(), 465));
        assert!(clean_host("", 993).is_err());
        assert!(clean_host("imap.163.com:0", 993).is_err());
        assert!(clean_host("imap.163.com:abc", 993).is_err());
    }

    #[test]
    fn recipients_must_look_like_addresses() {
        assert_eq!(
            clean_recipients(&[" A@163.com ".into(), "".into(), "b@126.com".into()]).unwrap(),
            vec!["a@163.com".to_string(), "b@126.com".to_string()]
        );
        assert!(clean_recipients(&["  ".into()]).is_err());
        assert!(clean_recipients(&["not-an-address".into()]).is_err());
    }

    // ----- SMTP -----

    #[test]
    fn smtp_replies_read_multiline() {
        let mut reader = Cursor::new("250-PIPELINING\r\n250-SIZE 52428800\r\n250 OK\r\n".as_bytes());
        let (code, text) = read_smtp_reply(&mut reader).unwrap();
        assert_eq!(code, 250);
        assert!(text.contains("PIPELINING"));
        assert!(text.contains("OK"));

        let mut reader = Cursor::new("535 authentication failed\r\n".as_bytes());
        let (code, text) = read_smtp_reply(&mut reader).unwrap();
        assert_eq!(code, 535);
        assert!(text.contains("authentication failed"));
    }

    #[test]
    fn dot_stuffing_prepends_dots() {
        assert_eq!(smtp_data_payload("line1\r\n.line2\r\n"), "line1\r\n..line2\r\n");
        // 单独的 `.` 是结束标记，必须垫成 `..`
        assert_eq!(smtp_data_payload("a\r\n.\r\nb\r\n"), "a\r\n..\r\nb\r\n");
        // 尾部没带 CRLF 会补上；已经带了不重复补
        assert_eq!(smtp_data_payload("x"), "x\r\n");
        assert_eq!(smtp_data_payload("x\r\n"), "x\r\n");
    }
}
