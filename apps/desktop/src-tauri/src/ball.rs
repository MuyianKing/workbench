//! 悬浮球：贴在屏幕左 / 右边缘、能上下拖的一颗网速球。
//!
//! ## 两个状态，两套窗口尺寸
//!
//! 收起时是 36×72 的半圆贴片（直边压在屏幕边上、不留缝），鼠标碰到它滑出来变成 76×76 的整颗球
//! （离边 8px）。**窗口尺寸必须等于可见形状**：透明窗口的隐形区域照样吃鼠标点击（见
//! screenshot.md 的「透明不影响点击」），开一个大窗口只画一小颗球的话，那圈看不见的地方会把
//! 桌面上的点击全吃掉。所以收起 / 展开要真的改窗口尺寸与位置 —— 这两件事都由 Rust 做，
//! 前端一条都不碰（capability 里那几个权限一个都不给）。
//!
//! ## 拖动：横向跟手，停手才吸附
//!
//! 拖动交给系统（页面上的 `data-tauri-drag-region`，跟手），Rust 挂在窗口的 `Moved` 上：
//! **只把纵向夹进工作区**（不压任务栏、也不出屏幕顶），横向一律不动它 ——
//! 一动就把窗口弹回原来那条边，中心永远跨不过屏幕中线，也就换不了侧。
//! 停手（连续 `DRAG_SETTLE_MS` 没有新的 `Moved`）之后才归位：按窗口中心落在哪一半定侧，再贴边。
//!
//! ## 记账
//!
//! 位置落在 `data\ball.json`（`pins.json` 同一待遇）：位置是这块屏上的坐标，换台机器不成立，
//! 也不进同步仓库。只记「贴哪一侧 + 纵向的 y」，横向由边算出来；收起还是展开不记 ——
//! 那是鼠标进出的即时状态，重启回来一律是收起的。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::paths;
use crate::store::JsonStore;

/// 窗口标签（capabilities/capture.json 里按它放行）
pub const BALL_LABEL: &str = "ball";

static BALL: OnceLock<JsonStore> = OnceLock::new();

pub fn ball_store() -> &'static JsonStore {
    BALL.get_or_init(|| JsonStore::new(paths::ball_file, "保存悬浮球位置"))
}

/// 收起态：贴着屏幕边的一条竖流量条（逻辑像素）。
/// **窗口就是这条竖条本身** —— 外面没有半圆底、也没有阴影。
const TUCKED_W: f64 = 6.0;
const TUCKED_H: f64 = 48.0;
/// 展开态：整颗球（逻辑像素）
const OPEN_D: f64 = 76.0;

/// 贴哪一侧
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BallSide {
    Left,
    Right,
}

/// 记账。字段名走 camelCase 出到渲染层，落盘也是这一份。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BallRecord {
    pub side: BallSide,
    /// 窗口上沿的 y（物理像素）
    pub y: i32,
}

/// 渲染层问「我现在是什么状态」时的回答
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BallContext {
    pub side: BallSide,
    pub y: i32,
    /// 展开（整颗球）还是收起（贴片）
    pub open: bool,
}

/// 拖动停手多久之后归位。
///
/// 拖动中系统会连着发 `Moved`，静了这么久就当他松手了。用「静默检测」而不是「拖动结束事件」：
/// 拖动是交给系统的（页面上的 `data-tauri-drag-region`），而系统那条 `WM_EXITSIZEMOVE`
/// 到不了这一层。
const DRAG_SETTLE_MS: u64 = 250;

static CLOCK: OnceLock<Instant> = OnceLock::new();

fn now_ms() -> u64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// 记账 + 当前展开状态。记账是内存里这份为真源，每次改完同步进 JsonStore。
#[derive(Default)]
pub struct BallState {
    record: Mutex<Option<BallRecord>>,
    open: AtomicBool,
    /// 正在程序化地改尺寸 / 位置（收起 / 展开那一瞬间）。
    ///
    /// 这一小段里的 `Moved` / `Resized` **不参与归位**：事件是异步派发的，
    /// 处理时读到的还是改之前的状态，于是会拿「收起态该在的 x」去覆盖刚摆好的展开态位置 ——
    /// 现象是窗口宽 76、位置却还在贴边那一档（看着像一个压扁的椭圆）。
    moving: AtomicBool,
    /// 最后一次 `Moved` 的时刻（毫秒）。拖动中它一直在跳，停手之后就不动了 —— 靠它认「松手了」
    last_move: AtomicU64,
    /// 已经安排了一次「停手归位」的巡检线程，别重复起
    snap_pending: AtomicBool,
}

