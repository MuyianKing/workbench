//! Git 页的只读仓库读取：仓库信息、提交列表、目录树、文件历史、提交差异与补丁。
//!
//! **一个字节都不写仓库**：只跑 `rev-parse` / `log` / `ls-tree` / `show` / `diff` /
//! `cat-file -s`，不 add、不 commit、不 checkout、不 push、不 fetch。也不联网。
//!
//! 范围是**用户在这一页自己打开的那个仓库**（见 docs/modules/git-client.md）。
//! 与 `project_git.rs`（工作日志的「从提交生成」）分开放：那一份按项目目录起算、
//! 只给一个功能用；这一份要按仓库根解释路径、分页、看树与补丁，口径不一样。
//!
//! 路径与提交号都从界面回来，是命令行参数的一部分：
//!  - 提交号只认十六进制（7 ~ 64 位，长短都收），别的字符必然不是提交号；
//!  - 文件路径只认仓库内的相对路径（不接受盘符、开头的 `/`、`..` 与空段）；
//!  - 所有带 pathspec 的命令都先挂 `--literal-pathspecs`：文件名里的 `*` / `?` / `[`
//!    不该被当成通配符；
//!  - `--no-ext-diff` / `--no-textconv`：仓库自己的 `.gitattributes` 或 `diff.external`
//!    可能指向一个外部程序，只读浏览不该顺带执行它。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::sync::{describe, run, run_bytes, GIT_TIMEOUT};

/// 一次最多读多少条提交（界面默认 50，滚动到底再要下一页）。
const PAGE_DEFAULT: u32 = 50;
const PAGE_MAX: u32 = 200;
/// 分页最多翻到第几条：再往后不是「看历史」，是拿它当导出用。
const SKIP_MAX: u32 = 100_000;
/// 一个目录最多回多少项：单目录几十万文件时别把整份 JSON 塞进 IPC。
const TREE_MAX: usize = 5_000;
/// 一次提交 / 一次对比最多列多少文件；超出的给 `filesTruncated`。
const FILES_MAX: usize = 1_000;
/// 单侧文件超过这个大小就不取补丁（完整文本可能不是 UTF-8，也可能几兆）。
const TEXT_MAX: u64 = 1024 * 1024;
/// 补丁最多回这么多字节，超过截断并标 `truncated`。
const PATCH_MAX: usize = 2 * 1024 * 1024;

// ---------- Tauri 命令 ----------
//
// 一律异步：它们都起 git 子进程，阻塞在主线程上会把窗口消息循环一起堵住。
// 读盘 / 起进程都在这里，解析与收敛的纯逻辑留在下面各函数（单测直接调它们）。

#[tauri::command(async)]
pub fn repo_git_open(path: String) -> Result<Value, String> {
    open(&path)
}

#[tauri::command(async)]
pub fn repo_git_commits(root: String, skip: Option<u32>, limit: Option<u32>) -> Result<Value, String> {
    commits(&root, skip, limit)
}

#[tauri::command(async)]
pub fn repo_git_file_commits(
    root: String,
    path: String,
    skip: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    file_commits(&root, &path, skip, limit)
}

#[tauri::command(async)]
pub fn repo_git_tree(root: String, dir: Option<String>) -> Result<Value, String> {
    tree(&root, dir.as_deref())
}

#[tauri::command(async)]
pub fn repo_git_commit(root: String, hash: String) -> Result<Value, String> {
    commit(&root, &hash)
}

#[tauri::command(async)]
pub fn repo_git_compare(root: String, base: String, target: String) -> Result<Value, String> {
    compare(&root, &base, &target)
}

#[tauri::command(async)]
pub fn repo_git_patch(root: String, base: String, target: String, path: String) -> Result<Value, String> {
    patch(&root, &base, &target, &path)
}

// ---------- 实现 ----------

