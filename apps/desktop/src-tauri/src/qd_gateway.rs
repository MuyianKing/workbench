//! Qoder 网关的生命周期、状态与 Tauri 命令。
//!
//! 与 `wb_gateway` 同构：账号、登录会话、会话亲和都在 [`Inner`] 里，
//! 监听句柄与密钥在共享的 [`ProxyControl`] 里（与 TBuddy 互斥）。
//!
//! 所有命令一律 `async`：都要碰磁盘或起线程，不能占 IPC 主线程。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::qd_account::{now_secs, Account};
use crate::qd_auth::{LoginStart, LoginTicket, PollOutcome};
use crate::qd_body::Conversation;
use crate::qd_credits::{self, Credits};
use crate::qd_models::{self, ModelInfo};
use crate::qd_tasks::{self, ActivityRow, CampaignView, CheckinStatus, ClaimResult, EarningPoint, HeatmapPoint};
use crate::qd_usage;
use crate::wb_server::{self, Server};
use crate::wb_usage::{self, BucketUnit};

/// 登录窗口有效期。
const LOGIN_TTL_SECS: i64 = 600;

/// Qoder 自己的持久化配置（`data/wb-qoder/settings.json`）。
///
/// 与 TBuddy 的 `wb-gateway/settings.json` **各存各的**：端口、密钥、随程序启动都独立，
/// 两个代理可以同时跑（端口不同）。字段少，直接读写文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_auto_start")]
    pub auto_start: bool,
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
}

fn default_auto_start() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            auto_start: true,
            port: DEFAULT_PORT,
            api_key: String::new(),
        }
    }
}

/// 默认端口。TBuddy 用 17878，这里错开一个。
pub const DEFAULT_PORT: u16 = 17879;

pub fn load_config() -> Config {
    let path = crate::paths::qoder_settings_file();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Config::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let path = crate::paths::qoder_settings_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建 Qoder 目录失败: {err}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|err| format!("序列化 Qoder 配置失败: {err}"))?;
    crate::fs_util::write_atomic(&path, text.as_bytes())
}

/// 一段随机密钥。`wbg-` 前缀与 TBuddy 同一族，认得出来这是网关密钥。
pub fn new_key() -> String {
    format!("wbg-{}", uuid::Uuid::new_v4().simple())
}

struct LoginSession {
    ticket: LoginTicket,
}

#[derive(Default)]
struct Inner {
    server: Option<Server>,
    accounts: Vec<Account>,
    loaded: bool,
    /// state → 登录票据
    logins: HashMap<String, LoginSession>,
    /// 会话亲和：affinity key → 会话身份（chat_record_id / begin_at / name）
    conversations: HashMap<String, Conversation>,
    /// Qoder 自己的访问密钥（与 TBuddy 各用各的）
    api_key: String,
}

/// Tauri managed state。
#[derive(Default, Clone)]
pub struct Qoder {
    inner: Arc<Mutex<Inner>>,
}

