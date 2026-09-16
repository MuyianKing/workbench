//! 笔记：用户自己挑的一个文件夹里的 markdown 文件。
//!
//! 笔记不是应用维护的一棵 JSON 树，而就是磁盘上这个目录里的 `.md` 文件 ——
//! 于是「笔记」跟任何别的编辑器一样，用户拿 VSCode / Typora 直接改那些文件也成立，
//! 应用里看到的目录树就是文件夹本来的结构。
//!
//! 这一层只做文件系统那点事（列目录 / 读写 / 新建 / 改名 / 移动 / 删除），
//! 树怎么组、秩序怎么排、拖动落到哪由 `src/shared/note.ts` 的纯函数决定 ——
//! 那里有单测，改一版显示口径也不必重编 Rust（与其余模块同一条分工）。
//!
//! **所有命令都只认「相对笔记根的路径」**，由 `resolve` 逐段解析并挡住越界：
//! 渲染层递进来的是一串它自己组的字符串，`..`、绝对路径、盘符这些一律不接受。
//! 笔记根本身（相对路径为空）只能整份扫描，改名 / 移动 / 删除都被挡在 `resolve_child` 那里。

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

/// 只认这两种后缀：编辑器写出来的是 `.md`，`.markdown` 是照顾别处写下的文件
const NOTE_EXTENSIONS: [&str; 2] = [".md", ".markdown"];

/// 递归的深度上限。正常笔记本用不到，拦住的是「有人把盘根选成了笔记本」
const MAX_DEPTH: usize = 12;

/// 扫的时候整棵跳过的目录名（比大小写，Windows 上 `Node_Modules` 也是同一个目录）。
///
/// 点开头的那些（`.git` / `.obsidian` / `.vscode` / `.idea`…）由 `is_hidden` 一并拦住了，
/// 这里放的是**不带点**的噪音：笔记不会住在依赖目录或构建产物里，而它们动辄几万个文件 ——
/// 扫一遍既慢，又只会把目录树塞满。
///
/// 代价说清楚：用户真有一个叫 `build` / `out` 的目录装笔记时，它不会出现在树里。
/// 这类名字与构建产物的重名概率远高于「人拿它当笔记本」，所以按前者处理。
const IGNORED_DIRS: [&str; 10] = [
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    "__pycache__",
    "venv",
    "vendor",
];

fn is_note_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    NOTE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// 点开头的一律不理（`.git`、`.obsidian`、附件目录里那些点文件）
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// 依赖 / 构建产物一类的目录：整棵不走，也不进树
fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

/// 这个条目要不要连子树一起跳过
fn is_skipped_entry(name: &str, is_dir: bool) -> bool {
    if is_hidden(name) {
        return true;
    }
    is_dir && is_ignored_dir(name)
}

/// 笔记根本身。目录不在（被移走 / 被删掉 / 网络盘没连上）时给一句能看懂的话
fn root_path(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("还没有选择笔记文件夹".into());
    }
    let base = PathBuf::from(trimmed);
    if !base.is_dir() {
        return Err(format!("找不到笔记文件夹：{trimmed}"));
    }
    Ok(base)
}

/// 相对路径 → 绝对路径，逐段只接受普通名字。
///
/// `..` / `.` / 盘符 / UNC 前缀在 `Component` 里都不是 `Normal`，于是「往上跳一级」
/// 这种写法到不了这里 —— 笔记模块的边界就是笔记根，越界的一律当非法路径拒掉。
fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let mut path = root_path(root)?;
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

/// 同上，但不接受空路径：改名 / 移动 / 删除针对的是根**里面**的东西，
/// 少这一道的话「删除空路径」就是删掉整个笔记本。
fn resolve_child(root: &str, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("不能对笔记文件夹本身做这个操作".into());
    }
    resolve(root, rel)
}

/// 绝对路径 → 相对笔记根的路径，统一用 `/` 分隔（渲染层只认这一种写法）
fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// 列目录：一层层往下走，只回文件夹与 markdown 文件。
///
/// 回来的是**平铺的清单**（每项带自己的相对路径），不是嵌套结构 —— 树由渲染层组，
/// 这样「文件夹排在文件前面、同层按名字排」这类口径改起来只动 TS。
pub fn scan(root: &str) -> Result<Vec<Value>, String> {
    let base = root_path(root)?;
    let mut out = Vec::new();

    let entries = WalkDir::new(&base)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        // 点开头的、以及依赖 / 构建产物的目录整棵跳过（往里走一步就白扫几万个文件）
        .filter_entry(|entry| {
            entry.depth() == 0
                || !is_skipped_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        });

    for entry in entries {
        // 权限不够 / 刚被删掉都是常态：跳过它，别让整棵树读不出来
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().is_dir();
        if !is_dir && !is_note_file(&name) {
            continue;
        }

        out.push(json!({
            "rel": rel_of(&base, entry.path()),
            "name": name,
            "isDir": is_dir,
            "mtimeMs": mtime_ms(entry.path()),
        }));
    }

    Ok(out)
}

