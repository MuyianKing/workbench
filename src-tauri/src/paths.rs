//! 路径解析：数据目录、指针文件、各数据文件名。
//!
//! 关键约定：数据目录必须与 Electron 版一致（`%APPDATA%\Workbench`）。
//! 不能图省事用 Tauri 的 `app_config_dir()` —— 它按 identifier 生成
//! `%APPDATA%\com.muyian.workbench`，换了位置用户就等于「丢了」项目列表。

use std::path::PathBuf;

/// 数据目录指针：只放一个路径。固定放在用户数据根目录下，
/// 不能把「数据目录」存进 workbench-data.json 自己 —— 那样就得先知道文件在哪才能知道文件在哪。
const POINTER_FILE: &str = "data-location.json";
pub const DATA_FILE: &str = "workbench-data.json";
pub const TOKEN_DATA_FILE: &str = "token-data.json";
pub const THEME_FILE: &str = "theme.json";

/// 用户数据根目录，等价于 Electron 的 `app.getPath('userData')`。
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
    data_dir().join(TOKEN_DATA_FILE)
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

    // token 用量快照与主数据同目录，迁移时一并带走（还没有就跳过）
    let _ = std::fs::copy(token_file(), target_dir.join(TOKEN_DATA_FILE));

    std::fs::write(
        pointer_path(),
        serde_json::to_string_pretty(&serde_json::json!({ "dir": target })).unwrap(),
    )
    .map_err(|e| format!("写入指针文件失败: {e}"))?;

    Ok(())
}
