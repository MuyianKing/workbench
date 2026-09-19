// 发布态不要额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_news;
mod commands;
mod credentials;
mod encoding;
mod http;
mod icon;
mod imaging;
mod nrm;
mod notes;
mod nvm;
mod oauth;
mod paths;
mod proc;
mod session;
mod skills;
mod store;
mod sync;
mod system;
mod token;

use serde_json::{json, Value};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 最大化状态的上一次观测值：窗口事件推的是「变化」，不是每次 resize 都发
struct MaximizedFlag(Mutex<bool>);

/// 退出确认等待中的应答通道；渲染层回传选择后由这里唤醒
struct PendingQuit(Mutex<Option<Sender<String>>>);

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        // 隐藏期间任务栏按钮被摘掉了，重新显示时先装回来
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized {
            hide_main_window(app);
        } else {
            show_main_window(app);
        }
    }
}

/// 首屏快照的同步注入。
///
/// Tauri 没有 `sendSync` 那种同步 IPC，而渲染层要在 mount 之前拿到明暗与主题色，
/// 异步的话第一帧已经画完了（见 src/renderer/src/bootstrap.ts）。
/// 用初始化脚本在页面加载前把快照挂到 window 上，比同步 IPC 更彻底：
/// 它连一次跨进程往返都不需要，也不阻塞渲染线程。
///
/// 只注入原始设置与布局，不做 sanitize —— 收敛逻辑在 TS 侧，与异步路径用的是同一份。
fn bootstrap_script() -> String {
    let data = commands::data_store().get();
    let payload = json!({
        "settings": data.get("settings").cloned().unwrap_or(Value::Null),
        "themeConfig": commands::theme_store().get(),
    });
    format!("window.__WB_BOOTSTRAP__ = {payload};")
}

/**
 * 关掉 WebView2 自带的右键菜单（返回 / 刷新 / 另存为 / 打印 / 更多工具 / 检查）。
 *
 * WebView2 管这个菜单的开关是 `AreDefaultContextMenusEnabled`，Tauri 没把它暴露出来，
 * 只能在事件上拦：菜单是 `contextmenu` 的默认行为，preventDefault 掉就不弹了。
 * 挂在捕获阶段是抢在页面自己的处理之前，且**不** stopPropagation —— 将来渲染层要自建
 * 右键菜单仍然收得到事件。键盘上的菜单键 / Shift+F10 触发的是同一个事件，一并盖住。
 *
 * 放进初始化脚本而不是渲染层入口：它比其他任何页面脚本都早，连首帧之前那段空窗也盖住了。
 * 代价是原生菜单里的「检查」没了，调试改走 CDP 远程调试端口（见 AGENTS.md 第 6 节）。
 */
fn no_context_menu_script() -> &'static str {
    "window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });"
}

/// 窗口事件在窗口建好之后挂：Tauri 2 的 `WebviewWindowBuilder` 没有 `on_window_event`，
/// 事件要挂在窗口实例上（等价于 Electron 的 `mainWindow.on(...)`）。
fn attach_window_events(window: &tauri::WebviewWindow) {
    let handle = window.clone();

    window.on_window_event(move |event| match event {
        // 关闭按钮 = 收进托盘。托盘是常驻的，退出只能从托盘菜单走。
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.hide();
            let _ = handle.set_skip_taskbar(true);
        }
        // 最大化状态从窗口事件推，不由按钮自己记：拖边缘、双击标题栏、
        // 系统快捷键都能最大化，按钮只管画。
        tauri::WindowEvent::Resized(_) => {
            let maximized = handle.is_maximized().unwrap_or(false);
            // 先放开锁再发事件，避免在持锁期间触发重入
            let changed = {
                let flag = handle.state::<MaximizedFlag>();
                let mut last = flag.0.lock().unwrap();
                let changed = *last != maximized;
                *last = maximized;
                changed
            };
            if changed {
                let _ = handle.emit("window:state-changed", json!({ "maximized": maximized }));
            }
        }
        _ => {}
    });
}

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        // 只是启动那一瞬的占位：渲染层挂载后立刻用设置里的程序名覆盖它（见 commands::set_app_name）。
        // 取 package_info 而不是写死一个字面量，改 productName 时这里跟着走
        .title(app.package_info().name.clone())
        .inner_size(1360.0, 860.0)
        .min_inner_size(1080.0, 680.0)
        // 隐藏原生标题栏：最小化 / 最大化 / 关闭由渲染层自绘（components/TitleBar.vue）。
        // 代价是失去 Windows 11 最大化按钮上的贴靠布局，换来顶栏层次可以随便做。
        .decorations(false)
        // 首帧画好再显示，避免先闪一下白底
        .visible(false)
        .initialization_script(&bootstrap_script())
        .initialization_script(no_context_menu_script())
        .on_page_load(|window, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                let _ = window.show();
            }
        })
        .build()?;

    attach_window_events(&window);
    Ok(())
}

