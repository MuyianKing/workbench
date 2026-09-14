//! IPC 命令层。
//!
//! 命名用 snake_case，渲染层的适配层负责把 camelCase 方法名映射过来，
//! 这样前端的 `WorkbenchApi` 契约不用改一个字。
//!
//! 这一层刻意做薄：只做「取原始数据 / 落盘 / 调系统能力」，不做业务语义。
//! 合并、排序、收敛、状态机都在 `src/shared/` 与渲染层，那边有测试、改起来也是 HMR 秒级。
//!
//! **命令的同步 / 异步约定**：`#[tauri::command]` 默认落在「阻塞」执行上下文 ——
//! 函数体会在 IPC 处理器所在的那个线程（也就是主线程）上内联跑完，所以「起一个子进程」
//! 或「解一张图」会把窗口消息循环一起堵住，表现是界面卡死而不是慢
//! （踩过一次：启动时的包管理器探测加壁纸缩略图，让整个窗口好几秒点不动）。
//! 因此凡是会起子进程、读写文件、解码图片、跑 SQL 的命令一律标 `(async)` ——
//! 宏会把它生成为 `async_runtime::spawn`，函数体落到工作线程上，主线程只管回包。
//! 只有纯内存读写与窗口控制保持同步：它们没有可观的等待。

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::paths;
use crate::store::JsonStore;
use crate::system;
use crate::token;

/// 主数据 / 首页布局 / token 快照各一份去抖存储
static DATA: OnceLock<JsonStore> = OnceLock::new();
static THEME: OnceLock<JsonStore> = OnceLock::new();
static TOKEN: OnceLock<JsonStore> = OnceLock::new();

pub fn data_store() -> &'static JsonStore {
    DATA.get_or_init(|| JsonStore::new(paths::data_file, "保存项目数据"))
}

pub fn theme_store() -> &'static JsonStore {
    THEME.get_or_init(|| JsonStore::new(paths::theme_file, "保存首页布局"))
}

pub fn token_store() -> &'static JsonStore {
    TOKEN.get_or_init(|| JsonStore::new(paths::token_file, "保存 token 用量数据"))
}

/// 启动时载入三份数据（原始 JSON；收敛由 TS 侧负责）
pub fn load_all() {
    data_store().load();
    theme_store().load();
    token_store().load();
}

/// 退出前同步落盘，防止防抖窗口内的改动丢失
pub fn flush_all() {
    data_store().flush_sync();
    theme_store().flush_sync();
    token_store().flush_sync();
}

// ---------- 数据文件 ----------

#[tauri::command]
pub fn data_load() -> Value {
    data_store().get()
}

#[tauri::command]
pub fn data_save(value: Value) {
    data_store().set(value);
    data_store().schedule();
}

#[tauri::command]
pub fn data_flush() {
    flush_all();
}

#[tauri::command]
pub fn theme_load() -> Value {
    theme_store().get()
}

#[tauri::command]
pub fn theme_save(value: Value) {
    theme_store().set(value);
    theme_store().schedule();
}

#[tauri::command]
pub fn token_load() -> Value {
    token_store().get()
}

#[tauri::command]
pub fn token_save(value: Value) {
    token_store().set(value);
    token_store().schedule();
}

#[tauri::command]
pub fn data_location() -> Value {
    let custom = paths::custom_dir();
    json!({
        "dir": paths::data_dir().to_string_lossy(),
        "file": paths::data_file().to_string_lossy(),
        "isDefault": custom.is_none(),
    })
}

#[tauri::command]
pub fn data_file_exists_in(dir: String) -> bool {
    paths::data_file_exists_in(&dir)
}

/// 迁移数据目录要真搬文件，不能挡在主线程上
#[tauri::command(async)]
pub fn data_migrate(dir: String) -> Result<(), String> {
    // 先把当前内存态同步落盘，迁移走的才是最新数据
    data_store().flush_sync();
    token_store().flush_sync();
    paths::migrate_data_dir(&dir, &data_store().get())
}

// ---------- 窗口控制 ----------

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

/// 自绘标题栏的第三个按钮：最大化 / 还原，返回切换后的状态
#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> bool {
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
    !maximized
}

