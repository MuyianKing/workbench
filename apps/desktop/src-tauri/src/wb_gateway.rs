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
use crate::wb_realm::Realm;
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
    /// 进行中的登录：state → 区域与发起时刻。十分钟不用就回收
    logins: HashMap<String, LoginSession>,
    /// 生效中的访问密钥（启动时从配置里取，没有就现生成）
    api_key: String,
}

struct LoginSession {
    realm: Realm,
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
    pub realm: String,
    pub realm_label: String,
    pub product: String,
    pub enterprise: bool,
    pub enabled: bool,
    pub ready: bool,
    pub needs_refresh: bool,
    pub note: String,
}

// ---------- 登录 ----------

/// 发起登录。返回授权链接，界面拿去开浏览器，state 留在内存里等轮询。
#[tauri::command(async)]
pub fn wb_gateway_login_start(
    state: tauri::State<'_, Gateway>,
    realm: String,
) -> Result<LoginStart, String> {
    let realm = Realm::parse(&realm).ok_or_else(|| format!("不认识的区域：{realm}"))?;
    let start = wb_api_auth::start_login(realm)?;
    let mut inner = state.lock()?;
    inner.prune_logins();
    inner.logins.insert(
        start.state.clone(),
        LoginSession {
            realm,
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
    let realm = {
        let inner = state.lock()?;
        match inner.logins.get(login_state.trim()) {
            Some(session) => session.realm,
            None => return Err("这个登录已过期或不存在，请重新发起".into()),
        }
    };

    match wb_api_auth::poll_login(realm, &login_state)? {
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

    // 续期过的 token 必须写回：不落盘的话下次启动还拿着旧 token，
    // 内存里也不换回去的话，进程里继续用旧的（下一轮又会续期一次）
    if renewed {
        account.save(&crate::paths::gateway_accounts_dir())?;
        let mut inner = state.lock()?;
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == uid) {
            *slot = account;
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
fn remote_rows(repo: &str, device: &str, days: i64) -> Vec<crate::wb_usage::UsageRow> {
    match crate::sync::read_gateway_rows(repo, device, days) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("[workbench] 读取网关同步流水失败：{err}");
            Vec::new()
        }
    }
}

/// 一段时间（天）内的用量汇总。`repo` 非空时把同步仓库里别的机器的流水也合进来。
#[tauri::command(async)]
pub fn wb_gateway_usage(days: i64, repo: String, device: String) -> crate::wb_usage::Summary {
    let days = days.max(1);
    let rows = usage_rows(days, &repo, &device);
    // 粒度跟着窗口走：一周以内按小时，再长退回按天（见 `bucket_unit` 的说明）
    crate::wb_usage::summarize(&rows, crate::wb_usage::bucket_unit(days))
}

/// 一段时间（天）内的流水（旧→新）。**统计在前端算**（见 packages/usage 的 gateway-usage）：
/// Rust 只负责把本机与同步仓库里的行按窗口取齐，分组 / 分桶 / 比率的语义留在 TS 侧。
#[tauri::command(async)]
pub fn wb_gateway_usage_rows(
    days: i64,
    repo: String,
    device: String,
) -> Vec<crate::wb_usage::UsageRow> {
    usage_rows(days.max(1), &repo, &device)
}

fn usage_rows(days: i64, repo: &str, device: &str) -> Vec<crate::wb_usage::UsageRow> {
    let mut rows = crate::wb_usage::read_since(days);
    fill_machine(&mut rows);
    if !repo.trim().is_empty() {
        rows.append(&mut remote_rows(repo.trim(), device.trim(), days));
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
        let mut remote = remote_rows(repo.trim(), device.trim(), 90);
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
        inner
            .accounts
            .iter()
            .find(|item| item.enabled && item.is_ready())
            .or_else(|| inner.accounts.iter().find(|item| item.enabled))
            .cloned()
            .ok_or_else(|| "没有可用的账号：先登录一个再拉模型目录".to_string())?
    };

    // 与查余额同一条规矩：网络请求不占状态锁；续期过就把 token 写回去
    let renewed = account.needs_refresh();
    if renewed {
        wb_api_auth::refresh(&mut account)?;
        account.save(&crate::paths::gateway_accounts_dir())?;
        let mut inner = state.lock()?;
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == account.uid) {
            *slot = account.clone();
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

fn view_of(account: &Account) -> AccountView {
    AccountView {
        uid: account.uid.clone(),
        label: account.label(),
        realm: account.realm.as_str().to_string(),
        realm_label: account.realm.config().label.to_string(),
        product: account.product.as_str().to_string(),
        enterprise: !account.enterprise_id.trim().is_empty(),
        enabled: account.enabled,
        ready: account.is_ready(),
        needs_refresh: account.needs_refresh(),
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
            realm: Realm::Workbuddy,
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
}
