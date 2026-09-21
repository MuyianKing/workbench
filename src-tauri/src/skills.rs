//! 技能（skill）管理：技能库是**它自己的一个目录**（用户选的），版本就是 git 提交历史。
//!
//! 技能库与笔记文件夹**互不相干**：各自一个目录，可以正好是同一处、也可能各有各的仓库 ——
//! 这里只认渲染层带下来的「仓库根 + 库在里面的相对路径」（见 `state`），
//! 从不假设它与某个笔记本有关系。每个技能就是技能库下 `<技能名>/` 里的一个目录。
//! 增删改都在那个仓库里提交一次，git 的历史因此就是技能的版本历史；
//! 推上去走 `sync`（技能页那颗同步按钮），它**只提交技能库那一层**再拉推那个仓库。
//!
//! 与 sync.rs 的分工一致：这里只做「跑 git / 复制文件」，技能叫什么名字、frontmatter 里
//! 写了什么、安装到哪个项目，都由渲染层决定（见 shared/skills.ts）。因此对入参只有两道把关：
//! 名字必须是一个「正常的路径段」（拼出来的路径不许越过笔记根），笔记根必须真实存在。
//!
//! 技能库不在任何 git 仓库里时，技能照常增删改 —— 本地文件操作照做，
//! 提交与历史这类「版本」动作如实返回「没有产生版本」，不把它当错误拦住别人。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

use crate::sync::{
    busy_message, current_branch, describe, ensure_commit_identity, head_of, host_name,
    is_plain_segment, pull_with_rebase, push_with_retry, run_git, run_git_quiet, set_git_auth,
};

/// 技能清单文件：没有它的目录不算技能，装不进项目（渲染层负责提示，这里挡最后一道）
pub(crate) const SKILL_MD: &str = "SKILL.md";

/// 技能的 git 调用全是本地操作，不会像 push / pull 那样等网络 —— 宽松给 30 秒够了
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// 版本历史一次默认回几条；上限卡住手工传大数的情况
const HISTORY_LIMIT_DEFAULT: usize = 50;
const HISTORY_LIMIT_MAX: usize = 200;

/// 这个根必须存在：各条技能通道拿的是**仓库根**（或者没仓库时就是技能库目录自己），
/// 它不在的话后面每一步（拼路径、跑 git）都没意义。
fn workspace_of(root: &str) -> Result<PathBuf, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("还没有选择技能库目录".into());
    }
    let base = PathBuf::from(root);
    if !base.is_dir() {
        return Err(format!("找不到技能库所在的目录：{root}"));
    }
    Ok(base)
}

/// 收敛技能库的相对目录（渲染层已经收敛过，这里再挡一道）：逐段必须是普通名字。
/// **空串是合法的**：技能库自己就是仓库根（一个专门的技能仓库），返回 `""`。
/// 返回仓库内的相对路径写法（`/` 分隔），既能 join 也能直接当 git 的 pathspec。
fn rel_of(dir: &str) -> Result<String, String> {
    let raw = dir.trim().replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if !is_plain_segment(part) {
            return Err(format!("技能目录不合法：{dir}"));
        }
        parts.push(part);
    }
    // 空串是合法的：技能库自己就是仓库根（选一个专门的技能仓库当库时就是这样）
    Ok(parts.join("/"))
}

/// 技能名 = 它的目录名，只能是一段：带分隔符或 `..` 的名字能把复制写到笔记根之外去
fn require_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if !is_plain_segment(id) {
        return Err(format!("技能名不合法：{id}"));
    }
    Ok(id.to_string())
}

/// 技能目录在磁盘上的位置；还不存在不算错（第一次用就是从没有开始），
/// 由各调用方按自己的语义处理
fn skill_dir(root: &str, dir: &str, id: &str) -> Result<PathBuf, String> {
    let workspace = workspace_of(root)?;
    let rel = rel_of(dir)?;
    let id = require_id(id)?;
    Ok(workspace.join(rel).join(id))
}

/// 这台笔记根上真的有 git 仓库吗（有 `.git` 且至少有一次提交）。
/// 没有仓库时「版本」这件事不存在：提交、历史、恢复都按「什么都没有」处理。
fn has_history(workspace: &Path) -> bool {
    workspace.join(".git").exists() && !head_of(workspace).is_empty()
}

// ---------- 列表 ----------

/// 技能库里的技能：id / 递归文件数 / SKILL.md 原文（名字与描述由渲染层解析，那边有单测）。
///
/// 技能库目录还不存在时返回空表 —— 这是「还没建过技能」，不是错误；
/// 单个 SKILL.md 读不出来（编码坏了）就当没有清单，整批不因此失败。
pub fn list(root: &str, dir: &str) -> Result<Vec<Value>, String> {
    let workspace = workspace_of(root)?;
    let rel = rel_of(dir)?;
    let base = workspace.join(&rel);
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Ok(Vec::new());
    };

    let mut out: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        // 点开头的目录（.git、.obsidian…）不是技能，与笔记扫描同一条规矩
        if id.starts_with('.') {
            continue;
        }

        let file_count = WalkDir::new(&path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            })
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .count();

        let skill_md = std::fs::read_to_string(path.join(SKILL_MD)).ok();
        out.push(json!({ "id": id, "fileCount": file_count, "skillMd": skill_md }));
    }

    out.sort_by(|left, right| {
        left["id"]
            .as_str()
            .unwrap_or("")
            .cmp(right["id"].as_str().unwrap_or(""))
    });
    Ok(out)
}

// ---------- 技能库与它的仓库 ----------

