//! 截图：抓屏、铺遮罩、收工。
//!
//! ## 一次截图的生命周期
//!
//! 1. `request`（热键 / 托盘 / 设置里的按钮）丢一个工作线程进来，走 `start`；
//! 2. `start` 确认遮罩窗口的池子对得上当前这几块屏（见下面那条）；
//! 3. 再逐屏抓图、编成 PNG 字节留在内存里；**顺序不能反**（窗口一显示就会被拍进去）；
//! 4. 帧进状态之后把遮罩**摆好、显示出来**，并推一条 `capture:sync` 给每一块遮罩
//!    （窗口是复用的，光显示它不会让里面的 JS 知道又开了一场）；焦点给光标所在的那块屏；
//! 5. 渲染层在窗口里画「冻结的那一帧 + 选区 + 标注」，做完复制 / 保存 / 钉图之后调
//!    `capture_abort` 收工：**把遮罩藏起来**（窗口留着下次接着用）、丢掉这场会话的帧字节。
//!
//! ## 为什么要养一池遮罩窗口（预建 + 复用）
//!
//! 「按下热键到看见遮罩」要压到两百毫秒级，靠的就只有这一条：**建一个 WebView2 窗口
//! 本身就比这个预算还贵**（要起 webview、加载 JS 包、跑起 Vue）。所以遮罩窗口在
//! `capture_prewarm`（渲染层载入设置后调一次）里就建好、藏在屏幕外，之后每场截图只是
//! 「塞帧 → 摆位置 → 显示」，建窗口那一笔再也不在热路径上。
//! 代价是**多几块常驻的 webview**（一块屏一块）—— 有意换的，不是漏掉的。
//! 屏幕数变了（插拔显示器）池子就对不上，那就整批重建：旧的一代先关掉，新的一代换个
//! 代号（见 `overlay_label`），免得旧窗口还没销毁、新窗口顶着同一个标签建不出来。
//!
//! ## 为什么一块屏一个窗口（而不是一个横跨虚拟桌面的窗口）
//!
//! WebView 的缩放因子是按它所在显示器定的：一个横跨两块不同 DPI 的窗口只能有一个缩放，
//! 另一半的画面就是错的。所以每种 DPI 一块屏一个窗口，各自 1:1 画自己的那帧。
//! 代价是**选区不跨屏**（拖到屏幕边缘就停住）—— 这是有意接受的限制，不是漏掉的。
//!
//! ## 为什么遮罩也是透明的
//!
//! 遮罩把冻结的截图当背景整个画满，所以它不需要透明；但**藏着的窗口不会往合成器交新帧**
//! （见 docs/modules/screenshot.md 的「为什么遮罩窗口也是透明的」），`show()` 出来的头一帧
//! 是上一次合成留下的旧表面 —— 那一瞬间屏幕上是一块黑（页面底色）+ 提示条，看着就是
//! 「按下热键先闪一下黑」。所以遮罩窗口按钉图那套开 `transparent(true)`、页面底也透明
//! （见 capture.html）：旧表面那一刻露出来的是**桌面本身**，与冻结帧几乎一样，看不出切换。
//! 冻结帧是整块不透明的画布，画上去之后外观与以前完全一致。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::fs_util;
use crate::screen;

/// 遮罩窗口的标签前缀；完整标签是 `capture-<代号>-<序号>`（见 `overlay_label`）
pub const OVERLAY_PREFIX: &str = "capture-";

/// 等遮罩里的 JS 报「画好了」的上限（见 `maybe_show`）：正常情况下它几十毫秒就来了，
/// 这个数只是兜底 —— 按一下热键什么都没发生，比慢一点更糟
const SHOW_WATCHDOG_MS: u64 = 1000;

/// 一块屏的几何 + 它那一帧落在哪儿
#[derive(Clone, Serialize)]
pub struct MonitorFrame {
    pub index: usize,
    /// 显示器名（界面上给用户看）
    pub name: String,
    /// 虚拟桌面物理坐标下的左上角与尺寸
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 这块屏的缩放（物理像素 / CSS 像素）
    pub scale: f64,
}

/// 这次截图要用到的几项设置。
///
/// **直接从数据文件里读，而不是问渲染层的 store**：遮罩窗口跑的是自己的入口
/// （capture.html），它不装那份 store —— 装了就会与主窗口抢着写同一批 JSON
/// （见 docs/modules/screenshot.md 的「第二入口不碰持久化」）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    /// 自动保存的目录（空串 = 还没设置，保存时弹「另存为」）
    pub save_dir: String,
    /// 新钉图的初始透明度（百分比）
    pub pin_opacity: u32,
    /// 选区时显示放大镜与像素取色
    pub magnifier: bool,
}

/// 遮罩窗口问「我是谁、这块屏在哪儿」时拿到的东西
#[derive(Clone, Serialize)]
pub struct CaptureContext {
    /// 这一场会话的编号：遮罩画完那一帧再送回 `capture_show`（见 `Session::id`）
    pub session: u64,
    /// 这个窗口自己那块屏
    pub monitor: MonitorFrame,
    /// 这场会话里的所有屏（渲染层用它算坐标，虽然当前不跨屏选，留着一处口径）
    pub monitors: Vec<MonitorFrame>,
    /// 这次截图要用的设置
    pub options: CaptureOptions,
}

