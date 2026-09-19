//! Token 用量实读。
//!
//! 刻意只做「取原始行」这一层：合并 / 取最大值 / 修剪 / 快照的语义都在
//! `src/shared/token-usage.ts` 里，渲染层复用同一份实现，Rust 侧不重复第二遍。
//! 唯一的例外是 zstd —— 浏览器没有 zstd 解码 API，DSH 的多帧解压只能留在 Rust。

use serde_json::{json, Value};
use std::path::PathBuf;
use walkdir::WalkDir;

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

// ---------- CodeBuddy(IDE 扩展日志) ----------
//
// 只做「列文件」这一层：CodeBuddy 没有落地用量库，唯一的数据源是扩展日志里的逐步 usage 记录，
// 而行与行之间靠 traceId / requestId 串起来（见 shared/codebuddy-log.ts 的文件头），
// 所以解析必须整批读、跨文件累积 —— 那是纯逻辑，留在 TS 侧，这里只负责找目录与列文件。

/// 扩展日志的根目录：国内版在 `%APPDATA%/CodeBuddy CN/logs`，国际版没有 CN 后缀，两个都试。
/// 环境变量出口与 ZCode 的 `ZCODE_HOME` 同理，给装在别处的人留一条路。
pub fn codebuddy_log_roots() -> Vec<PathBuf> {
    if let Some(dir) = std::env::var("CODEBUDDY_DATA_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return vec![PathBuf::from(dir).join("logs")];
    }

    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    vec![
        roaming.join("CodeBuddy CN").join("logs"),
        roaming.join("CodeBuddy").join("logs"),
    ]
}

/// 扩展目录名（与界面语言无关），匹配时忽略大小写 —— 不同版本里的大小写不一定一致
const CODEBUDDY_EXTENSION_DIR: &str = "tencent-cloud.coding-copilot";

/// 递归深度上限。日志结构是 `会话/windowN/exthost/扩展目录`，留几层余量就够；
/// 有上限才不会在目录被软链成环时把磁盘走穿。
const CODEBUDDY_MAX_DEPTH: usize = 8;

/// 扩展日志文件清单：`{ found, root, files: [{ path, mtimeMs, size }] }`，不读文件内容。
///
/// `found` 为 false 表示这台机器没有 CodeBuddy（或目录名被改过），调用方据此**安静地跳过**这个来源；
/// 只有「目录在、但根目录读不出来」才返回 Err —— 没装某个工具是常态，
/// 不该和「装了却读不到」在界面上报成同一个样子。
pub fn codebuddy_log_files() -> Result<Value, String> {
    let roots = codebuddy_log_roots();
    let root = roots
        .iter()
        .find(|path| path.is_dir())
        .cloned()
        .unwrap_or_else(|| roots[0].clone());
    codebuddy_files_in(&root)
}

fn codebuddy_files_in(root: &std::path::Path) -> Result<Value, String> {
    if !root.is_dir() {
        return Ok(json!({ "found": false, "root": root.to_string_lossy(), "files": [] }));
    }

    // 根目录读不进来是实打实的错误（权限 / 被占用），先探一次再往下递归，
    // 免得被下面的「读不了就跳过」吞掉，表现成「CodeBuddy 装了但一条数据都没有」
    std::fs::read_dir(root).map_err(|err| format!("CodeBuddy 日志目录读取失败: {err}"))?;

    let mut files = Vec::new();
    collect_codebuddy_logs(root, &mut files);
    Ok(json!({ "found": true, "root": root.to_string_lossy(), "files": files }))
}

/// 只收扩展目录下的 `.log`。日志文件名是中文（腾讯云代码助手.log），
/// 所以只能按目录名定位、不能按文件名找；扩展目录之外的 .log（main.log 那些）不是用量来源。
///
/// 遍历交给 `walkdir`（tauri-utils 已经在用它，加进来不新增编译单元）：深度上限替掉手写的
/// 递归与 depth 参数，单个子目录读不了（`filter_map(Result::ok)`）也只少一棵子树。
fn collect_codebuddy_logs(root: &std::path::Path, out: &mut Vec<Value>) {
    for entry in WalkDir::new(root)
        .max_depth(CODEBUDDY_MAX_DEPTH)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("log") {
            continue;
        }
        // 「在扩展目录下」按相对路径判：祖先里只要有那一层目录名，它的子树都算。
        // 等价于原来那个一路往下传的 in_extension 标志，但不必自己带状态。
        if !under_extension_dir(root, entry.path()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        out.push(json!({
            "path": entry.path().to_string_lossy(),
            "mtimeMs": modified_ms(&meta),
            "size": meta.len(),
        }));
    }
}

