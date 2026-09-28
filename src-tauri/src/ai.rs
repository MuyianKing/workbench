//! AI 助手：让本机的 Pi（一个开源的编码 Agent，<https://pi.dev>）在知识库目录里干活 ——
//! 把 `data/raw` 的原始资料整理成 `kb/` 里的条目。索引重建不归它，由 kb.rs 自己做。
//!
//! 这里只做三件事，且三件都必须待在 Rust 侧：
//!
//! 1. **提示词不走命令行**：它含中文与换行，长度也不可控（要列出待整理的清单）。
//!    写进 `%TEMP%` 下的一个固定文件，起进程时以 Pi 自己的 `@文件` 语法附进第一个提示词
//!    （`@路径` = 把文件内容并进提示词，print 模式支持；RPC 模式才拒绝它）。整条命令走
//!    `session::spawn_args` **直启 node**，不经 `cmd /C` —— 整行 + 内层引号会被 cmd 的
//!    引号剥离规则拆坏（实测：cli.js 路径带引号时 node 收到的是被剥得只剩盘符的路径）。
//!    同一时刻只允许跑一个 AI 任务（界面保证），所以固定文件名不会打架。
//! 2. **密钥只走环境变量**：命令行参数在进程列表里是明文（任务管理器就能看见），
//!    环境变量只属于这个子进程。密钥取自 Windows 凭据管理器（`ai/<provider>` 一条），
//!    渲染层从头到尾不知道它。
//! 3. **替 Pi 关掉它自己那两条出网旁路**：安装 / 更新遥测与向 pi.dev 的版本检查。
//!    应用对用户的承诺是「只在用户显式开启的出口上出网」，这两条不在其中
//!    （见 AGENTS.md 第 1 节与架构文档的「数据与隐私」）。
//!
//! 程序与参数的形状在渲染层（`src/shared/ai.ts`，那边有单测）：TS 给 `program` 与
//! `args`（内置模式 `node <cli.js>`、退路 `pi`），这里只管写提示词文件、追加 `@路径`
//! 参数、取密钥、拼环境变量。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 密钥在凭据管理器里的 provider 前缀：一个提供方一条 `Workbench/ai/<provider>/token`
const KEY_PROVIDER_PREFIX: &str = "ai";

/// 内置 Pi 的 CLI 入口（相对 `resources/pi/`；由 scripts/vendor-pi.mjs 生成）
const BUNDLED_CLI_REL: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

/// 注入密钥用的环境变量名。**它同时出现在 `models.json` 的 `apiKey` 字段里**
/// （`$WORKBENCH_AI_KEY`，Pi 做环境变量插值）—— 两处都在这个文件里，改要一起改。
/// 这样密钥只存在凭据管理器、只在起进程时进环境，不落任何明文配置。
const KEY_ENV: &str = "WORKBENCH_AI_KEY";

/// Pi 的 agent 目录（`PI_CODING_AGENT_DIR`）：指到应用自己的数据目录下，
/// 我们的 `models.json`（自定义端点）与 Pi 的 trust.json / auth.json 都收在这里，
/// 与用户全局的 `~/.pi` 互不掺和。
fn agent_dir() -> PathBuf {
    crate::paths::data_dir().join("pi")
}

/// 内置 Pi 的 CLI 入口：打包后走 resource_dir（resources 映射成 `pi/`），开发态直接读仓库里的
/// `resources/pi/` —— 开发态资源不经过打包流程，不会出现在 target 下面，与内置壁纸同一条路子
/// （见 commands.rs 的 list_wallpapers）。两处都没有（没跑过 vendor 脚本）就回 None，
/// 调用方退回 PATH 上的全局 pi。
///
/// 返回前做一次**规整**：canonicalize 会给出 `\\?\E:\...` 的原样路径，而这个 cli.js 之后要
/// 交给 `cmd /C node` 去跑 —— cmd 对 `\\?\` 前缀的参数会拆坏（实测 node 收到的主路径只剩
/// `E:`，报 EISDIR）。剥掉前缀对盘符路径是安全的；顺带把候选里的 `..` 一起消掉。
pub fn resolve_cli(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("pi").join(BUNDLED_CLI_REL));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("pi")
            .join(BUNDLED_CLI_REL),
    );

    let path = candidates.into_iter().find(|path| path.is_file())?;
    let canon = path.canonicalize().unwrap_or(path);
    let text = canon.to_string_lossy();
    Some(match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => canon,
    })
}