impl Qoder {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "Qoder 状态被上一次失败污染了，重启应用即可".to_string())
    }

    /// 启动监听。已经在跑就直接返回当前端口（幂等）。
    pub fn start(&self, port: u16) -> Result<u16, String> {
        let mut inner = self.lock()?;
        if let Some(server) = inner.server.as_ref() {
            return Ok(server.port());
        }
        inner.ensure_loaded();
        inner.api_key = ensure_key()?;

        let shared = Arc::clone(&self.inner);
        let handler: wb_server::Handler = Arc::new(move |request: &wb_server::Request| {
            let mut inner = match shared.lock() {
                Ok(inner) => inner,
                Err(poisoned) => poisoned.into_inner(),
            };
            // 先把 key 拷出来：`&mut inner.accounts` 与 `&inner.api_key` 同时借不行
            let key = inner.api_key.clone();
            let Inner {
                accounts,
                conversations,
                ..
            } = &mut *inner;
            crate::qd_router::route(request, accounts, &key, conversations)
        });
        let server = Server::start(port, handler)?;
        inner.server = Some(server);
        Ok(port)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut inner = self.lock()?;
        if let Some(mut server) = inner.server.take() {
            server.stop();
        }
        Ok(())
    }

    pub fn status(&self) -> Result<Status, String> {
        let mut inner = self.lock()?;
        inner.ensure_loaded();
        let ready = inner.accounts.iter().filter(|account| account.is_ready()).count();
        let config = load_config();
        Ok(Status {
            running: inner.server.is_some(),
            port: inner
                .server
                .as_ref()
                .map(Server::port)
                .unwrap_or(config.port),
            base_url: inner
                .server
                .as_ref()
                .map(|server| wb_server::api_base(server.port())),
            accounts: inner.accounts.len(),
            ready,
            auto_start: config.auto_start,
        })
    }

    pub fn accounts(&self) -> Result<Vec<AccountView>, String> {
        let mut inner = self.lock()?;
        inner.ensure_loaded();
        let now = now_secs();
        Ok(inner.accounts.iter().map(|account| view_of(account, now)).collect())
    }

    pub fn reload(&self) -> Result<(), String> {
        let mut inner = self.lock()?;
        inner.accounts = crate::qd_account::load_all(&crate::paths::qoder_accounts_dir());
        inner.loaded = true;
        Ok(())
    }

    /// 导出全部账号的完整凭据（含明文 token）。
    ///
    /// **这是账号视图之外唯一回读 token 的通道**：只由用户显式点「导出」触发，
    /// 结果直接交给渲染层供复制，不进任何列表 / 同步仓库。
    pub fn export_accounts(&self) -> Result<String, String> {
        let mut inner = self.lock()?;
        inner.ensure_loaded();
        crate::qd_account::export_accounts(&inner.accounts)
    }

    /// 导入一批账号：`overwrite` 决定同 uid 是覆盖本机那份还是跳过。
    ///
    /// 先全部解析、再逐个落盘，写成功之后才改内存；任一文件写失败就带着 uid 返回，
    /// 内存保持原样（已写成的文件下次 reload 会被读回来）。
    pub fn import_accounts(
        &self,
        imported: Vec<Account>,
        overwrite: bool,
    ) -> Result<ImportResult, String> {
        let dir = crate::paths::qoder_accounts_dir();
        let mut inner = self.lock()?;
        inner.ensure_loaded();
        let (plan, result) = plan_import(&inner.accounts, imported, overwrite);
        for account in &plan {
            account.save(&dir)?;
        }
        for account in plan {
            match inner.accounts.iter().position(|item| item.uid == account.uid) {
                Some(index) => inner.accounts[index] = account,
                None => inner.accounts.push(account),
            }
        }
        // 与 `load_all` 同一口径：重启前后账号池顺序一致
        inner.accounts.sort_by_key(|account| account.added_at);
        Ok(result)
    }

    pub fn access(&self) -> Result<Access, String> {
        let mut inner = self.lock()?;
        let config = load_config();
        if inner.api_key.is_empty() {
            inner.api_key = ensure_key()?;
        }
        Ok(Access {
            base_url: wb_server::api_base(
                inner
                    .server
                    .as_ref()
                    .map(Server::port)
                    .unwrap_or(config.port),
            ),
            api_key: inner.api_key.clone(),
            models: qd_models::merged()
                .into_iter()
                .filter(|model| model.enabled)
                .map(|model| model.id)
                .collect(),
        })
    }
}

/// 读 Qoder 自己的密钥；没有就生成并落盘。
fn ensure_key() -> Result<String, String> {
    let mut config = load_config();
    if config.api_key.trim().is_empty() {
        config.api_key = new_key();
        save_config(&config)?;
    }
    Ok(config.api_key)
}