/// 打开一个仓库：返回根目录、当前分支与 HEAD。
///
/// 选中的可以是仓库里的任意子目录；返回的 `root` 才是仓库根，之后的命令都用它。
/// 空仓库（还没有第一次提交）也照常打开，`empty: true`、`head` 为空。
pub fn open(path: &str) -> Result<Value, String> {
    let root = repo_root(path)?;

    let head = run(&["rev-parse", "--verify", "HEAD"], Some(&root), GIT_TIMEOUT)?;
    let empty = !head.ok();
    let (hash, short, branch) = if empty {
        (String::new(), String::new(), String::new())
    } else {
        let hash = run_ok(&["rev-parse", "HEAD"], &root, "rev-parse")?
            .trim()
            .to_string();
        let short = run_ok(&["rev-parse", "--short", "HEAD"], &root, "rev-parse")
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        let branch = run_ok(&["rev-parse", "--abbrev-ref", "HEAD"], &root, "rev-parse")
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        (hash, short, branch)
    };

    let root_text = root.to_string_lossy().to_string();
    let name = root
        .file_name()
        .map(|part| part.to_string_lossy().to_string())
        .filter(|part| !part.is_empty())
        .unwrap_or_else(|| root_text.clone());

    Ok(json!({
        "root": root_text,
        "name": name,
        "head": hash,
        "shortHead": short,
        "branch": branch,
        "detached": !empty && branch == "HEAD",
        "empty": empty,
    }))
}

/// 当前分支的提交列表（`HEAD`，不跟别的分支混在一起）。
pub fn commits(root: &str, skip: Option<u32>, limit: Option<u32>) -> Result<Value, String> {
    let root = repo_root(root)?;
    let skip = skip.unwrap_or(0).min(SKIP_MAX);
    let limit = clamp_limit(limit);
    // 多取一条只用来判断「后面还有没有」；--skip 由 git 先跳，--max-count 限制的是跳完之后的条数
    let max = format!("--max-count={}", limit + 1);
    let skip_arg = format!("--skip={skip}");
    let args = [
        "--literal-pathspecs",
        "log",
        "HEAD",
        "--date-order",
        "--no-color",
        "--no-show-signature",
        max.as_str(),
        skip_arg.as_str(),
        "--format=%H%x1f%at%x1f%an%x1f%ae%x1f%P%x1f%D%x1f%s",
    ];
    let outcome = run(&args, Some(&root), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err("读取提交记录超时".into());
    }
    if !outcome.ok() {
        if is_empty_repo(&outcome.stdout, &outcome.stderr) {
            return Ok(json!({ "commits": [], "hasMore": false }));
        }
        return Err(describe("log", &outcome));
    }

    let mut commits = parse_commits(&outcome.stdout);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(json!({ "commits": commits, "hasMore": has_more }))
}

/// 一个文件的提交历史（只按这个路径，不做 rename 跟踪 —— 改名前的历史不显示）。
pub fn file_commits(
    root: &str,
    path: &str,
    skip: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let root = repo_root(root)?;
    let path = check_rel_path(path, false)?;
    let skip = skip.unwrap_or(0).min(SKIP_MAX);
    let limit = clamp_limit(limit);
    let max = format!("--max-count={}", limit + 1);
    let skip_arg = format!("--skip={skip}");
    let args = [
        "--literal-pathspecs",
        "log",
        "HEAD",
        "--date-order",
        "--no-color",
        "--no-show-signature",
        max.as_str(),
        skip_arg.as_str(),
        "--format=%H%x1f%at%x1f%an%x1f%ae%x1f%P%x1f%D%x1f%s",
        "--",
        path.as_str(),
    ];
    let outcome = run(&args, Some(&root), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err("读取文件历史超时".into());
    }
    if !outcome.ok() {
        if is_empty_repo(&outcome.stdout, &outcome.stderr) {
            return Ok(json!({ "commits": [], "hasMore": false }));
        }
        return Err(describe("log", &outcome));
    }

    let mut commits = parse_commits(&outcome.stdout);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(json!({ "commits": commits, "hasMore": has_more }))
}

