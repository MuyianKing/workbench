//! AI 助手：让本机的 Pi（一个开源的编码 Agent，<https://pi.dev>）在用户挑的那个目录里干活。
//!
//! 这里只做五件必须待在 Rust 侧的事：
//!
//! 1. **提示词与「确认答复」都走子进程的 stdin**：提示词含中文与换行、长度也不可控，
//!    走命令行必炸。Pi 跑的是 **RPC 模式**（`--mode rpc`，它官方给宿主集成的双向协议），
//!    提示词是 stdin 上的一行 JSON（`{"type":"prompt","message":…}`，见 `prompt_frame`），
//!    扩展回头问「这条命令让不让跑」时，渲染层把答复也写成一行 JSON 回同一条 stdin
//!    （`session::write_stdin`，形状见 shared/ai.ts 的 confirmFrame）。
//!    整条命令走 `session::spawn_args` **直启 node**，不经 `cmd /C` —— 整行 + 内层引号
//!    会被 cmd 的引号剥离规则拆坏（实测：cli.js 路径带引号时 node 收到的是被剥得只剩盘符的路径）。
//!    **一个会话一个进程、好几个会话可以同时在跑**（界面上一次只画一个，但它们各跑各的）。
//! 2. **密钥只走环境变量**：命令行参数在进程列表里是明文（任务管理器就能看见），
//!    环境变量只属于这个子进程。密钥取自 Windows 凭据管理器（`ai/<provider>` 一条），
//!    渲染层从头到尾不知道它。
//! 3. **替 Pi 关掉它自己那三条出网旁路**：安装 / 更新遥测、向 pi.dev 的版本检查，
//!    以及 RPC 模式启动时的模型目录刷新（`PI_OFFLINE=1` —— print 模式没有这一下，
//!    换到 RPC 才出现，实测不影响真正的模型请求）。应用对用户的承诺是「只在用户显式开启的
//!    出口上出网」，这三条都不在其中（见 AGENTS.md 第 1 节与架构文档的「数据与隐私」）。
//! 4. **权限模式的落点**：`auto-edit` 时写一份 Pi 扩展（`permission.js`，一个 `tool_call`
//!    钩子）并以 `-e` 加载 —— 模型要执行命令时它先 `ctx.ui.confirm`，宿主（也就是本应用）
//!    把这一次询问画成日志里的确认条，答复原路回给 Pi；`full` 不加载任何扩展，
//!    所有工具都直接跑。**「不问」是「没有扩展」，不是扩展里判了一下** —— 结构上就没有询问。
//! 5. **会话留档的落点**：会话文件由 Pi 自己写，位置用 `--session-dir` 钉在应用的数据目录下
//!    （`%APPDATA%\Workbench\data\pi\sessions`，不碰用户全局的 `~/.pi`）。**一段对话就是
//!    一份文件、一个 session-id**：同一个 id 再起进程就等于接着那段聊（实测：进程杀掉后
//!    按同一个 id 重开，`get_messages` 读得回全部历史；杀在半路也不留半行坏数据）。
//!    「连续多轮」与「重启后还在」靠的就是它，不是应用自己攒上下文。删除会话时也由这里
//!    按 id 找文件删掉（见 `session_delete`）。
//! 6. **模型与端点**：AI 服务（可能有几个）整份写成 Pi 的 `models.json`（`models_write`）；
//!    「添加服务」里那一下「拉模型列表」（`models_fetch`）打的是**用户自己那个端点**的
//!    `/models` —— 同一个主机、同一把 Key，只是换个路径（本机服务也在内），
//!    渲染层点了「获取列表」或粘完 Key 才走。
//! 7. **技能**：这一轮启用的技能**逐个目录**用 `--skill` 交给 Pi（`pi_skills.rs`）——
//!    Pi 的 RPC 这条路不扫默认技能目录，只有 `--skill` / settings.json / 扩展三种来源，
//!    应用用第一种。装/卸/开关都发生在用户自己那两个 `.agents/skills` 里，下次起进程才生效。
//!
//! 程序与参数的形状在渲染层（`src/shared/ai.ts`，那边有单测）：TS 给 `program` 与
//! `args`（内置模式 `node <cli.js>`、退路 `pi`，含 `--session-id`），这里只管写扩展文件、
//! 取密钥、拼环境变量、补上会话文件目录（`--session-dir`）与技能（`--skill`）、
//! 把提示词写进 stdin。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 密钥在凭据管理器里的 provider 前缀：一个提供方一条 `Workbench/ai/<provider>/token`
const KEY_PROVIDER_PREFIX: &str = "ai";

/// 内置 Pi 的 CLI 入口（相对 `resources/pi/`；由 scripts/vendor-pi.mjs 生成）
const BUNDLED_CLI_REL: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

/// 一次最多交给 Pi 几条技能。每条占两个参数（`--skill` + 路径），几百条也只是几 KB 的命令行
/// —— 这个数拦的是「技能根被指到一个塞满目录的地方」那种失控，不是性能参数。
const MAX_SKILLS: usize = 200;

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

/// 会话文件目录（交给 Pi 的 `--session-dir`）：一段对话一份 `<时间戳>_<session-id>.jsonl`。
///
/// 钉在应用的数据目录下是**故意的**：默认落点是用户全局的 `~/.pi/agent/sessions/`，
/// 而这个应用对用户的承诺是自己的东西自己收着（与 PI_CODING_AGENT_DIR 同一条理由）。
/// 名字里的时间戳是 Pi 自己的写法（同一 id 只会有一份，见文件头第 5 条），
/// 所以找文件不认文件名、认首行那个 header 里的 id（见 `session_delete`）。
fn sessions_dir() -> PathBuf {
    agent_dir().join("sessions")
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

    // 全局技能根（`%USERPROFILE%\.agents\skills`）：渲染层拿它扫列表、拼开关状态。
    // 拿不到用户目录时是空串，界面据此把全局那一栏说明白（不显示一个拼错的路径）
    json!({
        "source": source,
        "cli": cli,
        "pi": pi,
        "node": node,
        "detail": detail,
        "skillRoot": crate::pi_skills::global_root().unwrap_or_default(),
    })
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

/// 权限模式（设置里的 `aiPermission`，形状与收敛在 shared/ai.ts）。
/// **只把 `full` 当"不问"** —— 认不出的值一律按自动编辑走，权限这种事不靠猜。
const PERMISSION_FULL: &str = "full";

/// 自动编辑模式那份 Pi 扩展的文件名（落在 agent 目录下，与 models.json 同一个地方）
const PERMISSION_EXTENSION: &str = "permission.js";

/// 那份扩展的全文。**它是一个 `tool_call` 钩子**：模型要执行命令时先问一句，
/// 答「不允许」就把这次调用挡回去（`reason` 会作为工具结果交给模型，它自己会改主意）。
/// 其余工具（read / write / edit / grep / find / ls）一概不碰。
///
/// `ctx.ui.confirm` 在 RPC 模式下就是 stdout 上的一条 `extension_ui_request`：
/// 确认条画在运行面板里（workbench/ai.ts → stores/ai.ts → AiRunPanel.vue），
/// 答复经 session::write_stdin 回同一条 stdin。
const PERMISSION_EXTENSION_SOURCE: &str = r#"// 由 Workbench 生成（见 src-tauri/src/ai.rs），勿手改：应用在它变样时会重写一遍。
// 它只做一件事 —— 模型要执行命令时先问宿主一句，答「不允许」就把这次调用挡回去。
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return
    const command = event.input && typeof event.input.command === "string" ? event.input.command : ""
    const allowed = await ctx.ui.confirm("执行命令前先确认", command)
    if (!allowed) return { block: true, reason: "用户在 Workbench 里没有允许这条命令" }
  })
}
"#;

