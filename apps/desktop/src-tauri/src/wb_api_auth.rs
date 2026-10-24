//! 上游鉴权：续期。这是**唯一**会改写账号 token 的地方。
//!
//! 端点与头都照官方插件那条路：`POST {CHAT_UPSTREAM}/v2/plugin/auth/token/refresh`，
//! 凭证放在 `X-Refresh-Token` 里（不是 `Authorization`），并带一个来源标记 ——
//! 国内版要 `workbuddy`（官方插件报的自己的身份名），写错了上游不认。
//!
//! 纯 I/O 适配：只发请求、解响应、把结果写回 `Account`。要不要续、什么时候续，
//! 由调用方按 [`Account::needs_refresh`] 决定。

use crate::http;
use crate::wb_account::{Account, TokenGrant};
use crate::wb_upstream;

const REFRESH_PATH: &str = "/v2/plugin/auth/token/refresh";

/// 续期。成功时账号的 token 三件套已被更新。
///
/// 失败**不改**账号状态，只把错误交出去 —— 由调用方决定是重试还是标记需要重登。
pub fn refresh(account: &mut Account) -> Result<(), String> {
    if account.refresh_token.trim().is_empty() {
        account.token_expired = true;
        return Err("没有 refresh token，需要重新登录".into());
    }

    let url = wb_upstream::chat_url(REFRESH_PATH);
    // 国内版插件报自己的身份；上游按这个值区分客户端来源
    let source = "workbuddy";
    let mut headers = common_headers();
    headers.push(("X-Refresh-Token", account.refresh_token.as_str()));
    headers.push(("X-Auth-Refresh-Source", source));
    // 企业号续期要带空间 id，否则拿到的是个人空间的新 token
    if !account.enterprise_id.trim().is_empty() {
        headers.push(("X-Enterprise-Id", account.enterprise_id.as_str()));
    }

    let response = http::request_url("POST", &url, &headers, Some("{}"))?;
    let text = response.text();
    if response.status != 200 {
        return Err(format!(
            "续期失败：HTTP {} {}",
            response.status,
            excerpt(&text)
        ));
    }

    let grant = parse_grant(&text)?;
    if grant.access_token.trim().is_empty() {
        return Err(format!("续期返回里没有 accessToken：{}", excerpt(&text)));
    }
    account.absorb_grant(&grant);
    Ok(())
}

/// 解析续期响应。上游包在信封里（`{code, data}`），也见过直接给扁平对象的实现，
/// 两种都认 —— 认错形态的代价是"续期成功却当成失败"。
fn parse_grant(text: &str) -> Result<TokenGrant, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|err| format!("续期响应不是 JSON: {err}"))?;

    if let Some(code) = value.get("code").and_then(serde_json::Value::as_i64) {
        if code != 0 {
            let message = value
                .get("msg")
                .or_else(|| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("上游未说明原因");
            return Err(format!("续期被拒：code={code} {message}"));
        }
    }

    let body = value.get("data").unwrap_or(&value);
    serde_json::from_value::<TokenGrant>(body.clone())
        .map_err(|err| format!("续期响应字段不认识: {err}"))
}

/// 与聊天头那套分开：续期走的是浏览器形态的轻量头，没有会话 id 家族。
fn common_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Content-Type", "application/json"),
        ("Accept", "application/json"),
        ("X-Requested-With", "XMLHttpRequest"),
        ("Origin", wb_upstream::ORIGIN),
        ("User-Agent", wb_upstream::BILLING_UA),
        ("X-CodeBuddy-Request", "1"),
        ("Accept-Language", wb_upstream::ACCEPT_LANGUAGE),
    ]
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    trimmed.chars().take(200).collect::<String>() + "…"
}

// ---------- 登录（设备授权流） ----------
//
// 三步：问一个 state → 用户在浏览器里授权 → 拿 state 换 token。
// 上游签发 state（没有 PKCE），网关只负责把 state 记住并在轮询时带回去。
//
// 这套流程的**唯一用途**是首次接账号；之后靠 refresh 续期，永远不再走这里。