struct Session {
    /// 这一场的编号：`capture:sync` 带出去、`capture_show` 带回来 —— 上一场那半截
    /// 「画好了」不该把这一场提前亮出来
    id: u64,
    frames: Vec<Frame>,
    /// 还没报「画好了」的那几块屏（序号）。都报齐（或看门狗到点）才把遮罩亮出来
    pending: Vec<usize>,
    /// 已经亮出来了。看门狗与 capture_show 只认第一次
    shown: bool,
}

/// 一块屏：几何 + 那一帧的 PNG 字节。
///
/// **字节留在内存里、不落盘**：渲染层拿的是 base64（它要画到画布上，还要 `getImageData`
/// 与 `toBlob`），而 asset 协议那边是**跨源**的 —— 把 asset 图 `drawImage` 进画布会把画布
/// 污染掉，`getImageData` 直接抛 SecurityError、`toBlob` 也同样抛（复制 / 保存 / 钉图全废）。
/// 走 base64 → Blob 就没有这回事（同源），顺带也没有临时目录要收拾。
struct Frame {
    info: MonitorFrame,
    png: Vec<u8>,
}

/// 遮罩窗口 + 这场会话。窗口是**跨场复用**的（见文件头），所以两件事分开记：
/// `session` 管「现在在不在截」，`generation` 管池子里这批窗口是哪一代的。
#[derive(Default)]
struct Pool {
    /// 这场截图的几帧。没有 = 没在截
    session: Option<Session>,
    /// 池子里这批遮罩的代号（窗口标签中间那一段）。0 = 一块都还没建
    generation: u64,
    /// 发过的最大会话编号（见 `Session::id`）
    last_session: u64,
}

/// 遮罩窗口的池子。没有会话 = 没在截。
///
/// **两把锁**：`Pool` 那把管会话与代号（`capture_context` / `capture_frame` 每次都取它，是热路径）；
/// `build` 那把只用来串行化「建池子 / 收池子」—— 预建（渲染层在设置载入后、以及每次改设置时调）
/// 与「按了热键现建」可能撞在一起，撞上就会两边各建一批、互相把对方关掉。
/// 取锁次序**永远是 `build` → `Pool`**，不反过来（反过来会与 capture_context 死锁：
/// 建窗口要回主线程，而主线程可能在等那把会话锁）。
#[derive(Default)]
pub struct CaptureState(Mutex<Pool>, Mutex<()>);

/// Tauri 报回来的显示器几何（与 `screen::capture_region` 要的坐标系一致）
struct MonitorSpec {
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

/// 遮罩窗口的标签：`capture-<代号>-<序号>`，序号就是这块屏在这一代里的位置。
///
/// **为什么要带一代「代号」**：屏幕数变了要整批重建遮罩，而 `close()` 是异步的 ——
/// 旧窗口还在事件队列里没销毁，紧接着用同一个标签建新窗口会直接失败。换一代代号，
/// 新旧不撞名（`capabilities/capture.json` 那条 `capture-*` 通配照旧盖得住）。
pub fn overlay_label(generation: u64, index: usize) -> String {
    format!("{OVERLAY_PREFIX}{generation}-{index}")
}

/// 起一次截图（热键 / 托盘 / 设置按钮都走它）。
///
/// **必须丢到工作线程**：抓屏加 PNG 编码在多屏上是几百毫秒的活，而热键回调与托盘菜单
/// 事件都是在主线程上派发的 —— 在那儿直接做会把整个界面冻住（踩过一次，见 commands.rs
/// 文件头那条「会读写文件的命令一律标 async」）。
pub fn request(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = toggle(&handle) {
            eprintln!("[workbench] 截图失败：{err}");
            // 界面这时多半压根看不见（截图是从热键 / 托盘起的），先把窗口唤出来再推事件 ——
            // 应用内的提示条压在隐藏的窗口里等于没提（与退出确认那条同一条口径）
            crate::show_main_window(&handle);
            let _ = handle.emit("capture:failed", err);
        }
    });
}

/// 已经在截 → 收掉（热键再按一次就是取消）；否则开始
fn toggle(app: &AppHandle) -> Result<usize, String> {
    if active(app) {
        abort(app);
        return Ok(0);
    }
    start(app)
}

pub fn active(app: &AppHandle) -> bool {
    app.state::<CaptureState>()
        .0
        .lock()
        .expect("锁中毒")
        .session
        .is_some()
}