/// 渲染层传进来的一张图（用户贴在输入框里、随这一句发出去的那些）。
///
/// **形状对 Pi 的 `ImageContent`**（`{type:'image', data, mimeType}`，见它 rpc-types.d.ts）：
/// 这里只有后两个字段，`type` 由 `prompt_frame` 补上。`data` 是 base64、不带 `data:` 前缀
/// —— 渲染层从数据 URL 的逗号后面切出来（shared/ai.ts 的 aiImagePayload，有单测）。
///
/// **键名与渲染层成一字不差的对**（`data` / `mimeType`）：serde 对认不出的键是静默丢弃，
/// 名字对不上时两边单测都会绿（models.json 那边踩过一次同类坑，见 ModelInput 的注释）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub data: String,
    pub mime_type: String,
}

/// 这一轮启用的一个技能：根 + 技能名（就是那份技能目录的名字）。
///
/// 渲染层只知道「哪些技能开着」，路径由这里拼（它不碰分隔符，见 `pi_skills::skill_path`）。
/// 名字与根都要过闸：这两个值最终会拼成命令行上的一个路径。
#[derive(serde::Deserialize)]
pub struct AiSkillRef {
    pub root: String,
    pub id: String,
}

/// 提示词那一行（RPC 协议的 `prompt` 命令）。**一行 JSON，末尾的 `\n` 由 write_stdin 补** ——
/// 中文与换行都靠 JSON 转义带进去，不再落临时文件、也不经过命令行。
///
/// `images` 是用户随这一句贴的图（Pi 的 `prompt` 命令收 `images?: ImageContent[]`）。
/// 一张都没有时不写这个键 —— 免得给每个不带图的会话都塞一个空数组。
/// **同一行里的 base64 可能有好几 MB**：`session::write_stdin` 一次写整行（它自己补 `\n`），
/// 这里只保证是**一行**。
fn prompt_frame(prompt: &str, images: &[ImageInput]) -> String {
    let mut frame = json!({ "type": "prompt", "message": prompt });
    let list: Vec<Value> = images
        .iter()
        .filter(|image| !image.data.trim().is_empty() && !image.mime_type.trim().is_empty())
        .map(|image| {
            json!({
                "type": "image",
                "data": image.data,
                "mimeType": image.mime_type,
            })
        })
        .collect();
    if !list.is_empty() {
        frame["images"] = Value::Array(list);
    }
    frame.to_string()
}

/// 把「自动编辑」那份扩展写到 agent 目录，返回它的路径（交给 `-e`）。
///
/// **内容一样就不重写**：好几个会话可以同时起进程（见文件头第 1 条），每次都截断重写的话，
/// 另一个进程可能正好在这会儿加载它、读到半份文件。
fn write_permission_extension(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("创建 Pi 配置目录失败：{err}"))?;
    let path = dir.join(PERMISSION_EXTENSION);
    if std::fs::read_to_string(&path).is_ok_and(|text| text == PERMISSION_EXTENSION_SOURCE) {
        return Ok(path);
    }
    std::fs::write(&path, PERMISSION_EXTENSION_SOURCE)
        .map_err(|err| format!("写权限扩展失败：{err}"))?;
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

/// Pi 认的那七个思考档位（它自己的 defaults.js；`thinkingLevelMap` 只收这几个键）。
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 一个服务的上限（与渲染层的 AI_PROVIDER_MAX / AI_MODEL_MAX 是同一个数，改要一起改）
const PROVIDER_MAX: usize = 12;
const MODEL_MAX: usize = 32;

/// 渲染层传进来的一个模型（形状对 shared/ai.ts 的 AiModelEntry）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInput {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 上下文窗口；0（或负数）表示不知道 —— 那就不落这个字段，Pi 按它的默认值兜底
    #[serde(default)]
    pub context_window: f64,
    /// 最大输出；同一条口径（0 = 不落字段，Pi 按 16384 兜底）
    #[serde(default)]
    pub max_tokens: f64,
    #[serde(default)]
    pub reasoning: bool,
    /// Pi 的 `thinkingLevelMap`：档位 → 这一家的取值，或 null（不支持这一档）。
    /// **算它的是渲染层**（shared/ai.ts 的 aiThinkingMap，有单测）—— 那条规则只写一处，
    /// 这里只按 Pi 认的七个档位过滤一遍。
    #[serde(default)]
    pub thinking_level_map: std::collections::HashMap<String, Option<String>>,
    /// 能不能看图：真时写 `"input": ["text", "image"]`。**不写 Pi 就按 `["text"]` 算** ——
    /// read 读图、工具结果里的截图都会被它丢掉，只给模型留一句「图附在这儿了」。
    /// **键名与渲染层 payload 一字不差**（shared/ai.ts 的 AiProviderPayload 发 `imageInput`）——
    /// serde 对认不出的键是静默丢弃，两边名字对不上时哪边单测都不会红（踩过）。
    #[serde(default)]
    pub image_input: bool,
}

