//! 多机同步：把本机那份**用量快照**与**外观配置**推进一个 git 仓库，再把别人的读回来。
//!
//! **为什么是 git**：仓库地址由用户在设置里给，凭据默认用它系统里 git 已经配好的那一套
//! （Credential Manager / SSH key）。代价是本机要装 git。
//!
//! **登录账号是可选的一条捷径**：登录过 GitHub / Gitee 之后，可以把那个 token 变成一条
//! host 限定的请求头交给 git（见 `oauth::git_envs`），私有仓库就不必先手工配好凭据了。
//! 没登录、或设置里关掉了这个开关，就退回系统凭据 —— 两条路都要留着：
//! token 失效时如果只剩它一条路，原本能用的同步也会跟着坏掉。
//!
//! **仓库布局（两个目录，各管一件事）**：
//!   `token-usage/<设备id>.json` —— 这台机器的用量快照（只增不减的计数）
//!   `config/<设备id>.json`      —— 这台机器 theme.json 的整份副本（外观 + 首页布局）
//! 一台机器在每个目录里各占一个文件，每个文件只有一个写者，所以两个目录都不存在
//! 需要人工合并的冲突，流程一律是 pull → 写自己的那份 → commit → push。
//! 别人的文件我们从不修改，只在读取时汇总（用量求和，见 `shared/token-usage.ts`；
//! 配置则整份采用 —— 什么时候采用由用户在设置里点，见 `shared/sync-config.ts`）。
//!
//! 这一层仍然只做「调系统能力 + 读写文件」：两份文件的内容与合并语义都在 TS 侧。
//! 它对那两个 payload 的唯一要求是「能原样变成一个 JSON 文件」—— 结构与收敛规则不在这里。

use serde::Serialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

use crate::oauth;
use crate::paths;
use crate::proc;

/// 单次 git 操作的超时。push / pull 要走网络，给足时间；到点还没回就当失败 ——
/// 界面上「同步失败 + 原因」比一直转圈有用得多。
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// 首次克隆可能要拉完整的仓库历史，宽一些
const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// 图片目录往下找几层。用户自己整理过的仓库可能有 `images/2026/09` 这种层级，
/// 但不会更深 —— 只防手改出来的离谱结构。
const MAX_IMAGE_DEPTH: usize = 6;

/// git 非交互：没有终端可问的时候让它立刻报错，而不是弹一个我们看不见的输入框然后挂到超时。
/// 只关掉**终端**提示，不动 Credential Manager —— 首次同步让它自己弹出登录窗口是合理的，
/// 用户看得见那个窗口，也知道自己在授权什么。
const GIT_ENVS: [(&str, &str); 1] = [("GIT_TERMINAL_PROMPT", "0")];

/// 每条 git 命令都先挂上的全局选项（拼在子命令之前）。
///
/// `core.quotepath=false`：**git 默认会把非 ASCII 路径转义成八进制** ——
/// `周报.md` 会变成 `\345\221\250\346\212\245.md`。冲突提示里要点出的正是文件名
/// （见 `conflict_names`），而这个应用的笔记多半是中文名，转义之后那句话就成了看不懂的乱码。
///
/// 不能指望本机的 git 配置：这是个**每台机器都可能不同**的全局项（用户自己在
/// `~/.gitconfig` 里设过就不同），而我们每次都要拿到能直接上屏的名字。
const GIT_GLOBAL_ARGS: [&str; 2] = ["-c", "core.quotepath=false"];

thread_local! {
    /// 本次 git 调用额外要带的 git 配置（host 限定的 Authorization 头，见 `oauth::git_envs`）。
    ///
    /// **为什么走 thread-local 而不是逐层传参**：这个值只有最底下的 `run()` 用得到，
    /// 而中间那七八个 git 辅助函数（`ensure_clone` / `sync_branch` / `checkout_branch` …）
    /// 与凭据毫无关系，为它改一长串签名并不划算。同步流程从头到尾是同步调用，
    /// 每个入口显式设一次，不会跨线程串味。
    static GIT_AUTH: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

/// 设定本次同步用的凭据。空表表示照旧走系统 git 凭据。
fn set_git_auth(use_account: bool) {
    let envs = if use_account { oauth::git_envs() } else { Vec::new() };
    GIT_AUTH.with(|slot| *slot.borrow_mut() = envs);
}

/// 本机设备标识：没有就生成一份落盘。id 一旦生成不再变，分片文件名就是它。
///
/// 落盘失败不报错：设备 id 只在同步里当分片名用，连它都写不进去的话同步本来也跑不成，
/// 但那时**本机数据仍然要能看**，不能因为一个标识把整块 Token 面板打断。
pub fn device_info() -> Result<Value, String> {
    let existing = std::fs::read_to_string(paths::device_file())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());

    let id = match existing {
        Some(id) => id,
        None => {
            let generated = uuid::Uuid::new_v4().to_string();
            if let Err(err) = write_device(&generated) {
                eprintln!("[workbench] {err}");
            }
            generated
        }
    };

    Ok(json!({ "id": id, "name": host_name() }))
}

fn write_device(id: &str) -> Result<(), String> {
    let file = paths::device_file();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建设备标识目录失败: {err}"))?;
    }
    let text = serde_json::to_string_pretty(&json!({ "id": id }))
        .map_err(|err| format!("序列化设备标识失败: {err}"))?;
    std::fs::write(&file, text).map_err(|err| format!("写入设备标识失败: {err}"))
}

/// 设备名：默认就是主机名（Windows 的计算机名不带空格、不带中文，正好能直接当标签和提交信息）
fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "本机".to_string())
}

/// 写本机那两个文件（用量 + 配置）→ 提交 → 推送。返回 `{ changed, pushed, log }`（log 只用于排查）。
///
/// `config` 为 `None` 表示「这台机器不同步配置」（设置里的开关关着）：仓库里自己那份会被删掉，
/// 一并进这次提交 —— 「不同步外观」就该是仓库里没有它，而不是留着一份越放越旧的副本。
/// `use_account` 为真时用已登录账号的 token 授权，否则走系统 git 凭据。
pub fn publish(
    repo: &str,
    device: &str,
    usage: &Value,
    config: Option<&Value>,
    use_account: bool,
) -> Result<Value, String> {
    publish_at(
        &paths::token_sync_dir(),
        repo,
        device,
        usage,
        config,
        use_account,
    )
}