impl Inner {
    fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.accounts = crate::qd_account::load_all(&crate::paths::qoder_accounts_dir());
        self.loaded = true;
    }

    fn upsert(&mut self, account: Account) {
        match self.accounts.iter_mut().find(|item| item.uid == account.uid) {
            Some(existing) => *existing = account,
            None => self.accounts.push(account),
        }
        self.loaded = true;
    }

    fn prune_logins(&mut self) {
        let now = now_secs();
        self.logins
            .retain(|_, session| now - session.ticket.created <= LOGIN_TTL_SECS);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub accounts: usize,
    pub ready: usize,
    pub auto_start: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub uid: String,
    pub label: String,
    pub enabled: bool,
    pub ready: bool,
    pub needs_refresh: bool,
    pub priority: u8,
    pub team: bool,
    pub organization_name: String,
    pub user_type: String,
    pub plan: String,
    pub note: String,
    pub last_error: String,
    pub quota_exhausted: bool,
    pub quota_resets_at: Option<i64>,
    pub model_quotas: Vec<ModelQuotaView>,
    pub credit_expires_at: i64,
    pub last_checkin: String,
    /// 已领到的活动兑换码：活动 id → 码
    pub campaign_codes: HashMap<String, String>,
    pub added_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelQuotaView {
    pub model: String,
    pub resets_at: i64,
}

fn view_of(account: &Account, now: i64) -> AccountView {
    AccountView {
        uid: account.uid.clone(),
        label: account.label(),
        enabled: account.enabled,
        ready: account.is_ready(),
        needs_refresh: account.needs_refresh(),
        priority: account.weight,
        team: account.is_team(),
        organization_name: account.organization_name.clone(),
        user_type: account.user_type.clone(),
        plan: account.plan.clone(),
        note: account.note.clone(),
        last_error: account.last_error.clone(),
        quota_exhausted: account.quota_blocked(now),
        quota_resets_at: (account.quota_until() > now).then(|| account.quota_until()),
        model_quotas: account
            .quota_models
            .iter()
            .filter(|item| now < item.resets_at)
            .map(|item| ModelQuotaView {
                model: item.model.clone(),
                resets_at: item.resets_at,
            })
            .collect(),
        credit_expires_at: account.credit_expires_at,
        last_checkin: account.last_checkin.clone(),
        campaign_codes: account.campaign_codes.clone(),
        added_at: account.added_at,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    pub status: String,
    pub message: String,
    pub account: Option<AccountView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub since: i64,
    pub rows: Vec<crate::wb_usage::UsageRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub account: String,
    pub uid: String,
    pub checkin: CheckinStatus,
    pub campaigns: Vec<CampaignView>,
    pub credits: Option<Credits>,
    pub error: String,
}

// ---------- 生命周期 ----------

#[tauri::command(async)]
pub fn wb_qoder_status(state: tauri::State<'_, Qoder>) -> Result<Status, String> {
    state.status()
}

#[tauri::command(async)]
pub fn wb_qoder_start(state: tauri::State<'_, Qoder>, port: u16) -> Result<u16, String> {
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
pub fn wb_qoder_stop(state: tauri::State<'_, Qoder>) -> Result<(), String> {
    state.stop()
}

/// 「随程序启动」：只写 Qoder 自己的配置，不立刻启停；TBuddy 的开关是另一份。
#[tauri::command(async)]
pub fn wb_qoder_auto_start_set(enabled: bool) -> Result<(), String> {
    let mut config = load_config();
    config.auto_start = enabled;
    save_config(&config)
}

#[tauri::command(async)]
pub fn wb_qoder_accounts(state: tauri::State<'_, Qoder>) -> Result<Vec<AccountView>, String> {
    state.accounts()
}

#[tauri::command(async)]
pub fn wb_qoder_reload(state: tauri::State<'_, Qoder>) -> Result<(), String> {
    state.reload()
}

#[tauri::command(async)]
pub fn wb_qoder_access(state: tauri::State<'_, Qoder>) -> Result<Access, String> {
    state.access()
}

#[tauri::command(async)]
pub fn wb_qoder_rotate_key(state: tauri::State<'_, Qoder>) -> Result<String, String> {
    let key = new_key();
    let mut config = load_config();
    config.api_key = key.clone();
    save_config(&config)?;
    state.lock()?.api_key = key.clone();
    Ok(key)
}

// ---------- 登录 ----------

#[tauri::command(async)]
pub fn wb_qoder_login_start(state: tauri::State<'_, Qoder>) -> Result<LoginStart, String> {
    let start = crate::qd_auth::start_login()?;
    let mut inner = state.lock()?;
    inner.prune_logins();
    inner.logins.insert(
        start.state.clone(),
        LoginSession {
            ticket: LoginTicket {
                verifier: start.verifier.clone(),
                nonce: start.nonce.clone(),
                created: now_secs(),
            },
        },
    );
    Ok(LoginStart {
        state: start.state,
        auth_url: start.auth_url,
        verifier: String::new(),
        nonce: String::new(),
    })
}

#[tauri::command(async)]
pub fn wb_qoder_login_poll(
    state: tauri::State<'_, Qoder>,
    login_state: String,
) -> Result<LoginPoll, String> {
    let ticket = {
        let mut inner = state.lock()?;
        inner.prune_logins();
        match inner.logins.get(&login_state) {
            Some(session) => session.ticket.clone(),
            None => {
                return Ok(LoginPoll {
                    status: "unknown".into(),
                    message: "登录窗口已过期，请重新发起登录".into(),
                    account: None,
                })
            }
        }
    };
    let outcome = crate::qd_auth::poll_login(&ticket);
    match outcome {
        PollOutcome::Pending(message) => Ok(LoginPoll {
            status: "pending".into(),
            message,
            account: None,
        }),
        PollOutcome::Failed(message) => Ok(LoginPoll {
            status: "error".into(),
            message,
            account: None,
        }),
        PollOutcome::Ready(account) => {
            let account = *account;
            account.save(&crate::paths::qoder_accounts_dir())?;
            let mut inner = state.lock()?;
            inner.logins.remove(&login_state);
            inner.upsert(account.clone());
            Ok(LoginPoll {
                status: "ok".into(),
                message: "登录成功".into(),
                account: Some(view_of(&account, now_secs())),
            })
        }
    }
}

// ---------- 账号操作 ----------

/// 导入结果：界面拿它拼一句「新增 N 个 / 覆盖 N 个 / 跳过 N 个」。
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
}

/// 合并判定（纯逻辑，不碰磁盘）：返回需要落盘的账号与计数。
fn plan_import(
    existing: &[Account],
    imported: Vec<Account>,
    overwrite: bool,
) -> (Vec<Account>, ImportResult) {
    let mut plan = Vec::new();
    let mut result = ImportResult::default();
    for account in imported {
        match existing.iter().find(|item| item.uid == account.uid) {
            Some(_) if !overwrite => result.skipped += 1,
            Some(_) => {
                result.updated += 1;
                plan.push(account);
            }
            None => {
                result.added += 1;
                plan.push(account);
            }
        }
    }
    (plan, result)
}

/// 把账号池导成一段 JSON（含明文 token，只给用户点「导出」时用）。
#[tauri::command(async)]
pub fn wb_qoder_accounts_export(state: tauri::State<'_, Qoder>) -> Result<String, String> {
    state.export_accounts()
}

/// 从一段导出的 JSON 导入账号。`overwrite=false` 时同 uid 跳过。
#[tauri::command(async)]
pub fn wb_qoder_accounts_import(
    state: tauri::State<'_, Qoder>,
    payload: String,
    overwrite: bool,
) -> Result<ImportResult, String> {
    let accounts = crate::qd_account::parse_import(&payload)?;
    state.import_accounts(accounts, overwrite)
}

#[tauri::command(async)]
pub fn wb_qoder_account_set(
    state: tauri::State<'_, Qoder>,
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
    if enabled {
        account.clear_quota();
        account.clear_model_quota();
        account.token_expired = false;
        account.last_error.clear();
        account.cooldown_until = 0;
    }
    account.save(&crate::paths::qoder_accounts_dir())
}

#[tauri::command(async)]
pub fn wb_qoder_account_priority(
    state: tauri::State<'_, Qoder>,
    uid: String,
    priority: u8,
) -> Result<(), String> {
    let mut inner = state.lock()?;
    inner.ensure_loaded();
    let account = inner
        .accounts
        .iter_mut()
        .find(|item| item.uid == uid)
        .ok_or_else(|| format!("没有这个账号：{uid}"))?;
    account.weight = priority.clamp(1, 100);
    account.save(&crate::paths::qoder_accounts_dir())
}

#[tauri::command(async)]
pub fn wb_qoder_account_delete(
    state: tauri::State<'_, Qoder>,
    uid: String,
) -> Result<(), String> {
    let mut inner = state.lock()?;
    inner.ensure_loaded();
    let path = crate::qd_account::account_path(&crate::paths::qoder_accounts_dir(), &uid)?;
    let _ = std::fs::remove_file(path);
    inner.accounts.retain(|item| item.uid != uid);
    Ok(())
}

/// 账号昵称表：请求页把 uid 显示成人名。
#[tauri::command(async)]
pub fn wb_qoder_account_names(
    state: tauri::State<'_, Qoder>,
) -> Result<HashMap<String, String>, String> {
    let mut inner = state.lock()?;
    inner.ensure_loaded();
    Ok(inner
        .accounts
        .iter()
        .map(|account| (account.uid.clone(), account.label()))
        .collect())
}

// ---------- 模型 ----------

#[tauri::command(async)]
pub fn wb_qoder_models() -> Vec<ModelInfo> {
    qd_models::merged()
}

/// 用第一个可用账号拉一次上游目录。失败时旧缓存保留。
#[tauri::command(async)]
pub fn wb_qoder_models_refresh(
    state: tauri::State<'_, Qoder>,
) -> Result<Vec<ModelInfo>, String> {
    let mut account = {
        let mut inner = state.lock()?;
        inner.ensure_loaded();
        crate::qd_pool::first(&inner.accounts, now_secs())
            .map(|index| inner.accounts[index].clone())
            .or_else(|| inner.accounts.iter().find(|item| item.enabled).cloned())
            .ok_or_else(|| "没有可用的账号：先登录一个再拉模型目录".to_string())?
    };
    if account.needs_refresh() {
        crate::qd_auth::refresh(&mut account)?;
        let mut inner = state.lock()?;
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == account.uid) {
            slot.access_token = account.access_token.clone();
            slot.refresh_token = account.refresh_token.clone();
            slot.expires_at = account.expires_at;
        }
        account.save(&crate::paths::qoder_accounts_dir())?;
    }
    let mut cache = crate::qd_sign::CosyCache::default();
    let count = qd_models::refresh(&account, &mut cache)?;
    let _ = count;
    Ok(qd_models::merged())
}

// ---------- 积分 ----------

#[tauri::command(async)]
pub fn wb_qoder_credits(
    state: tauri::State<'_, Qoder>,
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
    if account.needs_refresh() {
        crate::qd_auth::refresh(&mut account)?;
    }
    let credits = qd_credits::fetch(&account);
    // 到期时刻写回账号（选号的第一关键字）；token 也一并写回
    let mut inner = state.lock()?;
    if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == uid) {
        qd_credits::apply_expiry(slot, &credits);
        if !credits.plan.is_empty() {
            slot.plan = credits.plan.clone();
        }
        slot.access_token = account.access_token.clone();
        slot.refresh_token = account.refresh_token.clone();
        slot.expires_at = account.expires_at;
        slot.last_error = credits.error.clone();
        slot.save(&crate::paths::qoder_accounts_dir())?;
    }
    Ok(credits)
}

