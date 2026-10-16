//! 禅道 REST API：只保管内存 token、请求单页并做隐私白名单投影。
//! 分页汇总、字段收敛、排序与新增 Bug 判定由 TS 负责；后台线程只定时唤醒 TS。
//! 凭据由构建期配置提供，token 不序列化、不落盘。

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::http::{self, Response};
use crate::notify;

const WATCH_TICK: Duration = Duration::from_secs(60);
const CHECK_EVENT: &str = "zentao:check";
const NOTIFY_CLICK_EVENT: &str = "zentao:notify-click";

/// 后台检查周期的上下限（分钟）：与 @workbench/zentao 的 sanitizeZentaoPollMinutes 同口径。
const POLL_MIN_MINUTES: u32 = 1;
const POLL_MAX_MINUTES: u32 = 1440;
/// 通知正文（首条 Bug 标题）的字数上限：toast 就两行，长了也显示不下。
const NOTIFY_TITLE_MAX: usize = 120;
/// 通知里汇总条数的上限：防止上游异常数据把通知写成天文数字
const NOTIFY_COUNT_MAX: u32 = 10_000;

const AUTH_EXPIRED: &str = "ZENTAO_AUTH_EXPIRED:禅道登录已失效，请重新登录";
const CANCELLED: &str = "禅道登录已取消或被新的登录替代";
const INVALID_RESPONSE: &str = "禅道返回的数据格式不正确";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub base_url: String,
    pub account: String,
}

// 不派生 Serialize / Debug，防止 token 随响应或诊断输出泄漏。
#[derive(Clone)]
struct Session {
    info: SessionInfo,
    token: String,
}

#[derive(Default)]
struct Inner {
    epoch: u64,
    session: Option<Session>,
}

#[derive(Default)]
pub struct ZentaoState(Mutex<Inner>);

/// 渲染层登记的检查周期（分钟，0 = 关闭）。后台线程只读它决定发不发检查事件 ——
/// 取数、比新增与弹通知都是渲染层的事（线程不做网络，见文件头）。
#[derive(Default)]
pub struct ZentaoWatch {
    config: Mutex<WatchConfig>,
}

#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
struct WatchConfig {
    poll_minutes: u32,
    /// 上次发出检查事件的时刻；None = 还没发过（下一眼就到点）
    last_emit: Option<Instant>,
}

impl ZentaoWatch {
    fn lock(&self) -> Result<MutexGuard<'_, WatchConfig>, String> {
        self.config.lock().map_err(|_| "禅道监视暂不可用".into())
    }
}

impl ZentaoState {
    fn lock(&self) -> Result<MutexGuard<'_, Inner>, String> {
        self.0.lock().map_err(|_| "禅道会话暂不可用".into())
    }
}

impl Inner {
    /// 开始登录即占一代；失败也不让更早的登录回来覆盖。
    fn reserve(&mut self) -> Result<u64, String> {
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or("禅道会话编号已用尽，请重启应用")?;
        Ok(self.epoch)
    }

    fn finish_login(
        &mut self,
        epoch: u64,
        result: Result<Session, String>,
    ) -> Result<SessionInfo, String> {
        if self.epoch != epoch {
            return Err(CANCELLED.into());
        }
        let session = result?;
        let info = session.info.clone();
        self.session = Some(session);
        Ok(info)
    }

    fn require_session(&self, id: &str) -> Result<&Session, String> {
        match &self.session {
            Some(session) if session.info.id == id => Ok(session),
            Some(_) => Err("禅道会话已变更，请重试".into()),
            None => Err(AUTH_EXPIRED.into()),
        }
    }

    /// 旧 id 不能注销新会话；尚无会话时空 id 用于取消第一次在途登录。
    fn logout(&mut self, id: &str) -> Result<(), String> {
        let matches = match &self.session {
            Some(session) => session.info.id == id,
            None => id.is_empty(),
        };
        if !matches {
            return Err("禅道会话已变更，请重试".into());
        }
        self.reserve()?;
        self.session = None;
        Ok(())
    }

    fn finish_page(
        &mut self,
        id: &str,
        result: Result<Response, String>,
        bugs: bool,
    ) -> Result<Value, String> {
        // 包括失败回包在内都先校验：旧请求不能报告新会话过期或回传旧账号数据。
        self.require_session(id)?;
        let response = result.map_err(|_| "连接禅道失败，请检查地址与网络".to_string())?;
        if response.status == 401 {
            self.session = None;
            // 只摘掉同 id 的 token，不取消另一代正在进行的登录。
            return Err(AUTH_EXPIRED.into());
        }
        let value = response_json(response)?;
        project_page(value, bugs)
    }

    /// 同上，但回的是**原始 JSON**（详情 / 用户 / 版本这些各有各的形状，投影交给调用方）。
    fn finish_json(&mut self, id: &str, result: Result<Response, String>) -> Result<Value, String> {
        self.require_session(id)?;
        let response = result.map_err(|_| "连接禅道失败，请检查地址与网络".to_string())?;
        if response.status == 401 {
            self.session = None;
            return Err(AUTH_EXPIRED.into());
        }
        response_json(response)
    }
}

