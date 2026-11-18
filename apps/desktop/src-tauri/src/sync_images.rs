//! 笔记图片的同步仓库读写：上传 / 列清单 / 删除 / 旧图迁移。
//!
//! 从 `sync.rs` 拆出来的独立一块：它碰的是**用户自己的图片仓库**（笔记里粘贴的图），
//! 与用量分片那几份「一台机器一份」的文件不是一类东西；git 基础设施仍复用
//! `sync.rs` 的那几个 pub(crate) 助手（clone / 锁 / 凭证 / 推送）。
//!
//! 图片按 origin 共享层或本机层存放（算法在 packages/notes/src/note-image.ts）；
//! `migrate_images` 把旧的本机层图搬进共享层，并在笔记本文件夹里改写正文 URL ——
//! 两个仓库各提交一次，顺序是先搬图再改正文（见 docs/modules/notes.md）。

use std::path::Path;

use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::fs_util;
use crate::fs_util::is_plain_segment;
use crate::paths;
use crate::sync::{ensure_clone, lock_workflow, push_with_retry, run_git, run_git_quiet, set_git_auth, GIT_TIMEOUT, MAX_IMAGE_DEPTH};
use serde::Serialize;

/// 迁移结果（图片仓库这一侧）。带 `@contract` → 生成 TS 类型，前端据此收敛形状。
// @contract
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMigrationResult {
    /// 真的搬走的图数（已经不在的跳过）
    pub moved: u32,
    /// 写回了正文的篇数
    pub rewritten: u32,
    /// 读不出来 / 被并发改过而跳过的篇数
    pub failed: u32,
    /// 推上去的分支（保留给界面显示 / 排查）
    pub branch: String,
    /// git 输出（失败时界面拿它说明原因）
    pub log: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImageMigrationRename {
    pub from: String,
    pub to: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImageUrlReplacement {
    pub from: String,
    pub to: String,
}

// ---------- 笔记里的图片 ----------

/// 把一张图片写进**图片仓库**并推上去，返回它在仓库里的相对路径与推上去的分支。
///
/// 与用量同步共用同一套 git 机制（克隆缓存、凭据、pull → 写 → commit → push），
/// 但地址与克隆目录都是**另一套**：用户完全可以把图片放在另一个仓库里。
/// 这一层只搬字节 —— 不转格式、不压尺寸、也不看内容（渲染层从粘贴的图片里读到的就是原始字节）。
///
/// 子目录与文件名由渲染层算好（带时间戳与随机段，见 `packages/notes/src/note-image.ts`），
/// 这里做最后一道把关：挡掉会把文件写到克隆目录之外的名字。
pub fn publish_image(
    repo: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    publish_image_at(&paths::image_sync_dir(), repo, dir, name, bytes)
}

/// 同上，克隆目录由调用方给（单测用临时目录跑真实 git 流程）
fn publish_image_at(
    clone_dir: &Path,
    repo: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err("还没有配置图片仓库（设置 → 笔记图片）".into());
    }
    if bytes.is_empty() {
        return Err("这是一张空图片".into());
    }

    let _workflow = lock_workflow(clone_dir);
    // 必须在任何 git 调用之前设好：下面的 ensure_clone 就要走网络
    set_git_auth();
    let relative = image_relative_path(dir, name)?;
    let (dir_path, branch) = ensure_clone(clone_dir, repo)?;

    let file = dir_path.join(&relative);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    // 先写临时文件再改名：与 store.rs 同一个道理 —— 中途断电时，读到的不是半张图。
    // 临时文件**不参与这次提交**（下面只 add 这一个相对路径），所以它进不了仓库历史
    fs_util::write_atomic(&file, bytes).map_err(|err| format!("保存失败: {err}"))?;

    let mut log: Vec<String> = Vec::new();
    run_git(&["add", "-A", "--", &relative], Some(&dir_path), GIT_TIMEOUT)?;

    // 同名文件重传（理论上不会，文件名带随机段）时不产生空提交
    let changed = !run_git_quiet(&["diff", "--cached", "--quiet", "--", &relative], &dir_path);
    if changed {
        let message = format!("image:{name}");
        log.push(run_git(&["commit", "-m", &message], Some(&dir_path), GIT_TIMEOUT)?);
    }

    // 推不动（远端在 pull 之后又动了，另一处刚推过）时 rebase 一次再试
    push_with_retry(&dir_path, &branch, &mut log)?;

    Ok(json!({ "path": relative, "branch": branch, "changed": changed, "log": log.join("\n") }))
}

/// 图片仓库里现在有哪些图（顺手把本地克隆拉到最新）。
///
/// 只扫**设置里那个子目录**：仓库里还住着 README 之类的东西，它们不该出现在素材列表里。
/// 回来的是「相对路径（仓库内写法，与上传回来的是同一种）+ 文件名 + 字节数」，
/// 名字不要后缀、谁被引用了多少次这类判断都留在渲染层（见 packages/notes/src/note-image.ts）。
///
/// 与上传一样，配置为空是「还没设」而不是「空仓库」：那种情况要报错，
/// 界面才能提示去哪儿填，而不是显示成「一张图都没有」。
pub fn list_images(repo: &str, dir: &str) -> Result<Value, String> {
    list_images_at(&paths::image_sync_dir(), repo, dir)
}

fn list_images_at(
    clone_dir: &Path,
    repo: &str,
    dir: &str,
) -> Result<Value, String> {
    let clean = require_image_repo(repo)?;
    let clean_dir = normalize_image_dir(dir)?;

    let _workflow = lock_workflow(clone_dir);
    // 必须在任何 git 调用之前设好：ensure_clone 要走网络
    set_git_auth();
    let (root, branch) = ensure_clone(clone_dir, &clean)?;

    let base = if clean_dir.is_empty() {
        root.clone()
    } else {
        root.join(&clean_dir)
    };

    let mut files: Vec<Value> = Vec::new();
    let walker = WalkDir::new(&base)
        .max_depth(MAX_IMAGE_DEPTH)
        .follow_links(false)
        .sort_by_file_name();
    for entry in walker.into_iter().filter_entry(|entry| {
        entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
    }) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = repo_rel_path(&root, entry.path());
        if !is_image_file(&rel) {
            continue;
        }

        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        files.push(json!({
            "path": rel,
            "name": entry.file_name().to_string_lossy(),
            "size": size,
        }));
    }

    Ok(json!({ "branch": branch, "dir": clean_dir, "files": files }))
}