/// 一个目录的内容（`HEAD` 那一版）。根目录传空串。
pub fn tree(root: &str, dir: Option<&str>) -> Result<Value, String> {
    let root = repo_root(root)?;
    let dir = check_rel_path(dir.unwrap_or_default(), true)?;
    // 空仓库没有 HEAD：照常回空清单，别把「还没有第一次提交」显示成读取失败
    let head = run(&["rev-parse", "--verify", "HEAD"], Some(&root), GIT_TIMEOUT)?;
    if !head.ok() {
        return Ok(json!({ "entries": [], "truncated": false }));
    }
    let spec = if dir.is_empty() {
        "HEAD".to_string()
    } else {
        format!("HEAD:{dir}")
    };
    let text = run_ok(&["ls-tree", "-z", "-l", spec.as_str()], &root, "ls-tree")?;

    let mut entries: Vec<(bool, String, Value)> = Vec::new();
    for record in text.split('\0') {
        if record.is_empty() {
            continue;
        }
        let Some((meta, name)) = record.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = meta.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let mode = parts[0];
        let kind = parts[1];
        let size = if parts[3] == "-" {
            0
        } else {
            parts[3].parse::<u64>().unwrap_or(0)
        };
        let name = name.to_string();
        let path = if dir.is_empty() {
            name.clone()
        } else {
            format!("{dir}/{name}")
        };
        let (entry_type, is_dir) = match kind {
            "tree" => ("dir", true),
            "commit" => ("submodule", false),
            _ if mode == "120000" => ("symlink", false),
            _ => ("file", false),
        };
        entries.push((
            is_dir,
            name.to_lowercase(),
            json!({
                "name": name,
                "path": path,
                "type": entry_type,
                "size": size,
            }),
        ));
    }

    // 目录在前、同层按名字（不区分大小写）；git 自己的树顺序对界面不直观。
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let truncated = entries.len() > TREE_MAX;
    entries.truncate(TREE_MAX);
    Ok(json!({
        "entries": entries.into_iter().map(|(_, _, value)| value).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

/// 一个提交的元信息 + 改动文件清单。
///
/// `base` 是第一个父提交；根提交的 `base` 是空串、`isRoot: true`。
/// 合并提交只对比第一父提交（`isMerge: true`）—— 三方合成的差异读不出「改了什么」。
pub fn commit(root: &str, hash: &str) -> Result<Value, String> {
    let root = repo_root(root)?;
    let hash = check_hash(hash)?;
    let text = run_ok(
        &[
            "show",
            "-s",
            "--no-color",
            "--no-show-signature",
            "--format=%H%x1f%at%x1f%an%x1f%ae%x1f%P%x1f%B",
            hash.as_str(),
        ],
        &root,
        "show",
    )?;

    let mut parts = text.splitn(6, '\u{1f}');
    let (Some(actual), Some(seconds), Some(author), Some(email), Some(parents), Some(body)) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err("解析提交信息失败".into());
    };
    let seconds = seconds
        .trim()
        .parse::<u64>()
        .map_err(|_| "解析提交时间失败".to_string())?;
    let parents: Vec<String> = parents
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let is_root = parents.is_empty();
    let base = parents.first().cloned().unwrap_or_default();
    let (files, files_truncated) = diff_files(&root, &base, &hash, is_root)?;

    let body = body.trim().to_string();
    let subject = body.lines().next().unwrap_or_default().trim().to_string();

    Ok(json!({
        "hash": actual.trim(),
        "time": seconds.saturating_mul(1000),
        "author": author.trim(),
        "authorEmail": email.trim(),
        "parents": parents,
        "body": body,
        "subject": subject,
        "isMerge": parents.len() > 1,
        "isRoot": is_root,
        "base": base,
        "files": files,
        "filesTruncated": files_truncated,
    }))
}

/// 任意两个提交之间的改动文件清单（不含补丁本身，补丁按文件再取）。
pub fn compare(root: &str, base: &str, target: &str) -> Result<Value, String> {
    let root = repo_root(root)?;
    let base = check_hash(base)?;
    let target = check_hash(target)?;
    let (files, files_truncated) = diff_files(&root, &base, &target, false)?;
    Ok(json!({
        "base": base,
        "target": target,
        "files": files,
        "filesTruncated": files_truncated,
    }))
}

/// 一个文件的补丁（`base` 为空串时按根提交处理，用 `git show`）。
pub fn patch(root: &str, base: &str, target: &str, path: &str) -> Result<Value, String> {
    let root = repo_root(root)?;
    let target = check_hash(target)?;
    let base = {
        let value = base.trim();
        if value.is_empty() {
            String::new()
        } else {
            check_hash(value)?
        }
    };
    let path = check_rel_path(path, false)?;

    // 单侧超过上限就不取：完整补丁可能几兆，界面也读不动。
    for rev in [base.as_str(), target.as_str()] {
        if rev.is_empty() {
            continue;
        }
        let spec = format!("{rev}:{path}");
        if let Ok(outcome) = run(&["cat-file", "-s", spec.as_str()], Some(&root), GIT_TIMEOUT) {
            if outcome.ok() {
                if let Ok(size) = outcome.stdout.trim().parse::<u64>() {
                    if size > TEXT_MAX {
                        return Ok(json!({
                            "patch": "",
                            "binary": false,
                            "tooLarge": true,
                            "lossy": false,
                            "truncated": false,
                        }));
                    }
                }
            }
        }
    }

    let args: Vec<&str> = if base.is_empty() {
        vec![
            "--literal-pathspecs",
            "show",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-U3",
            "--format=",
            &target,
            "--",
            &path,
        ]
    } else {
        vec![
            "--literal-pathspecs",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-U3",
            &base,
            &target,
            "--",
            &path,
        ]
    };
    let outcome = run_bytes(&args, Some(&root), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err("读取文件差异超时".into());
    }
    if !outcome.ok() {
        let stderr = String::from_utf8_lossy(&outcome.stderr).into_owned();
        let detail = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&outcome.stdout).into_owned()
        } else {
            stderr
        };
        return Err(format!("git diff 失败: {}", last_lines(&detail, 4)));
    }

    let lossy = std::str::from_utf8(&outcome.stdout).is_err();
    let text = String::from_utf8_lossy(&outcome.stdout).into_owned();
    // 只看**行首**：普通文本里也可能出现 "Binary files ..." 这几个字（它在补丁里会带 +/空格前缀），
    // 按整段 contains 判会把一行源码误认成二进制。
    let binary = text
        .lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"));
    let (patch, truncated) = truncate_text(text, PATCH_MAX);

    Ok(json!({
        "patch": patch,
        "binary": binary,
        "tooLarge": false,
        "lossy": lossy,
        "truncated": truncated,
    }))
}

// ---------- 解析 ----------

fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(PAGE_DEFAULT).clamp(1, PAGE_MAX) as usize
}