/// 同上，克隆目录由调用方给（单测用临时目录跑真实的 git 流程）。
fn publish_at(
    clone_dir: &Path,
    repo: &str,
    device: &str,
    usage: &Value,
    config: Option<&Value>,
    use_account: bool,
) -> Result<Value, String> {
    // 必须在任何 git 调用之前设好：下面的 ensure_clone 就要走网络
    set_git_auth(use_account);
    let (dir, branch) = ensure_clone(clone_dir, repo)?;
    let mut log: Vec<String> = Vec::new();

    let safe = safe_name(device);
    let usage_relative = format!("{}/{safe}.json", paths::TOKEN_USAGE_DIR);
    let config_relative = format!("{}/{safe}.json", paths::CONFIG_DIR);

    write_json(&dir.join(&usage_relative), usage)?;

    // 配置那份可能写、可能删、也可能本来就没有（从没推过配置的机器）。
    // **先记下它原来在不在**：删掉之后 exists() 就是 false 了，而「删过一个文件」同样要进这次提交 ——
    // 漏掉它的话仓库里那份配置会一直留着，工作区里还多出一个永远没被提交的删除。
    let config_file = dir.join(&config_relative);
    let had_config = config_file.exists();
    match config {
        Some(value) => write_json(&config_file, value)?,
        None => {
            if had_config {
                std::fs::remove_file(&config_file).map_err(|err| format!("删除配置失败: {err}"))?;
            }
        }
    }
    let touches_config = config.is_some() || had_config;

    // 一次提交带上这两个文件：它们是「这台机器的一份状态」，分开提交只会让历史里多出
    // 两条语义相同的记录。没写也没删配置时不提它 —— `git add` 一个不存在的路径会直接报错。
    let mut staged = vec![usage_relative.as_str()];
    if touches_config {
        staged.push(config_relative.as_str());
    }
    let mut add_args: Vec<&str> = vec!["add", "-A", "--"];
    add_args.extend(staged.iter().copied());
    run_git(&add_args, Some(&dir), GIT_TIMEOUT)?;

    // 有没有东西要提交交给 git 自己判断（内容没变时自动同步每分钟都会走到这里，
    // 不能让仓库里堆一串「什么都没改」的提交）。`diff --cached --quiet` 退出码 1 = 有暂存改动。
    let mut diff_args: Vec<&str> = vec!["diff", "--cached", "--quiet", "--"];
    diff_args.extend(staged.iter().copied());
    let changed = !run_git_quiet(&diff_args, &dir);
    if changed {
        let message = format!("sync:{safe}");
        log.push(run_git(&["commit", "-m", &message], Some(&dir), GIT_TIMEOUT)?);
    }

    // 即使这轮没提交也推一次：上一轮可能提交成功而推送失败，那一笔还压在本地等着出去
    if let Err(err) = push(&dir, &branch) {
        // 远端在 pull 之后又动了（另一台机器刚推过）：rebase 一次再试。
        // 两个目录里都是单写者文件，所以这次 rebase 不可能产生冲突。
        log.push(err);
        log.push(run_git(
            &["pull", "--rebase", "--autostash", "--no-edit", "origin", &branch],
            Some(&dir),
            GIT_TIMEOUT,
        )?);
        log.push(push(&dir, &branch)?);
    }

    Ok(json!({ "changed": changed, "pushed": true, "log": log.join("\n") }))
}

/// 先写临时文件再改名：读到半个 JSON 的可能是 git 自己，也可能是同步目录上的杀毒软件
fn write_json(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|err| format!("序列化失败: {err}"))?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, &text).map_err(|err| format!("写入失败: {err}"))?;
    std::fs::rename(&tmp, file).map_err(|err| format!("替换文件失败: {err}"))
}

/// 仓库里两个目录的内容（原始 JSON，收敛与合并由渲染层负责）
#[derive(Serialize)]
pub struct SyncFiles {
    pub usage: Vec<Value>,
    pub config: Vec<Value>,
}

// ---------- 笔记里的图片 ----------

/// 把一张图片写进**图片仓库**并推上去，返回它在仓库里的相对路径与推上去的分支。
///
/// 与用量同步共用同一套 git 机制（克隆缓存、凭据、pull → 写 → commit → push），
/// 但地址与克隆目录都是**另一套**：用户完全可以把图片放在另一个仓库里。
/// 这一层只搬字节 —— 不转格式、不压尺寸、也不看内容（渲染层从粘贴的图片里读到的就是原始字节）。
///
/// 子目录与文件名由渲染层算好（带时间戳与随机段，见 `shared/note-image.ts`），
/// 这里做最后一道把关：挡掉会把文件写到克隆目录之外的名字。
pub fn publish_image(
    repo: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
    use_account: bool,
) -> Result<Value, String> {
    publish_image_at(&paths::image_sync_dir(), repo, dir, name, bytes, use_account)
}

/// 同上，克隆目录由调用方给（单测用临时目录跑真实 git 流程）
fn publish_image_at(
    clone_dir: &Path,
    repo: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
    use_account: bool,
) -> Result<Value, String> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err("还没有配置图片仓库（设置 → 笔记图片）".into());
    }
    if bytes.is_empty() {
        return Err("这是一张空图片".into());
    }

    // 必须在任何 git 调用之前设好：下面的 ensure_clone 就要走网络
    set_git_auth(use_account);
    let relative = image_relative_path(dir, name)?;
    let (dir_path, branch) = ensure_clone(clone_dir, repo)?;

    let file = dir_path.join(&relative);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    // 先写临时文件再改名：与 store.rs 同一个道理 —— 中途断电时，读到的不是半张图。
    // 临时文件**不参与这次提交**（下面只 add 这一个相对路径），所以它进不了仓库历史
    let temp = file.with_file_name(format!("{name}.part"));
    std::fs::write(&temp, bytes).map_err(|err| format!("写入失败: {err}"))?;
    std::fs::rename(&temp, &file).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("保存失败: {err}")
    })?;

    let mut log: Vec<String> = Vec::new();
    run_git(&["add", "-A", "--", &relative], Some(&dir_path), GIT_TIMEOUT)?;

    // 同名文件重传（理论上不会，文件名带随机段）时不产生空提交
    let changed = !run_git_quiet(&["diff", "--cached", "--quiet", "--", &relative], &dir_path);
    if changed {
        let message = format!("image:{name}");
        log.push(run_git(&["commit", "-m", &message], Some(&dir_path), GIT_TIMEOUT)?);
    }

    if let Err(err) = push(&dir_path, &branch) {
        // 远端在我们 pull 之后又动了（另一处刚推过）：rebase 一次再试
        log.push(err);
        log.push(run_git(
            &["pull", "--rebase", "--autostash", "--no-edit", "origin", &branch],
            Some(&dir_path),
            GIT_TIMEOUT,
        )?);
        log.push(push(&dir_path, &branch)?);
    }

    Ok(json!({ "path": relative, "branch": branch, "changed": changed, "log": log.join("\n") }))
}

/// 图片仓库里现在有哪些图（顺手把本地克隆拉到最新）。
///
/// 只扫**设置里那个子目录**：仓库里还住着 README 之类的东西，它们不该出现在素材列表里。
/// 回来的是「相对路径（仓库内写法，与上传回来的是同一种）+ 文件名 + 字节数」，
/// 名字不要后缀、谁被引用了多少次这类判断都留在渲染层（见 shared/note-image.ts）。
///
/// 与上传一样，配置为空是「还没设」而不是「空仓库」：那种情况要报错，
/// 界面才能提示去哪儿填，而不是显示成「一张图都没有」。
pub fn list_images(repo: &str, dir: &str, use_account: bool) -> Result<Value, String> {
    list_images_at(&paths::image_sync_dir(), repo, dir, use_account)
}

fn list_images_at(
    clone_dir: &Path,
    repo: &str,
    dir: &str,
    use_account: bool,
) -> Result<Value, String> {
    let clean = require_image_repo(repo)?;
    let clean_dir = normalize_image_dir(dir)?;

    // 必须在任何 git 调用之前设好：ensure_clone 要走网络
    set_git_auth(use_account);
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
    dir: &str,
    paths: &[String],
    use_account: bool,
) -> Result<Value, String> {
    delete_images_at(&paths::image_sync_dir(), repo, dir, paths, use_account)
}