/// 批量删掉仓库里的图片，**一次提交、一次推送**（删图也是一次改动，要进仓库历史）。
///
/// 递进来的路径是「列表回来的那种仓库内相对路径」，逐条过 `image_repo_path`：
/// 只认当前图片目录里的图片，越界的一律拒掉（那是用户的磁盘，不只是这个仓库）。
/// 已经不在的文件跳过而不是整批失败 —— 上一次删到一半、或者别处已经删过了，
/// 都不该让这一批白做。一张都没删到时不提交空提交。
pub fn delete_images(
    repo: &str,
    dirs: &[String],
    paths: &[String],
) -> Result<Value, String> {
    delete_images_at(&paths::image_sync_dir(), repo, dirs, paths)
}

fn delete_images_at(
    clone_dir: &Path,
    repo: &str,
    dirs: &[String],
    paths: &[String],
) -> Result<Value, String> {
    let clean = require_image_repo(repo)?;
    if paths.is_empty() {
        return Err("没有选中要删除的图片".into());
    }

    let _workflow = lock_workflow(clone_dir);
    set_git_auth();
    let (root, branch) = ensure_clone(clone_dir, &clean)?;

    let mut removed: Vec<String> = Vec::new();
    for raw in paths {
        let rel = image_repo_path_in(dirs, raw)?;
        if !root.join(&rel).is_file() {
            continue;
        }
        // `git rm` 会连工作区一起删掉并暂存这次删除（不是只删文件、让 git 看到「未暂存的删除」）
        run_git(&["rm", "--quiet", "--", &rel], Some(&root), GIT_TIMEOUT)?;
        removed.push(rel);
    }

    if removed.is_empty() {
        return Ok(json!({
            "deleted": 0, "changed": false, "branch": branch, "log": String::new(), "paths": removed,
        }));
    }

    let message = format!("image: 清理 {} 张没有引用的图片", removed.len());
    let mut log: Vec<String> = Vec::new();
    log.push(run_git(&["commit", "-m", &message], Some(&root), GIT_TIMEOUT)?);

    // 推不动（远端在 pull 之后又动了，另一处刚推过）时 rebase 一次再试
    push_with_retry(&root, &branch, &mut log)?;

    Ok(json!({
        "deleted": removed.len(),
        "changed": true,
        "branch": branch,
        "log": log.join("\n"),
        "paths": removed,
    }))
}