/// 探测 AI 运行时：**内置的那份优先**（resources/pi，vendor 脚本生成、随包分发），
/// 没有再看 PATH 上的全局 pi，两个都没有就是 `none`。node 版本一并探 ——
/// 内置的 cli.js 一样要 node ≥ 22.19 才能跑（门槛的判定在渲染层 shared/ai.ts）。
/// `detail` 带内置那份探测失败时的原始输出：这个字段就是为「为什么明明装了却说没有」
/// 这类排查准备的，界面上不展示。
pub fn runtime(app: &AppHandle) -> Value {
    let node = crate::proc::probe_version("node").unwrap_or_default();

    let mut source = "none";
    let mut cli = String::new();
    let mut pi = String::new();
    let mut detail = String::new();

    match resolve_cli(app) {
        Some(path) => {
            // 版本探测就是跑一次 `node <cli> --version`：node.exe 是真可执行文件，直启不经 cmd
            // （8 秒超时，与 proc::probe_version 同一档）
            let argv = [
                path.to_string_lossy().into_owned(),
                "--version".to_string(),
            ];
            match crate::proc::run_direct("node", &argv, Duration::from_secs(8), None, &[]) {
                Ok(outcome) if outcome.ok() => {
                    source = "bundled";
                    pi = outcome.first_line();
                    cli = path.to_string_lossy().into_owned();
                }
                Ok(outcome) => {
                    detail = format!(
                        "版本探测退出码 {:?} | stderr：{}",
                        outcome.status,
                        &outcome.stderr.chars().take(400).collect::<String>()
                    );
                }
                Err(err) => {
                    detail = format!("版本探测没起来：{err}");
                }
            }
        }
        None => {
            detail = "内置的 cli.js 不在（resource_dir 与仓库 resources/pi 都没有）".into();
        }
    }

    if source == "none" {
        if let Some(version) = crate::proc::probe_version("pi") {
            source = "path";
            pi = version;
        }
    }

    json!({ "source": source, "cli": cli, "pi": pi, "node": node, "detail": detail })
}

/// 提供方名进凭据目标名之前先收紧：只收小写字母、数字与连字符。
/// 它来自渲染层（设置项），而目标名是凭据管理器里的一等键名 —— 不该由界面随意拼。
pub fn key_provider(provider: &str) -> Result<String, String> {
    let id = provider.trim();
    let ok = !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(id.to_string())
    } else {
        Err(format!("提供方名不合法：{provider}"))
    }
}

/// 提示词文件的固定落点（每次运行覆盖）。放 `%TEMP%` 而不是数据目录：
/// 它是这一次运行的中间产物，不该混进用户的数据文件里。
pub fn prompt_file() -> PathBuf {
    std::env::temp_dir().join("workbench-ai-prompt.md")
}

fn write_prompt(prompt: &str) -> Result<PathBuf, String> {
    let path = prompt_file();
    std::fs::write(&path, prompt.as_bytes()).map_err(|err| format!("写提示词文件失败：{err}"))?;
    Ok(path)
}

/// 凭据管理器里的目标名：一个提供方一条（`Workbench/ai/<provider>/token`）
fn credential_provider(provider: &str) -> String {
    format!("{KEY_PROVIDER_PREFIX}/{provider}")
}

/// 存 / 覆盖某个提供方的 API Key。空串挡在这里 —— 界面上的「清除」走另一条命令，
/// 不小心传个空串进来不该把已配好的那条悄悄抹掉。
pub fn key_save(provider: &str, secret: &str) -> Result<(), String> {
    let provider = key_provider(provider)?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("API Key 不能是空的".into());
    }
    crate::credentials::store(&credential_provider(&provider), secret)
}

/// 这个提供方配过 Key 没有。**只回有没有** —— 密钥不进渲染层，界面只显示「已配置」。
pub fn key_state(provider: &str) -> Result<bool, String> {
    let provider = key_provider(provider)?;
    Ok(crate::credentials::read(&credential_provider(&provider)).is_some())
}

/// 清掉某个提供方的 Key（本来就没有也算成功，见 credentials::remove）
pub fn key_clear(provider: &str) -> Result<(), String> {
    let provider = key_provider(provider)?;
    crate::credentials::remove(&credential_provider(&provider))
}

