//! 额度用完的判定与恢复时刻。
//!
//! 上游对「额度用完」有两档，粒度不一样：
//!
//! - **按模型**（code 6004）：正文说「您的使用量已超出频率限制，将在 … 重置，
//!   您也可以切换其他模型继续使用」。限额是按模型的 —— 实测同一个号在这个模型上
//!   429、换 `glm-5.3-flash` 立刻 200。所以这里只挡这一个模型，不能拿按号的标记
//!   去封整个号：那会让一个还能用的号无端下线。
//! - **按号**（余额 / 积分用完）：正文说「余额不足 / 积分耗尽 / insufficient_quota」
//!   这类，整个号停一段时间。
//!
//! 判据只认**正文里明确的说法**或上游稳定 code：HTTP 429 单独出现不算 ——
//! 那可能只是瞬时限流，误判会把好号封一整天。
//!
//! 恢复时刻优先用正文里的「将在 YYYY-MM-DD HH:MM:SS UTC+8 重置」；企业号再用
//! `cycleEndTime`；都判不出来才退回固定冷却 [`QUOTA_COOLDOWN_SECS`]。
//! 个人资源包的 `expires_at` 是抵扣截止，不是每日重置，不拿来当恢复时间。

use crate::wb_credits::Credits;

/// 判不出恢复时刻时的兜底冷却：从标记那一刻起 24 小时。
pub const QUOTA_COOLDOWN_SECS: i64 = 24 * 3600;

/// 上游按模型限流的业务码（`{"code":6004,"msg":"您的使用量已超出频率限制…"}`）。
const MODEL_LIMIT_CODE: &str = "\"code\":6004";

/// 这条错误是不是「这个模型的额度用完了」。
///
/// 认两样：上游的 `code: 6004`，或正文里那句完整的「使用量已超出频率限制」。
/// 只写「频率限制」不用模糊匹配 —— 瞬时限流也会这么说，那不该封到重置时刻。
pub fn model_scoped(status: u16, body: &str) -> bool {
    if !(400..600).contains(&status) {
        return false;
    }
    let text = body.to_lowercase();
    // 正文可能是被转义过一层的 JSON（错误信封里嵌字符串），两种写法都认
    text.contains(MODEL_LIMIT_CODE)
        || text.contains("\\\"code\\\":6004")
        || text.contains("使用量已超出频率限制")
}

/// 上游的这条错误是否在说「整个号的额度 / 余额用完了」。
///
/// `status` 只用来排除 2xx（200 的正文里出现「额度」很可能是正常说明），不单独定罪：
/// 429 单独出现不算 —— 那更可能是限流。正文认英文的 OpenAI 口径与中文的额度说法，
/// 关键词要成对出现（「额度」+「用完 / 不足」这类），不做模糊匹配。
pub fn looks_exhausted(status: u16, body: &str) -> bool {
    if !(400..600).contains(&status) {
        return false;
    }
    // 402 的语义就是「要付钱」，不用再看正文
    if status == 402 {
        return true;
    }

    let text = body.to_lowercase();
    const PHRASES: [&str; 7] = [
        "insufficient_quota",
        "insufficient balance",
        "insufficient_balance",
        "quota exceeded",
        "quota_exceeded",
        "exceeded your current quota",
        "credit balance is too low",
    ];
    if PHRASES.iter().any(|phrase| text.contains(phrase)) {
        return true;
    }

    let subject = text.contains("额度") || text.contains("积分") || text.contains("余额");
    let empty = ["用完", "不足", "耗尽", "超限", "已用尽", "已空"]
        .iter()
        .any(|word| text.contains(word));
    subject && empty
}

/// 正文里带的重置时刻：`将在 2026-10-21 09:21:25 UTC+8 重置`。
///
/// 认第一个形如 `YYYY-MM-DD HH:MM:SS` 的片段，按 UTC+8 折算（上游的墙钟就是北京时间）。
/// 找不到、或解析不出来就是 `None`，由调用方退回兜底冷却。
pub fn reset_in_body(body: &str) -> Option<i64> {
    let bytes = body.as_bytes();
    let mut index = 0;
    while index + 19 <= bytes.len() {
        let window = &bytes[index..index + 19];
        if is_wall_clock(window) {
            if let Ok(text) = std::str::from_utf8(window) {
                if let Some(at) = crate::wb_credits::parse_wall_clock(text) {
                    return Some(at);
                }
            }
        }
        index += 1;
    }
    None
}

