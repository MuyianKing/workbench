//! nrm（npm 镜像源管理器）探测与切换。
//!
//! 这里刻意**不维护镜像清单**：名字与地址一律问 `nrm ls` 要 —— 清单会随版本变
//! （taobao 改名 npmmirror 就是一次），在代码里再抄一份必然过期。
//! 我们只负责把它认出来、把「当前是哪个」对上。切换走 `nrm use <name>`，
//! 由 nrm 自己去写 npm 配置，不需要管理员权限。
//!
//! nrm 是个 .cmd，所以要经 shell 起（见 proc::run）；超时给得比探测宽 ——
//! 冷启动一次 node 要一两秒，慢机器上更多。

use serde_json::{json, Value};
use std::time::Duration;

/// `nrm ls` / `nrm use` 的单次超时
const NRM_TIMEOUT: Duration = Duration::from_secs(20);

/// 去掉 CSI 控制序列（`nrm ls` 会给当前那一行上色）。
///
/// 管道里大多数情况本来就没有颜色，但环境变量（FORCE_COLOR、CLICOLOR_FORCE）能把它打开，
/// 那样星号前面会多出一串转义字符，整行都认不出来。
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // CSI 的终结符落在 0x40..=0x7e，读到它这一串就结束了
            for next in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&next) {
                    break;
                }
            }
        } else {
            // 非 CSI 的转义序列：吃掉紧邻的一个字符即可
            chars.next();
        }
    }

    out
}

/// 解析 `nrm ls` 的输出。
///
/// 每行的形状是 `* 名字 ---- 地址`（星号标记当前那个）；名字与地址之间是一串横线，
/// 横线的数量和名字的对齐宽度都随版本变，所以按「第一个 token 是名字、
/// 第一个 http 开头的 token 是地址」来取，不去数字符。
pub fn parse_registries(text: &str) -> Vec<(String, String, bool)> {
    let mut list: Vec<(String, String, bool)> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        let (current, rest) = match line.strip_prefix('*') {
            Some(rest) => (true, rest.trim()),
            None => (false, line),
        };

        let Some(url) = rest
            .split_whitespace()
            .find(|part| part.starts_with("http"))
            .map(str::to_string)
        else {
            continue;
        };
        let Some(name) = rest
            .split_whitespace()
            .next()
            .filter(|name| !name.starts_with('-') && *name != url)
            .map(str::to_string)
        else {
            continue;
        };

        // 同一个名字在 nrm 的输出里只该出现一次；真重复了就以后面的为准，
        // 免得界面上的下拉里出现两条一模一样的选项
        match list.iter_mut().find(|item| item.0 == name) {
            Some(item) => {
                item.1 = url;
                item.2 = item.2 || current;
            }
            None => list.push((name, url, current)),
        }
    }

    list
}

/// 地址比对：忽略结尾斜杠与大小写（`https://x.com/` 与 `https://x.com` 是同一个）
fn same_url(left: &str, right: &str) -> bool {
    let norm = |value: &str| value.trim().trim_end_matches('/').to_lowercase();
    !left.is_empty() && norm(left) == norm(right)
}

/// 镜像名要直接进 `cmd /C nrm use <name>`，含命令分隔符的名字会把命令拆开。
/// 名字来自 nrm 自己的输出（也就来自用户的 .nrmrc），这里只做最小拦截：
/// 空白与 shell 元字符一律拒掉，中文之类正常字符不影响。
fn is_safe_registry_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name
            .chars()
            .any(|ch| ch.is_whitespace() || "&|<>^%!\"'`$(){}[];,*?".contains(ch))
}

/// 失败原因：stderr 优先，退回 stdout 首行，都空就给一句通用的
fn reason_of(outcome: &crate::proc::Outcome) -> String {
    for text in [&outcome.stderr, &outcome.stdout] {
        let line = text.lines().map(str::trim).find(|line| !line.is_empty());
        if let Some(line) = line {
            return line.to_string();
        }
    }
    format!("nrm 退出码 {:?}", outcome.status)
}

/// npm 当前生效的 registry：拿它给「没打星号」的 nrm 兜底认当前项
fn npm_registry() -> Option<String> {
    let outcome = crate::proc::run(
        "npm",
        &["config".to_string(), "get".to_string(), "registry".to_string()],
        NRM_TIMEOUT,
    )
    .ok()?;

    let value = outcome.first_line();
    if outcome.ok() && value.starts_with("http") {
        Some(value)
    } else {
        None
    }
}