/// 渲染层传进来的一个服务（形状对 shared/ai.ts 的 AiProvider）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub base_url: String,
    pub api: String,
    #[serde(default)]
    pub models: Vec<ModelInput>,
}

/// Base URL 的形状校验：http(s):// 开头、有点内容
fn validate_base_url(base_url: &str) -> Result<&str, String> {
    let url = base_url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Base URL 要以 http(s):// 开头".into());
    }
    Ok(url)
}

/// 一个服务在 models.json 里的那一条（`apiKey` 是环境变量引用，不落明文）。
fn provider_entry(name: &str, base_url: &str, api: &str, models: Vec<Value>) -> Value {
    let label = name.trim();
    let mut entry = json!({
        "baseUrl": base_url.trim(),
        "api": api,
        "apiKey": format!("${KEY_ENV}"),
        "models": models,
    });
    if !label.is_empty() {
        entry["name"] = json!(label);
    }
    entry
}

/// 模型清单 → models.json 的 `models` 数组：去空白、去重（保序）、限长限量。
///
/// 五样东西的写法跟着 Pi 的 schema 走（dist/core/model-config.js 的 ModelDefinitionSchema）：
/// `contextWindow` / `maxTokens` 必须大于 0（不知道就整个字段不写，Pi 的默认是 128000 /
/// 16384）、`reasoning` 不写就是 false、`thinkingLevelMap` 里 `null` 表示这一档不支持、
/// `input` 不写就按 `["text"]` 算（图会被 Pi 丢掉）。
fn model_definitions(models: &[ModelInput]) -> Result<Vec<Value>, String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for model in models {
        let id = model.id.trim();
        if id.is_empty() || seen.iter().any(|existing| existing == id) {
            continue;
        }
        if id.len() > 120 {
            return Err(format!("模型名过长：{id}"));
        }
        seen.push(id.to_string());

        let name = model.name.trim();
        let mut entry = json!({ "id": id });
        if !name.is_empty() && name != id {
            entry["name"] = json!(name);
        }
        if model.context_window.is_finite() && model.context_window > 0.0 {
            entry["contextWindow"] = json!(model.context_window.floor() as u64);
        }
        if model.max_tokens.is_finite() && model.max_tokens > 0.0 {
            entry["maxTokens"] = json!(model.max_tokens.floor() as u64);
        }
        entry["reasoning"] = json!(model.reasoning);
        if model.reasoning && !model.thinking_level_map.is_empty() {
            let mut map = serde_json::Map::new();
            for level in THINKING_LEVELS {
                if let Some(value) = model.thinking_level_map.get(level) {
                    map.insert(
                        level.to_string(),
                        match value {
                            Some(text) => json!(text),
                            None => Value::Null,
                        },
                    );
                }
            }
            if !map.is_empty() {
                entry["thinkingLevelMap"] = Value::Object(map);
            }
        }
        if model.image_input {
            entry["input"] = json!(["text", "image"]);
        }
        out.push(entry);
    }
    if out.is_empty() {
        return Err("至少要有一个模型".into());
    }
    if out.len() > MODEL_MAX {
        return Err(format!("模型太多了（上限 {MODEL_MAX} 个）"));
    }
    Ok(out)
}

/// 写全部 AI 服务的 `models.json`（Pi agent 目录下，`PI_CODING_AGENT_DIR` 指过去的那份）。
///
/// 这是「模型管理」的落点：弹窗里加 / 改 / 停用之后，渲染层把**当前启用着的服务**整理好
/// 一次传进来，这里整份重写（不做增量 —— 增量会在文件里留下上一次的残影）。
/// `apiKey` 写成 `$WORKBENCH_AI_KEY`（Pi 的环境变量插值）：真正的密钥在凭据管理器里、
/// 只在起进程时进环境变量，这份文件从头到尾只有占位引用，**不落明文**。
pub fn models_write(providers: &[ProviderInput]) -> Result<(), String> {
    let file = build_models_json(providers)?;
    write_models_json(&agent_dir(), &file)
}

/// 服务清单 → models.json 的内容（纯函数，不碰盘：单测直接打它）。
fn build_models_json(providers: &[ProviderInput]) -> Result<Value, String> {
    if providers.is_empty() {
        return Err("至少要有一个 AI 服务".into());
    }
    if providers.len() > PROVIDER_MAX {
        return Err(format!("服务太多了（上限 {PROVIDER_MAX} 个）"));
    }

    let mut map = serde_json::Map::new();
    for provider in providers {
        let id = key_provider(&provider.id)?;
        if map.contains_key(&id) {
            return Err(format!("服务名重复：{id}"));
        }
        let base_url = validate_base_url(&provider.base_url)?;
        if !API_FORMATS.contains(&provider.api.as_str()) {
            return Err(format!("API 形态不认识：{}", provider.api));
        }
        let models = model_definitions(&provider.models)?;
        map.insert(
            id,
            provider_entry(&provider.name, base_url, &provider.api, models),
        );
    }

    Ok(json!({ "providers": Value::Object(map) }))
}

/// models.json 的实际落盘（`dir` 即 Pi 的 agent 目录）。拆出来是为了让单测能直打，
/// 不必去改 APPDATA 环境变量。
fn write_models_json(dir: &Path, file: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("创建 Pi 配置目录失败：{err}"))?;
    let text =
        serde_json::to_string_pretty(file).map_err(|err| format!("生成 models.json 失败：{err}"))?;
    std::fs::write(dir.join("models.json"), text).map_err(|err| format!("写 models.json 失败：{err}"))
}

// ---------- 拉模型列表（「添加服务」弹窗里粘完 Key 那一下） ----------

/// 一次最多回几个模型：目录再长，界面里也就是一列挑几个。
const FETCH_MAX: usize = 500;

/// 模型列表的地址。**按 Pi 的约定推出来**（它自己怎么拼，这里就怎么拼）：
/// `openai-completions` 的 baseUrl 本来就含 `/v1`（如 `https://api.openai.com/v1`），
/// 列表就在 `{baseUrl}/models`；`anthropic-messages` 的 baseUrl 到主机为止
/// （SDK 自己接 `/v1/messages`），列表在 `{baseUrl}/v1/models` —— 用户填成带 `/v1`
/// 的中转地址时不再补一层。
fn models_url(base_url: &str, api: &str) -> Result<String, String> {
    let base = validate_base_url(base_url)?.trim_end_matches('/').to_string();
    let needs_v1 = api == "anthropic-messages" && !base.to_lowercase().ends_with("/v1");
    Ok(format!("{base}{}/models", if needs_v1 { "/v1" } else { "" }))
}