/// 这个路径是否落在扩展目录之下（相对 `root` 看）
fn under_extension_dir(root: &std::path::Path, path: &std::path::Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        relative.components().any(|part| {
            part.as_os_str().to_string_lossy().to_ascii_lowercase() == CODEBUDDY_EXTENSION_DIR
        })
    })
}

// ---------- WorkBuddy(~/.workbuddy/projects) ----------
//
// 同样只做「列文件」：WorkBuddy 把每次模型调用的用量写进会话正文
// （`projects/<项目>/<会话 id>.jsonl`，一行一个 JSON 事件），正文没有压缩、
// 每一行都自带时间 / 模型 / 用量，读取与解析都在 TS 侧（shared/workbuddy-log.ts）。

/// WorkBuddy 的 home。
///
/// 注意它与 Electron 的 `%APPDATA%/WorkBuddy`（只有窗口状态那些）**不是**一回事：
/// 会话与排障日志都在 `~/.workbuddy` 这个 CLI 风格的目录下。
/// 环境变量出口与其它来源同理，给装在别处的人留一条路。
pub fn workbuddy_home() -> PathBuf {
    std::env::var("WORKBUDDY_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".workbuddy"))
}

/// 会话文件清单：`{ found, root, sessions: [{ path, mtimeMs, size }] }`，不读文件内容。
///
/// `found` 为 false 表示这台机器没有 WorkBuddy，调用方安静跳过这个来源。
pub fn workbuddy_session_files() -> Result<Value, String> {
    workbuddy_sessions_in(&workbuddy_home().join("projects"))
}

fn workbuddy_sessions_in(root: &std::path::Path) -> Result<Value, String> {
    jsonl_sessions_in(root, "WorkBuddy")
}

/// 会话正文清单：`{ found, root, sessions: [{ path, mtimeMs, size }] }`，不读文件内容。
///
/// WorkBuddy 与 Qoder 是同一套布局（`projects/<项目>/<会话 id>.jsonl`），所以共用这一段。
/// 只下探两层：这一层才是会话正文，更深的位置没有实测过的用量来源，
/// 多收一份就可能把同一次调用算两遍（子会话正文的用量是不是已经并进主正文，没有把握）。
fn jsonl_sessions_in(root: &std::path::Path, label: &str) -> Result<Value, String> {
    if !root.is_dir() {
        return Ok(json!({ "found": false, "root": root.to_string_lossy(), "sessions": [] }));
    }
    std::fs::read_dir(root).map_err(|err| format!("{label}会话目录读取失败: {err}"))?;

    let mut sessions = Vec::new();
    for entry in WalkDir::new(root)
        .min_depth(2)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        // 每个会话都是一个 .jsonl 加两个同名侧车文件（.meta.json / .file-rollback.ndjson），
        // 只有 .jsonl 才是会话正文
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        sessions.push(json!({
            "path": path.to_string_lossy(),
            "mtimeMs": modified_ms(&meta),
            "size": meta.len(),
        }));
    }

    Ok(json!({ "found": true, "root": root.to_string_lossy(), "sessions": sessions }))
}

// ---------- Qoder(~/.qoder-cn/projects) ----------
//
// 同样只做「列文件」：Qoder 把每次请求扣掉的额度写在会话文件里
// （`projects/<项目>/<会话 id>.jsonl`，一行一个 JSON 事件），正文没有压缩，
// 读取与解析都在 TS 侧（shared/qoder-log.ts）。
//
// 它**没有 token 计数可读**：会话文件与 CLI 日志里的 input_tokens / output_tokens 恒为 0
// （Qoder 自己的上下文快照里写着 `tokenCountsAvailable: false`，用量面板是问服务端的），
// 本地唯一能读到的用量就是 credits —— 所以这个来源只喂 credits 口径。

