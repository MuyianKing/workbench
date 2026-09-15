//! 账号登录：GitHub / Gitee 的授权码流程 + 本机回环回调。
//!
//! **为什么是回环回调而不是设备码**：设备码要用户手抄一串码，而回环回调就是 VS Code 那种
//! 「点一下 → 浏览器授权 → 自动跳回应用」。做法是应用在本机 `127.0.0.1:45871` 起一个小 HTTP
//! 服务，把它的地址注册成两家的回调地址 —— 浏览器只是访问本机的一个普通网页，所以不需要
//! 注册任何自定义协议，也不需要管理员权限。
//!
//! **为什么端口写死**：Gitee 要求 `redirect_uri` 与注册时填的完全一致，随机端口必然对不上。
//! GitHub 对回环地址豁免端口匹配，但两家用同一个地址更省心（注册时填同一个即可）。
//! 端口被占用时给明确报错，不静默换端口。
//!
//! **凭据从哪来**：编译期由 `build.rs` 从 `oauth.local.json`（不入库）或 `oauth.example.json`
//! 注入，所以使用者只需要有账号、点一下就登录，不必自己去注册 OAuth 应用。
//! 本模块只在 Rust 侧持有 client_secret，**绝不回传给渲染层**。
//!
//! **token 落到哪**：Windows 凭据管理器（见 credentials.rs），同样不进渲染层 ——
//! 前端拿到的只有登录名 / 昵称 / 头像。同步时由 sync.rs 直接取用。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::credentials;
use crate::encoding::{base64, base64_url, sha256};
use crate::http;

/// 回环回调的监听地址。三个常量拼出 `redirect_uri()`，**改了就必须同步改两家平台上注册的回调地址**。
const REDIRECT_HOST: &str = "127.0.0.1";
const REDIRECT_PORT: u16 = 45871;
const REDIRECT_PATH: &str = "/callback";

/// 一次登录的有效期。超过就当作放弃 —— 浏览器标签页可能已经被关掉了，无限等下去没意义。
const SESSION_TTL: Duration = Duration::from_secs(300);

/// 读回调请求的超时。浏览器在连上的那一刻就把请求行发出来了，正常在毫秒级返回；
/// 这个上限是兜住「连上但一直不发数据」的连接（端口扫描、预连接），别让它把工作线程挂住。
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(1);
const CALLBACK_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// build.rs 注入的凭据。文件缺失时注入的是模板（值全空），见 oauth.example.json。
const EMBEDDED: &str = include_str!(concat!(env!("OUT_DIR"), "/oauth.json"));

pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    /// 授权页所在的 host
    auth_host: &'static str,
    authorize_path: &'static str,
    /// 用授权码换 token 的端点
    token_path: &'static str,
    /// 用户信息接口
    api_host: &'static str,
    api_path: &'static str,
    /// 授权范围。GitHub 在这里申请；**Gitee 的权限是注册应用时勾死的**，这里传空。
    scope: &'static str,
    /// 是否支持 PKCE。只有 GitHub 支持（只接受 S256），Gitee 未见文档说明。
    pkce: bool,
    /// 注入 git 时 Basic 认证的用户名部分
    git_user: &'static str,
    /// git 仓库的 host，用于生成 host 限定的 extraheader
    git_host: &'static str,
}

pub const PROVIDERS: [Provider; 2] = [
    Provider {
        id: "github",
        label: "GitHub",
        auth_host: "github.com",
        authorize_path: "/login/oauth/authorize",
        token_path: "/login/oauth/access_token",
        api_host: "api.github.com",
        api_path: "/user",
        // repo：同步私有仓库要推送，read:user 只够读昵称头像
        scope: "read:user repo",
        pkce: true,
        git_user: "x-access-token",
        git_host: "github.com",
    },
    Provider {
        id: "gitee",
        label: "Gitee",
        auth_host: "gitee.com",
        authorize_path: "/oauth/authorize",
        token_path: "/oauth/token",
        api_host: "gitee.com",
        api_path: "/api/v5/user",
        // 不留空会让 Gitee 报错：它的 scope 来自应用注册时勾选的权限范围
        scope: "",
        pkce: false,
        git_user: "oauth2",
        git_host: "gitee.com",
    },
];

#[derive(Deserialize, Default, Debug)]
struct ProviderConfig {
    #[serde(rename = "clientId", default)]
    client_id: String,
    #[serde(rename = "clientSecret", default)]
    client_secret: String,
}

