//! nvm 探测（只读）+ 版本切换所需的目录解析。
//!
//! 刻意**不调用 nvm.exe**：nvm-windows 会先用 GetConsoleMode 检查 stdout 是不是真终端，
//! 而 `nvm use` 还要管理员权限去改软链。所以只读它的安装目录、settings.txt 与软链，
//! 版本切换靠给子进程前置 PATH（见 session 的 `path_prepend`）。
//!
//! 这套规则与判据是从 Electron 版 `main/nvm.ts` 整段搬过来的，连同它的用例。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 版本目录名：vX.Y.Z
fn is_version_dir(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<&str> = rest.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// 去掉 v 前缀和空白，统一成 nvm 目录用的写法
pub fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches(['v', 'V']).to_string()
}

/// 版本号从高到低；纯数字比较，避免 9 排到 10 前面
pub fn sort_versions(versions: &[String]) -> Vec<String> {
    let mut sorted: Vec<String> = versions.to_vec();
    sorted.sort_by(|left, right| {
        let parse = |value: &str| -> Vec<u64> {
            value.split('.').map(|part| part.parse().unwrap_or(0)).collect()
        };
        let a = parse(left);
        let b = parse(right);
        for index in 0..3 {
            let diff = b.get(index).copied().unwrap_or(0) as i64
                - a.get(index).copied().unwrap_or(0) as i64;
            if diff != 0 {
                return diff.cmp(&0);
            }
        }
        std::cmp::Ordering::Equal
    });
    sorted
}

/// 把声明里的版本映射到具体已安装版本：
/// 先精确匹配，「20」/「20.20」这种段前缀再匹配到该段内最高的版本（.nvmrc 里很常见）。
pub fn match_installed_version(version: &str, installed: &[String]) -> Option<String> {
    let wanted = normalize_version(version);
    if wanted.is_empty() {
        return None;
    }

    if installed.iter().any(|item| item == &wanted) {
        return Some(wanted);
    }

    let wanted_parts: Vec<&str> = wanted.split('.').filter(|part| !part.is_empty()).collect();
    if wanted_parts
        .iter()
        .any(|part| !part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }

    for candidate in sort_versions(installed) {
        let parts: Vec<&str> = candidate.split('.').collect();
        if wanted_parts
            .iter()
            .enumerate()
            .all(|(index, part)| parts.get(index) == Some(part))
        {
            return Some(candidate);
        }
    }
    None
}

/// 解析 settings.txt 里的 root / path 两行，容忍引号与空白。
///
/// 键名比较不区分大小写，但**取值必须原样保留** —— 路径大小写会被写回环境变量，
/// 早先把整行小写化过，结果 D:\nvm 变成了 d:\nvm。
pub fn parse_settings(text: &str) -> (Option<String>, Option<String>) {
    let mut root = None;
    let mut path = None;

    for line in text.split(['\r', '\n']) {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };

        let cleaned = value.trim().trim_matches('"').trim();
        if cleaned.is_empty() {
            continue;
        }

        match key.trim().to_ascii_lowercase().as_str() {
            "root" => root = Some(cleaned.to_string()),
            "path" => path = Some(cleaned.to_string()),
            _ => {}
        }
    }

    (root, path)
}

fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

/// 这个版本目录是不是一份可用的 node 安装
fn is_node_install(dir: &Path) -> bool {
    dir.join("node.exe").is_file()
}

/// 列出 root 下所有可用版本，从高到低。
/// 只认 vX.Y.Z 且带 node.exe 的目录，nvm 自己的下载缓存（.zip / tmp）会被自然排除。
pub fn list_installed_versions(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut versions = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_version_dir(&name) {
            continue;
        }
        if !is_node_install(&root.join(&name)) {
            continue;
        }
        versions.push(name[1..].to_string());
    }
    sort_versions(&versions)
}

