//! 文件系统原语：路径守卫、相对路径换算、mtime、原子写。
//!
//! 这些逻辑原先在 notes.rs / kb.rs / video.rs（路径守卫三兄弟）、store.rs / vault.rs /
//! sync.rs / mail_watch.rs（原子写七处）、token.rs / commands.rs（mtime 五处）各抄一份，
//! 抄写已经产生语义分叉（临时文件名两种、rename 失败删不删临时文件两种、push 重试两套）。
//! 这里一处实现、处处调用。模块只认 std，不沾 Tauri 与业务。

use std::path::{Component, Path, PathBuf};

/// 「还没有选择 X / 找不到 X」的根目录守卫：目录不在（被移走 / 被删掉 / 网络盘没连上）时
/// 给一句能看懂的话。`subject` 是报错里的称呼，如「笔记文件夹」「知识库文件夹」。
pub fn root_dir(root: &str, subject: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err(format!("还没有选择{subject}"));
    }
    let base = PathBuf::from(trimmed);
    if !base.is_dir() {
        return Err(format!("找不到{subject}：{trimmed}"));
    }
    Ok(base)
}

/// 相对路径 → 绝对路径，逐段只接受普通名字。
///
/// `..` / `.` / 盘符 / UNC 前缀在 `Component` 里都不是 `Normal`，于是「往上跳一级」
/// 这种写法到不了这里 —— 模块的边界就是那个根，越界的一律当非法路径拒掉。
pub fn resolve_under(root: &str, rel: &str, subject: &str) -> Result<PathBuf, String> {
    let mut path = root_dir(root, subject)?;
    for raw in rel.split(['/', '\\']) {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        let mut parts = Path::new(part).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(name)), None) => path.push(name),
            _ => return Err(format!("路径不合法：{rel}")),
        }
    }
    Ok(path)
}

/// 绝对路径 → 相对根的路径，统一用 `/` 分隔（渲染层只认这一种写法）。
/// 根外头的路径（strip_prefix 失败）原样返回，与各处旧实现同一条口径。
pub fn rel_under(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 一个「正常的路径段」：非空、不是 `.` / `..`、不带分隔符与 Windows 上的非法字符
pub fn is_plain_segment(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
}

/// 已拿到的元数据 → 修改时间（毫秒）；拿不到（时钟早于纪元）按 0
pub fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 路径 → 修改时间（毫秒）；读不到元数据按 0
pub fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|meta| modified_ms(&meta))
        .unwrap_or(0)
}

/// 先写同目录的临时文件再 rename：rename 在同一卷上是原子的，读者（并发的进程、
/// 或者扫盘的杀毒软件）不会看到半个文件。临时文件是「目标名 + .tmp」，rename 失败时
/// 把它删掉，不留垃圾。
///
/// **父目录不存在时不建**：目录该不该由调用方说了算 —— 数据目录可以悄悄建起来，
/// 「笔记所在文件夹没了」却是要报给用户的真实错误。
pub fn write_atomic(file: &Path, data: &[u8]) -> Result<(), String> {
    let temp = file.with_file_name(format!(
        "{}.tmp",
        file.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&temp, data).map_err(|err| format!("写入失败: {err}"))?;
    std::fs::rename(&temp, file).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("替换文件失败: {err}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fs_util_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 根目录守卫的空串与不存在两种报错() {
        assert_eq!(root_dir("", "笔记文件夹"), Err("还没有选择笔记文件夹".into()));
        assert_eq!(
            root_dir("  ", "知识库文件夹"),
            Err("还没有选择知识库文件夹".into())
        );
        let missing = temp_root("missing_root_guard").join("nope");
        assert!(root_dir(missing.to_str().unwrap(), "视频文件夹")
            .unwrap_err()
            .contains("找不到视频文件夹"));
    }

    #[test]
    fn 相对路径逐段校验_越界一律拒() {
        let root = temp_root("resolve_under");
        let resolved = resolve_under(root.to_str().unwrap(), "a/b.md", "笔记文件夹").unwrap();
        assert_eq!(resolved, root.join("a").join("b.md"));

        assert!(resolve_under(root.to_str().unwrap(), "../escape", "笔记文件夹").is_err());
        assert!(resolve_under(root.to_str().unwrap(), "C:\\win", "笔记文件夹").is_err());
        assert!(resolve_under(root.to_str().unwrap(), "", "笔记文件夹").is_ok());
    }

    #[test]
    fn 相对路径统一用斜杠() {
        let root = temp_root("rel_under");
        let inner = root.join("a").join("b.md");
        assert_eq!(rel_under(&root, &inner), "a/b.md");
        // 根外头的原样返回（strip_prefix 失败）
        assert_eq!(rel_under(&root, &root), "");
    }

    #[test]
    fn 原子写不留临时文件且内容完整() {
        let root = temp_root("write_atomic");
        let target = root.join("data.json");
        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
        // 写成后临时文件应当不在了
        assert!(!root.join("data.json.tmp").exists());
    }

    #[test]
    fn 路径段白名单() {
        assert!(is_plain_segment("abc"));
        assert!(!is_plain_segment(""));
        assert!(!is_plain_segment(".."));
        assert!(!is_plain_segment("a/b"));
        assert!(!is_plain_segment("a:b"));
    }
}