/// 笔记本里所有笔记的正文（素材管理算「这张图被引用了几次」要用）。
///
/// 回来的是「相对路径 + 正文」的平铺清单 —— **怎么用这些字是渲染层的事**：
/// 「算一次引用」长什么样、文件名怎么比，都是有单测的纯函数（见 shared/note-image.ts），
/// 这里只负责把字读出来（与 `scan` 同一条分工）。
///
/// 读不出来的（不是 UTF-8、权限不够、扫描时刚被删掉）跳过并**计数**：
/// 少读一篇就可能把一张还在用的图当成没人引用，调用方要如实把这件事说给用户听。
pub fn scan_texts(root: &str) -> Result<Value, String> {
    let base = root_path(root)?;
    let mut files: Vec<Value> = Vec::new();
    let mut failed = 0usize;

    let entries = WalkDir::new(&base)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !is_skipped_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        });

    for entry in entries {
        let Ok(entry) = entry else {
            failed += 1;
            continue;
        };
        if entry.depth() == 0 || entry.file_type().is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_note_file(&name) {
            continue;
        }

        match std::fs::read_to_string(entry.path()) {
            Ok(text) => files.push(json!({ "rel": rel_of(&base, entry.path()), "text": text })),
            Err(_) => failed += 1,
        }
    }

    Ok(json!({ "files": files, "failed": failed }))
}

/// 读一篇的正文
pub fn read(root: &str, rel: &str) -> Result<String, String> {
    let path = resolve(root, rel)?;
    std::fs::read_to_string(&path).map_err(|err| format!("读取失败：{err}"))
}

/// 写一篇的正文。
///
/// 先写同目录下的临时文件再改名：这是编辑器每 600ms 就可能落一次盘的路径，
/// 直接覆盖时断电 / 进程被杀会留下半篇。改名在 Windows 上会直接覆盖旧文件（与 store.rs 同一套做法）。
pub fn write(root: &str, rel: &str, content: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    let parent = path.parent().unwrap_or(Path::new(""));
    if !parent.is_dir() {
        return Err("这篇笔记所在的文件夹已经不在了".into());
    }

    let temp = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&temp, content).map_err(|err| format!("写入失败：{err}"))?;
    std::fs::rename(&temp, &path).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("保存失败：{err}")
    })
}

/// 新建一个文件夹或一篇空笔记；同名已存在时报错（名字撞车由渲染层按树去重）
pub fn create(root: &str, rel: &str, is_dir: bool) -> Result<(), String> {
    let path = resolve_child(root, rel)?;
    if path.exists() {
        return Err(format!("「{}」已经存在了", path.file_name().unwrap_or_default().to_string_lossy()));
    }

    if is_dir {
        return std::fs::create_dir(&path).map_err(|err| format!("新建文件夹失败：{err}"));
    }
    if !path.parent().map(Path::is_dir).unwrap_or(false) {
        return Err("目标文件夹已经不在了".into());
    }
    std::fs::write(&path, "").map_err(|err| format!("新建笔记失败：{err}"))
}

/// 改名，返回改完之后的相对路径。
///
/// 传进来的是**不带后缀**的名字（树里显示的就是它），文件的后缀由这里补上：
/// 让用户去填 `.md` 只会多一个能填错的地方。
pub fn rename(root: &str, rel: &str, name: &str) -> Result<String, String> {
    let name = validate_name(name)?;
    let path = resolve_child(root, rel)?;
    let is_dir = path.is_dir();
    if !path.exists() {
        return Err("这个东西已经不在了".into());
    }

    let target = match path.parent() {
        Some(parent) => parent.join(if is_dir { name.clone() } else { format!("{name}.md") }),
        None => return Err("路径不合法".into()),
    };
    // 名字没变（连大小写都没变）时什么都不做，不产生一次无谓的磁盘改动
    if target == path {
        return Ok(rel.to_string());
    }
    if target.exists() {
        return Err(format!("这里已经有一个「{name}」了"));
    }

    std::fs::rename(&path, &target).map_err(|err| format!("重命名失败：{err}"))?;
    Ok(rel_of(&root_path(root)?, &target))
}

