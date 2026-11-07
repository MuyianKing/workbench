//! 任务福利：成长任务 / 每日签到 / 成长连登 / 猫猫旅行。
//!
//! 口径来自 workbuddy2api-hub 的 `wb_tasks.py` + `wb_activity.py`，
//! 这里只做两件事上的收敛：
//!
//! 1. **每一次尝试都落一行** [`ActivityRow`]（`activity.jsonl`）：签到过去只留在
//!    日志里，重启即散，回答不了「这个号昨天到底签成没有」。写进去的是运维元数据，
//!    不是凭据：uid / 昵称 / 任务 / 结果 / 一句截断并脱敏过的说明。
//! 2. **默认只给用户点了按钮才动**：这一页的每个动作都是一次显式的上游请求；
//!    福利自动跑是用户显式打开的开关（见 `wb_gateway` 的 `PerksAuto`），关着时
//!    什么也不做，打开后也只在启动 / 自然日翻篇 / 夜间窗口里各补一次。
//!
//! 上游口径里几个不能改的细节：
//!
//! - 专家 / 团队事件必须用**互不相同**的 id：上游按 `(eventCode, id)` 去重，重复 id
//!   不推进度；
//! - 只认桌面端真实行为的任务（`DESKTOP_ONLY_TASKS`）伪造事件不会涨进度，诚实跳过；
//! - 夜猫子任务只在 23:00–08:00 上报才计数，每天一次、累计三天；
//! - 未接取的任务上报不计进度，所以先接取、再复核、再不成就跳过。

use std::collections::HashSet;
use std::io::Write;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::common::{civil_from_days, days_from_civil, now_millis, now_secs, redact};
use crate::http;
use crate::wb_account::Account;
use crate::wb_api_billing;
use crate::wb_credits::Credits;
use crate::wb_identity;
use crate::wb_upstream;

/// 网页端的浏览器 UA（与桌面端的三段式 UA 不同：网页通道走的是浏览器形态）。
const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
/// 国内版网页端的域。领奖在桌面端点不通时降级到那里（参考项目的实测口径）。
const CN_WEB_ORIGIN: &str = "https://www.workbuddy.cn";

const TASKS_PATH: &str = "/v2/activity/growth/tasks";
const ACCEPT_PATH: &str = "/v2/activity/growth/tasks/accept";
const ENERGY_PATH: &str = "/v2/activity/growth/energy";
const STREAK_PATH: &str = "/activity/growth/streak";
const HEATMAP_PATH: &str = "/activity/growth/heatmap";
const MAKEUP_USE_PATH: &str = "/activity/growth/makeup-cards/use";
const REDEEM_PATH: &str = "/activity/growth/redeem";
const LOTTERY_CHANCES_PATH: &str = "/v2/activity/growth/lottery/chances";
const LOTTERY_DRAW_PATH: &str = "/v2/activity/growth/lottery/draw";
const TRAVEL_STATUS_PATH: &str = "/activity/growth/buddy/travel/status";
const TRAVEL_CONFIG_PATH: &str = "/activity/growth/buddy/travel/config";
const TRAVEL_DEPART_PATH: &str = "/activity/growth/buddy/travel/depart";
const TRAVEL_CLAIM_PATH: &str = "/activity/growth/buddy/travel/claim";
const BUDDY_QUOTA_PATH: &str = "/v2/activity/growth/buddy/quota";
const BUDDY_OPEN_PATH: &str = "/v2/activity/growth/buddy/open";
const REPORT_PATH: &str = "/v2/report";
const CHECKIN_PATH: &str = "/v2/billing/meter/daily-checkin";
/// 签到状态（只读 POST）：返回今天签没签、本赛季累计天数与逐日签到记录。
const CHECKIN_STATUS_PATH: &str = "/v2/billing/meter/checkin-activity-status";
/// 夜猫子任务：只在 23:00–08:00 上报计数，每天一次、累计三天。
const NIGHT_TASK: &str = "black_cat";
const GIFT_PATH: &str = "/billing/meter/claim-gift";
const COMPENSATION_PATH: &str = "/billing/meter/claim-compensation";

/// 任务代码 → 种类 / 目标 / 奖励 / 名称。上游没给的字段从这张表兜底。
struct TaskSpec {
    kind: &'static str,
    target: i64,
    reward: i64,
    name: &'static str,
    unforgeable: bool,
    reason: &'static str,
    /// 任务指定的专家 / 团队 id 与名字。空的走通用池轮换。
    expert: Option<(&'static str, &'static str)>,
}

const fn spec(kind: &'static str, target: i64, reward: i64, name: &'static str) -> TaskSpec {
    TaskSpec {
        kind,
        target,
        reward,
        name,
        unforgeable: false,
        reason: "",
        expert: None,
    }
}

/// 带固定专家 id 的任务。上游只按事件里的真实 id 推进度，通用池轮换上报不计数。
const fn expert_spec(
    target: i64,
    reward: i64,
    name: &'static str,
    expert: (&'static str, &'static str),
) -> TaskSpec {
    TaskSpec {
        kind: "expert",
        target,
        reward,
        name,
        unforgeable: false,
        reason: "",
        expert: Some(expert),
    }
}

const TASK_SPECS: &[(&str, TaskSpec)] = &[
    ("create_canvas", spec("canvas", 1, 300, "创建设计任务")),
    ("template_5", spec("template", 5, 200, "模板创建任务")),
    ("expert_5", spec("expert", 5, 200, "使用专家助手")),
    ("Expert_team_use_3", spec("team", 3, 150, "使用专家团队")),
    ("skill_1", spec("skill", 1, 100, "体验技能")),
    ("automation_1", spec("automation", 1, 100, "创建自动化任务")),
    ("playbook_prompt", spec("playbook", 1, 100, "灵感案例使用")),
    (
        "Expert_lighthouse",
        spec("lighthouse", 1, 100, "轻量云专家使用"),
    ),
    ("Buddy_App", spec("buddy5", 1, 100, "进入 Buddy 应用")),
    ("Buddy_App_QQ", spec("buddy5", 1, 100, "企鹅教师助手")),
    ("Hp_Appearance", spec("skin", 1, 100, "应用主题外观")),
    ("chat_5", spec("chat", 5, 100, "发起 5 次对话")),
    ("Model_chat_GLM5.2", spec("glmchat", 1, 100, "体验 GLM-5.2")),
    ("black_cat", spec("cat", 3, 100, "夜猫子任务 (23:00-08:00)")),
    ("RichMeow_Chat", spec("richmeow", 1, 100, "桌面对话事件链")),
    ("Library_read", spec("library", 1, 100, "浏览资料库")),
    // 活动 / 专项任务：事件里的 id 必须是对应专家的真实 id，否则上游只收事件不涨进度。
    (
        "WorkBuddy_Valorant",
        expert_spec(1, 100, "体验「无畏契约拼豆专家」", ("ex_xQHHD1u5Jkua", "无畏契约拼豆专家")),
    ),
    (
        "workstation_expert",
        expert_spec(1, 100, "工作台搭建师", ("WorkspaceBuilder", "工作台搭建师")),
    ),
    (
        "expert_use_maidehao",
        expert_spec(1, 100, "中国电商运营专家", ("ex_GDl31WahyIH0", "中国电商运营专家")),
    ),
    (
        "expert_use_douyinyin",
        expert_spec(1, 100, "抖音策略师", ("ex_FbY5nlWTqDod", "抖音策略师")),
    ),
    (
        "expert_use_shangjia_xuanchuan",
        expert_spec(
            1,
            100,
            "商家宣传页与海报设计师",
            ("ex_Weo3x2EZuSDm", "商家宣传页与海报设计师"),
        ),
    ),
    (
        "expert_use_bowangwang",
        expert_spec(1, 100, "直播电商教练", ("ex_WZY136wV5aMt", "直播电商教练")),
    ),
    ("Sequential_Tasks_7", spec("playbook", 1, 100, "PC 灵感功能")),
    // first_buddy 是 auto 类（上游不接受接取），完成后领奖才发放 Buddy 实例；
    // 它是所有 single 任务与猫猫旅行的前置（"prerequisite not met: first_buddy"）。
    ("first_buddy", spec("chat", 1, 300, "领取一只 Buddy")),
    (
        "wb_wechat_oa_subscribe_task",
        TaskSpec {
            kind: "",
            target: 1,
            reward: 100,
            name: "关注官方公众号",
            unforgeable: true,
            reason: "需在微信关注「腾讯 WorkBuddy」公众号满 24 小时",
            expert: None,
        },
    ),
    (
        "Expert_Philanthropy",
        TaskSpec {
            kind: "",
            target: 1,
            reward: 0,
            name: "公益爱心捐赠",
            unforgeable: true,
            reason: "真实捐款动作",
            expert: None,
        },
    ),
];

/// 只认桌面端真实行为的任务：`jump_url` 都是 `workbuddy://` 深链，伪造事件会被
/// 上游忽略或落到 heartbeat。诚实地跳过，界面上仍能看到进度与深链。
const DESKTOP_ONLY_TASKS: &[(&str, &str)] = &[
    ("RichMeow_Chat", "在桌面端发起 1 次对话"),
    ("Library_read", "在桌面端打开「资料库」并读完介绍文档"),
    (
        "Buddy_App",
        "在桌面端左上角「发现应用」进入任意一个 Buddy 应用",
    ),
    ("Buddy_App_QQ", "在桌面端「发现应用」进入「企鹅教师助手」"),
];

