// 发布态不要额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// 生产代码里禁止裸 `unwrap()`：release 档是 `panic = "abort"`，一处 unwrap 失手就是进程
// 凭空消失（数据还在 300ms 去抖窗口里，也没机会落盘）。要显式终止就用 `expect("原因")`
// —— 它带得走一句话，还会落到 panic.log（见 panic_log.rs）。
// `cfg(test)` 下不设：用例里 unwrap 出真实原因本身就是它的价值。
// 配 `clippy.toml` 的 allow-unwrap-in-tests，`--all-targets` 也能干净通过。
#![cfg_attr(not(test), deny(clippy::unwrap_used))]

mod ai;
mod ai_news;
mod ball;
mod capture;
mod clipboard;
mod commands;
mod credentials;
mod design;
mod encoding;
mod fs_util;
mod http;
mod icon;
mod imaging;
mod kb;
mod mail;
mod mail_watch;
mod net;
mod nrm;
mod notes;
mod notify;
mod nvm;
mod oauth;
mod panic_log;
mod paths;
mod pi_skills;
mod pin;
mod proc;
mod screen;
mod session;
mod skills;
mod store;
mod sync;
mod system;
mod token;
mod vault;
mod video;
mod weather;
mod zentao;

use serde_json::{json, Value};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GW_HWNDPREV, GWL_EXSTYLE, GetWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId,
    IsWindowVisible, WS_EX_TOOLWINDOW,
};

/// 最大化状态的上一次观测值：窗口事件推的是「变化」，不是每次 resize 都发
struct MaximizedFlag(Mutex<bool>);

/// 退出确认等待中的应答通道；渲染层回传选择后由这里唤醒
struct PendingQuit(Mutex<Option<Sender<String>>>);

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

/// 唤出主窗口。托盘 / 全局快捷键走它，邮件通知被点击时也一样（mail_watch.rs）。
///
/// 任务栏按钮交给系统随 hide / show 自动摘装，不要手动 set_skip_taskbar：
/// 它走 ITaskbarList 的 DeleteTab / AddTab，AddTab 出来的按钮系统盯不住前台状态，
/// 点它会走「已激活 → 最小化」的切换，把压在别的程序后面的窗口收起来而不是调到前面。
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
}

/// 主窗口是不是被别的程序压住了：z 序排在它前面、可见、与它相交的顶层窗口里有一个就算。
///
/// 工具窗口（任务栏、托盘、输入法候选框这些 shell 自己的壳，实测都带 WS_EX_TOOLWINDOW）
/// 与本进程自己的窗口不算 —— 它们不是用户点开的「别的程序」，被它们挡住不影响
/// 「窗口就在眼前」这个判断。
fn covered_by_other_app(window: &tauri::WebviewWindow) -> bool {
    let Ok(hwnd) = window.hwnd() else { return false };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };

    let ours = RECT {
        left: position.x,
        top: position.y,
        right: position.x + size.width as i32,
        bottom: position.y + size.height as i32,
    };
    let this = hwnd.0;
    let pid = unsafe { GetCurrentProcessId() };

    // GetWindow 的 GW_HWNDPREV 是 z 序里的上一个窗口，一路往上就是压在它上面的那些
    let mut above = unsafe { GetWindow(this, GW_HWNDPREV) };
    while !above.is_null() {
        let ex_style = unsafe { GetWindowLongW(above, GWL_EXSTYLE) } as u32;
        if (ex_style & WS_EX_TOOLWINDOW == 0) && unsafe { IsWindowVisible(above) } != 0 {
            let mut other_pid = 0;
            unsafe { GetWindowThreadProcessId(above, &mut other_pid) };
            let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            let overlaps = unsafe { GetWindowRect(above, &mut rect) } != 0
                && rect.left < ours.right
                && rect.right > ours.left
                && rect.top < ours.bottom
                && rect.bottom > ours.top;
            if other_pid != pid && overlaps {
                return true;
            }
        }
        above = unsafe { GetWindow(above, GW_HWNDPREV) };
    }
    false
}