fn start(app: &AppHandle) -> Result<usize, String> {
    // 上一场没收干净（崩过、或连按了两次）先收掉：只丢帧、把遮罩藏起来，窗口留着复用
    abort(app);

    let specs = monitors(app)?;
    // 池子对不上这几块屏（第一次、或插拔过显示器）就整批重建，否则一块窗口都不用建
    let overlays = ensure_overlays(app, &specs)?;

    let mut frames = Vec::with_capacity(specs.len());
    for (index, spec) in specs.iter().enumerate() {
        let image = match screen::capture_region(spec.x, spec.y, spec.width, spec.height) {
            Ok(image) => image,
            Err(err) => {
                abort(app);
                return Err(format!("抓「{}」失败：{err}", spec.name));
            }
        };

        // 编成 PNG 字节留在内存里（见 Frame 的说明：渲染层要 base64，而 asset 那条路会把
        // 画布污染掉）。多屏几兆，够小；也没有临时目录要收拾
        let mut png: Vec<u8> = Vec::new();
        if let Err(err) = encode_png(&image, &mut png) {
            abort(app);
            return Err(err);
        }

        frames.push(Frame {
            info: MonitorFrame {
                index,
                name: spec.name.clone(),
                x: spec.x,
                y: spec.y,
                width: spec.width,
                height: spec.height,
                scale: spec.scale,
            },
            png,
        });
    }

    let count = frames.len();

    // 会话要在**推事件之前**进状态：窗口里的 JS 收到 sync 就会立刻来问 capture_context
    let id = {
        let state = app.state::<CaptureState>();
        let mut guard = state.0.lock().expect("锁中毒");
        guard.last_session += 1;
        let id = guard.last_session;
        guard.session = Some(Session {
            id,
            frames,
            pending: (0..count).collect(),
            shown: false,
        });
        id
    };

    // 窗口是复用的：光显示它们不会让里面的 JS 知道又开了一场，得推一条让它重新取上下文与帧。
    // 带上这一场的编号，JS 画完再把编号送回来（`capture_show`）
    for window in &overlays {
        let _ = window.emit("capture:sync", Some(id));
    }

    // **到这里还不显示**：那一帧要走 `capture_frame` 从 IPC 过来（几兆、几十毫秒），
    // 抢在它前面显示就是先闪一块黑再出画面。等每一块屏都报「画好了」再亮（见 `capture_show`）。
    // 看门狗兜底：窗口里的 JS 万一没起来（帧取不到、脚本错了），也不能按一下什么都没发生
    let watchdog = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(SHOW_WATCHDOG_MS));
        if let Err(err) = maybe_show(&watchdog, id) {
            eprintln!("[workbench] 显示截图遮罩失败：{err}");
        }
    });

    Ok(count)
}

/// 等遮罩里的 JS 报「这一场的帧已经画到画布上了」，Rust 据此才把遮罩亮出来。
///
/// **为什么不在 `start` 里直接显示**：抢在帧前面显示，用户看到的就是「先闪一块黑、再出画面」。
/// 等每一块屏都画好再显示，看见的就是「按下 → 遮罩带着冻结画面一起出现」。
/// 编号对不上的（上一场那半截、或者已经收工了）一律忽略。
#[tauri::command(async)]
pub fn capture_show(window: WebviewWindow, app: AppHandle, id: u64) -> Result<(), String> {
    let index = overlay_index(window.label()).ok_or("这个窗口不是截图遮罩")?;

    let ready = {
        let state = app.state::<CaptureState>();
        let mut guard = state.0.lock().expect("锁中毒");
        match guard.session.as_mut() {
            Some(session) if session.id == id => {
                session.pending.retain(|item| *item != index);
                if session.pending.is_empty() && !session.shown {
                    session.shown = true;
                    true
                }
                else {
                    false
                }
            }
            _ => false,
        }
    };

    if ready {
        show_session(&app)?;
    }
    Ok(())
}

/// 看门狗：到点还没亮就亮（`capture_show` 一直没来）。编号对不上就什么都不做。
fn maybe_show(app: &AppHandle, id: u64) -> Result<(), String> {
    let ready = {
        let state = app.state::<CaptureState>();
        let mut guard = state.0.lock().expect("锁中毒");
        match guard.session.as_mut() {
            Some(session) if session.id == id && !session.shown => {
                session.shown = true;
                true
            }
            _ => false,
        }
    };

    if ready {
        show_session(app)?;
    }
    Ok(())
}

/// 摆位置、定尺寸、显示出来，再把焦点给**光标所在的那块屏**
/// （Esc / Enter / Ctrl+Z 只有拿到焦点的窗口收得到）。
///
/// 焦点是**现在**重新取的：等帧的那几十毫秒里光标可能已经挪到另一块屏上了。
fn show_session(app: &AppHandle) -> Result<(), String> {
    let (generation, geometry) = {
        let state = app.state::<CaptureState>();
        let guard = state.0.lock().expect("锁中毒");
        let geometry: Vec<MonitorFrame> = guard
            .session
            .as_ref()
            .map(|session| session.frames.iter().map(|frame| frame.info.clone()).collect())
            .unwrap_or_default();
        (guard.generation, geometry)
    };

    let overlays = overlays_of(app, generation);
    let focused = {
        let (cursor_x, cursor_y) = screen::cursor_position();
        geometry
            .iter()
            .position(|frame| contains(frame, cursor_x, cursor_y))
            .unwrap_or(0)
    };

    // 先把每一块都摆好、显示出来，**最后**再给焦点：`show()` 本身会把窗口激活，
    // 边显示边设焦点的话，后面那块会把这边的焦点抢走（键盘就落到别的屏上了）
    for (index, frame) in geometry.iter().enumerate() {
        if let Some(window) = overlays.get(index) {
            show_overlay(window, frame)?;
        }
    }

    if let Some(window) = overlays.get(focused) {
        let _ = window.set_focus();
    }
    Ok(())
}