/// 把一个条目移进某个文件夹，返回移完之后的相对路径。
/// `target_dir` 为空串表示移到笔记根 —— 从文件夹里拖回最外层就是这条路。
pub fn move_entry(root: &str, rel: &str, target_dir: &str) -> Result<String, String> {
    let from = resolve_child(root, rel)?;
    let dir = resolve(root, target_dir)?;

    if !from.is_dir() && !from.is_file() {
        return Err("这个东西已经不在了".into());
    }
    if !dir.is_dir() {
        return Err("目标文件夹已经不在了".into());
    }
    // 把文件夹拖进它自己（或它的下级）会把整棵子树从盘上搬没，必须挡住
    if from.is_dir() && (dir == from || dir.starts_with(&from)) {
        return Err("不能把文件夹移到它自己里面".into());
    }

    let name = from
        .file_name()
        .ok_or_else(|| "路径不合法".to_string())?
        .to_os_string();
    let target = dir.join(&name);
    if target == from {
        return Ok(rel.to_string());
    }
    if target.exists() {
        return Err(format!("目标文件夹里已经有一个「{}」了", name.to_string_lossy()));
    }

    std::fs::rename(&from, &target).map_err(|err| format!("移动失败：{err}"))?;
    Ok(rel_of(&root_path(root)?, &target))
}

/// 删除：文件直接删，文件夹连整棵子树一起删（界面上会先确认过）
pub fn delete(root: &str, rel: &str) -> Result<(), String> {
    let path = resolve_child(root, rel)?;
    if !path.exists() {
        return Err("这个东西已经不在了".into());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|err| format!("删除失败：{err}"))
    } else {
        std::fs::remove_file(&path).map_err(|err| format!("删除失败：{err}"))
    }
}