/**
 * 把旧层的图搬到 origin 共享层，并改写笔记本正文里的图片 URL。
 *
 * 两个仓库各提交一次，做不到原子（见 docs/modules/notes.md）：
 *  1. **图片仓库**：`lock_workflow` + `set_git_auth` + `ensure_clone`，逐条 `git mv` 旧路径 → 新层
 *     （边界复用 `image_repo_path_in`，只允许从 oldDir 搬到 newDir），一次 commit + push；
 *  2. **笔记本文件夹**：递归扫 `.md`（复用 notes 的跳过名单），逐篇套渲染层算好的字面替换，
 *     带 mtime 校验写回（复用 notes::write 的语义），改过的篇数 / 跳过的篇数如实返回。
 *
 * 笔记本仓库的 commit + push 不在这里 —— 由上层紧接着触发一次笔记同步负责。
 * 顺序：先搬图（此时旧 URL 还能打开，因为 git mv 在 images 仓库同一提交里完成），再改正文，
 * 这样任何时刻正文里的 URL 要么指向旧路径（图还在）、要么指向新路径（图已搬好）。
 */
pub fn migrate_images(
    repo: &str,
    root: &str,
    old_dir: &str,
    new_dir: &str,
    renames: &[ImageMigrationRename],
    replacements: &[ImageUrlReplacement],
) -> Result<ImageMigrationResult, String> {
    migrate_images_at(&paths::image_sync_dir(), repo, root, old_dir, new_dir, renames, replacements)
}

fn migrate_images_at(
    clone_dir: &Path,
    repo: &str,
    root: &str,
    old_dir: &str,
    new_dir: &str,
    renames: &[ImageMigrationRename],
    replacements: &[ImageUrlReplacement],
) -> Result<ImageMigrationResult, String> {
    let clean = require_image_repo(repo)?;
    if renames.is_empty() {
        return Err("没有需要迁移的图片".into());
    }
    let old_clean = normalize_image_dir(old_dir)?;
    let new_clean = normalize_image_dir(new_dir)?;
    if old_clean.is_empty() || new_clean.is_empty() || old_clean == new_clean {
        return Err("迁移的源目录与目标目录不合法或相同".into());
    }

    // ---- 1. 图片仓库：搬图 + 一次提交推送 ----
    let _workflow = lock_workflow(clone_dir);
    set_git_auth();
    let (img_root, branch) = ensure_clone(clone_dir, &clean)?;

    let allowed = vec![old_clean.clone()];
    let mut moved = 0u32;
    let mut log: Vec<String> = Vec::new();
    for rename in renames {
        let from = image_repo_path_in(&allowed, &rename.from)?;
        let to = {
            // 目标必须落在 new_dir 一层：文件名由渲染层给，只认普通名字
            if !is_plain_segment(rename.name.trim()) {
                return Err(format!("迁移目标文件名不合法：{}", rename.name));
            }
            let t = validate_image_path(&rename.to)?;
            if !t.starts_with(&format!("{new_clean}/")) {
                return Err(format!("迁移目标不在共享层里：{}", rename.to));
            }
            t
        };
        if !img_root.join(&from).is_file() {
            continue; // 已经不在（别处删过 / 迁移到一半），跳过
        }
        // git mv：移动工作区文件并暂存；目标父目录不存在时先建（git mv 不会建中间目录）
        if let Some(parent) = img_root.join(&to).parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("建共享层目录失败：{err}"))?;
        }
        run_git(&["mv", "--", &from, &to], Some(&img_root), GIT_TIMEOUT)?;
        moved += 1;
    }

    if moved == 0 {
        return Ok(ImageMigrationResult { moved: 0, rewritten: 0, failed: 0, branch, log: String::new() });
    }
    log.push(run_git(&["commit", "-m", &format!("image: 迁移 {moved} 张旧图到共享层")], Some(&img_root), GIT_TIMEOUT)?);
    push_with_retry(&img_root, &branch, &mut log)?;

    // ---- 2. 笔记本文件夹：逐篇替换正文（带 mtime 校验） ----
    let notes_root = crate::fs_util::root_dir(root, "笔记文件夹")?;
    let mut rewritten = 0u32;
    let mut failed = 0u32;
    for entry in WalkDir::new(&notes_root)
        .max_depth(crate::notes::MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
    {
        let Ok(entry) = entry else { failed += 1; continue };
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if crate::notes::is_skipped_entry(&name, false) || !crate::notes::is_note_file(&name) {
            continue;
        }
        let path = entry.path();
        let before = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(_) => { failed += 1; continue },
        };
        let expected = crate::fs_util::mtime_ms(path);
        let mut after = before.clone();
        // 大小写不敏感地套每条字面替换（别处编辑器可能把路径写成大写）
        for pair in replacements {
            after = replace_all_ci(&after, &pair.from, &pair.to);
        }
        if after == before {
            continue;
        }
        // mtime 校验：读完之后、写回之前若别处改过，跳过这篇（记 failed），不静默覆盖
        if crate::fs_util::mtime_ms(path) != expected {
            failed += 1;
            continue;
        }
        if crate::fs_util::write_atomic(path, after.as_bytes()).is_err() {
            failed += 1;
            continue;
        }
        rewritten += 1;
    }

    Ok(ImageMigrationResult { moved, rewritten, failed, branch, log: log.join("\n") })
}

