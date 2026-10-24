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
    let path = crate::paths::gateway_usage_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建用量目录失败: {err}"))?;
    }
    let mut line = serde_json::to_string(row).map_err(|err| format!("序列化用量失败: {err}"))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
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

// ---------- 聚合 ----------

/// 一段时间内的汇总。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub requests: i64,
    pub failed: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    /// 上游 `usage.credit` 累计。**只累计大于 0 的观测**，缺字段与 0 消耗都不参与
    pub credits: f64,
    /// 积分大于 0 的请求数（0 消耗 / 缺字段都不算）
    pub credit_samples: i64,
    /// 积分大于 0 的请求的总 token（比率的分子分母来自同一批请求）
    pub credit_tokens: i64,
    /// 积分 / 1M Token：`credits / credit_tokens`，**按总量直接除**
    pub credits_per_1m_tokens: f64,
    /// 平均首字延迟（毫秒）。只算成功的流式请求
    pub avg_ttft_ms: i64,
    /// 输出的 token / 秒（按整段耗时算）
    pub tokens_per_sec: f64,
    /// 命中率：缓存 token / 输入 token
    pub cache_hit_pct: f64,
    /// 成功率
    pub success_pct: f64,
    /// 估算花费（人民币）。价表里没有的模型不计入
    pub cost_cny: f64,
    /// 价表里有价的那部分 token：`cost_cny / priced_tokens` 才是「每百万 token 花多少」的分子分母
    pub priced_tokens: i64,
    /// 有价可折的请求数。缺价的历史不进这个数 —— 折算率的分母不能掺零
    pub priced_requests: i64,
    pub by_model: Vec<ModelSummary>,
    /// 时序分桶。窗口短时按小时（才看得见尖峰），长窗口退回按天，见 `bucket_unit`
    pub by_bucket: Vec<BucketSummary>,
    /// 时序的粒度：`hour` / `day`
    pub bucket_unit: String,
    pub by_account: Vec<AccountSummary>,
}

/// 按账号汇总
///
/// 除了「用了多少」，这里还要能回答「花了多少、缓存省下多少」—— 两组明细表（按账号 / 按模型）
/// 摆的是同一批列，所以字段也一一对应：`total_tokens` 是这一组的总量，`priced_tokens`
/// 只算价表里有价的那部分（折算率的分母），`cached_tokens` 与 `prompt_tokens` 算命中率。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub uid: String,
    pub requests: i64,
    pub failed: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    /// 这一组的积分累计与匹配 token（口径同全量，见 `Summary`）
    pub credits: f64,
    pub credit_samples: i64,
    pub credit_tokens: i64,
    pub credits_per_1m_tokens: f64,
    /// 命中率：缓存 token / 输入 token（这一组自己的口径，不是全量的）
    pub cache_hit_pct: f64,
    /// 这一组的估算花费。未定价的模型按 0 计
    pub cost_cny: f64,
    pub priced_tokens: i64,
    pub priced_requests: i64,
    pub avg_ttft_ms: i64,
    pub tokens_per_sec: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub model: String,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    /// 这一组的积分累计与匹配 token（口径同全量，见 `Summary`）
    pub credits: f64,
    pub credit_samples: i64,
    pub credit_tokens: i64,
    pub credits_per_1m_tokens: f64,
    pub cache_hit_pct: f64,
    pub cost_cny: f64,
    pub priced_tokens: i64,
    pub priced_requests: i64,
}

/// 时序的一格。`bucket` 是这一格的起点，按 `bucket_unit` 给到小时或到天：
/// `2026-10-20 14` 或 `2026-10-20`（都是本地墙钟）。键本身就是时间顺序，排序直接比字符串。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketSummary {
    pub bucket: String,
    pub requests: i64,
    pub total_tokens: i64,
    pub cost_cny: f64,
}

/// 时序的分桶粒度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BucketUnit {
    Hour,
    Day,
}

impl BucketUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            BucketUnit::Hour => "hour",
            BucketUnit::Day => "day",
        }
    }

    fn width(self) -> usize {
        match self {
            // `YYYY-MM-DD HH`：截到小时
            BucketUnit::Hour => 13,
            // `YYYY-MM-DD`
            BucketUnit::Day => 10,
        }
    }

    fn secs(self) -> i64 {
        match self {
            BucketUnit::Hour => 3600,
            BucketUnit::Day => 86400,
        }
    }
}

