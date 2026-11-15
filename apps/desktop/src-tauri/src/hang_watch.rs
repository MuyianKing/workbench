//! 挂起看门狗：主线程停泵消息时，抢在用户杀进程之前把证据写进数据目录。
//!
//! release 档 panic 有 panic.log（见 panic_log.rs），但「无响应」连 panic 都没有：
//! 主线程卡死在某个同步调用里，Windows 报 AppHang，用户从幽灵壳上关掉进程 ——
//! 事后什么证据都不剩（正式版 v0.3 / v0.4 的多次挂起就是这么丢的）。本模块的约定：
//!
//! - **判据与 Windows 报 AppHang 同一条**：每 5 秒往主线程事件循环投一个「回个时间戳」的
//!   探针（`run_on_main_thread` 从别的线程走事件循环代理，投递即返回，回调由主线程执行），
//!   探针 5 秒内没执行 = 主线程 5 秒没泵消息 —— 正是「停止与 Windows 交互」。
//! - **证据当场落盘**：判定挂起时写一行（此刻哪些锁被占，try_lock 探测 —— 占着 = 有人
//!   卡在里面；也可能只是恰好撞上微秒级临界区，只作线索不作定论），此后每 30 秒补一行，
//!   恢复后补总时长。直接 append + flush，不经 JsonStore —— 进程被杀也拦不住已写下的行。
//! - **看门狗要钝**：写文件失败就放弃；事件循环退出（应用正在退）就收摊 —— 退出路上
//!   探针失败不算挂起。单份超 256KB 先清空（与 panic.log 同一待遇，没有保留历史的价值）。

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use crate::paths;

/// 主线程最后一次执行探针的时刻（毫秒，UNIX 纪元）。只由主线程写，看门狗只读。
static LAST_MAIN_REPLY: AtomicU64 = AtomicU64::new(0);

/// 巡检节奏，也是探针的超时：一轮 = 投探针 + 等这么久。
const TICK_MS: u64 = 5_000;
/// 挂起期间隔多久补一行锁探测（锁的占有可能变化）。
const REPROBE_MS: u64 = 30_000;
/// 单份日志上限：超过先清空重记。
const MAX_BYTES: u64 = 256 * 1024;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 装上看门狗。setup 末尾调一次（各状态都已在 builder 上 manage 完，探针取得到）。
pub fn install(app: &AppHandle) {
    let handle = app.clone();
    // 线程起不来就算了：这只是诊断，不该挡启动
    let _ =
        std::thread::Builder::new()
            .name("hang-watch".into())
            .spawn(move || watch(handle));
}

/// 一轮巡检的结果。
enum Beat {
    /// 主线程在超时内执行了探针
    Alive,
    /// 探针超时没执行：主线程 ≥TICK_MS 没泵消息
    Stalled,
    /// 事件循环已退出（应用正在退）：没有「挂起」可言
    LoopGone,
}

/// 投一个探针并等一个 TICK。事件循环空闲时探针会把它唤醒，所以「没执行」只能是停泵。
fn probe(app: &AppHandle) -> Beat {
    let before = LAST_MAIN_REPLY.load(Ordering::Relaxed);
    if app
        .run_on_main_thread(|| LAST_MAIN_REPLY.store(now_ms(), Ordering::Relaxed))
        .is_err()
    {
        return Beat::LoopGone;
    }
    std::thread::sleep(Duration::from_millis(TICK_MS));
    if LAST_MAIN_REPLY.load(Ordering::Relaxed) == before {
        Beat::Stalled
    } else {
        Beat::Alive
    }
}