/// 允许的 API 形态（models.json 的 `api` 字段）。两个 id 都来自 Pi 自己的材料：
/// `openai-completions` 见它文档的示例，`anthropic-messages` 见它事件流的 api 字段。
const API_FORMATS: [&str; 2] = ["openai-completions", "anthropic-messages"];

/// 写自定义端点的 `models.json`（Pi agent 目录下，`PI_CODING_AGENT_DIR` 指过去的那份）。
///
/// 这是「模型配置」的落点：设置页存下名称 / Base URL / API 形态 / 模型清单后调这里。
/// `apiKey` 写成 `$WORKBENCH_AI_KEY`（Pi 的环境变量插值）—— 真正的密钥在凭据管理器里、
/// 只在起进程时进环境变量，这份文件从头到尾只有占位引用，**不落明文**。
pub fn provider_write(
    provider: &str,
    base_url: &str,
    api: &str,
    models: &[String],
) -> Result<(), String> {
    let provider = key_provider(provider)?;
    let base_url = base_url.trim();
    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("Base URL 要以 http(s):// 开头".into());
    }
    if !API_FORMATS.contains(&api) {
        return Err(format!("API 形态不认识：{api}"));
    }
    let ids = normalize_models(models)?;
    write_models_json(&agent_dir(), &provider, base_url, api, &ids)
}

/// 模型清单的收敛：去空白、去重（保序）、限长限量；空了明说
fn normalize_models(models: &[String]) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = Vec::new();
    for model in models {
        let id = model.trim();
        if id.is_empty() || ids.iter().any(|existing| existing == id) {
            continue;
        }
        if id.len() > 120 {
            return Err(format!("模型名过长：{id}"));
        }
        ids.push(id.to_string());
    }
    if ids.is_empty() {
        return Err("至少要有一个模型".into());
    }
    if ids.len() > 32 {
        return Err("模型太多了（上限 32 个）".into());
    }
    Ok(ids)
}

/// models.json 的实际生成（`dir` 即 Pi 的 agent 目录）。拆出来是为了让单测能直打，
/// 不必去改 APPDATA 环境变量。
fn write_models_json(
    dir: &Path,
    provider: &str,
    base_url: &str,
    api: &str,
    ids: &[String],
) -> Result<(), String> {
    let file = json!({
        "providers": {
            provider: {
                "baseUrl": base_url,
                "api": api,
                "apiKey": format!("${KEY_ENV}"),
                "models": ids.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>(),
            }
        }
    });

    std::fs::create_dir_all(dir).map_err(|err| format!("创建 Pi 配置目录失败：{err}"))?;
    let text = serde_json::to_string_pretty(&file).map_err(|err| format!("生成 models.json 失败：{err}"))?;
    std::fs::write(dir.join("models.json"), text).map_err(|err| format!("写 models.json 失败：{err}"))
}

