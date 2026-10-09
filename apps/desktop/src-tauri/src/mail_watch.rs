//! 邮件后台监视：按登记的周期（分钟，渲染层设置里的 mailPollMinutes，0 = 关）
//! 查各账户的新邮件，有未读的新信就弹系统 toast，
//! 点击唤出主窗口并跳到邮箱页（渲染层经 `mail:notify-click` 事件接手）。
//!
//! **联网边界**：这是邮箱那条出口的延伸 —— 账户（地址与两台服务器）由渲染层显式
//! 登记（`mail_watch_register`，清单为空就只睡不查），连接目标仍然只是用户配置的
//! 那台收件服务器，每轮现连现断拉一次最近摘要；授权码照旧只在连接时从凭据管理器
//! 取，不落任何文件。渲染层不参与轮询 —— 窗口收进托盘后 WebView 的定时器会被
//! 节流，靠它计时不诚实，这一层自己用线程醒。
//!
//! **为什么判定在 Rust**：轮询、UID 基准与通知都是这一层的事，渲染层只负责
//! 「登记谁要监视」与「点开通知之后怎么展示」。判法刻意保守：只认 UID 比基准大的
//! **未读**信（手机上读过的不再吵），广告黑名单里的发件人（设置的 `mailBulkSenders`，
//! 用户亲手标过的）一律不弹；`isBulkMail` 那套完整启发式仍在 TS 侧管清单展示，
//! 这里不重复 —— 宁可多弹一条，不在这里学人家判广告。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::mail::{self, Folder, MailSummary};
use crate::fs_util;
use crate::{notify, paths};

/// 轮询周期的下限（分钟）：每一轮都是一条全新的 IMAP 连接，再密就是在给服务器找麻烦。
/// 与 @workbench/mail 的 MAIL_POLL_MIN 同一口径。
const POLL_MIN_MINUTES: u32 = 1;
/// 轮询周期的上限（分钟）：24 小时，再长不如直接关掉。
const POLL_MAX_MINUTES: u32 = 1440;
/// 线程醒来的步长：每分钟看一眼「到点没有」，到点后最多晚一分钟，无碍
const TICK: Duration = Duration::from_secs(60);
/// 一轮盯住最近的多少封（与渲染层的 MAIL_LIST_LIMIT 同一口径）
const WINDOW: usize = 50;
/// 账户上限：与 @workbench/mail 的 MAIL_ACCOUNTS_MAX 一致（渲染层已拦，这里兜底）
const ACCOUNTS_MAX: usize = 5;
/// 广告发件人黑名单上限：与 @workbench/mail 的 MAIL_BULK_SENDERS_MAX 一致
const BULK_SENDERS_MAX: usize = 500;
/// 通知被点后发给渲染层的事件（渲染层换到邮箱页并打开这一封）
const NOTIFY_CLICK_EVENT: &str = "mail:notify-click";

/// 登记进来的一个账户。字段与渲染层的 MailAccount 对齐（camelCase 经 serde 收敛）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchAccount {
    pub address: String,
    pub imap_host: String,
    pub imap_port: u16,
}

/// 渲染层登记的监视清单 + 通知要避开的广告发件人。
#[derive(Default)]
pub struct MailWatch(Mutex<WatchConfig>);

/// 渲染层登记的监视清单 + 通知要避开的广告发件人 + 轮询周期。
#[derive(Default, Clone)]
struct WatchConfig {
    accounts: Vec<WatchAccount>,
    bulk_senders: Vec<String>,
    /// 周期（分钟）：0 = 后台检查关闭（只保留进页面 / 手动刷新的那几次）。
    poll_minutes: u32,
}

/// 一个账户的监视进度：UIDVALIDITY + 上次见过的最大 UID（高水位）。
/// uidvalidity 服务器不报时是 None —— None 与 None 之间照样可比（没证据说明换过茬）。
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AccountMark {
    uidvalidity: Option<u64>,
    last_uid: u64,
}

/// 一轮查出的新邮件：共几封、最新那封的 uid（点通知要打开的就是它）。
#[derive(Debug, PartialEq)]
struct NewBatch {
    count: usize,
    uid: u64,
}

/// 落盘的记账（`data/mail-watch.json`）：每账户的进度 + 上轮检查的时间。
/// 只是通知的凭据，丢了无非多弹或少弹一条，写坏了就当从没查过。
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WatchState {
    last_check: u64,
    accounts: HashMap<String, AccountMark>,
}