fn delete_images_at(
    clone_dir: &Path,
    repo: &str,
    dir: &str,
    paths: &[String],
    use_account: bool,
) -> Result<Value, String> {
    let clean = require_image_repo(repo)?;
    if paths.is_empty() {
        return Err("没有选中要删除的图片".into());
    }

    set_git_auth(use_account);
    let (root, branch) = ensure_clone(clone_dir, &clean)?;

    let mut removed: Vec<String> = Vec::new();
    for raw in paths {
        let rel = image_repo_path(dir, raw)?;
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

    if let Err(err) = push(&root, &branch) {
        // 远端在我们 pull 之后又动了（另一处刚推过）：rebase 一次再试
        log.push(err);
        log.push(run_git(
            &["pull", "--rebase", "--autostash", "--no-edit", "origin", &branch],
            Some(&root),
            GIT_TIMEOUT,
        )?);
        log.push(push(&root, &branch)?);
    }

    Ok(json!({
        "deleted": removed.len(),
        "changed": true,
        "branch": branch,
        "log": log.join("\n"),
        "paths": removed,
    }))
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

/// 一个「正常的路径段」：非空、不是 `.` / `..`、不带分隔符与 Windows 上的非法字符
fn is_plain_segment(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
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

// ---------- 笔记同步 ----------

/// 笔记同步：把**用户挑的那个笔记文件夹本身**当成一个 git 工作区（提交 → pull --rebase → 推送）。
///
/// 与另外两处同步最大的不同是**没有克隆目录**：用量 / 图片那边同步的是应用自己在 `%APPDATA%`
/// 里管的缓存，这边同步的就是用户那个文件夹 —— 于是「笔记就是磁盘上那些 `.md`」这条不变：
/// 换台机器 `git clone` 下来、拿别的编辑器接着写，还是同一份东西，应用只是替它跑几条 git 命令。
///
/// 四件必须说清楚的事：
///   1. **还不是仓库时就地 `git init`**：用户填了地址又点了同步，这件事本身就是「把笔记放进一个
///      git 仓库」。但**已经连着别的仓库时如实报错、不动它的 origin** —— 悄悄改地址等于把用户的
///      笔记推到一个他没选的地方（与 `ensure_clone` 那边相反：那边是应用自己的缓存，可以随便删）；
///   2. **先提交本机的改动**，再拉、再推。顺序反了的话工作区里的改动会挡住 rebase，
///      而「还没提的那一份」在冲突里没有落脚点，撤回来就没了；
///   3. **冲突不替用户挑边**：中止这次 rebase（本地那笔提交留着）、把冲突的文件名如实报回去。
///      笔记是文字，自动挑一边就是悄悄改掉人家的内容；
///   4. 文件夹里留着**别人没做完的 rebase / merge** 时拒绝动手：那是用户的现场，
///      我们既不该在 detach 的 HEAD 上提交，也不该替他 abort。
pub fn sync_notes(repo: &str, dir: &str, use_account: bool) -> Result<Value, String> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err("还没有配置笔记仓库（设置 → 笔记）".into());
    }

    let dir = dir.trim();
    if dir.is_empty() {
        return Err("还没有选择笔记文件夹".into());
    }
    let root = PathBuf::from(dir);
    if !root.is_dir() {
        return Err(format!("找不到笔记文件夹：{dir}"));
    }
    if in_rebase(&root) {
        return Err("这个笔记文件夹里还有一次没做完的 rebase：先手工处理完（`git rebase --continue` 或 `git rebase --abort`）再同步".into());
    }
    if run_git_quiet(&["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], &root) {
        return Err("这个笔记文件夹里还有一次没做完的合并：先手工处理完再同步".into());
    }

    // 必须在任何 git 调用之前设好：下面的 fetch / pull / push 都要走网络
    set_git_auth(use_account);

    let mut log: Vec<String> = Vec::new();
    let was_empty = head_of(&root).is_empty();
    prepare_notes_repo(&root, repo)?;

    // 先看看远端有什么：分支要按它来定。拉不动不算错（空仓库、没网都走这条）——
    // 真正的失败留给下面那几步，那里的报错更说得清原因
    if let Ok(text) = run_git(&["fetch", "--quiet", "--prune", "origin"], Some(&root), GIT_TIMEOUT) {
        if !text.trim().is_empty() {
            log.push(text);
        }
    }

    let branch = note_branch(&root)?;
    // 刚接上远端的分支（本地本来还没有提交，这一步之后站上去了）：远端那一批就是这次取下来的
    let adopted_remote = was_empty && !head_of(&root).is_empty();

    let files = commit_notes(&root, &mut log)?;

    /*
     * 「这次同步有没有把远端的东西取下来」。
     *
     * 两种情况都算：**刚接上远端的分支**（上面那一下把远端的笔记落到了盘上）与
     * **pull 真的动了 HEAD**。只看 pull 会漏掉前者 —— 那正是新机器第一次同步
     * 最需要被说一句「拉回来了」的时候。
     */
    let before_pull = head_of(&root);
    pull_notes(&root, &branch, &mut log)?;
    let received = adopted_remote || before_pull != head_of(&root);

    // 一份提交都没有（笔记本是空的、远端也空）：没有可推的，如实回一个「什么都没做」的结果，
    // 不然 `git push` 会报一句「refspec 匹配不上任何东西」，看着像出错
    if !head_of(&root).is_empty() {
        push_notes(&root, &branch, &mut log)?;
    }

    Ok(json!({
        "branch": branch,
        "files": files,
        "received": received,
        "log": log.join("\n"),
    }))
}

/// 让这个文件夹成为一个连到 `repo` 的仓库：没有仓库就地 init，没有 origin 就接上，
/// 连着**别的**仓库就报错（那是个人的文件夹，不能替他把 origin 改掉）。
fn prepare_notes_repo(root: &Path, repo: &str) -> Result<(), String> {
    // `.git` 是个目录（普通仓库）也可能是个文件（worktree / 子模块），两种都算「已经是仓库」
    if !root.join(".git").exists() {
        run_git(&["init", "--quiet"], Some(root), GIT_TIMEOUT)?;
    }

    if run_git_quiet(&["remote", "get-url", "origin"], root) {
        if !same_remote(root, repo) {
            let current =
                run_git(&["remote", "get-url", "origin"], Some(root), GIT_TIMEOUT).unwrap_or_default();
            return Err(format!(
                "这个笔记文件夹已经连着另一个仓库（{}），与设置里填的 {} 不是同一个。要换过来，请在这个文件夹里自己跑 `git remote set-url origin <新地址>`。",
                current.trim(),
                repo
            ));
        }
    } else {
        run_git(&["remote", "add", "origin", repo], Some(root), GIT_TIMEOUT)?;
    }

    // 提交是应用替用户产生的：他没配过 git 身份时给一个兜底，否则 commit 会直接失败。
    // 只写这个仓库的本地配置（`--local` 是默认），用户自己的全局身份一概不动 ——
    // 配过就照他的身份提交（这一条与 ensure_clone 那个应用自己的克隆不同）
    if !run_git_quiet(&["config", "user.email"], root) {
        run_git(&["config", "user.email", "workbench@localhost"], Some(root), GIT_TIMEOUT)?;
        run_git(&["config", "user.name", "Workbench"], Some(root), GIT_TIMEOUT)?;
    }

    Ok(())
}

/// 这个文件夹的 origin 与设置里填的是不是同一个仓库。
///
/// 先按 `clone_matches` 那条口径比（去尾斜杠与 `.git`）；**本地路径**再多走一步：
/// Windows 上 `C:/a/b` 与 `C:\a\b` 是同一个目录，字符串却不一样，而笔记仓库完全可能
/// 就是本机或网盘上的一个裸仓库 —— 不放宽的话，用户把地址换一种写法填进来就会被
/// 「已经连着另一个仓库」挡在门外（这条是实测踩到的，不是设想）。
/// 网络地址（https / ssh / scp 那种）仍然按原样比，自建服务器的路径可能区分大小写。
fn same_remote(root: &Path, repo: &str) -> bool {
    if clone_matches(root, repo) {
        return true;
    }

    let current = run_git(&["remote", "get-url", "origin"], Some(root), GIT_TIMEOUT).unwrap_or_default();
    match (local_path_key(&current), local_path_key(repo)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// 本地路径远端的归一化写法：统一分隔符、统一大小写，于是同一个目录的各种写法落在同一个串上。
/// 不是本地路径（URL / scp 那种）时返回 None —— 那些必须按原样比。
fn local_path_key(raw: &str) -> Option<String> {
    let value = normalize_repo(raw);
    let looks_local = value.starts_with('/')
        || value.starts_with("\\\\")
        // 盘符开头（`C:`）：`git@host:path` 的第二字符不是冒号，不会被认成路径
        || value.as_bytes().get(1) == Some(&b':');
    if !looks_local {
        return None;
    }
    Some(value.replace('\\', "/").to_lowercase())
}

/// 同步用哪个分支。
/// 这是**用户的**工作区：已经有提交时就按它当前站着的分支走 —— 他在自己文件夹里切过分支、
/// 或者在别的分支上写东西，应用不该把他切回去。还没有提交（刚 init 出来的）才交给
/// `sync_branch`：跟着远端已有的分支走，远端一个分支都没有（真·空仓库）才新建 main ——
/// 与另外两处同步同一条口径（那里记着 `rev-parse --abbrev-ref HEAD` 会骗人的原因）。
fn note_branch(root: &Path) -> Result<String, String> {
    if !head_of(root).is_empty() {
        if let Ok(name) = run_git(&["symbolic-ref", "--short", "HEAD"], Some(root), GIT_TIMEOUT) {
            let name = name.trim();
            if !name.is_empty() {
                return Ok(name.to_string());
            }
        }
    }
    sync_branch(root)
}

/// 把本机的改动提交掉（没有改动就什么都不做），返回这次提交了几个文件。
///
/// `add -A` 是整个文件夹：笔记、附件、用户自己放进来的 `.gitignore` 都算这个仓库的内容 ——
/// 要排除什么都写在 `.gitignore` 里，那是 git 自己的规矩。
fn commit_notes(root: &Path, log: &mut Vec<String>) -> Result<usize, String> {
    run_git(&["add", "-A"], Some(root), GIT_TIMEOUT)?;
    // 退出码 1 = 有暂存改动（与 publish_at 那边同一个用法）
    if run_git_quiet(&["diff", "--cached", "--quiet"], root) {
        return Ok(0);
    }

    let names = run_git(&["diff", "--cached", "--name-only"], Some(root), GIT_TIMEOUT)?;
    let files = names.lines().filter(|line| !line.trim().is_empty()).count();
    log.push(run_git(
        &["commit", "-m", &format!("notes: {}", host_name())],
        Some(root),
        GIT_TIMEOUT,
    )?);
    Ok(files)
}

/// 拉一次远端（rebase 方式）。
///
/// 撞上冲突**不挑边**：先记下那几个冲突的文件名，再中止这次 rebase（本地那笔提交留着），
/// 报错让用户自己合 —— 远端那些改动留在远端，没有丢。
///
/// **只有这次是我们起的 rebase 才中止**：文件夹里本来就留着一次没做完的 rebase 时，
/// 那是用户的现场，替他 abort 等于扔掉他手上的半成品（`sync_notes` 在入口已经拦了一道，
/// 这里再判一次是因为中间还隔着 fetch 与 commit 两个可能出错的步骤）。
fn pull_notes(root: &Path, branch: &str, log: &mut Vec<String>) -> Result<(), String> {
    // 远端还没有这个分支（第一次推送之前）就没东西可拉
    let remote_ref = format!("refs/remotes/origin/{branch}");
    if !run_git_quiet(&["rev-parse", "--verify", "--quiet", &remote_ref], root) {
        return Ok(());
    }
    if in_rebase(root) {
        return Ok(());
    }

    let outcome = run(
        &["pull", "--rebase", "--autostash", "--no-edit", "origin", branch],
        Some(root),
        GIT_TIMEOUT,
    )?;

    if outcome.timed_out {
        return Err("git pull 超时（网络不通或被防火墙拦了）".into());
    }
    if !outcome.ok() {
        if in_rebase(root) {
            let conflicts = run_git(
                &["diff", "--name-only", "--diff-filter=U"],
                Some(root),
                GIT_TIMEOUT,
            )
            .unwrap_or_default();
            // 中止之后本地回到「刚提交完」的样子：工作区干净、那笔提交还在
            let _ = run_git(&["rebase", "--abort"], Some(root), GIT_TIMEOUT);
            return Err(format!(
                "远端和本机改到了同一处（{}），这次没有替你挑一边：本次提交已经留在本地，远端那几处等你手工合好再同步。",
                conflict_names(&conflicts)
            ));
        }
        return Err(describe("pull", &outcome));
    }

    let text = outcome.stdout.trim();
    if !text.is_empty() {
        log.push(text.to_string());
    }
    Ok(())
}

/// 推上去；推不动（远端在拉之后又动了）时再拉一次 rebase 重试 —— 与另外两处同步同一个套路。
fn push_notes(root: &Path, branch: &str, log: &mut Vec<String>) -> Result<(), String> {
    if let Err(err) = push(root, branch) {
        log.push(err);
        pull_notes(root, branch, log)?;
        log.push(push(root, branch)?);
    }
    Ok(())
}

/// 当前 HEAD 的提交号；还没有提交（刚 init 出来的空仓库）时是空串。
///
/// 与 `rev-parse --abbrev-ref HEAD` 不同，这一条在「没有提交」时是**真的失败**，
/// 于是能被当成「本地还没有任何东西」的判据（那个名字在空仓库里照样报得出来，见 `sync_branch`）。
fn head_of(root: &Path) -> String {
    run_git(&["rev-parse", "HEAD"], Some(root), GIT_TIMEOUT).unwrap_or_default()
}

/// 文件夹里正处在一次 rebase 中途吗
fn in_rebase(root: &Path) -> bool {
    root.join(".git").join("rebase-merge").exists()
        || root.join(".git").join("rebase-apply").exists()
        || run_git_quiet(&["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], root)
}

/// 冲突的那几个文件名，报给用户看；多的时候只列前几个（列表太长反而看不清重点）
fn conflict_names(list: &str) -> String {
    let names: Vec<&str> = list
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if names.is_empty() {
        return "有一处".to_string();
    }

    let head: Vec<&str> = names.iter().copied().take(3).collect();
    let text = head.join("、");
    if names.len() > head.len() {
        format!("{text} 等 {} 个文件", names.len())
    } else {
        text
    }
}

/// 读同步目录里所有机器的两个文件（原始 JSON，收敛与合并由渲染层负责）。
///
/// **只读属于当前配置那个仓库的克隆**：克隆存在但 origin 不是 `repo` 时返回空表。
/// 换了地址之后重新克隆可能还没成功（没网 / 新地址写错 / 旧克隆被占用），
/// 而克隆的工作区里还留着**老仓库**的别人的文件 —— 不核对的话那些会被当成最新的读进来，
/// 界面上就是一份「看着正常、其实来自另一个仓库」的东西。
///
/// 不做别的过滤：本机那两份也在返回里，由渲染层按 device 排除
/// （它手上有内存里的最新版本，用仓库里上次推送的副本会把本机重复计一遍）。
pub fn read_shards(repo: &str) -> Result<SyncFiles, String> {
    read_shards_for(&paths::token_sync_dir(), repo)
}

/// 同上的实体：克隆目录可注入（单测用临时目录跑真实 git）
fn read_shards_for(dir: &Path, repo: &str) -> Result<SyncFiles, String> {
    // 这一路只碰本地（核对 origin 是本地命令，文件是读文件），不需要凭据。
    // 显式清空是为了不继承同线程上一次 publish 留下的凭据。
    set_git_auth(false);

    let empty = SyncFiles {
        usage: Vec::new(),
        config: Vec::new(),
    };
    if !dir.join(".git").is_dir() || !clone_matches(dir, repo) {
        return Ok(empty);
    }

    Ok(SyncFiles {
        usage: read_dir_json(&dir.join(paths::TOKEN_USAGE_DIR))?,
        config: read_dir_json(&dir.join(paths::CONFIG_DIR))?,
    })
}

fn read_dir_json(dir: &Path) -> Result<Vec<Value>, String> {
    // 还没同步过（克隆目录都没有）就是空列表，不是错误
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        // 单个文件坏了（手工改过 / 半截写入）就跳过它：一个坏文件不能把整块面板拖垮
        if let Some(value) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            out.push(value);
        }
    }
    Ok(out)
}

// ---------- git ----------

/// 确保本地克隆存在、指向**当前配置的那个**仓库、站在正确的分支上、并且已经是最新的；
/// 返回（克隆目录，分支名）。
///
/// 设置里换了仓库地址时必须把旧克隆整个丢掉重新克隆，不能只改 origin：
/// 克隆的工作区里带着**上一个仓库**的别人的分片文件，只换 origin 的话那些文件还在，
/// 读分片时会把上一个仓库的数据当成最新合进来（数字看着正常，其实来自另一个仓库）；
/// 而且两个仓库的历史通常无关，pull 也会直接失败。克隆目录只是缓存，删掉没有损失。
fn ensure_clone(dir: &Path, repo: &str) -> Result<(PathBuf, String), String> {
    if dir.join(".git").is_dir() && !clone_matches(dir, repo) {
        std::fs::remove_dir_all(dir).map_err(|err| format!("切换仓库时清理旧克隆失败: {err}"))?;
    }

    if !dir.join(".git").is_dir() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
        }
        // 上次克隆到一半留下的目录会让 git clone 直接失败（目标非空），先清掉
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|err| format!("清理上次的克隆失败: {err}"))?;
        }

        let target = dir.to_string_lossy().into_owned();
        run_git(&["clone", repo, &target], None, CLONE_TIMEOUT)?;

        // 提交是机器自动产生的，不该要求用户先把自己的 git 身份配好。
        // 写进仓库本地配置（--local 是默认），不动用户的全局配置。
        let _ = run_git(&["config", "user.name", "Workbench"], Some(dir), GIT_TIMEOUT);
        let _ = run_git(
            &["config", "user.email", "workbench@localhost"],
            Some(dir),
            GIT_TIMEOUT,
        );
    }

    let branch = sync_branch(dir)?;

    // 远端还没有这个分支（空仓库的第一次推送）就没东西可拉，那时 `git pull` 只会报错
    let remote_ref = format!("refs/remotes/origin/{branch}");
    if run_git_quiet(&["rev-parse", "--verify", "--quiet", &remote_ref], dir) {
        run_git(
            &["pull", "--rebase", "--autostash", "--no-edit", "origin", &branch],
            Some(dir),
            GIT_TIMEOUT,
        )?;
    }

    Ok((dir.to_path_buf(), branch))
}