/// 模板里的 `_readme` 之类的说明字段会被 serde 默认忽略（没开 deny_unknown_fields）
#[derive(Deserialize, Default)]
struct EmbeddedConfig {
    #[serde(default)]
    github: ProviderConfig,
    #[serde(default)]
    gitee: ProviderConfig,
}

fn embedded() -> &'static EmbeddedConfig {
    static CONFIG: OnceLock<EmbeddedConfig> = OnceLock::new();
    CONFIG.get_or_init(|| serde_json::from_str(EMBEDDED).unwrap_or_default())
}

fn provider_of(id: &str) -> Result<&'static Provider, String> {
    PROVIDERS
        .iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| format!("不认识的登录方式：{id}"))
}

/// 取某家的凭据并校验
fn config_of(provider: &Provider) -> Result<ProviderConfig, String> {
    let raw = match provider.id {
        "github" => &embedded().github,
        _ => &embedded().gitee,
    };
    validate(
        provider,
        ProviderConfig {
            client_id: raw.client_id.trim().to_string(),
            client_secret: raw.client_secret.trim().to_string(),
        },
    )
}

/// 凭据得齐两样才算能登录。分成单独一件是为了能直接测这两个分支（内嵌配置是空的模板，
/// 走 `config_of` 永远只会撞到第一条）。
fn validate(provider: &Provider, config: ProviderConfig) -> Result<ProviderConfig, String> {
    if config.client_id.is_empty() {
        return Err(format!(
            "当前构建未内置 {} 的 OAuth 凭据。把 oauth.example.json 复制成 oauth.local.json、\
             填入 clientId 后重新构建即可（见 README 的「启用账号登录」一节）。",
            provider.label
        ));
    }
    // clientSecret **两家都必填**。GitHub 虽然支持 PKCE，但授权码流程里 client_secret 仍是必需的
    // （官方文档把它标为 Required）—— 早期版本这里允许留空并只发 PKCE，结果是浏览器授权成功、
    // 换 token 那一步被一句 incorrect_client_credentials 挡回来，表现成「点了登录没反应」。
    if config.client_secret.is_empty() {
        return Err(format!(
            "{} 的 clientSecret 没有配置，无法换取访问令牌。\
             把 oauth.example.json 复制成 oauth.local.json、填入 clientSecret 后重新构建即可。",
            provider.label
        ));
    }
    Ok(config)
}

/// 是否至少有一家能用（渲染层据此决定登录按钮是否可点）
pub fn configured() -> bool {
    PROVIDERS.iter().any(|provider| config_of(provider).is_ok())
}

/// 一家都用不了时，把原因带出去。
///
/// 界面上只写「未内置凭据」是不够的 —— 凭据填了但少一项（比如只填 clientId）时，
/// 那句话会把人引向「是不是没配置」，而真正该做的是补上缺的那一项。
fn config_error() -> String {
    // 只要还有一家能用，这里就是空串：否则会把某一家的毛病当成整体的毛病报出来
    if configured() {
        return String::new();
    }
    PROVIDERS
        .iter()
        .find_map(|provider| config_of(provider).err())
        .unwrap_or_default()
}

fn redirect_uri() -> String {
    format!("http://{REDIRECT_HOST}:{REDIRECT_PORT}{REDIRECT_PATH}")
}

// ---------- 登录会话 ----------