/// Qoder 的数据目录：国内版是 `~/.qoder-cn`，国际版没有 `-cn` 后缀，两个都试。
/// 环境变量出口与其它来源同理，给装在别处的人留一条路。
pub fn qoder_data_roots() -> Vec<PathBuf> {
    if let Some(dir) = std::env::var("QODER_DATA_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return vec![PathBuf::from(dir)];
    }

    vec![home_dir().join(".qoder-cn"), home_dir().join(".qoder")]
}

/// 会话文件清单：`{ found, root, sessions: [{ path, mtimeMs, size }] }`，不读文件内容。
///
/// `found` 为 false 表示这台机器没有 Qoder，调用方安静跳过这个来源。
pub fn qoder_session_files() -> Result<Value, String> {
    // 认「projects 在不在」而不是「home 在不在」：~/.qoder 可能只装了浏览器连接器那个目录
    let roots = qoder_data_roots();
    let root = roots
        .iter()
        .map(|home| home.join("projects"))
        .find(|projects| projects.is_dir())
        .unwrap_or_else(|| roots[0].join("projects"));
    qoder_sessions_in(&root)
}

fn qoder_sessions_in(root: &std::path::Path) -> Result<Value, String> {
    jsonl_sessions_in(root, "Qoder")
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- DeepSeek Harness(~/.dsh/sessions) ----------
//
// 同样只做「列文件」：会话文件是多帧 zstd（浏览器没有 zstd 解码 API，所以解压在 Rust，
// 走 `token_zstd_decode`），解出来的每一行是一个 JSON 事件，语义解析在 shared/dsh-log.ts。

/// 会话文件名：v3 与旧版两种。**同一会话目录可能两者都在**（实测本机 25 个里有 4 个），
/// 只读其中一个 —— 两个都读会把那次会话的用量算两遍，而且不会有任何报错。
const DSH_SESSION_FILE: &str = "session.v3.jsonl.zstd";
const DSH_LEGACY_SESSION_FILE: &str = "session.jsonl.zstd";

/// DeepSeek Harness 的 home；环境变量出口与它自身的约定（DSH_HOME）一致
pub fn dsh_home() -> PathBuf {
    std::env::var("DSH_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".dsh"))
}

/// 会话文件清单：`{ found, root, sessions: [{ path, mtimeMs, size }] }`，不读文件内容
/// （内容要先逐帧解压，留在渲染层按需通过 `token_zstd_decode` 取）。
///
/// `found` 为 false 表示这台机器没有 DSH，调用方安静跳过这个来源。
pub fn dsh_session_files() -> Result<Value, String> {
    dsh_sessions_in(&dsh_home().join("sessions"))
}

fn dsh_sessions_in(root: &std::path::Path) -> Result<Value, String> {
    if !root.is_dir() {
        return Ok(json!({ "found": false, "root": root.to_string_lossy(), "sessions": [] }));
    }
    std::fs::read_dir(root).map_err(|err| format!("DSH 会话目录读取失败: {err}"))?;

    let mut sessions = Vec::new();
    // 目录结构是 sessions/<项目>/<会话>/<文件>：会话目录正好在第 2 层，逐个去挑该读的那个文件
    for entry in WalkDir::new(root)
        .min_depth(2)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_dir() {
            continue;
        }
        let Some(path) = pick_session_file(entry.path()) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        sessions.push(json!({
            "path": path.to_string_lossy(),
            "mtimeMs": modified_ms(&meta),
            "size": meta.len(),
        }));
    }

    Ok(json!({ "found": true, "root": root.to_string_lossy(), "sessions": sessions }))
}

/// 取这个会话该读哪个文件：v3 优先，没有才退回旧版（两者并存时**只能读一个**）
fn pick_session_file(session_dir: &std::path::Path) -> Option<PathBuf> {
    let v3 = session_dir.join(DSH_SESSION_FILE);
    if v3.is_file() {
        return Some(v3);
    }
    let legacy = session_dir.join(DSH_LEGACY_SESSION_FILE);
    if legacy.is_file() {
        return Some(legacy);
    }
    None
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

    /// 扩展目录下的 .log 才收；扩展目录之外的、以及非 .log 都不算
    #[test]
    fn collects_codebuddy_logs_from_a_directory_tree() {
        let root = std::env::temp_dir().join(format!("wb-cb-{}", uuid::Uuid::new_v4()));
        let ext = root
            .join("20260101T000000")
            .join("window1")
            .join("exthost")
            .join("Tencent-Cloud.coding-copilot");
        std::fs::create_dir_all(&ext).unwrap();

        std::fs::write(ext.join("腾讯云代码助手.log"), "hello").unwrap();
        std::fs::write(ext.join("其他.txt"), "nope").unwrap();
        // 扩展目录之外的同名 .log（CodeBuddy 自己的日志）不是用量来源
        std::fs::write(root.join("20260101T000000").join("main.log"), "nope").unwrap();

        let value = codebuddy_files_in(&root).unwrap();
        assert_eq!(value["found"], json!(true));

        let files = value["files"].as_array().unwrap();
        assert_eq!(files.len(), 1, "只该收到扩展目录下那一个 .log");
        let path = files[0]["path"].as_str().unwrap();
        assert!(path.ends_with("腾讯云代码助手.log"), "收到的是 {path}");
        assert_eq!(files[0]["size"], json!(5));
        assert!(files[0]["mtimeMs"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 目录名大小写无关：不同版本里的大小写不一致时也要找得到
    #[test]
    fn matches_the_extension_directory_case_insensitively() {
        let root = std::env::temp_dir().join(format!("wb-cb-{}", uuid::Uuid::new_v4()));
        let ext = root
            .join("s")
            .join("window2")
            .join("exthost")
            .join("tencent-cloud.coding-copilot");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("a.log"), "x").unwrap();

        let value = codebuddy_files_in(&root).unwrap();
        assert_eq!(value["files"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 没装 CodeBuddy 时 found=false、不是错误（界面上安静跳过，不点亮「来源不可用」）
    #[test]
    fn a_missing_codebuddy_install_is_not_an_error() {
        let missing = std::env::temp_dir().join("wb-cb-does-not-exist");
        let value = codebuddy_files_in(&missing).unwrap();

        assert_eq!(value["found"], json!(false));
        assert!(value["files"].as_array().unwrap().is_empty());

        // 两个候选根目录都要列出来，供界面提示去哪儿找
        let roots = codebuddy_log_roots();
        assert_eq!(roots.len(), 2);
        assert!(roots[0].to_string_lossy().contains("CodeBuddy CN"));
    }

    /// 环境相关诊断：真读本机的扩展日志目录。
    ///
    /// 用例里的目录树是自己造的，而真实目录长什么样只有这台机器知道 ——
    /// 扩展目录名或层级一变，源码里那个常量就会悄悄失配、CodeBuddy 静默变成 0 条记录。
    /// 换机器 / CodeBuddy 升级后跑一次：`cargo test -- --ignored --nocapture`。
    #[test]
    #[ignore = "环境相关诊断：cargo test -- --ignored --nocapture"]
    fn diagnose_real_codebuddy_logs() {
        for root in codebuddy_log_roots() {
            if !root.is_dir() {
                eprintln!("{} -> 不存在", root.display());
                continue;
            }
            let value = codebuddy_files_in(&root).unwrap();
            let files = value["files"].as_array().cloned().unwrap_or_default();
            let bytes: u64 = files.iter().filter_map(|f| f["size"].as_u64()).sum();
            eprintln!(
                "{} -> {} 个日志文件, 共 {:.1} MB",
                root.display(),
                files.len(),
                bytes as f64 / 1_048_576.0
            );
            if let Some(first) = files.first() {
                eprintln!("  例: {}", first["path"].as_str().unwrap_or(""));
            }
        }
    }

    /// 临时诊断：逐帧解压的真实结果长什么样（每帧是不是各自带换行）。
    /// 若相邻事件被粘成一行，渲染层的 JSON.parse 会整条失败、DSH 静默变成 0 条记录。
    #[test]
    #[ignore = "环境相关诊断"]
    fn diagnose_dsh_frames() {
        let home = std::env::var("DSH_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".dsh")
            });
        let sessions = home.join("sessions");

        let mut found = Vec::new();
        for project in std::fs::read_dir(&sessions).into_iter().flatten().flatten() {
            for session in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
                let v3 = session.path().join("session.v3.jsonl.zstd");
                if v3.is_file() {
                    found.push(v3);
                    break;
                }
            }
        }
        eprintln!("找到 {} 个 v3 会话文件", found.len());
        let Some(file) = found.first() else { return };

        let raw = std::fs::read(file).unwrap();
        let text = zstd_decode_frames(&raw);
        eprintln!("{} -> 压缩 {} 字节, 解出 {} 字节", file.display(), raw.len(), text.len());

        let lines: Vec<&str> = text.lines().collect();
        let parsed = lines.iter().filter(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()).count();
        let glued = text.matches("}{").count();
        eprintln!("行数 {} / 能当 JSON 解析的行 {} / 出现 \"}}{{\" {} 次", lines.len(), parsed, glued);
        eprintln!("首行: {}", lines.first().copied().unwrap_or("").chars().take(160).collect::<String>());

        // 解析规则要照真实事件核对：时间单位、模型声明位置、usage 字段名
        for (label, needle) in [
            ("request/header", "\"type\":\"request/header\""),
            ("assistant/message", "\"type\":\"assistant/message\""),
        ] {
            match lines.iter().find(|line| line.contains(needle)) {
                Some(line) => eprintln!(
                    "{label} 例: {}",
                    line.chars().take(420).collect::<String>()
                ),
                None => eprintln!("{label} 例: 这个文件里没有"),
            }
        }

        // usage 在最要紧的那一处：字段名必须照实核对
        if let Some(line) = lines.iter().find(|line| line.contains("\"usage\"")) {
            if let Some(at) = line.find("\"usage\"") {
                let tail: String = line[at..].chars().take(240).collect();
                eprintln!("usage 片段: {tail}");
            }
        }

        // 口径核实：inputTokens 到底含不含 cacheReadTokens。含就得减，否则缓存双算
        // （缓存常占九成以上，这一处弄反了数字会大得离谱）；顺便看有几个事件带缓存。
        let mut with_cache = 0;
        for (index, line) in lines.iter().enumerate() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let usage = &value["data"]["usage"];
            let Some(cache) = usage["cacheReadTokens"].as_i64() else {
                continue;
            };
            if cache <= 0 {
                continue;
            }
            with_cache += 1;
            if with_cache == 1 {
                eprintln!(
                    "带缓存的事件(第 {index} 行): input={} output={} cacheRead={} total={}",
                    usage["inputTokens"], usage["outputTokens"], usage["cacheReadTokens"], usage["totalTokens"]
                );
            }
        }
        eprintln!("带缓存读取的事件: {with_cache} 个");
    }

    /// 会话目录里 v3 与旧版并存时只取 v3：两个都读会把那次会话的用量算两遍
    #[test]
    fn picks_the_v3_session_file_and_never_both() {
        let root = std::env::temp_dir().join(format!("wb-dsh-{}", uuid::Uuid::new_v4()));

        let both = root.join("--proj-a--").join("session-1");
        std::fs::create_dir_all(&both).unwrap();
        std::fs::write(both.join(DSH_SESSION_FILE), "v3").unwrap();
        std::fs::write(both.join(DSH_LEGACY_SESSION_FILE), "legacy").unwrap();

        let legacy_only = root.join("--proj-b--").join("session-2");
        std::fs::create_dir_all(&legacy_only).unwrap();
        std::fs::write(legacy_only.join(DSH_LEGACY_SESSION_FILE), "legacy").unwrap();

        // 两个文件都没有的会话目录直接跳过
        std::fs::create_dir_all(root.join("--proj-c--").join("session-3")).unwrap();

        let value = dsh_sessions_in(&root).unwrap();
        assert_eq!(value["found"], json!(true));

        let sessions = value["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2, "只该有两个会话，且并存的那个只算一次");

        let mut paths: Vec<String> = sessions
            .iter()
            .map(|item| item["path"].as_str().unwrap().to_string())
            .collect();
        paths.sort();

        assert!(paths[0].ends_with("session-1\\session.v3.jsonl.zstd") || paths[0].ends_with("session-1/session.v3.jsonl.zstd"));
        assert!(paths[1].ends_with("session-2\\session.jsonl.zstd") || paths[1].ends_with("session-2/session.jsonl.zstd"));
        assert!(sessions.iter().all(|item| item["size"].as_u64().unwrap() > 0));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 没装 DSH 时 found=false、不是错误
    #[test]
    fn a_missing_dsh_install_is_not_an_error() {
        let missing = std::env::temp_dir().join("wb-dsh-does-not-exist");
        let value = dsh_sessions_in(&missing).unwrap();

        assert_eq!(value["found"], json!(false));
        assert!(value["sessions"].as_array().unwrap().is_empty());
    }

    /// 项目目录下的 .jsonl 才是会话正文：同名侧车（.meta.json / .file-rollback.ndjson）、
    /// 项目目录之外的、以及更深一层的都不收
    #[test]
    fn collects_workbuddy_sessions_and_skips_sidecars() {
        let root = std::env::temp_dir().join(format!("wb-wb-{}", uuid::Uuid::new_v4()));
        let project = root.join("f-projects-workbench");
        std::fs::create_dir_all(project.join("nested")).unwrap();

        std::fs::write(project.join("7cc5feb0.jsonl"), "{}\n").unwrap();
        std::fs::write(project.join("7cc5feb0.meta.json"), "{}").unwrap();
        std::fs::write(project.join("7cc5feb0.file-rollback.ndjson"), "{}").unwrap();
        std::fs::write(project.join("nested/deep.jsonl"), "{}").unwrap();
        // 项目目录之外的 .jsonl 不是用量来源
        std::fs::write(root.join("stray.jsonl"), "{}").unwrap();

        let value = workbuddy_sessions_in(&root).unwrap();
        assert_eq!(value["found"], json!(true));

        let sessions = value["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1, "只该收到项目目录下那一个会话正文");
        let path = sessions[0]["path"].as_str().unwrap();
        assert!(path.ends_with("7cc5feb0.jsonl"), "收到的是 {path}");
        assert!(sessions[0]["size"].as_u64().unwrap() > 0);
        assert!(sessions[0]["mtimeMs"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 没装 WorkBuddy 时 found=false、不是错误（界面上安静跳过，不点亮「来源不可用」）
    #[test]
    fn a_missing_workbuddy_install_is_not_an_error() {
        let missing = std::env::temp_dir().join("wb-workbuddy-does-not-exist");
        let value = workbuddy_sessions_in(&missing).unwrap();

        assert_eq!(value["found"], json!(false));
        assert!(value["sessions"].as_array().unwrap().is_empty());

        // 默认 home 是 ~/.workbuddy，不是 Electron 的 %APPDATA%/WorkBuddy
        assert!(workbuddy_home().ends_with(".workbuddy"));
    }

    /// 没装 Qoder 时 found=false、不是错误（界面上安静跳过，不点亮「来源不可用」）
    #[test]
    fn a_missing_qoder_install_is_not_an_error() {
        let missing = std::env::temp_dir().join("wb-qoder-does-not-exist");
        let value = qoder_sessions_in(&missing).unwrap();

        assert_eq!(value["found"], json!(false));
        assert!(value["sessions"].as_array().unwrap().is_empty());

        // 两个候选数据目录都要列出来：国内版在前（本机装的是它），国际版没有 -cn 后缀
        let roots = qoder_data_roots();
        assert_eq!(roots.len(), 2);
        assert!(roots[0].ends_with(".qoder-cn"));
        assert!(roots[1].ends_with(".qoder"));
    }

    /// 会话正文的收集与 WorkBuddy 共用一段，这里只核对 Qoder 那条路也收得对、且不收侧车
    #[test]
    fn collects_qoder_sessions_and_skips_sidecars() {
        let root = std::env::temp_dir().join(format!("wb-qoder-{}", uuid::Uuid::new_v4()));
        let project = root.join("F--projects-workbench");
        std::fs::create_dir_all(project.join("nested")).unwrap();

        std::fs::write(project.join("c5ef1c9b.jsonl"), "{}\n").unwrap();
        std::fs::write(project.join("c5ef1c9b.meta.json"), "{}").unwrap();
        std::fs::write(project.join("nested/deep.jsonl"), "{}").unwrap();

        let value = qoder_sessions_in(&root).unwrap();
        assert_eq!(value["found"], json!(true));

        let sessions = value["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1, "只该收到项目目录下那一个会话正文");
        let path = sessions[0]["path"].as_str().unwrap();
        assert!(path.ends_with("c5ef1c9b.jsonl"), "收到的是 {path}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 环境相关诊断：真读本机的 Qoder 会话，核对额度那两个字段还在。
    ///
    /// 用例里的会话正文是自己造的，而真实正文长什么样只有这台机器知道 ——
    /// Qoder 一改存放位置或字段名（`message.usage.credits`），这个来源就会静默变成 0 条记录，
    /// 界面上和「没用过」长得一模一样。换机器 / Qoder 升级后跑一次：
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "环境相关诊断：cargo test -- --ignored --nocapture"]
    fn diagnose_real_qoder_sessions() {
        for home in qoder_data_roots() {
            let root = home.join("projects");
            println!("数据目录: {} -> {}", home.display(), if root.is_dir() { "在" } else { "不在" });
            let Ok(value) = qoder_sessions_in(&root) else {
                println!("  列文件失败");
                continue;
            };
            let sessions = value["sessions"].as_array().cloned().unwrap_or_default();
            println!("  {} 个会话正文", sessions.len());

            let mut lines = 0usize;
            let mut with_credits = 0usize;
            let mut credits = 0f64;
            let mut zero_tokens = 0usize;
            let mut models: Vec<String> = Vec::new();
            for session in &sessions {
                let path = session["path"].as_str().unwrap_or("");
                let Ok(text) = std::fs::read_to_string(path) else {
                    continue;
                };
                for line in text.lines() {
                    lines += 1;
                    let Ok(event) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    if event["type"] != json!("assistant") {
                        continue;
                    }
                    if let Some(model) = event["message"]["model"].as_str() {
                        if !models.iter().any(|item| item == model) {
                            models.push(model.to_string());
                        }
                    }
                    // 口径核实：Qoder 的 token 计数恒为 0，额度在 credits 那一个字段上
                    if event["message"]["usage"]["input_tokens"].as_i64() == Some(0) {
                        zero_tokens += 1;
                    }
                    if let Some(value) = event["message"]["usage"]["credits"].as_f64() {
                        if value > 0.0 {
                            with_credits += 1;
                            credits += value;
                        }
                    }
                }
            }
            println!(
                "  共 {lines} 行, assistant 里 input_tokens 为 0 的 {zero_tokens} 条, 带 credits 的 {with_credits} 条, 合计 {credits:.4} 个额度"
            );
            println!("  模型: {}", models.join(", "));
        }
    }

    /// 环境相关诊断：真读本机的 WorkBuddy 会话正文，核对解析规则的前提。
    ///
    /// 用例里的会话正文是自己造的，而真实正文长什么样只有这台机器知道 ——
    /// WorkBuddy 还年轻，字段名或存放位置一变，`providerData.usage` 那条路径就会悄悄失配、
    /// 这个来源静默变成 0 条记录。换机器 / WorkBuddy 升级后跑一次：
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "环境相关诊断：cargo test -- --ignored --nocapture"]
    fn diagnose_real_workbuddy_sessions() {
        let root = workbuddy_home().join("projects");
        println!("会话目录: {}", root.display());
        let Ok(value) = workbuddy_sessions_in(&root) else {
            println!("列文件失败");
            return;
        };
        let sessions = value["sessions"].as_array().cloned().unwrap_or_default();
        let bytes: u64 = sessions.iter().filter_map(|f| f["size"].as_u64()).sum();
        println!(
            "{} 个会话正文, 共 {:.1} MB",
            sessions.len(),
            bytes as f64 / 1_048_576.0
        );
        if let Some(first) = sessions.first() {
            println!("  例: {}", first["path"].as_str().unwrap_or(""));
        }

        // 逐条核对解析规则要用的三处：时间戳、模型、用量
        let mut lines = 0usize;
        let mut with_usage = 0usize;
        let mut models: Vec<String> = Vec::new();
        let mut sample = String::new();
        for session in &sessions {
            let path = session["path"].as_str().unwrap_or("");
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            for line in text.lines() {
                lines += 1;
                let Ok(event) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let provider = &event["providerData"];
                let usage = &provider["usage"];
                if !usage.is_object() {
                    continue;
                }
                with_usage += 1;
                if let Some(model) = provider["model"].as_str() {
                    if !models.iter().any(|item| item == model) {
                        models.push(model.to_string());
                    }
                }
                if sample.is_empty() {
                    sample = usage.to_string();
                }
            }
        }
        println!("共 {lines} 行, 其中带 usage 的 {with_usage} 行");
        println!("模型: {}", models.join(", "));
        println!("样例 usage: {}", sample.chars().take(240).collect::<String>());
        if with_usage > 0 {
            // 口径核实：inputTokens 到底含不含缓存读取。含就得在解析时减掉，否则缓存双算
            println!("注意: 解析要求 usage.inputTokens 含 inputTokensDetails[].cached_tokens");
        }
    }
}

