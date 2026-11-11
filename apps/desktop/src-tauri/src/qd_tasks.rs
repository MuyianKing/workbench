//! Qoder 每日签到、活动领取、积分消耗热力与自动签到。
//!
//! 上游的每日签到现在是活动平台的一项（每天 100 Credits，10:00 UTC+8 刷新，
//! 桌面端才能领）。这里只认**上游明确说的**：
//! - `status == CLAIMED` 且 `lastClaimedAt` 是今天 → 今天已签；
//! - `CLAIMABLE` 才去领；`DISABLED` / 其他状态按「活动未开放」跳过；
//! - 领取返回 `ALREADY_CLAIMED` 也归一成「今天已签」。
//!
//! 记录写在 `data/wb-qoder/activity.jsonl`：时间、uid、昵称、任务、结果、本次领到的积分、
//! 一句截断并脱敏的说明。**不落 token / cookie / 请求体。**
//! 这份记录同时是福利栏「每日获取积分」统计的唯一来源
//! （见 [`earning_rows`] / [`aggregate_earnings`]）。

use std::collections::{BTreeMap, HashMap};
use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::http;
use crate::common::{civil_from_days, now_secs, redact};
use crate::qd_account::Account;
use crate::qd_credits::account_headers;
use crate::qd_upstream;

/// 签到状态。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckinStatus {
    pub ok: bool,
    pub available: bool,
    pub today_checked_in: bool,
    pub status: String,
    pub streak_days: i64,
    pub total_claim_days: i64,
    pub reward_credits: i64,
    pub next_claim_at: i64,
    pub last_claimed_at: i64,
    pub error: String,
}

/// 一次领取的结果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResult {
    pub ok: bool,
    pub already: bool,
    pub unavailable: bool,
    pub reward_credits: i64,
    pub message: String,
    /// 领到的兑换码（活动 id → 码）
    pub codes: HashMap<String, String>,
    pub error: String,
}

/// 一张热力图上的点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapPoint {
    pub date: String,
    pub value: f64,
}

/// 一个活动的展示信息。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignView {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub action_type: String,
    pub benefit_kind: String,
    pub benefit_amount: i64,
    pub end_at: i64,
    pub unavailable_reason: String,
    /// 已领到的兑换码
    pub code: String,
}

/// 签到尝试记录（一行一次真实尝试）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub ts: i64,
    pub date: String,
    pub uid: String,
    pub nickname: String,
    pub task: String,
    pub ok: bool,
    pub message: String,
    /// 这次动作实际领到的积分（签到 / 活动）。旧记录没有这一位，读成 0
    #[serde(default)]
    pub credits: i64,
}

/// 「每日获取的积分」柱状图的一点：UTC+8 自然日 → 当天领到的积分合计。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningPoint {
    pub date: String,
    pub credits: i64,
}

/// 一条可同步的领取记录（只保留多机合并要用的字段，不含昵称 / token）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningRow {
    pub ts: i64,
    pub date: String,
    pub uid: String,
    pub task: String,
    pub credits: i64,
    /// 活动标题 / 签到说明，用来在多机合并时去重
    pub message: String,
}

fn get_json(account: &Account, method: &str, path: &str, body: Option<&str>) -> Result<serde_json::Value, String> {
    let url = qd_upstream::openapi(path);
    let headers = account_headers(account);
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    http::request_json(method, &url, &refs, body, 2 * 1024 * 1024, 160)
}

/// 今天（UTC+8）的 `YYYY-MM-DD`。
pub fn today() -> String {
    let local = now_secs() + 8 * 3600;
    let days = local.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}


/// 查签到状态。
pub fn checkin_status(account: &Account) -> CheckinStatus {
    let mut status = CheckinStatus::default();
    let value = match get_json(account, "GET", qd_upstream::PATH_CHECKIN_STATUS, None) {
        Ok(value) => value,
        Err(message) => {
            status.error = message;
            return status;
        }
    };
    let data = value.get("data").cloned().unwrap_or(value);
    status.ok = true;
    status.available = true;
    status.status = data
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    status.streak_days = data
        .get("currentStreakDays")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    status.total_claim_days = data
        .get("totalClaimDays")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    status.reward_credits = data
        .get("rewardCredits")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    status.next_claim_at = data
        .get("nextClaimAt")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    status.last_claimed_at = data
        .get("lastClaimedAt")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let last_day = if status.last_claimed_at > 0 {
        let local = status.last_claimed_at + 8 * 3600;
        let days = local.div_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        String::new()
    };
    status.today_checked_in = status.status == "CLAIMED" && last_day == today();
    status
}

