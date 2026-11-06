//! Qoder 的请求流水：与 TBuddy 同一个 `UsageRow` 形状，但写**自己的文件**
//! （`data/wb-qoder/usage.jsonl`）。
//!
//! 为什么不混进 `gateway-usage/`：两边的账号 uid / 模型名 / 计价口径完全不同，
//! 混在一起后用量页的「按账号」「按模型」会把两个上游的账算到同一格里，而且
//! 用户已经确认不需要把 Qoder 流水并进多机同步。分文件之后，TBuddy 的同步与
//! 统计完全不受影响。

use crate::wb_usage::UsageRow;

/// 上游这次扣了多少额度。**Qoder 的 usage 里这一位叫 `credits`（复数）** —— 会话日志与网关响应
/// 同一套形态（见 `packages/usage/src/qoder-log.ts` 的实测样例）；兼容给 `credit` 的旧形态。
///
/// 只认这个字段，不拿 token 乘倍率去推：推出来的是估算，而用量页那一列要的是真实扣了多少。
pub fn parse_credits(usage: &serde_json::Value) -> Option<f64> {
    usage
        .get("credits")
        .or_else(|| usage.get("credit"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
}

/// 追加一条。写失败不打断请求（与 TBuddy 同一条规矩）。
pub fn append(row: &UsageRow) -> Result<(), String> {
    crate::wb_usage::append_at(&crate::paths::qoder_usage_file(), row)
}

/// 读 `ts >= since` 的行（旧→新）。坏行跳过。
pub fn read_since(since: i64) -> Vec<UsageRow> {
    read_since_at(&crate::paths::qoder_usage_file(), since)
}

pub fn read_since_at(path: &std::path::Path, since: i64) -> Vec<UsageRow> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut rows: Vec<UsageRow> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<UsageRow>(line).ok())
        .filter(|row| row.ts >= since)
        .collect();
    rows.sort_by_key(|row| row.ts);
    rows
}

/// 读最近 N 行（新→旧）。Qoder 没有 TBuddy 那张静态价表，所以不补 `costCny`。
pub fn read_recent(limit: usize) -> Vec<UsageRow> {
    read_recent_at(&crate::paths::qoder_usage_file(), limit)
}

pub fn read_recent_at(path: &std::path::Path, limit: usize) -> Vec<UsageRow> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut rows: Vec<UsageRow> = text
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<UsageRow>(line).ok())
        .take(limit)
        .collect();
    rows.reverse();
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: i64, model: &str) -> UsageRow {
        UsageRow {
            ts,
            uid: "u1".into(),
            machine: String::new(),
            model: model.into(),
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            cached_tokens: 0,
            ttft_ms: 100,
            duration_ms: 200,
            ok: true,
            error: String::new(),
            ua: "test".into(),
            effort: String::new(),
            stream: Some(true),
            reasoning_tokens: 0,
            credit: None,
            api_key: String::new(),
            cost_cny: None,
        }
    }

    #[test]
    fn 追加与按时间读回() {
        let dir = std::env::temp_dir().join(format!(
            "wb-qoder-usage-{}",
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("usage.jsonl");
        crate::wb_usage::append_at(&path, &row(100, "A")).unwrap_or_else(|err| panic!("{err}"));
        crate::wb_usage::append_at(&path, &row(300, "B")).unwrap_or_else(|err| panic!("{err}"));
        crate::wb_usage::append_at(&path, &row(200, "C")).unwrap_or_else(|err| panic!("{err}"));
        let since = read_since_at(&path, 150);
        assert_eq!(since.len(), 2);
        assert_eq!(since[0].model, "C");
        assert_eq!(since[1].model, "B");
        let recent = read_recent_at(&path, 2);
        assert_eq!(recent.len(), 2);
        // 最后两行是 200(C) 与 300(B)，按文件顺序翻回来就是 B、C
        assert_eq!(recent[1].model, "C");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 额度只认_credits_那一位() {
        use serde_json::json;
        assert_eq!(parse_credits(&json!({ "credits": 0.78 })), Some(0.78));
        // 旧形态给单数也收
        assert_eq!(parse_credits(&json!({ "credit": 0.5 })), Some(0.5));
        // 没有这一位、或者不是数字，都不落账（不拿 token 推）
        assert_eq!(parse_credits(&json!({ "total_tokens": 7 })), None);
        assert_eq!(parse_credits(&json!({ "credits": "0.78" })), None);
        assert_eq!(parse_credits(&serde_json::Value::Null), None);
    }
}
