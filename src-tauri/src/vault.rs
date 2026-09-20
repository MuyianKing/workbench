//! 密码保险库的宿主侧：本机那份文件、本机密钥、以及同步仓库里那份的读与写。
//!
//! **这里没有任何密码学**。加解密全在渲染层做（WebView2 自带 WebCrypto，
//! 而 Rust 侧引 `rsa` / `p256` / `aes-gcm` 任何一套都会往编译图里加进成片的编译单元，
//! 见 AGENTS.md 第 1 节的依赖判据），本模块只做三件事：
//!
//!   1. 把渲染层算好的那份 JSON 落盘（`data/vault.json`，走 `store.rs` 那套去抖存储）；
//!   2. 把**本机密钥**存进 / 取回 Windows 凭据管理器（复用 `credentials.rs`，DPAPI 按当前用户加密）——
//!      密钥串因此过一次 IPC，这是全项目唯一一处机密进渲染层的地方，
//!      理由是解密后的正文本来就要在那儿显示，而 Rust 侧没有能做这件事的工具；
//!   3. 同步仓库里 `vault/vault.json` 的读与写（复用 `sync.rs` 的 git 管道）。
//!
//! **与仓库里其余几个目录最大的不同：这份文件是所有机器共写的**。
//! `token-usage/<设备id>.json` 那套「一台机器一个文件、每个文件一个写者、所以不需要人工合并」
//! 在这里不成立，于是**合并规则必须自己定死**，且必须能在没有密钥的情况下算出来 ——
//! 规则在 `src/shared/vault.ts` 的 `mergeVaultItems` 里（纯函数、带单测），
//! 这一侧的职责只是「别让 git 也去合一遍」：同一个文件的两种改法交给 git 只会留下一堆冲突标记，
//! 而这份数据本来就有确定的合并结果。做法是写入前先核对远端还是不是合并时的那个基准，
//! 变过就不写、把远端那份交回去让渲染层重新合（见 `push`）。

use serde_json::{json, Value};
use std::path::Path;
use std::sync::OnceLock;

use crate::credentials;
use crate::paths;
use crate::store::JsonStore;
use crate::sync;

/// 凭据管理器里的那条记录：`Workbench/vault/key`
const KEY_PROVIDER: &str = "vault";
/// 密钥串的长度上限。一条 EC P-256 的 JWK 约 300 字符，留足余量只为挡住手改出来的离谱内容
const KEY_MAX_LEN: usize = 4096;

/// 本机那份保险库（密文）。与其余几份数据文件同一套落盘机制：300ms 去抖 + 临时文件 rename，
/// 退出前由 `commands::flush_all` 补一次同步落盘。
static VAULT: OnceLock<JsonStore> = OnceLock::new();

pub fn vault_store() -> &'static JsonStore {
    VAULT.get_or_init(|| JsonStore::new(paths::vault_file, "保存密码保险库"))
}

/// 仓库里那份保险库的相对路径。**不给用户配**：所有机器得落在同一个路径上才看得见彼此的改动，
/// 这与技能目录（`skillSyncDir`，跟着配置走）是同一条口径，只是这里连一个可配的余地都不需要。
fn relative_path() -> String {
    format!("{}/{}", paths::VAULT_DIR, paths::VAULT_FILE)
}

// ---------- 本机那份 ----------

#[tauri::command]
pub fn vault_load() -> Value {
    vault_store().get()
}

#[tauri::command]
pub fn vault_save(value: Value) {
    vault_store().set(value);
    vault_store().schedule();
}

// ---------- 本机密钥 ----------

/// 读本机密钥。没建过保险库（或用户在凭据管理器里手工删了那条记录）时返回 null，不算错误。
#[tauri::command(async)]
pub fn vault_key_read() -> Option<String> {
    credentials::read(KEY_PROVIDER)
}

/// 存 / 覆盖本机密钥。空串一律拒掉：凭据管理器里存一条空的，之后只会得到「有密钥但解不开」。
#[tauri::command(async)]
pub fn vault_key_write(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("密钥是空的".into());
    }
    if trimmed.len() > KEY_MAX_LEN {
        return Err("密钥内容不像是一把保险库密钥".into());
    }
    credentials::store(KEY_PROVIDER, trimmed)
}