/// 从**用户自己那个端点**拉一份模型列表（同一个主机、同一个 Key，只是换了个路径）。
/// `secret` 空串表示用凭据管理器里存着的那把（编辑一个已经保存过的服务时不必重填）。
///
/// 回给渲染层的是 `[{ id, name, contextWindow, reasoning }]`：**端点说多少就是多少**，
/// 它没提的那两样给 0 / null，由渲染层按名字兜底、用户在那一行上改。
pub fn models_fetch(
    base_url: &str,
    api: &str,
    provider: &str,
    secret: &str,
) -> Result<Vec<Value>, String> {
    let url = models_url(base_url, api)?;
    let key = match secret.trim() {
        "" => {
            let provider = key_provider(provider)?;
            crate::credentials::read(&credential_provider(&provider)).unwrap_or_default()
        }
        given => given.to_string(),
    };
    if key.is_empty() {
        return Err("先填上 API Key（或者先在设置里保存一次）".into());
    }

    // 两家的鉴权不一样：Anthropic 是 `x-api-key` + 版本头，OpenAI 那套是 Bearer
    let bearer;
    let headers: Vec<(&str, &str)> = if api == "anthropic-messages" {
        vec![
            ("x-api-key", key.as_str()),
            ("anthropic-version", "2023-06-01"),
            ("Accept", "application/json"),
            ("User-Agent", "Workbench"),
        ]
    } else {
        bearer = format!("Bearer {key}");
        vec![
            ("Authorization", bearer.as_str()),
            ("Accept", "application/json"),
            ("User-Agent", "Workbench"),
        ]
    };

    let response = crate::http::request_url("GET", &url, &headers, None)
        .map_err(|err| format!("连不上这个端点：{err}"))?;
    if response.status != 200 {
        // 401/403 是最常见的一种：地址对了、Key 不对（或者没权限）
        let hint = match response.status {
            401 | 403 => "端点没认这把 Key",
            404 => "这个地址下没有模型列表接口",
            _ => "端点回了一个错误",
        };
        return Err(format!(
            "{hint}（HTTP {}）｜{}",
            response.status,
            excerpt(&response.text())
        ));
    }

    parse_models(&response.text())
}

/// 出错时把那一段响应截下来给用户看：各家报错的形状不一样，猜不如原文。
fn excerpt(body: &str) -> String {
    let text = body.trim();
    let cut: String = text.chars().take(200).collect();
    if cut.is_empty() {
        "（没有响应内容）".into()
    } else {
        cut
    }
}

/// 端点回的模型列表 → 统一的形状。**几种常见的写法都认**：
/// `{"data":[…]}`（OpenAI / Anthropic / OpenRouter）、`{"models":[…]}`、以及顶层数组；
/// 每一条的 id 取 `id` / `model` / `name`，上下文与思考在十来个字段名里找
/// （各家叫法不同，认不出就是没有）。
fn parse_models(body: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "端点回的不是 JSON（这个地址多半不是那个 API）".to_string())?;
    let items = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array())
        .ok_or_else(|| "认不出这份模型列表（既没有 data 也没有 models）".to_string())?;

    let mut list: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        let Some(id) = model_id(item) else { continue };
        if seen.iter().any(|existing| existing == &id) {
            continue;
        }
        seen.push(id.clone());
        list.push(json!({
            "id": id,
            "name": model_label(item, &id),
            "contextWindow": model_context(item),
            "maxTokens": model_max_output(item),
            "reasoning": model_reasoning(item),
        }));
    }

    list.sort_by(|left, right| {
        left["id"]
            .as_str()
            .unwrap_or("")
            .cmp(right["id"].as_str().unwrap_or(""))
    });
    list.truncate(FETCH_MAX);
    if list.is_empty() {
        return Err("这个端点没有报出任何模型".into());
    }
    Ok(list)
}

/// 一条记录里的模型 id：`id` / `model` / `name` 三个字段名都见过
fn model_id(item: &Value) -> Option<String> {
    for key in ["id", "model", "name"] {
        let text = item.get(key).and_then(Value::as_str).unwrap_or("").trim();
        if !text.is_empty() {
            return Some(text.chars().take(120).collect());
        }
    }
    None
}

/// 显示名：端点给了就用（`display_name` 是 Anthropic 的叫法），没给就是 id
fn model_label(item: &Value, id: &str) -> String {
    for key in ["display_name", "displayName", "name", "label"] {
        let text = item.get(key).and_then(Value::as_str).unwrap_or("").trim();
        if !text.is_empty() && text != id {
            return text.chars().take(80).collect();
        }
    }
    id.to_string()
}

/// 上下文窗口：各家字段名不一样，都试一遍；都没有就是 0（不知道）。
/// 顶层没有时再看一层 `top_provider`（OpenRouter 那种把上限挂在这儿的写法）。
fn model_context(item: &Value) -> u64 {
    const KEYS: [&str; 10] = [
        "context_length",
        "contextLength",
        "context_window",
        "contextWindow",
        "max_context_length",
        "max_context_tokens",
        "max_input_tokens",
        "max_model_len",
        "inputTokenLimit",
        "input_token_limit",
    ];
    let find = |source: &Value| -> u64 {
        for key in KEYS {
            let size = match source.get(key) {
                Some(Value::Number(number)) => number.as_f64(),
                Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
                _ => None,
            };
            if let Some(size) = size {
                if size.is_finite() && size > 0.0 {
                    return size.floor() as u64;
                }
            }
        }
        0
    };
    let top = find(item);
    if top > 0 {
        return top;
    }
    find(item.get("top_provider").unwrap_or(&Value::Null))
}

/// 最大输出：同一条路子（OpenRouter 挂在 `top_provider.max_completion_tokens` 上，
/// 其余各家字段名不一），都没有就是 0（不知道 —— models.json 里不写，Pi 按它的默认兜底）。
fn model_max_output(item: &Value) -> u64 {
    const KEYS: [&str; 4] = [
        "max_completion_tokens",
        "maxCompletionTokens",
        "max_output_tokens",
        "maxOutputTokens",
    ];
    let find = |source: &Value| -> u64 {
        for key in KEYS {
            let size = match source.get(key) {
                Some(Value::Number(number)) => number.as_f64(),
                Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
                _ => None,
            };
            if let Some(size) = size {
                if size.is_finite() && size > 0.0 {
                    return size.floor() as u64;
                }
            }
        }
        0
    };
    let top = find(item);
    if top > 0 {
        return top;
    }
    find(item.get("top_provider").unwrap_or(&Value::Null))
}