/// 支持部署根目录或浏览器中的完整 my-work*.html 地址；统一回不带尾斜杠的根。
fn normalize_base_url(raw: &str) -> Result<String, String> {
    let invalid = || "禅道地址无效，请填写 http:// 或 https:// 部署根地址".to_string();
    // URL 解析器会自动丢控制字符、修正反斜杠，必须在它修正之前拒绝。
    if raw.chars().any(char::is_control) || raw.contains(['\\', '?', '#']) {
        return Err(invalid());
    }
    let text = raw.trim();
    let (_, rest) = text.split_once("://").ok_or_else(invalid)?;
    let authority = rest.split('/').next().ok_or_else(invalid)?;
    if authority.is_empty() || authority.contains('@') || authority.ends_with(':') {
        return Err(invalid());
    }
    let mut url = Url::parse(text).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err(invalid());
    }
    // 百分号编码也不能把 NUL / 换行等藏进部署路径。
    let decoded = percent_encoding::percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| invalid())?;
    if decoded.chars().any(char::is_control) || decoded.contains('\\') {
        return Err(invalid());
    }
    let path = url.path().trim_end_matches('/');
    let last = path.rsplit('/').next().unwrap_or("");
    let root = if last.starts_with("my-work") && last.ends_with(".html") {
        path.rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("")
    } else if last.ends_with(".html") || last.ends_with(".php") {
        return Err(invalid());
    } else {
        path
    };
    // set_path 会保留已有百分号编码，URL 库负责域名、端口与路径规范化。
    let root = root.to_string();
    url.set_path(&root);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn api_url(base_url: &str, endpoint: &str) -> String {
    format!("{base_url}/api.php/v1/{endpoint}")
}

/// 列表筛选允许的 browseType（与 @workbench/zentao 的 ZENTAO_BROWSE_OPTIONS 一致）。
/// **白名单**：这个值是渲染层递进来的，绝不能直接拼进 URL。
fn browse_of(raw: &str) -> Result<&'static str, String> {
    match raw {
        "assigntome" => Ok("assigntome"),
        "unresolved" => Ok("unresolved"),
        "unclosed" => Ok("unclosed"),
        _ => Err("禅道列表筛选值无效".into()),
    }
}

fn page_url(
    base_url: &str,
    product_id: Option<u64>,
    page: u32,
    browse: &str,
) -> Result<String, String> {
    if page == 0 || product_id == Some(0) {
        return Err("禅道页码或产品编号无效".into());
    }
    let endpoint = match product_id {
        Some(id) => {
            let browse = browse_of(browse)?;
            format!("products/{id}/bugs?status={browse}&order=id_desc&limit=100&page={page}")
        }
        None => format!("products?status=all&limit=100&page={page}"),
    };
    Ok(api_url(base_url, &endpoint))
}

fn response_json(response: Response) -> Result<Value, String> {
    match response.status {
        200..=299 => serde_json::from_slice(&response.body).map_err(|_| INVALID_RESPONSE.into()),
        401 => Err(AUTH_EXPIRED.into()),
        300..=399 => Err("禅道地址发生重定向，请填写最终部署地址".into()),
        403 => Err("没有权限访问禅道数据".into()),
        _ => Err("禅道请求失败，请检查地址、账号或稍后重试".into()),
    }
}

fn login_with<F>(
    state: &ZentaoState,
    base_url: &str,
    account: &str,
    password: &str,
    request: F,
) -> Result<SessionInfo, String>
where
    F: FnOnce(&str, &str, &[(&str, &str)], Option<&str>) -> Result<Response, String>,
{
    let epoch = state.lock()?.reserve()?;
    let result = (|| {
        let base_url = normalize_base_url(base_url)?;
        let account = account.trim();
        if account.is_empty()
            || password.is_empty()
            || account.chars().any(char::is_control)
            || password.contains('\0')
        {
            return Err("请填写有效的禅道账号与密码".into());
        }
        let body = json!({ "account": account, "password": password }).to_string();
        // 不持锁发请求；临时 JSON 不向渲染层或日志暴露。
        let response = request(
            "POST",
            &api_url(&base_url, "tokens"),
            &[
                ("Accept", "application/json"),
                ("Content-Type", "application/json"),
            ],
            Some(&body),
        )
        .map_err(|_| "连接禅道失败，请检查地址与网络".to_string())?;
        let value = response_json(response)?;
        let token = value
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| {
                !token.is_empty() && token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            })
            .ok_or_else(|| INVALID_RESPONSE.to_string())?;
        Ok(Session {
            info: SessionInfo {
                id: epoch.to_string(),
                base_url,
                account: account.to_string(),
            },
            token: token.to_string(),
        })
    })();
    state.lock()?.finish_login(epoch, result)
}

pub fn login(state: &ZentaoState) -> Result<SessionInfo, String> {
    let config = crate::oauth::zentao_config()?;
    login_with(
        state,
        &config.base_url,
        &config.account,
        &config.password,
        http::request_url_no_redirects,
    )
}

pub fn session(state: &ZentaoState) -> Result<Option<SessionInfo>, String> {
    Ok(state
        .lock()?
        .session
        .as_ref()
        .map(|session| session.info.clone()))
}

pub fn logout(state: &ZentaoState, session_id: &str) -> Result<(), String> {
    state.lock()?.logout(session_id)
}

fn page_with<F>(
    state: &ZentaoState,
    session_id: &str,
    product_id: Option<u64>,
    page: u32,
    browse: &str,
    request: F,
) -> Result<Value, String>
where
    F: FnOnce(&str, &str, &[(&str, &str)], Option<&str>) -> Result<Response, String>,
{
    let session = state.lock()?.require_session(session_id)?.clone();
    let url = page_url(&session.info.base_url, product_id, page, browse)?;
    let result = request(
        "GET",
        &url,
        &[("Accept", "application/json"), ("Token", &session.token)],
        None,
    );
    state
        .lock()?
        .finish_page(session_id, result, product_id.is_some())
}