/// 名字的最后一道防线：目录分隔符、Windows 保留字符、以及 `.` / `..` 这种会跑到别处的名字。
///
/// 渲染层已经收敛过一遍（`sanitizeNoteName`），这里是独立的第二份判断 ——
/// 命令是可以被别处直接调的，落盘的名字不能只靠上游自觉。
fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().trim_end_matches(['.', ' ']);
    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    if name.chars().any(|ch| "<>:\"/\\|?*".contains(ch) || (ch as u32) < 0x20) {
        return Err("名字里不能包含 \\ / : * ? \" < > | 这些字符".into());
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err("名字不能以点开头".into());
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个临时目录；用完删掉（留着的临时目录只会在盘上积垃圾）
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-notes-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rels(entries: &[Value]) -> Vec<String> {
        entries
            .iter()
            .map(|item| item["rel"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// 文件夹与 .md 都列出来，同一个目录里的其它文件（附件、临时文件）不进树；
    /// 点开头的目录整棵跳过。
    #[test]
    fn scans_folders_and_markdown_only() {
        let root = temp_root("scan");
        std::fs::create_dir_all(root.join("工作/归档")).unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(root.join("周报.md"), "# 本周").unwrap();
        std::fs::write(root.join("随手记.markdown"), "随手").unwrap();
        std::fs::write(root.join("图片.png"), "x").unwrap();
        std::fs::write(root.join("工作/归档/旧事.md"), "旧").unwrap();
        std::fs::write(root.join(".obsidian/配置.md"), "x").unwrap();

        let found = rels(&scan(root.to_str().unwrap()).unwrap());
        assert!(found.contains(&"工作".to_string()), "文件夹没被列出来: {found:?}");
        assert!(found.contains(&"工作/归档/旧事.md".to_string()), "嵌套的文件没被列出来: {found:?}");
        assert!(found.contains(&"周报.md".to_string()));
        assert!(found.contains(&"随手记.markdown".to_string()));
        assert!(!found.iter().any(|rel| rel.contains("图片.png")), "非 markdown 的文件不该进树");
        assert!(!found.iter().any(|rel| rel.contains(".obsidian")), "点开头的目录该整棵跳过");
    }

    /// 编辑器 / 工具链留下的那些目录（点开头的一批，以及依赖与构建产物）整棵不进树，
    /// 免得一个「把仓库根当笔记本」的选择把几万个文件拖进目录树
    #[test]
    fn skips_tool_and_build_folders() {
        let root = temp_root("skip");
        let path = root.to_str().unwrap();
        for ignored in [
            ".obsidian",
            ".git",
            ".vscode",
            "node_modules",
            "dist",
            "build",
            "out",
            "target",
            "coverage",
            "__pycache__",
            "venv",
            // 大小写不该让它漏过去（Windows 上那是同一个目录）
            "Node_Modules",
        ] {
            std::fs::create_dir_all(root.join(ignored)).unwrap();
            std::fs::write(root.join(ignored).join("笔记.md"), "x").unwrap();
        }
        // 名字里带这些词的正常目录不受影响
        std::fs::create_dir_all(root.join("node_modules 笔记")).unwrap();
        std::fs::write(root.join("node_modules 笔记/正事.md"), "x").unwrap();
        std::fs::write(root.join("笔记.md"), "x").unwrap();

        let found = rels(&scan(path).unwrap());
        assert_eq!(
            found,
            vec!["node_modules 笔记".to_string(), "node_modules 笔记/正事.md".to_string(), "笔记.md".to_string()],
            "被跳过的目录里混进了东西，或者正常目录被误伤: {found:?}"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 笔记不是在的目录 / 空地址：给一句能看懂的话，而不是一个空的树
    #[test]
    fn missing_root_is_reported() {
        let missing = std::env::temp_dir().join("wb-notes-not-there");
        assert!(scan(missing.to_str().unwrap()).is_err());
        assert!(scan("   ").is_err());
    }

    /// 越界一律挡住：`..`、绝对路径、盘符都得拒
    #[test]
    fn escaping_the_root_is_rejected() {
        let root = temp_root("escape");
        let path = root.to_str().unwrap();

        assert!(resolve_child(path, "..").is_err());
        assert!(resolve(path, "../别的目录/秘密.md").is_err());
        assert!(resolve(path, "C:/Windows/win.ini").is_err());
        assert!(resolve(path, "工作/../../外.md").is_err());
        // 空路径：根本身不能改名 / 移动 / 删除
        assert!(resolve_child(path, "").is_err());
        assert!(resolve_child(path, "  ").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 正文读写来回一趟，且写盘走的是「临时文件 + 改名」——目录里不该留下临时文件
    #[test]
    fn write_and_read_roundtrip() {
        let root = temp_root("write");
        let path = root.to_str().unwrap();
        create(path, "日记.md", false).unwrap();

        write(path, "日记.md", "# 今天\n\n写了一篇。").unwrap();
        assert_eq!(read(path, "日记.md").unwrap(), "# 今天\n\n写了一篇。");

        let left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["日记.md".to_string()], "写盘留下了临时文件: {left:?}");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 新建：同名挡住；改名补上 .md 后缀并回新的相对路径
    #[test]
    fn create_and_rename() {
        let root = temp_root("rename");
        let path = root.to_str().unwrap();
        create(path, "工作", true).unwrap();
        create(path, "工作/周报.md", false).unwrap();
        assert!(create(path, "工作", true).is_err(), "同名文件夹该被挡住");

        let renamed = rename(path, "工作/周报.md", "本周小结").unwrap();
        assert_eq!(renamed, "工作/本周小结.md");
        assert!(root.join("工作/本周小结.md").is_file());

        // 改成一个已经存在的名字：挡住并把原因说清楚
        create(path, "工作/别的.md", false).unwrap();
        assert!(rename(path, "工作/别的.md", "本周小结").is_err());
        // 名字里带路径分隔符 / 保留字符：挡住（不然会写到别的地方去）
        assert!(rename(path, "工作/别的.md", "../跑掉").is_err());
        assert!(rename(path, "工作/别的.md", "a?b").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 拖动：文件移进文件夹再移回来；文件夹不能移进自己的下级
    #[test]
    fn moving_between_folders() {
        let root = temp_root("move");
        let path = root.to_str().unwrap();
        create(path, "工作", true).unwrap();
        create(path, "工作/归档", true).unwrap();
        create(path, "随笔.md", false).unwrap();

        let moved = move_entry(path, "随笔.md", "工作").unwrap();
        assert_eq!(moved, "工作/随笔.md");
        assert!(root.join("工作/随笔.md").is_file());

        // 目标文件夹里已经有同名的：挡住，不覆盖
        assert!(create(path, "工作/随笔.md", false).is_err());
        // 移回根目录（空路径就是根）
        let back = move_entry(path, "工作/随笔.md", "").unwrap();
        assert_eq!(back, "随笔.md");

        assert!(move_entry(path, "工作", "工作/归档").is_err(), "文件夹不该能移进自己的下级");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 删除：文件夹连整棵子树一起走
    #[test]
    fn deleting_a_folder_takes_its_subtree() {
        let root = temp_root("delete");
        let path = root.to_str().unwrap();
        create(path, "工作", true).unwrap();
        create(path, "工作/归档", true).unwrap();
        create(path, "工作/归档/旧事.md", false).unwrap();

        delete(path, "工作").unwrap();
        assert!(!root.join("工作").exists());
        // 已经不在了（例如连着点了两次）如实报错，不当成成功
        assert!(delete(path, "工作").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }
}