/// 支不支持思考：端点明说就听它的（`reasoning` / `capabilities.reasoning` /
/// 支持的参数里带 reasoning 那几个），**没说回 null**（不是「不支持」——
/// 渲染层还要按模型名认一遍）。
fn model_reasoning(item: &Value) -> Option<bool> {
    if let Some(flag) = item.get("reasoning").and_then(Value::as_bool) {
        return Some(flag);
    }
    if let Some(flag) = item
        .get("capabilities")
        .and_then(|caps| caps.get("reasoning"))
        .and_then(Value::as_bool)
    {
        return Some(flag);
    }
    let parameters = item
        .get("supported_parameters")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .any(|name| name.contains("reasoning") || name == "thinking")
        });
    parameters
}

/// 在一条会话里跑一轮（会话没有活着的进程时先把它起起来）。
///
/// **接着聊就是接着那个进程**：会话已经有活着的进程时，只把这一轮的提示词写进它的 stdin
/// —— 上下文、模型、权限扩展都是那个进程的事（见文件头第 5 条）。没在跑时才起一个，
/// 参数里的 `--session-id` 会让 Pi 把盘上那份留档接起来（新会话就是新建一份）。
///
/// `prompt` 空串 = **只把进程起起来、不发提示词**：打开一个旧会话读历史（RPC 的
/// `get_messages`）走的就是这条路 —— 它要一根活着的 stdin 才答得出来。
///
/// 模型不在这里：它在渲染层拼好的参数里（`--provider` / `--model`，见 shared/ai.ts 的
/// piLaunch）。**别想着用环境变量指模型** —— 内置的 Pi 只认那两个参数，环境变量
/// `PI_MODEL` 它压根不读，会退到自己内置的提供方默认模型上（踩过：提供方叫
/// opencode-go 时实际请求的是它内置的 kimi-k2.6，清单里的模型一个字没用上）。
///
/// 返回子进程 pid；输出与退出照旧经 `session:lines` / `session:exit` 回推，
/// 渲染层按会话 id 前缀（`ai:`）接住（见 workbench/ai.ts）。
#[allow(clippy::too_many_arguments)]
pub fn run(
    app: &AppHandle,
    session_id: String,
    dir: String,
    prompt: String,
    images: Vec<ImageInput>,
    program: String,
    args: Vec<String>,
    provider: String,
    permission: String,
    skills: Vec<AiSkillRef>,
) -> Result<u32, String> {
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("这个会话没有工作目录".into());
    }
    if !Path::new(&dir).is_dir() {
        return Err(format!("找不到这个工作目录：{dir}"));
    }

    let sending = !prompt.trim().is_empty() || !images.is_empty();

    // 这条会话已经在跑：把提示词写进它那根 stdin 就行（进程、上下文、模型都留在那一份里）。
    // 写入失败要报出去 —— 「以为发出去了，其实没有」是这一页最坏的失败方式
    if let Some(pid) = crate::session::pid_if_alive(app, &session_id) {
        if sending {
            crate::session::write_stdin(app, &session_id, &prompt_frame(&prompt, &images))?;
        }
        return Ok(pid);
    }

    // 提供方名进凭据名与 models.json 的键，两处都得能对上；没配就别说「起不来」得莫名其妙
    let provider = key_provider(&provider)
        .map_err(|_| "还没有配置模型提供方（模型配置里那个名字）".to_string())?;
    // 密钥只在这一轮真要发提示词时是硬条件：打开旧会话读历史不该被一把没配的钥匙挡住
    let secret = crate::credentials::read(&credential_provider(&provider)).unwrap_or_default();
    if sending && secret.is_empty() {
        return Err(format!("还没有配置 {provider} 的 API Key"));
    }

    // 会话文件的落点由这里钉住（渲染层不知道数据目录在哪儿），与参数里的 --session-id
    // 一起决定这段对话是接着哪一份聊
    let mut argv = args;
    argv.push("--session-dir".to_string());
    argv.push(sessions_dir().to_string_lossy().into_owned());
    // 权限模式：只有「完全访问」不加载扩展（结构上就没有询问），其余一律按自动编辑走
    if permission != PERMISSION_FULL {
        let extension = write_permission_extension(&agent_dir())?;
        argv.push("-e".to_string());
        argv.push(extension.to_string_lossy().into_owned());
    }
    // 技能：**先把 Pi 自己的技能发现关掉**（`--no-skills`：它默认会扫 `~/.agents/skills`
    // 与（信任过的）项目里的 `.agents/skills`，还会加载 package / 扩展带来的技能），
    // 再把这一轮启用的**逐个技能目录**用 `--skill` 交过去（Pi 认「一个目录 + SKILL.md」，
    // 认了就不往里递归）。两条合起来才成立：应用那份表是**唯一**的真源 ——
    // 没启用、被卸掉、名字不合法的技能，Pi 那边就是看不见（不然「关掉」只是界面上关掉，
    // 模型照样能看到它）。实测：`-ns --skill <目录>` 之后 get_commands 只剩给出去的那几条。
    argv.push("--no-skills".to_string());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for skill in &skills {
        if seen.len() >= MAX_SKILLS {
            break;
        }
        let Ok(path) = crate::pi_skills::skill_path(&skill.root, &skill.id) else {
            continue;
        };
        if !path.is_dir() {
            continue;
        }
        // 同一个技能可能同时挂在全局与项目两栏上（同名不同根）：按整条路径去重
        if !seen.insert(path.to_string_lossy().to_lowercase()) {
            continue;
        }
        argv.push("--skill".to_string());
        argv.push(path.to_string_lossy().into_owned());
    }

    let envs = vec![
        // 这三条要排在最前：它们是「不要出网」的开关，别被后面任何一条覆盖掉
        ("PI_TELEMETRY".to_string(), "0".to_string()),
        ("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()),
        // RPC 模式启动时会去刷一遍模型目录（print 模式没有这一下）：那是一次计划外的出网，
        // 关掉之后实测真正的模型请求照常（见文件头的第 3 条）
        ("PI_OFFLINE".to_string(), "1".to_string()),
        // agent 目录指到应用自己的数据目录：models.json（自定义端点）与权限扩展在这里，
        // Pi 的 trust.json / auth.json 也收在这里，不与用户全局的 ~/.pi 掺和
        (
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir().to_string_lossy().into_owned(),
        ),
        // models.json 的 apiKey 引用的就是这个名字（见 provider_write 与 KEY_ENV 的注释）
        (KEY_ENV.to_string(), secret),
    ];

    // RPC 模式：提示词不是参数，是 stdin 上的一行 JSON。给会话配一根可写的管道
    // （别的会话不给 stdin），起完立刻写 —— 管道会先兜着，子进程读完 bootstrap 才来取
    let pid = crate::session::spawn_args(
        app,
        session_id.clone(),
        program,
        &argv,
        Some(dir),
        None,
        &envs,
    )?;

    if sending {
        if let Err(err) = crate::session::write_stdin(app, &session_id, &prompt_frame(&prompt, &images))
        {
            // 写不进去就别留一个不说话的进程在那儿：杀掉再报错
            let _ = crate::session::stop(app, &session_id);
            return Err(err);
        }
    }

    Ok(pid)
}