/// 屏幕工作区（物理像素）：不含任务栏那一块
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct WorkArea {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// 摆位结果，都是物理像素
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 算一次摆位。**纯函数**：屏幕尺寸、DPI、左右两侧、上下夹取都能单独测。
///
/// 宽度按 `scale` 折成物理像素再算 x 与夹取 —— 尺寸本身给的是逻辑像素（DPI 变了系统自己跟着缩放），
/// 但位置是物理像素，两者混着算就会在缩放屏上错位（与遮罩窗口同一条口径）。
///
/// **两种状态都贴着屏幕边，不留缝**。留缝看着好看，但鼠标甩到屏幕边时会被系统钳在最后一个像素上，
/// 那一像素落在缝里就是「不在窗口内」—— 展开态的球收不到 hover，于是「收起 → 指针又落回竖条 → 展开」
/// 每两秒来回抖一次。贴边之后指针在边上永远在窗口里。
fn place(work: WorkArea, side: BallSide, y: i32, open: bool, scale: f64) -> Placement {
    let logical_w = if open { OPEN_D } else { TUCKED_W };
    let logical_h = if open { OPEN_D } else { TUCKED_H };
    let width = (logical_w * scale).round() as i32;
    let height = (logical_h * scale).round() as i32;

    let x = match side {
        BallSide::Right => work.right - width,
        BallSide::Left => work.left,
    };

    // 纵向夹进工作区：下沿不压任务栏、上沿不出屏幕
    let max_y = (work.bottom - height).max(work.top);
    Placement {
        x,
        y: y.clamp(work.top, max_y),
        width,
        height,
    }
}

fn work_area(window: &WebviewWindow) -> Option<WorkArea> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some(WorkArea {
        left: area.position.x,
        top: area.position.y,
        right: area.position.x + area.size.width as i32,
        bottom: area.position.y + area.size.height as i32,
    })
}

/// 首次出现的落点：右侧、纵向约 40% 处（跟 360 那颗球一个习惯）
fn default_record(app: &AppHandle) -> BallRecord {
    let work = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let area = monitor.work_area();
            WorkArea {
                left: area.position.x,
                top: area.position.y,
                right: area.position.x + area.size.width as i32,
                bottom: area.position.y + area.size.height as i32,
            }
        })
        .unwrap_or(WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        });

    let span = (work.bottom - work.top - TUCKED_H as i32).max(0);
    BallRecord {
        side: BallSide::Right,
        y: work.top + span * 2 / 5,
    }
}

fn record_of(app: &AppHandle) -> BallRecord {
    let state = app.state::<BallState>();
    let current = *state.record.lock().expect("锁中毒");
    current.unwrap_or_else(|| default_record(app))
}

/// 启动时把记账读回来（读不出、格式不对都当「没记过」，不影响启动）
pub fn load(app: &AppHandle) {
    let raw = ball_store().load();
    let record: Option<BallRecord> = serde_json::from_value(raw).unwrap_or(None);
    *app.state::<BallState>().record.lock().expect("锁中毒") = record;
}

fn persist(app: &AppHandle) {
    let record = *app.state::<BallState>().record.lock().expect("锁中毒");
    ball_store().set(serde_json::to_value(record).unwrap_or(Value::Null));
    ball_store().schedule();
}

/// 把窗口摆到「这一侧 + 这个 y + 这个状态」该在的地方
fn apply_placement(window: &WebviewWindow, record: BallRecord, open: bool) -> Result<(), String> {
    // 摆的这几步会派发出 Moved / Resized，先举旗：这一小段里的事件不参与归位（见 BallState::moving）
    let state = window.app_handle().state::<BallState>();
    state.moving.store(true, Ordering::Relaxed);
    let result = place_now(window, record, open);
    state.moving.store(false, Ordering::Relaxed);
    result
}

