//! 网关的生命周期与状态。
//!
//! 一处拥有、多处借用：账号列表与监听句柄都在 [`Inner`] 里，路由处理函数通过
//! `Arc<Mutex<Inner>>` 借用。**没有模块级全局变量** —— 原项目那套 `POOL` / `SCHEDULER`
//! 让"这块状态到底被谁改"变成一件要靠读全仓库才能回答的事。
//!
//! 前端只通过本文件的几个函数与命令交互；开关、端口、状态全在这里收口。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::wb_account::{self, Account};
use crate::wb_api_auth::{self, LoginStart, PollOutcome};
use crate::wb_credits::Credits;
use crate::wb_server::{self, Server};

/// 持久化配置。字段少，所以直接读写文件（不必上 `JsonStore` 的防抖那一套 ——
/// 这里没有高频写入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 下次启动后自动把网关拉起来
    #[serde(default)]
    pub auto_start: bool,
    pub port: u16,
    /// 访问密钥。第三方客户端大多要填一个非空的 key 才肯保存配置；
    /// 同时它也是"别的本机程序别乱调"的一道闸。首次启动时自动生成。
    #[serde(default)]
    pub api_key: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            auto_start: false,
            port: DEFAULT_PORT,
            api_key: String::new(),
        }
    }
}

/// 默认端口。避开原项目的 8788（用户可能两个都装）。
pub const DEFAULT_PORT: u16 = 17878;

/// 网关的可变状态。
#[derive(Default)]
struct Inner {
    server: Option<Server>,
    /// 从磁盘载入的账号。第一次用到时载入，之后由命令与对话路径共同维护
    accounts: Vec<Account>,
    loaded: bool,
    /// 进行中的登录：state → 发起时刻。十分钟不用就回收
    logins: HashMap<String, LoginSession>,
    /// 生效中的访问密钥（启动时从配置里取，没有就现生成）
    api_key: String,
}

struct LoginSession {
    created: i64,
}

/// 登录窗口的有效期。用户"开了浏览器就走开"是常事，过期就让他重来，
/// 别把一个 state 无限留在内存里。
const LOGIN_TTL_SECS: i64 = 600;



/// Tauri managed state。Clone 只是为了把它交给监听线程，成本是一次 `Arc` 克隆。
#[derive(Default, Clone)]
pub struct Gateway {
    inner: Arc<Mutex<Inner>>,
}

impl Gateway {
    /// 启动监听。已经在跑就直接返回当前端口（幂等）。
    pub fn start(&self, port: u16) -> Result<u16, String> {
        let mut inner = self.lock()?;
        if let Some(server) = inner.server.as_ref() {
            return Ok(server.port());
        }
        inner.ensure_loaded();

        // 首次启动生成密钥：客户端要它，也挡住本机其它程序随手调
        if inner.api_key.is_empty() {
            let mut config = load_config();
            if config.api_key.trim().is_empty() {
                config.api_key = new_key();
                save_config(&config)?;
            }
            inner.api_key = config.api_key;
        }

        // 处理函数要一个 'static 的东西，所以把共享状态克隆进去，而不是借用 self
        let shared = Arc::clone(&self.inner);
        let handler: wb_server::Handler = Arc::new(move |request: &wb_server::Request| {
            // 锁在单次请求内持有：对话请求可能续期账号，必须拿可变借用。
            // 锁冲突的代价只是并发请求排队 —— 本机客户端不会把这里压满。
            let mut inner = match shared.lock() {
                Ok(inner) => inner,
                Err(poisoned) => poisoned.into_inner(),
            };
            // 先把 key 拷出来：`&mut inner.accounts` 与 `&inner.api_key` 同时借不行
            let key = inner.api_key.clone();
            crate::wb_router::route(request, &mut inner.accounts, &key)
        });

        let server = Server::start(port, handler)?;
        inner.server = Some(server);
        Ok(port)
    }

    /// 停止监听。没在跑就什么都不做。
    pub fn stop(&self) -> Result<(), String> {
        let mut inner = self.lock()?;
        if let Some(mut server) = inner.server.take() {
            server.stop();
        }
        Ok(())
    }

    /// 当前状态。界面拿它渲染开关与地址。
    pub fn status(&self) -> Result<Status, String> {
        let mut inner = self.lock()?;
        inner.ensure_loaded();
        let ready = inner.accounts.iter().filter(|item| item.is_ready()).count();
        Ok(Status {
            running: inner.server.is_some(),
            port: inner
                .server
                .as_ref()
                .map(Server::port)
                .unwrap_or_else(|| load_config().port),
            base_url: inner
                .server
                .as_ref()
                .map(|server| wb_server::api_base(server.port())),
            accounts: inner.accounts.len(),
            ready,
        })
    }

    /// 账号快照（不含 token —— 界面不需要，也不该拿得到）。
    pub fn accounts(&self) -> Result<Vec<AccountView>, String> {
        let mut inner = self.lock()?;
        inner.ensure_loaded();
        Ok(inner
            .accounts
            .iter()
            .map(view_of)
            .collect())
    }

    /// 重新从磁盘载入账号（登录完成、导入之后调用）。
    pub fn reload(&self) -> Result<(), String> {
        let mut inner = self.lock()?;
        inner.accounts = wb_account::load_all(&crate::paths::gateway_accounts_dir());
        inner.loaded = true;
        Ok(())
    }