pub fn page(
    state: &ZentaoState,
    session_id: &str,
    product_id: Option<u64>,
    page: u32,
    browse: &str,
) -> Result<Value, String> {
    page_with(
        state,
        session_id,
        product_id,
        page,
        browse,
        http::request_url_no_redirects,
    )
}

/// 读原始 JSON：一次单页 GET，会话匹配，401 清会话。调用方自己投影字段。
fn read_json<F>(
    state: &ZentaoState,
    session_id: &str,
    url: String,
    request: F,
) -> Result<Value, String>
where
    F: FnOnce(&str, &str, &[(&str, &str)], Option<&str>) -> Result<Response, String>,
{
    let session = state.lock()?.require_session(session_id)?.clone();
    let result = request(
        "GET",
        &url,
        &[("Accept", "application/json"), ("Token", &session.token)],
        None,
    );
    state.lock()?.finish_json(session_id, result)
}

/// 账号可见产品的 id 清单。
///
/// **为什么不用 `GET /v1/products`**：那条走 `product/all`，在「研发综合版」这类把产品挂在
/// 项目集 / 项目下的部署里会返回空数组（实测本部署就是 0 条），于是列表一条都取不到。
/// 改为以账号资料里已经算好的 `profile.view.products`（逗号分隔的 id）为准；万一是空
/// （或写成 `all` 之类的非数字），再退回 `/v1/products` 枚举。
pub fn products(state: &ZentaoState, session_id: &str) -> Result<Value, String> {
    let session = state.lock()?.require_session(session_id)?.clone();
    let user = read_json(
        state,
        session_id,
        api_url(&session.info.base_url, "user"),
        http::request_url_no_redirects,
    )?;
    let ids = product_ids_of(&user);
    if ids.is_empty() {
        let page = read_json(
            state,
            session_id,
            api_url(&session.info.base_url, "products?limit=500&page=1"),
            http::request_url_no_redirects,
        )?;
        return project_products(&page);
    }
    // 只回 id：产品名按需再取（见 product()），省掉一堆没有 Bug 的产品的请求
    let rows: Vec<Value> = ids.iter().map(|id| json!({ "id": id })).collect();
    let total = rows.len();
    Ok(json!({ "page": 1, "total": total, "limit": total, "products": rows }))
}

/// 单个产品（**只回 id 与名称**）：`GET /api.php/v1/products/{id}`，用于补产品名。
pub fn product(state: &ZentaoState, session_id: &str, product_id: u64) -> Result<Value, String> {
    if product_id == 0 {
        return Err("禅道产品编号无效".into());
    }
    let session = state.lock()?.require_session(session_id)?.clone();
    let url = api_url(&session.info.base_url, &format!("products/{product_id}"));
    let value = read_json(state, session_id, url, http::request_url_no_redirects)?;
    Ok(project_product(&value))
}

