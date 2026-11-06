//! Qoder 设备授权登录与 token 续期。
//!
//! 流程（国内版）：
//! 1. 本地生成 PKCE（verifier / S256 challenge）与 nonce；
//! 2. 浏览器打开 `https://qoder.com.cn/device/selectAccounts?…`（client_id / machine_id /
//!    redirect_uri 都要带，只有国内版带 redirect_uri）；
//! 3. `GET /api/v1/deviceToken/poll` 轮询，404 / 202 表示「还没授权」；
//! 4. 拿到 `token` / `refresh_token` 后再 `GET /api/v1/userinfo` 补昵称、用户类型与组织；
//! 5. 之后只走 `POST /api/v1/deviceToken/refresh`，**永不再走登录**。
//!
//! 只做 OAuth 设备授权（用户确认的范围）：PAT 导入与本地凭证扫描不实现。
//! 纯 I/O 适配：发请求、解响应、把结果写回 [`Account`]。

use crate::http;
use crate::qd_account::{now_secs, Account};
use crate::qd_upstream;

/// 一次登录的起点：授权链接交给浏览器，`state` 留在内存里等轮询。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub state: String,
    pub auth_url: String,
    /// PKCE verifier（只留在内存里，不发给前端）
    #[serde(skip)]
    pub verifier: String,
    /// 设备授权 nonce（同上）
    #[serde(skip)]
    pub nonce: String,
}

/// 登录轮询的结果。
pub enum PollOutcome {
    /// 用户还没在浏览器里授权完
    Pending(String),
    /// 拿到账号了（尚未落盘）
    Ready(Box<Account>),
    /// 这次登录已经不可能成功（state 过期、上游报错）
    Failed(String),
}

/// 一次登录在内存里要记住的东西。`state` → 这一份。
#[derive(Debug, Clone)]
pub struct LoginTicket {
    pub verifier: String,
    pub nonce: String,
    pub created: i64,
}

/// 发起登录。`machine_id` 取本机官方客户端留下的值，没有就随机生成。
pub fn start_login() -> Result<LoginStart, String> {
    let verifier = make_verifier();
    let challenge = challenge_of(&verifier);
    let nonce = uuid::Uuid::new_v4().to_string();
    let machine_id = local_machine_id();
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("challenge", &challenge)
        .append_pair("challenge_method", "S256")
        .append_pair("nonce", &nonce)
        .append_pair("redirect_uri", qd_upstream::REDIRECT_URI)
        .append_pair("client_id", qd_upstream::CLIENT_ID)
        .append_pair("machine_id", &machine_id)
        .finish();
    Ok(LoginStart {
        state: format!("qd-{}", uuid::Uuid::new_v4().simple()),
        auth_url: qd_upstream::device_auth_url(&query),
        verifier,
        nonce,
    })
}

