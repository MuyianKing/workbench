//! Qoder 上游错误分类：额度、频控、排队、凭证失效与瞬时故障。
//!
//! 与 `wb_quota` 同一套原则：**只认上游明确说的**，不拿 HTTP 429 单独定罪 ——
//! Qoder 用 429 同时表达「模型频控」与「模型繁忙」，误判会把好号封掉。
//!
//! 上游的错误语义（来自 `qoder2api-hub` 的实测口径）：
//! - `403` + `10605` / `isQueued` / `RESOURCE_LIMIT` → **排队**，不是账号问题，
//!   按 `retryAfterSeconds` 等待后重试同一账号；
//! - `403` + `code 112` / `pricingUrl` → 额度耗尽，冷却 30 分钟换号；
//! - `403` + `code 110` / `Billing daily count exceeded` → 当日请求次数上限，
//!   本地 0 点（UTC+8）恢复，封顶 6 小时；
//! - `402` → 余额不足；
//! - `429` → 模型粒度频控；
//! - `430` → 版本门，重试无效；
//! - 信封里出现 `TOKEN_EXPIRE` / `12153` / `Offline user session not found`
//!   → 会话被吊销，账号标记为需要重新登录。

/// 额度 / 频控判不出恢复时刻时的兜底冷却：30 分钟（上游 112 的口径）。
pub const QUOTA_COOLDOWN_SECS: i64 = 30 * 60;

/// 当日次数上限的封顶冷却：6 小时，免得本地时区乱跳时封太久。
const DAILY_LIMIT_MAX_SECS: i64 = 6 * 3600;

/// 排队等待：最多几轮、单轮最长几秒、整次请求总预算几秒。
pub const QUEUE_MAX_ROUNDS: u8 = 3;
pub const QUEUE_WAIT_MAX_SECS: i64 = 180;
pub const QUEUE_WAIT_BUDGET_SECS: i64 = 600;

/// 同账号瞬时故障的重试次数（1s / 2s 退避）。
pub const TRANSIENT_MAX_RETRIES: u8 = 2;

/// 额度问题的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaKind {
    /// 额度 / 余额耗尽：冷却 30 分钟后换号
    Exhausted,
    /// 当日请求次数上限：到本地 0 点（封顶 6 小时）
    Daily,
}

/// 从排队响应里解析「等多久」。不是排队信号返回 0。
///
/// 形如 `{"code":"10605","message":"...","isQueued":true,"retryAfterSeconds":30}`。
pub fn queue_wait(body: &str) -> i64 {
    let lower = body.to_lowercase();
    if !body.contains("10605") && !lower.contains("isqueued") && !lower.contains("queue") {
        return 0;
    }
    match number_after(body, "retryAfterSeconds") {
        Some(seconds) if seconds > 0 => seconds,
        // 排队但没给时长：保守按 30 秒
        _ => 30,
    }
}