fn place_now(window: &WebviewWindow, record: BallRecord, open: bool) -> Result<(), String> {
    let Some(work) = work_area(window) else {
        return Err("找不到这块屏幕".to_string());
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let at = place(work, record.side, record.y, open, scale);

    // 尺寸给逻辑像素：DPI 变了系统自己跟着缩放（位置是物理像素，见 place 的说明）
    let logical_w = if open { OPEN_D } else { TUCKED_W };
    let logical_h = if open { OPEN_D } else { TUCKED_H };
    window
        .set_size(LogicalSize::new(logical_w, logical_h))
        .map_err(|err| format!("定悬浮球尺寸失败：{err}"))?;
    window
        .set_position(PhysicalPosition::new(at.x, at.y))
        .map_err(|err| format!("摆悬浮球失败：{err}"))?;
    Ok(())
}

/// 窗口中心落在工作区哪一半，就算贴哪一侧
fn side_of(center: i32, work: WorkArea) -> BallSide {
    let middle = work.left + (work.right - work.left) / 2;
    if center < middle {
        BallSide::Left
    } else {
        BallSide::Right
    }
}

/// 拖动中把位置读回来：**只把纵向夹进工作区，横向跟着鼠标走**。
///
/// 横向不在这里归位 —— 一归位窗口就弹回原来的边，中心永远跨不过屏幕中线，
/// 「拖到另一侧」这件事就根本做不到（用户报的「无法左右拖动」就是它）。
/// 归位挪到停手之后，见 `schedule_snap`。
fn sync_from_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    // 正在程序化地摆位（收起 / 展开）：这一小段里的事件不归位
    if app.state::<BallState>().moving.load(Ordering::Relaxed) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Some(work) = work_area(&window) else {
        return;
    };

    // 纵向夹进工作区（不压任务栏、不出屏幕顶），横向原样留着
    let max_y = (work.bottom - size.height as i32).max(work.top);
    let y = position.y.clamp(work.top, max_y);
    if y != position.y {
        let _ = window.set_position(PhysicalPosition::new(position.x, y));
    }

    let changed = {
        let state = app.state::<BallState>();
        let mut guard = state.record.lock().expect("锁中毒");
        // 拖动过程中先不动派别：贴哪一侧等停手之后按落点定（见 snap_to_edge）
        let side = (*guard).map_or(BallSide::Right, |record| record.side);
        let next = Some(BallRecord { side, y });
        let changed = *guard != next;
        *guard = next;
        changed
    };
    if changed {
        persist(app);
    }

    let state = app.state::<BallState>();
    state.last_move.store(now_ms(), Ordering::Relaxed);
    if !state.snap_pending.swap(true, Ordering::Relaxed) {
        schedule_snap(app);
    }
}

/// 停手之后归位：静默 `DRAG_SETTLE_MS` 没再动过，就按窗口中心定侧、贴边。
fn schedule_snap(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(80));
        let state = handle.state::<BallState>();
        if state.moving.load(Ordering::Relaxed) {
            continue; // 正在程序化摆位，等它摆完再说
        }
        let quiet = now_ms().saturating_sub(state.last_move.load(Ordering::Relaxed));
        if quiet < DRAG_SETTLE_MS {
            continue; // 还在拖
        }
        snap_to_edge(&handle);
        handle
            .state::<BallState>()
            .snap_pending
            .store(false, Ordering::Relaxed);
        return;
    });
}

/// 按窗口中心落在哪一半定侧，然后贴边摆好、记账。
fn snap_to_edge(app: &AppHandle) {
    let Some(window) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Some(work) = work_area(&window) else {
        return;
    };

    let side = side_of(position.x + size.width as i32 / 2, work);
    let open = app.state::<BallState>().open.load(Ordering::Relaxed);
    let scale = window.scale_factor().unwrap_or(1.0);
    let at = place(work, side, position.y, open, scale);

    let changed = {
        let state = app.state::<BallState>();
        let mut guard = state.record.lock().expect("锁中毒");
        let next = Some(BallRecord { side, y: at.y });
        let changed = *guard != next;
        *guard = next;
        changed
    };
    if changed {
        persist(app);
    }

    if at.x != position.x || at.y != position.y {
        let state = app.state::<BallState>();
        state.moving.store(true, Ordering::Relaxed);
        let _ = window.set_position(PhysicalPosition::new(at.x, at.y));
        state.moving.store(false, Ordering::Relaxed);
    }
}