/// 大小写不敏感地把正文里所有 `from` 换成 `to`（Rust 侧只做机械替换，编码口径在 TS 侧算好）
fn replace_all_ci(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let lower = text.to_ascii_lowercase();
    let needle = from.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut low_rest = lower.as_str();
    loop {
        let Some(at) = low_rest.find(&needle) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..at]);
        out.push_str(to);
        rest = &rest[at + from.len()..];
        low_rest = &low_rest[at + needle.len()..];
    }
    out
}

/// 图片仓库地址：与上传同一条口径（空 = 还没配，报错而不是当成空仓库）
fn require_image_repo(repo: &str) -> Result<String, String> {
    let clean = repo.trim();
    if clean.is_empty() {
        return Err("还没有配置图片仓库（设置 → 笔记图片）".into());
    }
    Ok(clean.to_string())
}

/// 绝对路径 → 相对仓库根的路径，统一用 `/` 分隔
fn repo_rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 把「子目录 + 文件名」拼成仓库里的相对路径，并挡住越界与非法名字。
///
/// 名字里带分隔符或 `..` 就能写到克隆目录外面去（那是用户的磁盘，不只是这个仓库），
/// 所以这里只接受一个「正常的文件名」。
fn image_relative_path(dir: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if !is_plain_segment(name) {
        return Err(format!("图片文件名不合法：{name}"));
    }

    let dir = normalize_image_dir(dir)?;
    if dir.is_empty() {
        return Ok(name.to_string());
    }
    Ok(format!("{dir}/{name}"))
}

/// 收敛图片子目录：去掉空的与 `.` 段，挡住 `..` 与其它非法字符；空串表示仓库根目录。
fn normalize_image_dir(dir: &str) -> Result<String, String> {
    let raw = dir.trim().replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if !is_plain_segment(part) {
            return Err(format!("图片目录不合法：{dir}"));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}


/// 认得出是图片的后缀（大小写不比）。素材管理只认这些：
/// 仓库里还住着 README 之类的东西，混进图片列表只会让人以为那些也能删。
const IMAGE_EXTENSIONS: [&str; 10] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "tiff", "ico",
];

fn is_image_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    match lower.rsplit_once('.') {
        Some((_, ext)) => IMAGE_EXTENSIONS.contains(&ext),
        None => false,
    }
}

/// 渲染层递回来的一条图片路径（仓库内相对写法）→ 收过的同一条，并挡住越界。
///
/// 与 `image_relative_path` 是同一条边界，区别在于这条路径可能带着子目录
/// （列表回来的子目录里的图）。三条都要拦住：逐段是普通名字、必须是图片、
/// 必须落在**当前配置的那个子目录**里 —— 少最后一条，删图就能删到仓库里别的东西上。
fn image_repo_path(dir: &str, rel: &str) -> Result<String, String> {
    let rel = rel.trim().replace('\\', "/");
    let segments: Vec<&str> = rel.split('/').filter(|part| !part.trim().is_empty()).collect();
    if segments.is_empty() || !segments.iter().all(|part| is_plain_segment(part.trim())) {
        return Err(format!("图片路径不合法：{rel}"));
    }

    let clean = segments.join("/");
    if !is_image_file(&clean) {
        return Err(format!("不是图片文件：{rel}"));
    }

    let dir = normalize_image_dir(dir)?;
    if dir.is_empty() {
        // 图片放在仓库根目录时，路径只能是一层（与上传时同一条口径）
        if clean.contains('/') {
            return Err(format!("这张图不在仓库根目录里：{rel}"));
        }
    } else if !clean.starts_with(&format!("{dir}/")) {
        return Err(format!("这张图不在图片目录「{dir}」里：{rel}"));
    }
    Ok(clean)
}

/// 与 `image_repo_path` 同一条边界，但允许落在 `dirs` 里任意一个目录（并集：共享层 + 旧层）。
/// 逐条复用 `image_repo_path` 的校验，一条都不匹配就拒 —— 仍保证删不到清单之外的图。
fn image_repo_path_in(dirs: &[String], rel: &str) -> Result<String, String> {
    for dir in dirs {
        if let Ok(clean) = image_repo_path(dir, rel) {
            return Ok(clean);
        }
    }
    Err(format!("这张图不在允许的图片目录里：{rel}"))
}

