//! 出站身分：会话 ID 生成 + 三种客户端的请求头。
//!
//! 上游不靠身份鉴权，靠**像不像官方客户端**。同一份额度，用桌面端的头去要就被受理，
//! 少一个 `X-Agent-Type` 就可能吃 403 code 11140「request illegal」。所以这里的东西
//! 不是"可选装饰"，是协议的一部分，改动要有抓包依据。
//!
//! 三种身分（原项目口径，值全部照抄，别凭直觉改）：
//! - `workbuddy`：桌面端。默认，也是聊天主路径用的那个。
//! - `vscode`：官方 VSCode 扩展。id 形状、trace 头族都不同，且它**不发**
//!   `X-Root-Request-ID`（官方只在 subagent 上带）。
//! - `cli`：官方 CodeBuddy CLI。请求由 OpenAI Node SDK 发出，多一组
//!   `x-stainless-*` 指纹头，浏览器头一个不发 —— 所以它的 wrapper 是另一份。
//!
//! **本文件只造头，不做网络、不读文件。** 需要随机数的地方直接从 `uuid::Uuid::new_v4()`
//! 取熵（`uuid` 本来就在依赖里，不为四个随机 bit 再引 `rand`）。

use crate::encoding::sha256;
use crate::wb_realm::Realm;

/// 出站身分。序列化用上游那套词（`workbuddy` / `vscode` / `cli`）。
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Identity {
    #[default]
    Workbuddy,
    Vscode,
    Cli,
}

#[allow(dead_code)] // parse 由账号文件与导入接入（S2）
impl Identity {
    pub fn parse(raw: &str) -> Option<Identity> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "workbuddy" | "wb" | "desktop" => Some(Identity::Workbuddy),
            "vscode" | "vsc" | "ide" => Some(Identity::Vscode),
            "cli" | "codebuddy" => Some(Identity::Cli),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Identity::Workbuddy => "workbuddy",
            Identity::Vscode => "vscode",
            Identity::Cli => "cli",
        }
    }
}

// ---------- 版本常量 ----------
//
// 版本号是这一整块里**最容易过期**的东西。全部收在这里，上游改版时只改这一段。
// 数字后面的注释是它的来源，别删 —— 下次有人想"顺手升一下"时得知道原来是怎么定的。

/// 官方 CodeBuddy CLI 版本：npm 包 `@tencent-ai/codebuddy-code` 的 package version。
const CLI_IDE_VERSION: &str = "2.168.2";
/// CLI 的 `X-Agent-Runtime`（官方枚举 local-agent / cloud-agent / other）
const CLI_AGENT_RUNTIME: &str = "other";
/// 官方 VSCode 扩展版本（Open VSX `Tencent-Cloud.coding-copilot` 解包核对值）
const VSCODE_PRODUCT_VERSION: &str = "4.12.39997873";
/// 宿主 VSCode 版本。网关没有宿主，默认取官方声明的最低支持版
const VSCODE_IDE_VERSION: &str = "1.119.0";
const VSCODE_PLATFORM: &str = "VSCode";
const VSCODE_PRODUCT_NAME: &str = "CodeBuddy";
/// 官方 `HttpEnvRouteInterceptor`：developerMode 关闭时固定 production
const VSCODE_ENV_ID: &str = "production";

fn vscode_ua() -> String {
    format!(
        "{VSCODE_PLATFORM}/{VSCODE_IDE_VERSION} {VSCODE_PRODUCT_NAME}/{VSCODE_PRODUCT_VERSION}"
    )
}

// ---------- ID 生成 ----------

/// 一次请求要用的三个会话标识。
///
/// 桌面端与 CLI 的语义差别很大（见 [`new_ids`]），所以这里把它们摆成一个结构体，
/// 由调用方一次取好、整轮复用 —— 而不是在拼头的时候各自现生成，那样重试一次就换一套 id。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ids {
    /// `X-Conversation-ID`
    pub conversation: String,
    /// `X-Conversation-Request-ID`（桌面端 / CLI 还把它当 `X-Root-Request-ID`）
    pub conversation_request: String,
    /// `X-Conversation-Message-ID`（桌面端 / CLI 的 `X-Request-ID` 也用它）
    pub message: String,
}