fn number_after(body: &str, key: &str) -> Option<i64> {
    let at = body.find(key)?;
    let rest = &body[at + key.len()..];
    let digits: String = rest
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// 会话被上游吊销（需要重新登录，不要续期）。
pub fn session_dead(body: &str) -> bool {
    const MARKERS: [&str; 3] = ["TOKEN_EXPIRE", "12153", "Offline user session not found"];
    MARKERS.iter().any(|marker| body.contains(marker))
}

/// 额度 / 频控分类。`status` 与正文一起看；不是额度问题返回 `None`。
pub fn quota_kind(status: u16, body: &str, now: i64) -> Option<(QuotaKind, i64)> {
    if !(400..600).contains(&status) {
        return None;
    }
    // 正文可能被套在字符串里（转义形态 \"code\":\"112\"），先去掉反斜杠再匹配
    let flat = body.replace('\\', "");
    if status == 402
        || flat.contains("pricingUrl")
        || has_code(&flat, 112)
        || flat.contains("insufficient_quota")
        || flat.contains("credit balance is too low")
    {
        return Some((QuotaKind::Exhausted, now + QUOTA_COOLDOWN_SECS));
    }
    if flat.contains("Billing daily count exceeded") || has_code(&flat, 110) {
        let until = next_local_midnight(now);
        let capped = (until - now).clamp(60, DAILY_LIMIT_MAX_SECS);
        return Some((QuotaKind::Daily, now + capped));
    }
    // 429 是模型粒度频控；402 已在上面归为整号
    if status == 429 {
        return Some((QuotaKind::Exhausted, now + QUOTA_COOLDOWN_SECS));
    }
    None
}

/// 正文里是否出现 `"code": 112` / `"code":"112"` 这种独立 code。
fn has_code(text: &str, code: u32) -> bool {
    let needle = format!("\"code\":\"{code}\"");
    let spaced = format!("\"code\": {code}");
    text.contains(&needle) || text.contains(&spaced)
}

/// 下一个 UTC+8 的本地零点（Unix 秒）。Qoder 的每日次数上限按这个时刻恢复。
fn next_local_midnight(now: i64) -> i64 {
    const OFFSET: i64 = 8 * 3600;
    let local = now + OFFSET;
    let day_start = local.div_euclid(86_400) * 86_400;
    day_start + 86_400 - OFFSET
}

/// 请求自身的确定性错误：换号结果一样，不冷却、不重试，直接回给客户端。
pub fn is_request_fault(status: u16, body: &str) -> bool {
    const MARKERS: [&str; 7] = [
        "invalid_parameter_error",
        "invalid_request_error",
        "authentication_error",
        "permission_error",
        "\"Range of ",
        "DataInspectionFailed",
        "inappropriate content",
    ];
    status == 413 || MARKERS.iter().any(|marker| body.contains(marker))
}

/// 首字超时：同账号重试几乎必然再超时，应当直接换号。
pub fn first_token_timeout(body: &str) -> bool {
    let text = body.to_lowercase();
    text.contains("first token timeout")
        || text.contains("first_token_timeout")
        || text.contains("upstream timeout")
        || text.contains("504 first token")
}

/// 上游瞬时故障（418 / 5xx / 带 provider_error 的 4xx）：同账号退避重试。
pub fn transient_upstream(status: u16, body: &str) -> bool {
    if status == 401 || status == 403 || status == 429 {
        return false;
    }
    if is_request_fault(status, body) {
        return false;
    }
    status == 418 || status >= 500 || (400..500).contains(&status) && body.contains("provider_error")
}

/// 把上游错误翻成给客户端看的中文，并给一个错误类型。
pub fn friendly(status: u16, body: &str) -> (String, &'static str) {
    let detail = body.trim();
    let safe: String = detail.chars().take(300).collect();
    if body.contains("10605") || body.contains("isQueued") || body.contains("RESOURCE_LIMIT") {
        return (
            format!(
                "上游模型排队中（10605 / RESOURCE_LIMIT）：请稍后重试，或换一个模型。这不是密钥或账号问题。上游详情：{safe}"
            ),
            "upstream_queued",
        );
    }
    if status == 402 || body.contains("pricingUrl") || has_code(body, 112) {
        return (
            format!("上游账号额度耗尽：重试无效，请充值或启用其它账号。上游详情：{safe}"),
            "quota_exhausted",
        );
    }
    if body.contains("Billing daily count exceeded") || has_code(body, 110) {
        return (
            format!("上游账号今日请求次数已达上限：本地 0 点后恢复，或启用其它账号。上游详情：{safe}"),
            "quota_daily_limit",
        );
    }
    if status == 430 {
        return (
            "客户端 / 网关版本过低（430）：上游要求升级后才能继续。".into(),
            "version_too_low",
        );
    }
    if status == 429 {
        return (
            format!("上游模型限流（429）：该模型暂时不可用，可稍后重试或换一个模型。上游详情：{safe}"),
            "rate_limited",
        );
    }
    if is_request_fault(status, body) {
        return (
            format!("请求被上游拒绝（HTTP {status}）：换账号结果相同，请调整请求后重试。上游详情：{safe}"),
            "invalid_request_error",
        );
    }
    (
        format!("上游返回错误（HTTP {status}）：{safe}"),
        "upstream_error",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 排队信号与等待时长() {
        let body = r#"{"code":"10605","message":"busy","isQueued":true,"retryAfterSeconds":30}"#;
        assert_eq!(queue_wait(body), 30);
        assert!(queue_wait(r#"{"isQueued":true}"#) > 0);
        assert_eq!(queue_wait("ordinary error"), 0);
        assert_eq!(queue_wait(r#"{"code":"10605"}"#), 30);
    }

    #[test]
    fn 额度与每日上限分开() {
        let now = 1_800_000_000;
        match quota_kind(403, r#"{"code":"112","pricingUrl":"x"}"#, now) {
            Some((kind, until)) => {
                assert_eq!(kind, QuotaKind::Exhausted);
                assert_eq!(until, now + QUOTA_COOLDOWN_SECS);
            }
            None => panic!("112 应判成额度耗尽"),
        }
        match quota_kind(403, r#"{"code":"110"}"#, now) {
            Some((kind, until)) => {
                assert_eq!(kind, QuotaKind::Daily);
                assert!(until > now && until - now <= DAILY_LIMIT_MAX_SECS);
            }
            None => panic!("110 应判成每日上限"),
        }
        assert!(quota_kind(200, "额度用完", now).is_none());
        assert!(quota_kind(500, "boom", now).is_none());
    }

    #[test]
    fn 本地零点按_utc8() {
        // 2027-01-15 00:30 +08:00 → 下一个零点是 2027-01-16 00:00 +08:00
        let at = 1_800_000_000; // 仅用于检查结果落在 24 小时内
        let midnight = next_local_midnight(at);
        assert!(midnight > at);
        assert!(midnight - at <= 86_400);
        assert_eq!((midnight + 8 * 3600) % 86_400, 0);
    }

    #[test]
    fn 会话吊销认得出来() {
        assert!(session_dead("TOKEN_EXPIRE"));
        assert!(session_dead("code 12153"));
        assert!(session_dead("Offline user session not found"));
        assert!(!session_dead("quota"));
    }

    #[test]
    fn 瞬时故障与请求错误分开() {
        assert!(transient_upstream(418, "provider_error"));
        assert!(transient_upstream(503, ""));
        assert!(!transient_upstream(429, ""));
        assert!(!transient_upstream(400, "invalid_request_error"));
        assert!(is_request_fault(413, ""));
        assert!(is_request_fault(400, "DataInspectionFailed"));
    }

    #[test]
    fn 错误文案不把排队说成密钥问题() {
        let (message, kind) = friendly(403, r#"{"code":"10605","isQueued":true}"#);
        assert_eq!(kind, "upstream_queued");
        assert!(!message.contains("密钥失效"));
    }
}