/// 专家事件 id：每次必须不同（上游按 `(eventCode, id)` 去重）。
const EXPERT_ID_POOL: &[(&str, &str)] = &[
    ("ex_PZw8Gu81HfN4", "运维工程师"),
    ("ex_ROsDtJbzADFV", "产品经理"),
    ("ex_SMUnl0nJbPix", "UI设计师"),
    ("ex_ZTR062oVBOCW", "数据分析师"),
    ("ex_a3sSSFBy8qaC", "后端架构师"),
    ("ex_aG1kvKbq8lPx", "文案策划"),
    ("ex_al1vxtUOYQ10", "测试专家"),
    ("ex_cZfiyuET9UQP", "安全顾问"),
    ("ex_eggOvQuVP0hq", "算法工程师"),
    ("ex_hSwsQjkSKnkX", "前端工程师"),
    ("ex_mMbwwmFA9n9P", "项目管理专家"),
    ("ex_uAQE5POfk7Zh", "增长运营专家"),
    ("ex_uZzSAScSy7FZ", "行业研究员"),
    ("ex_LHywGrZOtG7G", "数据分析师"),
    ("ex_NX5C8GBciVed", "测试架构师"),
    ("ex_DdCsaoq4AtcO", "云端运维专家"),
    ("ex_KzqKQguubrNQ", "内容创作专家"),
    ("ex_2cvvUZQhDyeJ", "腾讯轻量云专家"),
];

const TEAM_ID_POOL: &[(&str, &str)] = &[
    ("CloudOpsTeam", "运维专家团队"),
    ("CloudContentTeam", "内容专家团队"),
    ("CloudDevTeam", "研发专家团队"),
    ("ProductStrategyTeam", "产品战略团队"),
    ("MarketingCampaignTeam", "营销活动团队"),
    ("SalesBattleTeam", "销售作战团队"),
    ("DesignEngineTeam", "设计引擎团队"),
    ("HrOperationsTeam", "人力运营团队"),
];

// ---------- 给界面的形状 ----------

/// 一个成长任务。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrowthTask {
    pub task_code: String,
    pub name: String,
    pub description: String,
    pub jump_url: String,
    /// 上游的 `accept_status`：`not_accepted` / `accepted` / `completed` / `claimed`…
    pub status: String,
    pub task_type: String,
    pub current: i64,
    pub target: i64,
    pub reward_credit: i64,
    pub reward_energy: i64,
    /// 无法自动化（需真实操作）
    pub unforgeable: bool,
    pub reason: String,
}

/// 猫猫旅行状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TravelState {
    /// `idle` / `traveling` / `arrived` / `unknown`
    pub state: String,
    pub daily_limit_reached: bool,
    pub reward_credit: i64,
}

/// 连续打卡、能量与猫猫旅行的汇总。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrowthSummary {
    pub energy: i64,
    pub streak_days: i64,
    /// 成长连登 7d 档还差几天（上游 `streak.next_tier_remaining`）
    pub next_tier_remaining: i64,
    pub makeup_cards: i64,
    pub lottery_chances: i64,
    pub travel: TravelState,
}

/// Buddy 加油站签到状态（计费域 `checkin-activity-status`）。
///
/// 上游 `streak_days` 是**本赛季累计签到天数**，不是当前连签；`current_streak`
/// 才是从 `checkin_dates` 里算出来的当前连续段。两个数都给界面，别混用。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckinStatus {
    pub active: bool,
    pub checked_in_today: bool,
    pub current_streak: i64,
    pub season_days: i64,
    pub week_days: i64,
    pub today_credit: i64,
    pub total_credits: i64,
    pub activity_name: String,
}

/// 一次成长任务的执行结果。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub ok: bool,
    pub logs: Vec<String>,
    pub earned_credit: i64,
    pub credits: Option<Credits>,
    pub msg: String,
}

/// 猫猫旅行的一次尝试。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TravelOutcome {
    pub ok: bool,
    /// `claim` / `depart` / `traveling` / `idle` / `skip`
    pub action: String,
    pub msg: String,
    pub credit: i64,
}

/// 成长连登与抽奖的结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreakOutcome {
    pub ok: bool,
    pub msg: String,
    pub logs: Vec<String>,
}

/// 每日签到 / 每日活跃的一次尝试。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOutcome {
    pub ok: bool,
    pub msg: String,
}

/// `activity.jsonl` 的一行。只落运维元数据：没有 token / cookie / 请求体。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    /// Unix 秒
    pub ts: i64,
    /// 本地自然日 `YYYY-MM-DD`。读「今天」不必再猜时区
    pub date: String,
    pub uid: String,
    pub nickname: String,
    /// `checkin`
    pub task: String,
    pub ok: bool,
    pub message: String,
}

// ---------- 请求与解析 ----------



fn sleep_secs(seconds: f64) {
    if seconds > 0.0 {
        std::thread::sleep(Duration::from_millis((seconds * 1000.0) as u64));
    }
}

fn data(value: &Value) -> &Value {
    value.get("data").unwrap_or(&Value::Null)
}

fn text_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn int_at(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(number_at).unwrap_or(0)
}

fn number_at(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return Some(number as i64);
    }
    value.as_f64().map(|number| number as i64)
}


/// 聊天头：与网关对话同一条构造路径，会话 id 每请求新生成。
fn chat_headers(account: &Account, model: Option<&str>) -> Vec<(String, String)> {
    let ids = wb_identity::new_ids(account.product, &account.uid, None, None, None);
    let input = wb_identity::ChatHeaders {
        identity: account.product,
        uid: &account.uid,
        token: &account.access_token,
        ids: &ids,
        enterprise_id: &account.enterprise_id,
        tenant_id: "",
        department: "",
        model,
        device_token: None,
    };
    wb_identity::chat_headers(&input)
}

fn as_refs(headers: &[(String, String)]) -> Vec<(&str, &str)> {
    headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect()
}

/// 发一个 JSON 请求并解上游信封。HTTP 非 200 一律当失败 —— 200 里也可能装错误码，
/// 由调用方按 `code` 再判一次。
fn send_json(
    _account: &Account,
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> Result<Value, String> {
    let refs = as_refs(headers);
    http::request_json(method, url, &refs, body, http::JSON_MAX_BODY, 200)
}

fn chat_get(account: &Account, path: &str) -> Result<Value, String> {
    let url = wb_upstream::chat_url(path);
    send_json(account, "GET", &url, &chat_headers(account, None), None)
}

fn chat_post(account: &Account, path: &str, body: &Value) -> Result<Value, String> {
    let url = wb_upstream::chat_url(path);
    let payload = body.to_string();
    send_json(
        account,
        "POST",
        &url,
        &chat_headers(account, None),
        Some(&payload),
    )
}

fn billing_post(account: &Account, path: &str, body: &Value) -> Result<Value, String> {
    wb_api_billing::call(account, path, body)
}

fn is_enterprise(account: &Account) -> bool {
    wb_api_billing::is_enterprise(account)
}

// ---------- 成长任务 ----------

fn spec_of(code: &str) -> Option<&'static TaskSpec> {
    TASK_SPECS
        .iter()
        .find(|(item, _)| *item == code)
        .map(|(_, spec)| spec)
}

fn task_from_json(raw: &Value) -> GrowthTask {
    let code = text_at(raw, "task_code");
    let spec = spec_of(&code);
    let progress = raw.get("progress").cloned().unwrap_or(Value::Null);
    GrowthTask {
        task_code: code.clone(),
        name: {
            let title = text_at(raw, "title");
            if !title.is_empty() {
                title
            } else if let Some(spec) = spec {
                spec.name.to_string()
            } else {
                code
            }
        },
        description: {
            let desc = text_at(raw, "description");
            if desc.is_empty() {
                text_at(raw, "task_desc")
            } else {
                desc
            }
        },
        jump_url: text_at(raw, "jump_url"),
        status: {
            let status = text_at(raw, "accept_status");
            if status.is_empty() {
                "not_accepted".to_string()
            } else {
                status
            }
        },
        task_type: text_at(raw, "task_type"),
        current: int_at(&progress, "current"),
        target: {
            let target = int_at(&progress, "target");
            if target > 0 {
                target
            } else {
                spec.map(|item| item.target).unwrap_or(1)
            }
        },
        reward_credit: {
            let reward = int_at(raw, "reward_credit");
            if reward > 0 {
                reward
            } else {
                spec.map(|item| item.reward).unwrap_or(0)
            }
        },
        reward_energy: int_at(raw, "reward_energy"),
        unforgeable: spec.map(|item| item.unforgeable).unwrap_or(false),
        reason: spec.map(|item| item.reason.to_string()).unwrap_or_default(),
    }
}

fn parse_tasks(value: &Value) -> Vec<GrowthTask> {
    data(value)
        .get("tasks")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(task_from_json).collect())
        .unwrap_or_default()
}

/// 查一次成长任务清单。
pub fn fetch_growth_tasks(account: &Account) -> Result<Vec<GrowthTask>, String> {
    if is_enterprise(account) {
        return Ok(Vec::new());
    }
    Ok(parse_tasks(&chat_get(account, TASKS_PATH)?))
}

fn tier_status(redemption: &Value, tier: &str) -> String {
    let status = text_at(redemption, &format!("tier_{tier}_status"));
    if status.is_empty() {
        "locked".to_string()
    } else {
        status
    }
}