/// 按身分生成一轮的标识。
///
/// - 桌面端 / VSCode：三项都现生成（桌面端 UUIDv7，VSCode 是 32 位无连字符 hex）。
/// - CLI：`X-Conversation-ID` 按 `(uid, session_key)` **稳定派生**，`conversation_request`
///   取调用方给的一轮 id（整轮所有请求与重试复用），`message` 仍每请求新生成。
///
/// `explicit_conversation` 非空时优先 —— 客户端自己带了 `X-Conversation-Id` / `session_id`
/// 就沿用它，别覆盖。
pub fn new_ids(
    identity: Identity,
    uid: &str,
    explicit_conversation: Option<&str>,
    session_key: Option<&str>,
    turn_request_id: Option<&str>,
) -> Ids {
    let explicit = explicit_conversation.map(str::trim).unwrap_or_default();
    let mut conversation = if explicit.is_empty() {
        match identity {
            Identity::Vscode => request_id_hex(),
            _ => uuid7().to_string(),
        }
    } else {
        explicit.to_string()
    };
    let message = request_id_hex();
    let mut conversation_request = request_id_hex();

    if identity == Identity::Cli {
        if explicit.is_empty() {
            if let Some(derived) = conversation_id_for(uid, session_key.unwrap_or_default()) {
                conversation = derived;
            }
        }
        if let Some(turn) = turn_request_id.map(str::trim).filter(|v| !v.is_empty()) {
            conversation_request = turn.to_string();
        }
    }

    Ids {
        conversation,
        conversation_request,
        message,
    }
}

/// UUIDv7（RFC 9562）：48 位毫秒时间戳打头，后面是随机位，时间有序。
///
/// 桌面端抓包里的 `X-Conversation-ID` 就是这个形状（带连字符）。用 v4 也"能用"，
/// 但时间戳段是空的就是另一个客户端了 —— 这类细节不值得赌。
pub fn uuid7() -> uuid::Uuid {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
        & ((1 << 48) - 1);

    let entropy = *uuid::Uuid::new_v4().as_bytes();
    // rand_a：12 位（entropy 前 1.5 字节）
    let rand_a = ((entropy[0] as u64) << 4) | ((entropy[1] as u64) >> 4);
    // rand_b：62 位（entropy 第 2..10 字节取 62 位）
    let mut rand_b: u64 = 0;
    for byte in &entropy[2..10] {
        rand_b = (rand_b << 8) | *byte as u64;
    }
    rand_b &= (1 << 62) - 1;

    let value = ((millis as u128) << 80)
        | (0x7u128 << 76)
        | ((rand_a as u128) << 64)
        | (0b10u128 << 62)
        | rand_b as u128;
    uuid::Uuid::from_u128(value)
}

/// 32 位小写 hex、无连字符的随机 id（官方 `uuidv4().replace(/-/g,"")` 的形状）。
pub fn request_id_hex() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 带连字符的随机 UUID 字符串（VSCode 的 `X-Request-Trace-Id` 用）。
pub fn request_trace_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 按 `(uid, session_key)` 稳定派生的会话 id，形状是带连字符的 UUIDv4。
///
/// 官方 CLI 在同一个会话里始终复用同一个 id；换会话才换。`session_key` 为空时返回
/// `None`（调用方回落到随机 id）。
pub fn conversation_id_for(uid: &str, session_key: &str) -> Option<String> {
    let key = session_key.trim();
    if key.is_empty() {
        return None;
    }
    let digest = sha256(format!("{uid}|{key}").as_bytes());
    let mut hex = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        hex.push_str(&format!("{byte:02x}"));
    }
    // 版本位 4、变体位 a：只改形状，不动其余信息
    let mut chars: Vec<char> = hex.chars().collect();
    chars[12] = '4';
    chars[16] = 'a';
    let shaped: String = chars.into_iter().collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &shaped[0..8],
        &shaped[8..12],
        &shaped[12..16],
        &shaped[16..20],
        &shaped[20..32]
    ))
}