/// 收工：把遮罩**藏起来**、丢掉这场会话的几帧字节，并推一条 `capture:sync` 让遮罩自己清干净
/// （清掉上一场的帧、选区与标注；那条事件在「没有会话」时的语义就是「收起你手里那张」）。
///
/// **窗口不关**：它们留在池子里给下一场复用（建一块 WebView2 窗口比按热键的整个预算还贵，
/// 见文件头）。藏起来的窗口不进合成，既不会被下一场抓进去，也不占屏幕。
pub fn abort(app: &AppHandle) {
    let overlays = overlay_windows(app);
    for window in &overlays {
        let _ = window.hide();
    }

    // 取锁放在藏窗之后：窗口事件会派发，持着锁等它不划算。
    // 会话里只有内存中的几份 PNG，丢掉引用就算收工了 —— 没有临时文件要删
    let _ = app.state::<CaptureState>().0.lock().expect("锁中毒").session.take();

    // 收工也通知一声（**不带编号** = 这一场结束了）：遮罩里那张上一场的帧（ImageBitmap +
    // 取样画布，4K 下是几十兆）、选区与标注都该丢掉 —— 窗口留着复用，但不必留着上一张图。
    // 这一条过去之后那边的 `capture_context` 会问到「会话已经结束了」，它就自己清干净了
    for window in &overlays {
        let _ = window.emit("capture:sync", None::<u64>);
    }
}

/// 池子里/还在销毁路上的所有 `capture-*` 窗口
fn overlay_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| overlay_ref(label).is_some())
        .map(|(_, window)| window)
        .collect()
}

/// 池子里**这一代**的窗口，按序号排好。少一块（被 Alt+F4 关过）就回不满，调用方据此重建
fn overlays_of(app: &AppHandle, generation: u64) -> Vec<WebviewWindow> {
    let mut found: Vec<(usize, WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            let (mark, index) = overlay_ref(&label)?;
            (mark == generation).then_some((index, window))
        })
        .collect();
    found.sort_by_key(|(index, _)| *index);
    found.into_iter().map(|(_, window)| window).collect()
}

/// 按当前这几块屏准备好遮罩窗口，返回按序号排好的一批。**对得上就原样复用，一块都不建**。
fn ensure_overlays(app: &AppHandle, specs: &[MonitorSpec]) -> Result<Vec<WebviewWindow>, String> {
    // 建池子这件事一次只能有一个（预建与「按了热键现建」会撞）
    let state = app.state::<CaptureState>();
    let _building = state.1.lock().expect("锁中毒");

    let needed = specs.len();
    let generation = state.0.lock().expect("锁中毒").generation;
    let pooled = overlays_of(app, generation);

    if needed > 0 && pooled.len() == needed {
        return Ok(pooled);
    }
    build_overlays(app, needed)
}

/// 整批重建：先换一代代号（旧的那批还等着销毁，见 `overlay_label`），再把旧的全关掉。
fn build_overlays(app: &AppHandle, needed: usize) -> Result<Vec<WebviewWindow>, String> {
    let generation = {
        let state = app.state::<CaptureState>();
        let mut guard = state.0.lock().expect("锁中毒");
        guard.generation += 1;
        guard.generation
    };

    // **不能在这里持着锁**：建窗口会回调进渲染层，而 capture_context / capture_frame 取的是同一把锁
    for window in overlay_windows(app) {
        let _ = window.close();
    }

    let mut built = Vec::with_capacity(needed);
    for index in 0..needed {
        match create_overlay_window(app, generation, index) {
            Ok(window) => built.push(window),
            Err(err) => {
                // 已经建出来的那几块也要收掉，别留半场遮罩在屏幕上
                for window in &built {
                    let _ = window.close();
                }
                return Err(err);
            }
        }
    }
    Ok(built)
}

/// 把池子整个收掉（用户把截图功能关了）
fn release(app: &AppHandle) {
    let state = app.state::<CaptureState>();
    let _building = state.1.lock().expect("锁中毒");

    for window in overlay_windows(app) {
        let _ = window.close();
    }

    let mut guard = state.0.lock().expect("锁中毒");
    guard.session = None;
    // 加一代：池子里那批窗口的代号再也对不上，下次要用了会重建
    guard.generation += 1;
}

fn monitors(app: &AppHandle) -> Result<Vec<MonitorSpec>, String> {
    let listed = app
        .available_monitors()
        .map_err(|err| format!("取显示器列表失败：{err}"))?;

    if !listed.is_empty() {
        return Ok(listed
            .iter()
            .enumerate()
            .map(|(index, monitor)| {
                let position = monitor.position();
                let size = monitor.size();
                MonitorSpec {
                    name: monitor
                        .name()
                        .map(|name| name.to_string())
                        .unwrap_or_else(|| format!("显示器 {}", index + 1)),
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    scale: monitor.scale_factor(),
                }
            })
            .collect());
    }

    // 一块屏都报不出来（远程桌面、刚切完显示模式那一下）：退化成「整块虚拟桌面当一块屏」。
    // 混合 DPI 时缩放会不对，但总比按了没反应强
    let (x, y, width, height) = screen::virtual_desktop().ok_or("系统没报出任何显示器")?;
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);

    Ok(vec![MonitorSpec {
        name: "整个桌面".into(),
        x,
        y,
        width,
        height,
        scale,
    }])
}

