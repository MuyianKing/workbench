//! 钉图：把一张图钉在屏幕上（置顶、可拖动、可缩放、可调透明度、可鼠标穿透）。
//!
//! ## 一张钉图的两半
//!
//! **图片**落在 `data\pins\<id>.png`（钉图关掉时连文件一起删），**记账**落在
//! `data\pins.json`（位置 / 尺寸 / 透明度 / 穿透）。记账进 JsonStore 的防抖落盘，
//! 与工作日志同一套；下次启动时 `restore` 照着记账把图重新钉回来 ——
//! 一段没做完的工作不该因为重启就散掉。
//!
//! ## 为什么钉图窗口是透明的
//!
//! 透明度（Snipaste 的 Ctrl+滚轮）只能靠 CSS 的 `opacity`，而 WebView2 的窗口底色默认
//! 是不透明的 —— CSS 再透明，底下露出来的也是窗口底色而不是桌面。所以窗口要开
//! `transparent(true)`，页面里的 `html` / `body` 也必须真的透明（见 pin.html）。
//! 代价是没有窗口阴影（`shadow(false)`），换来的是能透过图看到桌面。
//!
//! ## 穿透怎么收回来
//!
//! `set_ignore_cursor_events(true)` 之后钉图收不到任何鼠标事件 —— 界面上的菜单也就点不到了。
//! 唯一的退路是全局快捷键（见 main.rs 的 PIN_THROUGH_HOTKEY），它把**所有**钉图一起翻面。

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::fs_util;
use crate::paths;
use crate::store::JsonStore;

/// 钉图窗口的标签前缀
pub const PIN_PREFIX: &str = "pin-";

static PINS: OnceLock<JsonStore> = OnceLock::new();

pub fn pin_store() -> &'static JsonStore {
    PINS.get_or_init(|| JsonStore::new(paths::pins_file, "保存钉图记录"))
}

/// 一张钉图。字段名走 camelCase 出到渲染层，落盘也是这一份（这份文件不对外，怎么顺手怎么来）
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRecord {
    pub id: String,
    /// 图片的绝对路径（`data\pins\<id>.png`）
    pub file: String,
    pub x: i32,
    pub y: i32,
    /// 窗口尺寸（物理像素）
    pub width: u32,
    pub height: u32,
    /// 不透明度（百分比，20~100）
    pub opacity: u32,
    /// 鼠标穿透：开着的时候点它等于点它底下那个窗口
    pub click_through: bool,
    /// 图片的原始长宽比（宽 / 高）：缩放时按它保持比例
    pub ratio: f64,
}

/// 渲染层改钉图状态时递上来的补丁（只带改动的项）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PinPatch {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub opacity: Option<u32>,
    pub click_through: Option<bool>,
}

/// 当前钉着的那几张（内存里的那份才是真源，每次改完同步进 JsonStore）
#[derive(Default)]
pub struct Pins(pub Mutex<Vec<PinRecord>>);

pub fn pin_label(id: &str) -> String {
    format!("{PIN_PREFIX}{id}")
}

fn pin_id(label: &str) -> Option<&str> {
    label.strip_prefix(PIN_PREFIX).filter(|id| !id.is_empty())
}

/// 启动时把记账读回来（读不出、格式不对都当「没有钉图」，不影响启动）
pub fn load(app: &AppHandle) {
    let raw = pin_store().load();
    let records: Vec<PinRecord> = serde_json::from_value(raw).unwrap_or_default();
    *app.state::<Pins>().0.lock().unwrap() = records;
}

/// 启动时把上次钉着的图重新钉回来。图不在了（用户删过、盘没挂上）就丢掉那条记录。
pub fn restore(app: &AppHandle) {
    let records = app.state::<Pins>().0.lock().unwrap().clone();
    let total = records.len();
    let mut kept = Vec::new();

    for record in records {
        if !Path::new(&record.file).is_file() {
            continue;
        }
        // asset 协议的授权是进程内的：重启之后要重新按文件给一遍
        if app.asset_protocol_scope().allow_file(&record.file).is_err() {
            continue;
        }
        if create_window(app, &record).is_ok() {
            kept.push(record);
        }
    }

    let changed = kept.len() != total;
    *app.state::<Pins>().0.lock().unwrap() = kept.clone();
    if changed {
        persist(&kept);
    }
}