// ---------- 头构造 ----------

/// 拼一份聊天请求所需的全部头。`ids` 由 [`new_ids`] 预先算好，这里纯函数。
pub struct ChatHeaders<'a> {
    pub realm: Realm,
    pub identity: Identity,
    pub uid: &'a str,
    pub token: &'a str,
    pub ids: &'a Ids,
    pub enterprise_id: &'a str,
    pub tenant_id: &'a str,
    pub department: &'a str,
    pub model: Option<&'a str>,
    /// 国内版才用得上；客户端真实设备 token，网关一般拿不到
    pub device_token: Option<&'a str>,
}

/// 一组键值对。用 `Vec` 而不是 `HashMap`：WinHTTP 要的是有序文本，且同名头不能互相覆盖。
pub type Headers = Vec<(String, String)>;

fn push(headers: &mut Headers, name: &str, value: impl Into<String>) {
    headers.push((name.to_string(), value.into()));
}

/// 聊天请求头。顺序按原项目的字面顺序，方便与抓包对照。
pub fn chat_headers(input: &ChatHeaders<'_>) -> Headers {
    let cfg = input.realm.config();
    let uid = if input.uid.trim().is_empty() {
        "anonymous"
    } else {
        input.uid
    };
    let mut headers: Headers = Vec::with_capacity(32);

    // wrapper：浏览器形态的客户端才有。CLI 由 Node SDK 发出，一个都不带。
    if input.identity != Identity::Cli {
        push(&mut headers, "Content-Type", "application/json");
        push(&mut headers, "Accept", "application/json, text/plain, */*");
        push(&mut headers, "X-Requested-With", "XMLHttpRequest");
        push(&mut headers, "Origin", cfg.origin);
        push(&mut headers, "Referer", format!("{}/", cfg.origin));
        push(&mut headers, "X-CodeBuddy-Request", "1");
        push(&mut headers, "Accept-Language", cfg.accept_language);
    } else {
        push(&mut headers, "Content-Type", "application/json");
        push(&mut headers, "Accept", "application/json");
    }

    // 身分本体
    match input.identity {
        Identity::Workbuddy => {
            push(&mut headers, "X-Agent-Intent", "craft");
            push(&mut headers, "X-Agent-Purpose", "conversation");
            push(&mut headers, "X-Agent-Type", "main");
            push(&mut headers, "X-IDE-Name", "WorkBuddy");
            push(&mut headers, "X-IDE-Type", "WorkBuddy");
            push(&mut headers, "X-IDE-Version", client_version(input.realm));
            push(&mut headers, "X-Private-Data", "true");
            push(&mut headers, "X-Product", "SaaS");
            push(&mut headers, "X-Domain", cfg.domain);
            push(&mut headers, "User-Agent", cfg.chat_ua);
            push(&mut headers, "X-User-Id", uid);
            push(&mut headers, "Authorization", format!("Bearer {}", input.token));
            push(&mut headers, "X-Conversation-ID", &input.ids.conversation);
            push(
                &mut headers,
                "X-Conversation-Request-ID",
                &input.ids.conversation_request,
            );
            push(
                &mut headers,
                "X-Root-Request-ID",
                &input.ids.conversation_request,
            );
            push(
                &mut headers,
                "X-Conversation-Message-ID",
                &input.ids.message,
            );
            push(&mut headers, "X-Request-ID", &input.ids.message);
            push_trace(&mut headers, TraceStyle::Desktop);
        }
        Identity::Vscode => {
            push(&mut headers, "X-Agent-Intent", "craft");
            push(&mut headers, "X-Agent-Type", "main");
            push(&mut headers, "X-IDE-Type", VSCODE_PLATFORM);
            push(&mut headers, "X-IDE-Name", VSCODE_PLATFORM);
            push(&mut headers, "X-IDE-Version", VSCODE_IDE_VERSION);
            push(&mut headers, "X-Product-Version", VSCODE_PRODUCT_VERSION);
            push(&mut headers, "X-Env-ID", VSCODE_ENV_ID);
            // 主 chat 路径官方代码里没有 X-Product；这里保留是原项目的现状，
            // 「主 chat 到底发不发」还等抓包确认，先不动。
            push(&mut headers, "X-Product", "SaaS");
            push(&mut headers, "X-Domain", cfg.domain);
            push(&mut headers, "User-Agent", vscode_ua());
            push(&mut headers, "X-User-Id", uid);
            push(&mut headers, "Authorization", format!("Bearer {}", input.token));
            push(&mut headers, "X-Request-Trace-Id", request_trace_id());
            push(&mut headers, "X-Conversation-ID", &input.ids.conversation);
            push(
                &mut headers,
                "X-Conversation-Request-ID",
                &input.ids.conversation_request,
            );
            push(
                &mut headers,
                "X-Conversation-Message-ID",
                &input.ids.message,
            );
            // 官方：X-Request-ID 与本轮 requestId 同一个值
            push(&mut headers, "X-Request-ID", &input.ids.conversation_request);
            if let Some(model) = input.model.filter(|value| !value.trim().is_empty()) {
                let now_ms = now_millis().to_string();
                push(&mut headers, "X-Model-ID", model);
                // 只出现在 model 请求上，两个毫秒时间戳同值
                push(&mut headers, "monitor_promptPrepareStartTime", &now_ms);
                push(&mut headers, "monitor_httpSendTime", &now_ms);
            }
            // 官方按 endpoint 判断：只有国内站不发 X-Private-Data
            if input.realm == Realm::Workbuddy {
                push(&mut headers, "X-Private-Data", "true");
            }
            push_trace(&mut headers, TraceStyle::Vscode);
        }
        Identity::Cli => {
            push(&mut headers, "X-Agent-Intent", "craft");
            push(&mut headers, "X-Agent-Purpose", "conversation");
            push(&mut headers, "X-Agent-Runtime", CLI_AGENT_RUNTIME);
            push(&mut headers, "X-Agent-Type", "main");
            push(&mut headers, "X-IDE-Type", "CLI");
            push(&mut headers, "X-IDE-Name", "CLI");
            push(&mut headers, "X-IDE-Version", CLI_IDE_VERSION);
            push(&mut headers, "X-Product", "SaaS");
            push(&mut headers, "X-Domain", cfg.domain);
            push(
                &mut headers,
                "User-Agent",
                format!("CLI/{CLI_IDE_VERSION} CodeBuddy/{CLI_IDE_VERSION}"),
            );
            push(&mut headers, "X-User-Id", uid);
            push(&mut headers, "Authorization", format!("Bearer {}", input.token));
            push(&mut headers, "X-Conversation-ID", &input.ids.conversation);
            push(
                &mut headers,
                "X-Conversation-Request-ID",
                &input.ids.conversation_request,
            );
            push(
                &mut headers,
                "X-Root-Request-ID",
                &input.ids.conversation_request,
            );
            push(
                &mut headers,
                "X-Conversation-Message-ID",
                &input.ids.message,
            );
            push(&mut headers, "X-Request-ID", &input.ids.message);
            // 个人号 false、企业号 true（官方 getCustomHeaders 的默认值）
            push(
                &mut headers,
                "X-Private-Data",
                if input.enterprise_id.trim().is_empty() {
                    "false"
                } else {
                    "true"
                },
            );
            push_stainless(&mut headers);
            push_trace(&mut headers, TraceStyle::Cli);
        }
    }

    // 企业 / 租户 / 部门：三套身分共用
    if !input.enterprise_id.trim().is_empty() {
        push(&mut headers, "X-Enterprise-Id", input.enterprise_id);
        let tenant = if input.tenant_id.trim().is_empty() {
            input.enterprise_id
        } else {
            input.tenant_id
        };
        push(&mut headers, "X-Tenant-Id", tenant);
    }
    if !input.department.trim().is_empty() {
        push(&mut headers, "X-Department-Info", input.department);
    }

    // 设备 token：只有国内版会发（国际版客户端根本没有这个头）。
    // CLI 身份不发；VSCode 非企业号按官方失败态发 error 占位 —— 官方是
    // `token || error` 二选一，两者都不发是官方不存在的状态。
    if input.identity != Identity::Cli {
        if let Some(token) = input.device_token.map(str::trim).filter(|v| !v.is_empty()) {
            if input.realm == Realm::Codebuddy {
                push(&mut headers, "X-Device-Token", token);
            }
        } else if input.identity == Identity::Vscode
            && input.enterprise_id.trim().is_empty()
            && input.realm == Realm::Codebuddy
        {
            push(&mut headers, "X-Device-Token-Error", "sdk_not_initialized");
        }
    }

    headers
}