    /// 接入信息：地址、密钥、模型清单。界面直接展示这一块。
    pub fn access(&self) -> Result<Access, String> {
        let inner = self.lock()?;
        let config = load_config();
        let key = if inner.api_key.is_empty() {
            config.api_key.clone()
        } else {
            inner.api_key.clone()
        };
        Ok(Access {
            base_url: wb_server::api_base(
                inner
                    .server
                    .as_ref()
                    .map(Server::port)
                    .unwrap_or(config.port),
            ),
            api_key: key,
            models: model_views().into_iter().map(|item| item.id).collect(),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "网关状态被上一次失败污染了，重启应用即可".to_string())
    }
}

impl Inner {
    /// 换掉或加入一个账号（登录完成后调用）。
    fn upsert(&mut self, account: Account) {
        match self.accounts.iter_mut().find(|item| item.uid == account.uid) {
            Some(existing) => *existing = account,
            None => self.accounts.push(account),
        }
        self.loaded = true;
    }

    /// 回收过期的登录会话。
    fn prune_logins(&mut self) {
        let now = now_secs();
        self.logins
            .retain(|_, session| now - session.created <= LOGIN_TTL_SECS);
    }

    fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.accounts = wb_account::load_all(&crate::paths::gateway_accounts_dir());
        self.loaded = true;
    }
}

/// 给界面的状态。字段都是"能直接渲染"的东西。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub accounts: usize,
    pub ready: usize,
}

/// 清单里的一行模型：id 加上价表查出来的单价（每百万 token，人民币）。
///
/// 单价**在这一层算**：价表是按前缀匹配的（`glm-5.2` 要能命中客户端传来的 `glm-5.2-0930`），
/// 那套规则只该有 `wb_pricing` 一份。界面拿到 `None` 就显示「未定价」，不自己猜一个 0。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    /// 上游给的名字。缓存里没有（种子清单那几条）就是空串
    pub name: String,
    /// 消费倍率原文（`0.29x`）。只用于显示，不参与计价
    pub rate: String,
    pub context: i64,
    pub max_output: i64,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    pub efforts: Vec<String>,
    pub default_effort: String,
    pub input_cny: Option<f64>,
    pub output_cny: Option<f64>,
}

impl ModelView {
    fn of(entry: &crate::wb_models::ModelEntry) -> Self {
        let price = crate::wb_pricing::price_of(&entry.id);
        Self {
            id: entry.id.clone(),
            name: entry.name.clone(),
            rate: entry.rate.clone(),
            context: entry.context,
            max_output: entry.max_output,
            supports_vision: entry.supports_vision,
            supports_tools: entry.supports_tools,
            supports_reasoning: entry.supports_reasoning,
            efforts: entry.efforts.clone(),
            default_effort: entry.default_effort.clone(),
            input_cny: price.map(|p| p.input_cny),
            output_cny: price.map(|p| p.output_cny),
        }
    }

}

/// 网关能转发的模型，带单价。读的是 `models.json` —— 用户点「重新获取」时拉下来的那一份。
///
/// **没拉过就是空表**：种子那四条只是 `/v1/models` 首启时的兜底（见 `wb_relay::models`），
/// 不该当成真实目录摆进界面。界面见到空表会显示「点右上角重新获取」。
pub fn model_views() -> Vec<ModelView> {
    crate::wb_models::cached().iter().map(ModelView::of).collect()
}

/// 接入信息：第三方客户端要填的那三样。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub base_url: String,
    /// 明文密钥。本机自用，界面需要能复制出来
    pub api_key: String,
    pub models: Vec<String>,
}

/// 给界面的账号行。**不含 token**。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub uid: String,
    pub label: String,
    pub product: String,
    pub enterprise: bool,
    pub enabled: bool,
    pub ready: bool,
    pub needs_refresh: bool,
    /// 选号优先级（账号文件里的 `weight`，数大的先用）
    pub priority: u8,
    /// 额度标记是否还在生效（生效时这个号不会被选中）
    pub quota_exhausted: bool,
    /// 额度预计恢复的时刻（Unix 秒）。没标记是 `None`
    pub quota_resets_at: Option<i64>,
    /// 按模型记的额度用完标记（上游 code 6004）：只挡列表里这些模型
    pub model_quotas: Vec<ModelQuotaView>,
    pub note: String,
}

/// 账号行上的一个「这个模型额度用完」标记。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelQuotaView {
    pub model: String,
    /// 预计恢复的时刻（Unix 秒）
    pub resets_at: i64,
}

// ---------- 登录 ----------

/// 发起登录。返回授权链接，界面拿去开浏览器，state 留在内存里等轮询。
#[tauri::command(async)]
pub fn wb_gateway_login_start(
    state: tauri::State<'_, Gateway>,
) -> Result<LoginStart, String> {
    let start = wb_api_auth::start_login()?;
    let mut inner = state.lock()?;
    inner.prune_logins();
    inner.logins.insert(
        start.state.clone(),
        LoginSession {
            created: now_secs(),
        },
    );
    Ok(start)
}

