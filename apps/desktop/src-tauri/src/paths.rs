//! 路径解析：数据目录与各数据文件名。
//!
//! 关键约定：**安装版**的数据文件固定放在 `%APPDATA%\Workbench\data`；
//! **开发版**（`pnpm dev` / `cargo build` 不带 `custom-protocol`）落在 `%APPDATA%\Workbench-dev\data`。
//! 两边不共用：开发时改的设置（截图开关、全局快捷键、项目列表……）不会盖掉装着的那份，
//! 两个进程同时开着也不会互相覆盖同一份数据文件（判据同 main.rs 的单实例与 commands.rs 的开机自启：
//! 编译期 `dev` cfg）。
//!
//! 安装版的根目录 `%APPDATA%\Workbench` 是迁到 Tauri 之前的 Electron 版留下的 Chromium 配置目录
//! （`Cache` / `GPUCache` / `DIPS` / `Preferences` 那一堆），数据文件收在 `data` 子目录里，两边不混。
//! 不能图省事用 Tauri 的 `app_config_dir()` —— 它按 identifier 生成
//! `%APPDATA%\com.muyian.workbench`，换了位置用户就等于「丢了」项目列表。

use std::path::{Path, PathBuf};

pub const DATA_FILE: &str = "workbench-data.json";
/// Token 用量快照（改名前的 `token-data.json`，启动时由 `migrate_legacy_files` 搬过来）
pub const TOKEN_USAGE_FILE: &str = "token-usage.json";
/// 主题文件：外观设置 + 首页布局（见 packages/appearance/src/theme.ts）
pub const THEME_FILE: &str = "theme.json";
/// 工作日志（见 packages/work-log/src/work-log.ts）。**只在本机**：不进同步仓库、也不进任何云端
pub const WORK_LOG_FILE: &str = "work-log.json";
/// AI 热点缓存（见 packages/ai/src/ai-news.ts）。与工作日志同一待遇：只在本机、不进同步仓库
pub const AI_NEWS_FILE: &str = "ai-news.json";
/// ETF 资金流缓存（见 packages/etf/src/etf.ts）：份额 / 净值 / 指数的本地回填，
/// 只在本机、不进同步仓库
pub const ETF_FILE: &str = "etf.json";
/// 密码保险库（见 packages/vault/src/vault.ts）。**文件本身只有密文**：明文从不落盘，
/// 本机这把密钥在 Windows 凭据管理器里（见 vault.rs），仓库里那份在 `vault/vault.json`
pub const VAULT_FILE: &str = "vault.json";
/// 邮件后台监视的进度（见 mail_watch.rs）：每个账户的 UIDVALIDITY 与上次见过的
/// 最大 UID，外加上一轮检查的时间。只是通知用的记账，**不进同步仓库**
pub const MAIL_WATCH_FILE: &str = "mail-watch.json";
/// 钉图的记账文件（见 pin.rs）：哪些图还钉在屏幕上、各自在哪儿、多大、多透明。
/// 与工作日志同一待遇：只对本机成立（位置是这块屏的坐标），不进同步仓库
pub const PINS_FILE: &str = "pins.json";
/// 悬浮球的记账文件（见 ball.rs）：贴在哪一侧、纵向在哪儿。
/// 与钉图同一待遇：只对本机成立，不进同步仓库
pub const BALL_FILE: &str = "ball.json";
/// 崩溃日志（见 panic_log.rs）：release 档 panic 直接中止进程，那一下的证据只留在这里
const PANIC_LOG_FILE: &str = "panic.log";
/// 钉图的图片目录名：一张钉图一个 PNG，钉图关掉时连文件一起删
const PINS_DIR: &str = "pins";
/// 克隆里放**保险库**的子目录名。与用量 / 配置那两个目录最大的不同：那份文件是所有机器**共写**的
/// （用户的要求：所有设备公用一个文件），所以合并规则必须自己定死，见 packages/vault/src/vault.ts
pub(crate) const VAULT_DIR: &str = "vault";
/// 数据目录名：数据文件都收在它下面（见文件头的约定）
const DATA_SUBDIR: &str = "data";
/// 改名前的用量快照文件名，只在一次性搬家时用得上
const LEGACY_TOKEN_DATA_FILE: &str = "token-data.json";
/// 改名前的笔记文件名（旧版那棵 JSON 树）。应用早就不再读写它，搬家时顺手跟着挪个位置
const LEGACY_NOTE_DATA_FILE: &str = "note-data.json";
/// 本机设备标识（Token 同步用）
const DEVICE_FILE: &str = "device.json";
/// Token 同步仓库的本地克隆目录名
const TOKEN_SYNC_DIR: &str = "token-sync";
/// 图片仓库的本地克隆目录名（笔记里粘贴的图片推上去，见 sync.rs 的 publish_image）
const IMAGE_SYNC_DIR: &str = "image-sync";
/// 克隆里放**用量分片**的子目录名：一台机器一个文件
pub(crate) const TOKEN_USAGE_DIR: &str = "token-usage";
/// 克隆里放**配置**的子目录名：一台机器一份 theme.json 的副本（见 packages/usage/src/sync-config.ts）
pub(crate) const CONFIG_DIR: &str = "config";
/// 克隆里放**网关请求流水**的子目录名：一台机器一个子目录、每月一个 `.jsonl`
pub(crate) const GATEWAY_USAGE_DIR: &str = "gateway-usage";
/// 网关（WorkBuddy 反代）的目录名。它自带一层完整结构：账号、用量、日志都在里面，
/// 不跟工作台自己的数据文件混在一起 —— 那是一整套独立的运行时状态
const GATEWAY_DIR: &str = "wb-gateway";
pub const GATEWAY_SETTINGS_FILE: &str = "settings.json";
pub const GATEWAY_ACCOUNTS_DIR: &str = "accounts";
pub const GATEWAY_USAGE_FILE: &str = "usage.jsonl";
pub const GATEWAY_MODELS_FILE: &str = "models.json";
/// 签到 / 每日活跃的尝试记录（一行一次真实尝试，见 `wb_tasks::record_activity`）
pub const GATEWAY_ACTIVITY_FILE: &str = "activity.jsonl";