/// 查连续打卡、补签卡、抽奖次数、能量与猫猫旅行。每一段各自吞错误：
/// 一个端点挂了不该让整块汇总消失（界面上显示 0 比空白更像事实）。
pub fn fetch_growth_summary(account: &Account) -> GrowthSummary {
    let mut summary = GrowthSummary {
        travel: TravelState {
            state: "unknown".to_string(),
            ..TravelState::default()
        },
        ..GrowthSummary::default()
    };

    if let Ok(value) = chat_get(account, ENERGY_PATH) {
        summary.energy = int_at(data(&value), "balance");
    } else {
        eprintln!("[workbench] 查询成长能量失败");
    }

    if let Ok(value) = chat_get(account, STREAK_PATH) {
        let data = data(&value);
        let streak = data.get("streak").unwrap_or(&Value::Null);
        summary.streak_days = int_at(streak, "days");
        summary.next_tier_remaining = int_at(streak, "next_tier_remaining");
        summary.makeup_cards = int_at(data.get("makeup_cards").unwrap_or(&Value::Null), "balance");
    } else {
        eprintln!("[workbench] 查询连续打卡失败");
    }

    if let Ok(value) = chat_get(account, LOTTERY_CHANCES_PATH) {
        summary.lottery_chances = int_at(data(&value), "balance");
    } else {
        eprintln!("[workbench] 查询抽奖次数失败");
    }

    if let Ok(value) = chat_get(account, TRAVEL_STATUS_PATH) {
        summary.travel = travel_from(&value);
    } else {
        eprintln!("[workbench] 查询猫猫旅行状态失败");
    }
    summary
}

/// 读 Buddy 加油站的签到状态。失败返回 None：调用方回退到本地 activity 记录。
pub fn checkin_status(account: &Account) -> Option<CheckinStatus> {
    if is_enterprise(account) {
        return None;
    }
    let value = billing_post(account, CHECKIN_STATUS_PATH, &json!({})).ok()?;
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return None;
    }
    let data = data(&value);
    let dates: Vec<String> = data
        .get("checkin_dates")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(CheckinStatus {
        active: data.get("active").and_then(Value::as_bool).unwrap_or(true),
        checked_in_today: data
            .get("today_checked_in")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        current_streak: current_checkin_streak(&dates, &local_date()),
        season_days: int_at(data, "streak_days"),
        week_days: int_at(data, "week_checkin_days"),
        today_credit: int_at(data, "today_credit"),
        total_credits: int_at(data, "total_credits"),
        activity_name: text_at(data, "activity_name"),
    })
}

/// 从服务端给的签到日期算当前连签：最近一次必须落在今天或昨天，再向前数连续自然日。
/// 上游 `streak_days` 是本赛季累计，不能直接当连签。
fn current_checkin_streak(dates: &[String], today: &str) -> i64 {
    let Some(today_days) = date_days(today) else {
        return 0;
    };
    let mut days: Vec<i64> = dates.iter().filter_map(|value| date_days(value)).collect();
    days.sort_unstable();
    days.dedup();
    let Some(&last) = days.last() else {
        return 0;
    };
    if last < today_days - 1 {
        return 0;
    }
    let mut streak = 1;
    let mut expected = last - 1;
    for &day in days.iter().rev().skip(1) {
        if day != expected {
            break;
        }
        streak += 1;
        expected -= 1;
    }
    streak
}

/// `YYYY-MM-DD` → 距 1970-01-01 的天数。格式不对返回 None，不猜。
fn date_days(value: &str) -> Option<i64> {
    let mut parts = value.trim().split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn travel_from(value: &Value) -> TravelState {
    let data = data(value);
    let state = text_at(data, "state");
    TravelState {
        state: if state.is_empty() {
            "unknown".to_string()
        } else {
            state
        },
        daily_limit_reached: data
            .get("daily_limit_reached")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reward_credit: int_at(data, "reward_credit"),
    }
}

/// 批量接取。返回实际接上的与没接上的 —— 上层要能看见「接了一堆但一个都没点亮」。
#[derive(Debug, Default)]
struct AcceptOutcome {
    accepted: Vec<String>,
    failed: Vec<String>,
    msg: String,
}

fn accept_tasks(account: &Account, codes: &[String]) -> AcceptOutcome {
    let mut outcome = AcceptOutcome::default();
    for part in codes.chunks(20) {
        let body = json!({ "task_codes": part });
        let value = match chat_post(account, ACCEPT_PATH, &body) {
            Ok(value) => value,
            Err(message) => {
                outcome.msg = message.clone();
                outcome.failed.extend(part.iter().cloned());
                eprintln!("[workbench] 接取任务失败：{message}");
                continue;
            }
        };
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code != 0 {
            outcome.msg = text_at(&value, "msg");
            outcome.failed.extend(part.iter().cloned());
            eprintln!("[workbench] 接取被拒：{}", outcome.msg);
            continue;
        }
        let mut seen: Vec<String> = Vec::new();
        for item in data(&value)
            .get("results")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let task_code = text_at(item, "task_code");
            let status = text_at(item, "status");
            seen.push(task_code.clone());
            if status == "accepted" || status == "already_accepted" {
                outcome.accepted.push(task_code);
            } else {
                let message = text_at(item, "message");
                outcome
                    .msg
                    .push_str(&format!("{task_code}: {message} ({status}); "));
                outcome.failed.push(task_code);
            }
        }
        for item in part {
            if !seen.iter().any(|code| code == item) {
                outcome.failed.push(item.clone());
            }
        }
    }
    outcome
}

#[derive(Debug, Default)]
struct ClaimOutcome {
    ok: bool,
    credit: i64,
    msg: String,
}

/// 领奖。桌面端点不通（HTTP 400）时降级到国内网页端再试一次。
fn claim_task(account: &Account, code: &str) -> ClaimOutcome {
    let path = format!("/activity/growth/tasks/{code}/claim");
    let url = wb_upstream::chat_url(&path);
    let headers = chat_headers(account, None);
    let refs = as_refs(&headers);
    match http::request_url("POST", &url, &refs, Some("{}")) {
        Ok(response) => {
            let value: Value = serde_json::from_str(&response.text()).unwrap_or(Value::Null);
            let result = value.get("code").and_then(Value::as_i64).unwrap_or(0);
            if response.status == 200 && result == 0 {
                let data = data(&value);
                return ClaimOutcome {
                    ok: true,
                    credit: int_at(data, "credit"),
                    msg: String::new(),
                };
            }
            if response.status == 400 {
                return claim_web(account, code).unwrap_or_else(|message| ClaimOutcome {
                    ok: false,
                    msg: message,
                    ..ClaimOutcome::default()
                });
            }
            ClaimOutcome {
                ok: false,
                msg: if text_at(&value, "msg").is_empty() {
                    format!("code={result}")
                } else {
                    text_at(&value, "msg")
                },
                ..ClaimOutcome::default()
            }
        }
        Err(message) => ClaimOutcome {
            ok: false,
            msg: message,
            ..ClaimOutcome::default()
        },
    }
}

/// 国内网页端的领奖。只在桌面端回 400 时走这一跳（参考项目的实测口径）。
fn claim_web(account: &Account, code: &str) -> Result<ClaimOutcome, String> {
    let url = format!("{CN_WEB_ORIGIN}/activity/growth/tasks/{code}/claim");
    let headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", account.access_token),
        ),
        (
            "Accept".to_string(),
            "application/json, text/plain, */*".to_string(),
        ),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Origin".to_string(), CN_WEB_ORIGIN.to_string()),
        (
            "Referer".to_string(),
            format!("{CN_WEB_ORIGIN}/profile/growth-center"),
        ),
        ("x-client-platform".to_string(), "web".to_string()),
        ("User-Agent".to_string(), WEB_UA.to_string()),
        ("X-User-Id".to_string(), account.uid.clone()),
        ("X-Domain".to_string(), CN_WEB_ORIGIN.to_string()),
    ];
    let value = send_json(account, "POST", &url, &headers, Some("{}"))?;
    let result = value.get("code").and_then(Value::as_i64).unwrap_or(0);
    if result == 0 {
        let data = data(&value);
        Ok(ClaimOutcome {
            ok: true,
            credit: int_at(data, "credit"),
            msg: String::new(),
        })
    } else {
        Ok(ClaimOutcome {
            ok: false,
            msg: text_at(&value, "msg"),
            ..ClaimOutcome::default()
        })
    }
}