/// `image_repo_path` 的前半段：逐段普通名字 + 必须是图片，不判目录前缀
fn validate_image_path(rel: &str) -> Result<String, String> {
    let rel = rel.trim().replace('\\', "/");
    let segments: Vec<&str> = rel.split('/').filter(|part| !part.trim().is_empty()).collect();
    if segments.is_empty() || !segments.iter().all(|part| is_plain_segment(part.trim())) {
        return Err(format!("图片路径不合法：{rel}"));
    }
    let clean = segments.join("/");
    if !is_image_file(&clean) {
        return Err(format!("不是图片文件：{rel}"));
    }
    Ok(clean)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc;
    use crate::sync::{run_git, CLONE_TIMEOUT, GIT_ENVS, GIT_TIMEOUT};
    /// 图片的仓库内相对路径：子目录被规整，越界与非法文件名一律挡住
    #[test]
    fn image_paths_stay_inside_the_repo() {
        assert_eq!(
            image_relative_path("images", "20260916-104512-ab12cd34.png").unwrap(),
            "images/20260916-104512-ab12cd34.png"
        );
        // 子目录可以留空、可以带多余的斜杠，统一成 `/`
        assert_eq!(image_relative_path("", "a.png").unwrap(), "a.png");
        assert_eq!(image_relative_path(" /images/ ", "a.png").unwrap(), "images/a.png");
        assert_eq!(image_relative_path("images\\notes", "a.png").unwrap(), "images/notes/a.png");

        // 文件名只能是一个正常的文件名：带分隔符或 `..` 就能写到克隆目录外面去
        assert!(image_relative_path("images", "../逃出去.png").is_err());
        assert!(image_relative_path("images", "a/b.png").is_err());
        assert!(image_relative_path("images", "a\\b.png").is_err());
        assert!(image_relative_path("images", "C:evil.png").is_err());
        assert!(image_relative_path("images", "  ").is_err());
        assert!(image_relative_path("images", "..").is_err());
        // 子目录同理
        assert!(image_relative_path("../外面", "a.png").is_err());
        assert!(image_relative_path("images/../../x", "a.png").is_err());
    }

    /// 素材管理删图时那条边界：递进来的路径必须落在图片目录里、必须是图片。
    /// 少一条就可能把仓库里别的东西（用量分片、配置文件）删掉。
    #[test]
    fn deleting_only_touches_images_inside_the_image_dir() {
        // 正常的一条：与列表回来的写法一致
        assert_eq!(
            image_repo_path("images", "images/20260916-104512-ab12cd34.png").unwrap(),
            "images/20260916-104512-ab12cd34.png"
        );
        // 子目录里的图（用户自己整理过的仓库）
        assert_eq!(
            image_repo_path("images", "images/2026/09/a.PNG").unwrap(),
            "images/2026/09/a.PNG"
        );
        // 配置成仓库根目录时，只认一层（与上传同一条口径）
        assert_eq!(image_repo_path("", "a.png").unwrap(), "a.png");
        assert!(image_repo_path("", "sub/a.png").is_err());

        // 越界
        assert!(image_repo_path("images", "../逃出去.png").is_err());
        assert!(image_repo_path("images", "images/../../x.png").is_err());
        assert!(image_repo_path("images", "images/C:evil.png").is_err());
        assert!(image_repo_path("images", "..\\逃出去.png").is_err());
        // 反斜杠按分隔符收敛（Windows 上写下的路径就是这个样子），逐段仍然只认普通名字
        assert_eq!(
            image_repo_path("images", "images/sub\\a.png").unwrap(),
            "images/sub/a.png"
        );
        // 不是图片
        assert!(image_repo_path("images", "images/README.md").is_err());
        assert!(image_repo_path("images", "images/pic.png.part").is_err());
        // 不在图片目录里（仓库里别的东西）
        assert!(image_repo_path("images", "token-usage/dev-a.json").is_err());
        assert!(image_repo_path("images", "20260916-104512-ab12cd34.png").is_err());
        assert!(image_repo_path("images", "  ").is_err());
    }

    /// 图片现在按「设备 / 笔记本」分了两层（见 packages/notes/src/note-image.ts 的 imageScopeDir），
    /// 传下来的是**整条三层目录**。这条钉住的正是它的意义：别的笔记本、别的机器那一层里的图，
    /// 路径再合法也删不到 —— 少了这一条，「素材管理只列自己这一层」就只是界面上的一句好话。
    #[test]
    fn images_are_scoped_to_one_device_and_one_notebook() {
        let scope = "images/6f1e2d3c-4b5a/notes-1f3a9c02";

        // 上传：进这一层里
        assert_eq!(
            image_relative_path(scope, "20260916-104512-ab12cd34.png").unwrap(),
            "images/6f1e2d3c-4b5a/notes-1f3a9c02/20260916-104512-ab12cd34.png"
        );
        // 删除：这一层里的图认，写法仍然是仓库内相对路径
        assert_eq!(
            image_repo_path(scope, "images/6f1e2d3c-4b5a/notes-1f3a9c02/a.png").unwrap(),
            "images/6f1e2d3c-4b5a/notes-1f3a9c02/a.png"
        );

        // 别的笔记本那一层（同一个仓库、同一个设备）：挡住
        assert!(image_repo_path(scope, "images/6f1e2d3c-4b5a/别的-0b1c2d3e/a.png").is_err());
        // 别的机器那一层：挡住
        assert!(image_repo_path(scope, "images/9a8b7c6d-3e2f/notes-1f3a9c02/a.png").is_err());
        // 从这一层往上跳：仍然挡住（逐段只认普通名字）
        assert!(image_repo_path(scope, "images/6f1e2d3c-4b5a/notes-1f3a9c02/../别的/a.png").is_err());
        // 图片直接堆在图片目录底下（改版前那种老位置）：不属于任何一层，列不到也删不到
        assert!(image_repo_path(scope, "images/20260916-104512-ab12cd34.png").is_err());
    }

    /// 真跑一遍 git：空远端 → 推一张图上去 → 远端分支上真的有它，工作区里不留临时文件。
    ///
    /// 这条链最容易悄悄坏掉的地方是分支：空仓库的远端 HEAD 指向一个还不存在的分支，
    /// 挑错分支就会推到另一个分支上（图片在仓库里，但访问地址拼出来的是默认分支，图裂）。
    #[test]
    fn publishes_an_image_through_a_real_git_remote() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-image-{}", uuid::Uuid::new_v4()));
        let remote = root.join("images.git");
        let clone = root.join("clone");
        std::fs::create_dir_all(&root).unwrap();

        let init = proc::run_direct(
            "git",
            &[
                "init".to_string(),
                "--bare".to_string(),
                remote.to_string_lossy().into_owned(),
            ],
            GIT_TIMEOUT,
            None,
            &GIT_ENVS,
        )
        .unwrap();
        assert!(init.ok(), "git init --bare 失败: {}", init.stderr);

        let repo = remote.to_string_lossy().into_owned();
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4];

        let published = publish_image_at(
            &clone,
            &repo,
            "images",
            "20260916-104512-ab12cd34.png",
            &bytes,
        )
        .unwrap();
        assert_eq!(published["path"], json!("images/20260916-104512-ab12cd34.png"));
        let branch = published["branch"].as_str().unwrap();
        assert!(!branch.is_empty(), "分支名不该是空的");
        assert_eq!(published["changed"], json!(true));

        // 本地工作区里就是那张图，且没有留下临时文件
        assert_eq!(
            std::fs::read(clone.join("images/20260916-104512-ab12cd34.png")).unwrap(),
            bytes
        );
        let leftovers: Vec<String> = std::fs::read_dir(clone.join("images"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "20260916-104512-ab12cd34.png")
            .collect();
        assert!(leftovers.is_empty(), "图片目录里留下了别的东西: {leftovers:?}");

        // 远端那个分支上真的有它：从远端重新克隆一份来验证（不是看本地那份工作区）
        let again = root.join("clone-again");
        run_git(
            &[
                "clone",
                "--branch",
                branch,
                &repo,
                &again.to_string_lossy(),
            ],
            None,
            CLONE_TIMEOUT,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(again.join("images/20260916-104512-ab12cd34.png")).unwrap(),
            bytes,
            "远端分支上没有这张图"
        );

        // 同一张图再推一次：文件名与内容都一样，不该产生第二条提交
        let second = publish_image_at(
            &clone,
            &repo,
            "images",
            "20260916-104512-ab12cd34.png",
            &bytes,
        )
        .unwrap();
        assert_eq!(second["changed"], json!(false));
        let count = run_git(&["rev-list", "--count", "--all"], Some(&remote), GIT_TIMEOUT).unwrap();
        assert_eq!(count, "1", "内容没变时不该多出提交");

        // 没填仓库地址时给一句能看懂的话，而不是去 git 那里报一堆参数错误
        assert!(publish_image_at(&clone, "  ", "images", "a.png", &bytes).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 素材管理那条链：列图片 → 批量删 → **远端真的少了那几张**，而且只多出一条提交。
    ///
    /// 与粘贴上传同一条 git 流程，方向相反。最容易悄悄坏成「本地看着删了、远端还在」
    /// （没提交、或提交了没推），所以验证一律从远端重新克隆一份来看，不看本地工作区。
    #[test]
    fn lists_and_deletes_images_through_a_real_git_remote() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-assets-{}", uuid::Uuid::new_v4()));
        let remote = root.join("images.git");
        let clone = root.join("clone");
        std::fs::create_dir_all(&root).unwrap();

        let init = proc::run_direct(
            "git",
            &[
                "init".to_string(),
                "--bare".to_string(),
                remote.to_string_lossy().into_owned(),
            ],
            GIT_TIMEOUT,
            None,
            &GIT_ENVS,
        )
        .unwrap();
        assert!(init.ok(), "git init --bare 失败: {}", init.stderr);

        let repo = remote.to_string_lossy().into_owned();
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 7, 7, 7];
        let (keep, drop) = (
            "20260916-104513-ffffffff.png",
            "20260916-104512-ab12cd34.png",
        );
        // 传下来的目录是「图片目录 / 设备 / 笔记本」三层（见 packages/notes/src/note-image.ts 的 imageScopeDir）
        let scope = "images/6f1e2d3c-4b5a/notes-2f3a9c02";
        let dirs = vec![scope.to_string()];
        // 同一个仓库、同一个设备下的**另一个笔记本**：它的图不该出现在这一次的清单里，
        // 也不该被这一次的删除够到 —— 这正是那两层目录存在的意义
        let elsewhere = "images/6f1e2d3c-4b5a/别的-0b1c2d3e";
        let other = "20260916-104511-00000000.png";

        publish_image_at(&clone, &repo, scope, drop, &bytes).unwrap();
        publish_image_at(&clone, &repo, scope, keep, &bytes).unwrap();
        publish_image_at(&clone, &repo, elsewhere, other, &bytes).unwrap();

        // 列出来的就是这一层里那两张（含大小）
        let listed = list_images_at(&clone, &repo, scope).unwrap();
        let files = listed["files"].as_array().unwrap();
        assert_eq!(files.len(), 2, "列出来的是: {files:?}");
        assert_eq!(files[0]["path"], json!(format!("{scope}/{drop}")));
        assert_eq!(files[0]["name"], json!(drop));
        assert_eq!(files[0]["size"], json!(bytes.len() as u64));

        // 越界 / 非图片 / 别的层里的文件一律拒掉（这些路径是渲染层递进来的）
        for bad in [
            "../逃出去.png".to_string(),
            "images/../../x.png".to_string(),
            "images/README.md".to_string(),
            "token-usage/dev-a.json".to_string(),
            drop.to_string(),
            // 别的笔记本那一层：路径本身合法，但不属于这次的那一层
            format!("{elsewhere}/{other}"),
            // 图片目录底下那张（改版前的老位置）：不属于任何一层
            format!("images/{keep}"),
        ] {
            let rejected = delete_images_at(&clone, &repo, &dirs, std::slice::from_ref(&bad));
            assert!(rejected.is_err(), "这条路径本该被拒掉: {bad}");
        }

        // 删一张；另一条路径不存在，跳过而不是让整批失败
        let missing = format!("{scope}/20260916-104515-missing.png");
        let removed = delete_images_at(
            &clone,
            &repo,
            &dirs,
            &[format!("{scope}/{drop}"), missing.clone()],
        )
        .unwrap();
        assert_eq!(removed["deleted"], json!(1));
        assert_eq!(removed["changed"], json!(true));
        assert_eq!(removed["paths"], json!([format!("{scope}/{drop}")]));

        // 远端真的少了它：重新克隆一份来看
        let branch = removed["branch"].as_str().unwrap();
        let again = root.join("clone-again");
        run_git(
            &[
                "clone",
                "--branch",
                branch,
                &repo,
                &again.to_string_lossy(),
            ],
            None,
            CLONE_TIMEOUT,
        )
        .unwrap();
        assert!(
            !again.join(scope).join(drop).exists(),
            "远端还留着那张图"
        );
        assert!(
            again.join(scope).join(keep).exists(),
            "没让删的图不该跟着消失"
        );
        assert!(
            again.join(elsewhere).join(other).exists(),
            "别的笔记本那一层不该被动过"
        );

        // 再删一次同一张（已经不在）：不该产生空提交
        let gone = delete_images_at(&clone, &repo, &dirs, &[format!("{scope}/{drop}")]).unwrap();
        assert_eq!(gone["deleted"], json!(0));
        assert_eq!(gone["changed"], json!(false));
        let count = run_git(&["rev-list", "--count", "--all"], Some(&remote), GIT_TIMEOUT).unwrap();
        assert_eq!(count, "4", "三张图各一条提交 + 删图一条，不该多出空提交");

        // 一张都没选 / 没配仓库：各给一句能看懂的话
        assert!(delete_images_at(&clone, &repo, &dirs, &[]).is_err());
        assert!(list_images_at(&clone, "  ", scope).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 迁移：把旧层的图 git mv 到共享层、改写正文 URL，别的笔记本的图不动
    #[test]
    fn migrates_old_images_into_shared_layer_and_rewrites_notes() {
        if proc::probe_version("git").is_none() {
            return;
        }
        let root = std::env::temp_dir().join(format!("wb-migrate-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote.git");
        let clone = root.join("clone");
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        proc::run_direct(
            "git",
            &["init".to_string(), "--bare".to_string(), remote.to_string_lossy().into_owned()],
            GIT_TIMEOUT,
            None,
            &GIT_ENVS,
        )
        .unwrap();

        let old_dir = "images/device-a/notebook-old";
        let new_dir = "images/origin-3f2a91c4";
        let moved_name = "20260916-104512-ab12cd34.png";
        let kept_name = "20260916-104513-keepme00.png";
        let bytes = b"fake png bytes";
        publish_image_at(&clone, &remote.to_string_lossy(), old_dir, moved_name, bytes).unwrap();
        publish_image_at(&clone, &remote.to_string_lossy(), old_dir, kept_name, bytes).unwrap();

        // 当前笔记本正文：引用 moved（要改前缀），kept 不引用（不该被迁），还有一个别的笔记本的图
        let note_rel = "一篇.md";
        let note_body = format!(
            "看图 ![](https://gitee.com/me/pics/raw/main/{old_dir}/{moved_name}) 完。"
        );
        std::fs::write(notes.join(note_rel), &note_body).unwrap();

        let renames = vec![ImageMigrationRename {
            from: format!("{old_dir}/{moved_name}"),
            to: format!("{new_dir}/{moved_name}"),
            name: moved_name.to_string(),
        }];
        let replacements = vec![ImageUrlReplacement {
            from: format!("{old_dir}/"),
            to: format!("{new_dir}/"),
        }];
        let result = migrate_images_at(
            &clone,
            &remote.to_string_lossy(),
            &notes.to_string_lossy(),
            old_dir,
            new_dir,
            &renames,
            &replacements,
        )
        .unwrap();
        assert_eq!(result.moved, 1, "只搬了正文引用的那张");
        assert_eq!(result.rewritten, 1, "改了一篇正文");
        assert_eq!(result.failed, 0);

        // 图片仓库远端：新层有 moved、旧层没有 moved，但 kept 还在旧层
        let again = root.join("again");
        run_git(
            &["clone", "--branch", &result.branch, &remote.to_string_lossy(), &again.to_string_lossy()],
            None,
            CLONE_TIMEOUT,
        )
        .unwrap();
        assert!(again.join(new_dir).join(moved_name).exists(), "新层该有这张图");
        assert!(!again.join(old_dir).join(moved_name).exists(), "旧层不该再有这张图");
        assert!(again.join(old_dir).join(kept_name).exists(), "没被引用的图留在旧层");

        // 正文：前缀换成新层，其余字不动
        let after = std::fs::read_to_string(notes.join(note_rel)).unwrap();
        assert!(after.contains(&format!("{new_dir}/{moved_name}")), "正文 URL 该指向新层: {after}");
        assert!(after.contains("看图") && after.contains("完。"), "正文其余内容不该动");

        // 目标越界的迁移请求被拒（不能搬到共享层之外）
        let bad = migrate_images_at(
            &clone,
            &remote.to_string_lossy(),
            &notes.to_string_lossy(),
            old_dir,
            new_dir,
            &[ImageMigrationRename {
                from: format!("{old_dir}/{kept_name}"),
                to: "images/别处/x.png".into(),
                name: "x.png".into(),
            }],
            &replacements,
        );
        assert!(bad.is_err(), "搬到共享层之外的请求该被拒");

        let _ = std::fs::remove_dir_all(&root);
    }
}