fn client_version(realm: Realm) -> &'static str {
    // 桌面端的版本段与 UA 首段的版本是同一个数，从 UA 里抠出来会绕，
    // 但写两份又回到原项目"漏改一份"的老路 —— 所以从配置里派生。
    let ua = realm.config().chat_ua;
    let after_prefix = ua.trim_start_matches("WorkBuddy/");
    after_prefix
        .split_whitespace()
        .next()
        .unwrap_or(after_prefix)
}

// ---------- trace 头族 ----------

#[derive(Copy, Clone, PartialEq, Eq)]
enum TraceStyle {
    /// 桌面端：3 段 b3，带 traceparent
    Desktop,
    /// CLI：4 段 b3（带 parent span），带 traceparent
    Cli,
    /// VSCode：4 段 b3，不带 traceparent
    Vscode,
}

fn push_trace(headers: &mut Headers, style: TraceStyle) {
    let trace = request_id_hex();
    let span = random_hex(8);
    let parent = random_hex(8);

    push(headers, "X-B3-TraceId", &trace);
    push(headers, "X-B3-SpanId", &span);
    push(headers, "X-B3-Sampled", "1");
    let with_parent = matches!(style, TraceStyle::Cli | TraceStyle::Vscode);
    if with_parent {
        push(headers, "X-B3-ParentSpanId", &parent);
    }

    match style {
        TraceStyle::Desktop => {
            push(headers, "X-Trace-ID", &trace);
            push(headers, "traceparent", format!("00-{trace}-{span}-01"));
            push(headers, "b3", format!("{trace}-{span}-1"));
        }
        TraceStyle::Cli => {
            push(headers, "X-Trace-ID", &trace);
            push(headers, "traceparent", format!("00-{trace}-{span}-01"));
            push(headers, "b3", format!("{trace}-{span}-1-{parent}"));
        }
        TraceStyle::Vscode => {
            push(headers, "b3", format!("{trace}-{span}-1-{parent}"));
        }
    }
}