/// 签到（已签就是 already）。
pub fn checkin(account: &mut Account) -> ClaimResult {
    let status = checkin_status(account);
    if !status.ok {
        let unavailable = status.error.contains("HTTP 404")
            || status.error.contains("HTTP 405")
            || status.error.contains("HTTP 410");
        record_activity(account, "checkin", false, &status.error);
        return ClaimResult {
            unavailable,
            error: status.error,
            ..ClaimResult::default()
        };
    }
    if status.today_checked_in {
        stamp_checkin(account);
        record_activity(account, "checkin", true, "今日已签到");
        return ClaimResult {
            ok: true,
            already: true,
            message: "今日已签到".into(),
            ..ClaimResult::default()
        };
    }
    if status.status != "CLAIMABLE" {
        record_activity(account, "checkin", true, "官方签到活动未开放");
        return ClaimResult {
            ok: true,
            message: format!("官方签到活动未开放（status={}）", status.status),
            ..ClaimResult::default()
        };
    }
    let value = match get_json(account, "POST", qd_upstream::PATH_CHECKIN_CLAIM, Some("{}")) {
        Ok(value) => value,
        Err(message) => {
            if message.contains("ALREADY_CLAIMED") {
                stamp_checkin(account);
                record_activity(account, "checkin", true, "今日已签到");
                return ClaimResult {
                    ok: true,
                    already: true,
                    message: "今日已签到".into(),
                    ..ClaimResult::default()
                };
            }
            record_activity(account, "checkin", false, &message);
            return ClaimResult {
                error: message,
                ..ClaimResult::default()
            };
        }
    };
    let data = value.get("data").cloned().unwrap_or(value);
    if data.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
        let error = data
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("领取失败")
            .to_string();
        record_activity(account, "checkin", false, &error);
        return ClaimResult {
            error,
            ..ClaimResult::default()
        };
    }
    let reward = data
        .get("rewardCredits")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    stamp_checkin(account);
    record_activity_with(account, "checkin", true, reward, &format!("签到成功 +{reward} 积分"));
    ClaimResult {
        ok: true,
        reward_credits: reward,
        message: if reward > 0 {
            format!("签到成功 +{reward} 积分")
        } else {
            "签到成功".into()
        },
        ..ClaimResult::default()
    }
}

/// 领一遍活动（能领的都领）。没有真实机器身份时列表可能被上游隐藏，
/// 这时只返回「今天没有可领的活动」，不算失败。
pub fn claim_campaigns(account: &mut Account) -> ClaimResult {
    let mut result = ClaimResult::default();
    let value = match get_json(account, "GET", qd_upstream::PATH_CAMPAIGNS, None) {
        Ok(value) => value,
        Err(message) => {
            result.ok = true;
            result.message = format!("活动列表读取失败：{message}");
            return result;
        }
    };
    let data = value.get("data").cloned().unwrap_or(value);
    let items = campaign_items(&data, account);
    let claimable: Vec<&CampaignView> = items
        .iter()
        .filter(|item| !item.id.is_empty() && item.status == "CLAIMABLE")
        .collect();
    if claimable.is_empty() {
        result.ok = true;
        result.message = "今天没有可领的活动".into();
        return result;
    }
    let mut codes = HashMap::new();
    for item in claimable {
        let path = format!("/sash/api/v1/me/campaigns/{}/claim", item.id);
        match get_json(account, "POST", &path, Some("{}")) {
            Ok(value) => {
                let data = value.get("data").cloned().unwrap_or(value);
                let code = find_code(&data);
                if let Some(code) = code {
                    codes.insert(item.id.clone(), code);
                }
                // 领取响应不一定带面额（实测只回 success），取不到就退回活动列表里的 `benefit.amount`
                let amount = claim_reward(&data, item.benefit_amount);
                result.reward_credits += amount;
                record_activity_with(
                    account,
                    "campaign",
                    true,
                    amount,
                    &format!("领取活动 {}", item.title),
                );
            }
            Err(message) => {
                if !message.contains("ALREADY_CLAIMED") {
                    record_activity(account, "campaign", false, &message);
                }
            }
        }
    }
    for (id, code) in &codes {
        account.campaign_codes.insert(id.clone(), code.clone());
    }
    result.ok = true;
    result.codes = codes;
    result.message = if result.reward_credits > 0 {
        format!("领取成功 +{} 积分", result.reward_credits)
    } else {
        "已领取可用的活动".into()
    };
    result
}