/// 克隆指向的仓库与设置里填的是不是同一个（地址取不回来就当作不是）
fn clone_matches(dir: &Path, repo: &str) -> bool {
    match run_git(&["remote", "get-url", "origin"], Some(dir), GIT_TIMEOUT) {
        Ok(url) => normalize_repo(&url) == normalize_repo(repo),
        Err(_) => false,
    }
}

/// 比地址时忽略写法差异：结尾的斜杠与 `.git` 去掉再比 ——
/// 同一个仓库写成 `…/sync.git` 与 `…/sync` 不该让用户白等一次重新克隆。
/// 不动大小写：自建服务器的路径可能是大小写敏感的，宁可比严一点。
fn normalize_repo(url: &str) -> String {
    url.trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string()
}

/// 确定同步用的分支，并保证本地真的站在它上面。
///
/// **不能直接用 `rev-parse --abbrev-ref HEAD`**：远端 HEAD 指向一个不存在的分支时
/// （本地 `git init --bare` 之后把第一个分支推上去就是这种状态；GitHub 会自己把默认分支改过来，
/// 别的托管方和裸仓库不会），克隆出来**没有任何本地分支**，而 HEAD 照样报出一个名字。
/// 照着它提交就会另起一个分支、推到远端另一个分支上 —— 别人的分片明明在原来的分支上，
/// 我们却读不到，界面上表现为「同步成功，但永远只有自己这台机器」。
/// 所以这里以**远端实际存在的分支**为准：优先远端默认分支，其次远端已有的第一个分支，
/// 远端一个分支都没有（真·空仓库）才新建 main。
fn sync_branch(dir: &Path) -> Result<String, String> {
    let candidates = remote_branches(dir);
    let preferred = remote_default_branch(dir).filter(|name| candidates.contains(name));
    let target = preferred.or_else(|| candidates.first().cloned());

    match target {
        Some(name) => {
            checkout_branch(dir, &name)?;
            Ok(name)
        }
        None => {
            checkout_branch(dir, "main")?;
            Ok("main".to_string())
        }
    }
}