/// 技能库的仓库：**从选中的技能库目录开始看有没有 `.git`，没有就往上找最近的**。
///
/// 回 `{ repo, libraryRel, hasGit, origin }`：
///   - `repo` 是那个仓库根（一路上去都没有就是技能库目录自己）；
///   - `libraryRel` 是技能库相对仓库根的路径（技能库就是仓库根时是空串）；
///   - `hasGit` 有没有仓库（决定「改完记不记版本」，与有没有远端是两件事）；
///   - `origin` 是那个仓库的远端地址（没有就是空串）。
///
/// 各条技能通道拿的就是这两个值：文件操作落在 `<repo>/<libraryRel>` 下，git 在 `repo` 里跑。
/// 技能库与笔记文件夹**互不相干**（可能是同一个目录、也可能各有各的仓库）：这里只看选中的那个目录。
pub fn state(dir: &str) -> Result<Value, String> {
    let library = workspace_of(dir)?;
    let repo = repo_root_of(&library);
    let origin = if repo.join(".git").exists() {
        run_git(&["remote", "get-url", "origin"], Some(&repo), GIT_TIMEOUT)
            .map(|text| text.trim().to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };

    Ok(json!({
        "repo": repo.to_string_lossy(),
        "libraryRel": rel_under(&repo, &library),
        // 有没有 git 决定「改完记不记版本」；有 git 但 origin 为空只决定「推不推得出去」
        "hasGit": repo.join(".git").exists(),
        "origin": origin,
    }))
}

/// 从这一层开始、往上找到最近的那个有 `.git` 的目录；一路上去都没有就是它自己
/// （`.git` 是目录或文件都算 —— worktree / 子模块；与 `sync.rs` 的 `repo_state` 同一口径，
/// 区别只是它会往上找：技能库往往就住在某个仓库的里面一层）。
fn repo_root_of(library: &Path) -> PathBuf {
    let mut current = Some(library.to_path_buf());
    let mut steps = 0;
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return dir;
        }
        // 8 层足够深了（`E:\c\d\e` 这种），再往上不是项目而是盘根一类的公共目录
        if steps >= 8 {
            break;
        }
        steps += 1;
        current = dir.parent().filter(|parent| *parent != dir).map(Path::to_path_buf);
    }
    library.to_path_buf()
}

/// `path` 相对 `base` 的路径写法（`/` 分隔）；`base` 不是 `path` 的祖先时是空串
fn rel_under(base: &Path, path: &Path) -> String {
    let Ok(rest) = path.strip_prefix(base) else {
        return String::new();
    };
    let parts: Vec<String> = rest
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            // 基准就是 path 自己（strip_prefix 给出空路径）时没有这一段；其余（`.`、`..`）不算普通名字
            _ => None,
        })
        .collect();
    parts.join("/")
}

/// 库里的某个技能在仓库里的相对路径：`<库>/<id>`；技能库就是仓库根时就是 `<id>`
fn skill_path(rel: &str, id: &str) -> String {
    if rel.is_empty() {
        id.to_string()
    } else {
        format!("{rel}/{id}")
    }
}

/// 库自己在仓库里的 pathspec：技能库就是仓库根时用 `.`（git 里它表示整棵树）
fn library_spec(rel: &str) -> &str {
    if rel.is_empty() {
        "."
    } else {
        rel
    }
}

// ---------- 同步（把技能库所在的仓库对齐一次） ----------

