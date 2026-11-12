//! 独立 Markdown 编辑窗口：从资源管理器「打开方式」用 Workbench 打开一个 `.md`。
//!
//! 与笔记页共用 `notes.rs` 的读写（mtime 冲突保护、临时文件 + 改名落盘），但这扇窗口
//! **不是笔记页**：没有笔记本、没有目录树、没有 store，正文也不走笔记页那套选中项。
//!
//! 几条边界：
//!   - 窗口 label 以 `markdown-` 开头，一个文件一扇窗；同一路径再次打开只聚焦已有窗口。
//!   - **文件路径只从 Rust 会话取**：渲染层能调的只有 `markdown_window_context` /
//!     `markdown_window_save`，两条都不接受路径参数，因此这扇窗没法读写别的文件。
//!   - 关闭走一次握手：窗口先拦住关闭、让渲染层把防抖里那一份交出去，保存完成才销毁。
//!     收不到回执时兜底销毁，别让一扇窗永远关不掉。
//!   - 启动时带 md 参数、或应用已在运行时第二次被文件参数唤起，主窗口**不弹出来**
//!     （见 main.rs 的 setup 与单实例回调）。

use crate::notes;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 窗口 label 前缀；capability 里的 `windows` 用 `markdown-*` 匹配
pub const LABEL_PREFIX: &str = "markdown-";

/// 关闭前给渲染层冲刷正文的时间上限。本地文件写盘远用不了这么久，留足冗余。
const CLOSE_FLUSH_TIMEOUT: Duration = Duration::from_secs(10);

/// 一扇编辑窗口打开着的那个文件。
///
/// `dir` / `name` 是交给 `notes::read / write` 的两个值（它们只认「根 + 相对路径」）；
/// `path` 是规范化的绝对路径，只用来做「同一文件不重复开窗」与日志。
struct Session {
    dir: String,
    name: String,
    path: PathBuf,
}

/// 所有编辑窗口的会话 + 正在关闭的那几扇（防止重复发冲刷事件、兜底线程误杀已取消的关闭）。
#[derive(Default)]
pub struct MdWindows {
    sessions: Mutex<HashMap<String, Session>>,
    closing: Mutex<HashSet<String>>,
}

impl MdWindows {
    /// 按 label 取「这个窗口打开的是哪个文件」；不是编辑窗口 / 会话已清掉时返回原因。
    fn lookup(&self, label: &str) -> Result<(String, String), String> {
        if !label.starts_with(LABEL_PREFIX) {
            return Err("这个窗口不是 Markdown 编辑窗口".into());
        }
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "编辑窗口状态锁中毒".to_string())?;
        let session = sessions
            .get(label)
            .ok_or_else(|| "这个编辑窗口已经关闭了".to_string())?;
        Ok((session.dir.clone(), session.name.clone()))
    }

    fn has_path(&self, path: &Path) -> Option<String> {
        let sessions = self.sessions.lock().ok()?;
        sessions
            .iter()
            .find(|(_, session)| same_path(&session.path, path))
            .map(|(label, _)| label.clone())
    }
}

/// 后缀判断只认 `.md` / `.markdown`（与 notes.rs 的扫描口径一致，大小写不敏感）。
fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

/// Windows 路径按大小写不敏感比较；同一个文件用不同大小写 / 短名打开时不该开第二扇窗。
fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

/// 从命令行参数里挑出「真的存在的 markdown 文件」。
///
/// - 第一个参数是 exe 自己，跳过；
/// - 相对路径按 `cwd` 解析（资源管理器给的是绝对路径，手工启动时才可能是相对路径）；
/// - 只认确实存在的文件：`--flag`、别的后缀、拼错的路径一律忽略，让应用照常显示主界面；
/// - 规范化后去重（同一文件在一次多选打开里只开一扇窗）。
pub(crate) fn markdown_paths(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    for arg in args.iter().skip(1) {
        let raw = arg.trim();
        if raw.is_empty() {
            continue;
        }
        let path = PathBuf::from(raw);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if !is_markdown_path(&path) || !path.is_file() {
            continue;
        }
        let Ok(canonical) = dunce::canonicalize(&path) else {
            continue;
        };
        if out.iter().any(|known| same_path(known, &canonical)) {
            continue;
        }
        out.push(canonical);
    }

    out
}

/// 逐扇打开，返回成功打开 / 聚焦的窗口数。单个文件失败不影响其余文件
/// （多选打开时常见）；一个都没打开时由调用方决定退回主界面。
pub(crate) fn open_paths(app: &AppHandle, paths: &[PathBuf]) -> usize {
    let mut opened = 0;
    for path in paths {
        match open_path(app, path) {
            Ok(()) => opened += 1,
            Err(message) => eprintln!("[workbench] 打开 Markdown 窗口失败：{message}"),
        }
    }
    opened
}