/// 单个产品 → 只留 `{id, name}`（名称缺失给空串）。
fn project_product(value: &Value) -> Value {
    let mut out = Map::new();
    if let Some(id) = value.get("id") {
        if !id.is_array() && !id.is_object() {
            out.insert("id".into(), id.clone());
        }
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    out.insert("name".into(), Value::String(name));
    Value::Object(out)
}

/// `/v1/user` → `profile.view.products`（逗号分隔）里的正整数 id，去重保序。
fn product_ids_of(user: &Value) -> Vec<u64> {
    let text = user
        .get("profile")
        .and_then(|profile| profile.get("view"))
        .and_then(|view| view.get("products"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut seen = std::collections::HashSet::new();
    text.split(',')
        .filter_map(|part| part.trim().parse::<u64>().ok())
        .filter(|id| *id > 0)
        .filter(|id| seen.insert(*id))
        .collect()
}

/// `/v1/products` 那一页 → 只留 `{id, name}`（名称缺失就空串）。
fn project_products(value: &Value) -> Result<Value, String> {
    let rows = value
        .get("products")
        .and_then(Value::as_array)
        .ok_or_else(|| INVALID_RESPONSE.to_string())?;
    let rows = rows
        .iter()
        .map(|row| {
            let id = row.get("id").ok_or_else(|| INVALID_RESPONSE.to_string())?;
            if id.is_array() || id.is_object() {
                return Err(INVALID_RESPONSE.to_string());
            }
            let name = row.get("name").and_then(Value::as_str).unwrap_or("");
            Ok(json!({ "id": id, "name": name }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut out = project_fields(value, &["page", "total", "limit"])?;
    out.insert("products".into(), Value::Array(rows));
    Ok(Value::Object(out))
}

/// 登记后台检查周期（分钟，0 = 关闭）。就绪判定与邮件监视同一条：
/// **关闭着永远不到点；重新启用立即来一轮**（给渲染层一次建立基线的机会，
/// 否则启用后的第一轮会把启用前的存量 Bug 全报成新增）；**改间隔从现在重新计时**。
pub fn register(watch: &ZentaoWatch, poll_minutes: u32) -> Result<(), String> {
    let minutes = sanitize_poll_minutes(poll_minutes);
    let mut config = watch.lock()?;
    if minutes == config.poll_minutes {
        // 周期没变（设置里改别的项也会重登一次）：不动计时，别把「刚查过」重置掉
        return Ok(());
    }
    config.last_emit = if minutes == 0 || config.poll_minutes == 0 {
        None
    } else {
        Some(Instant::now())
    };
    config.poll_minutes = minutes;
    Ok(())
}

/// 周期的收敛（与渲染层 sanitizeZentaoPollMinutes 同一条）：0 = 关闭原样放行，
/// 其余夹进下限..上限。
fn sanitize_poll_minutes(raw: u32) -> u32 {
    if raw == 0 {
        return 0;
    }
    raw.clamp(POLL_MIN_MINUTES, POLL_MAX_MINUTES)
}

/// 到点没有：关着永远不到点；还没发过（刚启用）算到点。
fn is_due(config: &WatchConfig, now: Instant) -> bool {
    if config.poll_minutes == 0 {
        return false;
    }
    match config.last_emit {
        Some(last) => {
            now.duration_since(last) >= Duration::from_secs(u64::from(config.poll_minutes) * 60)
        }
        None => true,
    }
}

/// 起计时线程（main.rs 的 setup 里调，全进程一个）。渲染层登记周期之前它只睡 ——
/// 默认（没登记）就是关着。这一层只发「该查了」的事件，取数与新增判定在渲染层。
pub fn spawn(app: &AppHandle) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("zentao-watch".into())
        .spawn(move || loop {
            std::thread::sleep(WATCH_TICK);
            tick(&handle);
        });
    if let Err(err) = spawned {
        eprintln!("[workbench] 禅道检查线程起不来：{err}");
    }
}

/// 一眼：到点就给主窗口发一条检查事件，并把时刻推到现在。
/// 先记账后发（发失败也等下一个周期）——与邮件监视同一条口径，不把事件摁着打。
fn tick(app: &AppHandle) {
    let now = Instant::now();
    let due = {
        let state = app.state::<ZentaoWatch>();
        let Ok(mut config) = state.lock() else {
            return;
        };
        if !is_due(&config, now) {
            return;
        }
        config.last_emit = Some(now);
        true
    };
    if due {
        // 不持锁发事件：渲染层的处理会回头调这个模块的命令
        let _ = app.emit(CHECK_EVENT, ());
    }
}

/// 渲染层比出新增之后调它弹系统通知（条数与首条标题由渲染层给，都不是机密）。
///
/// 会话对不上就拒（后台那一轮可能在换配置之后才回来）：通知是「当前这个账号」的事，
/// 不能顶着新会话的名头弹旧数据。文案与提示音：标题用设置里的程序名（与邮件通知同一份），
/// 正文点出条数与第一条标题 —— 标题里的换行 / 控制字符压成空格，XML 转义在 notify.rs。
pub fn notify_new_bugs(
    app: &AppHandle,
    state: &ZentaoState,
    session_id: &str,
    count: u32,
    title: &str,
) -> Result<(), String> {
    {
        let guard = state.lock()?;
        guard.require_session(session_id)?;
    }
    let count = count.clamp(1, NOTIFY_COUNT_MAX);
    let title = sanitize_notify_title(title);
    let body = if title.is_empty() {
        format!("禅道有 {count} 个新 Bug")
    } else {
        format!("禅道有 {count} 个新 Bug：{title}")
    };
    let aumid = app.config().identifier.clone();
    let name = crate::mail_watch::display_name(app);
    let handle = app.clone();
    notify::ensure_aumid_shortcut(&aumid, app.package_info().name.as_str())?;
    // 提示音用系统默认那个：禅道跟新邮件混成一种声音就没法凭耳朵分了
    notify::show_toast_with_sound(&aumid, &name, &body, notify::SOUND_DEFAULT, move || {
        // 点击：唤出主窗口 + 发事件（渲染层换到禅道页；那儿的列表刚被这一轮检查刷过）
        crate::show_main_window(&handle);
        let _ = handle.emit(NOTIFY_CLICK_EVENT, ());
    })
}

/// 通知正文里的 Bug 标题：控制字符压成空格、连续空白合成一个、超长截断 ——
/// toast 就两行，标题里的换行会把版式顶坏。
fn sanitize_notify_title(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let mut text = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > NOTIFY_TITLE_MAX {
        text = text.chars().take(NOTIFY_TITLE_MAX).collect();
    }
    text
}

/// 白名单只复制标量原值；不转数字、不填默认值、不排序，也不返回未登记字段的嵌套内容。
fn project_fields(value: &Value, fields: &[&str]) -> Result<Map<String, Value>, String> {
    let source = value
        .as_object()
        .ok_or_else(|| INVALID_RESPONSE.to_string())?;
    let mut out = Map::new();
    for &field in fields {
        if let Some(value) = source.get(field) {
            if value.is_array() || value.is_object() {
                return Err(INVALID_RESPONSE.into());
            }
            out.insert(field.into(), value.clone());
        }
    }
    Ok(out)
}

fn project_page(value: Value, bugs: bool) -> Result<Value, String> {
    let (key, fields): (&str, &[&str]) = if bugs {
        (
            "bugs",
            &["id", "title", "status", "severity", "pri", "openedDate"],        )
    } else {
        ("products", &["id", "name"])
    };
    let rows = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| INVALID_RESPONSE.to_string())?;
    let rows = rows
        .iter()
        .map(|row| {
            let mut out = project_fields(row, fields)?;
            if bugs {
                // assignedTo / openedBy 被 v1 格式化成用户对象（format 'assignedTo:user'），
                // 压成一句可显示的文本再回渲染层；对象直接投影会被 project_fields 拒掉
                for field in ["assignedTo", "openedBy"] {
                    if let Some(raw) = row.get(field) {
                        out.insert(field.into(), Value::String(user_text(raw)));
                    }
                }
            }
            Ok(Value::Object(out))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut out = project_fields(&value, &["page", "total", "limit"])?;
    out.insert(key.into(), Value::Array(rows));
    Ok(Value::Object(out))
}

/// 用户类字段 → 一句可显示的文本：真实姓名优先、退回账号；非字符串 / 对象一律给空串。
fn user_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Object(map) => ["realname", "account", "name"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str))
            .map(|text| text.trim().to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, value: Value) -> Response {
        Response {
            status,
            body: value.to_string().into_bytes(),
            etag: None,
            location: None,
        }
    }

    fn mock_login(state: &ZentaoState, account: &str) -> SessionInfo {
        login_with(
            state,
            "https://zentao.example/zentao",
            account,
            "password",
            |_, _, _, _| {
                Ok(response(
                    201,
                    json!({ "token": "secret-token", "password": "must-not-return" }),
                ))
            },
        )
        .unwrap()
    }

    /// 单页只读入口（账号资料 / 产品清单 / 单个产品）走的是「会话匹配 + 只发到站内固定端点」这条路径。
    #[test]
    fn read_endpoints_use_fixed_paths_and_match_the_session() {
        let state = ZentaoState::default();
        let info = mock_login(&state, "account");

        for (label, url) in [
            ("产品清单", "https://zentao.example/zentao/api.php/v1/products?limit=500&page=1"),
            ("单个产品", "https://zentao.example/zentao/api.php/v1/products/17"),
        ] {
            let value = read_json(&state, &info.id, url.to_string(), |method, got, headers, body| {
                assert!(state.0.try_lock().is_ok(), "请求期间不能持锁：{label}");
                assert_eq!(method, "GET");
                assert!(body.is_none());
                assert!(headers.contains(&("Token", "secret-token")));
                assert_eq!(got, url, "{label} 地址必须由后端拼");
                Ok(response(200, json!({ "id": "7", "token": "leak" })))
            })
            .unwrap();
            // 只读入口透传原始 JSON，投影在 TS 侧；这里只确认它没被包成别的形状
            assert_eq!(value["id"], "7", "{label}");
        }

        // 旧会话不能读到新会话的数据
        assert!(read_json(&state, "stale", "https://x/y".into(), |_, _, _, _| Ok(response(
            200,
            json!({})
        )))
        .is_err());
    }

    /// 产品清单：优先用账号资料里的 view.products（/v1/products 在本部署下是空的）。
    #[test]
    fn product_ids_come_from_the_user_profile() {
        let user = json!({ "profile": { "view": { "products": "1,2, 3,2" } } });
        assert_eq!(product_ids_of(&user), vec![1, 2, 3], "去重且保序");
        assert!(product_ids_of(&json!({ "profile": {} })).is_empty());
        assert!(product_ids_of(&json!({ "profile": { "view": { "products": "all" } } })).is_empty());
        assert!(product_ids_of(&json!({})).is_empty());
        // 0 与负数不是产品号
        assert_eq!(product_ids_of(&json!({ "profile": { "view": { "products": "0,-1,7" } } })), vec![7]);
    }

    /// 列表里的用户字段被 v1 格式化成对象：必须压成文本，否则对象投影会被拒。
    #[test]
    fn bug_rows_flatten_user_objects_to_text() {
        let value = project_page(json!({
            "bugs": [{
                "id": "285", "title": "体温单", "status": "active", "severity": "3", "pri": "3",
                "openedDate": "2026-10-15 13:21:25",
                "assignedTo": { "id": "2", "account": "yangfeng", "realname": "杨峰", "avatar": "secret" }
            }],
            "page": 1, "total": "1", "limit": 100
        }), true).unwrap();
        assert_eq!(value["bugs"][0]["assignedTo"], "杨峰", "真实姓名优先");
        assert_eq!(value["bugs"][0]["id"], "285");
        // 字符串形态原样保留；缺失给空串
        assert_eq!(user_text(&json!("alice")), "alice");
        assert_eq!(user_text(&json!({ "account": "bob" })), "bob");
        assert_eq!(user_text(&json!(7)), "");
        assert_eq!(user_text(&json!(["x"])), "");
    }

    /// 单个产品只回 id 与名称（名称缺失给空串，绝不把整份产品丢回去）。
    #[test]
    fn single_product_projection_keeps_only_id_and_name() {
        let value = json!({ "id": "17", "name": "巩留县人民医院重症系统", "desc": "secret", "whitelist": ["a"] });
        let out = project_product(&value);
        assert_eq!(out, json!({ "id": "17", "name": "巩留县人民医院重症系统" }));
        let out2 = project_product(&json!({ "id": "3" }));
        assert_eq!(out2, json!({ "id": "3", "name": "" }));
    }

    #[test]
    fn normalizes_deployment_roots_and_my_work_urls() {
        for (raw, expected) in [
            ("https://zentao.example", "https://zentao.example"),
            (
                " https://zentao.example/zentao/// ",
                "https://zentao.example/zentao",
            ),
            (
                "https://zentao.example/zentao/my-work.html",
                "https://zentao.example/zentao",
            ),
            (
                "http://localhost:8080/team/zentao/my-work-bug.html",
                "http://localhost:8080/team/zentao",
            ),
            (
                "http://127.0.0.1:8080/my-work.html",
                "http://127.0.0.1:8080",
            ),
            ("HTTP://ZENTAO.EXAMPLE:80/", "http://zentao.example"),
            ("http://[::1]:8080/zentao/", "http://[::1]:8080/zentao"),
            (
                "https://zentao.example/%E7%A6%85%E9%81%93/",
                "https://zentao.example/%E7%A6%85%E9%81%93",
            ),
        ] {
            assert_eq!(normalize_base_url(raw).unwrap(), expected, "{raw}");
        }
    }

    #[test]
    fn rejects_invalid_or_ambiguous_urls_before_network() {
        for raw in [
            "",
            "zentao.example",
            "file:///zentao",
            "ftp://zentao.example",
            "https:///zentao",
            "https://",
            "https://user@zentao.example",
            "https://user:pass@zentao.example",
            "https://@zentao.example",
            "https://zentao.example?",
            "https://zentao.example/#",
            "https://zentao.example/my-work.html?token=secret",
            "https://zentao.example:0",
            "https://zentao.example:65536",
            "https://zentao.example:",
            "https://zentao.example:bad",
            "https://zentao.example\0.evil",
            "https://zentao.example/\nzentao",
            "https://zentao.example/%00",
            "https://zentao.example/%0d%0a",
            "https://zentao.example\\@evil.example",
            "https://zentao.example/index.php",
            "https://zentao.example/user-login.html",
        ] {
            assert!(normalize_base_url(raw).is_err(), "应拒绝 {raw:?}");
            assert!(login_with(
                &ZentaoState::default(),
                raw,
                "account",
                "password",
                |_, _, _, _| { panic!("非法地址不应发请求") }
            )
            .is_err());
        }
    }

    #[test]
    fn builds_only_fixed_single_page_endpoints() {
        assert_eq!(
            page_url("https://zentao.example/zentao", None, 2, "assigntome").unwrap(),
            "https://zentao.example/zentao/api.php/v1/products?status=all&limit=100&page=2"
        );
        assert_eq!(page_url("https://zentao.example/zentao", Some(7), 3, "assigntome").unwrap(),
            "https://zentao.example/zentao/api.php/v1/products/7/bugs?status=assigntome&order=id_desc&limit=100&page=3");
        assert_eq!(page_url("https://zentao.example/zentao", Some(7), 1, "unresolved").unwrap(),
            "https://zentao.example/zentao/api.php/v1/products/7/bugs?status=unresolved&order=id_desc&limit=100&page=1");
        assert!(page_url("https://zentao.example", None, 0, "assigntome").is_err());
        assert!(page_url("https://zentao.example", Some(0), 1, "assigntome").is_err());
        // browse 是渲染层递进来的：只认白名单，别的拼不进 URL
        assert!(page_url("https://zentao.example", Some(7), 1, "all").is_err());
        assert!(page_url("https://zentao.example", Some(7), 1, "x&status=all").is_err());
    }

    #[test]
    fn token_is_private_and_only_attached_to_page_requests() {
        let state = ZentaoState::default();
        let info = login_with(
            &state,
            "https://zentao.example/",
            " alice ",
            "password",
            |method, url, headers, body| {
                assert!(state.0.try_lock().is_ok(), "请求期间不能持锁");
                assert_eq!(method, "POST");
                assert_eq!(url, "https://zentao.example/api.php/v1/tokens");
                assert!(!headers.iter().any(|(name, _)| *name == "Token"));
                assert_eq!(
                    serde_json::from_str::<Value>(body.unwrap()).unwrap(),
                    json!({ "account": "alice", "password": "password" })
                );
                Ok(response(201, json!({ "token": "private-token" })))
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({ "id": "1", "baseUrl": "https://zentao.example", "account": "alice" })
        );
        assert_eq!(session(&state).unwrap(), Some(info.clone()));
        let value = page_with(&state, &info.id, None, 1, "assigntome", |method, _, headers, body| {
            assert!(state.0.try_lock().is_ok());
            assert_eq!(method, "GET");
            assert!(body.is_none());
            assert!(headers.contains(&("Token", "private-token")));
            Ok(response(200, json!({ "products": [{ "id": "9", "name": "产品", "token": "secret", "description": "内部说明" }], "page": "1", "total": 1, "limit": 100, "token": "secret" })))
        }).unwrap();
        assert_eq!(
            value,
            json!({ "products": [{ "id": "9", "name": "产品" }], "page": "1", "total": 1, "limit": 100 })
        );
    }

    #[test]
    fn bugs_projection_preserves_raw_scalars_and_excludes_private_fields() {
        let value = project_page(json!({
            "bugs": [{ "id": "8", "title": "问题", "status": "active", "severity": "2", "pri": 1, "openedDate": null, "assignedTo": "alice",
                "steps": "secret", "openedBy": "person", "files": ["secret"], "token": "secret" }],
            "page": 1, "total": "1", "limit": 100, "password": "secret", "pager": { "secret": true }
        }), true).unwrap();
        assert_eq!(
            value,
            json!({ "bugs": [{ "id": "8", "title": "问题", "status": "active", "severity": "2", "pri": 1, "openedDate": null, "assignedTo": "alice", "openedBy": "person" }], "page": 1, "total": "1", "limit": 100 })
        );
        assert!(project_page(
            json!({ "products": [{ "name": { "token": "secret" } }] }),
            false
        )
        .is_err());
        assert!(project_page(
            json!({ "products": [], "total": { "token": "secret" } }),
            false
        )
        .is_err());
        assert!(project_page(json!({ "error": "secret" }), false).is_err());
    }

    #[test]
    fn newer_login_wins_and_old_logout_cannot_clear_it() {
        let state = ZentaoState::default();
        let first = mock_login(&state, "first");
        let old = login_with(
            &state,
            "https://zentao.example",
            "old",
            "password",
            |_, _, _, _| {
                let newest = mock_login(&state, "newest");
                assert_ne!(first.id, newest.id);
                Ok(response(201, json!({ "token": "old-token" })))
            },
        );
        assert_eq!(old.unwrap_err(), CANCELLED);
        assert!(logout(&state, &first.id).is_err());
        assert_eq!(session(&state).unwrap().unwrap().account, "newest");
    }

    #[test]
    fn logout_cancels_pending_login_with_or_without_a_session() {
        for existing in [false, true] {
            let state = ZentaoState::default();
            let id = if existing {
                mock_login(&state, "first").id
            } else {
                String::new()
            };
            let result = login_with(
                &state,
                "https://zentao.example",
                "next",
                "password",
                |_, _, _, _| {
                    logout(&state, &id).unwrap();
                    Ok(response(201, json!({ "token": "late-token" })))
                },
            );
            assert_eq!(result.unwrap_err(), CANCELLED);
            assert!(session(&state).unwrap().is_none());
        }
    }

    #[test]
    fn failed_new_login_still_cancels_older_login() {
        let state = ZentaoState::default();
        let old = login_with(
            &state,
            "https://zentao.example",
            "old",
            "password",
            |_, _, _, _| {
                assert!(
                    login_with(&state, "bad-url", "new", "password", |_, _, _, _| panic!(
                        "不得联网"
                    ))
                    .is_err()
                );
                Ok(response(201, json!({ "token": "old-token" })))
            },
        );
        assert_eq!(old.unwrap_err(), CANCELLED);
        assert!(session(&state).unwrap().is_none());
    }

    #[test]
    fn expired_response_only_clears_its_own_session() {
        let state = ZentaoState::default();
        let info = mock_login(&state, "first");
        assert_eq!(
            page_with(&state, &info.id, None, 1, "assigntome", |_, _, _, _| Ok(response(
                401,
                json!({ "secret": true })
            )))
            .unwrap_err(),
            AUTH_EXPIRED
        );
        assert!(session(&state).unwrap().is_none());
        for status in [200, 401] {
            let old = mock_login(&state, "old");
            let result = page_with(&state, &old.id, None, 1, "assigntome", |_, _, _, _| {
                mock_login(&state, "newest");
                Ok(response(
                    status,
                    json!({ "products": [{ "id": 1, "name": "旧账号" }] }),
                ))
            });
            let error = result.unwrap_err();
            assert!(!error.starts_with("ZENTAO_AUTH_EXPIRED:"));
            assert_eq!(session(&state).unwrap().unwrap().account, "newest");
        }
    }

    #[test]
    fn expiry_of_old_session_does_not_cancel_a_new_pending_login() {
        let state = ZentaoState::default();
        let old = mock_login(&state, "old");
        let new = login_with(
            &state,
            "https://zentao.example",
            "new",
            "password",
            |_, _, _, _| {
                assert!(
                    page_with(&state, &old.id, None, 1, "assigntome", |_, _, _, _| Ok(response(
                        401,
                        json!({})
                    )))
                    .is_err()
                );
                Ok(response(201, json!({ "token": "new-token" })))
            },
        )
        .unwrap();
        assert_eq!(session(&state).unwrap(), Some(new));
    }

    #[test]
    fn rejects_redirects_invalid_tokens_and_never_echoes_upstream_errors() {
        for status in [301, 302, 307, 308, 400, 401, 403, 500] {
            let state = ZentaoState::default();
            let error = login_with(
                &state,
                "https://zentao.example",
                "account",
                "password",
                |_, _, _, _| {
                    Ok(response(
                        status,
                        json!({ "token": "secret-token", "error": "private upstream body" }),
                    ))
                },
            )
            .unwrap_err();
            assert!(!error.contains("secret-token") && !error.contains("private upstream body"));
            assert!(session(&state).unwrap().is_none());
        }
        for token in [
            "",
            "token\r\nInjected: secret",
            "token\0",
            "token with space",
            "秘密",
        ] {
            let state = ZentaoState::default();
            assert!(login_with(
                &state,
                "https://zentao.example",
                "account",
                "password",
                |_, _, _, _| { Ok(response(201, json!({ "token": token }))) }
            )
            .is_err());
        }
        let state = ZentaoState::default();
        let error = login_with(
            &state,
            "https://zentao.example",
            "account",
            "password",
            |_, _, _, _| Err("secret transport detail".into()),
        )
        .unwrap_err();
        assert!(!error.contains("secret"));
        let info = mock_login(&state, "account");
        assert!(
            page_with(&state, &info.id, None, 1, "assigntome", |_, _, _, _| Ok(response(
                302,
                json!({ "token": "secret" })
            )))
            .is_err()
        );
        assert_eq!(session(&state).unwrap(), Some(info));
    }

    #[test]
    fn local_validation_logout_and_malformed_json_do_not_expose_secrets() {
        let state = ZentaoState::default();
        assert!(session(&state).unwrap().is_none());
        let info = mock_login(&state, "account");
        for (id, product, page_number) in [
            ("stale", None, 1),
            (info.id.as_str(), None, 0),
            (info.id.as_str(), Some(0), 1),
        ] {
            assert!(page_with(&state, id, product, page_number, "assigntome", |_, _, _, _| {
                panic!("非法会话或分页参数不得发请求")
            })
            .is_err());
        }
        let error = page_with(&state, &info.id, None, 1, "assigntome", |_, _, _, _| {
            Ok(Response {
                status: 200,
                body: b"private invalid JSON".to_vec(),
                etag: None,
                location: None,
            })
        })
        .unwrap_err();
        assert_eq!(error, INVALID_RESPONSE);
        assert_eq!(session(&state).unwrap(), Some(info.clone()));
        logout(&state, &info.id).unwrap();
        assert!(session(&state).unwrap().is_none());
        assert_ne!(mock_login(&state, "account").id, info.id);
    }

    #[test]
    fn epoch_never_wraps_or_reuses_session_ids() {
        let mut inner = Inner {
            epoch: u64::MAX,
            session: None,
        };
        assert!(inner.reserve().is_err());
        assert_eq!(inner.epoch, u64::MAX);
    }

    #[test]
    fn watch_sanitizes_minutes_and_only_restarts_on_change() {
        assert_eq!(sanitize_poll_minutes(0), 0);
        assert_eq!(sanitize_poll_minutes(30), 30);
        assert_eq!(sanitize_poll_minutes(1), 1);
        assert_eq!(sanitize_poll_minutes(1440), 1440);
        assert_eq!(sanitize_poll_minutes(1441), 1440);

        let watch = ZentaoWatch::default();
        // 默认（还没登记）是关着的：永远不到点
        let mut config = *watch.lock().unwrap();
        assert_eq!(config.poll_minutes, 0);
        assert!(!is_due(&config, Instant::now()));

        register(&watch, 30).unwrap();
        config = *watch.lock().unwrap();
        assert_eq!(config.poll_minutes, 30);
        assert!(config.last_emit.is_none(), "刚启用要立即来一轮（先立基线）");
        assert!(is_due(&config, Instant::now()), "启用后立即到点");

        // 模拟线程发过一轮：计时压到现在，此后要等满一个周期
        watch.lock().unwrap().last_emit = Some(Instant::now());
        config = *watch.lock().unwrap();
        assert!(!is_due(&config, Instant::now()), "发过一轮后要等周期");

        // 周期没变（设置里改了别的项也会重登）：计时不动
        let before = config.last_emit;
        register(&watch, 30).unwrap();
        assert_eq!(*watch.lock().unwrap(), WatchConfig { poll_minutes: 30, last_emit: before });

        // 改间隔（两端都非 0）从现在重新计时
        register(&watch, 5).unwrap();
        config = *watch.lock().unwrap();
        assert_eq!(config.poll_minutes, 5);
        assert!(config.last_emit.is_some());
        assert!(!is_due(&config, Instant::now()));

        // 关闭：不再到点；重新启用立即来一轮（先立基线）
        register(&watch, 0).unwrap();
        config = *watch.lock().unwrap();
        assert_eq!(config.poll_minutes, 0);
        assert!(config.last_emit.is_none());
        assert!(!is_due(&config, Instant::now()));
        register(&watch, 30).unwrap();
        config = *watch.lock().unwrap();
        assert!(config.last_emit.is_none());
        assert!(is_due(&config, Instant::now()), "重新启用要立即给一次检查");
    }

    #[test]
    fn watch_is_due_only_after_the_registered_period() {
        let now = Instant::now();
        let config = WatchConfig {
            poll_minutes: 30,
            last_emit: Some(now),
        };
        assert!(!is_due(&config, now));
        assert!(!is_due(&config, now + Duration::from_secs(30 * 60 - 1)));
        assert!(is_due(&config, now + Duration::from_secs(30 * 60)));
        assert!(is_due(&config, now + Duration::from_secs(31 * 60)));
    }

    #[test]
    fn notify_title_is_flattened_and_bounded() {
        assert_eq!(sanitize_notify_title("  登录\n失败\t了  "), "登录 失败 了");
        assert_eq!(sanitize_notify_title("换行\u{7}与控制"), "换行 与控制");
        assert_eq!(sanitize_notify_title(""), "");
        let long = "长".repeat(NOTIFY_TITLE_MAX + 50);
        assert_eq!(sanitize_notify_title(&long).chars().count(), NOTIFY_TITLE_MAX);
    }

    #[test]
    fn notify_requires_the_current_session_and_valid_body() {
        let state = ZentaoState::default();
        let info = mock_login(&state, "account");
        // 会话对不上：后台那一轮可能在换配置之后才回来，不能顶着新会话弹旧数据
        {
            let guard = state.lock().unwrap();
            assert!(guard.require_session("stale").is_err());
            assert!(guard.require_session(&info.id).is_ok());
        }
        // count 为 0 或超大值都被夹进 1..上限（正文由调用方拼，这里只钉输入口径）
        assert_eq!(0u32.clamp(1, NOTIFY_COUNT_MAX), 1);
        assert_eq!(u32::MAX.clamp(1, NOTIFY_COUNT_MAX), NOTIFY_COUNT_MAX);
    }
}