/// 同步技能库所在的仓库：**先提交技能库那一层**，再 `pull --rebase`、`push`。
///
/// 与 `sync_notes` 的区别只在提交范围：那边提交的是「整个笔记本」（笔记的语义就是那个文件夹），
/// 这边**只 `add` 技能库** —— 技能库可能住在别人的仓库里（往上找到的那个），一次同步把那个仓库的
/// 其他改动一起提交走是不能接受的。拉与推仍然是整条分支（git 没有「半个分支」这回事），
/// 那是这个仓库自己的节奏，与用户在它里面正常用 git 是同一件事。
///
/// 不是仓库、没连远端都只如实报一句带解决办法的话：技能在本地照样能增删改（文件操作不走这里）。
/// 分支按仓库当前站着的那个走；撞上冲突不替用户挑边（中止这次 rebase、把冲突的文件名报回去）。
pub fn sync(root: &str, dir: &str) -> Result<Value, String> {
    let workspace = workspace_of(root)?;
    // 入参先验一遍（拼路径与 git 参数前的那道闸）：错误要在动网络之前出来
    rel_of(dir)?;
    if !workspace.join(".git").exists() {
        return Err(
            "技能库不在 git 仓库里：改动的版本不会被记录，也没法同步（把它放进一个仓库里就有版本了）"
                .into(),
        );
    }
    if !run_git_quiet(&["remote", "get-url", "origin"], &workspace) {
        return Err(
            "技能库所在的仓库还没连远端：在它里面跑 `git remote add origin <地址>` 就能同步".into(),
        );
    }
    if let Some(message) = busy_message(&workspace, "技能库所在的仓库") {
        return Err(message);
    }

    // 必须在任何 git 调用之前设好：下面的 pull / push 都要走网络
    set_git_auth();

    let mut log: Vec<String> = Vec::new();
    let committed = commit(root, dir, &format!("skills: {}", host_name()))?;
    let branch = current_branch(&workspace)?;
    let before = head_of(&workspace);
    pull_with_rebase(&workspace, &branch, &mut log)?;
    let received = before != head_of(&workspace);
    // 一份提交都没有（远端也空）：没有可推的，如实回一个「什么都没做」的结果
    if !head_of(&workspace).is_empty() {
        push_with_retry(&workspace, &branch, &mut log)?;
    }

    Ok(json!({
        "branch": branch,
        "files": committed["files"],
        "received": received,
        "log": log.join("
"),
    }))
}

// ---------- 版本（提交 / 历史 / 恢复） ----------

/// 把技能库下的当前改动提交一次（只 add 这一个子目录，用户没提交的笔记不捎带）。
///
/// 不是 git 仓库（`.git` 不存在）、目录不存在、内容没变都不报错 —— 返回 `changed: false`，
/// 「没产生版本」与「提交失败」是两回事，只有后者才该打断用户。
/// 注意拦的是「不是仓库」而不是「还没有提交」：第一笔技能提交恰恰发生在空仓库上，
/// 拦错了它就永远记不上第一版。提交信息由渲染层拼好（`skill: <id> 动作`），这里只兜一个空串的底。
///
/// 提交身份得在这里兜一道：技能这条路**不经过同步**（有仓库没远端、用户干脆不同步都照样提交），
/// 所以不能指望同步顺手把 `user.email` 写进去 —— 没配过全局 git 身份的用户会看到
/// git 那句 "Please tell me who you are"，而那是他自己没法从界面里修的。
pub fn commit(root: &str, dir: &str, message: &str) -> Result<Value, String> {
    let workspace = workspace_of(root)?;
    let rel = rel_of(dir)?;
    if !workspace.join(&rel).exists() || !workspace.join(".git").exists() {
        return Ok(json!({ "changed": false, "files": 0 }));
    }

    ensure_commit_identity(&workspace)?;
    let spec = library_spec(&rel);
    run_git(&["add", "-A", "--", spec], Some(&workspace), GIT_TIMEOUT)?;
    // 退出码 1 = 有暂存改动；没改动就不产生空提交（自动保存类调用会反复走到这里）
    if run_git_quiet(&["diff", "--cached", "--quiet", "--", spec], &workspace) {
        return Ok(json!({ "changed": false, "files": 0 }));
    }

    let names = run_git(&["diff", "--cached", "--name-only", "--", spec], Some(&workspace), GIT_TIMEOUT)?;
    let files = names.lines().filter(|line| !line.trim().is_empty()).count();
    let message = message.trim();
    let message = message.is_empty().then_some("skill: 更新").unwrap_or(message);
    run_git(&["commit", "-m", message], Some(&workspace), GIT_TIMEOUT)?;
    Ok(json!({ "changed": true, "files": files }))
}

/// 某个技能的提交历史（新的在前）。不是仓库、目录从未提交过都是空表 ——
/// 「还没有版本」在界面上是一句引导，不是一次失败。
pub fn history(root: &str, dir: &str, id: &str, limit: Option<usize>) -> Result<Vec<Value>, String> {
    let workspace = workspace_of(root)?;
    let rel = rel_of(dir)?;
    let id = require_id(id)?;
    if !has_history(&workspace) {
        return Ok(Vec::new());
    }

    let limit = limit.unwrap_or(HISTORY_LIMIT_DEFAULT).clamp(1, HISTORY_LIMIT_MAX);
    let limit = limit.to_string();
    let path = skill_path(&rel, &id);
    let text = run_git(
        // %x1f 是单元分隔符：提交说明里什么字符都可能出现，用它切开不会撞
        &["log", "-n", &limit, "--format=%H%x1f%at%x1f%s", "--", &path],
        Some(&workspace),
        GIT_TIMEOUT,
    )
    .unwrap_or_default();

    let mut out: Vec<Value> = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.trim().split('\u{1f}').collect();
        if parts.len() < 3 {
            continue;
        }
        out.push(json!({
            "hash": parts[0],
            // %at 是秒；渲染层统一用毫秒
            "time": parts[1].parse::<u64>().unwrap_or(0) * 1000,
            "subject": parts[2],
        }));
    }
    Ok(out)
}

/// 把某个技能恢复到指定版本。
///
/// `git checkout <hash> -- <目录>` **只会把旧版本里的文件盖回来**，那一版之后新增的文件
/// 会残留在工作区 —— 那就不是「恢复到那一版」了。所以先把该目录下**已跟踪**的内容整棵
/// 摘掉（`git rm` 连工作区一起删），再把旧版本检出；目录从未提交过时 `rm` 会失败，
/// 忽略它让 checkout 自己去报真正的原因。恢复本身也是一次提交，历史里留得住痕。
pub fn restore(root: &str, dir: &str, id: &str, hash: &str) -> Result<Value, String> {
    let workspace = workspace_of(root)?;
    let rel = rel_of(dir)?;
    let id = require_id(id)?;
    let hash = hash.trim();
    if !is_commit_hash(hash) {
        return Err(format!("不是有效的版本号：{hash}"));
    }
    if !has_history(&workspace) {
        return Err("笔记文件夹还不是 git 仓库，没有可恢复的版本".into());
    }

    let path = skill_path(&rel, &id);
    let _ = run_git(
        &["rm", "-r", "--force", "--quiet", "--", &path],
        Some(&workspace),
        GIT_TIMEOUT,
    );
    run_git(&["checkout", hash, "--", &path], Some(&workspace), GIT_TIMEOUT)?;

    if run_git_quiet(&["diff", "--cached", "--quiet", "--", &path], &workspace) {
        return Ok(json!({ "changed": false, "hash": hash }));
    }

    let short = &hash[..hash.len().min(7)];
    run_git(
        &["commit", "-m", &format!("skill: {id} 恢复到 {short}")],
        Some(&workspace),
        GIT_TIMEOUT,
    )?;
    Ok(json!({ "changed": true, "hash": hash }))
}