const AUTH_STATE_PATH: &str = "/v2/plugin/auth/state";
const AUTH_TOKEN_PATH: &str = "/v2/plugin/auth/token";
const LOGIN_ACCOUNT_PATH: &str = "/v2/plugin/login/account";

/// 上游的"还在等"业务码。
const LOGIN_PENDING_CODE: i64 = 11217;

/// 一次登录的起点：把 `auth_url` 丢给浏览器，把 `state` 留着轮询。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub state: String,
    pub auth_url: String,
}

/// 轮询的结果。
pub enum PollOutcome {
    /// 用户还没授权完
    Pending(String),
    /// 拿到账号了
    Ready(Box<Account>),
}

/// 发起登录，拿到授权链接。
pub fn start_login() -> Result<LoginStart, String> {
    let url = format!(
        "{}{}?platform=CLI",
        wb_upstream::CHAT_UPSTREAM,
        AUTH_STATE_PATH
    );
    let headers = login_headers();
    let refs: Vec<(&str, &str)> = headers.to_vec();

    let response = http::request_url("POST", &url, &refs, Some("{}"))?;
    let text = response.text();
    if response.status != 200 {
        return Err(format!(
            "发起登录失败：HTTP {} {}",
            response.status,
            excerpt(&text)
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|err| format!("登录响应不是 JSON: {err}"))?;
    check_code(&value)?;

    let data = value.get("data").unwrap_or(&value);
    let state = data
        .get("state")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let auth_url = data
        .get("authUrl")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if state.is_empty() || auth_url.is_empty() {
        return Err("上游没给 state 或授权链接，登录发不出去".into());
    }
    Ok(LoginStart { state, auth_url })
}

/// 轮询一次。`Pending` 不是错误 —— 用户在浏览器里还没点完。
pub fn poll_login(state: &str) -> Result<PollOutcome, String> {
    let state = state.trim();
    if state.is_empty() {
        return Err("缺少 state，请重新发起登录".into());
    }
    let url = format!(
        "{}{}?state={}",
        wb_upstream::CHAT_UPSTREAM,
        AUTH_TOKEN_PATH,
        urlencode(state)
    );
    let headers = login_headers();
    let refs: Vec<(&str, &str)> = headers.to_vec();

    let response = http::request_url("GET", &url, &refs, None)?;
    let text = response.text();
    if response.status != 200 {
        // 轮询期间的网络抖动不该把整个登录判死，按"还没好"处理
        return Ok(PollOutcome::Pending(format!(
            "HTTP {} {}",
            response.status,
            excerpt(&text)
        )));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|err| format!("登录响应不是 JSON: {err}"))?;

    let code = value
        .get("code")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if code == LOGIN_PENDING_CODE {
        let message = value
            .get("msg")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("等待浏览器授权");
        return Ok(PollOutcome::Pending(message.to_string()));
    }
    check_code(&value)?;

    let data = value.get("data").unwrap_or(&value);
    let grant: TokenGrant = serde_json::from_value(data.clone())
        .map_err(|err| format!("登录响应字段不认识: {err}"))?;
    if grant.access_token.trim().is_empty() {
        return Ok(PollOutcome::Pending("等待 token".into()));
    }

    let profile = fetch_profile(state, &grant.access_token).unwrap_or_default();
    let uid = if profile.uid.trim().is_empty() {
        // 兜底：token 自己带 sub
        crate::wb_jwt::claims(&grant.access_token)
            .map(|claims| claims.subject)
            .unwrap_or_default()
    } else {
        profile.uid.clone()
    };
    if uid.trim().is_empty() {
        return Err("登录成功但拿不到账号标识（uid）".into());
    }

    let mut account = Account::from_grant(&uid, &grant, &profile.nickname);
    account.enterprise_id = profile.enterprise_id;
    account.save(&crate::paths::gateway_accounts_dir())?;
    Ok(PollOutcome::Ready(Box::new(account)))
}

#[derive(Debug, Default)]
struct Profile {
    uid: String,
    nickname: String,
    enterprise_id: String,
}

/// 取昵称与企业 id。失败不算错 —— 这两个字段只影响展示。
fn fetch_profile(state: &str, token: &str) -> Result<Profile, String> {
    let url = format!(
        "{}{}?state={}",
        wb_upstream::CHAT_UPSTREAM,
        LOGIN_ACCOUNT_PATH,
        urlencode(state)
    );
    let mut owned: Vec<(String, String)> = login_headers()
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    owned.push(("Authorization".to_string(), format!("Bearer {token}")));
    let refs: Vec<(&str, &str)> = owned
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();

    let response = http::request_url("GET", &url, &refs, None)?;
    let value: serde_json::Value = serde_json::from_str(&response.text())
        .map_err(|err| format!("账号资料不是 JSON: {err}"))?;
    let data = value.get("data").unwrap_or(&value);
    Ok(Profile {
        uid: data
            .get("uid")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        nickname: data
            .get("nickname")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        enterprise_id: data
            .get("enterpriseId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn check_code(value: &serde_json::Value) -> Result<(), String> {
    if let Some(code) = value.get("code").and_then(serde_json::Value::as_i64) {
        if code != 0 {
            let message = value
                .get("msg")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("上游未说明原因");
            return Err(format!("上游拒绝：code={code} {message}"));
        }
    }
    Ok(())
}

/// 登录用的头。与聊天头不同：这套不带会话 id 家族，也不带 `X-CodeBuddy-Request`。
fn login_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Content-Type", "application/json"),
        ("Accept", "application/json, text/plain, */*"),
        ("X-Requested-With", "XMLHttpRequest"),
        ("User-Agent", wb_upstream::BILLING_UA),
        ("Origin", wb_upstream::ORIGIN),
        ("Referer", wb_upstream::ORIGIN),
    ]
}

/// state 里可能有 `+` `/` `=`，拼进查询串必须转义。
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真打一次上游：验证端点、头、信封形态。
    ///
    /// 跑法：`cargo test wb_api_auth -- --ignored --nocapture`
    /// 会在上游注册一个十分钟后失效的登录 state —— 无害，也不用清理。
    #[test]
    #[ignore = "真打上游，需要网络；手动跑"]
    fn 真发起一次登录能拿到授权链接() {
        match start_login() {
            Ok(start) => {
                assert!(!start.state.is_empty(), "没给 state");
                assert!(
                    start.auth_url.starts_with("http"),
                    "授权链接不像链接：{}",
                    start.auth_url
                );
                println!("{}", start.auth_url);
            }
            Err(message) => panic!("发起登录失败：{message}"),
        }
    }

    #[test]
    fn urlencode_转义_query_里的危险字符() {
        assert_eq!(urlencode("a+b/c="), "a%2Bb%2Fc%3D");
        assert_eq!(urlencode("safe-_.~"), "safe-_.~");
    }

    #[test]
    fn 解出信封里的授予() {
        let text = r#"{"code":0,"msg":"ok","data":{"accessToken":"a1","refreshToken":"r1","expiresIn":5184000,"domain":"copilot.tencent.com"}}"#;
        let grant = parse_grant(text).unwrap();
        assert_eq!(grant.access_token, "a1");
        assert_eq!(grant.refresh_token, "r1");
        assert_eq!(grant.expires_in, 5184000);
        assert_eq!(grant.domain, "copilot.tencent.com");
    }

    #[test]
    fn 扁平形态也认() {
        let text = r#"{"accessToken":"a2","refreshToken":"r2","expiresIn":60}"#;
        let grant = parse_grant(text).unwrap();
        assert_eq!(grant.access_token, "a2");
    }

    #[test]
    fn 业务错误码翻译成人话() {
        let error = parse_grant(r#"{"code":11217,"msg":"login ing"}"#).unwrap_err();
        assert!(error.contains("11217"), "{error}");
        assert!(error.contains("login ing"), "{error}");
    }

    #[test]
    fn 没有_refresh_token_时直接判需要重登() {
        let mut account = Account::from_grant(
            "u",
            &TokenGrant {
                access_token: "a".into(),
                ..TokenGrant::default()
            },
            "",
        );
        account.refresh_token.clear();
        let error = refresh(&mut account).unwrap_err();
        assert!(error.contains("重新登录"), "{error}");
        assert!(account.token_expired);
    }
}