/// 忘掉本机密钥。**不动仓库里那份数据** —— 密钥没了，那份文件谁也解不开，
/// 所以界面上这个动作必须先问一遍（换密钥等于把现有条目全作废）。
#[tauri::command(async)]
pub fn vault_key_clear() -> Result<(), String> {
    credentials::remove(KEY_PROVIDER)
}

/// 把密钥导出成一个文件（用户自己挑路径，再自己搬到另一台机器）。
///
/// 走文件而不是「显示一串让人手抄」：那把私钥是三百来个字符的 base64，
/// 抄错一个字符的后果是另一台机器上一条都解不开，而且看不出错在哪。
#[tauri::command(async)]
pub fn vault_key_export(path: String, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("没有可导出的密钥".into());
    }
    write_text(Path::new(&path), key.trim())
}

/// 读回一个导出的密钥文件。**只读不管内容对不对** —— 认不认得出那是一把密钥由渲染层判
/// （`parseKeyString`），这样「文件里放的是别的东西」能得出一句人话，而不是这里的一句「格式错误」。
#[tauri::command(async)]
pub fn vault_key_import(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|err| format!("读取密钥文件失败: {err}"))
}

// ---------- 同步仓库里那份 ----------

/// 拉：把远端那份读回来（仓库里还没有 / 远端分支还不存在时是 null）。
///
/// 内容按**原始 JSON 值**回传，不做任何解析上的挑剔：判断「这是不是一份保险库」
/// 是渲染层的 `parseVaultFile` 的事，那边能把「路径上放着一份别的东西」和「文件不存在」分开说清楚。
#[tauri::command(async)]
pub fn vault_pull(repo: String) -> Result<Option<Value>, String> {
    pull_at(&paths::token_sync_dir(), &repo)
}

/// 推：把渲染层合出来的那份写进仓库并推上去。
///
/// `base` 是这次合并所依据的**远端那份**（首次推送时是 null）。写入之前再核一次远端还是不是它 ——
/// 不是就说明这中间有另一台机器推过了，于是**一个字都不写**，把远端现在的样子交回去
/// （返回 `pushed: false`），由渲染层重新合一次再来。这样两边永远不需要人工挑边，
/// 也绝不让 git 去做同一个文件的 rebase。
#[tauri::command(async)]
pub fn vault_push(repo: String, content: Value, base: Option<Value>) -> Result<Value, String> {
    push_at(&paths::token_sync_dir(), &repo, &content, base.as_ref())
}

// ---------- 内部 ----------

/// 与 `vault_pull` 同一条路，克隆目录由调用方给（单测用临时目录跑真实的 git 流程）。
fn pull_at(clone: &Path, repo: &str) -> Result<Option<Value>, String> {
    let repo = checked_repo(repo)?;
    sync::set_git_auth();
    drop_stale_rebase(clone);
    let (dir, branch) = sync::ensure_clone(clone, &repo)?;

    match read_remote(&dir, &branch)? {
        Some(text) => serde_json::from_str::<Value>(&text)
            .map(Some)
            .map_err(|err| format!("仓库里那份 vault.json 不是合法的 JSON: {err}")),
        None => Ok(None),
    }
}

