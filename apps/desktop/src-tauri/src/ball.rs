//! 悬浮球：桌面上随便摆的一颗网速球，拖到屏幕左右那条边才收成一条竖流量条。
//!
//! ## 一个判据：贴没贴住屏幕的左右边
//!
//! **贴着左右边**（`dock_of`）就是收起态 —— 贴在边上的 6×48 竖流量条，鼠标移开 1.5 秒收回去；
//! **浮在桌面上**就是 76×76 的整颗球，鼠标移开也不收（屏幕中间摆着的一条竖条既不像东西、
//! 也没地方可贴）。**没有吸附**：松手停在哪儿就是哪儿，只有「往屏幕外拖、被边夹住」那一下
//! 才算贴边；贴边就自动收起、拖出来就自动展开（都在 `settle_drop`）。
//!
//! **窗口尺寸必须等于可见形状**：透明窗口的隐形区域照样吃鼠标点击（见 screenshot.md 的
//! 「透明不影响点击」），开一个大窗口只画一小颗球的话，那圈看不见的地方会把桌面上的点击
//! 全吃掉。所以收起 / 展开要真的改窗口尺寸与位置 —— 这两件事都由 Rust 做，
//! 前端一条都不碰（capability 里那几个权限一个都不给）。
//!
//! ## 拖动：完全自由，只有撞到屏幕边才被夹住
//!
//! 拖动交给系统（页面上的 `data-tauri-drag-region`，跟手），Rust 挂在窗口的 `Moved` / `Resized`
//! 上把几何读回来：**两个方向都只夹进工作区**（不出屏幕、不压任务栏），横向不往边上吸 ——
//! 一吸球就飞回原来那条边，也就摆不到桌子中间去。贴没贴边留到松手之后再判（见 `settle_drop`）。
//! 判「松手了没有」认左键（见 `dragging`）：只判静默分不出「拖着停住」与「已经松手」。
//!
//! ## 记账
//!
//! 位置落在 `data\ball.json`（`pins.json` 同一待遇）：位置是这块屏上的坐标，换台机器不成立，
//! 也不进同步仓库。记的是「窗口左上角 + 贴没贴边」；展开还是收起不记 —— 那是位置的即时结果，
//! 重启回来按记账里的位置重算（贴边的回到那条边、浮着的还在原地，见 `place`）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

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
    /// 窗口左沿（物理像素）。**只在浮着时算数** —— 贴着边时 x 由那条边算出来（见 `place`），
    /// 免得换个状态（6 宽 / 76 宽）或换块屏就错位
    pub x: i32,
    /// 窗口上沿的 y（物理像素）
    pub y: i32,
    /// 贴着屏幕哪一侧。`None` = 浮在桌面上 —— 这时鼠标移开也不收起（见 `set_open`）
    pub side: Option<BallSide>,
}

/// 渲染层问「我现在是什么状态」时的回答
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BallContext {
    /// 贴着哪一侧，`None` = 浮着。前端照它决定鼠标移开收不收（收起只发生在贴边时）
    pub side: Option<BallSide>,
    pub y: i32,
    /// 展开（整颗球）还是收起（贴边那条竖条）
    pub open: bool,
}

/// 松手之后多久落定（判贴没贴边 + 摆位）。
///
/// 拖动是交给系统的（页面上的 `data-tauri-drag-region`），而系统那条 `WM_EXITSIZEMOVE`
/// 到不了这一层，所以「松手了没有」得自己认：**左键抬起**（见 `dragging`）+ 静默这么久。
/// 静默那一半是给「抬起后画面还在动」留的余量。
const DRAG_SETTLE_MS: u64 = 250;

