//! panic 落痕：release 档把 panic 设成直接中止进程（`panic = "abort"`），那一刻进程
//! 凭空消失 —— 数据还压在 300ms 去抖窗口里、子进程与邮件监视也没机会收尾。留给用户的
//! 证据只有这里追加的一段。
//!
//! 几条约定：
//!  - **装钩子要早**：`main()` 第一行，早于任何可能 panic 的初始化；
//!  - **钩子本身要钝**：写文件失败就放弃（在钩子里再 panic 会把原始原因盖掉），
//!    默认钩子照旧调用（dev 下 stderr 上还有一份，位置与消息都在）；
//!  - **落点在数据目录**（见 paths.rs 的 `panic_log_file`）：与其余应用文件同一处。
//!
//! 时间戳走系统自带的 `GetLocalTime`，不引日期格式化 crate（AGENTS.md：不新增编译单元）。

use std::io::Write;

/// 单份日志上限：超过就先清空重记。一次进程最多留一段（abort 之后进程就没了），
/// 会涨大基本只有 dev 里反复崩这一种情况。
const MAX_BYTES: u64 = 256 * 1024;

/// 装上钩子。`main()` 开头调一次。
///
/// 提取载荷的代码直接写在闭包里、不单独抽函数：那个参数类型在 1.81 才叫
/// `PanicHookInfo`（本 crate 的 MSRV 是 1.77），写类型名会同时踩上
/// 「MSRV 不够」与「旧名已废弃」两条 —— 让编译器自己推最省事。
pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(panic 载荷不是字符串)".to_string());
        let location = info
            .location()
            .map(|loc| loc.to_string())
            .unwrap_or_else(|| "未知位置".to_string());

        write_entry(&message, &location);
        previous(info);
    }));
}

fn write_entry(message: &str, location: &str) {
    write_entry_to(&crate::paths::panic_log_file(), message, location);
}

/// 路径由调用方给，便于单测；生产路径就是数据目录里那份（见 `panic_log_file`）。
fn write_entry_to(path: &std::path::Path, message: &str, location: &str) {
    let Some(mut file) = open(path) else {
        return;
    };
    let thread = std::thread::current();
    let thread = thread.name().unwrap_or("<未命名线程>");

    let _ = writeln!(
        file,
        "===== {} =====\n线程 {thread} 在 {location} panic：\n{message}\n{}",
        local_time_text(),
        std::backtrace::Backtrace::force_capture(),
    );
}

/// 打开日志（追加）。文件超上限时先清空 —— 崩溃日志没有保留历史的价值。
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

/// 本地时间，形如 `2026-10-12 15:04:05.123`。
fn local_time_text() -> String {
    let mut now: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut now) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wb-panic-{label}-{}", uuid::Uuid::new_v4()));
        let path = dir.join("panic.log");
        (dir, path)
    }

    /// 时间戳形状固定成 `YYYY-MM-DD HH:MM:SS.mmm`（23 个字符）
    #[test]
    fn timestamp_has_a_fixed_shape() {
        let text = local_time_text();
        assert_eq!(text.len(), 23, "形如 2026-10-12 15:04:05.123，实际是 {text}");
        assert_eq!(&text[4..5], "-");
        assert_eq!(&text[10..11], " ");
        assert_eq!(&text[13..14], ":");
        assert_eq!(&text[16..17], ":");
        assert_eq!(&text[19..20], ".");
    }

    /// 一段崩溃记录要落成「能看懂、能定位」的样子：时间、位置、消息都在
    #[test]
    fn writes_a_readable_entry() {
        let (dir, path) = temp_log("write");
        write_entry_to(&path, "锁中毒", "src/session.rs:71:9");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("锁中毒"), "实际内容：{text}");
        assert!(text.contains("src/session.rs:71:9"), "实际内容：{text}");
        assert!(text.contains("线程"), "实际内容：{text}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 超过上限先清空：崩溃日志没有保留历史的价值，也不该无限长
    #[test]
    fn a_bloated_log_is_cleared_before_appending() {
        let (dir, path) = temp_log("bloat");
        std::fs::create_dir_all(&dir).unwrap();
        // 旧内容要留一个**新记录里不可能出现**的记号：新记录带着一段回溯，里面 `x86_64` 这类
        // 带 x 的字样一定在，拿单个 `'x'` 当判据会把回溯自己当成没清干净的旧内容（踩过一次）
        let bloat = "BLOAT".repeat(MAX_BYTES as usize / 5 + 1);
        std::fs::write(&path, &bloat).unwrap();

        write_entry_to(&path, "新的一条", "src/main.rs:1:1");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("BLOAT"), "旧内容该被清掉，实际长度 {}", text.len());
        assert!(text.contains("新的一条"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