/// 问 nrm 要镜像清单，并把「当前是哪个」标出来
fn list_registries() -> Result<Vec<(String, String, bool)>, String> {
    let outcome = crate::proc::run("nrm", &["ls".to_string()], NRM_TIMEOUT)
        .map_err(|err| format!("调用 nrm 失败: {err}"))?;
    if !outcome.ok() {
        return Err(reason_of(&outcome));
    }

    let mut list = parse_registries(&strip_ansi(&outcome.stdout));
    if list.is_empty() {
        return Err("没读懂 nrm ls 的输出".to_string());
    }

    // 星号是首选依据；有些版本/配置下不打星号，那时拿 npm 的 registry 反查一遍
    if !list.iter().any(|item| item.2) {
        if let Some(url) = npm_registry() {
            for item in list.iter_mut() {
                item.2 = same_url(&item.1, &url);
            }
        }
    }

    Ok(list)
}

/// nrm 探测结果，形状与 shared 里的 NrmStatus 一致
pub fn status() -> Value {
    let Some(version) = crate::proc::probe_version("nrm") else {
        return json!({
            "available": false,
            "registries": [],
            "error": "未检测到 nrm，可用右侧的安装按钮装一个",
        });
    };

    match list_registries() {
        Ok(list) => {
            let current = list
                .iter()
                .find(|item| item.2)
                .map(|item| item.0.clone());
            let registries: Vec<Value> = list
                .iter()
                .map(|(name, url, current)| json!({ "name": name, "url": url, "current": current }))
                .collect();

            json!({
                "available": true,
                "version": version,
                "current": current,
                "registries": registries,
            })
        }
        // 装是装了，但清单读不出来：照样按「可用」回，把原因带上让界面提示
        Err(err) => json!({
            "available": true,
            "version": version,
            "registries": [],
            "error": err,
        }),
    }
}

/// 切换镜像源：`nrm use <name>`，由 nrm 自己写 npm 配置
pub fn use_registry(name: &str) -> Result<(), String> {
    let name = name.trim();
    if !is_safe_registry_name(name) {
        return Err("镜像名不合法".to_string());
    }

    let outcome = crate::proc::run("nrm", &["use".to_string(), name.to_string()], NRM_TIMEOUT)
        .map_err(|err| format!("调用 nrm 失败: {err}"))?;

    if outcome.ok() {
        Ok(())
    } else {
        Err(reason_of(&outcome))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机上的输出（管道里没有颜色时的样子）
    const SAMPLE: &str = "\
  npm ---------- https://registry.npmjs.org/
  yarn --------- https://registry.yarnpkg.com/
  tencent ------ https://mirrors.tencent.com/npm/
  cnpm --------- https://r.cnpmjs.org/
* taobao ------- https://registry.npmmirror.com/
  npmMirror ---- https://skimdb.npmjs.com/registry/
";

    #[test]
    fn parses_the_real_output_and_finds_the_current_one() {
        let list = parse_registries(SAMPLE);
        assert_eq!(list.len(), 6);
        assert_eq!(
            list[0],
            (
                "npm".to_string(),
                "https://registry.npmjs.org/".to_string(),
                false
            )
        );
        // 星号标记的那一行就是当前镜像
        let current: Vec<&String> = list
            .iter()
            .filter(|item| item.2)
            .map(|item| &item.0)
            .collect();
        assert_eq!(current, vec!["taobao"]);
    }

    #[test]
    fn keeps_chinese_names_and_ignores_noise_lines() {
        let text = "nrm 版本 2.1.0\n  自定义源 ---- https://example.com/npm/\n";
        let list = parse_registries(text);
        assert_eq!(
            list,
            vec![(
                "自定义源".to_string(),
                "https://example.com/npm/".to_string(),
                false
            )]
        );
    }

    #[test]
    fn strips_colors_so_the_star_still_matches() {
        // 当前行整行涂色：ESC[36m 开头、ESC[39m 收尾
        let colored = "\u{1b}[36m* taobao ------- https://registry.npmmirror.com/\u{1b}[39m\n";
        let list = parse_registries(&strip_ansi(colored));
        assert_eq!(list.len(), 1);
        assert!(list[0].2, "去掉颜色后星号应当还在行首");
    }

    #[test]
    fn compares_urls_ignoring_slash_case_and_spaces() {
        assert!(same_url("https://registry.npmjs.org/", " HTTPS://registry.npmjs.org "));
        assert!(!same_url("https://registry.npmjs.org/", "https://registry.yarnpkg.com/"));
    }

    #[test]
    fn rejects_names_that_could_break_out_of_the_shell() {
        assert!(is_safe_registry_name("taobao"));
        assert!(is_safe_registry_name("npmmirror"));
        assert!(is_safe_registry_name("自建源"));
        assert!(!is_safe_registry_name(""));
        assert!(!is_safe_registry_name("taobao & calc"));
        assert!(!is_safe_registry_name("taobao|whoami"));
        assert!(!is_safe_registry_name("a\"b"));
    }
}
