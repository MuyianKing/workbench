//! 错误日志：后台链路里那些「写失败就放弃」的错误，在 release 里只进 stderr ——
//! 正式版是 GUI（windows_subsystem），stderr 上根本没人看，等于黑洞。这一份把它们
//! 收进数据目录：出问题时与 panic.log / hang.log 同一处找（见 ipc-and-state.md）。
//!
//! 约定：
//! - **只收「已经失败 / 反常」的事**：调用点就是原来 `eprintln!` 的位置（本模块在 dev
//!   的 stderr 上照打一份，开发时控制台不丢信息）；正常流程的进度不打进来，别把它
//!   写成流水账。
//! - **一行一条，当场落盘**：直接 append + flush，不经 JsonStore —— 断电 / 被杀拦不住
//!   已写下的行。多线程都往里写，靠一把锁串行（「失败才写」的量级，开销可忽略）。
//! - **满了轮转**：超上限把 error.log 挪成 error.log.old 再从头记 —— 比直接清空多留
//!   一代，「上个月那回」不至于被这个月的刷掉。

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

/// 单份上限：超过就轮转成 error.log.old
const MAX_BYTES: u64 = 512 * 1024;

/// 写盘的串行锁。只护「打开-追加-关闭」这一小段，不护任何不变量。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 记一条错误。`label` 是子系统名（「邮件监视」「落盘」这类），`message` 是已成形的
/// 错误内容（`err` 直接传即可，`String` / `io::Error` 都行）。
pub fn error(label: &str, message: impl std::fmt::Display) {
    write("错误", label, &message.to_string());
}

/// 记一条警告：反常但已兜底的事（比如 OAuth 回调端口收到无关请求）。
/// 与 error 进同一份文件，级别标在行首，翻日志时好区分「出事了」与「有怪事但没坏」。
pub fn warn(label: &str, message: impl std::fmt::Display) {
    write("警告", label, &message.to_string());
}

fn write(level: &str, label: &str, message: &str) {
    // dev 的 stderr 照旧：开发时控制台要能看见（release 的 stderr 落在 NUL 设备上，无害）
    eprintln!("[workbench] {label}：{message}");
    let line = format!("[{}] [{level}] [{label}] {message}", crate::panic_log::local_time_text());
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    write_line_to(&crate::paths::error_log_file(), &line);
}

/// 路径由调用方给，便于单测；生产路径就是数据目录里那份（见 `error_log_file`）。
fn write_line_to(path: &Path, line: &str) {
    let Some(mut file) = open(path) else {
        return;
    };
    let _ = writeln!(file, "{line}");
    let _ = file.flush();
}

/// 打开日志（追加）。目录没建就先建；超上限轮转成 `.old`（Windows 的 `rename` 自带
/// 替换语义，旧的那份直接被顶掉）。
fn open(path: &Path) -> Option<std::fs::File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wb-error-{label}-{}", uuid::Uuid::new_v4()));
        let path = dir.join("error.log");
        (dir, path)
    }

    /// 一条记录要带着时间、级别与子系统名，事后能看懂
    #[test]
    fn writes_a_readable_entry() {
        let (dir, path) = temp_log("write");
        write_line_to(&path, "[2026-11-15 15:04:05.123] [错误] [落盘] workbench-data.json 写入失败：盘满了");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[错误] [落盘]"), "实际内容：{text}");
        assert!(text.contains("盘满了"), "实际内容：{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 追加不覆盖：同一次排查里的多条记录要都在
    #[test]
    fn entries_append_instead_of_overwrite() {
        let (dir, path) = temp_log("append");
        write_line_to(&path, "第一条");
        write_line_to(&path, "第二条");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("第一条") && text.contains("第二条"), "实际：{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 超上限轮转：当前份挪成 .old，新内容从头记 —— 比清空多留一代历史
    #[test]
    fn a_bloated_log_rotates_instead_of_being_cleared() {
        let (dir, path) = temp_log("rotate");
        std::fs::create_dir_all(&dir).unwrap();
        let bloat = "BLOAT".repeat(MAX_BYTES as usize / 5 + 1);
        std::fs::write(&path, &bloat).unwrap();

        write_line_to(&path, "新的一条");

        let old = path.with_extension("log.old");
        let old_text = std::fs::read_to_string(&old).unwrap();
        assert!(old_text.contains("BLOAT"), "旧内容该在 .old 里");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("BLOAT"), "当前份该从头记，实际长度 {}", text.len());
        assert!(text.contains("新的一条"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