fn parse_commits(text: &str) -> Vec<Value> {
    let mut commits = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        // 提交说明里理论上什么字符都可能有，所以用单元分隔符切；splitn 让最后一段
        // （标题）即便混进分隔符也原样留下。
        let mut parts = line.trim_end().splitn(7, '\u{1f}');
        let (
            Some(hash),
            Some(seconds),
            Some(author),
            Some(email),
            Some(parents),
            Some(refs),
            Some(subject),
        ) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        let Ok(seconds) = seconds.trim().parse::<u64>() else {
            continue;
        };
        let hash = hash.trim();
        // 提交说明可以是空的（`git commit --allow-empty-message`）：照常列出来，
        // 界面显示「（无提交说明）」；这里只丢掉没有哈希的坏行。
        let subject = subject.trim();
        if hash.is_empty() {
            continue;
        }
        let parents: Vec<&str> = parents.split_whitespace().collect();
        commits.push(json!({
            "hash": hash,
            "time": seconds.saturating_mul(1000),
            "author": author.trim(),
            "authorEmail": email.trim(),
            "parents": parents,
            "refs": refs.trim(),
            "subject": subject,
        }));
    }
    commits
}

/// `git diff --numstat -z` → 路径 →（增行、删行、是否二进制）
fn parse_numstat(text: &str) -> HashMap<String, (u64, u64, bool)> {
    let mut map = HashMap::new();
    for record in text.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let binary = added == "-" || deleted == "-";
        let added = added.parse::<u64>().unwrap_or(0);
        let deleted = deleted.parse::<u64>().unwrap_or(0);
        map.insert(path.to_string(), (added, deleted, binary));
    }
    map
}