/// 托盘：常驻。左键唤起 / 收起，右键出菜单。
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        // 同窗口标题：占位用构建时的产品名，渲染层随后按设置里的程序名覆盖
        .tooltip(app.package_info().name.clone())
        .menu(&menu)
        // 左键单击留给「唤起窗口」，菜单只在右键出
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/**
 * 注册全局快捷键（传 None 表示清掉）。
 *
 * 先全清再注册：设置里改一次快捷键不该留下上一条还活着 ——
 * 那样按新旧两个键都会唤起窗口，很难查出原因。
 */
fn register_hotkey(app: &AppHandle, accelerator: Option<String>) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let Some(text) = accelerator
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let parsed = text
        .parse::<Shortcut>()
        .map_err(|_| format!("无法识别的快捷键：{text}"))?;
    manager
        .register(parsed)
        .map_err(|_| format!("快捷键注册失败，可能已被别的程序占用：{text}"))
}

/**
 * 真正的退出入口（托盘的「退出」）。
 *
 * 关闭按钮只是收进托盘，所以退出确认挪到了这里：只要还有进程在跑就先问一次，
 * 免得用户以为只是关窗口，结果在跑的 dev server 被一起收掉。
 * 三个选项与 Electron 版一致：结束全部进程再退 / 保留进程直接退 / 取消。
 */