/// 与 `vault_push` 同一条路，克隆目录由调用方给（单测用临时目录跑真实的 git 流程）。
fn push_at(clone: &Path, repo: &str, content: &Value, base: Option<&Value>) -> Result<Value, String> {
    let repo = checked_repo(repo)?;
    sync::set_git_auth();
    drop_stale_rebase(clone);
    let (dir, branch) = sync::ensure_clone(clone, &repo)?;

    let current = match read_remote(&dir, &branch)? {
        Some(text) => Some(
            serde_json::from_str::<Value>(&text)
                .map_err(|err| format!("仓库里那份 vault.json 不是合法的 JSON: {err}"))?,
        ),
        None => None,
    };

    if let Some(base) = base {
        if current.as_ref() != Some(base) {
            return Ok(json!({ "pushed": false, "remote": current }));
        }
    }

    let path = relative_path();
    write_text(&dir.join(&path), &serde_json::to_string_pretty(content).map_err(|err| err.to_string())?)?;
    sync::run_git(&["add", "-A", "--", &path], Some(&dir), sync::GIT_TIMEOUT)?;

    // 内容没变就不提交（这个文件每次同步都会被整份重写一遍，不拦的话仓库里会堆一串空提交）
    let changed = !sync::run_git_quiet(&["diff", "--cached", "--quiet", "--", &path], &dir);
    if changed {
        let message = commit_message();
        sync::run_git(&["commit", "-m", &message], Some(&dir), sync::GIT_TIMEOUT)?;
    }

    // 即使这轮没提交也推一次：上一轮可能提交成功而推送失败，那一笔还压在本地等着出去
    if let Err(err) = sync::run_git(
        &["push", "--set-upstream", "origin", &branch],
        Some(&dir),
        sync::GIT_TIMEOUT,
    ) {
        // 远端在这几秒里被另一台机器推过（`base` 那道闸拦不到这么窄的窗口）。
        // **不做 rebase** —— 这是同一个文件的两种改法，rebase 只会留下冲突标记让用户去挑边。
        // 把刚落下的那笔提交退回未提交状态（`--mixed`，工作区不动），免得它成为
        // 下一次 `ensure_clone` 里 pull --rebase 的源头：那才是最糟的一种卡死 ——
        // 每次同步都在同一个文件上撞一次冲突，克隆就此废掉，而用户看不出该怎么办。
        // 在这里做这一步是安全的：这个克隆是应用自己的缓存（见 paths.rs），
        // 里面每个文件的内容都由本机数据现算，没有任何只存在于这里的东西。
        let _ = sync::run_git(&["reset", "--mixed", &format!("origin/{branch}")], Some(&dir), sync::GIT_TIMEOUT);
        return Ok(json!({ "pushed": false, "remote": current, "reason": err }));
    }

    Ok(json!({ "pushed": true, "remote": content }))
}

fn checked_repo(repo: &str) -> Result<String, String> {
    let trimmed = repo.trim().to_string();
    if trimmed.is_empty() {
        return Err("还没有填同步仓库地址".into());
    }
    Ok(trimmed)
}

/// 提交信息带上本机设备名，一眼看得出这次改动是哪台机器做的
fn commit_message() -> String {
    let name = sync::device_info()
        .ok()
        .and_then(|value| value.get("name").and_then(|name| name.as_str()).map(str::to_string))
        .unwrap_or_default();

    if name.is_empty() {
        "vault: 同步".to_string()
    } else {
        format!("vault: {name}")
    }
}

/// 从**远端那个 ref** 上读那份文件，而不是工作区里那份。
///
/// 工作区可能压着上一次没推上去的一笔提交（推送失败时会退回去，但退之前的瞬间是这样），
/// 照着它读会让「远端变了没有」判断错。路径不存在就是「仓库里还没有这份文件」，
/// 不是错误 —— 先拿 `cat-file -e` 问一句存在性，免得把 git 那句
/// `path 'vault/vault.json' does not exist in 'origin/main'` 当成失败报给用户。
fn read_remote(dir: &Path, branch: &str) -> Result<Option<String>, String> {
    let spec = format!("origin/{branch}:{}", relative_path());
    if !sync::run_git_quiet(&["cat-file", "-e", &spec], dir) {
        return Ok(None);
    }

    let outcome = sync::run(&["show", &spec], Some(dir), sync::GIT_TIMEOUT)?;
    if !outcome.ok() {
        return Err(sync::describe("show", &outcome));
    }
    // 这里**不能 trim**（所以没走 run_git）：JSON 本身无所谓，但保持一条口径 ——
    // 凡是从 git 里取文件内容的地方都按原始字节收，见 constraints/sync-and-auth.md 里那条
    Ok(Some(outcome.stdout))
}

/// 克隆里如果还留着半截 rebase，先中止掉。
///
/// 会留下它的只有本应用自己（用量 / 外观那两条同步的 pull --rebase 失败时），
/// 而那两个文件的内容都能从本机数据重新算出来，退回去不会丢任何只存在于那里面的东西；
/// 不退的话，整个克隆会一直卡在 rebase 中途，之后每一次同步（包括保险库这条）都直接失败。
fn drop_stale_rebase(clone: &Path) {
    if clone.join(".git").is_dir() && sync::in_rebase(clone) {
        let _ = sync::run_git(&["rebase", "--abort"], Some(clone), sync::GIT_TIMEOUT);
    }
}