/// 窗口 → 粒度。一周以内按小时：那一档要回答「几点最费」，按天只剩七根柱子、什么也看不出。
/// 窗口再长就退回按天 —— 三十天按小时是 720 根柱子，谁也读不动。
pub fn bucket_unit(days: i64) -> BucketUnit {
    if days <= 7 {
        BucketUnit::Hour
    } else {
        BucketUnit::Day
    }
}

/// 一个时刻落在哪个桶里（本地墙钟的前 10 / 13 个字符）。
fn bucket_key(ts: i64, unit: BucketUnit) -> String {
    crate::wb_api_billing::format_wall_clock(ts)
        .chars()
        .take(unit.width())
        .collect()
}

/// 聚合一批行。粒度由 `bucket_unit(days)` 定，调用方传进来（见 `wb_gateway_usage`）。
pub fn summarize(rows: &[UsageRow], unit: BucketUnit) -> Summary {
    let mut summary = Summary {
        requests: rows.len() as i64,
        bucket_unit: unit.as_str().to_string(),
        ..Summary::default()
    };
    let mut ttft_sum = 0i64;
    let mut ttft_count = 0i64;
    let mut generation_ms = 0i64;

    let mut by_model: Vec<ModelSummary> = Vec::new();
    let mut by_bucket: Vec<BucketSummary> = Vec::new();
    let mut by_account: Vec<AccountSummary> = Vec::new();

    for row in rows {
        if !row.ok {
            summary.failed += 1;
        }
        summary.prompt_tokens += row.prompt_tokens;
        summary.completion_tokens += row.completion_tokens;
        summary.total_tokens += row.total_tokens;
        summary.cached_tokens += row.cached_tokens;
        if row.ok && row.ttft_ms > 0 {
            ttft_sum += row.ttft_ms;
            ttft_count += 1;
        }
        generation_ms += row.duration_ms.max(1);
        // 一行只查一次价：花费、折算分母、分组累计都要用同一个判断，
        // 分头去查会出现「计了费但不算样本」这种自相矛盾的口径。
        let row_cost = cost_of(row);
        if let Some(amount) = row_cost {
            summary.cost_cny += amount;
            summary.priced_tokens += row.total_tokens;
            summary.priced_requests += 1;
        }

        // 积分只认上游明确给的、且大于 0 的数：缺字段与 credit = 0 都不进样本 / 分母。
        if let Some(credit) = row.credit.filter(|amount| *amount > 0.0) {
            summary.credits += credit;
            summary.credit_samples += 1;
            if row.total_tokens > 0 {
                summary.credit_tokens += row.total_tokens;
            }
        }

        accumulate_model(&mut by_model, row, row_cost);
        accumulate_bucket(&mut by_bucket, row, row_cost, unit);
        accumulate_account(&mut by_account, row, row_cost);
    }

    if ttft_count > 0 {
        summary.avg_ttft_ms = ttft_sum / ttft_count;
    }
    if generation_ms > 0 {
        summary.tokens_per_sec =
            (summary.completion_tokens as f64) / (generation_ms as f64 / 1000.0);
    }
    summary.cache_hit_pct = hit_pct(summary.cached_tokens, summary.prompt_tokens);
    if summary.requests > 0 {
        summary.success_pct =
            (summary.requests - summary.failed) as f64 / summary.requests as f64 * 100.0;
    }
    summary.cost_cny = round2(summary.cost_cny);
    // 跨模型/跨账号的总比率：直接把两个总量相除，不是各组比率的平均
    summary.credits_per_1m_tokens = per_million(summary.credits, summary.credit_tokens);

    // 命中率、花费与积分比率都得等这一组累计完再算：增量平均会把早期的比例带偏
    for account in &mut by_account {
        account.cache_hit_pct = hit_pct(account.cached_tokens, account.prompt_tokens);
        account.cost_cny = round2(account.cost_cny);
        account.credits_per_1m_tokens = per_million(account.credits, account.credit_tokens);
    }
    for model in &mut by_model {
        model.cache_hit_pct = hit_pct(model.cached_tokens, model.prompt_tokens);
        model.credits_per_1m_tokens = per_million(model.credits, model.credit_tokens);
    }

    by_model.sort_by_key(|item| std::cmp::Reverse(item.prompt_tokens + item.completion_tokens));
    by_account.sort_by_key(|item| std::cmp::Reverse(item.requests));
    // 空档补齐到「有数据的第一格 → 最后一格」：不补的话，空闲的午后会跟下一条并排成一根，
    // 柱子之间的间距就不再代表时间。
    if let (Some(first_ts), Some(last_ts)) = (
        rows.iter().map(|row| row.ts).min(),
        rows.iter().map(|row| row.ts).max(),
    ) {
        fill_gaps(&mut by_bucket, first_ts, last_ts, unit);
    }
    summary.by_model = by_model;
    summary.by_bucket = by_bucket;
    summary.by_account = by_account;
    summary
}

