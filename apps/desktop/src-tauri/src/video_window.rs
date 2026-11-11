//! 独立视频窗口：把当前视频搬到一扇真正的系统窗口里播（见 docs/modules/video.md）。
//!
//! 与悬浮小窗（应用内的 fixed 浮层）不是一回事：
//!   - 主窗口负责「挑哪个视频、现在播到哪」，开窗时把这份上下文交过来；
//!   - 这扇窗口自己持有一份 `<video>`（同一个文件由 asset 协议读，授权是进程级的）；
//!   - 两边的状态用两条事件通道同步：主 → 窗口 `video-window:command`，
//!     窗口 → 主 `video-window:event`。窗口关了也发一条 closed。
//!   - 位置 / 尺寸 / 置顶不落盘：位置尺寸与主窗口同一口径（主窗口也不落盘），
//!     置顶只是这次运行里的记忆（AtomicBool），下次启动回到不置顶。
//!
//! 建窗口的命令标 `(async)`：IPC 命令默认跑在主线程，而 `WebviewWindowBuilder::build()`
//! 要等主线程泵消息 —— 在主线程里等主线程就是死锁（同 ball.rs 的 ball_apply）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Theme, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// 独立视频窗口的 label（同一时间只有一扇）
pub const LABEL: &str = "video-window";

/// 播放列表里的一集：窗口拿到 root 后自己调 `loadVideo` 换下一个
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoWindowItem {
    pub rel: String,
    pub name: String,
}

/// 视频源：与主窗口的 `VideoSource` 同形（`name` 是显示名，`url` 是 asset 地址）
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    pub rel: String,
    pub name: String,
    pub url: String,
}

/// 开窗时主窗口交过来的那份上下文
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoWindowOpen {
    pub root: String,
    pub source: VideoSource,
    pub rate: f64,
    /// 主窗口暂停时播到第几秒；窗口从同一秒接上
    pub time: f64,
    /// 主窗口那一刻在不在播：窗口据此决定元数据到位后要不要直接开播
    pub playing: bool,
    /// 视频树按展示顺序摊平的一整份（播完自动接续用）
    pub playlist: Vec<VideoWindowItem>,
}

/// 窗口问回的上下文：开窗时那份 + 本次运行的置顶状态
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoWindowContext {
    #[serde(flatten)]
    pub open: VideoWindowOpen,
    pub on_top: bool,
}

/// 主窗口发来的命令（`action` 区分三种）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoWindowCommand {
    pub action: String,
    pub source: Option<VideoSource>,
    pub rate: Option<f64>,
    pub time: Option<f64>,
    pub playing: Option<bool>,
    pub playlist: Option<Vec<VideoWindowItem>>,
}

/// 窗口发回来的回报（`kind` 区分四种）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoWindowReport {
    pub kind: String,
    pub source: Option<VideoSource>,
    pub rate: Option<f64>,
    pub time: Option<f64>,
    pub playing: Option<bool>,
}

/// 会话 + 本次运行的置顶记忆 + 「这次关闭是不是收回」的标记
pub struct VideoWindowState {
    session: Mutex<Option<VideoWindowOpen>>,
    on_top: AtomicBool,
    docking: AtomicBool,
}

impl Default for VideoWindowState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            on_top: AtomicBool::new(false),
            docking: AtomicBool::new(false),
        }
    }
}

fn emit_to_main(app: &AppHandle, payload: Value) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("video-window:event", payload);
    }
}

/// 主窗口：开 / 更新独立视频窗口。
///
/// 标 `(async)` 的理由见文件头；已有窗口时只更新会话、发 `load`、把它唤到前面。
#[tauri::command(async)]
pub fn video_window_open(
    app: AppHandle,
    window: WebviewWindow,
    input: VideoWindowOpen,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口能打开独立视频窗口".to_string());
    }
    open(&app, &window, input)
}