/// 两个提交之间（或根提交对空树）的改动文件。
///
/// `--no-renames` 是有意的：重命名会被拆成「删旧 + 加新」，补丁与文件历史就始终按
/// 同一个路径读，不会出现「列表里是旧名、点进去查不到」的错位。重命名跟踪留给以后。
fn diff_files(
    root: &Path,
    base: &str,
    target: &str,
    is_root: bool,
) -> Result<(Vec<Value>, bool), String> {
    let (numstat, status) = if is_root {
        (
            run_ok(
                &[
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "-r",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--numstat",
                    "-z",
                    target,
                ],
                root,
                "diff-tree",
            )?,
            run_ok(
                &[
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "-r",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--name-status",
                    "-z",
                    target,
                ],
                root,
                "diff-tree",
            )?,
        )
    } else {
        (
            run_ok(
                &[
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--numstat",
                    "-z",
                    base,
                    target,
                ],
                root,
                "diff",
            )?,
            run_ok(
                &[
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--name-status",
                    "-z",
                    base,
                    target,
                ],
                root,
                "diff",
            )?,
        )
    };

    let counts = parse_numstat(&numstat);
    let mut files = Vec::new();
    let mut fields = status.split('\0').filter(|item| !item.is_empty());
    while let Some(status) = fields.next() {
        let Some(path) = fields.next() else {
            break;
        };
        let status = status.trim();
        if status.is_empty() || path.is_empty() {
            continue;
        }
        let (added, deleted, binary) = counts.get(path).copied().unwrap_or((0, 0, false));
        files.push(json!({
            "path": path,
            "status": status.chars().next().unwrap_or('M').to_string(),
            "added": added,
            "deleted": deleted,
            "binary": binary,
        }));
    }

    let truncated = files.len() > FILES_MAX;
    files.truncate(FILES_MAX);
    Ok((files, truncated))
}

// ---------- 路径与命令 ----------

fn repo_root(root: &str) -> Result<PathBuf, String> {
    let dir = check_dir(root)?;
    let outcome = run(&["rev-parse", "--show-toplevel"], Some(&dir), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err("读取仓库路径超时".into());
    }
    if !outcome.ok() {
        let detail = format!("{}\n{}", outcome.stdout, outcome.stderr);
        if detail.contains("must be run in a work tree") {
            return Err("这个文件夹不是 Git 工作区（裸仓库或 .git 目录），请选择仓库根目录".into());
        }
        return Err("这个文件夹不在 Git 仓库里".into());
    }
    let top = outcome.stdout.trim();
    if top.is_empty() {
        return Err("这个文件夹不在 Git 仓库里".into());
    }
    let path = PathBuf::from(top);
    if !path.is_dir() {
        return Err(format!("找不到仓库文件夹：{top}"));
    }
    Ok(path)
}

fn check_dir(root: &str) -> Result<PathBuf, String> {
    let value = root.trim();
    if value.is_empty() {
        return Err("还没有选择仓库文件夹".into());
    }
    let path = PathBuf::from(value);
    if !path.is_dir() {
        return Err(format!("找不到仓库文件夹：{value}"));
    }
    Ok(path)
}

/// 仓库内的相对路径：统一成 `/`，拒绝盘符、开头的 `/`、`.` / `..` 与空段。
/// `allow_empty` 只给目录树用（空串 = 根目录）。
fn check_rel_path(path: &str, allow_empty: bool) -> Result<String, String> {
    let value = path.replace('\\', "/");
    if value.is_empty() {
        return if allow_empty {
            Ok(value)
        } else {
            Err("缺少文件路径".into())
        };
    }
    if value.starts_with('/') || value.contains('\0') {
        return Err(format!("不是有效的仓库内路径：{path}"));
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(format!("不是有效的仓库内路径：{path}"));
    }
    for part in value.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("不是有效的仓库内路径：{path}"));
        }
    }
    Ok(value)
}

fn check_hash(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if !(7..=64).contains(&value.len()) || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("不是有效的提交号：{value}"));
    }
    Ok(value)
}

fn is_empty_repo(stdout: &str, stderr: &str) -> bool {
    let detail = format!("{stdout}\n{stderr}");
    detail.contains("does not have any commits") || detail.contains("unknown revision")
}

fn run_ok(args: &[&str], cwd: &Path, label: &str) -> Result<String, String> {
    let outcome = run(args, Some(cwd), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err(format!("git {label} 超时"));
    }
    if !outcome.ok() {
        return Err(describe(label, &outcome));
    }
    Ok(outcome.stdout)
}

fn last_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("；")
}