/// 构造一个真实规范事件。`expert` 为专家 / 团队 id 与名字：上游按
/// `(eventCode, id)` 去重，重复 id 不会推进度。
fn build_event(account: &Account, kind: &str, idx: usize, expert: Option<(&str, &str)>) -> Value {
    let stamp = now_millis();
    let conversation = format!("wb-task-{stamp}-{idx}");
    let request = format!("{conversation}-req");
    let uid = &account.uid;

    match kind {
        "canvas" => json!({
            "eventCode": "wbx_design_canvas_task_create", "timestamp": stamp,
            "reportDelay": 0, "conversationId": conversation, "requestId": request,
            "source": "summon_keyword", "isCustomModel": false, "name": "",
            "inputLength": 12, "id": format!("wbx-canvas-{stamp}"), "cost": 0,
            "isSuccessful": true, "userId": uid
        }),
        "template" => json!({
            "eventCode": "agent_task_created_with_template", "timestamp": stamp,
            "reportDelay": 0, "isCustomModel": true, "id": idx.to_string(),
            "name": "幻灯片", "requestId": request, "conversationId": conversation,
            "userId": uid
        }),
        "expert" | "team" | "lighthouse" => {
            let (expert_id, name) = if let Some(pair) = expert {
                pair
            } else if kind == "lighthouse" {
                ("ex_2cvvUZQhDyeJ", "腾讯轻量云专家")
            } else if kind == "team" {
                ("CloudOpsTeam", "运维专家团队")
            } else {
                ("ContentCreator", "内容创作专家")
            };
            json!({
                "eventCode": "expert_actual_use", "timestamp": stamp, "reportDelay": 0,
                "mode": "CLOUD", "id": expert_id, "name": name, "expertTitle": name,
                "type": "02-Engineering",
                "expertType": if kind == "team" { "team" } else { "agent" },
                "source": "builtin", "version": "1.0.2", "cost": 0,
                "characterCount": 12, "conversationId": conversation,
                "requestId": request, "messageId": request,
                "requestModelId": "deepseek-v4-flash",
                "requestModelName": "DeepSeek V4 Flash", "userId": uid
            })
        }
        "skill" => json!({
            "eventCode": "skill_info", "timestamp": stamp, "reportDelay": 0,
            "skillId": "skill_2096525080079265792", "name": "pptx", "userId": uid
        }),
        "automation" => json!({
            "eventCode": "automated_task_create_suc", "timestamp": stamp, "reportDelay": 0,
            "name": "每周工作整理", "type": "cron", "source": "manually",
            "modelId": "deepseek-v4-flash", "modelIsThinking": false,
            "conversationId": conversation, "requestId": request,
            "schedule": { "type": "recurring", "rrule": "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0" },
            "prompt": "每周五自动整理本周工作", "userId": uid
        }),
        "playbook" => json!({
            "eventCode": "playbook_prompt_send", "timestamp": stamp, "reportDelay": 0,
            "id": "worker-ledger-freedom-dashboard", "name": "打工人小账本",
            "type": "other", "promptLength": 10, "isOfficial": 1,
            "source": "discover", "conversationId": conversation,
            "requestId": request, "userId": uid
        }),
        "skin" => json!({
            "eventCode": "appearance_skin_apply", "timestamp": stamp, "reportDelay": 0,
            "action": "apply", "source": "settings_close", "id": "theme-tkmw7j",
            "vipLevel": "free", "series": "craft", "type": "unknown",
            "name": "和平精英激战金秋", "userId": uid
        }),
        "chat" | "glmchat" | "cat" => {
            let (model_id, model_name) = if kind == "glmchat" || kind == "cat" {
                ("glm-5.2", "GLM-5.2")
            } else {
                ("deepseek-v4-flash", "DeepSeek V4 Flash")
            };
            json!({
                "eventCode": "chat_request_send", "timestamp": stamp, "reportDelay": 0,
                "mode": if kind == "cat" { "night" } else { "craft" },
                "conversationId": conversation, "requestId": request,
                "inputLength": 12, "requestModelId": model_id,
                "requestModelName": model_name, "isPlan": false,
                "agentName": "default", "agentType": "conversation", "userId": uid
            })
        }
        _ => json!({ "eventCode": "heartbeat", "timestamp": stamp, "userId": uid }),
    }
}

fn report_events(account: &Account, events: &[Value]) -> bool {
    let url = wb_upstream::chat_url(REPORT_PATH);
    let body = Value::Array(events.to_vec()).to_string();
    let headers = chat_headers(account, None);
    match send_json(account, "POST", &url, &headers, Some(&body)) {
        Ok(value) => value.get("code").and_then(Value::as_i64) == Some(0),
        Err(_) => false,
    }
}

/// 夜猫子任务的计分窗口：23:00–08:00（本地时间）。抽成纯函数是为了能测边界。
fn night_window(hour: i32) -> bool {
    !(8..23).contains(&hour)
}

pub(crate) fn in_night_window() -> bool {
    night_window(local_parts().3)
}

fn desktop_only_hint(code: &str) -> Option<&'static str> {
    DESKTOP_ONLY_TASKS
        .iter()
        .find(|(item, _)| *item == code)
        .map(|(_, hint)| *hint)
}

/// 从任务自带的 `jump_url` 里解专家 id。深链可能套两层：
/// `...?deeplink=workbuddy%3A%2F%2F...%3FexpertId%3Dex_xxx`，所以解完还要再解一层。
fn expert_from_jump(task: &GrowthTask) -> Option<(String, String)> {
    let direct = query_param(&task.jump_url, "expertId");
    let nested = query_param(&task.jump_url, "deeplink")
        .and_then(|inner| query_param(&inner, "expertId"));
    let id = direct.or(nested)?;
    let id = id.trim();
    if !valid_expert_id(id) {
        return None;
    }
    let name = if task.name.trim().is_empty() {
        "专家".to_string()
    } else {
        task.name.clone()
    };
    Some((id.to_string(), name))
}

/// `ex_` + 6~64 位字母数字。上游的专家 id 都是这个形状。
fn valid_expert_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("ex_") else {
        return false;
    };
    (6..=64).contains(&rest.len()) && rest.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if percent_decode(name).eq_ignore_ascii_case(key) {
            return Some(percent_decode(value));
        }
    }
    None
}

/// 只为解深链里的 query 参数：`%XX` 与 `+`，不做完整 URL 规范化。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let high = (bytes[index + 1] as char).to_digit(16);
                let low = (bytes[index + 2] as char).to_digit(16);
                if let (Some(high), Some(low)) = (high, low) {
                    out.push((high * 16 + low) as u8);
                    index += 3;
                    continue;
                }
                out.push(b'%');
                index += 1;
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

/// 推进单个任务并返回本次到账积分。auto 类不需要接取；single 类未接取时上报
/// 不计进度，跳过等接取成功。
fn progress_one(
    account: &Account,
    task: &GrowthTask,
    logs: &mut Vec<String>,
    gap: f64,
    report_limit: Option<i64>,
) -> i64 {
    let Some(spec) = spec_of(&task.task_code) else {
        return 0;
    };
    if spec.unforgeable {
        if !spec.reason.is_empty() {
            logs.push(format!(
                "⏭ 任务 [{}] 需真实操作完成：{}，跳过",
                spec.name, spec.reason
            ));
        }
        return 0;
    }
    if task.status == "claimed" {
        return 0;
    }

    // 已完成的任务先领奖 —— 用户自己也可能在桌面端做完，不能因为「只能靠真实操作」就丢奖励。
    if task.status == "completed" || task.current >= task.target {
        let result = claim_task(account, &task.task_code);
        sleep_secs(gap);
        if result.ok {
            logs.push(format!(
                "✓ 任务 [{}] 领奖成功：+{} 积分",
                spec.name, result.credit
            ));
            return result.credit;
        }
        logs.push(format!(
            "! 任务 [{}] 领奖失败：{}",
            spec.name,
            if result.msg.is_empty() {
                "未知原因"
            } else {
                &result.msg
            }
        ));
        return 0;
    }

    if let Some(hint) = desktop_only_hint(&task.task_code) {
        logs.push(format!(
            "⏭ 任务 [{}] 需真实操作完成：{hint} (深链 {})，跳过事件伪造",
            spec.name,
            if task.jump_url.is_empty() {
                "workbuddy://chat"
            } else {
                &task.jump_url
            }
        ));
        return 0;
    }

    if task.task_code == NIGHT_TASK && !in_night_window() {
        logs.push(format!(
            "🌙 任务 [{}] 仅 23:00–08:00 上报计数，当前不在窗口，跳过",
            spec.name
        ));
        return 0;
    }

    if task.status == "not_accepted" && task.task_type != "auto" {
        logs.push(format!(
            "⏭ 任务 [{}] 仍未接取，跳过（先解决接取失败）",
            spec.name
        ));
        return 0;
    }

    let need = (task.target - task.current).max(1);
    // 夜猫子每天只计一次：夜间轮传 `Some(1)`，别把剩余次数在同一晚全报掉。
    let need = report_limit.map_or(need, |limit| need.min(limit.max(1)));
    logs.push(format!("正在点亮任务 [{}]（需上报 {need} 次）…", spec.name));
    let pool = match spec.kind {
        "team" => Some(TEAM_ID_POOL),
        "expert" => Some(EXPERT_ID_POOL),
        _ => None,
    };
    // 固定专家优先；没预录入的再从任务自己的 jump_url 里解 expertId。
    let dynamic = if spec.expert.is_none() {
        expert_from_jump(task)
    } else {
        None
    };
    let mut report_ok = true;
    for index in 0..need {
        let from_pool = pool.map(|items| {
            let index = ((task.current + index) as usize) % items.len();
            items[index]
        });
        let expert = spec
            .expert
            .or_else(|| dynamic.as_ref().map(|(id, name)| (id.as_str(), name.as_str())))
            .or(from_pool);
        let event = build_event(account, spec.kind, index as usize, expert);
        if !report_events(account, &[event]) {
            report_ok = false;
        }
        if index < need - 1 {
            sleep_secs(gap);
        }
    }
    if !report_ok {
        logs.push(format!(
            "! 任务 [{}] 部分事件上报失败（上游拒绝），继续尝试领奖",
            spec.name
        ));
    }
    sleep_secs(1.5);

    // 等进度落账：通常 1~3 秒可见；只在确实在涨时多等一会儿，免得每个卡住的任务空等。
    let mut progress = task.current;
    for attempt in 0..6 {
        let fresh = fetch_growth_tasks(account)
            .unwrap_or_default()
            .into_iter()
            .find(|item| item.task_code == task.task_code);
        if let Some(item) = fresh {
            progress = item.current;
            if progress >= task.target || item.status == "completed" || item.status == "claimed" {
                break;
            }
            if progress > task.current {
                sleep_secs(2.5);
                continue;
            }
        }
        if attempt < 2 {
            sleep_secs(1.5);
        } else {
            break;
        }
    }
    if progress < task.target {
        logs.push(format!(
            "? 任务 [{}] 已上报但进度 {progress}/{} 未达成，领奖顺延到下次运行",
            spec.name, task.target
        ));
        sleep_secs(gap);
        return 0;
    }

    let result = claim_task(account, &task.task_code);
    sleep_secs(gap);
    if result.ok {
        logs.push(format!(
            "✓ 任务 [{}] 点亮并领奖成功：+{} 积分",
            spec.name, result.credit
        ));
        result.credit
    } else {
        logs.push(format!(
            "! 任务 [{}] 进度已达 {progress}/{} 但领奖失败：{}",
            spec.name,
            task.target,
            if result.msg.is_empty() {
                "未知原因"
            } else {
                &result.msg
            }
        ));
        0
    }
}

