//! 用量记录：每条请求一行 JSONL，看板从它算出来。
//!
//! **为什么是 JSONL 而不是 SQLite**：这是只追加的事件流，不更新、不删单条，
//! 读的时候全量扫一遍再聚合。几千到几十万行的量级里，这比维护一张表简单得多，
//! 出问题时也能直接 `tail` 看。日志那一块才需要 SQLite（要按标签/级别筛、要裁剪）。
//!
//! 写入是**追加**：`OpenOptions::append` 在多线程下由系统保证原子性（单次 write 小于管道缓冲）。
//! 一个进程内只有一个网关在写，不必再加锁。
//!
//! 纯 I/O + 聚合：不懂协议、不认识账号。

use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::common::now_secs;

/// 一条请求的用量。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// Unix 秒（请求开始时刻）
    pub ts: i64,
    pub uid: String,
    /// 产生这条流水的机器名（主机名）。旧行没有这个字段，读出来是空串
    #[serde(default)]
    pub machine: String,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    /// 命中前缀缓存的输入 token
    pub cached_tokens: i64,
    /// 首字延迟（毫秒）。非流式时等于总耗时
    pub ttft_ms: i64,
    /// 整段耗时（毫秒）
    pub duration_ms: i64,
    pub ok: bool,
    /// 失败时的一句话（已经翻成人话）
    pub error: String,
    /// 调用方的 User-Agent（谁在用这条网关，排查时最有用的一列）
    #[serde(default)]
    pub ua: String,
    /// 客户端要求的推理强度（`reasoning_effort` / `reasoning.effort` / `thinking.effort`）。
    /// 没提就是空串 —— 空不是「不让想」，是「这次没说」
    #[serde(default)]
    pub effort: String,
    /// 这次是不是流式（`stream: true`）。老流水没记过这一项，是 `None` 而不是 `false` ——
    /// 「没记」和「非流式」是两件事
    #[serde(default)]
    pub stream: Option<bool>,
    /// 推理 token（模型自己「想」了多少）。上游没给就是 0
    #[serde(default)]
    pub reasoning_tokens: i64,
    /// 上游给这次请求扣的积分。**没给就是 `None`，不是 0** —— 0 会被读成「免费」
    #[serde(default)]
    pub credit: Option<f64>,
    /// 调用网关用的密钥尾部（只留最后四位）。没带密钥就是空串
    #[serde(default)]
    pub api_key: String,
    /// 按价表折算的估算花费（人民币）。价表里没有这个模型就是 `None`
    #[serde(default)]
    pub cost_cny: Option<f64>,
}

/// 上游 `usage` 对象里这次要的五个数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UsageNumbers {
    pub prompt: i64,
    pub completion: i64,
    pub total: i64,
    pub cached: i64,
    pub reasoning: i64,
}

/// 从上游的 `usage` 对象里取数。字段名各家不一，按常见别名依次试。
///
/// 拿不到就全 0 —— **不要猜**。猜出来的数字会污染"花了多少"这件事，
/// 而这件事的唯一价值就是准。
pub fn parse_usage(usage: &Value) -> UsageNumbers {
    let prompt = first_int(usage, &["prompt_tokens", "input_tokens"]);
    let completion = first_int(usage, &["completion_tokens", "output_tokens"]);
    let total = {
        let given = first_int(usage, &["total_tokens"]);
        if given > 0 {
            given
        } else {
            prompt + completion
        }
    };
    let cached = usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| first_int_opt(usage, &["cache_read_input_tokens", "cached_tokens"]))
        .unwrap_or(0);
    // 思考 token 在 completion 里面：OpenAI 那一族挂在 details 下，也有直接给在顶层的
    let reasoning = usage
        .get("completion_tokens_details")
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| first_int_opt(usage, &["reasoning_tokens"]))
        .unwrap_or(0);
    UsageNumbers {
        prompt,
        completion,
        total,
        cached,
        reasoning,
    }
}