struct Pending {
    provider: &'static Provider,
    /// CSRF 防护：授权页带去、回调带回来，对不上就丢弃
    state: String,
    /// PKCE 的 code_verifier（只有 GitHub 用）
    verifier: Option<String>,
    listener: TcpListener,
    started: Instant,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// 随手生成一串够用的随机值（state 与 code_verifier 都用它）。
/// 两个 uuid 拼起来 64 个十六进制字符 —— PKCE 要求 verifier 是 43~128 个 unreserved 字符。
fn random_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// 不认得的登录方式 / 没内置凭据都在这里拦下，且不动已有会话
pub fn login_start(provider_id: &str) -> Result<Value, String> {
    let provider = provider_of(provider_id)?;
    let config = config_of(provider)?;

    // 起新的之前先把上一次的收掉：否则监听端口还占着，bind 一定失败
    *PENDING.lock().unwrap() = None;

    // 端口被占用就明确报错，不静默换端口 —— Gitee 的 redirect_uri 必须与注册值逐字一致，
    // 换端口只会变成一个更难懂的「回调地址不匹配」。
    let listener = TcpListener::bind((REDIRECT_HOST, REDIRECT_PORT)).map_err(|err| {
        format!(
            "无法监听 {REDIRECT_HOST}:{REDIRECT_PORT}（{err}）。这个端口被别的程序占用时登录不可用，\
             请关掉占用它的程序后重试。"
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("无法设置为非阻塞监听: {err}"))?;

    let state = random_secret();
    // PKCE 当纵深防御：secret 已经必带，但把 code_challenge 一起发出去没有坏处，
    // 万一授权码在本地被谁截走，没有 verifier 也换不出 token。Gitee 未见支持，永远为 None。
    let verifier = if provider.pkce { Some(random_secret()) } else { None };

    let mut params: Vec<(&str, String)> = vec![
        ("client_id", config.client_id.clone()),
        ("redirect_uri", redirect_uri()),
        ("response_type", "code".to_string()),
        ("state", state.clone()),
    ];
    if !provider.scope.is_empty() {
        params.push(("scope", provider.scope.to_string()));
    }
    if let Some(verifier) = &verifier {
        params.push(("code_challenge", base64_url(&sha256(verifier.as_bytes()))));
        params.push(("code_challenge_method", "S256".to_string()));
    }

    let auth_url = format!(
        "https://{}{}?{}",
        provider.auth_host,
        provider.authorize_path,
        encode_pairs(&params)
    );

    *PENDING.lock().unwrap() = Some(Pending {
        provider,
        state,
        verifier,
        listener,
        started: Instant::now(),
    });

    Ok(json!({ "authUrl": auth_url, "redirectUri": redirect_uri() }))
}

pub fn login_cancel() {
    *PENDING.lock().unwrap() = None;
}

/// 收一次回调。非阻塞，没连接就返回 `pending`；轮询节奏由渲染层控制。
pub fn login_poll() -> Value {
    let step = {
        let mut guard = PENDING.lock().unwrap();
        let Some(pending) = guard.as_mut() else {
            return json!({ "status": "failed", "error": "没有进行中的登录，请重新发起" });
        };

        if pending.started.elapsed() > SESSION_TTL {
            *guard = None;
            return json!({ "status": "expired", "error": "等待授权超时，请重新发起登录" });
        }

        // 本地读写，很快；网络的活等放掉锁之后再做，免得 cancel 被卡住
        match receive_callback(pending) {
            Callback::Idle => None,
            Callback::Ignore => None,
            Callback::Denied(error) => {
                *guard = None;
                return json!({ "status": "denied", "error": error });
            }
            Callback::Code { code, provider, verifier } => {
                *guard = None;
                Some((provider, code, verifier))
            }
        }
    };

    match step {
        None => json!({ "status": "pending" }),
        Some((provider, code, verifier)) => complete(provider, &code, verifier.as_deref()),
    }
}

/// 手动兜底：回调没回来时，让用户把浏览器地址栏里的完整回调地址粘进来。
/// VS Code 也留了同类出口，端口被占用或浏览器没跳回来时不至于卡死。
pub fn login_submit(pasted: &str) -> Value {
    let Some((code, state)) = parse_callback_url(pasted) else {
        return json!({
            "status": "failed",
            "error": "这段地址里没有授权码，请复制浏览器地址栏里以 /callback 开头的那一整条"
        });
    };

    let taken = {
        let mut guard = PENDING.lock().unwrap();
        let Some(pending) = guard.as_ref() else {
            return json!({ "status": "failed", "error": "没有进行中的登录，请重新发起" });
        };
        if state != pending.state {
            *guard = None;
            return json!({ "status": "denied", "error": "授权状态不匹配，本次登录已作废，请重新发起" });
        }
        let provider = pending.provider;
        let verifier = pending.verifier.clone();
        *guard = None;
        (provider, verifier)
    };

    complete(taken.0, &code, taken.1.as_deref())
}

// ---------- 回调接收 ----------

enum Callback {
    /// 还没有连接
    Idle,
    /// 来了连接但不是我们的回调（浏览器会顺手要 favicon），继续等
    Ignore,
    /// 授权被拒或不匹配
    Denied(String),
    Code {
        provider: &'static Provider,
        code: String,
        verifier: Option<String>,
    },
}

/// 非阻塞收一个连接并解析。**只处理一次**，其余连接留给下一轮轮询。
fn receive_callback(pending: &Pending) -> Callback {
    let stream = match pending.listener.accept() {
        Ok((stream, _)) => stream,
        // 还没人来，或这条连接已经断了 —— 都当没事发生
        Err(_) => return Callback::Idle,
    };

    // **必须把流改回阻塞再读。** Windows 上 `accept` 出来的 socket 会继承监听套接字的非阻塞模式
    // （Linux 不会，所以这个坑只在 Windows 上现形）：不改的话，下面那次 read 立刻拿到
    // WouldBlock、请求行读成空串，这个回调就被当成无关键接丢掉了 —— 浏览器明明跳回了回调地址，
    // 应用却毫无反应，而且不会有任何报错。读超时是为了兜住「连上了但一直不发数据」的连接，
    // 不要让它把工作线程挂住（顺序：先设超时，再改阻塞）。
    let mut stream = stream;
    let _ = stream.set_read_timeout(Some(CALLBACK_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CALLBACK_WRITE_TIMEOUT));
    let _ = stream.set_nonblocking(false);

    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
    // 请求行：`GET /callback?code=…&state=… HTTP/1.1`
    let target = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
        .to_string();

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target.as_str(), ""),
    };

    if path != REDIRECT_PATH {
        // favicon 之类。回个 404 打发掉，会话继续等。
        // 读不到请求行也会落到这里（target 是空串），所以文案要能提示这种情况。
        let empty = text.trim().is_empty();
        if empty {
            // 读不到内容属于异常，落一行日志：这类问题只看界面是查不出来的
            eprintln!("[workbench] 回调连接上没读到请求内容（可能不是浏览器的请求）");
        } else if path != "/favicon.ico" {
            // favicon 是浏览器顺手要的，正常现象不必记
            eprintln!("[workbench] 回调端口收到无关请求：{path}");
        }
        let detail = if empty {
            "没能读到这次请求的内容，请回到 Workbench 重新发起登录。"
        } else {
            "这个地址不是登录回调，可以关掉。"
        };
        respond(&mut stream, "404 Not Found", &page("不是登录回调", detail));
        return Callback::Ignore;
    }

    let params = parse_query(query);
    let find = |key: &str| {
        params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };

    if let Some(error) = find("error") {
        let detail = find("error_description").unwrap_or(error);
        respond(&mut stream, "200 OK", &page("授权未完成", &detail));
        return Callback::Denied(format!("授权未完成：{detail}"));
    }

    let Some(code) = find("code") else {
        respond(&mut stream, "400 Bad Request", &page("缺少授权码", "请回到 Workbench 重新发起登录。"));
        return Callback::Ignore;
    };

    if find("state").as_deref() != Some(pending.state.as_str()) {
        respond(
            &mut stream,
            "400 Bad Request",
            &page("授权状态不匹配", "本次登录已作废，请回到 Workbench 重新发起。"),
        );
        return Callback::Denied("授权状态不匹配，本次登录已作废，请重新发起".into());
    }

    // 这一页**不能写「登录成功」**：响应发生在换取 token 之前，那一步失败的话，
    // 浏览器上写着成功、应用里却报错，看上去就像「点了登录没反应」。结果一律由应用那边说。
    respond(
        &mut stream,
        "200 OK",
        &page("授权已完成", "正在回到 Workbench 完成登录，这个页面可以关掉了。"),
    );
    eprintln!("[workbench] 收到 {} 的授权回调，正在换取访问令牌", pending.provider.label);
    Callback::Code {
        provider: pending.provider,
        code,
        verifier: pending.verifier.clone(),
    }
}

fn respond(stream: &mut std::net::TcpStream, status: &str, html: &str) {
    let body = html.as_bytes();
    let head = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn page(title: &str, detail: &str) -> String {
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>Workbench · {title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;background:#16181d;color:#e8eaed;\
         display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
         <div style=\"text-align:center\"><h1 style=\"font-size:20px;font-weight:600\">{title}</h1>\
         <p style=\"color:#9aa0a6\">{detail}</p></div></body></html>"
    )
}

// ---------- 换取 token 与账号信息 ----------

/// 用授权码换 token → 存凭据 → 拉账号信息。返回给渲染层的结果里**没有 token**。
fn complete(provider: &'static Provider, code: &str, verifier: Option<&str>) -> Value {
    let config = match config_of(provider) {
        Ok(config) => config,
        Err(err) => return json!({ "status": "failed", "error": err }),
    };

    let mut params: Vec<(&str, String)> = vec![
        ("client_id", config.client_id.clone()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri()),
        ("grant_type", "authorization_code".to_string()),
    ];
    if !config.client_secret.is_empty() {
        params.push(("client_secret", config.client_secret.clone()));
    }
    if let Some(verifier) = verifier {
        params.push(("code_verifier", verifier.to_string()));
    }

    let response = match http::request(
        "POST",
        provider.auth_host,
        provider.token_path,
        &[
            ("Accept", "application/json"),
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("User-Agent", "Workbench"),
        ],
        Some(&encode_pairs(&params)),
    ) {
        Ok(response) => response,
        Err(err) => return json!({ "status": "failed", "error": err }),
    };

    let payload: Value = match serde_json::from_str(&response.text()) {
        Ok(value) => value,
        Err(_) => {
            return json!({
                "status": "failed",
                "error": format!("{} 返回了看不懂的内容（HTTP {}）", provider.label, response.status)
            })
        }
    };

    // 两家的失败回包都是 { error, error_description }
    if let Some(error) = payload.get("error").and_then(Value::as_str) {
        let detail = payload
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        // 这一种最常见：凭据与平台上注册的对不上（改了 oauth.local.json 却没重新构建，
        // 或者 clientSecret 压根没填）。光看 error_description 很难反应过来，补一句怎么做。
        let hint = if error == "incorrect_client_credentials" {
            "。clientId / clientSecret 要和平台上注册的完全一致，改完 oauth.local.json 必须重新构建才生效"
        } else {
            ""
        };
        let message = format!("{} 拒绝了授权：{detail}{hint}", provider.label);
        eprintln!("[workbench] {message}");
        return json!({ "status": "failed", "error": message });
    }

    let Some(token) = payload.get("access_token").and_then(Value::as_str) else {
        return json!({
            "status": "failed",
            "error": format!("{} 没有返回 access_token（HTTP {}）", provider.label, response.status)
        });
    };

    // 先落盘再拉资料：token 已经拿到了，这一步失败也不该让它白拿
    if let Err(err) = credentials::store(provider.id, token) {
        return json!({ "status": "failed", "error": err });
    }

    match fetch_account(provider, token) {
        Ok(account) => json!({ "status": "ok", "account": account }),
        Err(err) => json!({ "status": "failed", "error": err }),
    }
}

/// 拉账号信息。token 只在这里当参数用，不会出现在返回值里。
fn fetch_account(provider: &'static Provider, token: &str) -> Result<Value, String> {
    let authorization = if provider.id == "github" {
        format!("Bearer {token}")
    } else {
        format!("token {token}")
    };

    let response = http::request(
        "GET",
        provider.api_host,
        provider.api_path,
        &[
            ("Authorization", &authorization),
            ("Accept", "application/json"),
            // GitHub 的 API 不带 User-Agent 直接 403
            ("User-Agent", "Workbench"),
        ],
        None,
    )?;

    if response.status != 200 {
        return Err(format!(
            "读取 {} 账号信息失败（HTTP {}），请重新登录",
            provider.label, response.status
        ));
    }

    let payload: Value =
        serde_json::from_str(&response.text()).map_err(|err| format!("账号信息解析失败: {err}"))?;

    let text = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };

    let login = text("login").unwrap_or_else(|| provider.label.to_string());
    let avatar = payload
        .get("avatar_url")
        .and_then(Value::as_str)
        .and_then(fetch_avatar);

    Ok(json!({
        "provider": provider.id,
        "id": payload.get("id").map(|id| id.to_string()).unwrap_or_default(),
        "login": login,
        // 昵称可以是空的，界面上回落到登录名
        "name": text("name"),
        "avatar": avatar,
    }))
}

/// 头像转 data URL。
///
/// **为什么不让渲染层直接 `<img src>` 那个外网地址**：那样会多出一个不受本模块掌控的网络出口，
/// 而这里所有对外请求都集中在 Rust，便于审计（README「数据与隐私」也是这么写的）。
fn fetch_avatar(url: &str) -> Option<String> {
    let (host, path) = split_url(url)?;
    let response = http::request("GET", &host, &path, &[("User-Agent", "Workbench")], None).ok()?;
    if response.status != 200 {
        return None;
    }
    let mime = sniff_image(&response.body)?;
    Some(format!("data:{mime};base64,{}", base64(&response.body)))
}

/// 从 `https://host/path?query` 里拆出 host 与 path+query。
fn split_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

/// 按文件头认图片类型。
///
/// 不读响应的 `Content-Type`：为这一个用途去解析响应头，比读几个魔数字节复杂得多，
/// 而这里唯一会拉的就是头像。认不出来就不显示头像（返回 None），不猜。
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

// ---------- 查询串 ----------

/// 只留 RFC 3986 的 unreserved 字符，其余百分号转义。
/// 授权 URL 与表单体共用一套（`%20` 在两种场合都合法）。
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn encode_pairs(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((name, value)) => (decode_component(name), decode_component(value)),
            None => (decode_component(part), String::new()),
        })
        .collect()
}