fn needs_accept(task: &GrowthTask) -> bool {
    task.status == "not_accepted" && !task.unforgeable && task.task_type != "auto"
}

/// 完整执行一轮成长任务：auto 类先点亮（first_buddy 是前置）→ 批量接取 → 逐个推进
/// → 顺手看猫猫旅行 → 刷新积分。
pub fn run_growth_tasks(account: &Account, gap: f64) -> RunOutcome {
    if is_enterprise(account) {
        return RunOutcome {
            ok: true,
            msg: "企业版账号无成长体系，跳过".into(),
            ..RunOutcome::default()
        };
    }

    let mut logs = vec![format!(
        "开始为账号 {} 运行成长任务自动化…",
        account.label()
    )];
    let mut tasks = match fetch_growth_tasks(account) {
        Ok(tasks) => tasks,
        Err(message) => {
            logs.push(format!("未能获取到任务清单：{message}"));
            return RunOutcome {
                ok: false,
                logs,
                ..RunOutcome::default()
            };
        }
    };
    if tasks.is_empty() {
        logs.push("未能获取到任务清单，请检查网络或账号状态".into());
        return RunOutcome {
            ok: false,
            logs,
            ..RunOutcome::default()
        };
    }

    let mut earned = 0;

    // 0. auto 类（first_buddy）：不接受接取，且是猫猫旅行与 single 任务的前置。
    for task in tasks.iter().filter(|item| item.task_type == "auto") {
        earned += progress_one(account, task, &mut logs, gap, None);
    }

    // 1. 批量接取 + 复核一次 + 再复核。
    let pending: Vec<String> = tasks
        .iter()
        .filter(|item| needs_accept(item))
        .map(|item| item.task_code.clone())
        .collect();
    if !pending.is_empty() {
        logs.push(format!(
            "发现 {} 个待接取任务，正在批量接取…",
            pending.len()
        ));
        let first = accept_tasks(account, &pending);
        if !first.failed.is_empty() {
            logs.push(format!(
                "! 接取未成功 {} 个：{}{}",
                first.failed.len(),
                first
                    .failed
                    .iter()
                    .take(5)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
                if first.failed.len() > 5 { " …" } else { "" }
            ));
        }
        if !first.accepted.is_empty() {
            logs.push(format!("✓ 已接取 {} 个任务", first.accepted.len()));
        }
        sleep_secs(gap);
        tasks = fetch_growth_tasks(account).unwrap_or_default();
        let still: Vec<String> = tasks
            .iter()
            .filter(|item| needs_accept(item))
            .map(|item| item.task_code.clone())
            .collect();
        if !still.is_empty() {
            logs.push(format!("仍有 {} 个未接取，重试接取一次…", still.len()));
            let retry = accept_tasks(account, &still);
            if !retry.accepted.is_empty() {
                logs.push(format!("✓ 重试接取成功 {} 个", retry.accepted.len()));
            }
            sleep_secs(gap);
            tasks = fetch_growth_tasks(account).unwrap_or_default();
        }
        if tasks.is_empty() {
            logs.push("! 接取后无法获取任务清单，本轮中止".into());
            return RunOutcome {
                ok: false,
                logs,
                earned_credit: earned,
                ..RunOutcome::default()
            };
        }
        let still_pending = tasks.iter().filter(|item| needs_accept(item)).count();
        if still_pending > 0 {
            logs.push(format!(
                "! 仍有 {still_pending} 个任务处于未接取状态，对未接取任务上报事件不会计入进度，本轮跳过这些任务"
            ));
        }
    }

    for task in tasks.iter().filter(|item| item.task_type != "auto") {
        earned += progress_one(account, task, &mut logs, gap, None);
    }

    let travel = do_cat_travel(account);
    if !travel.msg.is_empty() {
        logs.push(format!("猫猫日常：{}", travel.msg));
        if travel.credit > 0 {
            earned += travel.credit;
        }
    }
    // 领奖那条已经在 `do_cat_travel` 里顺手开过了；其余状态（旅行中 / 今日已完成）
    // 仍可能有任务攒下的能量，这里再补一次。
    if travel.action != "claim" {
        if let Some(line) = open_buddy(account) {
            logs.push(format!("Buddy 盲盒：{line}"));
        }
    }

    let credits = wb_api_billing::fetch(account).ok();
    let remain = credits.as_ref().map(|item| item.remain).unwrap_or(0.0);
    logs.push(format!(
        "🎉 全部完成！本次累计新增到账：+{earned} 积分，当前总剩余：{} 积分",
        trim_number(remain)
    ));
    RunOutcome {
        ok: true,
        logs,
        earned_credit: earned,
        credits,
        msg: String::new(),
    }
}

/// 夜间单跑一轮的结果。`attempted` 为 false 表示本轮没动上游（不在窗口 / 已领取 / 企业版）；
/// `ok` 表示这一晚的动作走通了（上报被接受或领奖成功），不是任务已累计满。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NightOutcome {
    pub attempted: bool,
    pub ok: bool,
    pub msg: String,
    pub credit: i64,
}

/// 夜猫子任务的单独一轮：只在 23:00–08:00 内推进，每晚只上报一次。
///
/// 白天那轮 `run_growth_tasks` 在窗口外会跳过它、在窗口内会顺手做掉；这个入口只服务
/// 「应用一直开着、跨到 23:00」的夜间补跑，不碰别的任务，也不碰猫猫旅行 / 盲盒。
pub fn run_night_owl(account: &Account) -> NightOutcome {
    if is_enterprise(account) {
        return NightOutcome {
            ok: true,
            msg: "企业版账号无成长体系，跳过".into(),
            ..NightOutcome::default()
        };
    }
    if !in_night_window() {
        return NightOutcome {
            msg: "不在 23:00–08:00 窗口".into(),
            ..NightOutcome::default()
        };
    }

    let tasks = match fetch_growth_tasks(account) {
        Ok(tasks) => tasks,
        Err(message) => {
            return NightOutcome {
                attempted: true,
                msg: format!("读取任务清单失败：{message}"),
                ..NightOutcome::default()
            }
        }
    };
    let Some(mut task) = tasks
        .iter()
        .find(|item| item.task_code == NIGHT_TASK)
        .cloned()
    else {
        return NightOutcome {
            msg: "任务清单里没有夜猫子任务".into(),
            ..NightOutcome::default()
        };
    };
    if task.status == "claimed" {
        return NightOutcome {
            ok: true,
            msg: "夜猫子任务已领取".into(),
            ..NightOutcome::default()
        };
    }

    // 未接取的任务上报不计进度：先单独接它，再复核一次。
    if needs_accept(&task) {
        let accepted = accept_tasks(account, &[task.task_code.clone()]);
        if !accepted.accepted.iter().any(|code| code == &task.task_code) {
            return NightOutcome {
                attempted: true,
                msg: if accepted.msg.trim().is_empty() {
                    "夜猫子任务接取失败".into()
                } else {
                    format!("夜猫子任务接取失败：{}", accepted.msg.trim_end_matches("; "))
                },
                ..NightOutcome::default()
            };
        }
        sleep_secs(1.0);
        let fresh = fetch_growth_tasks(account).unwrap_or_default();
        let Some(next) = fresh.into_iter().find(|item| item.task_code == NIGHT_TASK) else {
            return NightOutcome {
                attempted: true,
                msg: "接取后读不到夜猫子任务".into(),
                ..NightOutcome::default()
            };
        };
        task = next;
    }

    let mut logs = Vec::new();
    let credit = progress_one(account, &task, &mut logs, 1.0, Some(1));
    let ok = night_action_ok(&logs);
    NightOutcome {
        attempted: true,
        ok,
        msg: if ok {
            if credit > 0 {
                format!("夜猫子领奖 +{credit} 积分")
            } else {
                "夜猫子已上报一次".into()
            }
        } else if logs.is_empty() {
            "夜猫子任务没有可推进的步骤".into()
        } else {
            logs.join("；")
        },
        credit,
    }
}

/// 夜猫子要累计三天：前两晚只会把进度推到 1/3、2/3，日志里是 `?` 而不是 `✓`。
/// `ok` 表示「这一晚的动作走通了」（上报被接受 / 领奖成功），不是任务已完成。
fn night_action_ok(logs: &[String]) -> bool {
    let failed = logs.iter().any(|line| line.starts_with('!'));
    let progressed = logs
        .iter()
        .any(|line| line.starts_with('✓') || line.starts_with('?'));
    !failed && progressed
}