/// 上游这次扣了多少积分。没有这个字段就是 `None`。
///
/// 只认 `credit` 这一种明确形态：别拿 token 数乘倍率去推 —— 那本账在服务端，
/// 推出来的数是「估算」，而这一列存在的意义恰恰是「真实扣了多少」。
pub fn parse_credit(usage: &Value) -> Option<f64> {
    usage
        .get("credit")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn first_int(usage: &Value, keys: &[&str]) -> i64 {
    first_int_opt(usage, keys).unwrap_or(0)
}

fn first_int_opt(usage: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(value) = usage.get(*key).and_then(Value::as_i64) {
            return Some(value);
        }
    }
    None
}

/// 追加一行。失败**不阻断请求** —— 记账写不进去是账本的问题，不该让对话失败。
pub fn append(row: &UsageRow) -> Result<(), String> {
    append_at(&crate::paths::gateway_usage_file(), row)
}

/// 追加到指定流水文件（Qoder 用自己的文件，不混进 TBuddy 的流水）。
pub(crate) fn append_at(path: &std::path::Path, row: &UsageRow) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建用量目录失败: {err}"))?;
    }
    let mut line = serde_json::to_string(row).map_err(|err| format!("序列化用量失败: {err}"))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("打开用量文件失败: {err}"))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("写用量失败: {err}"))
}

/// 自然日窗口的起点（Unix 秒，UTC+8 的 0 点）：`days = 1` 是今天 0 点，`days = 3` 是前天 0 点。
///
/// **「今日」是自然日，不是滚动的 24 小时**：滚动窗口在上午打开时会把昨天下午的流水也算进去，
/// 页面上「今日」与「近 3 天」于是是一批数（看起来像切换没生效）。时区取 UTC+8，
/// 与分桶、`format_wall_clock` 同一套口径。
pub fn window_start(days: i64) -> i64 {
    window_start_at(now_secs(), days)
}

fn window_start_at(now: i64, days: i64) -> i64 {
    let local = now + 8 * 3600;
    let midnight = local - local.rem_euclid(86400);
    midnight - (days.max(1) - 1) * 86400 - 8 * 3600
}

/// 取数起点：统计窗口的起点，但至少往前铺满 24 小时。
///
/// 时序图固定看最近 24 小时，而「今日」的自然日窗口在上午比 24 小时短 ——
/// 只按窗口取数的话，图上昨天那半天会被画成空的。
pub fn fetch_start(days: i64) -> i64 {
    fetch_start_at(now_secs(), days)
}

fn fetch_start_at(now: i64, days: i64) -> i64 {
    window_start_at(now, days).min(now - 86400)
}

/// 读 `ts >= since` 的行（旧→新）。坏行跳过。
pub fn read_since(since: i64) -> Vec<UsageRow> {
    let path = crate::paths::gateway_usage_file();
    let Ok(text) = std::fs::read_to_string(&path) else {
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

/// 读最近 N 行（用于"最近请求"列表），新→旧。
pub fn read_recent(limit: usize) -> Vec<UsageRow> {
    let path = crate::paths::gateway_usage_file();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<UsageRow> = text
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<UsageRow>(line).ok())
        .take(limit)
        .collect();
    // 文件里是旧→新，取完要翻回来
    rows.reverse();
    // 老流水没记估算花费（这一列是后加的）：读的时候按当前价表补一次，
    // 否则「估算价格」对历史数据永远是空的。未定价的模型照样留 None。
    for row in &mut rows {
        if row.cost_cny.is_none() {
            row.cost_cny = cost_for(&row.model, row.prompt_tokens, row.completion_tokens)
                .map(round2);
        }
    }
    rows
}

/// 读全部本地流水，整理成可以进同步仓库的副本。
///
/// **脱敏**：`apiKey` 清空（哪怕只留了末四位），`costCny` 清掉（它不是展示口径）。
/// 旧行没有 `machine`，补上传进来的本机名 —— 同步出去的行靠它认机器。
pub fn rows_for_sync(machine: &str) -> Vec<UsageRow> {
    rows_for_sync_at(&crate::paths::gateway_usage_file(), machine)
}

fn rows_for_sync_at(path: &std::path::Path, machine: &str) -> Vec<UsageRow> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut rows: Vec<UsageRow> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<UsageRow>(line).ok())
        .collect();
    for row in &mut rows {
        row.api_key.clear();
        row.cost_cny = None;
        if row.machine.trim().is_empty() {
            row.machine = machine.trim().to_string();
        }
    }
    rows.sort_by_key(|row| row.ts);
    rows
}