/// 老版本直接写在用户数据根目录下的那批文件：搬家清单（见 `relocate_root_files_in`）
const ROOT_FILES: &[&str] = &[
    DATA_FILE,
    THEME_FILE,
    TOKEN_USAGE_FILE,
    WORK_LOG_FILE,
    AI_NEWS_FILE,
    DEVICE_FILE,
    LEGACY_TOKEN_DATA_FILE,
    LEGACY_NOTE_DATA_FILE,
];

/// 用户数据根目录名。开发版单独一个根：与安装版共用会让两边的设置互相盖掉
/// （最典型的是截图开关与全局快捷键：一边关掉，另一边也跟着关）。
///
/// 抽成 const fn 是为了让单测能同时断言两个环境的取值；生产代码只用下面那个常量。
const fn app_dir_name(dev: bool) -> &'static str {
    if dev { "Workbench-dev" } else { "Workbench" }
}

const APP_DIR: &str = app_dir_name(cfg!(dev));

/// 用户数据根目录，等价于 Electron 的 `getAppData`。
pub fn user_data_dir() -> PathBuf {
    match std::env::var_os("APPDATA") {
        Some(base) => PathBuf::from(base).join(APP_DIR),
        // 理论上 Windows 上 APPDATA 一定有；兜底到临时目录，至少不 panic
        None => std::env::temp_dir().join(APP_DIR),
    }
}

/// 数据目录：用户数据根目录下的 `data`。**固定就是它**：数据文件不跟着任何设置走，
/// 换机器 / 重装都落在同一个地方（见文件头的约定）。
pub fn data_dir() -> PathBuf {
    user_data_dir().join(DATA_SUBDIR)
}

pub fn data_file() -> PathBuf {
    data_dir().join(DATA_FILE)
}

pub fn theme_file() -> PathBuf {
    data_dir().join(THEME_FILE)
}

pub fn token_file() -> PathBuf {
    data_dir().join(TOKEN_USAGE_FILE)
}

pub fn work_log_file() -> PathBuf {
    data_dir().join(WORK_LOG_FILE)
}

pub fn ai_news_file() -> PathBuf {
    data_dir().join(AI_NEWS_FILE)
}

pub fn etf_file() -> PathBuf {
    data_dir().join(ETF_FILE)
}

/// 本机那份保险库（密文）。仓库里那份由同步流程读写（见 vault.rs），
/// 这一份是离线的落点：没登录、没填仓库地址时照样能建库、能读写条目。
pub fn vault_file() -> PathBuf {
    data_dir().join(VAULT_FILE)
}

pub fn mail_watch_file() -> PathBuf {
    data_dir().join(MAIL_WATCH_FILE)
}

/// 钉图的图片目录
pub fn pins_dir() -> PathBuf {
    data_dir().join(PINS_DIR)
}