fn trim_number(value: f64) -> String {
    if (value.fract()).abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

/// 猫猫旅行：领奖 / 派出 / 报告正在路上。企业号没有成长体系。
pub fn do_cat_travel(account: &Account) -> TravelOutcome {
    if is_enterprise(account) {
        return TravelOutcome {
            ok: true,
            action: "skip".into(),
            msg: "企业版账号无成长体系，跳过".into(),
            credit: 0,
        };
    }
    let state = match chat_get(account, TRAVEL_STATUS_PATH) {
        Ok(value) => travel_from(&value),
        Err(message) => {
            return TravelOutcome {
                ok: false,
                msg: format!("查询旅行状态失败：{message}"),
                ..TravelOutcome::default()
            };
        }
    };

    match state.state.as_str() {
        "arrived" => match chat_post(account, TRAVEL_CLAIM_PATH, &json!({})) {
            Ok(value) => {
                let credit = int_at(data(&value), "reward_credit");
                let _ = wb_api_billing::fetch(account);
                // 领奖后顺手看一次成长能量：够开盲盒就开，不够就什么都不做。
                let opened = open_buddy(account);
                let suffix = opened
                    .map(|line| format!("；{line}"))
                    .unwrap_or_default();
                TravelOutcome {
                    ok: true,
                    action: "claim".into(),
                    msg: format!("旅行归来领奖成功！获得 {credit} 积分{suffix}"),
                    credit,
                }
            }
            Err(message) => TravelOutcome {
                ok: false,
                msg: format!("领奖失败：{message}"),
                ..TravelOutcome::default()
            },
        },
        "idle" => {
            if state.daily_limit_reached {
                return TravelOutcome {
                    ok: true,
                    action: "idle".into(),
                    msg: "猫猫今日已完成旅行，明日 00:00 刷新".into(),
                    credit: 0,
                };
            }
            let mut location = None;
            if let Ok(value) = chat_get(account, TRAVEL_CONFIG_PATH) {
                location = data(&value)
                    .get("locations")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(|item| item.get("id"))
                    .and_then(Value::as_i64);
            }
            let location = location.unwrap_or(1);
            let mut depart = travel_depart(account, location);
            if let Err(message) = &depart {
                if message.to_ascii_lowercase().contains("no active buddy") {
                    if ensure_buddy(account, 1.0) {
                        depart = travel_depart(account, location);
                    } else {
                        return TravelOutcome {
                            ok: false,
                            msg: "还没有 Buddy：需先完成并领取「领取一只 Buddy」任务（新建任务并发起对话）".into(),
                            ..TravelOutcome::default()
                        };
                    }
                }
            }
            match depart {
                Ok(value) => {
                    let name = data(&value)
                        .get("location")
                        .map(|item| text_at(item, "name"))
                        .unwrap_or_default();
                    TravelOutcome {
                        ok: true,
                        action: "depart".into(),
                        msg: format!("猫猫已出发前往「{name}」，预计数小时后归来！"),
                        credit: 0,
                    }
                }
                Err(message) => TravelOutcome {
                    ok: false,
                    msg: format!("派出旅行失败：{message}"),
                    ..TravelOutcome::default()
                },
            }
        }
        "traveling" => TravelOutcome {
            ok: true,
            action: "traveling".into(),
            msg: "猫猫正在旅行途中，请稍后再来查看！".into(),
            credit: 0,
        },
        other => TravelOutcome {
            ok: true,
            action: other.to_string(),
            msg: format!("当前状态：{other}"),
            credit: 0,
        },
    }
}

/// 用成长能量开 Buddy 盲盒。**只在能量够的时候动**；企业版没有成长体系。
///
/// 返回一句给日志的说明（开了几个 / 为什么失败）；没有可开的返回 `None`，
/// 这样调用方不用为「能量不足」这种正常状态写一行日志。
fn open_buddy(account: &Account) -> Option<String> {
    if is_enterprise(account) {
        return None;
    }
    let quota = match chat_get(account, BUDDY_QUOTA_PATH) {
        Ok(value) => value,
        Err(_) => return None,
    };
    if quota.get("code").and_then(Value::as_i64) != Some(0) {
        return None;
    }
    let quota = data(&quota);
    let affordable = int_at(quota, "affordable");
    if affordable <= 0 {
        return None;
    }
    // 上游一次最多开 `max_open_count` 个；它没给就按 1 个。
    let count = affordable.min(int_at(quota, "max_open_count").max(1));
    let body = json!({
        "count": count,
        "client_token": wb_identity::uuid7().to_string(),
    });
    match chat_post(account, BUDDY_OPEN_PATH, &body) {
        Ok(value) if value.get("code").and_then(Value::as_i64) == Some(0) => {
            let data = data(&value);
            let mut name = text_at(data, "buddy");
            if name.is_empty() {
                name = text_at(data, "name");
            }
            if name.is_empty() {
                Some(format!("开 Buddy 盲盒 ×{count} 成功"))
            } else {
                Some(format!("开 Buddy 盲盒 ×{count} 成功：{name}"))
            }
        }
        Ok(value) => {
            let msg = text_at(&value, "msg");
            Some(if msg.is_empty() {
                "开 Buddy 盲盒失败（上游没给原因）".to_string()
            } else {
                format!("开 Buddy 盲盒失败：{msg}")
            })
        }
        Err(message) => Some(format!("开 Buddy 盲盒失败：{message}")),
    }
}

fn travel_depart(account: &Account, location: i64) -> Result<Value, String> {
    let url = wb_upstream::chat_url(TRAVEL_DEPART_PATH);
    let body = json!({ "location_id": location }).to_string();
    let headers = chat_headers(account, None);
    let value = send_json(account, "POST", &url, &headers, Some(&body))?;
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code == 0 {
        Ok(data(&value).clone())
    } else {
        Err(text_at(&value, "msg"))
    }
}

/// 确保账号已领到 Buddy 实例：没有则完成并领取 first_buddy。
fn ensure_buddy(account: &Account, gap: f64) -> bool {
    let Ok(tasks) = fetch_growth_tasks(account) else {
        return false;
    };
    let Some(buddy) = tasks
        .iter()
        .find(|item| item.task_code == "first_buddy")
        .cloned()
    else {
        return false;
    };
    if buddy.status == "claimed" {
        return true;
    }
    progress_one(account, &buddy, &mut Vec::new(), gap, None);
    fetch_growth_tasks(account)
        .unwrap_or_default()
        .iter()
        .find(|item| item.task_code == "first_buddy")
        .map(|item| item.status == "claimed")
        .unwrap_or(false)
}

/// 每轮最多补一张：补签会改变连登天数，剩下的留给下一轮，写操作也不重试。
const MAKEUP_MAX_PER_RUN: usize = 1;

/// 补签卡余额，兼容 `{"balance":2}` 与裸数字 `2` 两种形状。
fn makeup_card_count(value: &Value) -> i64 {
    value
        .get("balance")
        .and_then(Value::as_i64)
        .or_else(|| value.as_i64())
        .unwrap_or(0)
}

/// 从服务端活跃日历里挑可补签的日期：当月、今天之前、活动上线之后、score = 0、
/// 不在 `makeup_dates` 里；最近的断点优先。`today` 用热力墙的服务端日期，避免本机时区
/// 把月初 / 午夜算错。结构不对就返回空，不拿猜测去消耗补签卡。
fn makeup_candidates(
    today: &str,
    launch: &str,
    made_up: &[String],
    cells: &[(String, i64)],
) -> Vec<String> {
    let Some(today_days) = date_days(today) else {
        return Vec::new();
    };
    let Some(launch_days) = date_days(launch) else {
        return Vec::new();
    };
    let (year, month, _) = civil_from_days(today_days);
    let start = days_from_civil(year, month, 1)
        .max(launch_days)
        .max(days_from_civil(2026, 6, 17));
    let made_up: HashSet<i64> = made_up.iter().filter_map(|value| date_days(value)).collect();
    let mut days: Vec<i64> = cells
        .iter()
        .filter(|(_, score)| *score == 0)
        .filter_map(|(date, _)| date_days(date))
        .filter(|day| *day >= start && *day < today_days && !made_up.contains(day))
        .collect();
    days.sort_unstable();
    days.dedup();
    days.into_iter()
        .rev()
        .map(|day| {
            let (year, month, day) = civil_from_days(day);
            format!("{year:04}-{month:02}-{day:02}")
        })
        .collect()
}

/// 成长连登：补签保连登 → 礼包 / 补偿 → 7d/14d/28d 档位兑换 → 抽奖。
/// 未解锁 / 已领 / 无次数 / 企业版一律安全跳过。
pub fn run_streak_bonus(account: &Account) -> StreakOutcome {
    if !account.enterprise_id.trim().is_empty() {
        return StreakOutcome {
            ok: true,
            msg: "企业版账号无成长体系，跳过".into(),
            ..StreakOutcome::default()
        };
    }

    let mut logs: Vec<String> = Vec::new();

    // 0. 断登补签：从活跃日历里挑最近的断点，每轮最多一张。
    //    上游 streak_days 是赛季累计；真正能补的是当月、今天之前、score = 0 且不在
    //    makeup_dates 里的日期。先查 streak：没有补签卡就不必再拉热力墙。
    match chat_get(account, STREAK_PATH) {
        Ok(streak) => {
            let streak_data = data(&streak);
            let cards = makeup_card_count(streak_data.get("makeup_cards").unwrap_or(&Value::Null));
            if cards > 0 {
                match chat_get(account, HEATMAP_PATH) {
                    Ok(heatmap) => {
                        let heatmap_data = data(&heatmap);
                        let today =
                            text_at(heatmap_data.get("today").unwrap_or(&Value::Null), "date");
                        let launch = text_at(streak_data, "launch_date");
                        let made_up: Vec<String> = streak_data
                            .get("streak")
                            .and_then(|item| item.get("makeup_dates"))
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let cells: Vec<(String, i64)> = heatmap_data
                            .get("cells")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .map(|cell| (text_at(cell, "date"), int_at(cell, "score")))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let dates = makeup_candidates(&today, &launch, &made_up, &cells);
                        for target in dates.iter().take(MAKEUP_MAX_PER_RUN) {
                            match chat_post(
                                account,
                                MAKEUP_USE_PATH,
                                &json!({ "target_date": target }),
                            ) {
                                Ok(value)
                                    if value.get("code").and_then(Value::as_i64) == Some(0) =>
                                {
                                    logs.push(format!("已消耗 1 张补签卡补签 {target}"));
                                }
                                Ok(value) => {
                                    let message = text_at(&value, "msg");
                                    if message.contains("date is not broken") {
                                        logs.push(format!("{target} 已活跃或已补登，无需补签"));
                                    } else {
                                        logs.push(format!(
                                            "补签 {target} 失败：{}",
                                            if message.is_empty() {
                                                "上游拒绝"
                                            } else {
                                                &message
                                            }
                                        ));
                                    }
                                }
                                Err(message) => logs.push(format!("补签 {target} 失败：{message}")),
                            }
                        }
                    }
                    Err(message) => {
                        logs.push(format!("查询补签热力图失败：{message}"));
                    }
                }
            }
        }
        Err(message) => logs.push(format!("查询连登状态失败：{message}")),
    }

    // 1. 新手礼包 / 活动补偿（每号一次，无则业务错误静默）
    for (path, name) in [(GIFT_PATH, "新手礼包"), (COMPENSATION_PATH, "活动补偿")] {
        if let Ok(value) = billing_post(account, path, &json!({})) {
            if value.get("code").and_then(Value::as_i64) == Some(0) {
                let credit = int_at(data(&value), "credit");
                logs.push(format!("领取{name} +{credit}积分"));
            }
        }
    }

    // 2. 连登档位兑换
    if let Ok(value) = chat_get(account, STREAK_PATH) {
        let redemption = data(&value)
            .get("redemption_status")
            .cloned()
            .unwrap_or(Value::Null);
        for tier in redemption
            .get("tiers")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let name = text_at(tier, "tier");
            let status = tier_status(&redemption, &name);
            if status == "locked" || status == "claimed" {
                continue;
            }
            let body = json!({
                "tier": name,
                "client_token": uuid::Uuid::new_v4().to_string()
            });
            if chat_post(account, REDEEM_PATH, &body).is_ok() {
                logs.push(format!("成功兑换连登 {name} 档位"));
            }
        }
    }

    // 3. 抽奖：有次数就抽完
    let mut drawn = 0;
    if let Ok(value) = chat_get(account, LOTTERY_CHANCES_PATH) {
        let chances = int_at(data(&value), "balance").max(0);
        for _ in 0..chances {
            let body = json!({ "client_token": uuid::Uuid::new_v4().to_string() });
            if chat_post(account, LOTTERY_DRAW_PATH, &body).is_ok() {
                drawn += 1;
            } else {
                break;
            }
            sleep_secs(1.0);
        }
        if drawn > 0 {
            logs.push(format!("完成成长抽奖 {drawn} 次"));
        }
    }

    let msg = if logs.is_empty() {
        "连登状态正常（无需兑换 / 无抽奖次数）".to_string()
    } else {
        logs.join("；")
    };
    StreakOutcome {
        ok: true,
        msg,
        logs,
    }
}