/// 托盘左键 / 全局快捷键：窗口没被别的程序压住就收起，被压住（或收在托盘、最小化）就调到前面。
///
/// 不能只看「可见」：窗口被别的程序遮住时照样可见，按可见就收起会把这一步做成
/// 「把程序收起来」，而那时想要的恰恰是「调到前面」（判定见 covered_by_other_app）。
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized && !covered_by_other_app(&window) {
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
        }
        // 最大化状态从窗口事件推，不由按钮自己记：拖边缘、双击标题栏、
        // 系统快捷键都能最大化，按钮只管画。
        tauri::WindowEvent::Resized(_) => {
            let maximized = handle.is_maximized().unwrap_or(false);
            // 先放开锁再发事件，避免在持锁期间触发重入
            let changed = {
                let flag = handle.state::<MaximizedFlag>();
                let mut last = flag.0.lock().expect("锁中毒");
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
        .initialization_script(bootstrap_script())
        .initialization_script(no_context_menu_script())
        .on_page_load(|window, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                let _ = window.show();
            }
        })
        // 邮件正文（sandbox iframe）里的链接统一 target="_top" 往顶层窗口导航
        // （见 @workbench/mail 的 htmlBody），在这里拦下：应用自己的页面照常放行，
        // 其余 http(s) / mailto 交给系统浏览器开，别的 scheme 一律取消 ——
        // 邮件的 HTML 不带宿主能力，这条边界不因放行链接而破。
        // 禅道窗口是另一扇窗（zentao.rs），有它自己的导航边界。
        .on_navigation(|url| {
            let url = url.as_str();
            let own = url.starts_with("http://tauri.localhost")
                || url.starts_with("https://tauri.localhost")
                || url.starts_with("tauri://localhost")
                || url.starts_with("about:");
            if own || (cfg!(dev) && url.starts_with("http://localhost:5274")) {
                return true;
            }
            if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
                let _ = crate::system::open_external(url);
            }
            false
        })
        .build()?;

    attach_window_events(&window);
    Ok(())
}

