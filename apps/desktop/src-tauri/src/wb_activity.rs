//! TBuddy 福利的**活动记录**：`activity.jsonl` 的一行形状、写入与「读今天」。
//!
//! 从 `wb_tasks.rs` 拆出来：它是一份**只追加的运维流水**（签到 / 任务各一次尝试），
//! 与任务协议本身无关 —— 排查「今天这个号为什么没签到」时才有人读它。

use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::common::{now_secs, redact};
use crate::wb_account::Account;

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
pub(crate) fn local_parts() -> (i32, i32, i32, i32) {
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
    let days = crate::common::days_from_civil(year as i64, month as i64, day as i64) + offset;
    let (year, month, day) = crate::common::civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}
#[cfg(test)]
mod tests {
    use super::*;

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
}