/// 建一块遮罩窗口（**不显示**，位置与尺寸也不摆 —— 那两件事在 show_overlay 里）。
///
/// 标签是 `capture-<代号>-<序号>`：窗口里的 JS 靠它通过 capture_context 认出自己代表哪块屏。
fn create_overlay_window(
    app: &AppHandle,
    generation: u64,
    index: usize,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(
        app,
        overlay_label(generation, index),
        WebviewUrl::App("capture.html".into()),
    )
    // 一块铺满屏幕的「冻结画面」：无边框、置顶、不上任务栏、不要阴影
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    // **透明**：画面画上之前的那一帧露出来的是桌面，不是一块黑（见文件头那条）。
    // 冻结帧是不透明的画布，画上去之后看不出区别
    .transparent(true)
    .visible(false)
    .focused(false)
    .title("截图")
    .build()
    .map_err(|err| format!("铺遮罩窗口失败：{err}"))?;

    // 必须在第一次显示之前设（见 disable_transitions）
    disable_transitions(&window);
    Ok(window)
}

/// 关掉这个窗口显示 / 收起时的那一段过渡。
///
/// 不关的话 Windows 会给「隐藏」补一段淡出（实测约 150~200ms，桌面从底下渐渐透出来）——
/// 遮罩要的是「按下就出现、收工就消失」，那段过渡既看着像画面在渐变，也把热键那一下拖慢。
/// **必须在窗口第一次显示之前设**，所以建窗口时来一次；`show_overlay` 里再补一次，
/// 因为 tao 每次改窗口样式都会 `SetWindowLongW`，有可能把这个属性带掉。
/// 设不上（旧系统不认这个属性）也无所谓：最坏就是那段过渡还在。
fn disable_transitions(window: &WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};

    let Ok(handle) = window.hwnd() else {
        return;
    };
    let disabled: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            handle.0,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const i32 as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

/// 摆位置、定尺寸、显示出来。焦点由调用方在**全部显示完之后**统一给（见 start）。
///
/// 位置与尺寸给**物理像素**：builder 上的 position / inner_size 是逻辑坐标，
/// 混合 DPI 的多屏下用它正好错位。
fn show_overlay(window: &WebviewWindow, frame: &MonitorFrame) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(frame.x, frame.y))
        .map_err(|err| format!("摆遮罩窗口失败：{err}"))?;
    window
        .set_size(PhysicalSize::new(frame.width, frame.height))
        .map_err(|err| format!("定遮罩窗口尺寸失败：{err}"))?;
    // 显示前再压一次过渡（见 disable_transitions：改样式有可能把它带掉）
    disable_transitions(window);
    window
        .show()
        .map_err(|err| format!("显示遮罩窗口失败：{err}"))
}

/// 点在不在这一帧覆盖的范围内
fn contains(frame: &MonitorFrame, x: i32, y: i32) -> bool {
    x >= frame.x
        && x < frame.x + frame.width as i32
        && y >= frame.y
        && y < frame.y + frame.height as i32
}

/// 窗口标签 → （这一代窗口的代号, 这块屏的序号）
fn overlay_ref(label: &str) -> Option<(u64, usize)> {
    let (mark, index) = label.strip_prefix(OVERLAY_PREFIX)?.split_once('-')?;
    Some((mark.parse().ok()?, index.parse().ok()?))
}

/// 这个窗口代表哪块屏（`capture_context` / `capture_frame` 靠它认出自己）
fn overlay_index(label: &str) -> Option<usize> {
    overlay_ref(label).map(|(_, index)| index)
}

/// 把这一帧编成 PNG 字节。
///
/// **压缩档与滤波都是显式给的**：`image` 的默认是「自适应滤波 + 默认压缩档」，自适应那一趟
/// 要按行试遍五种滤波再挑最省的，实测一张 1080p 要 1.4 秒（release 也有 166ms）——
/// 而按热键的整个预算才 200ms，它是这条路上最大的一笔。换成 `Sub` + `Fast`：同屏 34ms，
/// 体积只多一成多（1.9MB → 2.2MB），快五倍。
pub(crate) fn encode_png(image: &image::RgbaImage, out: &mut Vec<u8>) -> Result<(), String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;

    let mut cursor = std::io::Cursor::new(out);
    let encoder = PngEncoder::new_with_quality(&mut cursor, CompressionType::Fast, FilterType::Sub);
    encoder
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|err| format!("截图编码失败：{err}"))
}

// ---------- 渲染层要的三块：上下文、帧字节、落盘 ----------

#[tauri::command]
pub fn capture_context(window: WebviewWindow, app: AppHandle) -> Result<CaptureContext, String> {
    let index = overlay_index(window.label()).ok_or("这个窗口不是截图遮罩")?;
    let state = app.state::<CaptureState>();
    let guard = state.0.lock().expect("锁中毒");
    let session = guard.session.as_ref().ok_or("截图会话已经结束了")?;
    let monitor = session
        .frames
        .iter()
        .find(|frame| frame.info.index == index)
        .map(|frame| frame.info.clone())
        .ok_or("找不到这块屏的截图")?;

    Ok(CaptureContext {
        session: session.id,
        monitor,
        monitors: session
            .frames
            .iter()
            .map(|frame| frame.info.clone())
            .collect(),
        options: options(),
    })
}