/// 官方 OpenAI Node SDK 6.25.0 的 `x-stainless-*` 指纹头。
///
/// 头名按官方 wire 小写（SDK 迭代时键已小写化）。OS / Arch / Runtime-Version
/// 本来由 SDK 按宿主生成，这里取 Windows 的默认值 —— 反代本来就跑在 Windows 上。
fn push_stainless(headers: &mut Headers) {
    push(headers, "x-stainless-lang", "js");
    push(headers, "x-stainless-package-version", "6.25.0");
    push(headers, "x-stainless-os", "Windows");
    push(headers, "x-stainless-arch", "x64");
    push(headers, "x-stainless-runtime", "node");
    push(headers, "x-stainless-runtime-version", "v22.21.1");
    push(headers, "x-stainless-retry-count", "0");
    push(headers, "x-stainless-timeout", "1200");
}

fn random_hex(bytes: usize) -> String {
    let entropy = *uuid::Uuid::new_v4().as_bytes();
    let mut out = String::with_capacity(bytes * 2);
    for byte in entropy.iter().cycle().take(bytes) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

// ---------- 查找 ----------

/// 从一组头里取某个（大小写不敏感的）值。测试与调试用。
#[allow(dead_code)] // 调试与后续校验用
pub fn header_value<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(realm: Realm, identity: Identity, ids: &'a Ids) -> ChatHeaders<'a> {
        ChatHeaders {
            realm,
            identity,
            uid: "uid-1",
            token: "tok",
            ids,
            enterprise_id: "",
            tenant_id: "",
            department: "",
            model: None,
            device_token: None,
        }
    }

    #[test]
    fn uuid7_形状与版本位正确() {
        let id = uuid7();
        let text = id.to_string();
        assert_eq!(text.len(), 36);
        assert_eq!(id.get_version_num(), 7);
        let parts: Vec<&str> = text.split('-').collect();
        assert_eq!(parts[2][0..1], *"7");
        // 变体位：8 / 9 / a / b
        assert!(matches!(&parts[3][0..1], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn uuid7_时间有序() {
        let first = uuid7();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = uuid7();
        assert!(first < second, "同一毫秒内可能乱序，隔开 2ms 必须有序");
    }

    #[test]
    fn 稳定派生要求_session_key() {
        assert_eq!(conversation_id_for("u", ""), None);
        assert_eq!(conversation_id_for("u", "   "), None);
        let derived = conversation_id_for("u", "s").unwrap();
        assert_eq!(derived.len(), 36);
        assert_eq!(conversation_id_for("u", "s").unwrap(), derived);
        assert_ne!(conversation_id_for("u", "t").unwrap(), derived);
        assert_ne!(conversation_id_for("v", "s").unwrap(), derived);
    }

    #[test]
    fn 桌面端三项_id_都现生成() {
        let ids = new_ids(Identity::Workbuddy, "u", None, Some("sess"), Some("turn"));
        // 桌面端不吃 session_key / turn_request_id
        assert_ne!(ids.conversation_request, "turn");
        assert_eq!(ids.conversation.len(), 36); // UUIDv7 带连字符
        assert_eq!(ids.message.len(), 32);
    }

    #[test]
    fn cli_的会话_id_稳定_请求_id_整轮复用() {
        let a = new_ids(Identity::Cli, "u", None, Some("sess"), Some("turn"));
        let b = new_ids(Identity::Cli, "u", None, Some("sess"), Some("turn"));
        assert_eq!(a.conversation, b.conversation);
        assert_eq!(a.conversation_request, "turn");
        // 消息 id 每请求新生成
        assert_ne!(a.message, b.message);
    }

    #[test]
    fn 显式会话_id_优先() {
        let ids = new_ids(Identity::Cli, "u", Some("given"), Some("sess"), None);
        assert_eq!(ids.conversation, "given");
    }

    #[test]
    fn vscode_的会话_id_是无连字符_hex() {
        let ids = new_ids(Identity::Vscode, "u", None, None, None);
        assert_eq!(ids.conversation.len(), 32);
        assert!(!ids.conversation.contains('-'));
    }

    #[test]
    fn 桌面端的头是完整的一套() {
        let ids = new_ids(Identity::Workbuddy, "u", None, None, None);
        let headers = chat_headers(&input(Realm::Workbuddy, Identity::Workbuddy, &ids));

        // wrapper
        assert_eq!(header_value(&headers, "Origin"), Some("https://www.workbuddy.ai"));
        assert_eq!(header_value(&headers, "X-CodeBuddy-Request"), Some("1"));
        assert_eq!(header_value(&headers, "Accept-Language"), Some("en-US"));
        // 身分
        assert_eq!(header_value(&headers, "X-IDE-Name"), Some("WorkBuddy"));
        assert_eq!(header_value(&headers, "X-IDE-Version"), Some("5.8.4"));
        assert_eq!(header_value(&headers, "X-Product"), Some("SaaS"));
        assert_eq!(header_value(&headers, "X-Private-Data"), Some("true"));
        assert_eq!(header_value(&headers, "X-Domain"), Some("www.workbuddy.ai"));
        assert_eq!(header_value(&headers, "Authorization"), Some("Bearer tok"));
        // root 与 conversation_request 同值
        assert_eq!(
            header_value(&headers, "X-Root-Request-ID"),
            header_value(&headers, "X-Conversation-Request-ID")
        );
        // request id 与 message id 同值
        assert_eq!(
            header_value(&headers, "X-Request-ID"),
            header_value(&headers, "X-Conversation-Message-ID")
        );
        // trace 三件套
        assert!(header_value(&headers, "traceparent").is_some());
        assert_eq!(header_value(&headers, "X-B3-Sampled"), Some("1"));
        assert!(header_value(&headers, "X-B3-ParentSpanId").is_none());
    }

    #[test]
    fn 国内版的_origin_与_domain_不是一回事() {
        let ids = new_ids(Identity::Workbuddy, "u", None, None, None);
        let headers = chat_headers(&input(Realm::Codebuddy, Identity::Workbuddy, &ids));
        assert_eq!(header_value(&headers, "Origin"), Some("https://www.codebuddy.cn"));
        assert_eq!(header_value(&headers, "Referer"), Some("https://www.codebuddy.cn/"));
        assert_eq!(header_value(&headers, "X-Domain"), Some("copilot.tencent.com"));
        assert_eq!(header_value(&headers, "Accept-Language"), Some("zh-CN"));
        assert_eq!(header_value(&headers, "X-IDE-Version"), Some("5.5.6"));
    }

    #[test]
    fn vscode_不发_root_request_id_也不发_x_trace_id() {
        let ids = new_ids(Identity::Vscode, "u", None, None, None);
        let headers = chat_headers(&input(Realm::Workbuddy, Identity::Vscode, &ids));
        assert!(header_value(&headers, "X-Root-Request-ID").is_none());
        assert!(header_value(&headers, "X-Trace-ID").is_none());
        assert!(header_value(&headers, "traceparent").is_none());
        // b3 是四段：traceId - spanId - sampled - parentSpanId
        let b3 = header_value(&headers, "b3").unwrap();
        assert_eq!(b3.split('-').count(), 4, "b3 段数不对：{b3}");
        assert!(header_value(&headers, "X-Request-Trace-Id").is_some());
    }

    #[test]
    fn vscode_带_model_时才有_model_id() {
        let ids = new_ids(Identity::Vscode, "u", None, None, None);
        let plain = chat_headers(&input(Realm::Workbuddy, Identity::Vscode, &ids));
        assert!(header_value(&plain, "X-Model-ID").is_none());

        let mut with_model = input(Realm::Workbuddy, Identity::Vscode, &ids);
        with_model.model = Some("glm-5.2");
        let headers = chat_headers(&with_model);
        assert_eq!(header_value(&headers, "X-Model-ID"), Some("glm-5.2"));
        assert!(header_value(&headers, "monitor_httpSendTime").is_some());
    }

    #[test]
    fn vscode_只在国际站发_private_data() {
        let ids = new_ids(Identity::Vscode, "u", None, None, None);
        let intl = chat_headers(&input(Realm::Workbuddy, Identity::Vscode, &ids));
        assert_eq!(header_value(&intl, "X-Private-Data"), Some("true"));
        let cn = chat_headers(&input(Realm::Codebuddy, Identity::Vscode, &ids));
        assert!(header_value(&cn, "X-Private-Data").is_none());
        // 国内站非企业号补失败态占位
        assert_eq!(
            header_value(&cn, "X-Device-Token-Error"),
            Some("sdk_not_initialized")
        );
    }

    #[test]
    fn cli_没有浏览器头_但带_stainless() {
        let ids = new_ids(Identity::Cli, "u", None, Some("s"), None);
        let headers = chat_headers(&input(Realm::Workbuddy, Identity::Cli, &ids));
        assert!(header_value(&headers, "Origin").is_none());
        assert!(header_value(&headers, "Referer").is_none());
        assert!(header_value(&headers, "X-CodeBuddy-Request").is_none());
        assert!(header_value(&headers, "X-Requested-With").is_none());
        assert_eq!(header_value(&headers, "Accept"), Some("application/json"));
        assert_eq!(header_value(&headers, "x-stainless-lang"), Some("js"));
        assert_eq!(
            header_value(&headers, "x-stainless-package-version"),
            Some("6.25.0")
        );
        // CLI 的 b3 带 parent span
        assert!(header_value(&headers, "X-B3-ParentSpanId").is_some());
        assert!(header_value(&headers, "traceparent").is_some());
    }

    #[test]
    fn cli_的_private_data_按企业号分流() {
        let ids = new_ids(Identity::Cli, "u", None, Some("s"), None);
        let personal = chat_headers(&input(Realm::Workbuddy, Identity::Cli, &ids));
        assert_eq!(header_value(&personal, "X-Private-Data"), Some("false"));

        let mut enterprise = input(Realm::Workbuddy, Identity::Cli, &ids);
        enterprise.enterprise_id = "ent-1";
        let headers = chat_headers(&enterprise);
        assert_eq!(header_value(&headers, "X-Private-Data"), Some("true"));
        assert_eq!(header_value(&headers, "X-Enterprise-Id"), Some("ent-1"));
        // 没给 tenant 时回落成 enterprise id
        assert_eq!(header_value(&headers, "X-Tenant-Id"), Some("ent-1"));
    }

    #[test]
    fn 设备_token_只在国内版与桌面端出现() {
        let ids = new_ids(Identity::Workbuddy, "u", None, None, None);

        let mut cn = input(Realm::Codebuddy, Identity::Workbuddy, &ids);
        cn.device_token = Some("dev-token");
        assert_eq!(
            header_value(&chat_headers(&cn), "X-Device-Token"),
            Some("dev-token")
        );

        // 国际版即使配了也不发
        let mut intl = input(Realm::Workbuddy, Identity::Workbuddy, &ids);
        intl.device_token = Some("dev-token");
        assert!(header_value(&chat_headers(&intl), "X-Device-Token").is_none());

        // CLI 身份无论如何不发
        let cli_ids = new_ids(Identity::Cli, "u", None, Some("s"), None);
        let mut cli = input(Realm::Codebuddy, Identity::Cli, &cli_ids);
        cli.device_token = Some("dev-token");
        let headers = chat_headers(&cli);
        assert!(header_value(&headers, "X-Device-Token").is_none());
        assert!(header_value(&headers, "X-Device-Token-Error").is_none());
    }

    #[test]
    fn 空_uid_回落成_anonymous() {
        let ids = new_ids(Identity::Workbuddy, "", None, None, None);
        let mut request = input(Realm::Workbuddy, Identity::Workbuddy, &ids);
        request.uid = "";
        assert_eq!(
            header_value(&chat_headers(&request), "X-User-Id"),
            Some("anonymous")
        );
    }

    #[test]
    fn 身分字符串能双向解析() {
        for identity in [Identity::Workbuddy, Identity::Vscode, Identity::Cli] {
            assert_eq!(Identity::parse(identity.as_str()), Some(identity));
        }
        assert_eq!(Identity::parse("desktop"), Some(Identity::Workbuddy));
        assert_eq!(Identity::parse("codebuddy"), Some(Identity::Cli));
        assert_eq!(Identity::parse("nope"), None);
    }
}