/// 删掉一条会话的留档（盘上的会话文件），返回删掉几个。
///
/// **调用方先把进程收掉**（适配层先 `stop_session` 再调这里）：活着的进程还在往文件里写，
/// 而 Windows 上删一个正被打开的文件会直接失败。
///
/// 认文件只认**首行那个 header**（`{"type":"session","id":…}`，Pi 的会话格式里定死的
/// 第一个字段）—— 文件名里的时间戳、目录分组都是它的实现细节，不拿它当判据。
pub fn session_delete(session_id: &str) -> Result<usize, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("没有指定要删除的会话".into());
    }
    remove_sessions_in(&sessions_dir(), id)
}

/// 递归找 `dir` 下属于 `id` 的会话文件并删掉。拆出来是为了能直接测：
/// 不必去动 APPDATA 环境变量。
fn remove_sessions_in(dir: &Path, id: &str) -> Result<usize, String> {
    if !dir.is_dir() {
        return Ok(0);
    }

    let mut removed = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(err) => {
                failures.push(format!("{} 读不了：{err}", current.display()));
                continue;
            }
        };
        for path in entries.flatten().map(|entry| entry.path()) {
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !is_session_file(&path, id) {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(err) => failures.push(format!("{} 删不掉：{err}", path.display())),
            }
        }
    }

    if failures.is_empty() {
        Ok(removed)
    } else {
        Err(format!(
            "已删除 {removed} 个会话文件，但{}",
            failures.join("；")
        ))
    }
}