/// 提交号只认十六进制（7 ~ 40 位，完整或短都收）：它是命令行参数，
/// 别的字符要么是注入的选项、要么必然不是提交号。
fn is_commit_hash(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// 版本对比的数据：`{ current: [...], version: [...] }`，两侧同一种形状
/// （`[{rel, content}]`，content 为 null = 读不出文本，比不了）。
///
/// 放在 Rust 一次取回，是为了「对比」这一下只需要一趟 IPC：文件都在同一个仓库里，
/// 分成两条通道去问，中间还可能插进一次别的提交，两侧就对不上同一时刻了。
/// 工作区那一侧与「读项目副本」共用 `read_text_files` —— 二进制 / 读不出的都记 null，
/// 两侧同一条口径，不会出现一边说二进制、一边当成文本的错位。
pub fn version_compare(root: &str, dir: &str, id: &str, hash: &str) -> Result<Value, String> {
    let workspace = workspace_of(root)?;
    let rel = rel_of(dir)?;
    let id = require_id(id)?;
    let hash = hash.trim();
    if !is_commit_hash(hash) {
        return Err(format!("不是有效的版本号：{hash}"));
    }
    if !has_history(&workspace) {
        return Err("笔记文件夹还不是 git 仓库，没有可比的历史版本".into());
    }

    let path = skill_path(&rel, &id);
    Ok(json!({
        "current": read_text_files(&workspace.join(&rel).join(&id)),
        "version": read_commit_files(&workspace, &path, hash)?,
    }))
}

/// 某个提交里这个技能目录下的全部文本文件（`[{rel, content}]`，与 `read_text_files` 同一个形状）。
///
/// 两处不能照搬读工作区那套：
/// 1. 清单来自 `git ls-tree -r -l -z`。**-z 不是可选项**：不加它，git 会把非 ASCII 路径
///    转义成八进制（中文名的附属文件就成了 `\346\212\200...` 这种乱码），而带换行的路径
///    还会把一条记录劈成两行；
/// 2. 内容必须**按原始字节**收回来：`sync::run_git` 会把 stdout 收尾 trim 掉，文件末尾那个
///    换行一没，「两版其实一模一样」就会比出一条假差异来 —— 所以这里走 `git_stdout`。
///
/// 二进制（读不出 UTF-8 的）记 `null`，与工作区那一侧同一条口径。判据有两条，都在这里收口：
/// 「拿回来的字节数对不上 ls-tree 报的大小」（读成字符串时遇到非法 UTF-8 会提前中断）
/// 与「内容里有 NUL」（git 自己就是用 NUL 判二进制的）。
fn read_commit_files(workspace: &Path, path: &str, hash: &str) -> Result<Vec<Value>, String> {
    let listing = git_stdout(
        workspace,
        &["ls-tree", "-r", "-l", "-z", hash, "--", path],
    )?;
    let prefix = format!("{path}/");

    let mut out: Vec<Value> = Vec::new();
    for entry in listing.split('\0').filter(|item| !item.is_empty()) {
        let Some((meta, file)) = entry.split_once('\t') else {
            continue;
        };
        // `<mode> SP <type> SP <object> SP <size>`（-l 的 size 右边有对齐用的空格，按空白切）
        let fields: Vec<&str> = meta.split_whitespace().collect();
        if fields.get(1).copied() != Some("blob") {
            // 子模块 / 目录之类的条目不是技能内容，跳过
            continue;
        }
        let Ok(size) = fields.get(3).copied().unwrap_or("").parse::<usize>() else {
            continue;
        };

        let content = git_stdout(workspace, &["show", &format!("{hash}:{file}")])
            .ok()
            .filter(|text| text.len() == size && !text.contains('\0'));
        out.push(json!({ "rel": file.strip_prefix(&prefix).unwrap_or(file), "content": content }));
    }

    out.sort_by(|left, right| {
        left["rel"]
            .as_str()
            .unwrap_or("")
            .cmp(right["rel"].as_str().unwrap_or(""))
    });
    Ok(out)
}

/// 跑一条 git 命令，**原样**拿回 stdout。
///
/// 为什么不复用 `sync::run_git`：那个函数给的是「一条命令的答案」，会把收尾空白 trim 掉 ——
/// 对「列提交」「取提交号」正好，对「把某个版本的文件内容取回来」是致命的（末尾换行被削掉）。
/// 技能这边的 git 调用全在本地，不需要 sync 那套凭据与全局选项（路径里的中文由 `-z` 负责，
/// 见 `read_commit_files`）。
fn git_stdout(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let outcome = crate::proc::run_direct("git", &owned, GIT_TIMEOUT, Some(workspace), &[])
        .map_err(|err| format!("启动 git 失败（请确认已安装 Git 并把它放在 PATH 里）: {err}"))?;

    if outcome.timed_out {
        return Err(format!("git {} 超时", args[0]));
    }
    if !outcome.ok() {
        return Err(describe(args[0], &outcome));
    }
    Ok(outcome.stdout)
}

// ---------- 复制（导入 / 安装） ----------

/// 从本机一个文件夹把技能复制进技能库。同名的技能已存在时报错 ——
/// 「导入」是想得到一份新的，悄悄覆盖会让用户丢掉他已有的版本历史。
pub fn import_skill(root: &str, dir: &str, source: &str, id: &str) -> Result<Value, String> {
    let target = skill_dir(root, dir, id)?;
    if target.exists() {
        return Err(format!("已经有同名的技能了：{id}"));
    }

    let source = source.trim();
    let source_path = PathBuf::from(source);
    if !source_path.is_dir() {
        return Err(format!("找不到要导入的文件夹：{source}"));
    }

    let files = copy_tree(&source_path, &target)?;
    Ok(json!({ "files": files }))
}

/// 把技能安装到指定项目：整棵复制到 `<项目>/.agents/skills/<技能名>/`。
///
/// 没有 SKILL.md 的目录不是技能（安装过去任何 agent 都认不出），在这里挡住；
/// 目标已存在且没给 overwrite 时返回失败 —— 「要覆盖」必须经过用户确认，
/// 界面拿着这个错误去问，确认后带 overwrite 重调，这里不做第二次判断。
pub fn install(
    root: &str,
    dir: &str,
    id: &str,
    project_dir: &str,
    overwrite: bool,
) -> Result<Value, String> {
    let source = skill_dir(root, dir, id)?;
    if !source.is_dir() {
        return Err(format!("找不到这个技能：{id}"));
    }
    if !source.join(SKILL_MD).is_file() {
        return Err("这个文件夹里没有 SKILL.md，还不是一个完整的技能".into());
    }

    let project = project_dir.trim();
    let project_path = PathBuf::from(project);
    if !project_path.is_dir() {
        return Err(format!("找不到目标项目：{project}"));
    }

    let target = project_path.join(".agents").join("skills").join(require_id(id)?);
    if target.exists() {
        if !overwrite {
            return Err(format!("「{id}」已经装在这个项目里了"));
        }
        std::fs::remove_dir_all(&target).map_err(|err| format!("清理旧版本失败: {err}"))?;
    }

    let files = copy_tree(&source, &target)?;
    Ok(json!({ "files": files }))
}

/// 读一棵目录树里的全部文本文件（`[{rel, content}]`，rel 用 `/` 分隔）。
///
/// 二进制 / 读不出的文件 content 记 `null` —— 它们出现在清单里，但**不参与**
/// 「有没有更新」的比对：比不了的东西不能当差异，也不能当新版本采用。
fn read_text_files(base: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    if !base.is_dir() {
        return out;
    }

    let walker = WalkDir::new(base).follow_links(false).min_depth(1);
    for entry in walker.into_iter().filter_entry(|entry| {
        entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
    }) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(base) else { continue };
        let rel = rel
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let content = std::fs::read_to_string(entry.path()).ok();
        out.push(json!({ "rel": rel, "content": content }));
    }

    out.sort_by(|left, right| {
        left["rel"]
            .as_str()
            .unwrap_or("")
            .cmp(right["rel"].as_str().unwrap_or(""))
    });
    out
}