impl WatchState {
    fn load() -> Self {
        let Ok(text) = std::fs::read_to_string(paths::mail_watch_file()) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    fn save(&self) {
        let Ok(text) = serde_json::to_string_pretty(self) else {
            return;
        };
        let path = paths::mail_watch_file();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // 与 store.rs 同一个写法：临时文件 + rename，不会留下半个 JSON（实现归 fs_util）
        if let Err(err) = fs_util::write_atomic(&path, text.as_bytes()) {
            eprintln!("[workbench] 邮件监视进度落盘失败: {err}");
        }
    }
}

/// 渲染层把账户清单、广告黑名单与轮询周期交给后台监视。任何一项变了就整份重登 ——
/// 这里不认增量。授权码不经过这一层：连的时候 mail.rs 自己去凭据管理器取。
#[tauri::command]
pub fn mail_watch_register(
    accounts: Vec<WatchAccount>,
    bulk_senders: Vec<String>,
    poll_minutes: u32,
    state: tauri::State<'_, MailWatch>,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();
    for account in accounts {
        // 与页面上同一套收敛：地址、服务器地址粘歪了不进清单
        let Ok(address) = mail::clean_address(&account.address) else {
            continue;
        };
        let Ok((imap_host, imap_port)) = mail::clean_host(&account.imap_host, account.imap_port)
        else {
            continue;
        };
        if !seen.insert(address.clone()) {
            continue;
        }
        cleaned.push(WatchAccount {
            address,
            imap_host,
            imap_port,
        });
        if cleaned.len() >= ACCOUNTS_MAX {
            break;
        }
    }

    let mut bulk = Vec::new();
    let mut seen_bulk = HashSet::new();
    for entry in bulk_senders {
        let entry = entry.trim().to_lowercase();
        if entry.is_empty() || !seen_bulk.insert(entry.clone()) {
            continue;
        }
        bulk.push(entry);
        if bulk.len() >= BULK_SENDERS_MAX {
            break;
        }
    }

    *state.0.lock().unwrap() = WatchConfig {
        accounts: cleaned,
        bulk_senders: bulk,
        poll_minutes: sanitize_poll_minutes(poll_minutes),
    };
    Ok(())
}

/// 周期的收敛（与渲染层 sanitizeMailPollMinutes 同一条）：0 = 关闭原样放行，
/// 其余夹进下限..上限。
fn sanitize_poll_minutes(raw: u32) -> u32 {
    if raw == 0 {
        return 0;
    }
    raw.clamp(POLL_MIN_MINUTES, POLL_MAX_MINUTES)
}

/// 起监视线程（main.rs 的 setup 里调，全进程一个）。清单空着时它只睡不查 ——
/// 渲染层把账户登记进来之后才开始干活。
pub fn spawn(app: &AppHandle) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("mail-watch".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            tick(&handle);
        });
    if let Err(err) = spawned {
        eprintln!("[workbench] 邮件监视线程起不来：{err}");
    }
}

/// 一轮：到点没（距上次检查满登记的周期）→ 逐个账户查 → 有新信就弹通知。
/// 每个账户的失败只记一行日志，不挡别人 —— 后台的事不该吵到界面。
fn tick(app: &AppHandle) {
    let config = app.state::<MailWatch>().0.lock().unwrap().clone();
    // 清单空着或周期设成关闭（0）：只睡不查
    if config.accounts.is_empty() || config.poll_minutes == 0 {
        return;
    }
    let mut state = WatchState::load();
    let now = now_secs();
    if now.saturating_sub(state.last_check) < u64::from(config.poll_minutes) * 60 {
        return;
    }
    // 先记账再查：这轮失败了也等下一个 30 分钟，别把服务器摁着打
    state.last_check = now;
    state.save();
    for account in &config.accounts {
        let known = state.accounts.get(&account.address).copied();
        match check_account(account, known, &config.bulk_senders) {
            Ok((mark, batch)) => {
                state.accounts.insert(account.address.clone(), mark);
                state.save();
                if let Some(batch) = batch {
                    toast(app, &account.address, batch);
                }
            }
            Err(err) => {
                eprintln!("[workbench] 邮件监视「{}」：{err}", account.address);
            }
        }
    }
}

/// 查一个账户：现连现断拉一次最近摘要，比出「基准之后到达且未读」的那部分。
/// 只看收件箱 —— 新邮件提醒跟「我发出去的信」没关系。
fn check_account(
    account: &WatchAccount,
    known: Option<AccountMark>,
    bulk: &[String],
) -> Result<(AccountMark, Option<NewBatch>), String> {
    let (info, summaries) = mail::fetch_recent_summaries(
        &account.address,
        &account.imap_host,
        account.imap_port,
        Folder::Inbox,
        WINDOW,
    )?;
    Ok(pick_new(&summaries, known, info.uidvalidity, bulk))
}