/// 切到 `name`：本地有就切过去（正常克隆本来就是当前分支，这行是幂等的），
/// 没有就从同名远端分支建一个带跟踪的本地分支；远端也没有（空仓库）就直接新建。
fn checkout_branch(dir: &Path, name: &str) -> Result<(), String> {
    if run_git_quiet(
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")],
        dir,
    ) {
        return run_git(&["checkout", name], Some(dir), GIT_TIMEOUT).map(|_| ());
    }

    let remote = format!("origin/{name}");
    if run_git_quiet(
        &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}")],
        dir,
    ) {
        return run_git(
            &["checkout", "-b", name, "--track", &remote],
            Some(dir),
            GIT_TIMEOUT,
        )
        .map(|_| ());
    }

    run_git(&["checkout", "-b", name], Some(dir), GIT_TIMEOUT).map(|_| ())
}

/// 远端默认分支的短名（`origin/main` → `main`）；解析不出来返回 None
fn remote_default_branch(dir: &Path) -> Option<String> {
    let name = run_git(
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        Some(dir),
        GIT_TIMEOUT,
    )
    .ok()?;
    let name = name.trim().strip_prefix("origin/")?.to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 远端已有的分支短名；`origin/HEAD` 是符号引用，不算分支
fn remote_branches(dir: &Path) -> Vec<String> {
    let Ok(text) = run_git(
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
        Some(dir),
        GIT_TIMEOUT,
    ) else {
        return Vec::new();
    };

    text.lines()
        .filter_map(|line| line.trim().strip_prefix("origin/"))
        .filter(|name| !name.is_empty() && *name != "HEAD")
        .map(str::to_string)
        .collect()
}

fn push(dir: &Path, branch: &str) -> Result<String, String> {
    run_git(&["push", "--set-upstream", "origin", branch], Some(dir), GIT_TIMEOUT)
}

/// 跑一条 git 命令；失败时把 git 自己的话带回去当提示。
fn run_git(args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<String, String> {
    let outcome = run(args, cwd, timeout)?;

    if outcome.timed_out {
        return Err(format!("git {} 超时（网络不通或被防火墙拦了）", args[0]));
    }
    if !outcome.ok() {
        return Err(describe(args[0], &outcome));
    }
    Ok(outcome.stdout.trim().to_string())
}

/// 只看退出码，不看输出。用于「有没有改动 / 有没有远端分支」这类判断题。
fn run_git_quiet(args: &[&str], cwd: &Path) -> bool {
    matches!(run(args, Some(cwd), GIT_TIMEOUT), Ok(outcome) if outcome.ok())
}

fn run(args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<proc::Outcome, String> {
    // `-c` 是 git 的**全局**选项，必须排在子命令前面，所以在这里拼 ——
    // 让每个调用方自己带的话，早晚有一条命令忘掉
    let mut all: Vec<&str> = GIT_GLOBAL_ARGS.to_vec();
    all.extend_from_slice(args);

    let owned: Vec<String> = all.iter().map(|arg| (*arg).to_string()).collect();
    let auth = GIT_AUTH.with(|slot| slot.borrow().clone());

    // 非交互那条永远带；账号凭据由 set_git_auth 决定要不要加
    let mut envs: Vec<(&str, &str)> = GIT_ENVS.to_vec();
    envs.extend(auth.iter().map(|(key, value)| (key.as_str(), value.as_str())));

    proc::run_direct("git", &owned, timeout, cwd, &envs).map_err(|err| {
        format!("启动 git 失败（请确认已安装 Git 并把它放在 PATH 里）: {err}")
    })
}

/// 失败提示：git 的话主要落在 stderr（凭据、权限、非快进…），整段带回去太长，
/// 只留最后几行 —— 真正的原因在靠后那几行，前面多是 "Cloning into..." 这类过程输出。
fn describe(command: &str, outcome: &proc::Outcome) -> String {
    let detail = if outcome.stderr.trim().is_empty() {
        outcome.stdout.trim()
    } else {
        outcome.stderr.trim()
    };

    let mut lines: Vec<&str> = detail.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    if lines.len() > 4 {
        lines = lines.split_off(lines.len() - 4);
    }
    let text = if lines.is_empty() {
        format!("退出码 {:?}", outcome.status)
    } else {
        lines.join("；")
    };

    format!("git {command} 失败: {text}")
}

/// 分片文件名与提交信息里能用的字符：只留字母数字和 `-` `_`。
/// device 是个 uuid，正常不会有别的字符；转义一遍是防着数据文件被手工改过。
fn safe_name(device: &str) -> String {
    let cleaned: String = device
        .trim()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect();

    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "unknown-device".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本地路径远端按「不分大小写、不分分隔符」比；网络地址仍归 `normalize_repo` 那条严口径管
    #[test]
    fn local_remote_paths_compare_loosely() {
        assert_eq!(
            local_path_key(r"C:\Users\me\notes.git"),
            local_path_key("c:/users/me/notes.git")
        );
        assert_eq!(
            local_path_key("C:/a/b/"),
            local_path_key(r"C:\a\b"),
            "尾斜杠该被 normalize_repo 去掉"
        );
        assert!(local_path_key("https://github.com/a/b").is_none());
        assert!(local_path_key("git@github.com:a/b.git").is_none());
        // 盘符开头才当路径：`git@host:path` 的第二字符不是冒号
        assert!(local_path_key("https://host/A/b").is_none());
    }

    /// 读一篇笔记的正文，换行统一成 LF 再比。
    ///
    /// Windows 上 git 可能开着 `autocrlf`，检出来的工作区文件是 CRLF，而应用写下去的是 LF ——
    /// 差别只在换行、不是内容（git 那边也不认为这是一个改动，所以提交历史不会被这种来回搅乱）。
    fn read_note(path: &Path) -> String {
        std::fs::read_to_string(path)
            .unwrap_or_else(|err| panic!("读 {} 失败: {err}", path.display()))
            .replace("\r\n", "\n")
    }

    #[test]
    fn safe_name_keeps_ids_and_neutralizes_path_tricks() {
        assert_eq!(safe_name("6f1c2a10-3b2c-4d5e-8f90-abc123456789"), "6f1c2a10-3b2c-4d5e-8f90-abc123456789");
        // 路径穿越 / 盘符这类手工改过的值不能变成文件名
        assert_eq!(safe_name("../../evil"), "evil");
        assert_eq!(safe_name("C:\\windows\\x"), "C--windows-x");
        assert_eq!(safe_name("   "), "unknown-device");
    }

    /// 设备名不能是空的：分片名字段与提交信息都要用它
    #[test]
    fn host_name_is_never_empty() {
        assert!(!host_name().trim().is_empty());
    }

    /// 比地址时忽略「结尾的斜杠 / .git」这类写法差异，但不同仓库必须区分得开
    #[test]
    fn normalizes_repo_urls_for_comparison() {
        assert_eq!(normalize_repo("https://github.com/a/b.git"), "https://github.com/a/b");
        assert_eq!(normalize_repo("https://github.com/a/b/"), "https://github.com/a/b");
        assert_eq!(normalize_repo("  git@github.com:a/b.git  "), "git@github.com:a/b");

        assert_ne!(normalize_repo("https://github.com/a/b"), normalize_repo("https://github.com/a/c"));
        assert_ne!(normalize_repo("https://github.com/a/b"), normalize_repo("https://gitee.com/a/b"));
        // 大小写不动：自建服务器的路径可能区分大小写，宁可比严
        assert_ne!(normalize_repo("https://host/A/b"), normalize_repo("https://host/a/b"));
    }

    /// 没有克隆目录时两个目录都读成空表，而不是报错（还没同步过的机器就是这个状态）
    #[test]
    fn reading_without_a_clone_is_empty() {
        let missing = std::env::temp_dir().join("wb-sync-does-not-exist");
        assert!(read_dir_json(&missing.join("token-usage")).unwrap().is_empty());
        assert!(read_dir_json(&missing.join("config")).unwrap().is_empty());
    }

    /// 克隆指向别的仓库时一个分片都不返回：换了地址、重新克隆还没成功的那段时间里，
    /// 工作区里留着的是**老仓库**的别人的分片，读出来就会被当成最新数据展示。
    #[test]
    fn reading_shards_of_another_repo_is_empty() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-stale-{}", uuid::Uuid::new_v4()));
        let (remote_a, remote_b) = (root.join("a.git"), root.join("b.git"));
        let clone = root.join("clone");
        std::fs::create_dir_all(&root).unwrap();
        for remote in [&remote_a, &remote_b] {
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
            assert!(init.ok());
        }

        let repo_a = remote_a.to_string_lossy().into_owned();
        let repo_b = remote_b.to_string_lossy().into_owned();
        let shard = json!({ "version": 6, "device": "dev-z", "name": "Z", "updatedAt": 1, "sources": {} });
        let theme = json!({ "device": "dev-z", "name": "Z", "theme": { "version": 2, "updatedAt": 1 } });

        // 克隆里现在装的是 A 的那两份文件
        publish_at(&clone, &repo_a, "dev-z", &shard, Some(&theme), false).unwrap();

        // 地址还是 A：读得到；换成 B：一个都不返回（老仓库的文件不能当成最新的展示出来）
        let files = read_shards_for(&clone, &repo_a).unwrap();
        assert_eq!(files.usage.len(), 1);
        assert_eq!(files.config.len(), 1);
        let other = read_shards_for(&clone, &repo_b).unwrap();
        assert!(other.usage.is_empty() && other.config.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真跑一遍 git：空远端 → 两台机器各推一份分片 → 互相读得到 → 内容没变就不产生空提交。
    ///
    /// 这是整条同步链里最容易悄悄坏掉的一段（参数顺序、分支选择、空仓库、rebase、无改动跳过提交），
    /// 坏掉之后界面上的表现是「同步成功但数据不全」，从日志里看不出来。
    /// 用本地裸仓库当远端，不碰网络、不需要任何凭据。
    #[test]
    fn syncs_two_machines_through_a_real_git_remote() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-sync-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote.git");
        let clone_a = root.join("clone-a");
        let clone_b = root.join("clone-b");
        std::fs::create_dir_all(&root).unwrap();

        // 裸仓库当远端：它不会像 GitHub 那样自动把默认分支改到我们推上去的那个分支，
        // 正好覆盖「远端 HEAD 指向一个不存在的分支」这个最容易踩的情形
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
        let shard_a = json!({
            "version": 6, "device": "dev-a", "name": "A", "updatedAt": 1,
            "sources": { "zcode": { "days": {} } }
        });
        let shard_b = json!({
            "version": 6, "device": "dev-b", "name": "B", "updatedAt": 2,
            "sources": { "zcode": { "days": {} } }
        });
        let theme_a = json!({ "device": "dev-a", "name": "A", "theme": { "version": 2, "updatedAt": 1 } });
        let theme_b = json!({ "device": "dev-b", "name": "B", "theme": { "version": 2, "updatedAt": 2 } });

        let first = publish_at(&clone_a, &repo, "dev-a", &shard_a, Some(&theme_a), false).unwrap();
        assert_eq!(first["changed"], json!(true));
        assert_eq!(first["pushed"], json!(true));

        // 第二台机器在另一端：它的克隆会落在「远端 HEAD 不存在」的状态上。
        // 分支挑错了这里就会另起一个分支，下面那句读分片就会缺一台机器。
        let second = publish_at(&clone_b, &repo, "dev-b", &shard_b, Some(&theme_b), false).unwrap();
        assert_eq!(second["changed"], json!(true));

        let read = read_shards_for(&clone_b, &repo).unwrap();
        let devices = |items: &[Value]| -> Vec<String> {
            let mut found: Vec<String> = items
                .iter()
                .filter_map(|item| item.get("device").and_then(Value::as_str).map(str::to_string))
                .collect();
            found.sort();
            found
        };
        assert_eq!(
            devices(&read.usage),
            vec!["dev-a".to_string(), "dev-b".to_string()],
            "两台机器的用量分片都要读得到"
        );
        assert_eq!(
            devices(&read.config),
            vec!["dev-a".to_string(), "dev-b".to_string()],
            "两台机器的配置也要读得到"
        );

        // 内容没变就不该产生提交：自动同步一小时一轮，否则仓库里全是空提交
        let again = publish_at(&clone_a, &repo, "dev-a", &shard_a, Some(&theme_a), false).unwrap();
        assert_eq!(again["changed"], json!(false));
        let count = run_git(&["rev-list", "--count", "HEAD"], Some(&clone_a), GIT_TIMEOUT).unwrap();
        assert_eq!(count, "2", "不该为空提交再增一条");

        // 关掉外观同步（config 给 None）：仓库里自己那份配置要被删掉，并作为一次改动提交出去
        let dropped = publish_at(&clone_a, &repo, "dev-a", &shard_a, None, false).unwrap();
        assert_eq!(dropped["changed"], json!(true), "删掉配置也是一次要提交的改动");
        assert!(!clone_a.join("config").join("dev-a.json").exists());
        let read = read_shards_for(&clone_a, &repo).unwrap();
        assert_eq!(devices(&read.config), vec!["dev-b".to_string()], "只剩另一台机器的配置");

        // 第二次给 None 就无事可做了：文件已经不在，不该每轮都提交一次「删了个不存在的东西」
        let stable = publish_at(&clone_a, &repo, "dev-a", &shard_a, None, false).unwrap();
        assert_eq!(stable["changed"], json!(false));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 设置里换了仓库地址：必须重新克隆，而不是接着用上一个仓库的克隆。
    ///
    /// 这条是踩过的坑：克隆只按目录是否存在来判断，地址换了也不管，于是 pull/push 一直打向老仓库 ——
    /// 界面上「同步成功」，实际数据全进了另一个仓库（用户换到 gitee 之后仍然在跟 github 同步）。
    /// 而且旧克隆的工作区里还留着老仓库的别人的分片，只改 origin 的话那些会被当成最新读进来。
    #[test]
    fn switching_the_repo_reclones_and_drops_the_old_shards() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-switch-{}", uuid::Uuid::new_v4()));
        let (remote_a, remote_b) = (root.join("a.git"), root.join("b.git"));
        let clone = root.join("clone");
        std::fs::create_dir_all(&root).unwrap();

        for remote in [&remote_a, &remote_b] {
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
            assert!(init.ok());
        }

        let repo_a = remote_a.to_string_lossy().into_owned();
        let repo_b = remote_b.to_string_lossy().into_owned();
        let shard = |device: &str| {
            json!({ "version": 6, "device": device, "name": device, "updatedAt": 1, "sources": {} })
        };

        // 先在 A 上同步，并让另一台机器（dev-z）的文件也进了这个克隆
        publish_at(&clone, &repo_a, "dev-z", &shard("dev-z"), None, false).unwrap();
        assert_eq!(read_shards_for(&clone, &repo_a).unwrap().usage.len(), 1);

        // 换到 B
        publish_at(&clone, &repo_b, "dev-a", &shard("dev-a"), None, false).unwrap();

        let read = read_shards_for(&clone, &repo_b).unwrap();
        let found: Vec<String> = read
            .usage
            .iter()
            .filter_map(|item| item.get("device").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(found, vec!["dev-a".to_string()], "换了仓库之后不能再看到老仓库的文件");
        assert!(read.config.is_empty(), "配置目录同样只剩这个仓库里的东西");

        // 提交要落在 B 上：换成用 --all 数（裸仓库的 HEAD 默认指向 refs/heads/master，
        // 而我们推的是 main，`rev-list HEAD` 会直接解析不出来）
        let count_b = run_git(&["rev-list", "--count", "--all"], Some(&remote_b), GIT_TIMEOUT).unwrap();
        let count_a = run_git(&["rev-list", "--count", "--all"], Some(&remote_a), GIT_TIMEOUT).unwrap();
        assert_eq!(count_b, "1", "B 上应当只有我的分片那一条");
        assert_eq!(count_a, "1", "A 上不该再多出提交（多出来就说明还在往老仓库推）");

        let _ = std::fs::remove_dir_all(&root);
    }

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

    /// 图片现在按「设备 / 笔记本」分了两层（见 shared/note-image.ts 的 imageScopeDir），
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
            false,
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
            false,
        )
        .unwrap();
        assert_eq!(second["changed"], json!(false));
        let count = run_git(&["rev-list", "--count", "--all"], Some(&remote), GIT_TIMEOUT).unwrap();
        assert_eq!(count, "1", "内容没变时不该多出提交");

        // 没填仓库地址时给一句能看懂的话，而不是去 git 那里报一堆参数错误
        assert!(publish_image_at(&clone, "  ", "images", "a.png", &bytes, false).is_err());

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
        // 传下来的目录是「图片目录 / 设备 / 笔记本」三层（见 shared/note-image.ts 的 imageScopeDir）
        let scope = "images/6f1e2d3c-4b5a/notes-2f3a9c02";
        // 同一个仓库、同一个设备下的**另一个笔记本**：它的图不该出现在这一次的清单里，
        // 也不该被这一次的删除够到 —— 这正是那两层目录存在的意义
        let elsewhere = "images/6f1e2d3c-4b5a/别的-0b1c2d3e";
        let other = "20260916-104511-00000000.png";

        publish_image_at(&clone, &repo, scope, drop, &bytes, false).unwrap();
        publish_image_at(&clone, &repo, scope, keep, &bytes, false).unwrap();
        publish_image_at(&clone, &repo, elsewhere, other, &bytes, false).unwrap();

        // 列出来的就是这一层里那两张（含大小）
        let listed = list_images_at(&clone, &repo, scope, false).unwrap();
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
            let rejected = delete_images_at(&clone, &repo, scope, &[bad.clone()], false);
            assert!(rejected.is_err(), "这条路径本该被拒掉: {bad}");
        }

        // 删一张；另一条路径不存在，跳过而不是让整批失败
        let missing = format!("{scope}/20260916-104515-missing.png");
        let removed = delete_images_at(
            &clone,
            &repo,
            scope,
            &[format!("{scope}/{drop}"), missing.clone()],
            false,
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
        let gone = delete_images_at(&clone, &repo, scope, &[format!("{scope}/{drop}")], false).unwrap();
        assert_eq!(gone["deleted"], json!(0));
        assert_eq!(gone["changed"], json!(false));
        let count = run_git(&["rev-list", "--count", "--all"], Some(&remote), GIT_TIMEOUT).unwrap();
        assert_eq!(count, "4", "三张图各一条提交 + 删图一条，不该多出空提交");

        // 一张都没选 / 没配仓库：各给一句能看懂的话
        assert!(delete_images_at(&clone, &repo, scope, &[], false).is_err());
        assert!(list_images_at(&clone, "  ", scope, false).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 笔记同步：真跑一遍 git —— 两台「机器」各自一个文件夹，通过一个裸仓库来回同步。
    ///
    /// 钉住五件事：首次同步就地 init 并把地址接上、本机改动提交后推得出去、另一台空文件夹
    /// 拉得到、**撞上冲突时中止 rebase 而不是替用户挑一边**（本地那笔提交与工作区都要保住）、
    /// 以及文件夹连着别的仓库时只报错、不动它的 origin。
    #[test]
    fn syncs_notes_between_two_machines() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-notes-sync-{}", uuid::Uuid::new_v4()));
        let remote = root.join("notes.git");
        let (a, b) = (root.join("machine-a"), root.join("machine-b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

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
        let a_path = a.to_str().unwrap();
        let b_path = b.to_str().unwrap();

        // A：笔记本里先有一篇，第一次同步应该就地 init、提交、推上去
        std::fs::write(a.join("周报.md"), "本周：写同步\n").unwrap();
        let first = sync_notes(&repo, a_path, false).unwrap();
        assert_eq!(first["files"], json!(1), "本机那一篇该被提交: {first:?}");
        assert_eq!(first["received"], json!(false), "远端本来是空的: {first:?}");
        assert!(a.join(".git").exists(), "首次同步该把文件夹变成仓库");

        // B：一个**还没 init** 的文件夹 + 远端已经有 main —— 跟着远端那个分支走，把笔记落下来
        let second = sync_notes(&repo, b_path, false).unwrap();
        assert_eq!(second["received"], json!(true), "第一次同步该说「拉回来了」: {second:?}");
        assert_eq!(second["files"], json!(0), "B 自己没有改动: {second:?}");
        assert_eq!(second["branch"], json!("main"));
        assert_eq!(read_note(&b.join("周报.md")), "本周：写同步\n");

        // B 写一篇新的推上去 → A 拉得到（不只是「能推」，是两边真的走得通）
        std::fs::write(b.join("随手记.md"), "B 写的\n").unwrap();
        sync_notes(&repo, b_path, false).unwrap();
        let third = sync_notes(&repo, a_path, false).unwrap();
        assert_eq!(third["received"], json!(true), "A 该拿到 B 那一篇: {third:?}");
        assert!(a.join("随手记.md").is_file());

        // 同一个仓库换个写法（Windows 上 `C:/a/b` 与 `C:\a\b` 是同一处）：得认出来是同一个，
        // 不能报「已经连着另一个仓库」—— 用户完全可能把地址换个写法填进来（踩过）
        let slashed = repo.replace('\\', "/");
        let rewritten = sync_notes(&slashed, a_path, false).unwrap();
        assert_eq!(rewritten["files"], json!(0), "换个写法还是同一个仓库: {rewritten:?}");

        // 两边改同一篇 → 后同步的那台：如实报错、rebase 中止、本地提交与工作区都还在
        std::fs::write(a.join("周报.md"), "A 改的\n").unwrap();
        std::fs::write(b.join("周报.md"), "B 改的\n").unwrap();
        sync_notes(&repo, a_path, false).unwrap();

        let conflict = sync_notes(&repo, b_path, false).unwrap_err();
        assert!(
            conflict.contains("周报.md"),
            "冲突提示里要点出是哪一篇: {conflict}"
        );
        assert!(
            !in_rebase(&b),
            "报错之后不该把文件夹留在 rebase 中途: {conflict}"
        );
        assert_eq!(
            read_note(&b.join("周报.md")),
            "B 改的\n",
            "本地那一份不能被远端盖掉"
        );
        let local = run_git(&["rev-list", "--count", "HEAD"], Some(&b), GIT_TIMEOUT).unwrap();
        assert_eq!(
            local, "3",
            "B 这边的三笔（A 那一篇 + B 的随手记 + 这次的改动）都要留着"
        );
        // 再同步一次：不会说「有一次没做完的 rebase」，还是同一句冲突提示（说明现场是干净的）
        let again = sync_notes(&repo, b_path, false).unwrap_err();
        assert!(again.contains("周报.md"), "{again}");

        // 连着别的仓库的文件夹：只报错，origin 一个字都不改
        let other = root.join("machine-c");
        std::fs::create_dir_all(&other).unwrap();
        run_git(&["init", "--quiet"], Some(&other), GIT_TIMEOUT).unwrap();
        run_git(
            &["remote", "add", "origin", "https://example.com/other.git"],
            Some(&other),
            GIT_TIMEOUT,
        )
        .unwrap();
        let mismatch = sync_notes(&repo, other.to_str().unwrap(), false).unwrap_err();
        assert!(mismatch.contains("另一个仓库"), "{mismatch}");
        let kept = run_git(&["remote", "get-url", "origin"], Some(&other), GIT_TIMEOUT).unwrap();
        assert_eq!(kept, "https://example.com/other.git");

        // 没配地址 / 文件夹不在：各给一句能看懂的话
        assert!(sync_notes("  ", a_path, false).is_err());
        assert!(sync_notes(&repo, root.join("没有这个目录").to_str().unwrap(), false).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