/// 左键现在按着吗。
///
/// **这才是「还在拖」的真凭据**。只看「多久没 `Moved`」分不出「拖着停住了」和「已经松手」：
/// 拖到一半停下来想一下超过 `DRAG_SETTLE_MS`，就会被当成松手，球在手里被摆一次
/// （现象是拖动不跟手）；而真松手那一下**不产生任何 `Moved`**，那一轮已经用掉，
/// 于是没人再补一次 —— 球停在半路上。
fn dragging() -> bool {
    // 最高位是「此刻按下」，低位是「上次按键以来按过」，只认最高位
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

/// 该落定了吗：**手已经松开**，且窗口静默够久。纯函数，两个分支各有用例。
fn should_settle(pressed: bool, quiet_ms: u64) -> bool {
    !pressed && quiet_ms >= DRAG_SETTLE_MS
}

static CLOCK: OnceLock<Instant> = OnceLock::new();

fn now_ms() -> u64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// 摆位的写锁：`set_size` 与 `set_position` 是一对，中间不许别的写者插进来。
///
/// 写者有仨 —— 展开、收起（前端推的两条命令各跑在一条工作线程上）与松手落定（巡检线程）。
/// `size` 与 `position` 分开算、分开下发，插在中间的那一笔就会把两者的档位配错：
/// 尺寸落成展开的 76、位置却是收起那一档的 x —— 球只剩贴着屏幕边的一条
/// （用户报的「收不起来 / 只剩一条」）。整对一起落地就没这个窗口。
static PLACE_LOCK: Mutex<()> = Mutex::new(());

/// 拿摆位写锁。锁里只放两个下发调用，没有嵌套、也没有重入，中毒了也接着用
/// （这把锁不守任何不变量，只是一段互斥）
fn place_guard() -> std::sync::MutexGuard<'static, ()> {
    PLACE_LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

/// 记账 + 当前展开状态。记账是内存里这份为真源，每次改完同步进 JsonStore。
#[derive(Default)]
pub struct BallState {
    record: Mutex<Option<BallRecord>>,
    open: AtomicBool,
    /// 正在程序化地改尺寸 / 位置（收起 / 展开那一瞬间）。
    ///
    /// 这一小段里的 `Moved` / `Resized` **不参与落定**：事件是异步派发的，
    /// 处理时读到的还是改之前的状态，于是会拿「收起态该在的 x」去覆盖刚摆好的展开态位置 ——
    /// 现象是窗口宽 76、位置却还在贴边那一档（看着像一个压扁的椭圆）。
    moving: AtomicBool,
    /// 最后一次 `Moved` 的时刻（毫秒）。拖动中它一直在跳，停手之后就不动了 —— 靠它认「松手了」
    last_move: AtomicU64,
    /// 已经安排了一次「松手落定」的巡检线程，别重复起
    settle_pending: AtomicBool,
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

/// 算一次摆位。**纯函数**：屏幕尺寸、DPI、贴没贴边、四个方向的夹取都能单独测。
///
/// 宽度按 `scale` 折成物理像素再算 x 与夹取 —— 尺寸本身给的是逻辑像素（DPI 变了系统自己跟着缩放），
/// 但位置是物理像素，两者混着算就会在缩放屏上错位（与遮罩窗口同一条口径）。
///
/// **贴边那一档的 x 由那条边算出来**（左：工作区左沿；右：右沿减窗口宽）。收起 6 宽、展开 76 宽，
/// 要是照搬记账里的 x，换个状态就会露一条缝或者伸出屏幕外；另外贴边不留缝还有一条老原因 ——
/// 鼠标甩到屏幕边时会被系统钳在最后一个像素上，那一像素落在缝里就是「不在窗口内」，
/// 展开态的球收不到 hover，于是「收起 → 指针落回竖条 → 展开」每两秒来回抖一次。
///
/// **浮着那一档的 x 就是记账里那个**，只夹进工作区 —— 让球待在屏幕外等于把它弄丢。
fn place(work: WorkArea, record: BallRecord, open: bool, scale: f64) -> Placement {
    let logical_w = if open { OPEN_D } else { TUCKED_W };
    let logical_h = if open { OPEN_D } else { TUCKED_H };
    let width = (logical_w * scale).round() as i32;
    let height = (logical_h * scale).round() as i32;

    let max_x = (work.right - width).max(work.left);
    let x = match record.side {
        Some(BallSide::Left) => work.left,
        Some(BallSide::Right) => max_x,
        None => record.x.clamp(work.left, max_x),
    };

    // 纵向夹进工作区：下沿不压任务栏、上沿不出屏幕
    let max_y = (work.bottom - height).max(work.top);
    Placement {
        x,
        y: record.y.clamp(work.top, max_y),
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
        // 默认贴着右边（x 由那条边算，见 place，这儿给什么都不算数）
        x: work.right,
        y: work.top + span * 2 / 5,
        side: Some(BallSide::Right),
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

/// 把窗口摆到记账里那个位置该在的地方
fn apply_placement(window: &WebviewWindow, record: BallRecord, open: bool) -> Result<(), String> {
    // 摆的这几步会派发出 Moved / Resized，先举旗：这一小段里的事件不参与落定（见 BallState::moving）
    let state = window.app_handle().state::<BallState>();
    state.moving.store(true, Ordering::Relaxed);
    let result = place_now(window, record, open);
    state.moving.store(false, Ordering::Relaxed);
    result
}

/// 摆位落地。**调用方必须已持 `PLACE_LOCK`**（见那把锁的说明）：算尺寸、算位置、下发。
fn place_locked(window: &WebviewWindow, record: BallRecord, open: bool) -> Result<(), String> {
    let Some(work) = work_area(window) else {
        return Err("找不到这块屏幕".to_string());
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let at = place(work, record, open, scale);

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

/// 摆位落地（自己拿锁）。展开 / 收起走这条：它要摆的形状由调用方给定，不含「读当前状态」这一步。
fn place_now(window: &WebviewWindow, record: BallRecord, open: bool) -> Result<(), String> {
    let _guard = place_guard();
    place_locked(window, record, open)
}

/// 窗口现在是不是贴住了屏幕左右那条边；贴住了就是那条边，浮着就是 `None`。
///
/// 判据是**撞到墙**：拖动中 `sync_from_window` 会把横向夹进工作区（见那儿），
/// 所以「往屏幕外拖」落到这儿是精确贴边 —— 不留容差、也不是磁吸。
/// 拖到屏幕中间就返回 `None`：球停在人家中间，不收起来（用户要的就是这个）。
fn dock_of(work: WorkArea, x: i32, width: i32) -> Option<BallSide> {
    if x <= work.left {
        Some(BallSide::Left)
    } else if x + width >= work.right {
        Some(BallSide::Right)
    } else {
        None
    }
}

/// 拖动中把位置读回来：**两个方向都只夹进工作区，不往边上吸**。
///
/// 横向不在这里贴边 —— 一贴窗口就弹回原来那条边、中心永远跨不过屏幕中线，
/// 球也就摆不到桌子中间（用户报的「无法左右拖动」就是它）。贴没贴边留到松手之后判，
/// 见 `settle_drop`；这里夹的只是「不许拖出屏幕」（拖出去就看不见了）。
fn sync_from_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    // 正在程序化地摆位（收起 / 展开）：这一小段里的事件不落定
    if app.state::<BallState>().moving.load(Ordering::Relaxed) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Some(work) = work_area(&window) else {
        return;
    };

    // 两个方向都夹进工作区（不压任务栏、不出屏幕顶、也不让球跑到屏幕外）
    let max_x = (work.right - size.width as i32).max(work.left);
    let x = position.x.clamp(work.left, max_x);
    let max_y = (work.bottom - size.height as i32).max(work.top);
    let y = position.y.clamp(work.top, max_y);
    if x != position.x || y != position.y {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }

    let changed = {
        let state = app.state::<BallState>();
        let mut guard = state.record.lock().expect("锁中毒");
        // 拖动过程中先不动贴边状态：贴没贴边等松手之后按落点判（见 settle_drop）。
        // 还没有记账时（首次启动、文件被改坏）按窗口现在的位置判 —— 与松手那条同一个判据，
        // 不会凭空把浮着的球当成贴边的（写死一侧就会）。
        let side = match *guard {
            Some(record) => record.side,
            None => dock_of(work, x, size.width as i32),
        };
        let next = Some(BallRecord { x, y, side });
        let changed = *guard != next;
        *guard = next;
        changed
    };
    if changed {
        persist(app);
    }

    let state = app.state::<BallState>();
    // **只有「手按着搬出来的」位移才安排落定**。悬停展开 / 收起也是程序化摆位，同样会派发
    // `Moved` / `Resized`，可那不是拖动 —— 它们要是也走进落定，刚摊开的球会在 250ms 后
    // 按「贴边就收起」被收回去，指针还压在球上就又摊开，收放收放没完（用户报的）。
    // 判据就是左键按着（`dragging`，与「松手了没有」同一条）：拖动中手一直按着，
    // 而程序化摆位那几下指针没按键。
    if !dragging() {
        return;
    }
    state.last_move.store(now_ms(), Ordering::Relaxed);
    if !state.settle_pending.swap(true, Ordering::Relaxed) {
        schedule_settle(app);
    }
}

/// 松手之后落定：**左键松开**、且静默 `DRAG_SETTLE_MS` 没再动过，就判贴没贴边、摆位。
/// **只有拖动才会走到这儿**（见 `sync_from_window` 那条闸）。
///
/// **这一轮要活到真的松手**：巡检线程不能一看到「静默够了」就动手 —— 手还按着的时候
/// 位置归他（见 `dragging`），所以按着就一直等；等真松手了再落定。反过来（只看静默）
/// 会在手里把球摆一道，而且那一轮用掉之后不再补，松手就没着落了。
fn schedule_settle(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(80));
        // 球已经关了（用户关掉开关）：这一轮收摊，别让 settle_pending 一直挂着
        if handle.get_webview_window(BALL_LABEL).is_none() {
            handle
                .state::<BallState>()
                .settle_pending
                .store(false, Ordering::Relaxed);
            return;
        }
        let state = handle.state::<BallState>();
        if state.moving.load(Ordering::Relaxed) {
            continue; // 正在程序化摆位，等它摆完再说
        }
        let quiet = now_ms().saturating_sub(state.last_move.load(Ordering::Relaxed));
        if !should_settle(dragging(), quiet) {
            continue; // 还在拖（含「按着不动」），或者刚动过
        }
        // **先落旗、再落定**：落定那一下自己也会派发 `Moved`，落旗排在后面就会被它吞掉，
        // 「落定途中又动过」的那一轮就没了着落。先落旗，那条 `Moved` 会自己再起一轮
        state.settle_pending.store(false, Ordering::Relaxed);
        settle_drop(&handle);
        return;
    });
}

/// 松手落定：看窗口现在贴住哪条边，**贴边就收起、浮着就展开**，然后记账 + 摆位。
///
/// 这一步是「收起 / 展开」的第三个入口（前两个是前端推的那两条命令），而且**位置说了算**：
/// 拖到墙边松手 → 收成竖条；从墙边拖出来松手 → 摊回整颗球。前端那条 hover 链只管
/// 「贴边的球鼠标移进来临时展开」，收不收最后还是看它贴没贴边 —— 但**只对拖动生效**：
/// 那条 hover 链自己也会摆位，跟着走一遍就成了「谁也别想摊开」（见 `sync_from_window`）。
///
/// **读位置、判贴边、落地三件事在同一把锁里**（见 `PLACE_LOCK`）：中间被展开 / 收起插一脚，
/// 就会拿「刚才那个位置」去算、拿「现在的尺寸」落地 —— 两个档位对不上，
/// 球最后是一颗挂在收起那一档 x 上的球（屏幕上只剩贴着边的一条），
/// 或者一条落在展开那一档 x 上的竖条。所以落地那一下也**连尺寸一起比对**：
/// 被拆开过的窗口在这里收回来。
fn settle_drop(app: &AppHandle) {
    let Some(window) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };

    let _guard = place_guard();
    let Some(work) = work_area(&window) else {
        return;
    };
    let side = dock_of(work, position.x, size.width as i32);
    // 贴边收起、浮着展开：这一档由位置定，跟前端推的意图无关
    let open = side.is_none();
    let scale = window.scale_factor().unwrap_or(1.0);
    let at = place(work, BallRecord { x: position.x, y: position.y, side }, open, scale);
    // 夹过之后的 x / y 才是它真待着的地方
    let record = BallRecord { x: at.x, y: at.y, side };

    // **先记状态再摆位**：摆位会派发 Moved / Resized，事件读的就是这个值（同 set_open）
    app.state::<BallState>().open.store(open, Ordering::Relaxed);
    {
        let state = app.state::<BallState>();
        let mut guard = state.record.lock().expect("锁中毒");
        *guard = Some(record);
    }
    persist(app);

    let torn = at.x != position.x
        || at.y != position.y
        || at.width != size.width as i32
        || at.height != size.height as i32;
    if torn {
        let state = app.state::<BallState>();
        state.moving.store(true, Ordering::Relaxed);
        let _ = place_locked(&window, record, open);
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

    // 开出来是什么形状看记账落在哪儿：贴边的（含首次出现）是那条竖条，浮着的是整颗球
    let open = record.side.is_none();
    app.state::<BallState>().open.store(open, Ordering::Relaxed);
    apply_placement(&window, record, open)?;
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
///
/// **浮着的球不收**：收起是「贴边」的形态 —— 屏幕中间摆着的一条 6×48 竖条既不像东西、
/// 也没地方可贴。所以这一档直接回绝，把现在的状态原样返回，前端照它对齐就行
/// （它那边拿到 `open: true` 也就不会再推了）。贴边的球照旧收放。
pub fn set_open(app: &AppHandle, open: bool) -> Result<BallContext, String> {
    let window = app
        .get_webview_window(BALL_LABEL)
        .ok_or("悬浮球没开着")?;
    let record = record_of(app);
    if !open && record.side.is_none() {
        return Ok(context_of(app));
    }
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

    /// 贴着某条边的记账（x 不算数，由那条边算出来）
    fn docked(side: BallSide, y: i32) -> BallRecord {
        BallRecord {
            x: 0,
            y,
            side: Some(side),
        }
    }

    /// 浮在桌面上的记账
    fn floating(x: i32, y: i32) -> BallRecord {
        BallRecord { x, y, side: None }
    }

    #[test]
    fn 贴右边的_x_是工作区右沿减去球宽() {
        let at = place(screen(), docked(BallSide::Right, 300), true, 1.0);
        assert_eq!(at.width, 76);
        // 不留缝：窗口右沿就是屏幕右沿
        assert_eq!(at.x, 1920 - 76);
        assert_eq!(at.y, 300);
    }

    #[test]
    fn 贴左边的_x_就是工作区左沿() {
        let at = place(screen(), docked(BallSide::Left, 300), true, 1.0);
        assert_eq!(at.x, 0);
    }

    #[test]
    fn 收起态就是那条竖条本身() {
        let at = place(screen(), docked(BallSide::Right, 300), false, 1.0);
        assert_eq!((at.width, at.height), (6, 48));
        assert_eq!(at.x + at.width, 1920);
    }

    #[test]
    fn 浮着的球就摆在记账里那个位置() {
        let at = place(screen(), floating(880, 300), true, 1.0);
        assert_eq!((at.x, at.y), (880, 300));
        assert_eq!((at.width, at.height), (76, 76));
    }

    #[test]
    fn 浮着的球拖出屏幕会被夹回来() {
        // 左沿拖出屏幕左沿
        assert_eq!(place(screen(), floating(-400, 300), true, 1.0).x, 0);
        // 右沿拖出屏幕右沿
        assert_eq!(place(screen(), floating(1900, 300), true, 1.0).x, 1920 - 76);
    }

    #[test]
    fn 纵向夹在工作区里() {
        // 往上拖出屏幕
        assert_eq!(place(screen(), docked(BallSide::Right, -500), true, 1.0).y, 0);
        // 往下拖到任务栏底下
        assert_eq!(place(screen(), docked(BallSide::Right, 5000), true, 1.0).y, 1040 - 76);
        // 收起态更矮，能压得更低
        assert_eq!(place(screen(), docked(BallSide::Right, 5000), false, 1.0).y, 1040 - 48);
        // 浮着的也一样夹
        assert_eq!(place(screen(), floating(300, 5000), true, 1.0).y, 1040 - 76);
    }

    #[test]
    fn 工作区比球还小时不会算出负的_y() {
        let tiny = WorkArea {
            left: 0,
            top: 0,
            right: 200,
            bottom: 40,
        };
        let at = place(tiny, docked(BallSide::Right, 0), true, 1.0);
        assert_eq!(at.y, 0);
    }

    #[test]
    fn 缩放屏上按物理像素摆() {
        // 150% 缩放：球是 114 物理像素宽，x 要按 114 算，不能按 76
        let at = place(screen(), docked(BallSide::Right, 300), true, 1.5);
        assert_eq!(at.width, 114);
        assert_eq!(at.height, 114);
        assert_eq!(at.x, 1920 - 114);
        // 浮着的位置本来就是物理像素：原样摆，不跟着缩放走
        assert_eq!(place(screen(), floating(300, 300), true, 1.5).x, 300);
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
        let at = place(left_screen, docked(BallSide::Left, 100), true, 1.0);
        assert_eq!(at.x, -1920);
        let at = place(left_screen, docked(BallSide::Right, 100), true, 1.0);
        assert_eq!(at.x + at.width, 0);
        // 浮在左边那块屏上的球也按负坐标摆
        assert_eq!(place(left_screen, floating(-1500, 100), true, 1.0).x, -1500);
    }

    #[test]
    fn 撞到左右边才算贴边() {
        let work = screen();
        // 撞左沿（拖动中横向被夹住就是这一档）
        assert_eq!(dock_of(work, 0, 76), Some(BallSide::Left));
        assert_eq!(dock_of(work, -30, 76), Some(BallSide::Left));
        // 撞右沿
        assert_eq!(dock_of(work, 1920 - 76, 76), Some(BallSide::Right));
        assert_eq!(dock_of(work, 1900, 76), Some(BallSide::Right));
        // 只差一个像素也不吸：球就停在那儿，不收
        assert_eq!(dock_of(work, 1, 76), None);
        assert_eq!(dock_of(work, 1920 - 77, 76), None);
        // 屏幕中间
        assert_eq!(dock_of(work, 880, 76), None);
    }

    #[test]
    fn 负原点的多屏也按各自的边算() {
        let work = WorkArea {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1040,
        };
        assert_eq!(dock_of(work, -1920, 76), Some(BallSide::Left));
        assert_eq!(dock_of(work, -76, 76), Some(BallSide::Right));
        assert_eq!(dock_of(work, -1000, 76), None);
    }

    #[test]
    fn 收拾起来的竖条撞到边也算贴边() {
        // 收起态宽 6：右沿贴着屏幕右边
        assert_eq!(dock_of(screen(), 1920 - 6, 6), Some(BallSide::Right));
        // 离右边还有一截
        assert_eq!(dock_of(screen(), 1920 - 20, 6), None);
    }

    #[test]
    fn 手还按着就不算松手() {
        // 拖着停住想一下（静默早就够了）也不许落定 —— 位置归手，别在手里把球摆一道
        assert!(!should_settle(true, 0));
        assert!(!should_settle(true, DRAG_SETTLE_MS));
        assert!(!should_settle(true, 60_000));
    }

    #[test]
    fn 松开手还要等静默够了才落定() {
        assert!(!should_settle(false, DRAG_SETTLE_MS - 1));
        assert!(should_settle(false, DRAG_SETTLE_MS));
        // 真松手那一下不产生 Moved：静默只看「最后一次动」，所以松手后等着就是了
        assert!(should_settle(false, 60_000));
    }

    #[test]
    fn 记账_json_往返() {
        let record = floating(880, -120);
        let text = serde_json::to_string(&record).unwrap();
        assert!(text.contains("\"side\":null"));
        let back: BallRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(back, record);

        let record = docked(BallSide::Left, 300);
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
        let record: Option<BallRecord> = serde_json::from_value(
            serde_json::json!({ "side": "up", "x": 0, "y": 3 }),
        )
        .unwrap_or(None);
        assert!(record.is_none());
        // 只记「贴哪侧 + y」的那一版（没有 x）：认不出来，重新落一个默认位置
        let record: Option<BallRecord> =
            serde_json::from_value(serde_json::json!({ "side": "left", "y": 3 })).unwrap_or(None);
        assert!(record.is_none());
    }
}