/// 这个遮罩窗口自己那块屏的那一帧（**原始 PNG 字节，走二进制 IPC**）。
///
/// **为什么不 base64**：这一帧是这条路上最大的一笔载荷，base64 会把 4MB 的 PNG 撑成
/// 5.7MB 的字符串、再多一次编解码。Tauri 的 `ipc::Response` 直接把这堆字节交给 JS
/// （`invoke` 收到 `ArrayBuffer`），少那 33% 的体积与两次转换。
///
/// **为什么不是 asset 协议**：渲染层要把这一帧画到画布上，还要 `getImageData`
/// （放大镜取色、马赛克）与 `toBlob`（复制 / 保存 / 钉图）。asset 协议对页面来说是**跨源**的，
/// 把它的图 `drawImage` 进画布会把画布污染掉 —— `getImageData` 与 `toBlob` 都会抛 SecurityError，
/// 整条导出链就废了。二进制字节包成 Blob 是同源，没有这回事。
#[tauri::command(async)]
pub fn capture_frame(window: WebviewWindow, app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let index = overlay_index(window.label()).ok_or("这个窗口不是截图遮罩")?;
    let state = app.state::<CaptureState>();
    let guard = state.0.lock().expect("锁中毒");
    let session = guard.session.as_ref().ok_or("截图会话已经结束了")?;
    let frame = session
        .frames
        .iter()
        .find(|frame| frame.info.index == index)
        .ok_or("找不到这块屏的截图")?;

    // 会话里的帧还要留着给复制 / 保存用，交给 IPC 的是一份克隆
    Ok(tauri::ipc::Response::new(frame.png.clone()))
}

/// 从数据文件里取这次截图要用的设置。缺失 / 类型不对都回默认值 ——
/// 截图不该因为设置文件被手工改坏就起不来。
fn options() -> CaptureOptions {
    let settings = crate::commands::data_store()
        .get()
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    CaptureOptions {
        save_dir: settings
            .get("captureSaveDir")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        pin_opacity: settings
            .get("capturePinOpacity")
            .and_then(serde_json::Value::as_u64)
            .map(|value| value.clamp(20, 100) as u32)
            .unwrap_or(100),
        magnifier: settings
            .get("captureMagnifier")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    }
}

/// 起一次截图。**只给验证配方用**：界面上已经没有入口了（原来那颗「试一下」按钮已去掉），
/// 驱动方式见 docs/modules/screenshot.md 的「验证」一节（CDP 在页面里调 `beginCapture`）。
#[tauri::command(async)]
pub fn capture_begin(app: AppHandle) -> Result<usize, String> {
    start(&app)
}

/// 预先把遮罩窗口建好（**按热键到看见遮罩**能不能压到两百毫秒，全靠这一条）。
///
/// 由渲染层在载入设置之后调一次：开着截图就把池子建起来，关掉就把池子收掉
/// （否则每块屏常驻一块 webview 白占内存）。失败不致命 —— 真按了热键时 `start` 会现建。
#[tauri::command(async)]
pub fn capture_prewarm(app: AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        release(&app);
        return Ok(());
    }

    let specs = monitors(&app)?;
    ensure_overlays(&app, &specs).map(|_| ())
}

/// 收工：把遮罩藏起来（窗口留着复用，见 `abort`）
#[tauri::command]
pub fn capture_abort(app: AppHandle) {
    abort(&app)
}

/// 把最终的 PNG 放进系统剪贴板。
///
/// **一进来先把遮罩收掉**：解码 PNG、构两份 DIB、写剪贴板在 4K 上是几百毫秒的活，
/// 用户按下 Enter 之后不该还盯着遮罩等它。失败经 `report_copy_failure` 推给主窗口
/// （遮罩已经收了，没有别的地方能说话）。
#[tauri::command(async)]
pub fn capture_copy(app: AppHandle, png: String) -> Result<(), String> {
    abort(&app);
    let outcome = decode_png(&png).and_then(|bytes| crate::clipboard::write_png(&bytes));
    report_copy_failure(&app, outcome)
}

/// 没画任何标注时的复制快路径：**不用把图搬到渲染层再搬回来** —— Rust 手里就为这一场
/// 缓存了这块屏的原始 PNG，直接裁出选区写剪贴板。`x` / `y` / `width` / `height` 是这块屏
/// 的画布坐标（物理像素），由渲染层按选区取整后给。
///
/// 有标注时仍走 `capture_copy`：标注只有渲染层会画（见 screenshot.md「显示与导出同一条路」）。
#[tauri::command(async)]
pub fn capture_copy_frame(
    window: WebviewWindow,
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // 帧只在会话里，而收工会把会话丢掉：**先把 PNG 克隆出来再 abort**
    let frame = take_frame_png(&window, &app);
    abort(&app);
    let outcome = frame.and_then(|png| copy_region(&png, x, y, width, height));
    report_copy_failure(&app, outcome)
}