/// 签到回执的四档。`10001` 不是「已签到」专属码：活动补偿、重复操作都用它；
/// 只有文案明确说「已签到」才算 `Already`，否则记失败。
#[derive(Debug, Clone, Copy, PartialEq)]
enum CheckinState {
    Checked,
    Already,
    Pending,
    Failed,
}

const CHECKIN_PENDING_HINTS: [&str; 4] = ["处理中", "请勿重复操作", "系统繁忙", "稍后再试"];
const CHECKIN_ALREADY_HINTS: [&str; 1] = ["已签到"];
const CHECKIN_FAILURE_HINTS: [&str; 1] = ["失败"];

fn checkin_state(code: i64, msg: &str) -> CheckinState {
    if CHECKIN_PENDING_HINTS.iter().any(|hint| msg.contains(hint)) {
        return CheckinState::Pending;
    }
    if code == 0 {
        return if CHECKIN_FAILURE_HINTS.iter().any(|hint| msg.contains(hint)) {
            CheckinState::Failed
        } else {
            CheckinState::Checked
        };
    }
    if code == 10001 {
        return if CHECKIN_ALREADY_HINTS.iter().any(|hint| msg.contains(hint)) {
            CheckinState::Already
        } else {
            CheckinState::Failed
        };
    }
    CheckinState::Failed
}

/// 每日签到（Buddy 加油站）。只有「真签成」与「今天已签到」算成功；
/// 「请求处理中」这类明确没签成的回执不能记成功。
pub fn checkin(account: &Account) -> ActivityOutcome {
    if is_enterprise(account) {
        return ActivityOutcome {
            ok: false,
            msg: "企业版账号不支持签到".into(),
        };
    }

    let url = wb_upstream::billing_url(CHECKIN_PATH);
    let headers = wb_api_billing::headers(account);
    let refs = as_refs(&headers);
    let outcome = match http::request_url("POST", &url, &refs, Some("{}")) {
        Ok(response) => {
            let value: Value = serde_json::from_str(&response.text()).unwrap_or(Value::Null);
            let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
            let msg = text_at(&value, "msg");
            let state = checkin_state(code, &msg);
            let ok = match state {
                CheckinState::Checked => response.status == 200,
                CheckinState::Already => response.status == 200 || response.status == 400,
                CheckinState::Pending | CheckinState::Failed => false,
            };
            if ok {
                ActivityOutcome {
                    ok: true,
                    msg: if msg.is_empty() {
                        if state == CheckinState::Already {
                            "今天已签到".into()
                        } else {
                            "签到成功".into()
                        }
                    } else {
                        msg
                    },
                }
            } else {
                ActivityOutcome {
                    ok: false,
                    msg: if msg.is_empty() {
                        format!("HTTP {} code={code}", response.status)
                    } else {
                        msg
                    },
                }
            }
        }
        Err(message) => ActivityOutcome {
            ok: false,
            msg: message,
        },
    };
    record_activity(
        account,
        "checkin",
        outcome.ok,
        if outcome.ok {
            "签到成功"
        } else {
            &outcome.msg
        },
    );
    outcome
}

// ---------- 活动记录 ----------

/// 一行尝试。返回是否写成功；**写失败绝不影响签到本身**。
pub fn record_activity(account: &Account, task: &str, ok: bool, message: &str) {
    let row = ActivityRow {
        ts: now_secs(),
        date: local_date(),
        uid: account.uid.clone(),
        nickname: account.label(),
        task: task.to_string(),
        ok,
        message: redact(message),
    };
    let path = crate::paths::gateway_activity_file();
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!("[workbench] 建活动记录目录失败：{err}");
            return;
        }
    }
    let line = match serde_json::to_string(&row) {
        Ok(line) => line,
        Err(err) => {
            eprintln!("[workbench] 序列化活动记录失败：{err}");
            return;
        }
    };
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(err) = written {
        eprintln!("[workbench] 写活动记录失败：{err}");
        return;
    }
    compact_activity(&path);
}

/// 读今天的全部尝试（按写入顺序；坏行跳过）。
pub fn read_today() -> Vec<ActivityRow> {
    let path = crate::paths::gateway_activity_file();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let today = local_date();
    text.lines()
        .filter_map(|line| serde_json::from_str::<ActivityRow>(line).ok())
        .filter(|row| row.date == today)
        .collect()
}

/// 文件超过 1 MiB 时只留最近 2000 行。签到 / 活跃一天就几行，这个阀门只防
/// 「哪个环节把文件写爆」；整理失败就保持原样。
fn compact_activity(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < 1_048_576 {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let lines: Vec<&str> = text.lines().collect();
    let keep = lines
        .get(lines.len().saturating_sub(2000)..)
        .unwrap_or(&lines)
        .join("\n");
    let _ = crate::fs_util::write_atomic(path, format!("{keep}\n").as_bytes());
}

/// 本地时间：`(year, month, day, hour)`。走系统自己的 `GetLocalTime`，不引日期 crate。
fn local_parts() -> (i32, i32, i32, i32) {
    let mut now: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut now) };
    (
        now.wYear as i32,
        now.wMonth as i32,
        now.wDay as i32,
        now.wHour as i32,
    )
}

pub(crate) fn local_date() -> String {
    let (year, month, day, _) = local_parts();
    format!("{year:04}-{month:02}-{day:02}")
}