fn create_window(app: &AppHandle, record: BallRecord) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::App("ball.html".into()))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        // 透明度要靠它：WebView2 的窗口底色默认不透明（见 pin.rs 的同一条说明）
        .transparent(true)
        .visible(false)
        // 展开是靠鼠标悬停触发的，抢焦点会让底下正在打字的窗口断掉
        .focused(false)
        .title("网速球")
        .build()
        .map_err(|err| format!("开悬浮球窗口失败：{err}"))?;

    // 拖动与 DPI 变化都靠这两个事件把几何读回来（拖动是系统在搬窗口，前端不知道新位置）
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => sync_from_window(&handle),
        _ => {}
    });

    apply_placement(&window, record, false)?;
    window
        .show()
        .map_err(|err| format!("显示悬浮球失败：{err}"))?;
    Ok(())
}

/// 开 / 关悬浮球。**值由渲染层推**：Rust 不去数据文件里读设置（见 register_hotkeys 的说明 ——
/// 盘上那份在「刚加的字段还没写回盘」那一段是空的）。
pub fn apply(app: &AppHandle, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(window) = app.get_webview_window(BALL_LABEL) {
            let _ = window.close();
        }
        app.state::<BallState>().open.store(false, Ordering::Relaxed);
        return Ok(());
    }

    if app.get_webview_window(BALL_LABEL).is_some() {
        return Ok(());
    }

    create_window(app, record_of(app))
}

fn context_of(app: &AppHandle) -> BallContext {
    let record = record_of(app);
    BallContext {
        side: record.side,
        y: record.y,
        open: app.state::<BallState>().open.load(Ordering::Relaxed),
    }
}

/// 收起 / 展开。意图（鼠标进出 + 防抖）在渲染层，窗口尺寸与位置在这里。
pub fn set_open(app: &AppHandle, open: bool) -> Result<BallContext, String> {
    let window = app
        .get_webview_window(BALL_LABEL)
        .ok_or("悬浮球没开着")?;
    let record = record_of(app);
    // **先记状态再摆位**：摆位会派发 Moved / Resized，事件处理读的就是这个值 ——
    // 反过来的话那两条事件读到的还是旧状态，会按旧状态把位置改回去（见 BallState::moving）
    app.state::<BallState>().open.store(open, Ordering::Relaxed);
    apply_placement(&window, record, open)?;
    Ok(BallContext {
        side: record.side,
        y: record.y,
        open,
    })
}

// ---------- 命令 ----------

/// 开关悬浮球（角色同 capture_prewarm：设置改了就推一次）
///
/// 标 `(async)` 不是因为它慢，而是**建 webview 窗口不能跑在主线程上**：
/// IPC 命令默认在主线程执行，而 `WebviewWindowBuilder::build()` 要等主线程去泵消息 ——
/// 在主线程里等主线程就是死锁（现象是这条通道永远不返回、窗口停在 about:blank）。
/// capture_prewarm / pin_create 两条建窗口的命令同此。
#[tauri::command(async)]
pub fn ball_apply(app: AppHandle, visible: bool) -> Result<(), String> {
    apply(&app, visible)
}

/// 球窗口问自己现在贴哪一侧、收起还是展开
#[tauri::command]
pub fn ball_context(app: AppHandle) -> BallContext {
    context_of(&app)
}

/// 收起 / 展开（改窗口尺寸与位置，同样走工作线程，别占主线程）
#[tauri::command(async)]
pub fn ball_open(app: AppHandle, open: bool) -> Result<BallContext, String> {
    set_open(&app, open)
}