fn take_frame_png(window: &WebviewWindow, app: &AppHandle) -> Result<Vec<u8>, String> {
    let index = overlay_index(window.label()).ok_or("这个窗口不是截图遮罩")?;
    let state = app.state::<CaptureState>();
    let guard = state.0.lock().expect("锁中毒");
    let session = guard.session.as_ref().ok_or("截图会话已经结束了")?;
    let frame = session
        .frames
        .iter()
        .find(|frame| frame.info.index == index)
        .ok_or("找不到这块屏的截图")?;
    Ok(frame.png.clone())
}

/// 从这一场的原始帧裁出选区并写剪贴板。
///
/// 剪贴板里的 `PNG` 格式要的是**裁剪后**的图，所以非整屏时得重编一次（`Fast` + `Sub`，
/// 与抓屏那条路同一个编码档）；整屏就直接复用缓存的那份 PNG 字节。
fn copy_region(png: &[u8], x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    let image = image::load_from_memory(png)
        .map_err(|err| format!("这张图解不开（{err}）"))?
        .to_rgba8();
    let (left, top, crop_width, crop_height) =
        clamp_region(image.width(), image.height(), x, y, width, height)?;

    if left == 0 && top == 0 && crop_width == image.width() && crop_height == image.height() {
        return crate::clipboard::write_rgba(&image, png);
    }

    let cropped =
        image::imageops::crop_imm(&image, left, top, crop_width, crop_height).to_image();
    let mut encoded = Vec::new();
    encode_png(&cropped, &mut encoded)?;
    crate::clipboard::write_rgba(&cropped, &encoded)
}