fn open(app: &AppHandle, main: &WebviewWindow, input: VideoWindowOpen) -> Result<(), String> {
    let state = app.state::<VideoWindowState>();
    // 「收回」已经在关窗（等 Destroyed）时别复用旧窗口：那一刀的 Destroyed 会把新会话一起清掉，
    // 主窗口会落进「以为窗口在、其实已经没了」的状态。让用户稍后再点一次
    if state.docking.load(Ordering::Relaxed) {
        return Err("独立视频窗口正在关闭，请稍后再试".to_string());
    }
    // 先把会话写好：窗口页面加载后第一件事就是问它
    *state.session.lock().expect("锁中毒") = Some(input.clone());

    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_title(&input.source.name);
        // 发不出去（窗口正在销毁）就把会话收回去，别留一个「以为窗口还在」的主窗口
        if let Err(err) = existing.emit(
            "video-window:command",
            json!({
                "action": "load",
                "source": input.source,
                "rate": input.rate,
                "time": input.time,
                "playing": input.playing,
                "playlist": input.playlist,
            }),
        ) {
            *state.session.lock().expect("锁中毒") = None;
            return Err(format!("独立视频窗口没有响应：{err}"));
        }
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let on_top = state.on_top.load(Ordering::Relaxed);
    let window = match WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("video.html".into()))
        .title(input.source.name.clone())
        .inner_size(720.0, 405.0)
        .min_inner_size(320.0, 180.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(on_top)
        // 播放画布始终深色；原生媒体控件也跟着走暗色
        .theme(Some(Theme::Dark))
        .visible(false)
        .initialization_script(crate::no_context_menu_script())
        .on_page_load(|window, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()
    {
        Ok(window) => window,
        Err(err) => {
            *state.session.lock().expect("锁中毒") = None;
            return Err(format!("开独立视频窗口失败：{err}"));
        }
    };

    // 开在主窗口里偏右上的一块：x/y 都落在主窗口内，不会因为主窗口靠边而跑到屏幕外
    if let (Ok(position), Ok(size), Ok(video_size), Ok(scale)) = (
        main.outer_position(),
        main.outer_size(),
        window.outer_size(),
        main.scale_factor(),
    ) {
        let gap = (48.0 * scale).round() as i32;
        let x = position.x + size.width as i32 - video_size.width as i32 - gap;
        let y = position.y + (96.0 * scale).round() as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }

    // 被系统关掉（Alt+F4 / 任务栏 X）也要告诉主窗口：不然它还以为视频在播。
    // 退出应用时状态可能已经拆了：`try_state` 取不到就直接走，别在收尾路上 panic。
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let Some(state) = handle.try_state::<VideoWindowState>() else {
                return;
            };
            *state.session.lock().expect("锁中毒") = None;
            let docked = state.docking.swap(false, Ordering::Relaxed);
            if let Some(main) = handle.get_webview_window("main") {
                let _ = main.emit(
                    "video-window:event",
                    json!({ "kind": "closed", "docked": docked }),
                );
            }
        }
    });

    Ok(())
}

/// 独立窗口：问自己那份上下文
#[tauri::command]
pub fn video_window_context(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<VideoWindowContext, String> {
    if window.label() != LABEL {
        return Err("不是独立视频窗口".to_string());
    }
    let state = app.state::<VideoWindowState>();
    let open = state
        .session
        .lock()
        .expect("锁中毒")
        .clone()
        .ok_or_else(|| "独立视频窗口的状态已经过期".to_string())?;
    Ok(VideoWindowContext {
        open,
        on_top: state.on_top.load(Ordering::Relaxed),
    })
}

/// 主窗口 → 独立窗口：换视频 / 收回 / 关掉
#[tauri::command]
pub fn video_window_command(
    app: AppHandle,
    window: WebviewWindow,
    command: VideoWindowCommand,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口能控制独立视频窗口".to_string());
    }
    let Some(video) = app.get_webview_window(LABEL) else {
        return Err("独立视频窗口已经关掉了".to_string());
    };
    let state = app.state::<VideoWindowState>();

    match command.action.as_str() {
        "load" => {
            let source = command.source.ok_or("缺少要播放的视频")?;
            let rate = command.rate.unwrap_or(1.0);
            let time = command.time.unwrap_or(0.0);
            let playing = command.playing.unwrap_or(true);
            let playlist = command.playlist;
            {
                let mut guard = state.session.lock().expect("锁中毒");
                if let Some(session) = guard.as_mut() {
                    session.source = source.clone();
                    session.rate = rate;
                    session.time = time;
                    session.playing = playing;
                    if let Some(items) = playlist.clone() {
                        session.playlist = items;
                    }
                }
            }
            let _ = video.set_title(&source.name);
            video
                .emit(
                    "video-window:command",
                    json!({
                        "action": "load",
                        "source": source,
                        "rate": rate,
                        "time": time,
                        "playing": playing,
                        "playlist": playlist,
                    }),
                )
                .map_err(|err| format!("独立视频窗口没有响应：{err}"))?;
        }
        "dock" => {
            video
                .emit("video-window:command", json!({ "action": "dock" }))
                .map_err(|err| format!("独立视频窗口没有响应：{err}"))?;
        }
        "close" => {
            video
                .close()
                .map_err(|err| format!("关闭独立视频窗口失败：{err}"))?;
        }
        other => return Err(format!("认不出的独立视频窗口动作：{other}")),
    }
    Ok(())
}