/// 各个项目里这份技能的副本扫描（`{library: [...], projects: [{project, files}]}`）。
///
/// **只读不改**：库与每个项目副本的全部文本文件都带内容回来（技能文件都是小文本），
/// 「有没有更新」由渲染层比对 —— SKILL.md 按 version 比，附属文件按内容比。
/// 没装这个技能的项目 `files` 为空；路径在这里拼死在
/// `<项目>/.agents/skills/<技能名>/` 下（技能名是单个普通段，出不了项目目录）。
pub fn installed_versions(
    root: &str,
    dir: &str,
    id: &str,
    project_dirs: &[String],
) -> Result<Value, String> {
    let base = skill_dir(root, dir, id)?;
    let id = require_id(id)?;
    let library = read_text_files(&base);

    let mut projects: Vec<Value> = Vec::new();
    for raw in project_dirs {
        let project = raw.trim();
        if project.is_empty() {
            continue;
        }
        let copy_dir = PathBuf::from(project)
            .join(".agents")
            .join("skills")
            .join(&id);
        projects.push(json!({ "project": project, "files": read_text_files(&copy_dir) }));
    }
    Ok(json!({ "library": library, "projects": projects }))
}

/// 技能目录里的全部文件（相对路径 + 字节数）：详情页的多文件编辑列清单用。
///
/// 一个技能往往不止 SKILL.md —— 脚本、模板、子文档都是技能的一部分。点开头的项
/// （`.git` 之类）不进清单，与 copy_tree 同一条规矩；目录不存在返回空表。
pub fn files(root: &str, dir: &str, id: &str) -> Result<Vec<Value>, String> {
    let base = skill_dir(root, dir, id)?;
    let mut out: Vec<Value> = Vec::new();
    if !base.is_dir() {
        return Ok(out);
    }

    let walker = WalkDir::new(&base).follow_links(false).min_depth(1);
    for entry in walker
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
        })
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&base)
            .map_err(|err| format!("计算相对路径失败: {err}"))?
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        out.push(json!({ "rel": rel, "size": size }));
    }

    out.sort_by(|left, right| {
        left["rel"]
            .as_str()
            .unwrap_or("")
            .cmp(right["rel"].as_str().unwrap_or(""))
    });
    Ok(out)
}