fn open_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    let canonical = dunce::canonicalize(path)
        .map_err(|err| format!("找不到这个文件：{}（{err}）", path.display()))?;
    if !canonical.is_file() {
        return Err(format!("不是文件：{}", canonical.display()));
    }
    if !is_markdown_path(&canonical) {
        return Err(format!("不是 Markdown 文件：{}", canonical.display()));
    }

    let name = canonical
        .file_name()
        .ok_or_else(|| "这个路径没有文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let dir = canonical
        .parent()
        .ok_or_else(|| "这个文件没有所在文件夹".to_string())?
        .to_string_lossy()
        .to_string();

    let state = app.state::<MdWindows>();
    // 同一文件已经开着一扇：只把它唤到前面，别再开第二扇
    if let Some(label) = state.has_path(&canonical) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }
        // 会话还在、窗口已经不在了（销毁事件没跑到）：清掉这条，继续开新的
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&label);
        }
    }

    let label = format!("{LABEL_PREFIX}{}", uuid::Uuid::new_v4());
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "编辑窗口状态锁中毒".to_string())?;
        sessions.insert(
            label.clone(),
            Session {
                dir,
                name: name.clone(),
                path: canonical,
            },
        );
    }

    let built = WebviewWindowBuilder::new(app, label.as_str(), WebviewUrl::App("markdown.html".into()))
        .title(name)
        .inner_size(960.0, 760.0)
        .min_inner_size(520.0, 400.0)
        // 无边框：系统标题栏不画，最小化 / 最大化 / 关闭由渲染层自绘（MarkdownWindowApp.vue），
        // 标题栏与底栏兼做拖动带。关闭仍走下面的握手（CloseRequested 照拦）。
        .decorations(false)
        .visible(false)
        .initialization_script(crate::bootstrap_script())
        .initialization_script(crate::no_context_menu_script())
        .on_page_load(|window, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        // 与主窗口同一条导航边界：应用自身放行，外链交系统浏览器，其余一律取消
        .on_navigation(crate::handle_navigation)
        // 正文里若真有 target="_blank" 的链接，也不在应用里开第二扇不受管的窗口
        .on_new_window(|url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = crate::system::open_external(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .build();

    match built {
        Ok(window) => {
            attach_window_events(&window);
            Ok(())
        }
        Err(err) => {
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&label);
            }
            Err(format!("创建编辑窗口失败（{err}）"))
        }
    }
}

/// 关闭握手与收尾。
fn attach_window_events(window: &WebviewWindow) {
    let handle = window.clone();
    // 最大化状态的上一次观测值（这扇窗自己的）：Resized 推「变化」，不是每次 resize 都发。
    // 与主窗口的 MaximizedFlag 分开 —— 那一份是全局的，两边会互相顶掉。
    let maximized = Mutex::new(false);
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // 先拦下来，让渲染层把防抖里那一份写出去；回执到了再由 markdown_window_close 销毁
            api.prevent_close();
            let label = handle.label().to_string();
            let Some(state) = handle.try_state::<MdWindows>() else {
                let _ = handle.destroy();
                return;
            };
            let first = {
                let Ok(mut closing) = state.closing.lock() else {
                    return;
                };
                closing.insert(label.clone())
            };
            // 已经在关了（用户连点两下 / 兜底线程还没到）：别再发一遍
            if !first {
                return;
            }
            let _ = handle.emit("markdown-window:flush", ());

            // 页面崩了 / 渲染层没回执时也别让窗口永远关不掉
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(CLOSE_FLUSH_TIMEOUT);
                let Some(state) = fallback.try_state::<MdWindows>() else {
                    return;
                };
                let still_waiting = {
                    let Ok(mut closing) = state.closing.lock() else {
                        return;
                    };
                    closing.remove(&label)
                };
                if still_waiting {
                    let _ = fallback.destroy();
                }
            });
        }
        // 最大化状态从窗口事件推，不由按钮自己记：拖边缘、双击拖动带、系统快捷键
        // 都能最大化，第三个按钮只管画（与主窗口 main.rs 的那条同款）。
        tauri::WindowEvent::Resized(_) => {
            let now_maximized = handle.is_maximized().unwrap_or(false);
            let Ok(mut last) = maximized.lock() else {
                return;
            };
            if *last != now_maximized {
                *last = now_maximized;
                let _ = handle.emit(
                    "markdown-window:state-changed",
                    serde_json::json!({ "maximized": now_maximized }),
                );
            }
        }
        tauri::WindowEvent::Destroyed => {
            if let Some(state) = handle.try_state::<MdWindows>() {
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.remove(handle.label());
                }
                if let Ok(mut closing) = state.closing.lock() {
                    closing.remove(handle.label());
                }
            }
        }
        _ => {}
    });
}