/// 独立窗口 → 主窗口：当前视频 / 速率 / 收回 / 关闭
#[tauri::command]
pub fn video_window_report(
    app: AppHandle,
    window: WebviewWindow,
    report: VideoWindowReport,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("不是独立视频窗口".to_string());
    }
    let state = app.state::<VideoWindowState>();

    match report.kind.as_str() {
        "active" => {
            let source = report.source.ok_or("缺少当前视频")?;
            let rate = report.rate.unwrap_or(1.0);
            {
                let mut guard = state.session.lock().expect("锁中毒");
                if let Some(session) = guard.as_mut() {
                    session.source = source.clone();
                    session.rate = rate;
                }
            }
            let _ = window.set_title(&source.name);
            emit_to_main(
                &app,
                json!({ "kind": "active", "source": source, "rate": rate }),
            );
        }
        "rate" => {
            let rate = report.rate.ok_or("缺少播放速率")?;
            {
                let mut guard = state.session.lock().expect("锁中毒");
                if let Some(session) = guard.as_mut() {
                    session.rate = rate;
                }
            }
            emit_to_main(&app, json!({ "kind": "rate", "rate": rate }));
        }
        "dock" => {
            let source = report.source.ok_or("缺少当前视频")?;
            let rate = report.rate.unwrap_or(1.0);
            let time = report.time.unwrap_or(0.0);
            let playing = report.playing.unwrap_or(false);
            {
                let mut guard = state.session.lock().expect("锁中毒");
                if let Some(session) = guard.as_mut() {
                    session.source = source.clone();
                    session.rate = rate;
                    session.time = time;
                    session.playing = playing;
                }
            }
            emit_to_main(
                &app,
                json!({
                    "kind": "dock",
                    "source": source,
                    "rate": rate,
                    "time": time,
                    "playing": playing,
                }),
            );
            // 先标「这次关闭是收回」再关：Destroyed 里读的正是这个标记
            state.docking.store(true, Ordering::Relaxed);
            crate::show_main_window(&app);
            if let Err(err) = window.close() {
                state.docking.store(false, Ordering::Relaxed);
                return Err(format!("关闭独立视频窗口失败：{err}"));
            }
        }
        "close" => {
            window
                .close()
                .map_err(|err| format!("关闭独立视频窗口失败：{err}"))?;
        }
        other => return Err(format!("认不出的独立视频窗口回报：{other}")),
    }
    Ok(())
}

/// 独立窗口：切置顶（本次运行内记住）
#[tauri::command]
pub fn video_window_on_top(
    app: AppHandle,
    window: WebviewWindow,
    on_top: bool,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("不是独立视频窗口".to_string());
    }
    window
        .set_always_on_top(on_top)
        .map_err(|err| format!("切换置顶失败：{err}"))?;
    app.state::<VideoWindowState>()
        .on_top
        .store(on_top, Ordering::Relaxed);
    Ok(())
}