fn truncate_text(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> PathBuf {
        if crate::proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return PathBuf::from(name);
        }

        let dir = std::env::temp_dir().join(format!("wb-repo-git-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::sync::run_git(&["init", "--quiet"], Some(&dir), GIT_TIMEOUT).unwrap();
        let _ = crate::sync::run_git(&["config", "user.email", "wb@test"], Some(&dir), GIT_TIMEOUT);
        let _ = crate::sync::run_git(&["config", "user.name", "wb"], Some(&dir), GIT_TIMEOUT);
        dir
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let file = root.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }

    fn commit_all(root: &Path, message: &str) -> String {
        crate::sync::run_git(&["add", "-A"], Some(root), GIT_TIMEOUT).unwrap();
        crate::sync::run_git(&["commit", "--quiet", "-m", message], Some(root), GIT_TIMEOUT)
            .unwrap();
        crate::sync::run_git(&["rev-parse", "HEAD"], Some(root), GIT_TIMEOUT)
            .unwrap()
            .trim()
            .to_string()
    }

    fn cleanup(dir: &Path) {
        if dir.starts_with(std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn open_empty_repo_and_history_pages() {
        let repo = temp_repo("open");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        // 空仓库也能打开，只是没有 HEAD
        let info = open(&root).unwrap();
        assert_eq!(info["empty"], json!(true));
        assert_eq!(info["head"], json!(""));
        assert_eq!(commits(&root, None, None).unwrap()["commits"], json!([]));
        // 空仓库没有 HEAD：目录树回空清单，不是读取失败
        assert_eq!(tree(&root, None).unwrap()["entries"], json!([]));

        write(&repo, "a.txt", "one\n");
        let first = commit_all(&repo, "first");
        write(&repo, "a.txt", "two\n");
        write(&repo, "src/b.txt", "b\n");
        let second = commit_all(&repo, "second");

        let info = open(&root).unwrap();
        assert_eq!(info["empty"], json!(false));
        assert_eq!(info["head"], json!(second));

        let page = commits(&root, Some(0), Some(1)).unwrap();
        assert_eq!(page["commits"].as_array().unwrap().len(), 1);
        assert_eq!(page["hasMore"], json!(true));
        assert_eq!(page["commits"][0]["hash"], json!(second));
        assert_eq!(page["commits"][0]["subject"], json!("second"));

        let page = commits(&root, Some(1), Some(10)).unwrap();
        assert_eq!(page["commits"][0]["hash"], json!(first));
        assert_eq!(page["hasMore"], json!(false));

        cleanup(&repo);
    }

    #[test]
    fn tree_lists_directories_first_and_chinese_names() {
        let repo = temp_repo("tree");
        if !repo.exists() {
            return;
        }
        write(&repo, "src/main.rs", "fn main() {}\n");
        write(&repo, "说明.md", "第一版\n");
        commit_all(&repo, "init");
        let root = repo.to_string_lossy().into_owned();

        let page = tree(&root, Some("")).unwrap();
        let entries = page["entries"].as_array().unwrap();
        assert_eq!(entries[0]["type"], json!("dir"));
        assert_eq!(entries[0]["name"], json!("src"));
        assert!(entries.iter().any(|entry| entry["name"] == json!("说明.md")));

        let page = tree(&root, Some("src")).unwrap();
        assert_eq!(page["entries"][0]["path"], json!("src/main.rs"));
        assert_eq!(page["entries"][0]["type"], json!("file"));

        assert!(tree(&root, Some("../")).is_err());
        assert!(tree(&root, Some("C:/Windows")).is_err());

        cleanup(&repo);
    }

    #[test]
    fn file_history_filters_by_path_and_pages() {
        let repo = temp_repo("file-log");
        if !repo.exists() {
            return;
        }
        write(&repo, "a.txt", "one\n");
        let first = commit_all(&repo, "first");
        write(&repo, "b.txt", "b\n");
        commit_all(&repo, "second");
        write(&repo, "a.txt", "two\n");
        let third = commit_all(&repo, "third");
        let root = repo.to_string_lossy().into_owned();

        let page = file_commits(&root, "a.txt", None, None).unwrap();
        let commits = page["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0]["hash"], json!(third));
        assert_eq!(commits[1]["hash"], json!(first));
        assert_eq!(page["hasMore"], json!(false));

        let page = file_commits(&root, "a.txt", Some(1), Some(1)).unwrap();
        assert_eq!(page["commits"].as_array().unwrap().len(), 1);
        assert_eq!(page["commits"][0]["hash"], json!(first));

        // 文件名里的 [ ] 是字面字符，不是 pathspec 通配符（--literal-pathspecs）
        write(&repo, "odd[1].txt", "x\n");
        let odd = commit_all(&repo, "odd name");
        let page = file_commits(&root, "odd[1].txt", None, None).unwrap();
        assert_eq!(page["commits"][0]["hash"], json!(odd));
        let p = patch(&root, "", &odd, "odd[1].txt").unwrap();
        assert!(p["patch"].as_str().unwrap().contains("+x"));

        assert!(file_commits(&root, "../a.txt", None, None).is_err());
        assert!(file_commits(&root, "C:/a.txt", None, None).is_err());

        cleanup(&repo);
    }

    #[test]
    fn commit_diff_and_patch_cover_root_and_modified_files() {
        let repo = temp_repo("commit");
        if !repo.exists() {
            return;
        }
        write(&repo, "a.txt", "one\n");
        let first = commit_all(&repo, "first");
        write(&repo, "a.txt", "two\n");
        write(&repo, "b.txt", "new\n");
        std::fs::remove_file(repo.join("b.txt")).unwrap();
        write(&repo, "b.txt", "new\n");
        let second = commit_all(&repo, "second");
        let root = repo.to_string_lossy().into_owned();

        let detail = commit(&root, &first).unwrap();
        assert_eq!(detail["isRoot"], json!(true));
        assert_eq!(detail["base"], json!(""));
        let files = detail["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["status"], json!("A"));

        let root_patch = patch(&root, "", &first, "a.txt").unwrap();
        assert!(root_patch["patch"].as_str().unwrap().contains("+one"));

        let detail = commit(&root, &second).unwrap();
        assert_eq!(detail["base"], json!(first));
        let files = detail["files"].as_array().unwrap();
        assert!(files.iter().any(|file| file["path"] == json!("a.txt")
            && file["status"] == json!("M")
            && file["added"] == json!(1)
            && file["deleted"] == json!(1)));
        assert!(files.iter().any(|file| file["path"] == json!("b.txt")
            && file["status"] == json!("A")));

        let p = patch(&root, &first, &second, "a.txt").unwrap();
        let text = p["patch"].as_str().unwrap();
        assert!(text.contains("-one"));
        assert!(text.contains("+two"));

        // 路径 / 提交号只认合法形状
        assert!(commit(&root, "--all").is_err());
        assert!(patch(&root, &first, &second, "../a.txt").is_err());

        cleanup(&repo);
    }

    #[test]
    fn compare_reports_changes_between_two_commits() {
        let repo = temp_repo("compare");
        if !repo.exists() {
            return;
        }
        write(&repo, "a.txt", "one\n");
        let first = commit_all(&repo, "first");
        write(&repo, "a.txt", "two\n");
        write(&repo, "b.txt", "b\n");
        let second = commit_all(&repo, "second");
        let root = repo.to_string_lossy().into_owned();

        let result = compare(&root, &first, &second).unwrap();
        let files = result["files"].as_array().unwrap();
        assert!(files.iter().any(|file| file["path"] == json!("a.txt")
            && file["status"] == json!("M")));
        assert!(files.iter().any(|file| file["path"] == json!("b.txt")
            && file["status"] == json!("A")));
        assert_eq!(result["filesTruncated"], json!(false));

        cleanup(&repo);
    }

    #[test]
    fn binary_patch_is_flagged_instead_of_decoded() {
        let repo = temp_repo("binary");
        if !repo.exists() {
            return;
        }
        write(&repo, "a.txt", "one\n");
        let first = commit_all(&repo, "first");
        std::fs::write(repo.join("bin.dat"), [0u8, 1, 2, 255]).unwrap();
        let second = commit_all(&repo, "binary");
        let root = repo.to_string_lossy().into_owned();

        let detail = commit(&root, &second).unwrap();
        let file = detail["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["path"] == json!("bin.dat"))
            .unwrap();
        assert_eq!(file["binary"], json!(true));

        let result = patch(&root, &first, &second, "bin.dat").unwrap();
        assert_eq!(result["binary"], json!(true));

        cleanup(&repo);
    }
}