fn persist(records: &[PinRecord]) {
    pin_store().set(serde_json::to_value(records).unwrap_or(Value::Null));
    pin_store().schedule();
}

/// 建一张钉图：先把 PNG 存下来，再开窗，最后记账。
///
/// `width` / `height` 是**物理像素**（渲染层按 initialPinSize 算好递过来），位置同样按
/// 物理像素摆 —— 与遮罩窗口同一条口径（builder 上的 position / inner_size 是逻辑坐标）。
pub fn create(
    app: &AppHandle,
    png: &[u8],
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    opacity: u32,
) -> Result<PinRecord, String> {
    let image =
        image::load_from_memory(png).map_err(|err| format!("钉图：这张图解不开（{err}）"))?;

    let dir = paths::pins_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("建钉图目录失败：{err}"))?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let file = dir.join(format!("{id}.png"));
    fs_util::write_atomic(&file, png)?;
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|err| format!("把钉图交给界面加载失败：{err}"))?;

    let record = PinRecord {
        id,
        file: file.to_string_lossy().into_owned(),
        x,
        y,
        width,
        height,
        opacity,
        click_through: false,
        ratio: if image.height() > 0 {
            f64::from(image.width()) / f64::from(image.height())
        } else {
            1.0
        },
    };

    if let Err(err) = create_window(app, &record) {
        // 窗口没开起来就别留那张图与那条记账
        let _ = std::fs::remove_file(&record.file);
        return Err(err);
    }

    let all = {
        let state = app.state::<Pins>();
        let mut guard = state.0.lock().unwrap();
        guard.push(record.clone());
        guard.clone()
    };
    persist(&all);

    Ok(record)
}

fn create_window(app: &AppHandle, record: &PinRecord) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(
        app,
        pin_label(&record.id),
        WebviewUrl::App("pin.html".into()),
    )
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    // 透明度要靠它：WebView2 的窗口底色默认不透明，CSS 的 opacity 会透出底色而不是桌面
    .transparent(true)
    .visible(false)
    .title("钉图")
    .build()
    .map_err(|err| format!("开钉图窗口失败：{err}"))?;

    window
        .set_position(PhysicalPosition::new(record.x, record.y))
        .map_err(|err| format!("摆钉图窗口失败：{err}"))?;
    window
        .set_size(PhysicalSize::new(record.width, record.height))
        .map_err(|err| format!("定钉图窗口尺寸失败：{err}"))?;

    if record.click_through {
        let _ = window.set_ignore_cursor_events(true);
    }

    // 被系统关掉（Alt+F4、任务管理器之类）也要记账：不然下次启动会照着一份旧账
    // 把已经关掉的图又钉回来。我们自己调 close() 时先删了记录，这里就成了空转。
    //
    // Moved / Resized 是**拖动与缩放**那条：拖动是系统在搬窗口（页面上的
    // data-tauri-drag-region），前端并不知道新位置，只能在这儿把几何读回来补记。
    let handle = app.clone();
    let id = record.id.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { .. } => prune(&handle, &id),
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            sync_geometry(&handle, &id)
        }
        _ => {}
    });

    window
        .show()
        .map_err(|err| format!("显示钉图窗口失败：{err}"))?;
    Ok(())
}

/// 把窗口**当前**的几何读回来写进记账。
///
/// 拖动过程中 Moved 会连发很多次，不过 JsonStore 是防抖落盘的（300ms 合并），
/// 一路拖下来只会写一次；几何没变时这里直接返回，连那次写都省掉
/// （我们自己 set_size / set_position 之后系统也会回一个事件）。
fn sync_geometry(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window(&pin_label(id)) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };

    let all = {
        let state = app.state::<Pins>();
        let mut guard = state.0.lock().unwrap();
        let Some(record) = guard.iter_mut().find(|record| record.id == id) else {
            return;
        };
        if record.x == position.x
            && record.y == position.y
            && record.width == size.width
            && record.height == size.height
        {
            return;
        }
        record.x = position.x;
        record.y = position.y;
        record.width = size.width;
        record.height = size.height;
        guard.clone()
    };

    persist(&all);
}