/// 关闭按钮 = 收进托盘（与 Electron 版一致），退出只能从托盘菜单走
#[tauri::command]
pub fn window_close(window: WebviewWindow) {
    let _ = window.hide();
    let _ = window.set_skip_taskbar(true);
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

// ---------- Token 用量 ----------

#[tauri::command(async)]
pub fn token_zcode_rows() -> Result<Vec<Value>, String> {
    token::zcode_rows()
}

/// DSH 会话文件的多帧 zstd 解压：浏览器没有 zstd 解码 API，只能留在 Rust
#[tauri::command(async)]
pub fn token_zstd_decode(path: String) -> Result<String, String> {
    let buf = std::fs::read(path.as_str()).map_err(|err| format!("读取失败: {err}"))?;
    Ok(token::zstd_decode_frames(&buf))
}

/// 本机设备标识（Token 同步用）；首次调用生成并落盘
#[tauri::command(async)]
pub fn token_device() -> Result<Value, String> {
    crate::sync::device_info()
}

/// CodeBuddy 扩展日志的文件清单（路径 / 修改时间 / 大小），不含文件内容。
/// 内容由渲染层按需再读（`fs_read_text`）——日志加起来有近十兆，
/// 闲着的时候没必要每分钟搬一遍（见适配层里的签名缓存）。
#[tauri::command(async)]
pub fn token_codebuddy_files() -> Result<Value, String> {
    token::codebuddy_log_files()
}

/// DeepSeek Harness 的会话文件清单（路径 / 修改时间 / 大小），不含内容。
/// 内容要先逐帧解压，走 `token_zstd_decode`（浏览器没有 zstd 解码 API）。
#[tauri::command(async)]
pub fn token_dsh_sessions() -> Result<Value, String> {
    token::dsh_session_files()
}

/// WorkBuddy 的会话正文清单（路径 / 修改时间 / 大小），不含内容。
/// 正文没有压缩，渲染层自己按路径读回来解析（`fs_read_text`），不用再经 Rust 一趟。
#[tauri::command(async)]
pub fn token_workbuddy_sessions() -> Result<Value, String> {
    token::workbuddy_session_files()
}

/// 把本机分片写进同步仓库并推送；返回 `{ changed, pushed, log }`
#[tauri::command(async)]
pub fn token_sync_publish(repo: String, device: String, shard: Value) -> Result<Value, String> {
    crate::sync::publish(&repo, &device, &shard)
}

/// 读同步仓库里各台机器的分片（原始 JSON，收敛与合并由渲染层负责）。
/// 带上仓库地址：克隆指向的不是这个仓库时返回空表，免得把老仓库的分片当成最新的。
#[tauri::command(async)]
pub fn token_sync_shards(repo: String) -> Result<Vec<Value>, String> {
    crate::sync::read_shards(&repo)
}

// ---------- 系统能力 ----------

#[tauri::command(async)]
pub fn check_port(port: u16) -> Value {
    system::check_port(port)
}

#[tauri::command(async)]
pub fn kill_port_process(port: u16) -> Result<(), String> {
    system::kill_port_process(port)
}

/// 只发起、不等结果（explorer 是 spawn 出去的），所以留在主线程上没有代价
#[tauri::command]
pub fn reveal(path: String) {
    system::reveal(&path)
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    system::open_external(&url)
}

/// 探测 `<bin> --version`：可用返回版本串，不可用返回 null。
/// 包管理器检测与 Node 版本探测都走它。
///
/// 一次调用要起 `cmd /C <bin> --version`，Windows 上 npm 是 .cmd、还会再拉一个 node，
/// 冷启动能到秒级 —— 必须异步，否则启动时界面就是冻住的（这条是踩过的坑）。
#[tauri::command(async)]
pub fn probe_version(bin: String) -> Option<String> {
    crate::proc::probe_version(&bin)
}
/// 跑一条命令并把输出整份收回（带超时），用于 `npm install -g <pm>` 这类会长时间输出的操作。
/// 超时返回 `timedOut: true`，由调用方给出提示。
#[tauri::command(async)]
pub fn run_command(program: String, args: Vec<String>, timeout_ms: u64) -> Value {
    match crate::proc::run(&program, &args, std::time::Duration::from_millis(timeout_ms)) {
        Ok(outcome) => json!({
            "ok": outcome.ok(),
            "timedOut": outcome.timed_out,
            "stdout": outcome.stdout,
            "stderr": outcome.stderr,
        }),
        Err(err) => json!({
            "ok": false,
            "timedOut": false,
            "stdout": "",
            "stderr": err.to_string(),
        }),
    }
}

// ---------- 进程会话 ----------

/// 起一条命令（整行交 shell 执行），返回子进程 pid。
/// 输出与退出经 `session:lines` / `session:exit` 两个事件回推，
/// 映射成渲染层认识的事件形状由适配层负责。
#[tauri::command]
pub fn spawn_session(
    app: AppHandle,
    session_id: String,
    line: String,
    cwd: Option<String>,
    path_prepend: Option<String>,
) -> Result<u32, String> {
    crate::session::spawn(&app, session_id, line, cwd, path_prepend)
}

// ---------- nvm ----------

/// nvm 探测结果；形状与 shared 里的 NvmStatus 一致
#[tauri::command(async)]
pub fn nvm_status() -> Value {
    crate::nvm::status()
}

/// 某个 nvm 版本对应的安装目录，用于给子进程前置 PATH
#[tauri::command(async)]
pub fn nvm_node_dir(version: String) -> Option<String> {
    crate::nvm::find_node_dir(&version).map(|dir| dir.to_string_lossy().into_owned())
}

// ---------- nrm ----------

/// nrm（npm 镜像源管理器）状态：装没装、当前镜像、可切换的清单。
/// 一次调用要起 nrm（node 冷启动一秒上下），必须异步。
#[tauri::command(async)]
pub fn nrm_status() -> Value {
    crate::nrm::status()
}

/// 换一个 npm 镜像源；失败时把 nrm 自己的输出带回去当提示
#[tauri::command(async)]
pub fn nrm_use(name: String) -> Result<(), String> {
    crate::nrm::use_registry(&name)
}

// ---------- 快捷启动 ----------

/// 抽一张程序图标（data URL）；失败时带出原因（文件里没有图标资源 / 编码失败）
#[tauri::command(async)]
pub fn extract_icon(source: String) -> Result<String, String> {
    crate::icon::extract(&source)
}

/// 读一张图片、压到最长边 `maxEdge` 以内再编码成 data URL。
/// 给内置壁纸的缩略图用（设置面板里铺一排，原尺寸图白占内存）。
///
/// 解码 + 缩放 + 编码都是实打实的 CPU 活（2560 那张要遍历几百万像素），
/// 跑在主线程上就是一次可感知的卡顿，所以异步。
#[tauri::command(async)]
pub fn image_data_url(path: String, max_edge: u32, quality: u8) -> Result<String, String> {
    crate::imaging::data_url(&path, max_edge, quality)
}

// ---------- 工作区背景图 ----------

/**
 * 把一张背景图交给 webview 直接加载（asset 协议），返回后渲染层就能拿它的 asset URL 当图片用。
 *
 * 为什么要这么绕：背景图原本是我们解码 → 缩到 2560 → 编成 JPEG → base64 成 data URL 再交给
 * 渲染层，实测一张 3824×2400 的壁纸要 249ms，而且每次启动都重算一遍，产物是 270KB 的字符串
 * （换来的是"界面先出来、背景图晚一步到"）。改走 asset 协议之后我们不碰像素：webview 按文件
 * 读、自己解码并缩放，Rust 这边只剩这一次授权。
 *
 * 授权是**按文件**给的（tauri.conf.json 里 assetProtocol.scope 刻意留空）：
 * 用户没选过的路径读不到，别为了省事在那儿写 `**`。
 *
 * 顺手只读文件头核一遍它确实是张能解码的图 —— webview 解码失败是静默的（画不出来，
 * 控制台也没有），用户会以为自己选的图没问题，所以坏文件必须在这里就报出来。
 */
#[tauri::command(async)]
pub fn allow_background(app: AppHandle, path: String) -> Result<(), String> {
    crate::imaging::check_decodable(&path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|err| format!("无法把这张图交给界面加载：{err}"))
}

/// 用系统最自然的方式打开路径（ShellExecute）：快捷启动就靠它
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    system::open_path(&path)
}