/// 把区间里没有请求的格子补成 0，然后按桶键（= 时间顺序）排好。
fn fill_gaps(list: &mut Vec<BucketSummary>, first_ts: i64, last_ts: i64, unit: BucketUnit) {
    let mut ts = first_ts;
    while ts <= last_ts {
        let key = bucket_key(ts, unit);
        if !list.iter().any(|item| item.bucket == key) {
            list.push(BucketSummary {
                bucket: key,
                requests: 0,
                total_tokens: 0,
                cost_cny: 0.0,
            });
        }
        ts += unit.secs();
    }
    list.sort_by(|a, b| a.bucket.cmp(&b.bucket));
}

/// 命中率：缓存 token / 输入 token。没有输入就是 0，不是 NaN。
fn hit_pct(cached: i64, prompt: i64) -> f64 {
    if prompt > 0 {
        cached as f64 / prompt as f64 * 100.0
    } else {
        0.0
    }
}

/// 积分 / 1M Token。分母为空就是 0（界面上按样本数显示「—」），不是 NaN。
/// **按总量直接除**：跨模型的汇总比率由 `credits` 与 `credit_tokens` 两个总量算，
/// 不是各组比率的平均。
fn per_million(credits: f64, tokens: i64) -> f64 {
    if tokens > 0 {
        credits / tokens as f64 * 1_000_000.0
    } else {
        0.0
    }
}

fn accumulate_model(list: &mut Vec<ModelSummary>, row: &UsageRow, row_cost: Option<f64>) {
    let entry = match list.iter_mut().find(|item| item.model == row.model) {
        Some(entry) => entry,
        None => {
            list.push(ModelSummary {
                model: row.model.clone(),
                requests: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                cached_tokens: 0,
                credits: 0.0,
                credit_samples: 0,
                credit_tokens: 0,
                credits_per_1m_tokens: 0.0,
                cache_hit_pct: 0.0,
                cost_cny: 0.0,
                priced_tokens: 0,
                priced_requests: 0,
            });
            list.last_mut().expect("刚 push 过")
        }
    };
    entry.requests += 1;
    entry.prompt_tokens += row.prompt_tokens;
    entry.completion_tokens += row.completion_tokens;
    entry.total_tokens += row.total_tokens;
    entry.cached_tokens += row.cached_tokens;
    if let Some(credit) = row.credit.filter(|amount| *amount > 0.0) {
        entry.credits += credit;
        entry.credit_samples += 1;
        if row.total_tokens > 0 {
            entry.credit_tokens += row.total_tokens;
        }
    }
    if let Some(amount) = row_cost {
        entry.cost_cny = round2(entry.cost_cny + amount);
        entry.priced_tokens += row.total_tokens;
        entry.priced_requests += 1;
    }
}

fn accumulate_bucket(
    list: &mut Vec<BucketSummary>,
    row: &UsageRow,
    row_cost: Option<f64>,
    unit: BucketUnit,
) {
    let key = bucket_key(row.ts, unit);
    let entry = match list.iter_mut().find(|item| item.bucket == key) {
        Some(entry) => entry,
        None => {
            list.push(BucketSummary {
                bucket: key,
                requests: 0,
                total_tokens: 0,
                cost_cny: 0.0,
            });
            list.last_mut().expect("刚 push 过")
        }
    };
    entry.requests += 1;
    entry.total_tokens += row.total_tokens;
    if let Some(amount) = row_cost {
        entry.cost_cny = round2(entry.cost_cny + amount);
    }
}