/// 钉图的记账文件
pub fn pins_file() -> PathBuf {
    data_dir().join(PINS_FILE)
}

/// 悬浮球的记账文件
pub fn ball_file() -> PathBuf {
    data_dir().join(BALL_FILE)
}

/// 崩溃日志（见 panic_log.rs）。与数据文件同一目录：出了「窗口凭空没了」这种怪事时，
/// 用户只需要找这一处。
pub fn panic_log_file() -> PathBuf {
    data_dir().join(PANIC_LOG_FILE)
}

/// 网关的根目录（`data/wb-gateway`）。
pub fn gateway_dir() -> PathBuf {
    data_dir().join(GATEWAY_DIR)
}

pub fn gateway_settings_file() -> PathBuf {
    gateway_dir().join(GATEWAY_SETTINGS_FILE)
}

pub fn gateway_accounts_dir() -> PathBuf {
    gateway_dir().join(GATEWAY_ACCOUNTS_DIR)
}

/// 网关的用量流水（一行一条请求，只追加）
pub fn gateway_usage_file() -> PathBuf {
    gateway_dir().join(GATEWAY_USAGE_FILE)
}

/// 上一次从上游拉下来的模型目录（见 `wb_models`）。
pub fn gateway_models_file() -> PathBuf {
    gateway_dir().join(GATEWAY_MODELS_FILE)
}

/// 签到 / 每日活跃的尝试记录（见 `wb_tasks`）。只追加，按自然日读今天那一段。
pub fn gateway_activity_file() -> PathBuf {
    gateway_dir().join(GATEWAY_ACTIVITY_FILE)
}

/// 一次性的本地搬家，启动时跑一次（commands.rs 的 `load_all`，必须早于任何 store 载入）：
/// 1. 老版本的数据文件直接写在根目录下，现在收进 `data/`；
/// 2. 用量快照从 `token-data.json` 改名成 `token-usage.json`。
///
/// 顺序不能反：改名那一步得在文件都已经落进新目录之后做。
/// 之所以要走这一步：只改 `data_dir()` 而不搬文件，启动时读到的是空文件，
/// 面板上就是「项目列表全没了」，而下一次落盘又会把空数据写回去。
pub fn migrate_legacy_files() {
    let dir = data_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("[workbench] 数据目录创建失败（{err}）");
        return;
    }
    relocate_root_files_in(&user_data_dir(), &dir);
    rename_legacy_token_file_in(&dir);
}

/// 根目录 → `data/`，只补空缺：**新位置已经有这份文件时绝不用根目录那份盖掉**。
///
/// 理由是根目录里还能冒出数据文件只有一种可能 —— 老版本（数据已经搬走、它读到的是空的）
/// 又跑了一次，写回去的是默认值；拿它盖掉 `data/` 里的真数据等于把用户的项目列表清空。
/// 那份多余的副本一律不动，要删由用户自己删（与上面那个改名同一条口径）。
///
/// 目录可注入（单测用临时目录跑）。
fn relocate_root_files_in(root: &Path, dir: &Path) {
    for name in ROOT_FILES {
        let from = root.join(name);
        if !from.is_file() {
            continue;
        }
        let to = dir.join(name);
        if to.exists() {
            continue;
        }
        if let Err(err) = std::fs::rename(&from, &to) {
            eprintln!("[workbench] 数据文件搬家失败（{name}: {err}），下次启动再试");
        }
    }
}

/// 一次性的本地改名：用量快照从 `token-data.json` 换成 `token-usage.json`。
///
/// 只改文件名、不动内容，所以攒下的历史原样留着。目录可注入（单测用临时目录跑）。
fn rename_legacy_token_file_in(dir: &Path) {
    let target = dir.join(TOKEN_USAGE_FILE);
    let legacy = dir.join(LEGACY_TOKEN_DATA_FILE);
    // 新文件已经在了（已经升级过）或旧文件本来就没有（全新安装）：都不动
    if target.exists() || !legacy.exists() {
        return;
    }
    if let Err(err) = std::fs::rename(&legacy, &target) {
        eprintln!("[workbench] 用量快照改名失败（{err}），下次启动再试");
    }
}

/// Token 同步仓库的本地克隆；机器本地的缓存，删掉会在下次同步时重新克隆
pub fn token_sync_dir() -> PathBuf {
    user_data_dir().join(TOKEN_SYNC_DIR)
}