/// 轮询登录。用户没点完时回 `{done:false}` —— 这不是错误。
#[tauri::command(async)]
pub fn wb_gateway_login_poll(
    state: tauri::State<'_, Gateway>,
    login_state: String,
) -> Result<LoginPoll, String> {
    {
        let inner = state.lock()?;
        if !inner.logins.contains_key(login_state.trim()) {
            return Err("这个登录已过期或不存在，请重新发起".into());
        }
    }

    match wb_api_auth::poll_login(&login_state)? {
        PollOutcome::Pending(message) => Ok(LoginPoll {
            done: false,
            message,
            account: None,
        }),
        PollOutcome::Ready(account) => {
            let view = view_of(&account);
            let mut inner = state.lock()?;
            inner.logins.remove(login_state.trim());
            inner.upsert(*account);
            Ok(LoginPoll {
                done: true,
                message: "登录完成".into(),
                account: Some(view),
            })
        }
    }
}

/// 轮询结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    pub done: bool,
    pub message: String,
    pub account: Option<AccountView>,
}

// ---------- 账号操作 ----------

/// 查一次余额。会顺带续期（token 快过期时），并把续期后的 token 落盘。
///
/// **网络请求不占着状态锁**：界面的「刷新积分」是对着每个号各发一次，
/// 握着锁去等 HTTP 等于把并发按回串行 —— 第二个号要等第一个号返回才轮到。
/// 所以这里只在一头一尾拿锁：先取一份账号快照，查完（连同续期）再写回。
#[tauri::command(async)]
pub fn wb_gateway_credits(
    state: tauri::State<'_, Gateway>,
    uid: String,
) -> Result<Credits, String> {
    let mut account = {
        let mut inner = state.lock()?;
        inner.ensure_loaded();
        inner
            .accounts
            .iter()
            .find(|item| item.uid == uid)
            .cloned()
            .ok_or_else(|| format!("没有这个账号：{uid}"))?
    };

    let renewed = account.needs_refresh();
    if renewed {
        wb_api_auth::refresh(&mut account)?;
    }
    let credits = crate::wb_api_billing::fetch(&account)?;

    // 余额是额度标记的第二个来源（第一个是对话失败时的错误正文）：
    // 上游明确说「一分不剩」就打标记；查到还有余额就把旧标记（可能是 24 小时兜底）清掉。
    let now = now_secs();
    let mut quota_changed = false;
    if credits.size > 0.0 && credits.remain <= 0.0 {
        let resets = crate::wb_quota::recovery_at(now, Some(&credits));
        if !account.quota_blocked(now) || account.quota_until() != resets {
            account.mark_quota_exhausted(now, resets);
            quota_changed = true;
        }
    } else if credits.remain > 0.0 {
        quota_changed = account.clear_quota();
    }

    // 只把这次真的动过的字段写回内存里那一份：查询期间用户可能改过优先级 / 启停，
    // 拿整份快照覆盖会把那些改动一起冲掉。
    if renewed || quota_changed {
        let mut inner = state.lock()?;
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == uid) {
            if renewed {
                slot.access_token = account.access_token;
                slot.refresh_token = account.refresh_token;
                slot.expires_at = account.expires_at;
                slot.domain = account.domain;
                slot.enterprise_id = account.enterprise_id;
                slot.token_expired = account.token_expired;
            }
            if quota_changed {
                slot.quota_exhausted_at = account.quota_exhausted_at;
                slot.quota_resets_at = account.quota_resets_at;
            }
            slot.save(&crate::paths::gateway_accounts_dir())?;
        }
    }
    Ok(credits)
}

/// 接入信息（地址 / 密钥 / 模型）。
#[tauri::command(async)]
pub fn wb_gateway_access(state: tauri::State<'_, Gateway>) -> Result<Access, String> {
    state.access()
}

/// 重新生成一个访问密钥。旧密钥立刻失效。
#[tauri::command(async)]
pub fn wb_gateway_rotate_key(state: tauri::State<'_, Gateway>) -> Result<String, String> {
    let key = new_key();
    let mut config = load_config();
    config.api_key = key.clone();
    save_config(&config)?;
    let mut inner = state.lock()?;
    inner.api_key = key.clone();
    Ok(key)
}

/// 一段随机密钥。`wbg-` 前缀只是让它在配置里认得出来。
fn new_key() -> String {
    format!("wbg-{}", uuid::Uuid::new_v4().simple())
}

/// 本机旧流水没有 `machine`，读出来补上主机名；远端行缺这个字段时由
/// `read_gateway_rows` 用设备目录名补。
fn fill_machine(rows: &mut [crate::wb_usage::UsageRow]) {
    let machine = crate::sync::host_name();
    for row in rows {
        if row.machine.trim().is_empty() {
            row.machine = machine.clone();
        }
    }
}

/// 同步仓库里别的机器的流水。读失败只记一行日志，**不挡本机出数**。
fn remote_rows(repo: &str, device: &str, since: i64) -> Vec<crate::wb_usage::UsageRow> {
    match crate::sync::read_gateway_rows(repo, device, since) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("[workbench] 读取网关同步流水失败：{err}");
            Vec::new()
        }
    }
}

/// 一段时间（自然日）内的用量汇总。`repo` 非空时把同步仓库里别的机器的流水也合进来。
#[tauri::command(async)]
pub fn wb_gateway_usage(days: i64, repo: String, device: String) -> crate::wb_usage::Summary {
    let days = days.max(1);
    let rows = usage_rows_since(crate::wb_usage::window_start(days), &repo, &device);
    // 粒度跟着窗口走：一周以内按小时，再长退回按天（见 `bucket_unit` 的说明）
    crate::wb_usage::summarize(&rows, crate::wb_usage::bucket_unit(days))
}