/// 把一条记账（连它的图片）抹掉。记录不在了就什么都不做。
fn prune(app: &AppHandle, id: &str) {
    let (all, removed) = {
        let state = app.state::<Pins>();
        let mut guard = state.0.lock().unwrap();
        match guard.iter().position(|record| record.id == id) {
            Some(index) => {
                let record = guard.remove(index);
                (guard.clone(), Some(record))
            }
            None => (guard.clone(), None),
        }
    };

    if let Some(record) = removed {
        let _ = std::fs::remove_file(&record.file);
        persist(&all);
    }
}

fn find(app: &AppHandle, id: &str) -> Option<PinRecord> {
    app.state::<Pins>()
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|record| record.id == id)
        .cloned()
}

/// 改钉图状态：窗口几何交给系统，记账跟着更新。
///
/// 缩放与移动都走这里 —— 渲染层用 `@workbench/capture` 里的纯函数把新位置与新尺寸算好
/// （以光标为不动点、保持长宽比、夹住上下限），Rust 只负责把结果落到窗口与磁盘上。
pub fn update(app: &AppHandle, id: &str, patch: PinPatch) -> Result<PinRecord, String> {
    let window = app
        .get_webview_window(&pin_label(id))
        .ok_or("这张钉图已经不在了")?;

    let next = {
        let state = app.state::<Pins>();
        let mut guard = state.0.lock().unwrap();
        let record = guard
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or("找不到这张钉图")?;

        if let Some(x) = patch.x {
            record.x = x;
        }
        if let Some(y) = patch.y {
            record.y = y;
        }
        if let Some(width) = patch.width {
            record.width = width;
        }
        if let Some(height) = patch.height {
            record.height = height;
        }
        if let Some(opacity) = patch.opacity {
            record.opacity = opacity.clamp(20, 100);
        }
        if let Some(click_through) = patch.click_through {
            record.click_through = click_through;
        }

        guard.clone()
    };

    let record = next
        .iter()
        .find(|record| record.id == id)
        .cloned()
        .ok_or("找不到这张钉图")?;

    // 几何与穿透各设一遍：位置与尺寸分开调用，改一个的时候另一个保持原值
    window
        .set_position(PhysicalPosition::new(record.x, record.y))
        .map_err(|err| format!("挪钉图窗口失败：{err}"))?;
    window
        .set_size(PhysicalSize::new(record.width, record.height))
        .map_err(|err| format!("改钉图窗口尺寸失败：{err}"))?;
    window
        .set_ignore_cursor_events(record.click_through)
        .map_err(|err| format!("切换钉图穿透失败：{err}"))?;

    persist(&next);
    Ok(record)
}

/// 关掉一张钉图：先抹掉记账与图片，再关窗口
///（顺序反了的话窗口事件会先跑一遍 prune，那里会把文件删掉 —— 结果一样，只是白跑一趟）
pub fn close(app: &AppHandle, id: &str) {
    prune(app, id);
    if let Some(window) = app.get_webview_window(&pin_label(id)) {
        let _ = window.close();
    }
}

/// 把所有钉图的鼠标穿透翻一面。
///
/// 这是穿透**唯一**的收回入口：穿透之后点不到钉图，界面上的菜单也就够不着了
/// （见文件头「穿透怎么收回来」）。只要还有一张没穿透，这一次就把全部变穿透。
pub fn toggle_click_through(app: &AppHandle) {
    let all = {
        let state = app.state::<Pins>();
        let mut guard = state.0.lock().unwrap();
        if guard.is_empty() {
            return;
        }
        let target = !guard.iter().all(|record| record.click_through);
        for record in guard.iter_mut() {
            record.click_through = target;
        }
        guard.clone()
    };

    for record in &all {
        if let Some(window) = app.get_webview_window(&pin_label(&record.id)) {
            let _ = window.set_ignore_cursor_events(record.click_through);
            // 渲染层也要知道（右键菜单里那一项的勾）
            let _ = window.emit("pin:state", record);
        }
    }

    persist(&all);
}