/// 托盘：常驻。左键把窗口调到前面（没被别的程序压住时才收起，见 toggle_main_window），右键出菜单。
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let shot = MenuItem::with_id(app, "capture", "截图", true, None::<&str>)?;
    let close_pins = MenuItem::with_id(app, "close-pins", "关闭所有钉图", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &shot,
            &close_pins,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        // 同窗口标题：占位用构建时的产品名，渲染层随后按设置里的程序名覆盖
        .tooltip(app.package_info().name.clone())
        .menu(&menu)
        // 左键单击留给「唤起窗口」，菜单只在右键出
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            // 截图与钉图都是「本体在别的窗口里」的动作：界面收在托盘时也点得到
            "capture" => capture::request(app),
            "close-pins" => pin::pin_close_all(app.clone()),
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
 * 一组全局快捷键（解析好之后的那份）。
 *
 * 两条各自独立：唤起/收起主窗口、起截图。**必须放在一处一起装**
 * —— 插件注册时用的是「先全清再逐条注册」，谁单独调一次都会把别人注销掉（见 register_hotkeys）。
 */
#[derive(Default, Clone)]
struct HotkeySet {
    main: Option<Shortcut>,
    capture: Option<Shortcut>,
}

/// 当前装着的那组快捷键。按下时按值比对派发（`Shortcut` 的 id 由修饰键与键码算出，同一串解析两次必然相等）。
#[derive(Default)]
struct Hotkeys(Mutex<HotkeySet>);

/// 把渲染层递上来的两串解析成一组快捷键。
///
/// **值一律由渲染层给**（见 register_hotkeys 的说明）：空串当作不要这一条；
/// 非空但认不出的那一串要报出来 —— 静默丢掉的话，界面上看着「设过了」，按下去却没反应。
fn parse_hotkeys(
    main: Option<String>,
    capture: Option<String>,
) -> Result<HotkeySet, String> {
    let parse = |name: &str, raw: Option<String>| -> Result<Option<Shortcut>, String> {
        let Some(text) = raw.map(|value| value.trim().to_string()) else {
            return Ok(None);
        };
        if text.is_empty() {
            return Ok(None);
        }
        text.parse::<Shortcut>()
            .map(Some)
            .map_err(|_| format!("{name}的快捷键认不出来：{text}"))
    };

    Ok(HotkeySet {
        main: parse("唤起窗口", main)?,
        capture: parse("截图", capture)?,
    })
}

/// 注册 / 更换**全部**全局快捷键（哪一项是 None 就是不要那一条）。
///
/// 先全清再逐条注册：设置里改一次快捷键不该留下上一条还活着 —— 那样按新旧两个键都会触发，
/// 很难查出原因。因此三条快捷键只能从这里一次性装好，调用方不许自己 register 一遍。
/// 单条失败（被别的程序占了）不拦其余的，最后把失败的几条一并报出来。
///
/// **值由渲染层推、Rust 自己不读设置**：默认值（默认 F1）只活在 `@workbench/capture` 里，
/// Rust 去盘上读的话，「刚加上的字段还没被写回盘」这一段时间就是空的 —— 首启时按 F1 没反应，
/// 而且之后再没有任何东西会去补注册（踩过一次，就是照着盘读的写法）。
fn register_hotkeys(app: &AppHandle, accelerators: HotkeySet) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let mut failed = Vec::new();
    for (name, shortcut) in [
        ("唤起窗口", accelerators.main),
        ("截图", accelerators.capture),
    ] {
        let Some(shortcut) = shortcut else { continue };
        if manager.register(shortcut).is_err() {
            failed.push(format!("{name}（{shortcut}）"));
        }
    }

    *app.state::<Hotkeys>().0.lock().expect("锁中毒") = accelerators;

    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("这些快捷键被别的程序占用了：{}", failed.join("、")))
    }
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
    *app.state::<PendingQuit>().0.lock().expect("锁中毒") = Some(tx);

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
        *handle.state::<PendingQuit>().0.lock().expect("锁中毒") = None;

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
    // 第一件事：release 档 panic 直接中止进程，只有这个钩子能把那一下记下来
    panic_log::install();

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
        // 全局快捷键：唤起 / 收起窗口、起截图 —— 按值比对分派
        // （三条快捷键的解析与注册都在 register_hotkeys 里）
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    let set = app.state::<Hotkeys>().0.lock().expect("锁中毒").clone();
                    if set.capture.as_ref() == Some(shortcut) {
                        // 抓屏 + 编码是几百毫秒的活，request 自己会丢到工作线程去（热键回调在主线程上）
                        capture::request(app);
                        return;
                    }
                    if set.main.as_ref() == Some(shortcut) {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(MaximizedFlag(Mutex::new(false)))
        .manage(Hotkeys::default())
        .manage(session::Sessions::default())
        .manage(PendingQuit(Mutex::new(None)))
        .manage(mail_watch::MailWatch::default())
        .manage(capture::CaptureState::default())
        .manage(pin::Pins::default())
        .manage(ball::BallState::default())
        .manage(zentao::ZentaoState::default())
        .manage(zentao::ZentaoWatch::default())
        .manage(zentao::ZentaoWindowState::default())
        .invoke_handler(tauri::generate_handler![
            commands::data_load,
            commands::data_save,
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
            weather::weather_geocode,
            weather::weather_forecast,
            mail::mail_key_save,
            mail::mail_key_state,
            mail::mail_key_clear,
            mail::mail_verify,
            mail::mail_list,
            mail::mail_fetch_body,
            mail::mail_set_seen,
            mail::mail_delete,
            mail::mail_send,
            mail::mail_attachment_save,
            mail_watch::mail_watch_register,
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
            commands::note_repo_state,
            commands::video_scan,
            commands::allow_video,
            commands::skill_list,
            commands::skill_state,
            commands::skill_sync,
            commands::skill_commit,
            commands::skill_history,
            commands::skill_restore,
            commands::skill_version_compare,
            commands::skill_import,
            commands::skill_install,
            commands::skill_installed_versions,
            commands::skill_files,
            commands::kb_scan,
            commands::kb_read,
            commands::kb_index_build,
            commands::ai_runtime,
            commands::ai_models_write,
            commands::ai_models_fetch,
            commands::ai_run,
            commands::ai_session_delete,
            commands::ai_key_save,
            commands::ai_key_state,
            commands::ai_key_clear,
            commands::pi_skill_list,
            commands::pi_skill_install_zip,
            commands::pi_skill_install_dir,
            commands::pi_skill_install_url,
            commands::pi_skill_remove,
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
            commands::zentao_login,
            commands::zentao_session,
            commands::zentao_logout,
            commands::zentao_page,
            commands::zentao_watch,
            commands::zentao_notify,
            commands::zentao_products,
            commands::zentao_open_window,
            commands::check_port,
            commands::kill_port_process,
            commands::reveal,
            commands::open_external,
            commands::open_in_vscode,
            commands::probe_version,
            commands::run_command,
            commands::spawn_session,
            commands::session_write,
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
            commands::apply_hotkeys,
            commands::resolve_quit_choice,
            commands::process_created_at,
            commands::kill_process_tree,
            commands::fs_read_text,
            commands::fs_read_base64,
            commands::fs_exists,
            commands::fs_is_dir,
            commands::fs_stat_mtime,
            commands::fs_list_dir,
            commands::design_write,
            commands::list_wallpapers,
            vault::vault_load,
            vault::vault_save,
            vault::vault_key_read,
            vault::vault_key_write,
            vault::vault_key_clear,
            vault::vault_key_export,
            vault::vault_key_import,
            vault::vault_verify_password,
            vault::vault_hello_state,
            vault::vault_unlock_hello,
            vault::vault_pull,
            vault::vault_push,
            capture::capture_begin,
            capture::capture_prewarm,
            capture::capture_abort,
            capture::capture_context,
            capture::capture_frame,
            capture::capture_show,
            capture::capture_copy,
            capture::capture_save,
            pin::pin_create,
            pin::pin_context,
            pin::pin_update,
            pin::pin_close,
            pin::pin_close_all,
            pin::pin_copy,
            pin::pin_save,
            ball::ball_apply,
            ball::ball_context,
            ball::ball_open,
            ball::ball_open_main,
            net::net_counters,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 数据先载入：窗口的初始化脚本要用到设置与布局
            commands::load_all();
            // 钉图的记账要早于窗口：restore 照着它把上次钉着的图开回来
            pin::load(&handle);
            // 悬浮球只读记账、不开窗：开不开由设置决定，值由渲染层在 initState 之后推
            // （ball_apply，见 workbench/index.ts 的 syncSystemIntegration）
            ball::load(&handle);
            create_main_window(&handle)?;
            create_tray(&handle)?;
            pin::restore(&handle);

            // 全局快捷键不在这里装：两条的值（含默认值）只有渲染层那份收敛过的设置里有，
            // 它在 initState 之后会调 apply_hotkeys 推一次（见 workbench/index.ts 的
            // syncSystemIntegration）；Rust 去数据文件里读会漏掉「刚加的字段还没写回盘」那一段。

            // 邮件后台监视：线程自己每分钟醒一次，到点（满登记的周期）查新邮件、弹通知。
            // 账户清单与周期由渲染层载入设置后经 mail_watch_register 登记进来。
            mail_watch::spawn(&handle);

            // 禅道后台检查：同样每分钟醒一次，到点给渲染层发一条检查事件
            // （取数、比新增与通知都在渲染层，线程只计时）。周期由渲染层载入设置后
            // 经 zentao_watch 登记进来，登记之前只睡。
            zentao::spawn(&handle);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Workbench 初始化失败")
        .run(|_app, event| {
            // 退出前同步落盘，防止防抖窗口内的改动丢失
            if let tauri::RunEvent::ExitRequested { .. } = event {
                commands::flush_all();
            }
            // 这里**不收进程**：收不收是托盘退出确认里那个选择的事，而选择在 request_quit 里
            // 就已经执行完了 —— 「结束全部进程并退出」当场按进程树收完才退，「直接退出」把进程
            // 留在后台，交给下次启动的残留清理。从前这里无条件调 stop_all，而 RunEvent::Exit
            // 是所有退出路径的必经之处（`AppHandle::exit` 就会走到），挡在这儿等于把选择抹平：
            // 选「直接退出」的也一样被收掉。
        });
}