fn decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match u8::from_str_radix(&text[index + 1..index + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// 从用户粘进来的一整条回调地址里取出 `code` 与 `state`。
/// 只认查询串里有 `code` 的那种，别的输入一律返回 None。
fn parse_callback_url(pasted: &str) -> Option<(String, String)> {
    let text = pasted.trim();
    let query = text.split_once('?').map(|(_, query)| query)?;
    let params = parse_query(query.split('#').next().unwrap_or(query));

    let find = |key: &str| {
        params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    Some((find("code")?, find("state").unwrap_or_default()))
}

// ---------- 对外状态 ----------

/// 已登录的 provider 列表（凭据管理器里有 token 的那些）
fn logged_in() -> Vec<&'static str> {
    PROVIDERS
        .iter()
        .filter(|provider| credentials::read(provider.id).is_some())
        .map(|provider| provider.id)
        .collect()
}

pub fn status() -> Value {
    json!({
        "configured": configured(),
        "redirectUri": redirect_uri(),
        "providers": logged_in(),
        // 只在完全用不了时才有值，界面直接显示它
        "configError": config_error(),
    })
}

/// 重新拉一次账号信息（启动时刷新头像用）
pub fn refresh_account(provider_id: &str) -> Result<Value, String> {
    let provider = provider_of(provider_id)?;
    let token = credentials::read(provider.id)
        .ok_or_else(|| format!("尚未登录 {}", provider.label))?;
    fetch_account(provider, &token)
}

pub fn logout(provider_id: &str) -> Result<(), String> {
    let provider = provider_of(provider_id)?;
    credentials::remove(provider.id)
}

/// 给 git 用的环境变量：把已登录账号的 token 变成一条 **host 限定**的请求头。
///
/// **必须带 URL 前缀**（`http.https://github.com/.extraheader` 而不是 `http.extraheader`）：
/// 后者是全局的，git 会把 token 发给**任何**远端地址 —— 同步仓库填了别的域名时就泄露了。
///
/// 走 `GIT_CONFIG_*` 环境变量而不是 `-c` 参数：`-c` 会出现在进程命令行里，同机其他进程看得见；
/// 也不会落进 `.git/config`（那会把 token 写进同步仓库的本地副本）。
pub fn git_envs() -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();

    for provider in PROVIDERS.iter() {
        let Some(token) = credentials::read(provider.id) else {
            continue;
        };
        let basic = base64(format!("{}:{}", provider.git_user, token).as_bytes());
        entries.push((
            format!("http.https://{}/.extraheader", provider.git_host),
            format!("Authorization: Basic {basic}"),
        ));
    }

    if entries.is_empty() {
        return Vec::new();
    }

    let mut envs = vec![("GIT_CONFIG_COUNT".to_string(), entries.len().to_string())];
    for (index, (key, value)) in entries.into_iter().enumerate() {
        envs.push((format!("GIT_CONFIG_KEY_{index}"), key));
        envs.push((format!("GIT_CONFIG_VALUE_{index}"), value));
    }
    envs
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    use super::*;

    /// 回归用例：回调请求必须真被读到。
    ///
    /// Windows 上 `accept` 出来的 socket 会继承监听套接字的非阻塞模式，刚开始这里读到的永远是空串，
    /// 回调被当成无关键接丢掉 —— 现象是「浏览器已经跳回 `127.0.0.1:45871/callback?code=…`，
    /// 应用却毫无反应，也不报错」。这个用例拿真监听 + 真连接走一遍收回调，钉住它。
    #[test]
    fn reads_the_request_line_of_the_callback() {
        let listener = TcpListener::bind((REDIRECT_HOST, 0)).expect("绑定临时端口失败");
        listener.set_nonblocking(true).expect("设置非阻塞失败");
        let port = listener.local_addr().unwrap().port();

        // 扮演浏览器：连上就发一行请求行，然后读掉响应免得服务端写阻塞
        let client = std::thread::spawn(move || {
            let mut socket = TcpStream::connect((REDIRECT_HOST, port)).expect("连接失败");
            socket
                .write_all(b"GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .expect("发送请求失败");
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer);
        });

        let pending = Pending {
            provider: &PROVIDERS[0],
            state: "xyz".to_string(),
            verifier: None,
            listener,
            started: Instant::now(),
        };

        // 连接不一定已经到达，轮询到 accept 成功为止
        let mut last = Callback::Idle;
        for _ in 0..100 {
            last = receive_callback(&pending);
            if !matches!(last, Callback::Idle) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        match last {
            Callback::Code { code, provider, .. } => {
                assert_eq!(code, "abc123");
                assert_eq!(provider.id, "github");
            }
            // 读成空串时会走到 Ignore（请求行是空的 → path 对不上）
            Callback::Ignore => panic!("回调请求没被读到：assume 出来的流多半还是非阻塞的"),
            Callback::Denied(err) => panic!("不该被判成授权被拒：{err}"),
            Callback::Idle => panic!("一直没等到连接"),
        }

        client.join().expect("客户端线程异常");
    }

    /// 不是回调的请求（浏览器会顺手要 favicon）要打发掉，但不能把会话结束掉
    #[test]
    fn ignores_requests_that_are_not_the_callback() {
        let listener = TcpListener::bind((REDIRECT_HOST, 0)).expect("绑定临时端口失败");
        listener.set_nonblocking(true).expect("设置非阻塞失败");
        let port = listener.local_addr().unwrap().port();

        let client = std::thread::spawn(move || {
            let mut socket = TcpStream::connect((REDIRECT_HOST, port)).expect("连接失败");
            socket
                .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .expect("发送请求失败");
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer);
        });

        let pending = Pending {
            provider: &PROVIDERS[0],
            state: "xyz".to_string(),
            verifier: None,
            listener,
            started: Instant::now(),
        };

        let mut last = Callback::Idle;
        for _ in 0..100 {
            last = receive_callback(&pending);
            if !matches!(last, Callback::Idle) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(matches!(last, Callback::Ignore), "favicon 请求该被忽略而不是结束会话");
        client.join().expect("客户端线程异常");
    }

    #[test]
    fn redirect_uri_is_the_registered_one() {
        // 改这三个常量就等于改了要在两家平台上注册的回调地址，这里钉住它
        assert_eq!(redirect_uri(), "http://127.0.0.1:45871/callback");
    }

    #[test]
    fn percent_encoding_covers_the_unreserved_set() {
        assert_eq!(encode_component("abc-_.~123"), "abc-_.~123");
        assert_eq!(encode_component("127.0.0.1:45871/callback"), "127.0.0.1%3A45871%2Fcallback");
        assert_eq!(encode_component("read:user repo"), "read%3Auser%20repo");
        // 非 ASCII 按 UTF-8 的字节转义
        assert_eq!(encode_component("中"), "%E4%B8%AD");
    }

    #[test]
    fn query_round_trips_through_encode_and_decode() {
        let pairs = vec![
            ("redirect_uri", "http://127.0.0.1:45871/callback".to_string()),
            ("scope", "read:user repo".to_string()),
        ];
        let encoded = encode_pairs(&pairs);
        assert_eq!(encoded, "redirect_uri=http%3A%2F%2F127.0.0.1%3A45871%2Fcallback&scope=read%3Auser%20repo");

        let decoded = parse_query(&encoded);
        assert_eq!(decoded[0].1, "http://127.0.0.1:45871/callback");
        assert_eq!(decoded[1].1, "read:user repo");
    }

    #[test]
    fn decodes_plus_as_space_and_keeps_broken_escapes() {
        assert_eq!(decode_component("a+b"), "a b");
        // 坏的转义不该 panic，也不该把后面的字符吃掉
        assert_eq!(decode_component("100%"), "100%");
        assert_eq!(decode_component("%zz"), "%zz");
    }

    #[test]
    fn parses_the_pasted_callback_url() {
        let pasted = "http://127.0.0.1:45871/callback?code=abc123&state=xyz";
        assert_eq!(
            parse_callback_url(pasted),
            Some(("abc123".to_string(), "xyz".to_string()))
        );

        // 浏览器有时会在末尾挂个锚点
        let with_hash = "http://127.0.0.1:45871/callback?code=abc&state=xyz#";
        assert_eq!(
            parse_callback_url(with_hash),
            Some(("abc".to_string(), "xyz".to_string()))
        );

        // 没有 code 的输入一律不认
        assert_eq!(parse_callback_url("http://127.0.0.1:45871/callback?state=xyz"), None);
        assert_eq!(parse_callback_url("随便粘贴的一段话"), None);
    }

    #[test]
    fn splits_urls_into_host_and_path() {
        assert_eq!(
            split_url("https://avatars.githubusercontent.com/u/1?v=4"),
            Some(("avatars.githubusercontent.com".to_string(), "/u/1?v=4".to_string()))
        );
        assert_eq!(
            split_url("https://gitee.com"),
            Some(("gitee.com".to_string(), "/".to_string()))
        );
        assert_eq!(split_url("file:///etc/passwd"), None);
    }

    #[test]
    fn sniffs_the_image_types_we_may_get() {
        assert_eq!(sniff_image(&[0x89, b'P', b'N', b'G', 0x0d]), Some("image/png"));
        assert_eq!(sniff_image(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF____WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"BM______"), Some("image/bmp"));
        // 认不出来就不显示头像，不猜
        assert_eq!(sniff_image(b"not an image"), None);
        assert_eq!(sniff_image(b""), None);
    }

    /// 没内置凭据时错误信息要指路，而不是只说「失败」。
    ///
    /// 这里走 `validate` 而不是 `config_of`：后者读的是编译期注入的真实凭据，
    /// 开发者本机配好了它就成功，测试结论会随环境变（这台机器上就变过一次）。
    #[test]
    fn missing_credentials_explain_what_to_do() {
        let err = validate(&PROVIDERS[0], ProviderConfig::default()).unwrap_err();
        assert!(err.contains("clientId"), "要说清缺的是哪一项：{err}");
        assert!(err.contains("oauth.local.json"), "要告诉用户怎么办：{err}");
    }

    /// clientId 填了、clientSecret 没填 —— GitHub 那条线踩过的坑，
    /// 它会一路走到换 token 才失败，必须在登录之前就拦下来
    #[test]
    fn a_missing_client_secret_is_rejected_up_front() {
        let config = ProviderConfig {
            client_id: "Iv1.0123456789abcdef".to_string(),
            client_secret: String::new(),
        };
        let err = validate(&PROVIDERS[0], config).unwrap_err();
        assert!(err.contains("clientSecret"), "要说清缺的是哪一项：{err}");
        assert!(err.contains("oauth.local.json"), "要告诉用户怎么办：{err}");

        // 两样都齐就放行
        let ok_config = ProviderConfig {
            client_id: "Iv1.0123456789abcdef".to_string(),
            client_secret: "secret".to_string(),
        };
        assert!(validate(&PROVIDERS[0], ok_config).is_ok());
    }

    /// git 凭据注入：必须是 host 限定的，且字段编号要对得上 GIT_CONFIG_COUNT
    #[test]
    fn git_envs_are_host_scoped_and_indexed() {
        // 这台机器上大概率没登录过，所以先存两条假的，跑完删掉
        let _ = credentials::store("github", "fake-token-for-test");
        let _ = credentials::store("gitee", "fake-token-for-test");
        let envs = git_envs();
        let _ = credentials::remove("github");
        let _ = credentials::remove("gitee");

        let value = |key: &str| {
            envs.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };

        assert_eq!(value("GIT_CONFIG_COUNT").as_deref(), Some("2"));
        // 关键：键上必须带 URL 前缀，否则 token 会被发给任意远端
        assert_eq!(
            value("GIT_CONFIG_KEY_0").as_deref(),
            Some("http.https://github.com/.extraheader")
        );
        assert_eq!(
            value("GIT_CONFIG_KEY_1").as_deref(),
            Some("http.https://gitee.com/.extraheader")
        );
        assert!(value("GIT_CONFIG_VALUE_0").unwrap().starts_with("Authorization: Basic "));
        // GitHub 用 x-access-token，Gitee 用 oauth2
        assert_eq!(
            value("GIT_CONFIG_VALUE_0").unwrap(),
            format!("Authorization: Basic {}", base64(b"x-access-token:fake-token-for-test"))
        );
        assert_eq!(
            value("GIT_CONFIG_VALUE_1").unwrap(),
            format!("Authorization: Basic {}", base64(b"oauth2:fake-token-for-test"))
        );
    }
}