/// `YYYY-MM-DD HH:MM:SS` 的字节形状。先按 ASCII 逐字节筛，避免在多字节字符上切出非法 UTF-8。
fn is_wall_clock(window: &[u8]) -> bool {
    window.len() == 19
        && window[0..4].iter().all(u8::is_ascii_digit)
        && window[4] == b'-'
        && window[5..7].iter().all(u8::is_ascii_digit)
        && window[7] == b'-'
        && window[8..10].iter().all(u8::is_ascii_digit)
        && window[10] == b' '
        && window[11..13].iter().all(u8::is_ascii_digit)
        && window[13] == b':'
        && window[14..16].iter().all(u8::is_ascii_digit)
        && window[16] == b':'
        && window[17..19].iter().all(u8::is_ascii_digit)
}

/// 恢复时刻：企业额度有周期结束时间就用它，其余一律「现在 + 24 小时」。
///
/// 个人资源包的 `expires_at` 是抵扣截止（包什么时候不能再花），不是每日重置，
/// 拿它当恢复时间会把号一关就是好几天 —— 所以只认企业号的周期边界。
pub fn recovery_at(now: i64, credits: Option<&Credits>) -> i64 {
    if let Some(credits) = credits {
        if credits.enterprise {
            if let Some(at) = credits.packages.first().and_then(|item| item.expires_at) {
                if at > now {
                    return at;
                }
            }
        }
    }
    now + QUOTA_COOLDOWN_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wb_credits;

    /// 上游原样回的 429 正文（2026-10-20 实测，只去掉 requestId）。
    const USAGE_LIMIT: &str = r#"{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-21 09:21:25 UTC+8 重置，您也可以切换其他模型继续使用。"}"#;

    #[test]
    fn 中文的额度用完认得出来() {
        assert!(looks_exhausted(400, "今日额度已用完"));
        assert!(looks_exhausted(429, "{\"msg\":\"账户余额不足\"}"));
        assert!(looks_exhausted(403, "积分已耗尽，请充值"));
    }

    #[test]
    fn 英文的额度用完认得出来() {
        assert!(looks_exhausted(429, "insufficient_quota"));
        assert!(looks_exhausted(400, "You exceeded your current quota"));
        assert!(looks_exhausted(402, ""));
    }

    #[test]
    fn 限流与普通错误不背这个锅() {
        // 429 但没有额度字样：限流，不该封 24 小时
        assert!(!looks_exhausted(429, "Too Many Requests"));
        assert!(!looks_exhausted(500, "upstream exploded"));
        // 200 正文里出现「额度」是正常说明
        assert!(!looks_exhausted(200, "今日额度已用完"));
        // 只有「额度」没有「用完 / 不足」这类词
        assert!(!looks_exhausted(400, "额度说明：每日 100 点"));
    }

    #[test]
    fn 按模型的限流认得出来_并且不算整号用完() {
        assert!(model_scoped(429, USAGE_LIMIT));
        // 上限流那句不能被「整号」判据吃掉：它说的是「使用量」，不是余额
        assert!(!looks_exhausted(429, USAGE_LIMIT));
    }

    #[test]
    fn 正文里能取到重置时刻() {
        // 2026-10-21 09:21:25 +08:00
        assert_eq!(reset_in_body(USAGE_LIMIT), Some(1_792_545_685));
        assert_eq!(reset_in_body("没有时间的限流"), None);
        // 时间格式不对就不认
        assert_eq!(reset_in_body("将在 2026-13-45 99:99:99 重置"), None);
    }

    #[test]
    fn 恢复时刻默认二十四小时() {
        let now = 1_700_000_000;
        assert_eq!(recovery_at(now, None), now + QUOTA_COOLDOWN_SECS);
        let personal = wb_credits::aggregate(vec![wb_credits::parse_package(
            &serde_json::json!({ "CapacitySize": 100, "CapacityRemain": 0 }),
        )]);
        assert_eq!(recovery_at(now, Some(&personal)), now + QUOTA_COOLDOWN_SECS);
    }

    #[test]
    fn 企业号用周期结束时间() {
        // 与 wb_credits 的墙钟用例同一枚金标值：2026-10-26 23:59:59 +08:00
        let cycle = 1_793_030_399;
        let now = cycle - 3600;
        let credits = wb_credits::enterprise(100.0, 100.0, "2026-10-26 23:59:59");
        assert_eq!(recovery_at(now, Some(&credits)), cycle);
    }

    #[test]
    fn 企业号的周期已经过去就退回二十四小时() {
        let now = 1_793_030_399 + 60;
        let credits = wb_credits::enterprise(100.0, 100.0, "2026-10-26 23:59:59");
        assert_eq!(recovery_at(now, Some(&credits)), now + QUOTA_COOLDOWN_SECS);
    }
}
