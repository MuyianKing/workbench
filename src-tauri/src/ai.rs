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
//!
//! 程序与参数的形状在渲染层（`src/shared/ai.ts`，那边有单测）：TS 给 `program` 与
//! `args`（内置模式 `node <cli.js>`、退路 `pi`，含 `--session-id`），这里只管写扩展文件、
//! 取密钥、拼环境变量、补上会话文件目录（`--session-dir`）、把提示词写进 stdin。

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

/// 提示词那一行（RPC 协议的 `prompt` 命令）。**一行 JSON，末尾的 `\n` 由 write_stdin 补** ——
/// 中文与换行都靠 JSON 转义带进去，不再落临时文件、也不经过命令行。
fn prompt_frame(prompt: &str) -> String {
    json!({ "type": "prompt", "message": prompt }).to_string()
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
    program: String,
    args: Vec<String>,
    provider: String,
    permission: String,
) -> Result<u32, String> {
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("这个会话没有工作目录".into());
    }
    if !Path::new(&dir).is_dir() {
        return Err(format!("找不到这个工作目录：{dir}"));
    }

    let sending = !prompt.trim().is_empty();

    // 这条会话已经在跑：把提示词写进它那根 stdin 就行（进程、上下文、模型都留在那一份里）。
    // 写入失败要报出去 —— 「以为发出去了，其实没有」是这一页最坏的失败方式
    if let Some(pid) = crate::session::pid_if_alive(app, &session_id) {
        if sending {
            crate::session::write_stdin(app, &session_id, &prompt_frame(&prompt))?;
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
        if let Err(err) = crate::session::write_stdin(app, &session_id, &prompt_frame(&prompt)) {
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

    /// 提示词那一行：一行 JSON，中文与换行都靠转义带进去（走命令行必炸的那些字符在这里是安全的）
    #[test]
    fn prompt_frame_is_one_json_line() {
        let text = "# 提示词\n\n整理 data/raw 下的资料，按「条目格式规范」入库。\n";
        let frame = prompt_frame(text);

        assert!(!frame.contains('\n'), "必须是一行：{frame}");
        let parsed: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(parsed["type"], "prompt");
        assert_eq!(parsed["message"], text, "原文一字不差（含中文与换行）");
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