/// 本次领到的积分：优先认响应里的面额，响应没给就用活动列表里的 `benefit.amount`。
fn claim_reward(data: &serde_json::Value, benefit_amount: i64) -> i64 {
    match claim_amount(data) {
        Some(value) if value > 0 => value,
        _ => benefit_amount,
    }
}

/// 领取响应里的本次面额。上游不一定回 `amount`；数字可能是整数、浮点或字符串。
fn claim_amount(data: &serde_json::Value) -> Option<i64> {
    for key in ["amount", "rewardCredits", "credits"] {
        if let Some(value) = data.get(key).and_then(json_i64) {
            return Some(value);
        }
    }
    data.get("benefit")
        .and_then(|benefit| benefit.get("amount"))
        .and_then(json_i64)
}

fn json_i64(value: &serde_json::Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_f64() {
        return Some(number.round() as i64);
    }
    value
        .as_str()
        .and_then(|text| text.trim().parse::<f64>().ok())
        .map(|number| number.round() as i64)
}

fn find_code(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value
        .get("redemptionCode")
        .or_else(|| value.get("code"))
        .and_then(serde_json::Value::as_str)
    {
        if text.starts_with("REDEMPTION") || text.len() > 6 {
            return Some(text.to_string());
        }
    }
    if let Some(object) = value.as_object() {
        for child in object.values() {
            if let Some(code) = find_code(child) {
                return Some(code);
            }
        }
    }
    if let Some(list) = value.as_array() {
        for child in list {
            if let Some(code) = find_code(child) {
                return Some(code);
            }
        }
    }
    None
}

/// 读活动列表（官方文案在 placements[].content.zh）。
pub fn campaigns(account: &Account) -> Vec<CampaignView> {
    let Ok(value) = get_json(account, "GET", qd_upstream::PATH_CAMPAIGNS, None) else {
        return Vec::new();
    };
    let data = value.get("data").cloned().unwrap_or(value);
    campaign_items(&data, account)
}