/// nvm 根目录的候选位置：环境变量 > nvm-windows 默认安装位置 > PATH 上的 nvm.exe
fn root_candidates() -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();

    if let Some(home) = env_non_empty("NVM_HOME") {
        list.push(PathBuf::from(home));
    }
    if let Some(app_data) = env_non_empty("APPDATA") {
        list.push(PathBuf::from(app_data).join("nvm"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            if entry.join("nvm.exe").is_file() {
                list.push(entry);
            }
        }
    }

    list.dedup();
    list
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 定位 nvm 根目录：候选目录里的 settings.txt 会给出真正的 root
pub fn resolve_root() -> Option<PathBuf> {
    for candidate in root_candidates() {
        if !is_dir(&candidate) {
            continue;
        }

        if let Ok(text) = std::fs::read_to_string(candidate.join("settings.txt")) {
            if let (Some(configured), _) = parse_settings(&text) {
                let configured = PathBuf::from(configured);
                if is_dir(&configured) {
                    return Some(configured);
                }
            }
        }

        if candidate.join("nvm.exe").is_file() || !list_installed_versions(&candidate).is_empty() {
            return Some(candidate);
        }
    }
    None
}

/// NVM_SYMLINK：环境变量优先，其次 settings.txt 里的 path
fn resolve_symlink(root: &Path) -> Option<String> {
    if let Some(from_env) = env_non_empty("NVM_SYMLINK") {
        return Some(from_env);
    }
    let text = std::fs::read_to_string(root.join("settings.txt")).ok()?;
    parse_settings(&text).1
}

/// 软链指向哪个版本（junction 与 symlink 都能被 canonicalize 解析）
fn version_of_symlink(symlink: &Option<String>) -> Option<String> {
    let target = std::fs::canonicalize(symlink.as_deref()?).ok()?;
    let name = target.file_name()?.to_string_lossy().into_owned();
    if is_version_dir(&name) {
        Some(name[1..].to_string())
    } else {
        None
    }
}

/// 某个版本对应的安装目录，找不到返回 None
pub fn find_node_dir(version: &str) -> Option<PathBuf> {
    let root = resolve_root()?;
    let installed = list_installed_versions(&root);
    let matched = match_installed_version(version, &installed)?;

    let dir = root.join(format!("v{matched}"));
    if is_node_install(&dir) {
        Some(dir)
    } else {
        None
    }
}

/// nvm 探测结果（只读），形状与 shared 里的 NvmStatus 一致
pub fn status() -> Value {
    let Some(root) = resolve_root() else {
        return json!({
            "available": false,
            "versions": [],
            "error": "未找到 nvm：NVM_HOME、%APPDATA%\\nvm 与 PATH 里都没有它的安装目录",
        });
    };

    let versions = list_installed_versions(&root);
    let symlink = resolve_symlink(&root);
    let current = version_of_symlink(&symlink);

    json!({
        "available": true,
        "root": root.to_string_lossy(),
        "symlink": symlink,
        "current": current,
        "versions": versions,
        "error": if versions.is_empty() {
            Some("这个 nvm 目录下还没有已安装的 Node 版本")
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_numerically_so_nine_does_not_beat_ten() {
        let input = vec!["9.0.0".to_string(), "10.1.0".to_string(), "10.0.0".to_string()];
        assert_eq!(sort_versions(&input), vec!["10.1.0", "10.0.0", "9.0.0"]);
    }

    #[test]
    fn normalizes_the_v_prefix_and_whitespace() {
        assert_eq!(normalize_version(" v20.10.0 "), "20.10.0");
        assert_eq!(normalize_version("V18.20.4"), "18.20.4");
    }

    #[test]
    fn matches_exact_first_then_segment_prefix() {
        let installed = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // 精确匹配，允许带 v 前缀
        assert_eq!(
            match_installed_version("v20.10.0", &installed(&["20.10.0", "20.11.0"])),
            Some("20.10.0".to_string())
        );
        // .nvmrc 里常见的段前缀落到该段内最高的版本
        assert_eq!(
            match_installed_version("20", &installed(&["20.10.0", "20.11.0", "18.20.4"])),
            Some("20.11.0".to_string())
        );
        // 段前缀是按段比较，不是字符串前缀：2 不该命中 20.x
        assert_eq!(match_installed_version("2", &installed(&["20.10.0"])), None);
        // 读不懂或没装的返回 None
        assert_eq!(match_installed_version("latest", &installed(&["20.10.0"])), None);
        assert_eq!(match_installed_version("", &installed(&["20.10.0"])), None);
    }

    #[test]
    fn parses_settings_tolerating_quotes_and_crlf() {
        let text = "root: D:\\nvm\r\npath: \"C:\\Program Files\\nodejs\"\r\n";
        let (root, path) = parse_settings(text);
        assert_eq!(root.as_deref(), Some("D:\\nvm"));
        assert_eq!(path.as_deref(), Some("C:\\Program Files\\nodejs"));

        let (root, path) = parse_settings("");
        assert!(root.is_none() && path.is_none());
    }

    #[test]
    fn recognizes_version_directories() {
        assert!(is_version_dir("v20.10.0"));
        assert!(!is_version_dir("20.10.0"));
        assert!(!is_version_dir("v20.10"));
        assert!(!is_version_dir("v20.10.0.zip"));
        assert!(!is_version_dir(".tmp"));
    }
}