/// 一段流水：统计窗口的起点 + 覆盖到它的行（旧→新）。
///
/// 行可能比 `since` **更早**：时序图固定看最近 24 小时，取数窗口至少要铺满它
/// （见 `wb_usage::fetch_start`）。KPI 与明细表由渲染层按 `since` 再裁一次。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub since: i64,
    pub rows: Vec<crate::wb_usage::UsageRow>,
}

/// 一段时间（自然日）内的流水（旧→新）。**统计在前端算**（见 packages/usage 的 gateway-usage）：
/// Rust 只负责把本机与同步仓库里的行按窗口取齐，分组 / 分桶 / 比率的语义留在 TS 侧。
#[tauri::command(async)]
pub fn wb_gateway_usage_rows(days: i64, repo: String, device: String) -> UsageWindow {
    let since = crate::wb_usage::window_start(days);
    UsageWindow {
        since,
        rows: usage_rows_since(crate::wb_usage::fetch_start(days), &repo, &device),
    }
}

fn usage_rows_since(since: i64, repo: &str, device: &str) -> Vec<crate::wb_usage::UsageRow> {
    let mut rows = crate::wb_usage::read_since(since);
    fill_machine(&mut rows);
    if !repo.trim().is_empty() {
        rows.append(&mut remote_rows(repo.trim(), device.trim(), since));
    }
    rows.sort_by_key(|row| row.ts);
    rows
}

/// 最近 N 条请求（新→旧），同样合入别的机器的流水。
#[tauri::command(async)]
pub fn wb_gateway_usage_recent(
    limit: usize,
    repo: String,
    device: String,
) -> Vec<crate::wb_usage::UsageRow> {
    let limit = limit.clamp(1, 500);
    let mut rows = crate::wb_usage::read_recent(limit);
    fill_machine(&mut rows);
    if !repo.trim().is_empty() {
        // 近 90 天足够覆盖「最近请求」；不够再放宽到全部（长时间没用的机器）
        let mut remote = remote_rows(repo.trim(), device.trim(), crate::wb_usage::window_start(90));
        if rows.len() + remote.len() < limit {
            remote = remote_rows(repo.trim(), device.trim(), 0);
        }
        rows.append(&mut remote);
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.ts));
    rows.truncate(limit);
    rows.reverse();
    rows
}

/// 网关当前提供的模型（`/v1/models` 的那一份），每条带上价表单价。
#[tauri::command(async)]
pub fn wb_gateway_models() -> Vec<ModelView> {
    model_views()
}

/// 从上游拉一次真实模型目录并落盘。**只有用户点「重新获取」会走到这里** ——
/// 不挂定时器：一次拉取就是一次真实的上游往返，而模型一天也不变几回。
///
/// 用「第一个可用账号」去拉：目录是账号维度的，两个域可能不一样，
/// 所以谁先能用就用谁，并把来源域记进 `models.json` 便于排查。
#[tauri::command(async)]
pub fn wb_gateway_models_refresh(
    state: tauri::State<'_, Gateway>,
) -> Result<Vec<ModelView>, String> {
    let mut account = {
        let mut inner = state.lock()?;
        inner.ensure_loaded();
        // 与对话同一条选号顺序：优先用池子里优先级最高、且没被额度挡住的号
        crate::wb_pool::first(&inner.accounts, now_secs())
            .map(|index| &inner.accounts[index])
            .or_else(|| inner.accounts.iter().find(|item| item.enabled))
            .cloned()
            .ok_or_else(|| "没有可用的账号：先登录一个再拉模型目录".to_string())?
    };

    // 与查余额同一条规矩：网络请求不占状态锁；续期过就只把 token 字段写回
    // （整份覆盖会冲掉查询期间用户改过的优先级 / 启停）
    let renewed = account.needs_refresh();
    if renewed {
        wb_api_auth::refresh(&mut account)?;
        let mut inner = state.lock()?;
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == account.uid) {
            slot.access_token = account.access_token.clone();
            slot.refresh_token = account.refresh_token.clone();
            slot.expires_at = account.expires_at;
            slot.domain = account.domain.clone();
            slot.enterprise_id = account.enterprise_id.clone();
            slot.token_expired = account.token_expired;
            slot.save(&crate::paths::gateway_accounts_dir())?;
        }
    }

    let catalog = crate::wb_models::fetch(&account)?;
    crate::wb_models::save(&catalog)?;
    Ok(catalog.models.iter().map(ModelView::of).collect())
}

/// 启停一个账号。
#[tauri::command(async)]
pub fn wb_gateway_account_set(
    state: tauri::State<'_, Gateway>,
    uid: String,
    enabled: bool,
) -> Result<(), String> {
    let mut inner = state.lock()?;
    inner.ensure_loaded();
    let account = inner
        .accounts
        .iter_mut()
        .find(|item| item.uid == uid)
        .ok_or_else(|| format!("没有这个账号：{uid}"))?;
    account.enabled = enabled;
    // 手动启用等于把号放回池子：两档额度标记一并清掉，
    // 不然点一次「启用」还是不会被选中（某个模型上也不会）
    if enabled {
        account.clear_quota();
        account.clear_model_quota();
    }
    account.save(&crate::paths::gateway_accounts_dir())
}