fn accumulate_account(list: &mut Vec<AccountSummary>, row: &UsageRow, row_cost: Option<f64>) {
    let entry = match list.iter_mut().find(|item| item.uid == row.uid) {
        Some(entry) => entry,
        None => {
            list.push(AccountSummary {
                uid: row.uid.clone(),
                requests: 0,
                failed: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                cached_tokens: 0,
                credits: 0.0,
                credit_samples: 0,
                credit_tokens: 0,
                credits_per_1m_tokens: 0.0,
                cache_hit_pct: 0.0,
                cost_cny: 0.0,
                priced_tokens: 0,
                priced_requests: 0,
                avg_ttft_ms: 0,
                tokens_per_sec: 0.0,
            });
            list.last_mut().expect("刚 push 过")
        }
    };
    entry.requests += 1;
    if !row.ok {
        entry.failed += 1;
    }
    entry.prompt_tokens += row.prompt_tokens;
    entry.completion_tokens += row.completion_tokens;
    entry.total_tokens += row.total_tokens;
    entry.cached_tokens += row.cached_tokens;
    if let Some(credit) = row.credit.filter(|amount| *amount > 0.0) {
        entry.credits += credit;
        entry.credit_samples += 1;
        if row.total_tokens > 0 {
            entry.credit_tokens += row.total_tokens;
        }
    }
    if let Some(amount) = row_cost {
        entry.cost_cny += amount;
        entry.priced_tokens += row.total_tokens;
        entry.priced_requests += 1;
    }
    // 增量平均：先按旧平均折算回总量，加上新的，再除以新条数
    if row.ok && row.ttft_ms > 0 {
        let counted = entry.requests - entry.failed;
        let total = entry.avg_ttft_ms * (counted - 1).max(0) + row.ttft_ms;
        entry.avg_ttft_ms = total / counted.max(1);
    }
    // 速度按累计 token / 累计秒算，避免单条异常值把均值带偏
    if entry.completion_tokens > 0 {
        entry.tokens_per_sec = entry.completion_tokens as f64;
    }
}

/// 一行的估算花费。价表里没有的模型返回 `None`（界面标"未定价"），不是 0 ——
/// 0 会被当成「免费」，而事实是「不知道」。
fn cost_of(row: &UsageRow) -> Option<f64> {
    cost_for(&row.model, row.prompt_tokens, row.completion_tokens)
}

/// 按价表折一次价。记账时与聚合时共用同一个函数，两个数才不会慢慢对不上。
pub fn cost_for(model: &str, prompt: i64, completion: i64) -> Option<f64> {
    crate::wb_pricing::price_of(model).map(|price| price.input_cny(prompt) + price.output_cny(completion))
}

pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
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

    fn at(row: UsageRow, ts: i64) -> UsageRow {
        UsageRow { ts, ..row }
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

    /// 命中率与花费都是「这一组自己的口径」：账号 A 的命中率不许被账号 B 的输入带偏。
    #[test]
    fn 分组的命中率各算各的() {
        let rows = vec![
            row("a", "glm-5.2", 1000, 100, 900),
            row("a", "glm-5.2", 1000, 100, 0),
            row("b", "unknown-model", 500, 50, 100),
        ];
        let summary = summarize(&rows, BucketUnit::Hour);
        // 全量：命中 1000 / 输入 2500
        assert!((summary.cache_hit_pct - 40.0).abs() < 1e-9);

        let a = summary.by_account.iter().find(|item| item.uid == "a").unwrap();
        assert!((a.cache_hit_pct - 45.0).abs() < 1e-9);
        assert_eq!(a.total_tokens, 2200);
        assert!(a.cost_cny > 0.0);

        let b = summary.by_account.iter().find(|item| item.uid == "b").unwrap();
        assert_eq!(b.cached_tokens, 100);
        // 未定价的模型：花费记 0，但 token 与命中率照常记账 —— 它确实用了
        assert_eq!(b.cost_cny, 0.0);
        assert_eq!(b.total_tokens, 550);
        assert!((b.cache_hit_pct - 20.0).abs() < 1e-9);
    }

    /// 折算率的分母只算价表里有价的那部分：未定价模型的 token 掺进来会把「每百万花多少」压低。
    #[test]
    fn 未定价的请求不进折算分母() {
        let rows = vec![
            row("a", "glm-5.2", 1000, 100, 0),
            row("a", "unknown-model", 900_000, 0, 0),
        ];
        let summary = summarize(&rows, BucketUnit::Hour);

        assert_eq!(summary.priced_requests, 1);
        assert_eq!(summary.priced_tokens, 1100);
        assert_eq!(summary.total_tokens, 901_100);

        let unknown = summary.by_model.iter().find(|item| item.model == "unknown-model").unwrap();
        assert_eq!(unknown.priced_tokens, 0);
        assert_eq!(unknown.priced_requests, 0);
        assert_eq!(unknown.cost_cny, 0.0);
    }

    /// 积分只累计上游明确给过、且大于 0 的样本：缺字段的行与 0 积分都不进样本数、也不进分母。
    /// 跨模型的总比率是总量直接除，不是各组比率的平均。
    #[test]
    fn 积分按有观测的样本聚合且跨模型总量直接除() {
        let mut first = row("a", "m1", 1_000_000, 0, 0);
        first.credit = Some(1.0);
        let mut second = row("a", "m2", 4_000_000, 0, 0);
        second.credit = Some(12.0);
        // 缺 credit：这条的 token 不进分母，也不计样本
        let missing = row("a", "m1", 1_000_000, 0, 0);
        // 0 积分（免费请求）：同样不进样本 / 分母
        let mut free = row("b", "m3", 1_000_000, 0, 0);
        free.credit = Some(0.0);

        let summary = summarize(&[first, second, missing, free], BucketUnit::Day);

        assert_eq!(summary.credit_samples, 2);
        assert_eq!(summary.credit_tokens, 5_000_000);
        assert!((summary.credits - 13.0).abs() < 1e-9);
        // 13 / 5M；不是三个模型比率 (1 + 3 + 0) / 3 = 1.333…
        assert!((summary.credits_per_1m_tokens - 13.0 / 5.0).abs() < 1e-9);

        let m1 = summary.by_model.iter().find(|item| item.model == "m1").unwrap();
        assert_eq!(m1.credit_samples, 1);
        assert_eq!(m1.credit_tokens, 1_000_000);
        assert!((m1.credits_per_1m_tokens - 1.0).abs() < 1e-9);

        let free_model = summary.by_model.iter().find(|item| item.model == "m3").unwrap();
        assert_eq!(free_model.credit_samples, 0);
        assert_eq!(free_model.credits, 0.0);
        assert_eq!(free_model.credits_per_1m_tokens, 0.0);

        let account_a = summary.by_account.iter().find(|item| item.uid == "a").unwrap();
        assert_eq!(account_a.credit_samples, 2);
        assert_eq!(account_a.credit_tokens, 5_000_000);
        assert!((account_a.credits_per_1m_tokens - 13.0 / 5.0).abs() < 1e-9);

        let account_b = summary.by_account.iter().find(|item| item.uid == "b").unwrap();
        assert_eq!(account_b.credit_samples, 0);
        assert_eq!(account_b.credits_per_1m_tokens, 0.0);
    }

    /// 时序：短窗口按小时，而且空闲的那一格要补 0 —— 不补的话柱子会并排成一根，
    /// 间距就不再代表时间。
    #[test]
    fn 时序按小时分桶并补齐空档() {
        let base = 1_770_000_000;
        let rows = vec![
            at(row("a", "glm-5.2", 100, 10, 0), base),
            // 隔两个小时的第二条：中间那一格该出现，且是 0
            at(row("a", "glm-5.2", 200, 20, 0), base + 2 * 3600),
        ];

        let hourly = summarize(&rows, BucketUnit::Hour);
        assert_eq!(hourly.bucket_unit, "hour");
        assert_eq!(hourly.by_bucket.len(), 3);
        assert_eq!(hourly.by_bucket[1].requests, 0);
        assert_eq!(hourly.by_bucket[1].total_tokens, 0);
        assert_eq!(hourly.by_bucket[2].requests, 1);
        assert_eq!(hourly.by_bucket[2].total_tokens, 220);
        // 键即时间顺序
        assert!(hourly.by_bucket[0].bucket.len() == 13);
        assert!(hourly.by_bucket[0].bucket < hourly.by_bucket[1].bucket);

        // 同一天的这两条，按天只剩一格
        let daily = summarize(&rows, BucketUnit::Day);
        assert_eq!(daily.bucket_unit, "day");
        assert_eq!(daily.by_bucket.len(), 1);
        assert_eq!(daily.by_bucket[0].requests, 2);
    }

    #[test]
    fn 窗口决定分桶粒度() {
        assert_eq!(bucket_unit(1), BucketUnit::Hour);
        assert_eq!(bucket_unit(3), BucketUnit::Hour);
        assert_eq!(bucket_unit(7), BucketUnit::Hour);
        // 三十天按小时是 720 根柱子，谁也读不动
        assert_eq!(bucket_unit(30), BucketUnit::Day);
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