/// 跑一次 AI 整理：写提示词 → 取密钥 → 拼环境变量 → 起会话。
///
/// 返回子进程 pid；输出与退出照旧经 `session:lines` / `session:exit` 回推，
/// 渲染层按会话 id 前缀（`ai:`）接住（见 workbench/ai.ts）。
#[allow(clippy::too_many_arguments)]
pub fn run(
    app: &AppHandle,
    session_id: String,
    dir: String,
    prompt: String,
    program: String,
    args: Vec<String>,
    provider: String,
    model: String,
) -> Result<u32, String> {
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("还没有选择知识库文件夹".into());
    }
    if !Path::new(&dir).is_dir() {
        return Err(format!("找不到知识库文件夹：{dir}"));
    }
    if prompt.trim().is_empty() {
        return Err("整理提示词是空的".into());
    }

    let provider = key_provider(&provider)?;
    let secret = crate::credentials::read(&credential_provider(&provider))
        .ok_or_else(|| format!("还没有配置 {provider} 的 API Key"))?;

    let prompt_path = write_prompt(&prompt)?;
    // 提示词以 Pi 的 `@文件` 语法附在最后一个参数上（args 由渲染层给，不含提示词；
    // 参数数组逐个传递，路径里有空格也不会被拆）
    let mut argv = args;
    argv.push(format!("@{}", prompt_path.display()));

    let mut envs = vec![
        // 这两条要排在最前：它们是「不要出网」的开关，别被后面任何一条覆盖掉
        ("PI_TELEMETRY".to_string(), "0".to_string()),
        ("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()),
        // agent 目录指到应用自己的数据目录：models.json（自定义端点）在这里，
        // Pi 的 trust.json / auth.json 也收在这里，不与用户全局的 ~/.pi 掺和
        (
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir().to_string_lossy().into_owned(),
        ),
        // models.json 的 apiKey 引用的就是这个名字（见 provider_write 与 KEY_ENV 的注释）
        (KEY_ENV.to_string(), secret),
    ];
    // 模型按 `提供方/模型` 寻址（Pi 的 provider/id 形态），空串让 Pi 自己挑
    let model = model.trim();
    if !model.is_empty() {
        envs.push(("PI_MODEL".to_string(), format!("{provider}/{model}")));
    }

    crate::session::spawn_args(app, session_id, program, &argv, Some(dir), None, &envs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个临时目录；用完删掉（留着的临时目录只会在盘上积垃圾）
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-ai-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 提供方名只收小写字母、数字与连字符：它会被拼进凭据管理器的目标名
    #[test]
    fn provider_names_are_narrowed() {
        assert_eq!(key_provider("anthropic").unwrap(), "anthropic");
        assert_eq!(key_provider(" deepseek ").unwrap(), "deepseek");
        assert_eq!(key_provider("zai-cn").unwrap(), "zai-cn");

        assert!(key_provider("").is_err());
        assert!(key_provider("Anthropic").is_err(), "大写要挡住（凭据名不做大小写折叠）");
        assert!(key_provider("a/b").is_err(), "斜杠拼进目标名会变成另一条凭据");
        assert!(key_provider("../vault").is_err());
        assert!(key_provider(&"x".repeat(33)).is_err());
    }

    /// models.json 的生成：apiKey 是环境变量引用（不落明文），传进来的清单原样落盘
    #[test]
    fn provider_write_writes_models_json() {
        let dir = temp_root("models");

        write_models_json(
            &dir,
            "opencode",
            "https://opencode.ai/zen/go/v1",
            "openai-completions",
            &["deepseek-v4.1-flash".into(), "mimo-v2.6-flash".into()],
        )
        .unwrap();

        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert!(
            text.contains(r#""apiKey": "$WORKBENCH_AI_KEY""#),
            "apiKey 必须是环境变量引用，不能落明文：{text}"
        );
        assert!(text.contains(r#""baseUrl": "https://opencode.ai/zen/go/v1""#));
        assert!(text.contains("deepseek-v4.1-flash"), "{text}");
        assert!(text.contains("mimo-v2.6-flash"), "{text}");

        // 校验在 provider_write 那一层：形态、Base URL、模型非空
        assert!(provider_write("opencode", "ftp://x", "openai-completions", &["a".into()]).is_err());
        assert!(provider_write("opencode", "https://x", "grpc", &["a".into()]).is_err());
        assert!(provider_write("opencode", "https://x", "openai-completions", &[]).is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 模型清单的收敛：去空白、去重保序、限长限量
    #[test]
    fn model_lists_are_normalized() {
        let ids = normalize_models(&[
            " deepseek-v4.1-flash ".into(),
            "mimo-v2.6-flash".into(),
            "deepseek-v4.1-flash".into(),
            "  ".into(),
        ])
        .unwrap();
        assert_eq!(ids, vec!["deepseek-v4.1-flash", "mimo-v2.6-flash"], "去空白、去重、丢空项");

        assert!(normalize_models(&["  ".into()]).is_err(), "清完就空要明说");
        assert!(normalize_models(&["x".repeat(121)]).is_err(), "超长要挡");
        let many = (0..33).map(|index| format!("m{index}")).collect::<Vec<_>>();
        assert!(normalize_models(&many).is_err(), "超过 32 个要挡");
    }

    /// 提示词确实落到了盘上，内容是 UTF-8 原文（中文不经过任何代码页转换）
    #[test]
    fn prompt_lands_on_disk_verbatim() {
        let text = "# 提示词\n\n整理 data/raw 下的资料，按「条目格式规范」入库。\n";
        let path = write_prompt(text).expect("写提示词失败");
        assert_eq!(path, prompt_file());

        let read = std::fs::read_to_string(&path).expect("读回提示词失败");
        assert_eq!(read, text);

        let _ = std::fs::remove_file(&path);
    }
}
