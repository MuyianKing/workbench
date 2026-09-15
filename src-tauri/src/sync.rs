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

use crate::oauth;
use crate::paths;
use crate::proc;

/// 单次 git 操作的超时。push / pull 要走网络，给足时间；到点还没回就当失败 ——
/// 界面上「同步失败 + 原因」比一直转圈有用得多。
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// 首次克隆可能要拉完整的仓库历史，宽一些
const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// git 非交互：没有终端可问的时候让它立刻报错，而不是弹一个我们看不见的输入框然后挂到超时。
/// 只关掉**终端**提示，不动 Credential Manager —— 首次同步让它自己弹出登录窗口是合理的，
/// 用户看得见那个窗口，也知道自己在授权什么。
const GIT_ENVS: [(&str, &str); 1] = [("GIT_TERMINAL_PROMPT", "0")];

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
    let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
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
}