/// 本地自然日偏移（`offset` 为天数）。用公历天数换算，跨月 / 跨年都对。
/// 目前只有日期形状的测试在用（补签已改成按服务端日历选日期）。
#[cfg(test)]
fn local_date_offset(offset: i64) -> String {
    let (year, month, day, _) = local_parts();
    let days = days_from_civil(year as i64, month as i64, day as i64) + offset;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_account() -> Account {
        Account {
            uid: "u-1".into(),
            nickname: "小明".into(),
            domain: String::new(),
            product: wb_identity::Identity::Workbuddy,
            enterprise_id: String::new(),
            access_token: "tok".into(),
            refresh_token: String::new(),
            expires_at: 0,
            added_at: 0,
            source: "oauth".into(),
            enabled: true,
            weight: 1,
            credit_expires_at: 0,
            note: String::new(),
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        }
    }

    #[test]
    fn 任务解析用上游字段并回落到规格表() {
        let value = json!({
            "data": { "tasks": [
                {
                    "task_code": "chat_5",
                    "accept_status": "accepted",
                    "task_type": "single",
                    "progress": { "current": 2 },
                    "description": "发起对话"
                },
                {
                    "task_code": "wb_wechat_oa_subscribe_task",
                    "accept_status": "not_accepted"
                }
            ]}
        });
        let tasks = parse_tasks(&value);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].name, "发起 5 次对话");
        assert_eq!(tasks[0].target, 5);
        assert_eq!(tasks[0].reward_credit, 100);
        assert_eq!(tasks[0].current, 2);
        assert!(!tasks[0].unforgeable);
        assert!(tasks[1].unforgeable);
        assert!(tasks[1].reason.contains("公众号"));
    }

    #[test]
    fn 猫猫旅行的状态按上游字段收敛() {
        let state = travel_from(&json!({
            "data": { "state": "traveling", "daily_limit_reached": false }
        }));
        assert_eq!(state.state, "traveling");
        assert!(!state.daily_limit_reached);

        let empty = travel_from(&json!({ "data": {} }));
        assert_eq!(empty.state, "unknown");
    }

    #[test]
    fn 夜猫子窗口跨午夜() {
        // 23:00–07:59 计数；08:00 与 22:59 各自在窗口外
        assert!(night_window(23));
        assert!(night_window(0));
        assert!(night_window(7));
        assert!(!night_window(8));
        assert!(!night_window(22));
    }

    #[test]
    fn 签到连签从服务端日期算当前连续段() {
        let dates: Vec<String> = [
            "2026-11-02",
            "2026-11-03",
            "2026-11-04",
            "2026-11-05",
            "2026-11-06",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        assert_eq!(current_checkin_streak(&dates, "2026-11-06"), 5);
        assert_eq!(
            current_checkin_streak(&dates, "2026-11-07"),
            5,
            "今天还没签时，连签停在昨天"
        );
        assert_eq!(
            current_checkin_streak(&dates, "2026-11-08"),
            0,
            "最近一次早于昨天，连签已断"
        );

        // 赛季累计不是连签：中间断一天只数最近一段
        let broken: Vec<String> = [
            "2026-10-20",
            "2026-10-21",
            "2026-11-04",
            "2026-11-05",
            "2026-11-06",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        assert_eq!(current_checkin_streak(&broken, "2026-11-06"), 3);
    }

    #[test]
    fn 补签只选当月今天之前且没补过的断点() {
        let cells: Vec<(String, i64)> = [
            ("2026-10-20", 0),
            ("2026-10-31", 0),
            ("2026-11-02", 0),
            ("2026-11-03", 0),
            ("2026-11-04", 40),
            ("2026-11-05", 0),
            ("2026-11-06", 0),
        ]
        .iter()
        .map(|(date, score)| (date.to_string(), *score))
        .collect();
        let made_up = vec!["2026-11-05".to_string()];
        assert_eq!(
            makeup_candidates("2026-11-06", "2026-06-17", &made_up, &cells),
            vec!["2026-11-03".to_string(), "2026-11-02".to_string()]
        );
        // 活动上线之前的日期不补
        assert!(makeup_candidates("2026-11-06", "2026-11-03", &[], &cells)
            .iter()
            .all(|date| date.as_str() >= "2026-11-03"));
    }

    #[test]
    fn 夜猫子夜间轮以走通为准不是以累计满为准() {
        assert!(night_action_ok(&[
            "正在点亮任务".into(),
            "? 任务已上报但进度 1/3 未达成，领奖顺延到下次运行".into(),
        ]));
        assert!(night_action_ok(&["✓ 任务领奖成功".into()]));
        assert!(!night_action_ok(&[
            "! 部分事件上报失败（上游拒绝）".into(),
            "? 任务已上报但进度 0/3 未达成".into(),
        ]));
        assert!(!night_action_ok(&[]));
    }

    #[test]
    fn 事件里的专家_id_随下标轮换() {
        let account = sample_account();
        let first = build_event(&account, "expert", 0, Some(EXPERT_ID_POOL[0]));
        let second = build_event(&account, "expert", 1, Some(EXPERT_ID_POOL[1]));
        assert_eq!(first["eventCode"], "expert_actual_use");
        assert_eq!(first["expertType"], "agent");
        assert_ne!(first["id"], second["id"]);

        let team = build_event(&account, "team", 0, Some(TEAM_ID_POOL[0]));
        assert_eq!(team["expertType"], "team");
    }

    #[test]
    fn 夜猫子事件带夜间模式与_glm_模型() {
        let account = sample_account();
        let event = build_event(&account, "cat", 0, None);
        assert_eq!(event["mode"], "night");
        assert_eq!(event["requestModelId"], "glm-5.2");
        assert_eq!(event["userId"], "u-1");
    }

    #[test]
    fn 未接取任务不推进度() {
        let account = sample_account();
        let task = GrowthTask {
            task_code: "chat_5".into(),
            name: "发起 5 次对话".into(),
            description: String::new(),
            jump_url: String::new(),
            status: "not_accepted".into(),
            task_type: "single".into(),
            current: 0,
            target: 5,
            reward_credit: 100,
            reward_energy: 0,
            unforgeable: false,
            reason: String::new(),
        };
        let mut logs = Vec::new();
        // 只走到「仍未接取」那一支就会返回，不会发请求
        let earned = progress_one(&account, &task, &mut logs, 0.0, None);
        assert_eq!(earned, 0);
        assert!(logs.iter().any(|line| line.contains("仍未接取")));
    }

    #[test]
    fn 无法自动化的任务跳过并给出原因() {
        let account = sample_account();
        let task = GrowthTask {
            task_code: "Expert_Philanthropy".into(),
            name: "公益爱心捐赠".into(),
            description: String::new(),
            jump_url: String::new(),
            status: "accepted".into(),
            task_type: "single".into(),
            current: 0,
            target: 1,
            reward_credit: 0,
            reward_energy: 0,
            unforgeable: true,
            reason: "真实捐款动作".into(),
        };
        let mut logs = Vec::new();
        assert_eq!(progress_one(&account, &task, &mut logs, 0.0, None), 0);
        assert!(logs[0].contains("真实捐款动作"));
    }

    #[test]
    fn 活动记录里的消息会被截断与打码() {
        let message = redact(&format!("失败: Bearer abcdefghijklmnop {}", "a".repeat(48)));
        assert!(message.contains("Bearer [redacted]"));
        assert!(!message.contains(&"a".repeat(48)));
        assert!(message.chars().count() <= 201);
    }

    #[test]
    fn 公历天数往返一致() {
        for days in [-10_000, -1, 0, 1, 19_000, 30_000] {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
        // 2026-10-21 的前一天跨月
        let october = days_from_civil(2026, 10, 1);
        assert_eq!(civil_from_days(october - 1), (2026, 9, 30));
    }

    #[test]
    fn 本地日期形状固定() {
        let date = local_date();
        assert_eq!(date.len(), 10);
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[7..8], "-");
        let yesterday = local_date_offset(-1);
        assert_eq!(yesterday.len(), 10);
        assert_ne!(yesterday, date);
    }

    #[test]
    fn 新增专家任务带固定_expert_id() {
        assert_eq!(
            spec_of("expert_use_douyinyin").and_then(|spec| spec.expert),
            Some(("ex_FbY5nlWTqDod", "抖音策略师"))
        );
        assert_eq!(
            spec_of("workstation_expert").and_then(|spec| spec.expert),
            Some(("WorkspaceBuilder", "工作台搭建师"))
        );
        assert!(spec_of("Sequential_Tasks_7").is_some());
    }

    #[test]
    fn 从_jump_url_的_deeplink_里解专家_id() {
        let task = GrowthTask {
            task_code: "some_new_expert".into(),
            name: "新专家任务".into(),
            description: String::new(),
            jump_url:
                "workbuddy://chat?deeplink=workbuddy%3A%2F%2Fexpert%3FexpertId%3Dex_Abc12345"
                    .into(),
            status: "accepted".into(),
            task_type: "single".into(),
            current: 0,
            target: 1,
            reward_credit: 100,
            reward_energy: 0,
            unforgeable: false,
            reason: String::new(),
        };
        let (id, name) = expert_from_jump(&task).unwrap();
        assert_eq!(id, "ex_Abc12345");
        assert_eq!(name, "新专家任务");
    }

    #[test]
    fn 非法专家_id_不被采纳() {
        let task = GrowthTask {
            task_code: "some_new_expert".into(),
            name: String::new(),
            description: String::new(),
            jump_url: "workbuddy://chat?expertId=../evil".into(),
            status: "accepted".into(),
            task_type: "single".into(),
            current: 0,
            target: 1,
            reward_credit: 100,
            reward_energy: 0,
            unforgeable: false,
            reason: String::new(),
        };
        assert!(expert_from_jump(&task).is_none());
    }

    #[test]
    fn 签到回执按文案分档() {
        assert_eq!(
            checkin_state(10001, "请求处理中，请勿重复操作"),
            CheckinState::Pending
        );
        assert_eq!(checkin_state(10001, "今天已签到"), CheckinState::Already);
        assert_eq!(checkin_state(10001, "未知错误"), CheckinState::Failed);
        assert_eq!(
            checkin_state(0, "签到失败，已签到天数不足 7 天"),
            CheckinState::Failed
        );
        assert_eq!(checkin_state(0, "签到成功"), CheckinState::Checked);
    }
}