/// 先写临时文件再改名：读到半个 JSON 的可能是 git 自己，也可能是同步目录上的杀毒软件
fn write_text(file: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|err| format!("写入失败: {err}"))?;
    std::fs::rename(&tmp, file).map_err(|err| format!("替换文件失败: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc;
    use std::path::PathBuf;

    /// 仓库里那个路径是固定的：所有机器得落在同一个位置上才看得见彼此的改动
    #[test]
    fn the_repo_path_is_fixed() {
        assert_eq!(relative_path(), "vault/vault.json");
    }

    /// 没填地址时给一句人话，而不是拿去起一个注定失败的 git
    #[test]
    fn an_empty_repo_is_rejected_with_a_readable_reason() {
        assert!(checked_repo("").is_err());
        assert!(checked_repo("   ").is_err());
        assert_eq!(checked_repo("  git@github.com:me/sync.git ").unwrap(), "git@github.com:me/sync.git");
    }

    /// 写文件走临时文件 + 改名：写完那份必须能原样读回来，临时文件不留痕
    #[test]
    fn writing_is_atomic_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("wb-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("vault.json");

        write_text(&file, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}");

        // 覆盖写：旧内容不残留
        write_text(&file, "{\"b\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"b\":2}");
        assert!(!dir.join("vault.json.tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 密钥文件的读写：导出的是纯文本，读回来逐字一样
    #[test]
    fn a_key_file_round_trips() {
        let dir = std::env::temp_dir().join(format!("wb-vault-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("vault-key.txt");
        let path = file.to_string_lossy().into_owned();

        vault_key_export(path.clone(), "  workbench-vault-v1.abc  ".into()).unwrap();
        assert_eq!(vault_key_import(path).unwrap(), "workbench-vault-v1.abc");

        // 空的导出直接拒掉：一个空文件搬到另一台机器上只会得到「密钥无效」
        assert!(vault_key_export(file.to_string_lossy().into_owned(), "   ".into()).is_err());

        // 读一个不存在的文件要给出原因，而不是空串
        assert!(vault_key_import(dir.join("nope.txt").to_string_lossy().into_owned()).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- 真仓库上的同步流程 ----------
    //
    // 这几条是这一块最值得测的地方：那份文件是**所有机器共写**的，而「谁先推谁后推」
    // 决定了仓库里最终是什么样。下面的用例都用真的 git 与一个裸仓库当远端跑一遍。

    /// 一份最小的保险库文件。真实内容由渲染层合出来，这里只关心信封的那几个字段。
    fn file_of(items: Value) -> Value {
        json!({
            "version": 1,
            "key": { "kty": "EC", "crv": "P-256", "x": "xx", "y": "yy" },
            "items": items
        })
    }

    fn item(id: &str, updated_at: u64, by: &str) -> Value {
        json!({ "id": id, "updatedAt": updated_at, "by": by, "pub": "p", "iv": "i", "ct": "c" })
    }

    /// 建一个裸仓库当远端（它不会像托管平台那样自动改默认分支，正好覆盖最容易踩的那种状态）
    fn bare_remote(root: &Path) -> String {
        let remote = root.join("remote.git");
        let init = proc::run_direct(
            "git",
            &[
                "init".to_string(),
                "--bare".to_string(),
                remote.to_string_lossy().into_owned(),
            ],
            sync::GIT_TIMEOUT,
            None,
            &[("GIT_TERMINAL_PROMPT", "0")],
        )
        .unwrap();
        assert!(init.ok(), "git init --bare 失败: {}", init.stderr);
        remote.to_string_lossy().into_owned()
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("wb-vault-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// 两台机器共写一份文件：各自都能推、都能读到对方推上去的内容
    #[test]
    fn two_machines_share_one_file_through_a_real_git_remote() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = temp_root();
        let repo = bare_remote(&root);
        let clone_a = root.join("clone-a");
        let clone_b = root.join("clone-b");

        // 远端还什么都没有：pull 要说「没有」，而不是报错
        assert!(pull_at(&clone_a, &repo).unwrap().is_none(), "空仓库里不该读到东西");

        // A 推第一条
        let a_file = file_of(json!([item("aaa", 100, "dev-a")]));
        let pushed = push_at(&clone_a, &repo, &a_file, None).unwrap();
        assert_eq!(pushed["pushed"], json!(true));

        // B 是另一台机器：它的克隆会落在「远端 HEAD 不存在」那种状态上，分支挑错了这里就读不到
        let seen = pull_at(&clone_b, &repo).unwrap().expect("B 应当读到 A 推上去的那份");
        assert_eq!(seen["items"].as_array().unwrap().len(), 1);
        assert_eq!(seen["items"][0]["id"], json!("aaa"));

        // B 把 A 的那条与自己新加的一条合在一起推上去（合并规则在 TS 侧，这里模拟它的输出）
        let b_file = file_of(json!([item("aaa", 100, "dev-a"), item("bbb", 200, "dev-b")]));
        let pushed = push_at(&clone_b, &repo, &b_file, Some(&seen)).unwrap();
        assert_eq!(pushed["pushed"], json!(true));

        // A 再拉一次：两条都在
        let back = pull_at(&clone_a, &repo).unwrap().unwrap();
        assert_eq!(back["items"].as_array().unwrap().len(), 2);
    }

    /// 关键的那条：另一台机器在中间推过时，这一轮**一个字都不写**，把远端交回去重合。
    ///
    /// 这是「不让 git 去合同一个文件」的全部依据 —— 少了它，两边就会各自 rebase 出一个
    /// 冲突现场让用户手工挑边，而这份数据本来就有确定的合并结果。
    #[test]
    fn a_stale_base_is_refused_instead_of_overwritten() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = temp_root();
        let repo = bare_remote(&root);
        let clone_a = root.join("clone-a");
        let clone_b = root.join("clone-b");

        // 起点：两台机器都读到同一份
        let base = file_of(json!([item("aaa", 100, "dev-a")]));
        push_at(&clone_a, &repo, &base, None).unwrap();
        let seen_b = pull_at(&clone_b, &repo).unwrap().unwrap();

        // A 先推了新的一条
        let a_new = file_of(json!([item("aaa", 100, "dev-a"), item("ccc", 300, "dev-a")]));
        push_at(&clone_a, &repo, &a_new, Some(&base)).unwrap();

        // B 还拿着旧的 base：它这一推必须被挡下来，并拿到 A 刚推的那份
        let b_new = file_of(json!([item("aaa", 100, "dev-a"), item("bbb", 200, "dev-b")]));
        let refused = push_at(&clone_b, &repo, &b_new, Some(&seen_b)).unwrap();
        assert_eq!(refused["pushed"], json!(false), "远端变过就不该写下去");
        assert_eq!(
            refused["remote"]["items"].as_array().unwrap().len(),
            2,
            "要把远端现在那份交回去"
        );

        // 仓库里仍是 A 推的那份：B 那一条没有被写进去
        let now = pull_at(&clone_a, &repo).unwrap().unwrap();
        assert!(
            now["items"].as_array().unwrap().iter().all(|entry| entry["id"] != json!("bbb")),
            "被挡下的那次不该在仓库里留下任何痕迹"
        );

        // B 拿新基准重走一遍就成了：合并规则在 TS 侧，这里模拟它的输出
        let merged = file_of(json!([
            item("aaa", 100, "dev-a"),
            item("bbb", 200, "dev-b"),
            item("ccc", 300, "dev-a")
        ]));
        let pushed = push_at(&clone_b, &repo, &merged, Some(&refused["remote"])).unwrap();
        assert_eq!(pushed["pushed"], json!(true));

        // 三条都在，两台机器此后读到的是同一份
        for clone in [&clone_a, &clone_b] {
            let seen = pull_at(clone, &repo).unwrap().unwrap();
            assert_eq!(seen["items"].as_array().unwrap().len(), 3);
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 内容没变时不产生新提交：两台机器各推一次完全相同的内容，仓库里只该有一笔
    #[test]
    fn pushing_identical_content_does_not_add_a_commit() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = temp_root();
        let repo = bare_remote(&root);
        let clone_a = root.join("clone-a");
        let clone_b = root.join("clone-b");

        let content = file_of(json!([item("aaa", 100, "dev-a")]));
        push_at(&clone_a, &repo, &content, None).unwrap();
        let seen_b = pull_at(&clone_b, &repo).unwrap().unwrap();
        push_at(&clone_b, &repo, &content, Some(&seen_b)).unwrap();

        // 数提交：`rev-list --count HEAD` 在克隆里跑
        let count = sync::run_git(
            &["rev-list", "--count", "HEAD"],
            Some(&clone_b),
            sync::GIT_TIMEOUT,
        )
        .unwrap();
        assert_eq!(count.trim(), "1", "同样的内容推第二次不该再产生一笔提交");

        let _ = std::fs::remove_dir_all(&root);
    }
}