fn request_quit(app: &AppHandle) {
    let active = session::active_ids(app);
    if active.is_empty() {
        commands::flush_all();
        app.exit(0);
        return;
    }

    let (tx, rx) = channel::<String>();
    *app.state::<PendingQuit>().0.lock().unwrap() = Some(tx);

    // 唤出窗口之前的状态（可见 / 最小化），取消退出时照着还原
    let mut before_show: Option<(bool, bool)> = None;

    if let Some(window) = main_window(app) {
        // 这个框是应用内的弹窗，不是系统消息框：窗口收在托盘里、最小化或压在别的程序后面时，
        // 弹了也没人看得见，而这边还要等 60 秒超时才按「直接退出」收场 —— 先把窗口唤到最前再推事件。
        let was = (
            window.is_visible().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
        );
        show_main_window(app);
        let _ = window.emit("app:quit-confirm", json!({ "count": active.len() }));
        before_show = Some(was);
    }

    // 等渲染层回传选择。等待放到独立线程里 —— 菜单事件是在主线程派发的，
    // 在这儿阻塞会把整个界面冻住。渲染层要是没响应（崩了 / 卡住），
    // 超时按「直接退出」处理：宁可留着进程，也不要卡住退不掉。
    let handle = app.clone();
    std::thread::spawn(move || {
        let choice = rx
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or_else(|_| "direct".to_string());
        *handle.state::<PendingQuit>().0.lock().unwrap() = None;

        match choice.as_str() {
            "cancel" => {
                // 不退了就把窗口放回唤出之前的样子：一次没退成，不该把藏在托盘里的窗口留在桌面上
                match before_show {
                    Some((false, _)) => hide_main_window(&handle),
                    Some((true, true)) => {
                        if let Some(window) = main_window(&handle) {
                            let _ = window.minimize();
                        }
                    }
                    _ => {}
                }
                return;
            }
            "stop" => session::stop_all(&handle),
            // "direct"：进程留在后台，交给下次启动的残留清理（reap）
            _ => {}
        }

        commands::flush_all();
        handle.exit(0);
    });
}

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：两个进程各持一份内存数据，后写的一次会把前一次的改动整个覆盖掉
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 开机自启：设置里改了就落一条注册表项（Windows 走的是启动项）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 全局快捷键：按下时唤起 / 收起窗口，与 Electron 版的全局快捷键同一行为
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(MaximizedFlag(Mutex::new(false)))
        .manage(session::Sessions::default())
        .manage(PendingQuit(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::data_load,
            commands::data_save,
            commands::data_flush,
            commands::theme_load,
            commands::theme_save,
            commands::token_load,
            commands::token_save,
            commands::work_log_load,
            commands::work_log_save,
            ai_news::ai_news_load,
            ai_news::ai_news_save,
            ai_news::ai_news_fetch,
            ai_news::ai_news_article,
            ai_news::ai_news_sources,
            commands::note_scan,
            commands::note_read,
            commands::note_write,
            commands::note_create,
            commands::note_rename,
            commands::note_move,
            commands::note_delete,
            commands::note_image_upload,
            commands::note_images_list,
            commands::note_images_delete,
            commands::note_scan_texts,
            commands::note_sync,
            commands::skill_list,
            commands::skill_commit,
            commands::skill_history,
            commands::skill_restore,
            commands::skill_version_compare,
            commands::skill_import,
            commands::skill_install,
            commands::skill_installed_versions,
            commands::skill_files,
            commands::data_dir,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            commands::window_is_maximized,
            commands::set_app_name,
            commands::app_version,
            commands::token_zcode_rows,
            commands::token_zstd_decode,
            commands::token_codebuddy_files,
            commands::token_dsh_sessions,
            commands::token_workbuddy_sessions,
            commands::token_qoder_sessions,
            commands::token_device,
            commands::token_sync_publish,
            commands::token_sync_config,
            commands::token_sync_shards,
            commands::auth_status,
            commands::auth_refresh_account,
            commands::auth_login_start,
            commands::auth_login_poll,
            commands::auth_login_submit,
            commands::auth_login_cancel,
            commands::auth_logout,
            commands::check_port,
            commands::kill_port_process,
            commands::reveal,
            commands::open_external,
            commands::open_in_vscode,
            commands::probe_version,
            commands::run_command,
            commands::spawn_session,
            commands::stop_session,
            commands::active_sessions,
            commands::forget_session,
            commands::nvm_status,
            commands::nvm_node_dir,
            commands::nrm_status,
            commands::nrm_use,
            commands::extract_icon,
            commands::image_data_url,
            commands::allow_background,
            commands::open_path,
            commands::app_pid,
            commands::set_autostart,
            commands::set_hotkey,
            commands::resolve_quit_choice,
            commands::process_created_at,
            commands::kill_process_tree,
            commands::fs_read_text,
            commands::fs_exists,
            commands::fs_is_dir,
            commands::fs_stat_mtime,
            commands::fs_list_dir,
            commands::list_wallpapers,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 数据先载入：窗口的初始化脚本要用到设置与布局
            commands::load_all();
            create_main_window(&handle)?;
            create_tray(&handle)?;

            // 按已存设置把快捷键装回来；占用之类的问题只记一笔，不拦启动
            let settings = commands::data_store()
                .get()
                .get("settings")
                .cloned()
                .unwrap_or(Value::Null);
            if settings.get("hotkeyEnabled").and_then(Value::as_bool).unwrap_or(true) {
                let hotkey = settings
                    .get("hotkey")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Err(err) = register_hotkey(&handle, hotkey) {
                    eprintln!("[workbench] {err}");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Workbench 初始化失败")
        .run(|app, event| match event {
            // 退出前同步落盘，防止防抖窗口内的改动丢失
            tauri::RunEvent::ExitRequested { .. } => {
                commands::flush_all();
            }
            // 再把本次会话起的进程按树收掉，避免 dev server 残留占着端口
            // （待补：Electron 版在还有项目在跑时会先弹窗问「结束全部 / 直接退出 / 取消」，
            //   现在是无条件结束，等于只保留了其中一种选择）
            tauri::RunEvent::Exit => {
                session::stop_all(app);
            }
            _ => {}
        });
}
