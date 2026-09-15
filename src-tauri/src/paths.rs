//! 路径解析：数据目录、指针文件、各数据文件名。
//!
//! 关键约定：数据目录必须与 Electron 版一致（`%APPDATA%\Workbench`）。
//! 不能图省事用 Tauri 的 `app_config_dir()` —— 它按 identifier 生成
//! `%APPDATA%\com.muyian.workbench`，换了位置用户就等于「丢了」项目列表。

use std::path::{Path, PathBuf};

/// 数据目录指针：只放一个路径。固定放在用户数据根目录下，
/// 不能把「数据目录」存进 workbench-data.json 自己 —— 那样就得先知道文件在哪才能知道文件在哪。
const POINTER_FILE: &str = "data-location.json";
pub const DATA_FILE: &str = "workbench-data.json";
/// Token 用量快照（改名前的 `token-data.json`，启动时由 `migrate_legacy_files` 搬过来）
pub const TOKEN_USAGE_FILE: &str = "token-usage.json";
/// 主题文件：外观设置 + 首页布局（见 shared/theme.ts）
pub const THEME_FILE: &str = "theme.json";
/// 改名前的用量快照文件名，只在一次性搬家时用得上
const LEGACY_TOKEN_DATA_FILE: &str = "token-data.json";
/// 本机设备标识（Token 同步用）
const DEVICE_FILE: &str = "device.json";
/// Token 同步仓库的本地克隆目录名
const TOKEN_SYNC_DIR: &str = "token-sync";
/// 克隆里放**用量分片**的子目录名：一台机器一个文件
pub(crate) const TOKEN_USAGE_DIR: &str = "token-usage";
/// 克隆里放**配置**的子目录名：一台机器一份 theme.json 的副本（见 shared/sync-config.ts）
pub(crate) const CONFIG_DIR: &str = "config";

/// 用户数据根目录，等价于 Electron 的 `getAppData`。
pub fn user_data_dir() -> PathBuf {
    match std::env::var_os("APPDATA") {
        Some(base) => PathBuf::from(base).join("Workbench"),
        // 理论上 Windows 上 APPDATA 一定有；兜底到临时目录，至少不 panic
        None => std::env::temp_dir().join("Workbench"),
    }
}

fn pointer_path() -> PathBuf {
    user_data_dir().join(POINTER_FILE)
}

/// 用户在设置里迁移过的数据目录；指针缺失或损坏时回落默认目录（不影响启动）。
pub fn custom_dir() -> Option<PathBuf> {
    let text = std::fs::read_to_string(pointer_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let dir = value.get("dir")?.as_str()?.trim().to_string();
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

pub fn data_dir() -> PathBuf {
    custom_dir().unwrap_or_else(user_data_dir)
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

/// 一次性的本地改名：用量快照从 `token-data.json` 换成 `token-usage.json`。
///
/// 只改文件名、不动内容，所以攒下的历史原样留着。必须在任何 store 载入之前跑
/// （见 commands.rs 的 `load_all`），否则会先按新名字读到一个空文件，
/// 面板上就是「历史突然没了」，而下一次落盘又会把空数据写回去。
pub fn migrate_legacy_files() {
    migrate_legacy_files_in(&data_dir());
}

/// 上者的实体，目录可注入（单测用临时目录跑）
pub(crate) fn migrate_legacy_files_in(dir: &Path) {
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

/// 克隆里放用量分片的子目录：一台机器一个文件，所以永远没有同文件冲突
pub fn token_shard_dir() -> PathBuf {
    token_sync_dir().join(TOKEN_USAGE_DIR)
}

/// 克隆里放配置的子目录：同样是「一台机器一个文件」
pub fn config_shard_dir() -> PathBuf {
    token_sync_dir().join(CONFIG_DIR)
}

/// 本机设备标识（Token 同步用）。机器本地生成，**不随数据目录迁移、也不进同步仓库**：
/// 两台机器拿到同一个 id 就会往同一个分片文件里写，互相覆盖且不会有任何报错。
/// 放在 user_data_dir 而不是数据目录里，正是因为用户可能把数据目录指到别处（甚至是网盘）。
pub fn device_file() -> PathBuf {
    user_data_dir().join(DEVICE_FILE)
}

/// 目标目录里是否已经有数据文件（迁移前要拦一下，避免覆盖别人的数据）。
pub fn data_file_exists_in(dir: &str) -> bool {
    !dir.trim().is_empty() && PathBuf::from(dir.trim()).join(DATA_FILE).exists()
}

/// 把数据搬到新目录并切过去。写的是内存里的当前数据，所以调用前必须已经加载过。
pub fn migrate_data_dir(dir: &str, current: &serde_json::Value) -> Result<(), String> {
    let target = dir.trim();
    if target.is_empty() {
        return Err("目录为空".into());
    }

    let target_dir = PathBuf::from(target);
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    std::fs::write(
        target_dir.join(DATA_FILE),
        serde_json::to_string_pretty(current).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入数据文件失败: {e}"))?;

    // 用量快照与主数据同目录，迁移时一并带走（还没有就跳过）
    let _ = std::fs::copy(token_file(), target_dir.join(TOKEN_USAGE_FILE));
    // 主题文件同理：首页布局与外观设置都在里面，漏掉这一份等于把用户的摆放和配色清掉
    let _ = std::fs::copy(theme_file(), target_dir.join(THEME_FILE));

    std::fs::write(
        pointer_path(),
        serde_json::to_string_pretty(&serde_json::json!({ "dir": target })).unwrap(),
    )
    .map_err(|e| format!("写入指针文件失败: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 老名字的用量快照要能搬到新名字上，历史不能丢
    #[test]
    fn legacy_token_file_is_renamed_once() {
        let dir = std::env::temp_dir().join(format!("wb-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let legacy = dir.join(LEGACY_TOKEN_DATA_FILE);
        std::fs::write(&legacy, r#"{"version":5,"sources":{}}"#).unwrap();

        migrate_legacy_files_in(&dir);
        assert!(!legacy.exists());
        assert!(!std::fs::read_to_string(dir.join(TOKEN_USAGE_FILE)).unwrap().is_empty());

        // 再跑一次不动新文件：重启时这一步每次都会走到
        let before = std::fs::read_to_string(dir.join(TOKEN_USAGE_FILE)).unwrap();
        migrate_legacy_files_in(&dir);
        assert_eq!(std::fs::read_to_string(dir.join(TOKEN_USAGE_FILE)).unwrap(), before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没有旧文件（全新安装）时什么都不做，也不能报错
    #[test]
    fn renaming_without_a_legacy_file_is_a_noop() {
        let dir = std::env::temp_dir().join(format!("wb-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        migrate_legacy_files_in(&dir);
        assert!(!dir.join(TOKEN_USAGE_FILE).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