fn watch(app: AppHandle) {
    // 首次发现挂起的时刻（毫秒）。挂起真正开始比发现早一个 TICK，报时长时补回去。
    let mut stall_since: Option<u64> = None;
    // 挂起期间下一次补写锁探测的时刻
    let mut reprobe_at = 0u64;
    loop {
        match probe(&app) {
            Beat::LoopGone => return,
            Beat::Alive => {
                if let Some(started) = stall_since.take() {
                    let at_least = (now_ms().saturating_sub(started) + TICK_MS) / 1000;
                    write_line(&format!("[{}] 恢复：本次挂起持续 ≥{at_least} 秒", stamp()));
                }
            }
            Beat::Stalled => {
                let now = now_ms();
                let held = held_locks(&app).join("、");
                match stall_since {
                    None => {
                        stall_since = Some(now);
                        reprobe_at = now.saturating_add(REPROBE_MS);
                        write_line(&format!(
                            "[{}] 挂起：主线程 ≥5 秒未泵消息 | 占用中的锁: {held}",
                            stamp()
                        ));
                    }
                    Some(started) if now >= reprobe_at => {
                        reprobe_at = now.saturating_add(REPROBE_MS);
                        let at_least = (now - started + TICK_MS) / 1000;
                        write_line(&format!(
                            "[{}] 仍在挂起（≥{at_least} 秒）| 占用中的锁: {held}",
                            stamp()
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
    }
}

/// 此刻被占的锁。每把锁单独 try_lock（拿到就立刻放），绝不阻塞看门狗自己。
/// 各模块的探针只在自己文件里摸得到私有字段，这里按模块收集。
fn held_locks(app: &AppHandle) -> Vec<String> {
    let probes: [fn(&AppHandle) -> Vec<String>; 6] = [
        crate::session::hang_probe,
        crate::ball::hang_probe,
        crate::pin::hang_probe,
        crate::capture::hang_probe,
        crate::mail_watch::hang_probe,
        crate::zentao::hang_probe,
    ];
    let mut held = Vec::new();
    for probe in probes {
        held.extend(probe(app));
    }
    held
}

fn write_line(line: &str) {
    write_line_to(&paths::hang_log_file(), line);
}

/// 路径由调用方给，便于单测；生产路径就是数据目录里那份（见 `hang_log_file`）。
fn write_line_to(path: &std::path::Path, line: &str) {
    let Some(mut file) = open(path) else {
        return;
    };
    let _ = writeln!(file, "{line}");
    let _ = file.flush();
}

/// 打开日志（追加）。文件超上限先清空 —— 挂起日志只服务「最近几次」的排查。
fn open(path: &std::path::Path) -> Option<std::fs::File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
        let _ = std::fs::remove_file(path);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// 本地时间，形如 `2026-11-15 14:16:20.123`。复用 panic_log 的实现（同一份口径）。
fn stamp() -> String {
    crate::panic_log::local_time_text()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wb-hang-{label}-{}", uuid::Uuid::new_v4()));
        let path = dir.join("hang.log");
        (dir, path)
    }

    /// 一条挂起记录要带着时间戳与被占的锁，事后能看懂（诊断尾巴的定位）
    #[test]
    fn writes_a_readable_entry() {
        let (dir, path) = temp_log("write");
        write_line_to(
            &path,
            "[2026-11-15 14:16:20.123] 挂起：主线程 ≥5 秒未泵消息 | 占用中的锁: ball.摆位锁",
        );

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("ball.摆位锁"), "实际内容：{text}");
        assert!(text.contains("占用中的锁"), "实际内容：{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 追加不覆盖：一次挂起的首条 + 补写 + 恢复行要都在
    #[test]
    fn entries_append_instead_of_overwrite() {
        let (dir, path) = temp_log("append");
        write_line_to(&path, "第一条");
        write_line_to(&path, "第二条");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("第一条") && text.contains("第二条"), "实际：{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 超过上限先清空：挂起日志没有保留历史的价值，也不该无限长
    #[test]
    fn a_bloated_log_is_cleared_before_appending() {
        let (dir, path) = temp_log("bloat");
        std::fs::create_dir_all(&dir).unwrap();
        let bloat = "BLOAT".repeat(MAX_BYTES as usize / 5 + 1);
        std::fs::write(&path, &bloat).unwrap();

        write_line_to(&path, "新的一条");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("BLOAT"), "旧内容该被清掉，实际长度 {}", text.len());
        assert!(text.contains("新的一条"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