/// 这份文件是不是 `id` 那条会话的留档：后缀是 `.jsonl`，且首行的 header 里 id 对得上。
/// 只读第一行（会话文件能到几 MB，为一个判断整份读进来不划算）。
fn is_session_file(path: &Path, id: &str) -> bool {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut first = String::new();
    if std::io::BufRead::read_line(&mut std::io::BufReader::new(file), &mut first).is_err() {
        return false;
    }
    let Ok(header) = serde_json::from_str::<Value>(first.trim()) else {
        return false;
    };
    header.get("type").and_then(Value::as_str) == Some("session")
        && header.get("id").and_then(Value::as_str) == Some(id)
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

    /// models.json 的生成：几个服务写在一起、apiKey 是环境变量引用（不落明文）、
    /// 上下文 / 思考照渲染层算好的落，缺的字段不写（Pi 那边有它自己的默认）
    #[test]
    fn models_write_puts_every_provider_in_one_file() {
        let dir = temp_root("models");
        let providers: Vec<ProviderInput> = serde_json::from_value(json!([
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "baseUrl": "https://api.deepseek.com/v1",
                "api": "openai-completions",
                "models": [
                    {
                        "id": "deepseek-reasoner",
                        "name": "DeepSeek Reasoner",
                        "contextWindow": 128000,
                        "reasoning": true,
                        "thinkingLevelMap": { "minimal": null, "xhigh": "xhigh" }
                    },
                    { "id": "deepseek-chat" }
                ]
            },
            {
                "id": "opencode-go",
                "name": "OpenCode Go",
                "baseUrl": "https://opencode.ai/zen/go/v1",
                "api": "openai-completions",
                "models": [{
                    "id": "deepseek-v4.1-flash",
                    "maxTokens": 384000,
                    "imageInput": true
                }]
            }
        ]))
        .unwrap();

        let file = build_models_json(&providers).unwrap();
        write_models_json(&dir, &file).unwrap();

        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert!(
            text.contains(r#""apiKey": "$WORKBENCH_AI_KEY""#),
            "apiKey 必须是环境变量引用，不能落明文：{text}"
        );
        assert_eq!(
            parsed["providers"]["deepseek"]["baseUrl"],
            json!("https://api.deepseek.com/v1")
        );
        assert_eq!(parsed["providers"]["deepseek"]["name"], json!("DeepSeek"));
        let reasoner = &parsed["providers"]["deepseek"]["models"][0];
        assert_eq!(reasoner["name"], json!("DeepSeek Reasoner"));
        assert_eq!(reasoner["contextWindow"], json!(128000));
        assert_eq!(
            reasoner["thinkingLevelMap"],
            json!({ "minimal": null, "xhigh": "xhigh" }),
            "只落渲染层算好的那几档"
        );
        // 没提上下文的那一条不写 contextWindow（写 0 会被 Pi 的 schema 挡下）
        let chat = &parsed["providers"]["deepseek"]["models"][1];
        assert_eq!(chat.get("contextWindow"), None);
        assert_eq!(chat["reasoning"], json!(false));
        let flash = &parsed["providers"]["opencode-go"]["models"][0];
        assert_eq!(flash["id"], json!("deepseek-v4.1-flash"));
        assert_eq!(flash["maxTokens"], json!(384000));
        assert_eq!(
            flash["input"],
            json!(["text", "image"]),
            "能看图的模型必须写 input，Pi 对没写的按 [\"text\"] 算、图会被它丢掉"
        );
        assert_eq!(chat.get("input"), None, "不能看图的不写（缺省就是纯文本）");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 校验：形态、Base URL、模型非空、服务重名与上限
    #[test]
    fn models_json_inputs_are_validated() {
        let ok = |value: Value| -> Vec<ProviderInput> { serde_json::from_value(value).unwrap() };

        assert!(build_models_json(&ok(json!([]))).is_err(), "一个服务都没有要挡住");
        assert!(
            build_models_json(&ok(json!([{
                "id": "x", "baseUrl": "ftp://x", "api": "openai-completions",
                "models": [{ "id": "a" }]
            }])))
            .is_err(),
            "Base URL 不成形要挡住"
        );
        assert!(
            build_models_json(&ok(json!([{
                "id": "x", "baseUrl": "https://x", "api": "grpc",
                "models": [{ "id": "a" }]
            }])))
            .is_err(),
            "认不出的 API 形态要挡住"
        );
        assert!(
            build_models_json(&ok(json!([{
                "id": "x", "baseUrl": "https://x", "api": "openai-completions", "models": []
            }])))
            .is_err(),
            "一个模型都没有要挡住"
        );
        assert!(
            build_models_json(&ok(json!([
                { "id": "x", "baseUrl": "https://x", "api": "openai-completions", "models": [{ "id": "a" }] },
                { "id": "x", "baseUrl": "https://y", "api": "openai-completions", "models": [{ "id": "b" }] }
            ])))
            .is_err(),
            "同名服务要挡住（后一个会盖掉前一个）"
        );
        assert!(
            build_models_json(&ok(json!([{
                "id": "Anthropic", "baseUrl": "https://x", "api": "openai-completions",
                "models": [{ "id": "a" }]
            }])))
            .is_err(),
            "服务名进凭据名，大写要挡住（与 key_provider 同一条）"
        );
    }

    /// 模型清单的收敛：去空白、去重保序、限长限量
    #[test]
    fn model_lists_are_normalized() {
        let models: Vec<ModelInput> = serde_json::from_value(json!([
            { "id": " deepseek-v4.1-flash " },
            { "id": "mimo-v2.6-flash" },
            { "id": "deepseek-v4.1-flash" },
            { "id": "  " }
        ]))
        .unwrap();
        let entries = model_definitions(&models).unwrap();
        assert_eq!(entries.len(), 2, "去空白、去重、丢空项");
        assert_eq!(entries[0]["id"], json!("deepseek-v4.1-flash"));
        assert_eq!(entries[1]["id"], json!("mimo-v2.6-flash"));
        assert_eq!(entries[0].get("name"), None, "显示名与 id 一样时不写");

        let long: Vec<ModelInput> =
            serde_json::from_value(json!([{ "id": "x".repeat(121) }])).unwrap();
        assert!(model_definitions(&long).is_err(), "超长要挡");
        let many: Vec<ModelInput> = serde_json::from_value(json!(
            (0..33)
                .map(|index| json!({ "id": format!("m{index}") }))
                .collect::<Vec<_>>()
        ))
        .unwrap();
        assert!(model_definitions(&many).is_err(), "超过 32 个要挡");
    }

    /// 模型列表的地址按 Pi 的约定推：OpenAI 那套的 baseUrl 本来就含 /v1，
    /// Anthropic 那套到主机为止（列表在 /v1/models），带 /v1 的中转地址不再补一层
    #[test]
    fn model_urls_follow_the_api_shape() {
        let url = |base: &str, api: &str| models_url(base, api).unwrap();
        assert_eq!(
            url("https://api.openai.com/v1", "openai-completions"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            url("http://localhost:11434/v1/", "openai-completions"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            url("https://api.anthropic.com", "anthropic-messages"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            url("https://x.example/anthropic/v1", "anthropic-messages"),
            "https://x.example/anthropic/v1/models"
        );
        assert_eq!(
            url("https://ark.cn-beijing.volces.com/api/v3", "openai-completions"),
            "https://ark.cn-beijing.volces.com/api/v3/models"
        );
        assert!(models_url("api.anthropic.com", "anthropic-messages").is_err());
    }

    /// 端点回的模型列表：三种常见形状都认，上下文与思考在十来个字段名里找，
    /// 端点没说的那两样给 0 / null（渲染层再按名字兜底）
    #[test]
    fn model_lists_are_parsed_leniently() {
        // OpenAI 那套：只有 id
        let openai =
            parse_models(r#"{"object":"list","data":[{"id":"gpt-4o"},{"id":"o3"}]}"#).unwrap();
        assert_eq!(openai.len(), 2);
        assert_eq!(openai[0]["id"], json!("gpt-4o"));
        assert_eq!(openai[0]["name"], json!("gpt-4o"), "没给显示名就用 id");
        assert_eq!(openai[0]["contextWindow"], json!(0));
        assert_eq!(openai[0]["reasoning"], Value::Null);

        // Anthropic 那套：display_name，顺序按下标排过就按 id 排
        let anthropic = parse_models(
            r#"{"data":[{"type":"model","id":"claude-z","display_name":"Claude Z"},{"id":"claude-a","display_name":"Claude A"}],"has_more":false}"#,
        )
        .unwrap();
        assert_eq!(anthropic[0]["id"], json!("claude-a"), "按 id 排好");
        assert_eq!(anthropic[0]["name"], json!("Claude A"));

        // OpenRouter 那套：context_length + supported_parameters
        let openrouter = parse_models(
            r#"{"data":[{"id":"x/y","name":"X: Y","context_length":200000,"supported_parameters":["tools","reasoning"]}]}"#,
        )
        .unwrap();
        assert_eq!(openrouter[0]["contextWindow"], json!(200000));
        assert_eq!(openrouter[0]["reasoning"], json!(true));

        // 最大输出：顶层与 top_provider 里的几个字段名都认，没有就是 0
        let output = parse_models(
            r#"{"data":[
                {"id":"o1","max_completion_tokens":32768},
                {"id":"o2","top_provider":{"max_completion_tokens":64000}},
                {"id":"o3"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(output[0]["maxTokens"], json!(32768));
        assert_eq!(output[1]["maxTokens"], json!(64000));
        assert_eq!(output[2]["maxTokens"], json!(0));

        // 顶层数组、models 键、capabilities 里那一位、字符串写的上下文、嵌套的 top_provider
        let bare = parse_models(r#"[{"model":"m1","capabilities":{"reasoning":false}}]"#).unwrap();
        assert_eq!(bare[0]["id"], json!("m1"));
        assert_eq!(bare[0]["reasoning"], json!(false));
        let nested =
            parse_models(r#"{"models":[{"id":"m2","top_provider":{"context_length":128000}}]}"#)
                .unwrap();
        assert_eq!(nested[0]["contextWindow"], json!(128000));
        let text_size = parse_models(r#"{"data":[{"id":"m3","context_window":"64000"}]}"#).unwrap();
        assert_eq!(text_size[0]["contextWindow"], json!(64000));

        // 同一份列表里的重复 id 只留一条；一条都没有 / 不是 JSON 要明说
        let dupe = parse_models(r#"{"data":[{"id":"m"},{"id":"m"}]}"#).unwrap();
        assert_eq!(dupe.len(), 1);
        assert!(parse_models(r#"{"data":[]}"#).is_err());
        assert!(parse_models("不是 JSON").is_err());
        assert!(parse_models(r#"{"hello":1}"#).is_err());
    }

    /// 拉模型列表这一条路真的走得通：本地起一个一次性的 HTTP 服务（**http + 自定端口** ——
    /// 本机服务就是这个样子，WinHTTP 那条分支只有真连一次才算验过），核对请求的路径与
    /// 鉴权头，再把回包按模型清单解析出来。
    #[test]
    fn fetches_a_model_list_from_a_local_endpoint() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = r#"{"object":"list","data":[{"id":"m1","context_length":128000}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            request
        });

        let models = models_fetch(
            &format!("http://127.0.0.1:{port}/v1"),
            "openai-completions",
            "local",
            "test-key",
        )
        .unwrap();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], json!("m1"));
        assert_eq!(models[0]["contextWindow"], json!(128000));

        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models"), "{request}");
        assert!(request.contains("Authorization: Bearer test-key"), "{request}");
    }

    /// 密钥没填、凭据管理器里也没有：当场说「先填 Key」，不发一个没鉴权的请求出去
    #[test]
    fn model_fetch_needs_a_key() {
        // 本机凭据管理器里没有 `ai/none/token` 这一条，所以这里必然停在这一步
        assert!(models_fetch("https://api.example/v1", "openai-completions", "none", "").is_err());
    }

    /// 提示词那一行：一行 JSON，中文与换行都靠转义带进去（走命令行必炸的那些字符在这里是安全的）
    #[test]
    fn prompt_frame_is_one_json_line() {
        let text = "# 提示词\n\n整理 data/raw 下的资料，按「条目格式规范」入库。\n";
        let frame = prompt_frame(text, &[]);

        assert!(!frame.contains('\n'), "必须是一行：{frame}");
        let parsed: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(parsed["type"], "prompt");
        assert_eq!(parsed["message"], text, "原文一字不差（含中文与换行）");
        // 不带图的这一句不该带 images 键（省得给每个会话都塞一个空数组）
        assert!(parsed.get("images").is_none(), "{frame}");
    }

    /// 随这一句贴的图：进同一行 JSON 的 `images`，形状是 Pi 的 ImageContent
    /// （`{type, data, mimeType}` —— 字段名错一个它就把图丢掉，与 models.json 那次同一条教训）
    #[test]
    fn prompt_frame_carries_pasted_images() {
        let images = vec![
            ImageInput {
                data: "iVBORw0KGgo=".into(),
                mime_type: "image/png".into(),
            },
            // 空的那两样（渲染层理论上不会发，但发进来了也别塞给 Pi）
            ImageInput {
                data: String::new(),
                mime_type: "image/png".into(),
            },
        ];
        let frame = prompt_frame("看看这两张图", &images);

        assert!(!frame.contains('\n'), "必须是一行：{frame}");
        let parsed: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(parsed["images"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["images"][0]["type"], "image");
        assert_eq!(parsed["images"][0]["data"], "iVBORw0KGgo=");
        assert_eq!(parsed["images"][0]["mimeType"], "image/png");
        assert_eq!(parsed["message"], "看看这两张图");
    }

    /// 权限扩展：落在 agent 目录下，内容里带着那个钩子（「自动编辑」的全部机制就是它）
    #[test]
    fn permission_extension_lands_on_disk() {
        let dir = temp_root("permission");

        let path = write_permission_extension(&dir).unwrap();
        assert_eq!(path.file_name().unwrap(), PERMISSION_EXTENSION);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(r#"pi.on("tool_call""#), "{text}");
        assert!(text.contains("ctx.ui.confirm"), "{text}");
        assert!(text.contains(r#"event.toolName !== "bash""#), "{text}");
        assert!(text.contains("block: true"), "{text}");

        // 内容对得上就不重写；改坏了（或被别的版本写过）要写回正确的那份
        std::fs::write(&path, "坏掉的").unwrap();
        write_permission_extension(&dir).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("tool_call"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 删会话：认的是**首行 header 里的 id**，别的会话、认不出的文件都不动
    #[test]
    fn session_delete_matches_the_header_id() {
        let dir = temp_root("sessions");
        let mine = dir.join("2026-01-01T00-00-00-000Z_keep-me.jsonl");
        // 目录分组那种写法（Pi 换分组方式时旧文件长这样）：递归扫，别漏
        let grouped_dir = dir.join("--E-Work--");
        let grouped = grouped_dir.join("2026-01-02T00-00-00-000Z_keep-me.jsonl");
        let other = dir.join("2026-01-03T00-00-00-000Z_other.jsonl");
        let garbage = dir.join("认不出的.jsonl");
        let not_session = dir.join("keep-me.txt");
        std::fs::create_dir_all(&grouped_dir).unwrap();

        let header = |id: &str| {
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"E:\\\\work\"}}\n{{\"type\":\"message\"}}\n"
            )
        };
        std::fs::write(&mine, header("keep-me")).unwrap();
        std::fs::write(&grouped, header("keep-me")).unwrap();
        std::fs::write(&other, header("other")).unwrap();
        std::fs::write(&garbage, "这不是 JSON\n").unwrap();
        std::fs::write(&not_session, header("keep-me")).unwrap();

        assert_eq!(remove_sessions_in(&dir, "keep-me").unwrap(), 2);
        assert!(!mine.exists(), "自己那份要删掉");
        assert!(!grouped.exists(), "分组目录里的那份也要删掉");
        assert!(other.exists(), "别人的会话不动");
        assert!(garbage.exists(), "认不出的文件不动");
        assert!(not_session.exists(), "不是 .jsonl 的不动");

        // 再删一次是 0（幂等，不报错）；目录压根不存在也当 0
        assert_eq!(remove_sessions_in(&dir, "keep-me").unwrap(), 0);
        assert_eq!(remove_sessions_in(&dir.join("没有这个目录"), "keep-me").unwrap(), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