/// 当前应用进程的 PID：写进会话记录当 ownerPid，
/// 下次启动时用它判断那些记录是「还有主」还是「上次被强杀留下的」
#[tauri::command]
pub fn app_pid() -> u32 {
    std::process::id()
}

/// 开机自启开关（Windows 上就是启动项里的一条注册表项）
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    // 开发态不动系统启动项：把 target/debug 下的可执行文件写进开机启动没有任何意义，
    // 却会真的改变开发机的行为（Electron 版同样只在打包后生效）。
    if cfg!(dev) {
        return Ok(());
    }

    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|err| format!("设置开机自启失败：{err}"))
}

/// 注册 / 更换全局快捷键；传 null 或空串表示清掉
#[tauri::command]
pub fn set_hotkey(app: AppHandle, accelerator: Option<String>) -> Result<(), String> {
    crate::register_hotkey(&app, accelerator)
}

/// 渲染层回传的退出选择：stop（结束全部进程）/ direct（保留进程）/ cancel（不退出）
#[tauri::command]
pub fn resolve_quit_choice(app: AppHandle, choice: String) {
    let waiting = {
        let state = app.state::<crate::PendingQuit>();
        let mut guard = state.0.lock().unwrap();
        guard.take()
    };

    if let Some(sender) = waiting {
        let _ = sender.send(choice);
    }
}