/// 改一个号的选号优先级（账号文件里的 `weight`，1..=100，数大的先用）。
#[tauri::command(async)]
pub fn wb_gateway_account_priority(
    state: tauri::State<'_, Gateway>,
    uid: String,
    priority: u8,
) -> Result<(), String> {
    let priority = priority.clamp(1, 100);
    let mut inner = state.lock()?;
    inner.ensure_loaded();
    let account = inner
        .accounts
        .iter_mut()
        .find(|item| item.uid == uid)
        .ok_or_else(|| format!("没有这个账号：{uid}"))?;
    account.weight = priority;
    account.save(&crate::paths::gateway_accounts_dir())
}

/// 删掉一个账号（文件一起删）。
#[tauri::command(async)]
pub fn wb_gateway_account_delete(
    state: tauri::State<'_, Gateway>,
    uid: String,
) -> Result<(), String> {
    wb_account::delete(&crate::paths::gateway_accounts_dir(), &uid)?;
    let mut inner = state.lock()?;
    inner.accounts.retain(|item| item.uid != uid);
    Ok(())
}

// ---------- 任务福利 ----------

/// 福利页顶上的账号选择项。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAccount {
    pub uid: String,
    pub label: String,
}

/// 福利页的任务快照。任务与汇总都是**当前选中那个号**的，不是全部账号的。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksSnapshot {
    pub tasks: Vec<crate::wb_tasks::GrowthTask>,
    pub summary: crate::wb_tasks::GrowthSummary,
    /// 这份快照属于哪个号；没有国内账号时是空串
    pub account: String,
    pub accounts: Vec<TaskAccount>,
    pub msg: String,
}

/// 一轮成长任务的执行结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub ok: bool,
    pub logs: Vec<String>,
    pub credit_added: i64,
}

/// 一个账号的积分发放流水（界面上按发放日汇总成近一个月）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantAccount {
    pub uid: String,
    pub nickname: String,
    pub grants: Vec<crate::wb_credits::Grant>,
    /// 这次没读到时的原因；空串表示读到了
    pub error: String,
}

/// 签到 / 每日活跃 / 猫猫旅行 / 连登管家：每个号一条结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub uid: String,
    pub nickname: String,
    pub ok: bool,
    pub message: String,
    /// 猫猫旅行的动作名（`claim` / `depart` / `traveling`…），其余动作是空串
    pub action: String,
    pub credit: i64,
}

fn snapshot_accounts(state: &tauri::State<'_, Gateway>) -> Result<Vec<Account>, String> {
    let mut inner = state.lock()?;
    inner.ensure_loaded();
    Ok(inner.accounts.clone())
}

/// 按 uid 选目标：`uid` 为空 / `all` 时取全部**已启用**的号。
fn targets_of(accounts: Vec<Account>, uid: Option<&str>) -> Vec<Account> {
    match uid.map(str::trim).filter(|value| !value.is_empty() && *value != "all") {
        Some(uid) => accounts.into_iter().filter(|item| item.uid == uid).collect(),
        None => accounts.into_iter().filter(|item| item.enabled).collect(),
    }
}

/// token 快过期时续一次。返回是否真的续过（续过就要把 token 字段写回）。
fn refresh_if_needed(account: &mut Account) -> Result<bool, String> {
    if !account.needs_refresh() {
        return Ok(false);
    }
    wb_api_auth::refresh(account)?;
    Ok(true)
}

/// 把续期后的 token 字段写回内存与磁盘。只动这几个字段：任务跑几分钟，
/// 期间用户可能改过优先级 / 启停，整份覆盖会把那些改动一起冲掉。
fn persist_tokens(state: &tauri::State<'_, Gateway>, account: &Account) {
    let Ok(mut inner) = state.lock() else {
        return;
    };
    let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == account.uid) else {
        return;
    };
    slot.access_token = account.access_token.clone();
    slot.refresh_token = account.refresh_token.clone();
    slot.expires_at = account.expires_at;
    slot.domain = account.domain.clone();
    slot.enterprise_id = account.enterprise_id.clone();
    slot.token_expired = account.token_expired;
    let _ = slot.save(&crate::paths::gateway_accounts_dir());
}

/// 福利页的任务快照：读当前号的成长任务与汇总。任务清单与汇总（合计四五次请求）
/// 并行发出去，等的是两边都到齐。
#[tauri::command(async)]
pub fn wb_gateway_tasks(
    state: tauri::State<'_, Gateway>,
    uid: Option<String>,
) -> Result<TasksSnapshot, String> {
    let cn = targets_of(snapshot_accounts(&state)?, None);
    if cn.is_empty() {
        return Ok(TasksSnapshot {
            tasks: Vec::new(),
            summary: Default::default(),
            account: String::new(),
            accounts: Vec::new(),
            msg: "未找到可用的账号".into(),
        });
    }
    let accounts = cn
        .iter()
        .map(|item| TaskAccount {
            uid: item.uid.clone(),
            label: item.label(),
        })
        .collect();
    let mut target = match uid.as_deref().map(str::trim).filter(|value| !value.is_empty() && *value != "all") {
        Some(wanted) => cn
            .iter()
            .find(|item| item.uid == wanted)
            .cloned()
            .or_else(|| cn.first().cloned()),
        None => cn.first().cloned(),
    }
    .ok_or_else(|| "未找到可用的账号".to_string())?;

    if refresh_if_needed(&mut target)? {
        persist_tokens(&state, &target);
    }

    let tasks = crate::wb_tasks::fetch_growth_tasks(&target)?;
    // 汇总要打四五次上游，和任务清单并行：这一栏等的是「两块都到齐」，
    // 串着来就是白白多等一倍。
    let summary_account = target.clone();
    let summary = std::thread::spawn(move || crate::wb_tasks::fetch_growth_summary(&summary_account))
        .join()
        .unwrap_or_default();
    Ok(TasksSnapshot {
        tasks,
        summary,
        account: target.uid,
        accounts,
        msg: String::new(),
    })
}