// ---------- 用量 / 请求 ----------

#[tauri::command(async)]
pub fn wb_qoder_usage(days: i64) -> wb_usage::Summary {
    let since = wb_usage::window_start(days);
    let rows = qd_usage::read_since(since);
    wb_usage::summarize(&rows, BucketUnit::Hour)
}

#[tauri::command(async)]
pub fn wb_qoder_usage_rows(days: i64) -> UsageWindow {
    let since = wb_usage::fetch_start(days);
    UsageWindow {
        since,
        rows: qd_usage::read_since(since),
    }
}

#[tauri::command(async)]
pub fn wb_qoder_usage_recent(limit: usize) -> Vec<crate::wb_usage::UsageRow> {
    qd_usage::read_recent(limit.clamp(1, 1000))
}

// ---------- 签到 / 活动 ----------

#[tauri::command(async)]
pub fn wb_qoder_perks_status(
    state: tauri::State<'_, Qoder>,
    uid: Option<String>,
) -> Result<Vec<TaskSnapshot>, String> {
    let accounts = {
        let mut inner = state.lock()?;
        inner.ensure_loaded();
        match uid {
            Some(uid) => inner
                .accounts
                .iter()
                .filter(|account| account.uid == uid)
                .cloned()
                .collect::<Vec<_>>(),
            None => inner
                .accounts
                .iter()
                .filter(|account| account.enabled)
                .cloned()
                .collect::<Vec<_>>(),
        }
    };
    let mut out = Vec::new();
    for mut account in accounts {
        if account.needs_refresh() {
            let _ = crate::qd_auth::refresh(&mut account);
        }
        let checkin = qd_tasks::checkin_status(&account);
        let campaigns_value = qd_tasks::campaigns(&account);
        let credits = qd_credits::fetch(&account);
        let mut inner = state.lock()?;
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == account.uid) {
            qd_credits::apply_expiry(slot, &credits);
            if !credits.plan.is_empty() {
                slot.plan = credits.plan.clone();
            }
            let _ = slot.save(&crate::paths::qoder_accounts_dir());
        }
        out.push(TaskSnapshot {
            account: account.label(),
            uid: account.uid.clone(),
            checkin,
            campaigns: campaigns_value,
            credits: Some(credits),
            error: String::new(),
        });
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn wb_qoder_checkin(
    state: tauri::State<'_, Qoder>,
    uid: String,
) -> Result<ClaimResult, String> {
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
    if account.needs_refresh() {
        crate::qd_auth::refresh(&mut account)?;
    }
    let result = qd_tasks::checkin(&mut account);
    let mut inner = state.lock()?;
    if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == uid) {
        slot.last_checkin = account.last_checkin.clone();
        slot.access_token = account.access_token.clone();
        slot.refresh_token = account.refresh_token.clone();
        slot.expires_at = account.expires_at;
        slot.save(&crate::paths::qoder_accounts_dir())?;
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn wb_qoder_claim_campaigns(
    state: tauri::State<'_, Qoder>,
    uid: String,
) -> Result<ClaimResult, String> {
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
    if account.needs_refresh() {
        crate::qd_auth::refresh(&mut account)?;
    }
    let result = qd_tasks::claim_campaigns(&mut account);
    let mut inner = state.lock()?;
    if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == uid) {
        slot.campaign_codes = account.campaign_codes.clone();
        slot.save(&crate::paths::qoder_accounts_dir())?;
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn wb_qoder_credit_heatmap(
    state: tauri::State<'_, Qoder>,
    uid: String,
) -> Result<Vec<HeatmapPoint>, String> {
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
    if account.needs_refresh() {
        let _ = crate::qd_auth::refresh(&mut account);
    }
    Ok(qd_tasks::credit_usage(&account))
}

#[tauri::command(async)]
pub fn wb_qoder_activity_today() -> Vec<ActivityRow> {
    qd_tasks::activity_today()
}

/// 最近 N 天每天领到的积分（本机 + 同步仓库里别的设备，按日合并去重）。
#[tauri::command(async)]
pub fn wb_qoder_earnings(days: i64, repo: String, device: String) -> Vec<EarningPoint> {
    let since = crate::wb_usage::window_start(days.clamp(1, 365));
    let mut rows = qd_tasks::earning_rows(since);
    if !repo.trim().is_empty() {
        if let Ok(remote) = crate::sync::read_qoder_earnings(&repo, &device, since) {
            rows.extend(remote);
        }
    }
    qd_tasks::aggregate_earnings(&rows, since)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerksAutoConfig {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerksAutoRun {
    pub ran: usize,
    pub credits: i64,
    pub failed: usize,
    pub message: String,
}

#[tauri::command(async)]
pub fn wb_qoder_perks_auto_config() -> PerksAutoConfig {
    PerksAutoConfig {
        enabled: qd_tasks::load_perks().enabled,
    }
}

#[tauri::command(async)]
pub fn wb_qoder_perks_auto_set(enabled: bool) -> Result<PerksAutoConfig, String> {
    let mut config = qd_tasks::load_perks();
    config.enabled = enabled;
    qd_tasks::save_perks(&config)?;
    Ok(PerksAutoConfig { enabled })
}

#[tauri::command(async)]
pub fn wb_qoder_perks_auto_run(
    state: tauri::State<'_, Qoder>,
) -> Result<PerksAutoRun, String> {
    let mut accounts = {
        let mut inner = state.lock()?;
        inner.ensure_loaded();
        inner.accounts.clone()
    };
    let (ran, credits, failed, message) = qd_tasks::auto_run(&mut accounts);
    let mut inner = state.lock()?;
    for account in &accounts {
        if let Some(slot) = inner.accounts.iter_mut().find(|item| item.uid == account.uid) {
            slot.last_checkin = account.last_checkin.clone();
            slot.access_token = account.access_token.clone();
            slot.refresh_token = account.refresh_token.clone();
            slot.expires_at = account.expires_at;
        }
    }
    Ok(PerksAutoRun {
        ran,
        credits,
        failed,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 账号视图不含_token() {
        let account = Account::from_login("u1", "昵称", "dt-secret", "drt-secret", 0, "", "", "");
        let view = view_of(&account, now_secs());
        let text = serde_json::to_string(&view).unwrap_or_default();
        assert!(!text.contains("dt-secret"));
        assert!(!text.contains("drt-secret"));
        assert!(text.contains("昵称"));
    }

    #[test]
    fn 默认状态是停止的() {
        let qoder = Qoder::default();
        let status = qoder.status().unwrap_or_else(|err| panic!("{err}"));
        assert!(!status.running);
    }

    #[test]
    fn 配置缺字段时按默认值补齐() {
        let config: Config =
            serde_json::from_str(r#"{"port": 17879}"#).unwrap_or_default();
        assert!(config.auto_start);
        assert_eq!(config.port, 17879);
    }

    #[test]
    fn 导入按开关跳过或覆盖已有账号() {
        let existing = vec![Account::from_login("u1", "n", "old", "r", 0, "", "", "")];
        let mut incoming = Account::from_login("u1", "n", "new", "r", 0, "", "", "");
        incoming.access_token = "new".into();
        let fresh = Account::from_login("u2", "n", "t", "r", 0, "", "", "");

        let (plan, result) = plan_import(&existing, vec![incoming.clone()], false);
        assert!(plan.is_empty(), "跳过时不产生写入");
        assert_eq!(
            result,
            ImportResult {
                added: 0,
                updated: 0,
                skipped: 1,
            }
        );

        let (plan, result) = plan_import(&existing, vec![incoming, fresh], true);
        assert_eq!(plan.len(), 2);
        assert_eq!(
            result,
            ImportResult {
                added: 1,
                updated: 1,
                skipped: 0,
            }
        );
    }
}