/// 图片仓库的本地克隆。与用量同步那个**分开两份**：两个仓库地址可以完全不同，
/// 共用一个克隆目录的话，换地址就会互相把对方的克隆删掉重新拉一遍。
/// 同样是机器本地的缓存，删掉会在下次上传时重新克隆。
pub fn image_sync_dir() -> PathBuf {
    user_data_dir().join(IMAGE_SYNC_DIR)
}

/// 本机设备标识（Token 同步用）。机器本地生成，**不进同步仓库**：
/// 两台机器拿到同一个 id 就会往同一个分片文件里写，互相覆盖且不会有任何报错。
/// 与数据文件同目录，但它只属于这台机器（同步时按设备分片，见 sync.rs）。
pub fn device_file() -> PathBuf {
    data_dir().join(DEVICE_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立的临时目录，别和真实数据目录撞上
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 开发版与安装版必须落在两个根目录下：共用一个根目录会让两边的设置互相覆盖
    #[test]
    fn dev_and_installed_roots_differ() {
        assert_eq!(app_dir_name(false), "Workbench");
        assert_eq!(app_dir_name(true), "Workbench-dev");
        assert_ne!(app_dir_name(true), app_dir_name(false));
    }

    /// 老名字的用量快照要能搬到新名字上，历史不能丢
    #[test]
    fn legacy_token_file_is_renamed_once() {
        let dir = temp_dir();

        let legacy = dir.join(LEGACY_TOKEN_DATA_FILE);
        std::fs::write(&legacy, r#"{"version":5,"sources":{}}"#).unwrap();

        rename_legacy_token_file_in(&dir);
        assert!(!legacy.exists());
        assert!(!std::fs::read_to_string(dir.join(TOKEN_USAGE_FILE)).unwrap().is_empty());

        // 再跑一次不动新文件：重启时这一步每次都会走到
        let before = std::fs::read_to_string(dir.join(TOKEN_USAGE_FILE)).unwrap();
        rename_legacy_token_file_in(&dir);
        assert_eq!(std::fs::read_to_string(dir.join(TOKEN_USAGE_FILE)).unwrap(), before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没有旧文件（全新安装）时什么都不做，也不能报错
    #[test]
    fn renaming_without_a_legacy_file_is_a_noop() {
        let dir = temp_dir();

        rename_legacy_token_file_in(&dir);
        assert!(!dir.join(TOKEN_USAGE_FILE).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 老版本写在根目录下的数据文件要整体搬进 `data/`，根目录那边不留副本
    #[test]
    fn root_files_move_into_the_data_dir() {
        let root = temp_dir();
        let data = root.join(DATA_SUBDIR);
        std::fs::create_dir_all(&data).unwrap();

        for name in [DATA_FILE, THEME_FILE, WORK_LOG_FILE, AI_NEWS_FILE, DEVICE_FILE] {
            std::fs::write(root.join(name), r#"{"a":1}"#).unwrap();
        }
        // 不认识的邻居一律不碰：根目录里还有 Electron 版那堆 Chromium 文件
        std::fs::write(root.join("Preferences"), "x").unwrap();

        relocate_root_files_in(&root, &data);

        for name in [DATA_FILE, THEME_FILE, WORK_LOG_FILE, AI_NEWS_FILE, DEVICE_FILE] {
            assert!(data.join(name).exists(), "{name} 应该已经搬进 data/");
            assert!(!root.join(name).exists(), "{name} 不该再留在根目录");
        }
        assert!(root.join("Preferences").exists());
        assert_eq!(std::fs::read_to_string(data.join(DATA_FILE)).unwrap(), r#"{"a":1}"#);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 搬过之后老版本又跑了一次（它读到的是空的，往根目录写回一份默认值）：
    /// `data/` 里那份真数据不能被盖掉，根目录那份也不动
    #[test]
    fn an_existing_data_file_is_never_overwritten_from_the_root() {
        let root = temp_dir();
        let data = root.join(DATA_SUBDIR);
        std::fs::create_dir_all(&data).unwrap();

        std::fs::write(data.join(DATA_FILE), r#"{"from":"data"}"#).unwrap();
        std::fs::write(root.join(DATA_FILE), r#"{"from":"root"}"#).unwrap();

        relocate_root_files_in(&root, &data);

        assert_eq!(
            std::fs::read_to_string(data.join(DATA_FILE)).unwrap(),
            r#"{"from":"data"}"#
        );
        assert!(root.join(DATA_FILE).exists(), "根目录那份留给用户自己删");

        let _ = std::fs::remove_dir_all(&root);
    }
}