/// 窗口拿到自己打开的是哪个文件、正文与 mtime（读盘只在这里做一次）。
#[tauri::command(async)]
pub fn markdown_window_context(
    window: WebviewWindow,
    state: State<'_, MdWindows>,
) -> Result<Value, String> {
    let (dir, name) = state.lookup(window.label())?;
    let mut document = notes::read(&dir, &name)?;
    if let Some(object) = document.as_object_mut() {
        object.insert("name".into(), json!(name));
    }
    Ok(document)
}

/// 保存正文。路径来自会话，渲染层给不了第二个文件；冲突规则与笔记页完全一致。
#[tauri::command(async)]
pub fn markdown_window_save(
    window: WebviewWindow,
    state: State<'_, MdWindows>,
    content: String,
    expected_mtime_ms: Option<u64>,
) -> Result<u64, String> {
    let (dir, name) = state.lookup(window.label())?;
    notes::write(&dir, &name, &content, expected_mtime_ms)
}

/// 渲染层已经交完正文：真正销毁窗口（Destroyed 里清会话）。
#[tauri::command(async)]
pub fn markdown_window_close(
    window: WebviewWindow,
    state: State<'_, MdWindows>,
) -> Result<(), String> {
    if let Ok(mut closing) = state.closing.lock() {
        closing.remove(window.label());
    }
    window
        .destroy()
        .map_err(|err| format!("关闭编辑窗口失败：{err}"))
}

/// 渲染层已经收到关闭请求：撤掉这次关闭的兜底计时。
///
/// 渲染层拿到回执后还要冲刷 / 等保存 / 可能弹确认框，这一段不能有 10 秒上限；
/// 真正销毁由它随后调 `markdown_window_close`。窗口不动（用户选「留在窗口」也是这条）。
#[tauri::command]
pub fn markdown_window_cancel_close(
    window: WebviewWindow,
    state: State<'_, MdWindows>,
) -> Result<(), String> {
    if let Ok(mut closing) = state.closing.lock() {
        closing.remove(window.label());
    }
    Ok(())
}

/// 这扇窗当前是不是最大化（第三个按钮画「最大化」还是「还原」用）。
#[tauri::command]
pub fn markdown_window_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-md-window-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn selects_only_existing_markdown_files() {
        let root = temp_root("pick");
        std::fs::write(root.join("note.md"), "# hi").unwrap();
        std::fs::write(root.join("OTHER.MD"), "# hi").unwrap();
        std::fs::write(root.join("long.markdown"), "# hi").unwrap();
        std::fs::write(root.join("image.png"), "x").unwrap();
        std::fs::write(root.join("note.md.txt"), "x").unwrap();

        let args = vec![
            "workbench.exe".to_string(),
            root.join("note.md").to_string_lossy().to_string(),
            root.join("OTHER.MD").to_string_lossy().to_string(),
            root.join("long.markdown").to_string_lossy().to_string(),
            root.join("image.png").to_string_lossy().to_string(),
            root.join("note.md.txt").to_string_lossy().to_string(),
            root.join("missing.md").to_string_lossy().to_string(),
            "--flag".to_string(),
        ];

        let picked = markdown_paths(&args, &root);
        assert_eq!(picked.len(), 3);
        assert!(picked.iter().any(|path| path.ends_with("note.md")));
        assert!(picked.iter().any(|path| path.ends_with("OTHER.MD")));
        assert!(picked.iter().any(|path| path.ends_with("long.markdown")));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolves_relative_paths_against_the_working_directory() {
        let root = temp_root("relative");
        std::fs::write(root.join("relative.md"), "# hi").unwrap();

        let picked = markdown_paths(&["workbench.exe".to_string(), "relative.md".to_string()], &root);
        assert_eq!(picked.len(), 1);
        assert!(picked[0].is_absolute());
        assert!(picked[0].ends_with("relative.md"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn duplicate_paths_open_one_window_only() {
        let root = temp_root("dedupe");
        std::fs::write(root.join("same.md"), "# hi").unwrap();
        let path = root.join("same.md").to_string_lossy().to_string();

        let picked = markdown_paths(
            &[
                "workbench.exe".to_string(),
                path.clone(),
                path.clone(),
                path.to_uppercase(),
            ],
            &root,
        );
        // 大小写不同的那个在同一台 Windows 上仍是同一个文件；不存在的那个不算
        assert_eq!(picked.len(), 1);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn extension_check_is_case_insensitive() {
        assert!(is_markdown_path(Path::new("a.md")));
        assert!(is_markdown_path(Path::new("a.MD")));
        assert!(is_markdown_path(Path::new("a.MarkDown")));
        assert!(!is_markdown_path(Path::new("a.md.txt")));
        assert!(!is_markdown_path(Path::new("a")));
    }
}