/// 按价表折一次价。记账时与网关转发时共用同一个函数，两个数才不会慢慢对不上。
pub fn cost_for(model: &str, prompt: i64, completion: i64) -> Option<f64> {
    crate::wb_pricing::price_of(model).map(|price| price.input_cny(prompt) + price.output_cny(completion))
}

pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}


#[cfg(test)]
mod tests {
    use super::*;

    fn row(uid: &str, model: &str, prompt: i64, completion: i64, cached: i64) -> UsageRow {
        UsageRow {
            ts: 1_770_000_000,
            uid: uid.to_string(),
            machine: String::new(),
            model: model.to_string(),
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            cached_tokens: cached,
            ttft_ms: 100,
            duration_ms: 1000,
            ok: true,
            error: String::new(),
            ua: String::new(),
            effort: String::new(),
            stream: Some(true),
            reasoning_tokens: 0,
            credit: None,
            api_key: String::new(),
            cost_cny: None,
        }
    }

    /// 进同步仓库的那份要脱敏、补机器名，并且坏行不能把整本账拖垮。
    #[test]
    fn 同步副本去掉密钥尾号与估算花费并补机器名() {
        let dir = std::env::temp_dir().join(format!("wb-usage-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("usage.jsonl");

        let mut first = row("a", "m", 10, 2, 0);
        first.ts = 1;
        first.api_key = "…abcd".into();
        first.cost_cny = Some(0.42);
        let mut second = row("b", "m", 20, 4, 0);
        second.ts = 2;
        second.machine = "另一台".into();
        let text = format!(
            "{}\n{}\n坏行\n",
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
        std::fs::write(&file, text).unwrap();

        let rows = rows_for_sync_at(&file, "本机");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].ts, 1);
        assert!(rows[0].api_key.is_empty());
        assert!(rows[0].cost_cny.is_none());
        assert_eq!(rows[0].machine, "本机");
        assert_eq!(rows[1].machine, "另一台");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 「今日」是自然日：上午 9 点的「今日」从当天 0 点起算，不是从昨天 9 点。
    #[test]
    fn 窗口起点是自然日零点() {
        // 2026-10-21 01:00:00Z = 10-21 09:00（UTC+8）
        let now = 1_792_544_400;
        // 10-20T16:00:00Z = 10-21 00:00
        assert_eq!(window_start_at(now, 1), 1_792_512_000);
        // 前天零点
        assert_eq!(window_start_at(now, 3), 1_792_512_000 - 2 * 86_400);
        // 凌晨 00:30 也只回到当天 0 点，不回到昨天
        assert_eq!(window_start_at(now - 8 * 3600 - 1800, 1), 1_792_512_000);
        // 0 / 负数当 1 天处理
        assert_eq!(window_start_at(now, 0), window_start_at(now, 1));
        // 取数起点至少铺满 24 小时：上午 9 点时它比「今日」的零点更早
        assert_eq!(fetch_start_at(now, 1), now - 86_400);
        assert!(fetch_start_at(now, 1) < window_start_at(now, 1));
        // 三天窗口本身就比 24 小时长，取数起点就是窗口起点
        assert_eq!(fetch_start_at(now, 3), window_start_at(now, 3));
    }

    /// 思考 token 藏在 completion 的 details 里；积分没有就是 None —— 0 会被读成「免费」。
    #[test]
    fn 解析思考_token_与积分() {
        let usage = serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "completion_tokens_details": { "reasoning_tokens": 20 },
            "credit": 0.28
        });
        let numbers = parse_usage(&usage);
        assert_eq!(numbers.prompt, 100);
        assert_eq!(numbers.completion, 50);
        // 上游没给 total：按 prompt + completion 兜底
        assert_eq!(numbers.total, 150);
        assert_eq!(numbers.reasoning, 20);
        assert_eq!(parse_credit(&usage), Some(0.28));

        assert_eq!(parse_credit(&serde_json::json!({ "prompt_tokens": 1 })), None);
        assert_eq!(parse_usage(&serde_json::json!({})).reasoning, 0);
    }
}