/// 把一棵目录树原样复制过去，返回复制了的文件数。
///
/// 点开头的项（`.git`、`.obsidian`…）整支跳过：从别人的笔记文件夹里导入技能时，
/// 那些是别人的仓库与工具状态，不该跟着走；符号链接与其它特殊文件也跳过 ——
/// 技能就是普通文件与小目录。
fn copy_tree(source: &Path, target: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(target).map_err(|err| format!("创建目录失败: {err}"))?;

    let mut files = 0usize;
    let walker = WalkDir::new(source).follow_links(false).min_depth(1);
    for entry in walker.into_iter().filter_entry(|entry| {
        entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
    }) {
        let entry = entry.map_err(|err| format!("读取目录失败: {err}"))?;
        let rel = entry
            .path()
            .strip_prefix(source)
            .map_err(|err| format!("计算相对路径失败: {err}"))?;
        let dest = target.join(rel);

        let file_type = entry.file_type();
        if file_type.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|err| format!("创建目录失败: {err}"))?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest)
                .map_err(|err| format!("复制 {} 失败: {err}", rel.display()))?;
            files += 1;
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个带身份配置的临时 git 仓库（技能的提交会真的跑 git，不配身份 commit 会失败）
    fn temp_repo(name: &str) -> PathBuf {
        if crate::proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            // 调用方用 exists() 检查这个标记
            return PathBuf::from(name);
        }

        let dir = std::env::temp_dir().join(format!("wb-skills-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(run_git(&["init", "--quiet"], Some(&dir), GIT_TIMEOUT).is_ok());
        let _ = run_git(&["config", "user.email", "wb@test"], Some(&dir), GIT_TIMEOUT);
        let _ = run_git(&["config", "user.name", "wb"], Some(&dir), GIT_TIMEOUT);
        dir
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let file = root.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }

    /// 读一个技能里的文件，换行统一成 LF 再比（与 sync.rs 的 read_note 同一个理由：
    /// Windows 上 git 可能开着 autocrlf，checkout 出来的工作区文件是 CRLF —— 差别只在换行）
    fn read_file(path: &Path) -> String {
        std::fs::read_to_string(path)
            .unwrap_or_else(|err| panic!("读 {} 失败: {err}", path.display()))
            .replace("\r\n", "\n")
    }

    fn cleanup(dir: &Path) {
        if dir.starts_with(std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn commit_history_restore_roundtrip() {
        let repo = temp_repo("roundtrip");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        // 第一次提交：changed，历史里有一条
        write(&repo, "skills/alpha/SKILL.md", "版本一\n");
        assert_eq!(commit(&root, "skills", "skill: alpha 新建").unwrap()["changed"], json!(true));
        let log = history(&root, "skills", "alpha", None).unwrap();
        assert_eq!(log.len(), 1);

        // 第二次提交后历史两条、新的在前
        write(&repo, "skills/alpha/SKILL.md", "版本二\n");
        commit(&root, "skills", "skill: alpha 保存").unwrap();
        let log = history(&root, "skills", "alpha", None).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0]["subject"], json!("skill: alpha 保存"));

        // 内容没变时不产生空提交
        assert_eq!(commit(&root, "skills", "skill: alpha 保存").unwrap()["changed"], json!(false));

        // 恢复到第一版：内容回去，历史里多一条恢复记录
        let first = log[1]["hash"].as_str().unwrap().to_string();
        assert_eq!(restore(&root, "skills", "alpha", &first).unwrap()["changed"], json!(true));
        assert_eq!(
            read_file(&repo.join("skills/alpha/SKILL.md")),
            "版本一\n"
        );
        assert_eq!(history(&root, "skills", "alpha", None).unwrap().len(), 3);

        // 版本号只认十六进制
        assert!(restore(&root, "skills", "alpha", "--all").is_err());
        assert!(restore(&root, "skills", "alpha", "zz").is_err());

        cleanup(&repo);
    }

    #[test]
    fn restore_removes_files_added_after_that_version() {
        let repo = temp_repo("restore-removes");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        write(&repo, "skills/alpha/SKILL.md", "第一版\n");
        commit(&root, "skills", "新建").unwrap();
        let first = history(&root, "skills", "alpha", None).unwrap()[0]["hash"]
            .as_str()
            .unwrap()
            .to_string();

        write(&repo, "skills/alpha/SKILL.md", "第二版\n");
        write(&repo, "skills/alpha/extra.md", "后来加的\n");
        commit(&root, "skills", "保存").unwrap();

        restore(&root, "skills", "alpha", &first).unwrap();
        assert_eq!(read_file(&repo.join("skills/alpha/SKILL.md")), "第一版\n");
        assert!(
            !repo.join("skills/alpha/extra.md").exists(),
            "那一版之后新增的文件不该残留"
        );

        cleanup(&repo);
    }

    /// 版本对比：两侧的内容都要**原样**（末尾换行不丢、中文文件名不转义），二进制如实记 null。
    ///
    /// 这一条是「先看清差异、再恢复」的前提 —— 少一个字节的保真度，用户看到的就是一条
    /// 并不存在的改动，而恢复按钮就摆在它下面。
    #[test]
    fn version_compare_reads_both_sides_verbatim() {
        let repo = temp_repo("compare");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        // 第一版：清单 + 一个中文名的附属文件 + 一个二进制文件
        write(&repo, "skills/alpha/SKILL.md", "---\nversion: 0.1.0\n---\n第一版\n");
        write(&repo, "skills/alpha/说明.md", "附属文件\n");
        std::fs::write(repo.join("skills/alpha/logo.png"), [0x89u8, 0x50, 0x00, 0xff]).unwrap();
        commit(&root, "skills", "skill: alpha 新建 0.1.0").unwrap();
        let first = history(&root, "skills", "alpha", None).unwrap()[0]["hash"]
            .as_str()
            .unwrap()
            .to_string();

        // 之后又改又加：对比要能同时看到「那一版的样子」与「现在的样子」
        write(&repo, "skills/alpha/SKILL.md", "---\nversion: 0.2.0\n---\n第二版\n");
        write(&repo, "skills/alpha/extra.md", "后来加的\n");
        commit(&root, "skills", "skill: alpha 保存 0.2.0").unwrap();

        let compared = version_compare(&root, "skills", "alpha", &first).unwrap();
        let files_of = |side: &str| -> Vec<(String, Option<String>)> {
            compared[side]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    (
                        item["rel"].as_str().unwrap().to_string(),
                        item["content"].as_str().map(str::to_string),
                    )
                })
                .collect()
        };
        let rels_of = |files: &[(String, Option<String>)]| -> Vec<String> {
            files.iter().map(|(rel, _)| rel.clone()).collect()
        };
        let content_of = |files: &[(String, Option<String>)], rel: &str| -> Option<String> {
            files
                .iter()
                .find(|(name, _)| name == rel)
                .and_then(|(_, text)| text.clone())
        };

        let version = files_of("version");
        assert_eq!(
            rels_of(&version),
            vec!["SKILL.md", "logo.png", "说明.md"],
            "中文名要原样回来（-z 不做 quotepath 转义），二进制也在清单里"
        );
        assert_eq!(
            content_of(&version, "SKILL.md").as_deref(),
            Some("---\nversion: 0.1.0\n---\n第一版\n"),
            "末尾换行要原样留着（trim 掉就会比出一条假差异）"
        );
        assert_eq!(content_of(&version, "说明.md").as_deref(), Some("附属文件\n"));
        assert!(
            content_of(&version, "logo.png").is_none(),
            "二进制读不出文本，记 null 而不是一段截断的乱码"
        );

        let current = files_of("current");
        assert_eq!(
            rels_of(&current),
            vec!["SKILL.md", "extra.md", "logo.png", "说明.md"],
            "工作区那一侧同样带内容回来"
        );
        assert_eq!(
            content_of(&current, "SKILL.md").as_deref(),
            Some("---\nversion: 0.2.0\n---\n第二版\n")
        );
        assert_eq!(content_of(&current, "extra.md").as_deref(), Some("后来加的\n"));

        // 版本号只认十六进制
        assert!(version_compare(&root, "skills", "alpha", "--all").is_err());
        assert!(version_compare(&root, "skills", "alpha", "zz").is_err());

        // 还不是仓库的笔记文件夹：如实说「没有可比的历史版本」，不是空表
        let plain = std::env::temp_dir().join(format!("wb-skills-plain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(plain.join("skills/alpha")).unwrap();
        assert!(version_compare(&plain.to_string_lossy(), "skills", "alpha", &first).is_err());
        cleanup(&plain);

        cleanup(&repo);
    }

    #[test]
    fn commit_and_history_without_a_repo_are_not_errors() {
        let plain = std::env::temp_dir().join(format!("wb-skills-plain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(plain.join("skills/alpha")).unwrap();
        let root = plain.to_string_lossy().into_owned();

        // 不在任何 git 仓库里：文件操作照常，版本动作如实说「没有」
        assert_eq!(commit(&root, "skills", "skill: alpha 新建").unwrap()["changed"], json!(false));
        assert!(history(&root, "skills", "alpha", None).unwrap().is_empty());

        // 目录不存在同样不是错误（第一次用）
        assert_eq!(commit(&root, "不存在", "x").unwrap()["changed"], json!(false));
        assert!(list(&root, "不存在").unwrap().is_empty());
        // 空 rel = 技能库自己就是仓库根（专门的技能仓库）：列的就是这个根下的条目
        assert!(list(&plain.join("skills").to_string_lossy(), "").is_ok());

        cleanup(&plain);
    }

    #[test]
    fn list_returns_sorted_entries_with_counts_and_text() {
        let repo = temp_repo("list");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        write(&repo, "skills/beta/SKILL.md", "---\nname: B\n---\n");
        write(&repo, "skills/beta/sub/deep.md", "嵌套的也算文件数\n");
        write(&repo, "skills/alpha/SKILL.md", "A\n");
        write(&repo, "skills/alpha/草稿.tmp", "非 markdown 的文件也在\n");
        std::fs::create_dir_all(repo.join("skills/.hidden")).unwrap();

        let items = list(&root, "skills").unwrap();
        let ids: Vec<&str> = items
            .iter()
            .filter_map(|item| item["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["alpha", "beta"], "按 id 排序，点开头的目录不进清单");
        assert_eq!(items[0]["fileCount"], json!(2));
        assert_eq!(items[1]["fileCount"], json!(2), "嵌套文件也数进去");
        assert_eq!(items[1]["skillMd"], json!("---\nname: B\n---\n"));

        cleanup(&repo);
    }

    #[test]
    fn install_copies_tree_and_guards_the_target() {
        let repo = temp_repo("install");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();
        let project = std::env::temp_dir().join(format!("wb-skills-proj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();

        write(&repo, "skills/alpha/SKILL.md", "技能\n");
        write(&repo, "skills/alpha/scripts/run.md", "步骤\n");
        write(&repo, "skills/broken/说明.md", "没有清单文件的目录\n");

        let files = install(&root, "skills", "alpha", &project.to_string_lossy(), false).unwrap();
        assert_eq!(files["files"], json!(2));
        assert!(project.join(".agents/skills/alpha/SKILL.md").is_file());
        assert!(project.join(".agents/skills/alpha/scripts/run.md").is_file());

        // 已安装：不覆盖时报错（界面拿它去问「要不要覆盖」），确认后覆盖成功
        assert!(install(&root, "skills", "alpha", &project.to_string_lossy(), false).is_err());
        assert!(install(&root, "skills", "alpha", &project.to_string_lossy(), true).is_ok());
        assert!(project.join(".agents/skills/alpha/SKILL.md").is_file());

        // 没有清单文件的目录装不出去；项目目录不存在也报错
        assert!(install(&root, "skills", "broken", &project.to_string_lossy(), false).is_err());
        assert!(install(&root, "skills", "alpha", "does-not-exist", false).is_err());

        // 技能名带路径穿越时复制到不了项目之外
        assert!(install(&root, "skills", "../逃出去", &project.to_string_lossy(), true).is_err());

        let _ = std::fs::remove_dir_all(&project);
        cleanup(&repo);
    }

    #[test]
    fn installed_versions_scans_library_and_project_copies() {
        let repo = temp_repo("copies");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        write(&repo, "skills/alpha/SKILL.md", "库里的清单\n");
        write(&repo, "skills/alpha/scripts/run.md", "库里的步骤\n");

        let project = std::env::temp_dir().join(format!("wb-skills-proj2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project).unwrap();
        write(&project, ".agents/skills/alpha/SKILL.md", "项目里改过的清单\n");
        write(&project, ".agents/skills/alpha/extra.md", "项目里新增的文件\n");

        let empty = std::env::temp_dir().join(format!("wb-skills-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&empty).unwrap();

        let result = installed_versions(
            &root,
            "skills",
            "alpha",
            &[project.to_string_lossy().into_owned(), empty.to_string_lossy().into_owned()],
        )
        .unwrap();

        // 库里两个文件都带内容回来
        let library = result["library"].as_array().unwrap();
        assert_eq!(library.len(), 2);
        assert_eq!(library[0]["rel"], json!("SKILL.md"));
        assert_eq!(library[0]["content"], json!("库里的清单\n"));

        // 项目副本：改过的 + 新增的都在；没装的项目 files 为空
        let projects = result["projects"].as_array().unwrap();
        assert_eq!(projects.len(), 2);
        let files = projects[0]["files"].as_array().unwrap();
        let rels: Vec<&str> = files.iter().filter_map(|f| f["rel"].as_str()).collect();
        assert_eq!(rels, vec!["SKILL.md", "extra.md"]);
        assert_eq!(files[0]["content"], json!("项目里改过的清单\n"));
        assert!(projects[1]["files"].as_array().unwrap().is_empty());

        // 技能名带路径穿越时读不到项目目录之外
        assert!(installed_versions(&root, "skills", "../逃出去", &[project.to_string_lossy().into_owned()]).is_err());

        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&empty);
        cleanup(&repo);
    }

    #[test]
    fn import_copies_into_the_library_and_rejects_duplicates() {
        let repo = temp_repo("import");
        if !repo.exists() {
            return;
        }
        let root = repo.to_string_lossy().into_owned();

        let source = std::env::temp_dir().join(format!("wb-skills-src-{}", uuid::Uuid::new_v4()));
        write(&source, "SKILL.md", "---\nname: 导入的\n---\n");
        write(&source, ".git/config", "别人的仓库不该跟过来\n");
        write(&source, "docs/用法.md", "正文\n");

        let files = import_skill(&root, "skills", &source.to_string_lossy(), "imported").unwrap();
        assert_eq!(files["files"], json!(2));
        assert!(repo.join("skills/imported/SKILL.md").is_file());
        assert!(
            !repo.join("skills/imported/.git").exists(),
            "点开头的目录整支跳过"
        );

        assert!(import_skill(&root, "skills", &source.to_string_lossy(), "imported").is_err());
        assert!(import_skill(&root, "skills", "does-not-exist", "other").is_err());

        let _ = std::fs::remove_dir_all(&source);
        cleanup(&repo);
    }

    #[test]
    fn ids_and_dirs_stay_inside_the_workspace() {
        assert!(require_id("alpha").is_ok());
        assert!(require_id("../逃出去").is_err());
        assert!(require_id("a/b").is_err());
        assert!(require_id("C:evil").is_err());
        assert!(require_id("  ").is_err());
        assert_eq!(rel_of("skills").unwrap(), "skills");
        assert_eq!(rel_of(" AI\\skills ").unwrap(), "AI/skills");
        // 空串是合法的：技能库自己就是仓库根
        assert!(rel_of("").unwrap().is_empty());
        assert!(rel_of("skills/../../x").is_err());
    }

    /// 技能库与它的仓库：**从技能库目录开始看有没有 `.git`，没有就往上找最近的**。
    ///
    /// 技能库与笔记文件夹互不相干，所以这里只看那个目录自己往上 —— 判断依据只有 `.git` 的位置，
    /// 与「它是不是某个笔记本」无关。
    #[test]
    fn state_walks_up_from_the_library_to_its_repo() {
        let root = std::env::temp_dir().join(format!("wb-skills-state-{}", uuid::Uuid::new_v4()));
        let library = root.join("仓库").join("agent-knowledge").join("skills");
        std::fs::create_dir_all(&library).unwrap();
        let library_text = library.to_string_lossy().into_owned();
        write(&library, "alpha/SKILL.md", "---
name: A
---
");

        // 上面还没有仓库：仓库就是技能库目录自己，库相对它自己是空串
        let found = state(&library_text).unwrap();
        assert_eq!(found["repo"], json!(library_text), "{found:?}");
        assert_eq!(found["libraryRel"], json!(""), "{found:?}");
        assert_eq!(found["origin"], json!(""), "{found:?}");

        // 挂上仓库（`.git` 存在就算）：往上找到它，库相对它是那几层路径
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let found = state(&library_text).unwrap();
        assert_eq!(found["repo"], json!(root.to_string_lossy()), "{found:?}");
        assert_eq!(found["libraryRel"], json!("仓库/agent-knowledge/skills"), "{found:?}");

        // 技能库**自己**是仓库根时（专门的技能仓库）：rel 是空串 —— 各条通道要照这个干活
        std::fs::create_dir_all(library.join(".git")).unwrap();
        let found = state(&library_text).unwrap();
        assert_eq!(found["repo"], json!(library_text), "最近的优先: {found:?}");
        assert_eq!(found["libraryRel"], json!(""), "{found:?}");

        // 目录不在：如实报错（界面据此提示「重新选一个技能文件夹」）
        assert!(state(root.join("没有这个目录").to_str().unwrap()).is_err());

        cleanup(&root);
    }

    /// 技能库就是仓库根（空 rel）时，路径与 pathspec 那两处换算
    #[test]
    fn an_empty_library_rel_means_the_repo_root_itself() {
        assert!(rel_of("").unwrap().is_empty());
        assert_eq!(skill_path("", "alpha"), "alpha");
        assert_eq!(skill_path("agent-knowledge/skills", "alpha"), "agent-knowledge/skills/alpha");
        assert_eq!(library_spec(""), ".");
        assert_eq!(library_spec("agent-knowledge/skills"), "agent-knowledge/skills");
    }

    /// 相对路径换算的两个边界：锚根就是路径自己（空串）、以及不是祖先时不给一个假路径
    #[test]
    fn rel_under_returns_empty_outside_the_base() {
        let base = PathBuf::from(r"E:\a\b");
        assert_eq!(rel_under(&base, &base.join("c").join("d")), "c/d");
        assert_eq!(rel_under(&base, &base), "");
        assert_eq!(rel_under(&base, &PathBuf::from(r"E:\a\x")), "");
        assert_eq!(rel_under(&base, &PathBuf::from(r"E:\a")), "");
    }
}