/// 新邮件判定（纯函数，可单测）。规则：
/// - 基准不存在（第一次查）或 UIDVALIDITY 换了茬：只立基准，本轮不弹 ——
///   UID 序列都没了对不上号，弹出来只会是一堆旧信；
/// - 之后每轮：UID 比基准**大**且**未读**且发件人不在黑名单的算新；
/// - 基准的高水位永远推到本轮见过的最大 UID（广告信也推进去，以后不再看它）。
fn pick_new(
    summaries: &[MailSummary],
    known: Option<AccountMark>,
    uidvalidity: Option<u64>,
    bulk: &[String],
) -> (AccountMark, Option<NewBatch>) {
    let max_uid = summaries.iter().map(|s| s.uid).max().unwrap_or(0);
    let baseline = match known {
        Some(k) if k.uidvalidity == uidvalidity => k,
        _ => AccountMark {
            uidvalidity,
            last_uid: max_uid,
        },
    };
    let fresh: Vec<&MailSummary> = summaries
        .iter()
        .filter(|s| s.uid > baseline.last_uid && !s.seen && !is_bulk_sender(&s.from, bulk))
        .collect();
    let mut mark = baseline;
    mark.last_uid = mark.last_uid.max(max_uid);
    let batch = (!fresh.is_empty()).then(|| NewBatch {
        count: fresh.len(),
        uid: fresh.iter().map(|s| s.uid).max().unwrap_or(0),
    });
    (mark, batch)
}

/// 从原始 From 头里取邮箱地址：尖括号里那段（`名字 <a@b.com>`），没有尖括号就
/// 整段 trim。统一小写 —— 黑名单里的地址也是小写存的。
fn from_address(raw: &str) -> String {
    let value = raw.trim();
    let value = match (value.rfind('<'), value.rfind('>')) {
        (Some(start), Some(end)) if end > start => &value[start + 1..end],
        _ => value,
    };
    value.trim().to_lowercase()
}

/// 发件人是否在广告黑名单上。整地址精确比对，不做包含匹配 ——
/// 黑名单是用户亲手标的，误伤一封真信比多弹一条通知难看得多。
fn is_bulk_sender(from: &str, blacklist: &[String]) -> bool {
    let address = from_address(from);
    !address.is_empty() && blacklist.iter().any(|entry| *entry == address)
}

/// 弹通知。标题用设置里的程序名（与窗口标题 / 托盘提示同一份）；
/// 点击唤出主窗口并发事件给渲染层（换到邮箱页、打开最新那封）。
fn toast(app: &AppHandle, address: &str, batch: NewBatch) {
    let aumid = app.config().identifier.clone();
    let title = display_name(app);
    let body = format!("「{address}」有 {} 封新邮件", batch.count);
    let account = address.to_string();
    let uid = batch.uid;
    let handle = app.clone();
    let outcome = notify::ensure_aumid_shortcut(&aumid, app.package_info().name.as_str()).and_then(
        |_| {
            // 载荷在回调里现拼：回调是 Fn（可以连点），不能把只用一次的值搬进去
            notify::show_toast(&aumid, &title, &body, move || {
                crate::show_main_window(&handle);
                let _ = handle.emit(NOTIFY_CLICK_EVENT, json!({ "account": account, "uid": uid }));
            })
        },
    );
    if let Err(err) = outcome {
        eprintln!("[workbench] 邮件通知：{err}");
    }
}