/// 把主界面唤出来（双击球）。球是常驻的，主窗口可能收在托盘里、也可能被别的程序压住，
/// 所以走托盘左键那套判定（见 main.rs 的 show_main_window）。
#[tauri::command(async)]
pub fn ball_open_main(app: AppHandle) {
    crate::show_main_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> WorkArea {
        WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            // 任务栏 40px：工作区下沿是 1040
            bottom: 1040,
        }
    }

    #[test]
    fn 右侧贴边的_x_是屏幕宽减去球宽() {
        let at = place(screen(), BallSide::Right, 300, true, 1.0);
        assert_eq!(at.width, 76);
        // 不留缝：窗口右沿就是屏幕右沿
        assert_eq!(at.x, 1920 - 76);
        assert_eq!(at.y, 300);
    }

    #[test]
    fn 左侧贴边的_x_就是屏幕左沿() {
        let at = place(screen(), BallSide::Left, 300, true, 1.0);
        assert_eq!(at.x, 0);
    }

    #[test]
    fn 收起态就是那条竖条本身() {
        let at = place(screen(), BallSide::Right, 300, false, 1.0);
        assert_eq!((at.width, at.height), (6, 48));
        assert_eq!(at.x + at.width, 1920);
    }

    #[test]
    fn 纵向夹在工作区里() {
        // 往上拖出屏幕
        assert_eq!(place(screen(), BallSide::Right, -500, true, 1.0).y, 0);
        // 往下拖到任务栏底下
        assert_eq!(place(screen(), BallSide::Right, 5000, true, 1.0).y, 1040 - 76);
        // 收起态更矮，能压得更低
        assert_eq!(place(screen(), BallSide::Right, 5000, false, 1.0).y, 1040 - 48);
    }

    #[test]
    fn 工作区比球还小时不会算出负的_y() {
        let tiny = WorkArea {
            left: 0,
            top: 0,
            right: 200,
            bottom: 40,
        };
        let at = place(tiny, BallSide::Right, 0, true, 1.0);
        assert_eq!(at.y, 0);
    }

    #[test]
    fn 缩放屏上按物理像素摆() {
        // 150% 缩放：球是 114 物理像素宽，x 要按 114 算，不能按 76
        let at = place(screen(), BallSide::Right, 300, true, 1.5);
        assert_eq!(at.width, 114);
        assert_eq!(at.height, 114);
        assert_eq!(at.x, 1920 - 114);
    }

    #[test]
    fn 多屏的工作区原点是负的也算得对() {
        // 左边那块屏：工作区从 -1920 开始
        let left_screen = WorkArea {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1040,
        };
        let at = place(left_screen, BallSide::Left, 100, true, 1.0);
        assert_eq!(at.x, -1920);
        let at = place(left_screen, BallSide::Right, 100, true, 1.0);
        assert_eq!(at.x + at.width, 0);
    }

    #[test]
    fn 中心落在哪一半就贴哪一侧() {
        let work = screen();
        // 工作区 0..1920，中线 960
        assert_eq!(side_of(0, work), BallSide::Left);
        assert_eq!(side_of(959, work), BallSide::Left);
        assert_eq!(side_of(960, work), BallSide::Right);
        assert_eq!(side_of(1919, work), BallSide::Right);
    }

    #[test]
    fn 负原点的多屏也按各自的中线分() {
        let work = WorkArea {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1040,
        };
        // 中线 -960
        assert_eq!(side_of(-1500, work), BallSide::Left);
        assert_eq!(side_of(-100, work), BallSide::Right);
    }

    #[test]
    fn 记账_json_往返() {
        let record = BallRecord {
            side: BallSide::Left,
            y: -120,
        };
        let text = serde_json::to_string(&record).unwrap();
        assert!(text.contains("\"side\":\"left\""));
        let back: BallRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(back, record);
    }

    #[test]
    fn 认不出的记账当没记过() {
        // 老版本 / 手改坏的文件：不能把启动带崩，回落成 None 由 default_record 兜
        let record: Option<BallRecord> = serde_json::from_value(Value::Null).unwrap_or(None);
        assert!(record.is_none());
        let record: Option<BallRecord> =
            serde_json::from_value(serde_json::json!({ "side": "up", "y": 3 })).unwrap_or(None);
        assert!(record.is_none());
    }
}