/// 把选区收敛到这一帧里面（渲染层已经取整并夹过一次，命令参数仍是外部输入，这里再夹一次）。
fn clamp_region(
    frame_width: u32,
    frame_height: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(u32, u32, u32, u32), String> {
    let frame_width = frame_width as i32;
    let frame_height = frame_height as i32;
    let left = x.clamp(0, frame_width);
    let top = y.clamp(0, frame_height);
    let right = (x + width as i32).clamp(left, frame_width);
    let bottom = (y + height as i32).clamp(top, frame_height);
    let crop_width = (right - left) as u32;
    let crop_height = (bottom - top) as u32;
    if crop_width == 0 || crop_height == 0 {
        return Err("还没选好要截的区域".into());
    }
    Ok((left as u32, top as u32, crop_width, crop_height))
}

/// 复制失败时遮罩已经收了：走与「起截图失败」同一条路 —— 把主窗口唤出来并推一条
/// `capture:failed`（主窗口那边弹一条提示条）。
fn report_copy_failure(app: &AppHandle, outcome: Result<(), String>) -> Result<(), String> {
    if let Err(err) = &outcome {
        crate::show_main_window(app);
        let _ = app.emit("capture:failed", format!("复制到剪贴板失败：{err}"));
    }
    outcome
}

/// 把最终的 PNG 落盘，返回真正写进去的那个绝对路径。
///
/// `unique` 为真时同名自动加 `-2` / `-3`（自动保存那条路：同一秒里截两张不该互相覆盖）；
/// 为假时原样覆盖（「另存为」那条路：用户已经在对话框里挑过、也确认过覆盖了）。
#[tauri::command(async)]
pub fn capture_save(
    png: String,
    dir: String,
    name: String,
    unique: bool,
) -> Result<String, String> {
    save_bytes(&dir, &name, unique, &decode_png(&png)?)
}

fn decode_png(png: &str) -> Result<Vec<u8>, String> {
    crate::encoding::base64_decode(png.trim()).ok_or_else(|| "截图数据不完整".to_string())
}

/// 写一张 PNG 到 `dir\name`（目录不存在就建）。pin.rs 的「另存为」也走它。
pub fn save_bytes(dir: &str, name: &str, unique: bool, bytes: &[u8]) -> Result<String, String> {
    let directory = dir.trim();
    if directory.is_empty() {
        return Err("还没设置保存目录".into());
    }

    let directory = PathBuf::from(directory);
    std::fs::create_dir_all(&directory).map_err(|err| format!("建保存目录失败：{err}"))?;

    let name = safe_file_name(name);
    let target = if unique {
        unique_in(&directory, &name)
    } else {
        directory.join(&name)
    };

    fs_util::write_atomic(&target, bytes)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 文件名收敛：只留最后那一段（用户可能连路径一起塞进来）、换掉 Windows 不认的字符。
/// 名字是拼进路径的，这一道不能省。
fn safe_file_name(name: &str) -> String {
    let tail = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();

    let mut cleaned: String = tail
        .chars()
        .map(|char| {
            if char.is_control() || matches!(char, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                char
            }
        })
        .collect();

    // 结尾的空白与点在 Windows 上会被静默吃掉，名字会与我们报回去的对不上
    while cleaned.ends_with(' ') || cleaned.ends_with('.') {
        cleaned.pop();
    }
    if cleaned.is_empty() {
        cleaned = "截图".into();
    }
    if !cleaned.to_lowercase().ends_with(".png") {
        cleaned.push_str(".png");
    }
    cleaned
}

/// 同一个目录里不重名：`截图.png` → `截图-2.png` → `截图-3.png` …
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }

    let dot = name.rfind('.').unwrap_or(name.len());
    let (stem, extension) = name.split_at(dot);

    for index in 2..1000 {
        let candidate = dir.join(format!("{stem}-{index}{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 一千个都占了：照原名覆盖，总比存不下去强
    dir.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> MonitorFrame {
        MonitorFrame {
            index: 0,
            name: "A".into(),
            x: 100,
            y: 200,
            width: 1920,
            height: 1080,
            scale: 1.5,
        }
    }

    #[test]
    fn 标签与序号互认() {
        // 标签是 `capture-<代号>-<序号>`：序号在最后一段，序号本身有几位都不影响
        assert_eq!(overlay_label(0, 3), "capture-0-3");
        assert_eq!(overlay_label(12, 0), "capture-12-0");
        assert_eq!(overlay_ref("capture-12-0"), Some((12, 0)));
        assert_eq!(overlay_index("capture-12-0"), Some(0));
        assert_eq!(overlay_index("capture-1-10"), Some(10));
        // 别的窗口 / 半截标签都不算
        assert_eq!(overlay_ref("main"), None);
        assert_eq!(overlay_index("capture-"), None);
        assert_eq!(overlay_index("capture-1-"), None);
        assert_eq!(overlay_index("capture-x-1"), None);
        assert_eq!(overlay_index("pin-1"), None);
    }

    #[test]
    fn 命中范围为半开区间() {
        let frame = frame();
        assert!(contains(&frame, 100, 200));
        assert!(contains(&frame, 2019, 1279));
        // 右下边界归下一块屏
        assert!(!contains(&frame, 2020, 1000));
        assert!(!contains(&frame, 99, 200));
    }

    #[test]
    fn 编码出来的是能解回原样的_png() {
        // 挡的是「压缩档与滤波换成 Sub + Fast 之后编出来的还是不是一个正常的 RGBA PNG」
        let image = image::RgbaImage::from_raw(
            2,
            2,
            vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255,
            ],
        )
        .unwrap();

        let mut png = Vec::new();
        encode_png(&image, &mut png).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

        let decoded = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (2, 2));
        assert_eq!(decoded.as_raw(), image.as_raw());
    }

    #[test]
    fn 文件名只留最后一段并换掉非法字符() {
        assert_eq!(safe_file_name("C:\\shots\\截图-1.png"), "截图-1.png");
        assert_eq!(safe_file_name("a/b/c.png"), "c.png");
        assert_eq!(safe_file_name("2026:10:12.png"), "2026_10_12.png");
        assert_eq!(safe_file_name("x?.png"), "x_.png");
    }

    #[test]
    fn 文件名补后缀与兜底() {
        assert_eq!(safe_file_name("没有后缀"), "没有后缀.png");
        assert_eq!(safe_file_name("   "), "截图.png");
        assert_eq!(safe_file_name(""), "截图.png");
        // 结尾的点与空格会被 Windows 吃掉，我们自己先去干净
        assert_eq!(safe_file_name("尾巴. "), "尾巴.png");
    }

    #[test]
    fn 同名加序号加在主名与后缀之间() {
        let dir = std::env::temp_dir().join(format!("wb-capture-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(unique_in(&dir, "截图.png"), dir.join("截图.png"));
        std::fs::write(dir.join("截图.png"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "截图.png"), dir.join("截图-2.png"));
        std::fs::write(dir.join("截图-2.png"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "截图.png"), dir.join("截图-3.png"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 落盘拒绝空目录并且会建目录() {
        assert!(save_bytes("", "a.png", true, b"x").is_err());
        assert!(save_bytes("   ", "a.png", true, b"x").is_err());

        let dir = std::env::temp_dir().join(format!("wb-capture-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let nested = dir.join("a").join("b");
        let written = save_bytes(nested.to_str().unwrap(), "图.png", true, b"png-bytes").unwrap();

        assert!(nested.join("图.png").is_file());
        assert_eq!(std::fs::read(&written).unwrap(), b"png-bytes");
        // unique 为真时第二次不会覆盖
        let again = save_bytes(
            nested.to_str().unwrap(),
            "图.png",
            true,
            "第二张".as_bytes(),
        )
        .unwrap();
        assert!(again.ends_with("图-2.png"));
        assert_eq!(std::fs::read(nested.join("图.png")).unwrap(), b"png-bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 坏_base64_给一句人话() {
        assert!(decode_png("这不是 base64!!").is_err());
        assert_eq!(decode_png("cG5n").unwrap(), b"png");
    }

    #[test]
    fn 复制选区的裁剪边界收敛到帧内() {
        assert_eq!(
            clamp_region(100, 50, 10, 10, 20, 20).unwrap(),
            (10, 10, 20, 20)
        );
        // 左上角出界：从帧的 (0, 0) 开始，只留伸进来的那一块
        assert_eq!(clamp_region(100, 50, -5, -5, 20, 20).unwrap(), (0, 0, 15, 15));
        // 右下角出界：夹到帧边界
        assert_eq!(clamp_region(100, 50, 90, 40, 20, 20).unwrap(), (90, 40, 10, 10));
        // 完全在帧外：空选区要报出来，别写一张 0×0 的图进剪贴板
        assert!(clamp_region(100, 50, 100, 50, 10, 10).is_err());
    }
}