pub fn campaign_items(data: &serde_json::Value, account: &Account) -> Vec<CampaignView> {
    let list = data
        .get("campaigns")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in list {
        let Some(object) = item.as_object() else {
            continue;
        };
        let id = object
            .get("campaignId")
            .or_else(|| object.get("campaign_id"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut title = String::new();
        let mut description = String::new();
        if let Some(placements) = object.get("placements").and_then(serde_json::Value::as_array) {
            for placement in placements {
                let Some(content) = placement.get("content") else {
                    continue;
                };
                let zh = content.get("zh").and_then(serde_json::Value::as_object);
                if let Some(zh) = zh {
                    if title.is_empty() {
                        title = zh.get("title").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
                    }
                    if description.is_empty() {
                        description = zh
                            .get("description")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .to_string();
                    }
                }
                if !title.is_empty() && !description.is_empty() {
                    break;
                }
            }
        }
        let benefit = object.get("benefit").cloned().unwrap_or_default();
        out.push(CampaignView {
            id,
            title,
            description,
            status: object
                .get("claimStatus")
                .or_else(|| object.get("claim_status"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            action_type: object
                .get("actionType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            benefit_kind: benefit
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            benefit_amount: benefit
                .get("amount")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0),
            end_at: object
                .get("endAt")
                .and_then(serde_json::Value::as_i64)
                .map(|value| if value > 100_000_000_000 { value / 1000 } else { value })
                .unwrap_or(0),
            unavailable_reason: object
                .get("unavailableReason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            code: account.campaign_codes.get(
                object
                    .get("campaignId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            ).cloned().unwrap_or_default(),
        });
    }
    out
}

/// 读官方积分消耗热力。上游回的是**一整年**的点（`items`），窗口由界面按近 30 天裁。
pub fn credit_usage(account: &Account) -> Vec<HeatmapPoint> {
    let Ok(value) = get_json(account, "GET", qd_upstream::PATH_CREDIT_HEATMAP, None) else {
        return Vec::new();
    };
    let data = value.get("data").cloned().unwrap_or(value);
    parse_heatmap(&data)
}

/// 热力响应归一：实测是 `{ items: [{ date, value }] }`（371 天，含全年零值），
/// 旧形态另有 `daily`；`levels` / `total` / `unit` / `year` 不是日历数据，忽略。
fn parse_heatmap(data: &serde_json::Value) -> Vec<HeatmapPoint> {
    let Some(list) = data
        .get("items")
        .or_else(|| data.get("daily"))
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let mut points = Vec::new();
    for item in list {
        let date = item
            .get("date")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        if date.is_empty() {
            continue;
        }
        let value = item
            .get("value")
            .or_else(|| item.get("credits"))
            .or_else(|| item.get("amount"))
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        points.push(HeatmapPoint { date, value });
    }
    points.sort_by(|a, b| a.date.cmp(&b.date));
    points
}

/// 把一个号的「今天已签」写回账号文件。
pub fn stamp_checkin(account: &mut Account) {
    account.last_checkin = today();
}

fn stamp(account: &Account) {
    let mut copy = account.clone();
    copy.last_checkin = today();
    let _ = copy.save(&crate::paths::qoder_accounts_dir());
}

/// 追加一条尝试记录（脱敏、截断、超过 1 MiB 只留最近 2000 行）。
pub fn record_activity(account: &Account, task: &str, ok: bool, message: &str) {
    record_activity_with(account, task, ok, 0, message);
}

/// 同 [`record_activity`]，额外记下这次真实领到的积分（每日获取统计的唯一来源）。
pub fn record_activity_with(account: &Account, task: &str, ok: bool, credits: i64, message: &str) {
    let row = ActivityRow {
        ts: now_secs(),
        date: today(),
        uid: account.uid.clone(),
        nickname: account.nickname.clone(),
        task: task.to_string(),
        ok,
        message: redact(message),
        credits: credits.max(0),
    };
    let path = crate::paths::qoder_activity_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = std::fs::read_to_string(&path) {
        if text.len() > 1024 * 1024 {
            let keep: Vec<&str> = text.lines().rev().take(2000).collect();
            let mut buffer = String::new();
            for line in keep.into_iter().rev() {
                buffer.push_str(line);
                buffer.push('\n');
            }
            let _ = std::fs::write(&path, buffer);
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        if let Ok(line) = serde_json::to_string(&row) {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// 今天的尝试记录。
pub fn activity_today() -> Vec<ActivityRow> {
    let path = crate::paths::qoder_activity_file();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let today = today();
    text.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<ActivityRow>(line).ok())
        .filter(|row| row.date == today)
        .collect()
}

/// 本机窗口内的可同步领取记录。
pub fn earning_rows(since: i64) -> Vec<EarningRow> {
    earning_rows_at(&crate::paths::qoder_activity_file(), since)
}

fn earning_rows_at(path: &std::path::Path, since: i64) -> Vec<EarningRow> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for row in text
        .lines()
        .filter_map(|line| serde_json::from_str::<ActivityRow>(line).ok())
    {
        if !row.ok || row.ts < since {
            continue;
        }
        let credits = effective_credits(&row.task, &row.message, row.credits);
        if credits <= 0 {
            continue;
        }
        rows.push(EarningRow {
            ts: row.ts,
            date: row.date,
            uid: row.uid,
            task: row.task,
            credits,
            message: row.message,
        });
    }
    rows.sort_by_key(|row| row.ts);
    rows
}

/// 合并本机与别的设备的领取记录，按日相加。
///
/// 去重键是 `(uid, date, task, message)`：同一条领取最多由一台设备真正拿到响应，
/// 正常不会重复；万一被重复推送，也只算一次。
pub fn aggregate_earnings(rows: &[EarningRow], since: i64) -> Vec<EarningPoint> {
    let mut seen = std::collections::HashSet::new();
    let mut totals: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows {
        if row.ts < since {
            continue;
        }
        let credits = effective_credits(&row.task, &row.message, row.credits);
        if credits <= 0 {
            continue;
        }
        let key = (
            row.uid.clone(),
            row.date.clone(),
            row.task.clone(),
            row.message.clone(),
        );
        if !seen.insert(key) {
            continue;
        }
        *totals.entry(row.date.clone()).or_default() += credits;
    }
    totals
        .into_iter()
        .map(|(date, credits)| EarningPoint { date, credits })
        .collect()
}

/// 新记录直接用 `credits`；旧记录没有金额，从说明里回读。
fn effective_credits(task: &str, message: &str, credits: i64) -> i64 {
    if credits > 0 {
        credits
    } else {
        legacy_credits(task, message)
    }
}

/// 旧记录的金额写在说明里：签到是「签到成功 +100 积分」，
/// 活动是标题里的面额（「领取活动 每天领 100 Credits」）；看不出金额的不猜。
fn legacy_credits(task: &str, message: &str) -> i64 {
    match task {
        "checkin" => message
            .split('+')
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        "campaign" => title_credits(message.strip_prefix("领取活动 ").unwrap_or(message)),
        _ => 0,
    }
}

/// 活动标题里写在「Credits / 积分」前面的面额（支持千分位逗号）。
fn title_credits(title: &str) -> i64 {
    let lower = title.to_lowercase();
    for marker in ["credits", "积分"] {
        for (index, _) in lower.match_indices(marker) {
            let head = lower[..index].trim_end();
            let digits: String = head
                .chars()
                .rev()
                .skip_while(|ch| !ch.is_ascii_digit())
                .take_while(|ch| ch.is_ascii_digit() || *ch == ',')
                .filter(|ch| ch.is_ascii_digit())
                .collect();
            let number: String = digits.chars().rev().collect();
            if let Ok(value) = number.parse::<i64>() {
                return value;
            }
        }
    }
    0
}

// ---------- 自动签到 ----------

/// 自动签到的开关与每号上次跑的日期（`perks-auto.json`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PerksAuto {
    pub enabled: bool,
    /// uid → `YYYY-MM-DD`
    pub daily: HashMap<String, String>,
}

pub fn load_perks() -> PerksAuto {
    let path = crate::paths::qoder_perks_file();
    let Ok(text) = std::fs::read_to_string(path) else {
        return PerksAuto::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_perks(config: &PerksAuto) -> Result<(), String> {
    let path = crate::paths::qoder_perks_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建目录失败：{err}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|err| format!("序列化自动签到配置失败：{err}"))?;
    crate::fs_util::write_atomic(&path, text.as_bytes())
}

/// 一轮自动签到。返回 (跑了几个号, 共领到多少积分, 失败数, 一句话)。
pub fn auto_run(accounts: &mut [Account]) -> (usize, i64, usize, String) {
    let mut config = load_perks();
    if !config.enabled {
        return (0, 0, 0, String::new());
    }
    let today = today();
    let mut ran = 0;
    let mut credits = 0;
    let mut failed = 0;
    for account in accounts.iter_mut() {
        if !account.enabled || account.access_token.trim().is_empty() {
            continue;
        }
        if config.daily.get(&account.uid) == Some(&today) {
            continue;
        }
        if account.needs_refresh() && crate::qd_auth::refresh(account).is_err() {
            failed += 1;
            continue;
        }
        let result = checkin(account);
        if result.ok {
            stamp(account);
            credits += result.reward_credits;
            config.daily.insert(account.uid.clone(), today.clone());
            let _ = save_perks(&config);
            ran += 1;
        } else {
            failed += 1;
        }
    }
    let message = if ran > 0 {
        format!("自动签到：{ran} 个账号，新增 {credits} 积分")
    } else if failed > 0 {
        format!("自动签到：{failed} 个账号失败")
    } else {
        String::new()
    };
    (ran, credits, failed, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 今天是_utc8_的自然日() {
        let text = today();
        assert_eq!(text.len(), 10);
        assert_eq!(&text[4..5], "-");
        assert_eq!(&text[7..8], "-");
    }

    #[test]
    fn 敏感串被打码() {
        let text = redact("refresh failed: Bearer abcdef1234567890 and sk-1234567890");
        assert!(!text.contains("abcdef1234567890"));
        assert!(!text.contains("1234567890"));
    }

    #[test]
    fn 活动列表按官方中文文案取名() {
        let data = serde_json::json!({
            "campaigns": [{
                "campaignId": "c1",
                "claimStatus": "CLAIMABLE",
                "benefit": { "kind": "credits", "amount": 100 },
                "placements": [{ "content": { "zh": { "title": "每日签到", "description": "领 100 积分" } } }]
            }]
        });
        let account = Account::from_login("u1", "", "t", "", 0, "", "", "");
        let items = campaign_items(&data, &account);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "每日签到");
        assert_eq!(items[0].status, "CLAIMABLE");
    }

    fn activity(date: &str, ts: i64, ok: bool, credits: i64, message: &str) -> ActivityRow {
        ActivityRow {
            ts,
            date: date.into(),
            uid: "u1".into(),
            nickname: "n".into(),
            task: "checkin".into(),
            ok,
            message: message.into(),
            credits,
        }
    }

    fn campaign(date: &str, ts: i64, ok: bool, credits: i64, message: &str) -> ActivityRow {
        ActivityRow {
            ts,
            date: date.into(),
            uid: "u1".into(),
            nickname: "n".into(),
            task: "campaign".into(),
            ok,
            message: message.into(),
            credits,
        }
    }

    #[test]
    fn 每日获取按自然日相加且只算成功() {
        let dir = std::env::temp_dir().join(format!("wb-qoder-earn-{}", uuid::Uuid::new_v4()));
        let path = dir.join("activity.jsonl");
        std::fs::create_dir_all(&dir).unwrap_or_else(|err| panic!("{err}"));
        let rows = vec![
            activity("2026-11-07", 200, true, 100, "签到成功 +100 积分"),
            activity("2026-11-07", 300, true, 50, "领取活动 每日福利"),
            // 旧活动记录没有 credits：从标题里的面额回读（真实现场的「每天领 100 Credits」）
            campaign("2026-11-07", 320, true, 0, "领取活动 每天领 100 Credits"),
            // 旧记录没有 credits，回读说明里的金额
            activity("2026-11-06", 150, true, 0, "签到成功 +100 积分"),
            // 失败 / 窗口外 / 没有金额的旧记录都不进图
            activity("2026-11-07", 250, false, 999, "签到失败"),
            activity("2026-10-01", 90, true, 777, "签到成功 +777 积分"),
            activity("2026-11-05", 140, true, 0, "今日已签到"),
        ];
        let mut text = String::new();
        for row in rows {
            text.push_str(&serde_json::to_string(&row).unwrap_or_else(|err| panic!("{err}")));
            text.push('\n');
        }
        std::fs::write(&path, text).unwrap_or_else(|err| panic!("{err}"));

        let points = aggregate_earnings(&earning_rows_at(&path, 100), 100);
        assert_eq!(
            points,
            vec![
                EarningPoint { date: "2026-11-06".into(), credits: 100 },
                EarningPoint { date: "2026-11-07".into(), credits: 250 },
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 旧活动记录从标题回读面额() {
        assert_eq!(title_credits("每天领 100 Credits"), 100);
        assert_eq!(title_credits("领取 1,000 积分"), 1000);
        assert_eq!(title_credits("首次订阅福利"), 0);
        assert_eq!(legacy_credits("campaign", "领取活动 每天领 100 Credits"), 100);
        assert_eq!(legacy_credits("campaign", "领取活动 首次订阅福利"), 0);
        assert_eq!(legacy_credits("checkin", "签到成功 +100 积分"), 100);
    }

    #[test]
    fn 领取响应没有面额时退回活动面额() {
        assert_eq!(claim_reward(&serde_json::json!({ "success": true }), 100), 100);
        assert_eq!(claim_reward(&serde_json::json!({ "amount": "50" }), 100), 50);
        assert_eq!(claim_reward(&serde_json::json!({ "rewardCredits": 60.0 }), 100), 60);
        assert_eq!(claim_reward(&serde_json::json!({ "benefit": { "amount": 70 } }), 100), 70);
    }

    #[test]
    fn 官方消耗热力按_items_解析() {
        let data = serde_json::json!({
            "items": [
                { "date": "2026-11-07", "value": 105.5102274776 },
                { "date": "2026-10-15", "value": 262 },
                { "date": "2026-11-08", "value": 0 }
            ],
            "levels": [0, 10, 100],
            "total": 367.5,
            "unit": "credits",
            "year": 2026
        });
        let points = parse_heatmap(&data);
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].date, "2026-10-15");
        assert_eq!(points[1].value, 105.5102274776);
        assert_eq!(points[2].date, "2026-11-08");
    }

    #[test]
    fn 多机合并按_uid_日期_任务_说明去重() {
        let row = EarningRow {
            ts: 200,
            date: "2026-11-07".into(),
            uid: "u1".into(),
            task: "checkin".into(),
            credits: 100,
            message: "签到成功 +100 积分".into(),
        };
        let other = EarningRow {
            ts: 300,
            date: "2026-11-07".into(),
            uid: "u1".into(),
            task: "campaign".into(),
            credits: 50,
            message: "领取活动 每日福利".into(),
        };
        let points = aggregate_earnings(&[row.clone(), row, other], 100);
        assert_eq!(
            points,
            vec![EarningPoint { date: "2026-11-07".into(), credits: 150 }]
        );
    }
}
