//! Token 用量实读。
//!
//! 刻意只做「取原始行」这一层：合并 / 取最大值 / 修剪 / 快照的语义都在
//! `src/shared/token-usage.ts` 里，渲染层复用同一份实现，Rust 侧不重复第二遍。
//! 唯一的例外是 zstd —— 浏览器没有 zstd 解码 API，DSH 的多帧解压只能留在 Rust。

use serde_json::{json, Value};
use std::path::PathBuf;

/// 聚合 SQL：按 天 × 模型 汇总，与 Electron 版逐字一致。
///  - ROW_NUMBER 去重重试：同一个 logical_request_id 只留最后一次尝试，重试不双算；
///  - error_type IS NULL 排除失败请求：没产生计数的失败不算用量；
///  - date(..., 'localtime') 按本地日期归天，与活跃度图同一约定。
const USAGE_SQL: &str = "
  SELECT
    date(mu.started_at / 1000, 'unixepoch', 'localtime') AS day,
    mu.model_id AS model,
    SUM(mu.input_tokens) AS input,
    SUM(mu.output_tokens) AS output,
    SUM(mu.reasoning_tokens) AS reasoning,
    SUM(mu.cache_read_input_tokens) AS cacheRead,
    SUM(mu.cache_creation_input_tokens) AS cacheWrite,
    COUNT(*) AS requests
  FROM model_usage mu
  WHERE mu.id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY logical_request_id ORDER BY attempt_index DESC) AS rn
      FROM model_usage
    ) latest WHERE latest.rn = 1
  )
    AND mu.error_type IS NULL
  GROUP BY day, model
";

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// ZCode 数据目录；少数人会把整个 .zcode 放在别处，给个环境变量出口
pub fn zcode_db_file() -> PathBuf {
    let root = std::env::var("ZCODE_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".zcode"));
    root.join("cli").join("db").join("db.sqlite")
}

/// 实读 ZCode 用量库，返回按 天 × 模型 聚合的原始行。
///
/// 关键约定：ZCode 的库是 WAL 模式，以 readonly 打开可以与运行中的 ZCode 并存，不拷文件。
/// 读取失败不抛错给用户看栈，只把原因带回去；界面回退展示快照。
pub fn zcode_rows() -> Result<Vec<Value>, String> {
    let file = zcode_db_file();

    let conn = rusqlite::Connection::open_with_flags(
        &file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| format!("未找到 ZCode 数据库({})", file.display()))?;

    let mut stmt = conn
        .prepare(USAGE_SQL)
        .map_err(|_| "ZCode 数据库读取失败,可能它的版本已更新了表结构".to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "day": row.get::<_, Option<String>>(0)?,
                "model": row.get::<_, Option<String>>(1)?,
                "input": row.get::<_, Option<i64>>(2)?,
                "output": row.get::<_, Option<i64>>(3)?,
                "reasoning": row.get::<_, Option<i64>>(4)?,
                "cacheRead": row.get::<_, Option<i64>>(5)?,
                "cacheWrite": row.get::<_, Option<i64>>(6)?,
                "requests": row.get::<_, Option<i64>>(7)?,
            }))
        })
        .map_err(|_| "ZCode 数据库读取失败,可能它的版本已更新了表结构".to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|_| "ZCode 数据库读取失败,可能它的版本已更新了表结构".to_string())?);
    }
    Ok(out)
}

/// DSH 会话文件是多帧 zstd：每条事件一帧追加写，解压器只认第一帧，
/// 这里按帧头魔数切开后逐帧解。魔数偶现在压缩数据里理论可能，概率可忽略(~1e-4/文件)，
/// 单帧解失败就跳过，只少一条事件，不影响整体。
pub fn zstd_decode_frames(buf: &[u8]) -> String {
    const MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

    let mut starts: Vec<usize> = Vec::new();
    let mut index = 0usize;
    while index + 4 <= buf.len() {
        if buf[index..index + 4] == MAGIC {
            starts.push(index);
            index += 4;
        } else {
            index += 1;
        }
    }

    let mut out = String::new();
    for (i, start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(buf.len());
        if let Ok(text) = zstd::decode_all(&buf[*start..end]) {
            out.push_str(&String::from_utf8_lossy(&text));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真读一次本机正在运行的 ZCode 的 WAL 库。
    ///
    /// 这是整次迁移里唯一「可能彻底不成立」的技术前提：SQLite 对 WAL 只读连接有额外要求
    /// （-shm 必须可写），better-sqlite3 能打开并不代表 rusqlite 也能打开。
    /// 库不存在时跳过（别的机器上不一定装了 ZCode），存在则必须读得出结果。
    #[test]
    fn reads_live_zcode_wal_database() {
        let file = zcode_db_file();
        if !file.exists() {
            eprintln!("跳过：本机没有 {}", file.display());
            return;
        }

        match zcode_rows() {
            Ok(rows) => eprintln!("只读打开成功，读到 {} 行聚合结果", rows.len()),
            Err(err) => panic!("只读打开运行中的 WAL 库失败: {err}"),
        }
    }

    /// 多帧 zstd 按魔数切开逐帧解；非 zstd 内容不应 panic
    #[test]
    fn decodes_zstd_frames_without_panicking() {
        assert_eq!(zstd_decode_frames(b"not zstd at all"), "");
        let frame = zstd::encode_all(&b"hello"[..], 3).unwrap();
        assert_eq!(zstd_decode_frames(&frame), "hello");
    }
}