// ---------- 命令 ----------

/// 建一张钉图。返回这张钉图的记账（渲染层据此对尺寸 / 透明度）。
#[tauri::command(async)]
pub fn pin_create(
    app: AppHandle,
    png: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    opacity: u32,
) -> Result<PinRecord, String> {
    let bytes = crate::encoding::base64_decode(png.trim()).ok_or("钉图数据不完整")?;
    create(&app, &bytes, x, y, width, height, opacity)
}

/// 钉图窗口问「我是哪一张、长宽比多少、现在什么透明度」
#[tauri::command]
pub fn pin_context(window: WebviewWindow, app: AppHandle) -> Result<PinRecord, String> {
    let id = pin_id(window.label()).ok_or("这个窗口不是钉图")?;
    find(&app, id).ok_or_else(|| "这张钉图已经不在了".to_string())
}

#[tauri::command(async)]
pub fn pin_update(
    window: WebviewWindow,
    app: AppHandle,
    patch: PinPatch,
) -> Result<PinRecord, String> {
    let id = pin_id(window.label())
        .ok_or("这个窗口不是钉图")?
        .to_string();
    update(&app, &id, patch)
}

#[tauri::command]
pub fn pin_close(window: WebviewWindow, app: AppHandle) {
    if let Some(id) = pin_id(window.label()) {
        close(&app, id);
    }
}

/// 把这张钉图的图放进剪贴板（读盘上的那份，不用渲染层再编一遍）
#[tauri::command(async)]
pub fn pin_copy(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    let id = pin_id(window.label()).ok_or("这个窗口不是钉图")?;
    let record = find(&app, id).ok_or("这张钉图已经不在了")?;
    let bytes = std::fs::read(&record.file).map_err(|err| format!("读钉图失败：{err}"))?;
    crate::clipboard::write_png(&bytes)
}

/// 把这张钉图另存一份
#[tauri::command(async)]
pub fn pin_save(
    window: WebviewWindow,
    app: AppHandle,
    dir: String,
    name: String,
    unique: bool,
) -> Result<String, String> {
    let id = pin_id(window.label()).ok_or("这个窗口不是钉图")?;
    let record = find(&app, id).ok_or("这张钉图已经不在了")?;
    let bytes = std::fs::read(&record.file).map_err(|err| format!("读钉图失败：{err}"))?;
    crate::capture::save_bytes(&dir, &name, unique, &bytes)
}

/// 关掉所有钉图（托盘菜单里那一项）
#[tauri::command]
pub fn pin_close_all(app: AppHandle) {
    let ids: Vec<String> = app
        .state::<Pins>()
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|record| record.id.clone())
        .collect();
    for id in ids {
        close(&app, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 标签与_id_互认() {
        assert_eq!(pin_label("abc"), "pin-abc");
        assert_eq!(pin_id("pin-abc"), Some("abc"));
        assert_eq!(pin_id("pin-"), None);
        assert_eq!(pin_id("main"), None);
        assert_eq!(pin_id("capture-0"), None);
    }

    #[test]
    fn 记账_json_往返() {
        let record = PinRecord {
            id: "a".into(),
            file: "C:\\x\\a.png".into(),
            x: -100,
            y: 20,
            width: 300,
            height: 200,
            opacity: 80,
            click_through: true,
            ratio: 1.5,
        };
        let text = serde_json::to_string(&record).unwrap();
        // 出到渲染层与落盘都是 camelCase
        assert!(text.contains("\"clickThrough\":true"));

        let back: PinRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(back.id, "a");
        assert_eq!(back.x, -100);
        assert!(back.click_through);
    }

    #[test]
    fn 补丁只带改动项() {
        let patch: PinPatch = serde_json::from_str(r#"{"opacity":70}"#).unwrap();
        assert_eq!(patch.opacity, Some(70));
        assert_eq!(patch.click_through, None);
        assert_eq!(patch.x, None);

        let empty: PinPatch = serde_json::from_str("{}").unwrap();
        assert!(empty.opacity.is_none());
    }
}