// ---------- 残留进程清理 ----------

/// 进程创建时间（毫秒，Unix 纪元）；打不开返回 null。
/// 残留清理用它判断「这个 PID 还是不是当初那个进程」。
#[tauri::command(async)]
pub fn process_created_at(pid: u32) -> Option<u64> {
    crate::proc::process_created_at(pid)
}

/// 按进程树结束指定 PID（清理残留进程用；清理前必须先核对命令行）
#[tauri::command(async)]
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    crate::proc::kill_process_tree(pid)
}

#[tauri::command]
pub fn stop_session(app: AppHandle, session_id: String) -> Result<(), String> {
    crate::session::stop(&app, &session_id)
}

#[tauri::command]
pub fn active_sessions(app: AppHandle) -> Vec<String> {
    crate::session::active_ids(&app)
}

/// 会话记录已在别处收尾（退出时已按树终止）后，把它从表里摘掉
#[tauri::command]
pub fn forget_session(app: AppHandle, session_id: String) {
    crate::session::forget(&app, &session_id)
}

// ---------- 文件读写（给渲染层的解析逻辑当数据源） ----------
//
// 这几个是批量调用的（每个项目 / 每个快捷启动各问一次），而项目目录可能落在
// 断开的网络盘上 —— 那时一次 `exists()` 要等 SMB 超时，几十秒起。一律异步。

#[tauri::command(async)]
pub fn fs_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|err| format!("读取失败: {err}"))
}

#[tauri::command(async)]
pub fn fs_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// 路径存在且是目录（扫描项目、判断产物目录都要用）
#[tauri::command(async)]
pub fn fs_is_dir(path: String) -> bool {
    PathBuf::from(&path).is_dir()
}

/// 文件的最后修改时间（毫秒）。图标缓存靠它判断「程序升级换了图标」而失效。
#[tauri::command(async)]
pub fn fs_stat_mtime(path: String) -> Option<u64> {
    std::fs::metadata(&path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as u64)
}

/// 列目录：只回元数据，怎么用由渲染层决定
#[tauri::command(async)]
pub fn fs_list_dir(path: String) -> Result<Vec<Value>, String> {
    let entries = std::fs::read_dir(&path).map_err(|err| format!("读取目录失败: {err}"))?;
    let mut out = Vec::new();

    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|dur| dur.as_millis() as u64)
            .unwrap_or(0);

        out.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "isDir": meta.is_dir(),
            "mtimeMs": mtime_ms,
        }));
    }
    Ok(out)
}


/// 内置壁纸目录：打包后走 resource_dir，开发态直接读仓库里的目录
/// （开发态资源不经过打包流程，不会出现在 target 下面）。
#[tauri::command(async)]
pub fn list_wallpapers(app: AppHandle) -> Vec<String> {
    fn candidates(app: &AppHandle) -> Vec<PathBuf> {
        let mut list = Vec::new();
        if let Ok(dir) = app.path().resource_dir() {
            list.push(dir.join("backgrounds"));
        }
        list.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("resources")
                .join("backgrounds"),
        );
        list
    }

    let Some(dir) = candidates(&app).into_iter().find(|path| path.is_dir()) else {
        return Vec::new();
    };

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut files: Vec<String> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    files.sort();
    files
}