/// 积分发放流水：福利页那张「近一个月每天积分」的柱状图。
///
/// `uid` 为空 / `all` 时取全部已启用的号，界面按发放日相加；每个号一次只读 POST。
/// 某个号失败只把 `error` 填上，其余账号照常返回 —— 一个号的 token 过期不该把整张图清空。
/// 整段包历史原样回去，裁最近 30 天是界面那一层的事（与用量流水的分工一致）。
#[tauri::command(async)]
pub fn wb_gateway_credit_grants(
    state: tauri::State<'_, Gateway>,
    uid: Option<String>,
) -> Result<Vec<GrantAccount>, String> {
    let targets = targets_of(snapshot_accounts(&state)?, uid.as_deref());
    if targets.is_empty() {
        return Err("未找到已启用的账号".into());
    }

    let mut rows = Vec::new();
    for mut account in targets {
        let mut error = String::new();
        match refresh_if_needed(&mut account) {
            Ok(refreshed) => {
                if refreshed {
                    persist_tokens(&state, &account);
                }
            }
            Err(message) => error = format!("续期失败：{message}"),
        }
        let grants = if error.is_empty() {
            match crate::wb_api_billing::fetch_credit_grants(&account) {
                Ok(grants) => grants,
                Err(message) => {
                    error = message;
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        rows.push(GrantAccount {
            uid: account.uid.clone(),
            nickname: account.label(),
            grants,
            error,
        });
    }
    Ok(rows)
}

/// 一键做任务领积分。`uid` 为空 / `all` 时对全部已启用的国内账号逐个跑。
#[tauri::command(async)]
pub fn wb_gateway_tasks_run(
    state: tauri::State<'_, Gateway>,
    uid: Option<String>,
) -> Result<TaskRun, String> {
    let targets = targets_of(snapshot_accounts(&state)?, uid.as_deref());
    if targets.is_empty() {
        return Err("未找到已启用的账号".into());
    }

    let mut logs: Vec<String> = Vec::new();
    let mut total = 0;
    for (index, mut account) in targets.iter().cloned().enumerate() {
        let nickname = account.label();
        logs.push(format!(
            "====== 正在为账号 [{nickname} ({})] 执行全自动成长任务 ({}/{}) ======",
            account.uid,
            index + 1,
            targets.len()
        ));
        if let Err(message) = refresh_if_needed(&mut account) {
            logs.push(format!("  ! 续期失败，跳过：{message}"));
            continue;
        }
        persist_tokens(&state, &account);
        let outcome = crate::wb_tasks::run_growth_tasks(&account, 1.0);
        total += outcome.earned_credit;
        logs.extend(outcome.logs.into_iter().map(|line| format!("  {line}")));
        if !outcome.msg.is_empty() {
            logs.push(format!("  {}", outcome.msg));
        }
        if index + 1 < targets.len() {
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    }
    logs.push(format!(
        "====== 全部 {} 个账号任务执行完毕，累计新增积分：+{total} ======",
        targets.len()
    ));
    Ok(TaskRun {
        ok: true,
        logs,
        credit_added: total,
    })
}

/// 猫猫旅行：到站领奖 / 在家出发 / 报告正在路上。
#[tauri::command(async)]
pub fn wb_gateway_tasks_travel(
    state: tauri::State<'_, Gateway>,
    uid: Option<String>,
) -> Result<Vec<ActionResult>, String> {
    let targets = targets_of(snapshot_accounts(&state)?, uid.as_deref());
    if targets.is_empty() {
        return Err("未找到已启用的账号".into());
    }
    let mut results = Vec::new();
    for mut account in targets {
        if let Err(message) = refresh_if_needed(&mut account) {
            results.push(ActionResult {
                uid: account.uid.clone(),
                nickname: account.label(),
                ok: false,
                message: format!("续期失败：{message}"),
                action: String::new(),
                credit: 0,
            });
            continue;
        }
        persist_tokens(&state, &account);
        let outcome = crate::wb_tasks::do_cat_travel(&account);
        results.push(ActionResult {
            uid: account.uid.clone(),
            nickname: account.label(),
            ok: outcome.ok,
            message: outcome.msg,
            action: outcome.action,
            credit: outcome.credit,
        });
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
    Ok(results)
}

/// 连登管家与抽奖：补签 → 礼包 / 补偿 → 档位兑换 → 抽奖。
#[tauri::command(async)]
pub fn wb_gateway_tasks_streak(
    state: tauri::State<'_, Gateway>,
    uid: Option<String>,
) -> Result<Vec<ActionResult>, String> {
    let targets = targets_of(snapshot_accounts(&state)?, uid.as_deref());
    if targets.is_empty() {
        return Err("未找到已启用的账号".into());
    }
    let mut results = Vec::new();
    for mut account in targets {
        if let Err(message) = refresh_if_needed(&mut account) {
            results.push(ActionResult {
                uid: account.uid.clone(),
                nickname: account.label(),
                ok: false,
                message: format!("续期失败：{message}"),
                action: String::new(),
                credit: 0,
            });
            continue;
        }
        persist_tokens(&state, &account);
        let outcome = crate::wb_tasks::run_streak_bonus(&account);
        results.push(ActionResult {
            uid: account.uid.clone(),
            nickname: account.label(),
            ok: outcome.ok,
            message: outcome.msg,
            action: String::new(),
            credit: 0,
        });
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
    Ok(results)
}

/// Buddy 加油站签到（国内版）。
#[tauri::command(async)]
pub fn wb_gateway_checkin(
    state: tauri::State<'_, Gateway>,
    uid: Option<String>,
) -> Result<Vec<ActionResult>, String> {
    let targets = targets_of(snapshot_accounts(&state)?, uid.as_deref());
    if targets.is_empty() {
        return Err("未找到已启用的账号".into());
    }
    let mut results = Vec::new();
    for mut account in targets {
        if let Err(message) = refresh_if_needed(&mut account) {
            results.push(ActionResult {
                uid: account.uid.clone(),
                nickname: account.label(),
                ok: false,
                message: format!("续期失败：{message}"),
                action: String::new(),
                credit: 0,
            });
            continue;
        }
        persist_tokens(&state, &account);
        let outcome = crate::wb_tasks::checkin(&account);
        results.push(ActionResult {
            uid: account.uid.clone(),
            nickname: account.label(),
            ok: outcome.ok,
            message: outcome.msg,
            action: String::new(),
            credit: 0,
        });
    }
    Ok(results)
}

/// 今天的签到尝试（`activity.jsonl` 里今天那一段）。
#[tauri::command(async)]
pub fn wb_gateway_activity_today() -> Vec<crate::wb_tasks::ActivityRow> {
    crate::wb_tasks::read_today()
}

fn view_of(account: &Account) -> AccountView {
    let now = now_secs();
    let quota_exhausted = account.quota_blocked(now);
    AccountView {
        uid: account.uid.clone(),
        label: account.label(),
        product: account.product.as_str().to_string(),
        enterprise: !account.enterprise_id.trim().is_empty(),
        enabled: account.enabled,
        ready: account.is_ready(),
        needs_refresh: account.needs_refresh(),
        priority: account.weight,
        quota_exhausted,
        quota_resets_at: if quota_exhausted {
            Some(account.quota_until())
        } else {
            None
        },
        model_quotas: {
            let mut list: Vec<ModelQuotaView> = account
                .model_quotas(now)
                .map(|item| ModelQuotaView {
                    model: item.model.clone(),
                    resets_at: item.resets_at,
                })
                .collect();
            // 先恢复的排前面：界面上那行小字只写第一个，剩下的合并成个数
            list.sort_by_key(|item| item.resets_at);
            list
        },
        note: account.note.clone(),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- 配置 ----------

pub fn load_config() -> Config {
    let path = crate::paths::gateway_settings_file();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Config::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let path = crate::paths::gateway_settings_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建网关目录失败: {err}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|err| format!("序列化网关配置失败: {err}"))?;
    crate::fs_util::write_atomic(&path, text.as_bytes())
}

// ---------- Tauri 命令 ----------
//
// 一律 `#[tauri::command(async)]`：都要碰磁盘或起线程，不该占 IPC 主线程。

/// 当前状态（是否在跑、端口、账号数）。
#[tauri::command(async)]
pub fn wb_gateway_status(state: tauri::State<'_, Gateway>) -> Result<Status, String> {
    state.status()
}

/// 启动监听。端口与开关落盘，下次打开应用还能记住。
#[tauri::command(async)]
pub fn wb_gateway_start(state: tauri::State<'_, Gateway>, port: u16) -> Result<u16, String> {
    if port < 1024 {
        return Err("端口要大于 1023（低端口段需要管理员权限）".into());
    }
    let bound = state.start(port)?;
    let mut config = load_config();
    config.port = bound;
    save_config(&config)?;
    Ok(bound)
}

#[tauri::command(async)]
pub fn wb_gateway_stop(state: tauri::State<'_, Gateway>) -> Result<(), String> {
    state.stop()
}

/// 账号列表（不含 token）。
#[tauri::command(async)]
pub fn wb_gateway_accounts(
    state: tauri::State<'_, Gateway>,
) -> Result<Vec<AccountView>, String> {
    state.accounts()
}

/// 重新从磁盘载入账号。登录完成或手工放文件之后调用。
#[tauri::command(async)]
pub fn wb_gateway_reload(state: tauri::State<'_, Gateway>) -> Result<(), String> {
    state.reload()
}

#[cfg(test)]
impl Gateway {
    /// 用给定的账号造一个网关（不读磁盘）。
    ///
    /// **为什么不直接用 `Gateway::default()` 测**：那会去读真实账号目录，
    /// 于是用例的结果取决于"这台机器上登过几个号"—— 本地跑绿、换台机器跑红。
    fn seeded(accounts: Vec<Account>) -> Self {
        let gateway = Gateway::default();
        {
            let mut inner = gateway.inner.lock().expect("刚创建，不会 poison");
            inner.accounts = accounts;
            inner.loaded = true;
        }
        gateway
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_account(uid: &str) -> Account {
        Account {
            uid: uid.into(),
            nickname: String::new(),
            domain: String::new(),
            product: crate::wb_identity::Identity::Workbuddy,
            enterprise_id: String::new(),
            access_token: "tok".into(),
            refresh_token: String::new(),
            expires_at: 0,
            added_at: 0,
            source: "oauth".into(),
            enabled: true,
            weight: 1,
            note: String::new(),
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        }
    }

    #[test]
    fn 默认配置不自动启动() {
        let config = Config::default();
        assert!(!config.auto_start, "默认不联网、不自启");
        assert_eq!(config.port, DEFAULT_PORT);
    }

    #[test]
    fn 模型条目带上价表单价与目录字段() {
        let entry = crate::wb_models::ModelEntry {
            id: "glm-5.2".into(),
            name: "GLM-5.2".into(),
            rate: "0.79x".into(),
            context: 1_000_000,
            max_output: 64_000,
            efforts: vec!["low".into(), "high".into()],
            default_effort: "high".into(),
            ..Default::default()
        };
        let view = ModelView::of(&entry);
        assert_eq!(view.id, "glm-5.2");
        assert_eq!(view.context, 1_000_000);
        assert_eq!(view.rate, "0.79x");
        assert_eq!(view.efforts.len(), 2);
        assert_eq!(view.input_cny, Some(4.0));
        assert_eq!(view.output_cny, Some(16.0));
    }

    #[test]
    fn 价表里没有的模型两个单价都是_none() {
        let unknown = ModelView::of(&crate::wb_models::ModelEntry {
            id: "some-model-nobody-priced".into(),
            ..Default::default()
        });
        assert_eq!(unknown.input_cny, None, "查不到就是 None，不退化成 0");
        assert_eq!(unknown.output_cny, None);

        // 前缀匹配：带日期后缀的变体也要落到同一个价上
        let variant = ModelView::of(&crate::wb_models::ModelEntry {
            id: "glm-5.2-0930".into(),
            ..Default::default()
        });
        assert_eq!(variant.input_cny, Some(4.0));
        assert_eq!(variant.output_cny, Some(16.0));
    }

    #[test]
    fn 配置能往返序列化() {
        let config = Config {
            auto_start: true,
            port: 18000,
            api_key: "wbg-test".into(),
        };
        let text = serde_json::to_string(&config).unwrap();
        assert!(text.contains("\"autoStart\":true"));
        assert!(text.contains("\"port\":18000"));
        let back: Config = serde_json::from_str(&text).unwrap();
        assert!(back.auto_start);
        assert_eq!(back.port, 18000);
    }

    #[test]
    fn 缺字段时用默认值补齐() {
        let back: Config = serde_json::from_str(r#"{"port":9999}"#).unwrap();
        assert!(!back.auto_start);
        assert_eq!(back.port, 9999);
    }

    #[test]
    fn 未启动时状态里没有_base_url() {
        let gateway = Gateway::seeded(Vec::new());
        let status = gateway.status().unwrap();
        assert!(!status.running);
        assert!(status.base_url.is_none());
        assert_eq!(status.accounts, 0);
        assert_eq!(status.ready, 0);
    }

    #[test]
    fn 账号数与可用数分开算() {
        let mut disabled = ready_account("u-2");
        disabled.enabled = false;
        let gateway = Gateway::seeded(vec![ready_account("u-1"), disabled]);
        let status = gateway.status().unwrap();
        assert_eq!(status.accounts, 2);
        assert_eq!(status.ready, 1, "停用的不算可用");
    }

    #[test]
    fn 账号视图带上优先级与额度标记() {
        let now = now_secs();
        let mut account = ready_account("u-1");
        account.weight = 7;
        account.mark_quota_exhausted(now, now + 3600);
        let view = view_of(&account);
        assert_eq!(view.priority, 7);
        assert!(view.quota_exhausted);
        assert!(view.quota_resets_at.expect("标记中要给恢复时间") > now);
    }

    #[test]
    fn 额度标记过期后视图恢复可用() {
        let now = now_secs();
        let mut account = ready_account("u-1");
        account.mark_quota_exhausted(now - 7200, now - 3600);
        let view = view_of(&account);
        assert!(!view.quota_exhausted);
        assert!(view.quota_resets_at.is_none());
        assert!(view.ready);
    }

    #[test]
    fn 视图带上按模型的额度标记_只列还在生效的() {
        let now = now_secs();
        let mut account = ready_account("u-1");
        account.mark_model_exhausted("deepseek", now, now + 7200);
        account.mark_model_exhausted("glm", now - 7200, now - 3600);

        let view = view_of(&account);
        assert_eq!(view.model_quotas.len(), 1, "视图只列还在生效的");
        assert_eq!(view.model_quotas[0].model, "deepseek");
        assert!(view.model_quotas[0].resets_at > now);
        // 按模型的标记不是整号用完：号的可用状态不受影响
        assert!(!view.quota_exhausted);
        assert!(view.ready);
    }
}