/// 通知标题：设置里的程序名（渲染层 `sanitizeAppName` 收敛过的那份），没设就产品名。
fn display_name(app: &AppHandle) -> String {
    crate::commands::data_store()
        .get()
        .get("settings")
        .and_then(|settings| settings.get("appName"))
        .and_then(|name| name.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| app.package_info().name.clone())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(uid: u64, seen: bool, from: &str) -> MailSummary {
        MailSummary {
            uid,
            subject: "主题".into(),
            from: from.into(),
            to: "me@163.com".into(),
            date: String::new(),
            seen,
            has_attachment: false,
        }
    }

    const UV: Option<u64> = Some(100);

    #[test]
    fn first_poll_baselines_without_toast() {
        let summaries = vec![summary(9, false, "a@b.com"), summary(11, false, "c@d.com")];
        let (mark, batch) = pick_new(&summaries, None, UV, &[]);
        assert_eq!(mark, AccountMark { uidvalidity: Some(100), last_uid: 11 });
        assert_eq!(batch, None);
    }

    #[test]
    fn new_unread_mail_notifies_with_the_newest_uid() {
        let known = AccountMark { uidvalidity: Some(100), last_uid: 11 };
        let summaries = vec![
            summary(11, true, "a@b.com"),
            summary(12, false, "c@d.com"),
            summary(13, false, "e@f.com"),
        ];
        let (mark, batch) = pick_new(&summaries, Some(known), UV, &[]);
        assert_eq!(mark.last_uid, 13);
        assert_eq!(batch, Some(NewBatch { count: 2, uid: 13 }));
    }

    /// 手机上读过的不再吵：新到达但已 \Seen 的信只推进高水位，不弹
    #[test]
    fn new_mail_that_is_already_read_advances_silently() {
        let known = AccountMark { uidvalidity: Some(100), last_uid: 11 };
        let summaries = vec![summary(12, true, "c@d.com")];
        let (mark, batch) = pick_new(&summaries, Some(known), UV, &[]);
        assert_eq!(mark.last_uid, 12);
        assert_eq!(batch, None);
    }

    /// UIDVALIDITY 换茬（服务器重建过邮箱）：旧 UID 全作废，只立新基准不弹
    #[test]
    fn uidvalidity_change_resets_the_baseline() {
        let known = AccountMark { uidvalidity: Some(100), last_uid: 50 };
        let summaries = vec![summary(3, false, "a@b.com")];
        let (mark, batch) = pick_new(&summaries, Some(known), Some(777), &[]);
        assert_eq!(mark, AccountMark { uidvalidity: Some(777), last_uid: 3 });
        assert_eq!(batch, None);
    }

    /// 黑名单发件人：不计数、不弹，但高水位照推（以后也不再看他）
    #[test]
    fn blacklisted_senders_are_silent_but_advance_the_mark() {
        let known = AccountMark { uidvalidity: Some(100), last_uid: 11 };
        let summaries = vec![
            summary(12, false, " promo@shop.com"),
            summary(13, false, "e@f.com"),
        ];
        let (mark, batch) = pick_new(&summaries, Some(known), UV, &["promo@shop.com".into()]);
        assert_eq!(mark.last_uid, 13);
        assert_eq!(batch, Some(NewBatch { count: 1, uid: 13 }));
    }

    /// 最新几封被删掉之后 max_uid 回落：高水位不许倒退，免得重弹旧信
    #[test]
    fn deletions_do_not_rollback_the_high_water_mark() {
        let known = AccountMark { uidvalidity: Some(100), last_uid: 50 };
        let summaries = vec![summary(9, false, "a@b.com")];
        let (mark, batch) = pick_new(&summaries, Some(known), UV, &[]);
        assert_eq!(mark.last_uid, 50);
        assert_eq!(batch, None);
    }

    /// 服务器没报 UIDVALIDITY（None）：记 0，下一轮同样是 None 就照常比对
    #[test]
    fn missing_uidvalidity_still_allows_comparison() {
        let known = AccountMark { uidvalidity: None, last_uid: 11 };
        let summaries = vec![summary(12, false, "c@d.com")];
        let (mark, batch) = pick_new(&summaries, Some(known), None, &[]);
        assert_eq!(mark.last_uid, 12);
        assert_eq!(batch, Some(NewBatch { count: 1, uid: 12 }));
    }

    #[test]
    fn poll_minutes_keep_zero_as_off_and_clamp_the_rest() {
        assert_eq!(sanitize_poll_minutes(0), 0);
        assert_eq!(sanitize_poll_minutes(30), 30);
        // 1 就是下限本身，5000 夹回上限
        assert_eq!(sanitize_poll_minutes(1), POLL_MIN_MINUTES);
        assert_eq!(sanitize_poll_minutes(5000), POLL_MAX_MINUTES);
    }

    // ----- 发件人地址 -----

    #[test]
    fn from_header_yields_the_bare_address() {
        assert_eq!(from_address("Alice <Alice@163.COM>"), "alice@163.com");
        assert_eq!(from_address("bob@example.com"), "bob@example.com");
        assert_eq!(from_address("  昵称 <c@d.com.cn>  "), "c@d.com.cn");
        assert_eq!(from_address(""), "");
    }

    #[test]
    fn blacklist_matches_whole_addresses_only() {
        let blacklist = vec!["promo@shop.com".to_string()];
        assert!(is_bulk_sender("商店 <PROMO@shop.com>", &blacklist));
        assert!(is_bulk_sender("promo@shop.com", &blacklist));
        // 子串不算：xa@shop.com 不是 promo@shop.com
        assert!(!is_bulk_sender("xa@shop.com", &blacklist));
        assert!(!is_bulk_sender("", &blacklist));
    }
}