/// 轮询一次。调用方负责按 `state` 找到 [`LoginTicket`]。
pub fn poll_login(ticket: &LoginTicket) -> PollOutcome {
    let url = format!(
        "{}?{}",
        qd_upstream::openapi(qd_upstream::PATH_DEVICE_POLL),
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("nonce", &ticket.nonce)
            .append_pair("verifier", &ticket.verifier)
            .append_pair("challenge_method", "S256")
            .finish()
    );
    let headers = vec![
        ("Accept", "application/json"),
        ("User-Agent", "QoderWork"),
    ];
    let response = match http::request_url("GET", &url, &headers, None) {
        Ok(response) => response,
        Err(message) => return PollOutcome::Pending(format!("轮询失败：{message}")),
    };
    let text = response.text();
    // 404 / 202 是「用户还没完成授权」的正常状态
    if response.status == 404 || response.status == 202 {
        return PollOutcome::Pending("等待浏览器完成 Qoder 设备授权".into());
    }
    if response.status != 200 {
        return PollOutcome::Failed(format!(
            "设备授权轮询返回 HTTP {}：{}",
            response.status,
            excerpt(&text)
        ));
    }
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return PollOutcome::Pending("等待授权结果".into()),
    };
    let data = value.get("data").unwrap_or(&value);
    let token = data
        .get("token")
        .or_else(|| data.get("device_token"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    if token.trim().is_empty() {
        return PollOutcome::Pending("等待授权结果".into());
    }
    let mut uid = data
        .get("user_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let nickname = data
        .get("user_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let user_type = data
        .get("user_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut user_type = user_type;
    let mut org_id = String::new();
    let mut org_name = String::new();
    let mut name = nickname;

    // 补全身份：失败不阻塞入库（token 已经拿到了）
    if let Ok(info) = fetch_userinfo(&token) {
        if let Some(id) = info.get("id").and_then(serde_json::Value::as_str) {
            if !id.trim().is_empty() {
                uid = id.to_string();
            }
        }
        if let Some(value) = info.get("name").and_then(serde_json::Value::as_str) {
            name = value.to_string();
        }
        if let Some(value) = info
            .get("user_type")
            .or_else(|| info.get("userType"))
            .and_then(serde_json::Value::as_str)
        {
            if !value.trim().is_empty() {
                user_type = value.to_string();
            }
        }
        org_id = info
            .get("organization_id")
            .or_else(|| info.get("organizationId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        org_name = info
            .get("organization_name")
            .or_else(|| info.get("organizationName"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
    }

    if uid.trim().is_empty() {
        uid = format!("q-{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
    }
    if name.trim().is_empty() {
        name = format!("u{}", uid.chars().rev().take(8).collect::<String>());
    }

    let account = Account::from_login(
        &uid,
        &name,
        &token,
        data.get("refresh_token")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(""),
        device_expiry(data),
        &user_type,
        &org_id,
        &org_name,
    );
    PollOutcome::Ready(Box::new(account))
}

/// 续期。成功时账号的 token 三件套已被更新。
///
/// `drt-` 走设备续期，其余（含未来可能导入的 `jrt-`）走 jobToken 续期。
pub fn refresh(account: &mut Account) -> Result<(), String> {
    if account.refresh_token.trim().is_empty() {
        account.token_expired = true;
        return Err("没有 refresh token，需要重新登录".into());
    }
    let path = if account.refresh_token.starts_with("drt-") {
        qd_upstream::PATH_DEVICE_REFRESH
    } else {
        qd_upstream::PATH_JOB_REFRESH
    };
    let url = qd_upstream::openapi(path);
    let body = serde_json::json!({ "refresh_token": account.refresh_token }).to_string();
    let headers = vec![
        ("Content-Type", "application/json"),
        ("Accept", "application/json"),
        ("User-Agent", qd_upstream::ACCOUNT_UA),
    ];
    let response = http::request_url("POST", &url, &headers, Some(&body))?;
    let text = response.text();
    if response.status != 200 {
        // 会话被吊销：再续也没用，标记需要重新登录
        if (response.status == 401 || response.status == 403)
            && crate::qd_quota::session_dead(&text)
        {
            account.token_expired = true;
            account.enabled = false;
            account.last_error = "会话已失效，需要重新登录".into();
        }
        return Err(format!(
            "续期失败：HTTP {} {}",
            response.status,
            excerpt(&text)
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|err| format!("续期响应不是 JSON：{err}"))?;
    let data = value.get("data").unwrap_or(&value);
    let token = data
        .get("token")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if token.trim().is_empty() {
        return Err(format!("续期返回里没有 token：{}", excerpt(&text)));
    }
    account.access_token = token.to_string();
    if let Some(next) = data.get("refresh_token").and_then(serde_json::Value::as_str) {
        if !next.trim().is_empty() {
            account.refresh_token = next.to_string();
        }
    }
    account.expires_at = device_expiry(data);
    account.token_expired = false;
    account.last_error.clear();
    Ok(())
}

/// 读一次用户信息（`/api/v1/userinfo`）。登录与「刷新账号资料」共用。
pub fn fetch_userinfo(token: &str) -> Result<serde_json::Value, String> {
    let url = qd_upstream::openapi(qd_upstream::PATH_USERINFO);
    let bearer = format!("Bearer {token}");
    let headers = vec![
        ("Accept", "application/json"),
        ("User-Agent", qd_upstream::ACCOUNT_UA),
        ("Authorization", bearer.as_str()),
    ];
    let response = http::request_url("GET", &url, &headers, None)?;
    if response.status != 200 {
        return Err(format!("userinfo 返回 HTTP {}", response.status));
    }
    let value: serde_json::Value =
        serde_json::from_str(&response.text()).map_err(|err| format!("userinfo 不是 JSON：{err}"))?;
    Ok(value.get("data").cloned().unwrap_or(value))
}

/// 凭证到期时刻：`expires_in` 是**毫秒**，`expires_at` 是 RFC3339（去时区只取前 19 位），
/// 都没有就按 30 天兜底（与原项目一致）。
fn device_expiry(data: &serde_json::Value) -> i64 {
    if let Some(ms) = data.get("expires_in").and_then(serde_json::Value::as_i64) {
        if ms > 0 {
            return now_secs() + ms / 1000;
        }
    }
    if let Some(text) = data.get("expires_at").and_then(serde_json::Value::as_str) {
        if let Some(at) = crate::wb_credits::parse_wall_clock(&text.replace('T', " ")) {
            return at;
        }
    }
    now_secs() + 30 * 86_400
}

/// PKCE verifier：64 个 RFC 7636 允许的字符。
fn make_verifier() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    crate::qd_sign::random_bytes(64)
        .iter()
        .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
        .collect()
}

fn challenge_of(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// 官方客户端留下的 machine_id：`%USERPROFILE%\.qoder-cn\.auth\machine_id`。
/// 读不到就随机生成一个（登录后它不会回写账号文件，只影响这次授权页的展示）。
fn local_machine_id() -> String {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    if let Some(home) = home {
        let path = home.join(".qoder-cn").join(".auth").join("machine_id");
        if let Ok(text) = std::fs::read_to_string(path) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    uuid::Uuid::new_v4().to_string()
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    trimmed.chars().take(200).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_是_sha256_的_base64url() {
        // RFC 7636 的示例 verifier / challenge
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge_of(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_只用_rfc_字符集且长度固定() {
        let verifier = make_verifier();
        assert_eq!(verifier.len(), 64);
        assert!(verifier
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "-._~".contains(ch)));
    }

    #[test]
    fn 授权链接带国内版必需的五个参数() {
        let start = start_login().unwrap_or_else(|err| panic!("生成授权链接失败：{err}"));
        assert!(start.auth_url.starts_with("https://qoder.com.cn/device/selectAccounts?"));
        for key in ["challenge=", "challenge_method=S256", "nonce=", "redirect_uri=", "client_id=", "machine_id="] {
            assert!(start.auth_url.contains(key), "缺少 {key}");
        }
        assert!(start.state.starts_with("qd-"));
    }

    #[test]
    fn 到期时间_ms_换算成秒() {
        let data = serde_json::json!({ "expires_in": 2_592_000_000i64 });
        let at = device_expiry(&data);
        assert!(at > now_secs() + 29 * 86_400);
        assert!(at <= now_secs() + 31 * 86_400);
    }
}
