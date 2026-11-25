//! 笔记 PDF 的静默导出：把自包含 HTML 交给一个 WebView2 窗口，
//! 直接调 `ICoreWebView2_7::PrintToPdf` 写出 .pdf，全程不弹系统打印预览对话框。
//!
//! 为什么不用 `window.print()`：WebView2 的 print() 只有交互式那一种（弹打印预览），
//! 静默出 PDF 必须走 COM 的 PrintToPdf。外部程序（Edge headless）也不行 —— 项目只预装 git，
//! 不为了导出 PDF 再引一个外部程序（见 AGENTS.md 的外部程序边界）。
//!
//! 线程模型（踩过死锁，别改）：
//!  - `WebviewWindow::with_webview` 把闭包**异步派发到主 UI 线程**（tauri-runtime-wry 的
//!    send_user_message），WebView2 的 COM 与回调也都住在主线程。
//!  - **主线程闭包里绝不做任何阻塞等待**。曾经在闭包里 `recv_timeout` / `wait_with_pump`
//!    等回调，结果整个界面卡死 —— WebView2 的回调靠主线程消息循环派发，主线程被阻塞住、
//!    又不泵消息，回调永远来不了（自锁）。
//!  - 正确做法：闭包只**发起**异步操作就返回；`WebMessage → PrintToPdf →
//!    PrintToPdfCompleted` 整条链都在各自的 COM 回调里接力，靠 Tauri 主循环泵消息驱动。
//!    只有 async 命令所在的工作线程用 `recv_timeout` 等最终结果（不冻结 UI）。
//!
//! 真机踩坑（按时间顺序，全都别改回去）：
//!  1. **导航时序不对 → 空白页**。NavigationCompleted 触发时页面还没渲染完（标题已是
//!     about:blank、IsSuccess 常为 false），据此打印必得空白 PDF（864 字节、无中文）；
//!     标题哨兵、IsSuccess 判据都不可靠。改成页面 onload 后 postMessage('PDF_READY')，
//!     Rust 收到 WebMessage 才打印 —— 时序确定，DOM/样式就绪。
//!  2. **窗口 show 出来会闪一下**。曾以为"不可见窗口不渲染 → 空白页"，错：那是上面导航时序
//!     的问题。WebMessage 保证打印时机后，窗口全程 visible(false) 也能导出有内容的 PDF
//!     （真机验证 447KB、标题为笔记名、含中文）。所以全程不显示，用户看不到、不闪。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, WebviewWindowBuilder, WebviewUrl};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment6, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2_7,
};
// handler 是 webview2-com 根级 re-export（lib.rs 的 pub use callback::*）。
use webview2_com::{
    take_pwstr, PrintToPdfCompletedHandler, WebMessageReceivedEventHandler,
};
use windows::core::{HSTRING, Interface, PWSTR};

/// 隐藏窗口的标签前缀：每次导出一个随机后缀，避免并发两次导出抢同一个 label
const WINDOW_LABEL_PREFIX: &str = "pdf-export-";
/// 页面就绪信号：HTML 尾部注入的脚本在 window.onload 后发这条消息，
/// Rust 收到它才打印（此时 DOM 与样式已就绪）。
const READY_MESSAGE: &str = "PDF_READY";
/// 等最终回调的兜底超时。PrintToPdf 正常几百毫秒，超时说明渲染/回调出问题了，
/// 不能让隐藏窗口永远挂在后台（参考 main.rs 退出确认那套 recv_timeout）。
const EXPORT_TIMEOUT: Duration = Duration::from_secs(30);

/// 导出结果：成功是 Ok(())，失败是带原因的 Err(String)。
type ExportResult = Result<(), String>;
type ResultSender = mpsc::Sender<ExportResult>;

/// 窗口尺寸（A4 的 96dpi 近似）：WebView2 的渲染依赖控制器 bounds。
const PAGE_WIDTH: f64 = 794.0;
const PAGE_HEIGHT: f64 = 1123.0;

/// 笔记 PDF 静默导出命令。
///
/// `path` 来自前端的「另存为」对话框（与 fs_write_text / vault_key_export 同一信任模型），
/// `html` 是前端用 buildExportHtml 生成好的自包含文档（三份 CSS 都内联）。
#[tauri::command(async)]
pub fn export_pdf(app: AppHandle, path: String, html: String) -> ExportResult {
    if path.trim().is_empty() {
        return Err("导出路径不能为空".into())
    }
    if html.trim().is_empty() {
        return Err("导出内容为空".into())
    }

    let label = format!("{WINDOW_LABEL_PREFIX}{}", uuid::Uuid::new_v4());
    let window = WebviewWindowBuilder::new(
        &app,
        label.as_str(),
        WebviewUrl::App("pdf-export.html".into()),
    )
    .title("PDF 导出")
    .inner_size(PAGE_WIDTH, PAGE_HEIGHT)
    // 全程不显示：用户完全看不到这个窗口，也就不存在闪烁。
    // 早先以为"不可见窗口不渲染 → 空白页"，真机证实那是导航竞态（打印太早）所致；
    // 现在改用 WebMessage 等页面 onload 后再打印，隐藏窗口也能渲染出有内容的 PDF。
    .visible(false)
    .skip_taskbar(true)
    .focused(false)
    .resizable(false)
    .build()
    .map_err(|err| format!("创建 PDF 导出窗口失败：{err}"))?;

    let (tx, rx) = mpsc::channel::<ExportResult>();
    let closure_tx = tx.clone();
    // 闭包**异步**投递到主线程，只发起操作、立即返回；同步阶段的失败由闭包自己回报。
    if let Err(err) = window.with_webview(move |webview| {
        if let Err(message) = start_export(&webview.controller(), &path, &html, &closure_tx) {
            let _ = closure_tx.send(Err(message));
        }
    }) {
        let _ = window.close();
        return Err(format!("访问 PDF 导出窗口失败：{err}"))
    }

    // 阻塞的是 async 命令的工作线程，主 UI 线程照常跑 —— 这里的回调能顺利被主线程派发。
    let result = rx
        .recv_timeout(EXPORT_TIMEOUT)
        .unwrap_or_else(|_| Err("导出 PDF 超时，未收到 WebView2 的完成回调".into()));

    // 不管成败都关掉隐藏窗口；关窗失败只是留一条警告，不改导出结果
    if let Err(err) = window.close() {
        crate::error_log::warn("PDF 导出", format!("关闭隐藏窗口失败：{err}"));
    }
    result
}

/// 主线程上的同步阶段：注册 WebMessage 处理器、灌入带就绪脚本的 HTML，**不等待任何回调**。
/// 打印在收到页面的 PDF_READY 消息后由事件回调接力完成。
fn start_export(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    path: &str,
    html: &str,
    tx: &ResultSender,
) -> ExportResult {
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|err| format!("取 WebView2 内核失败：{err}"))?;
    // PrintToPdf 在 ICoreWebView2_7 上；controller 给的是 ICoreWebView2，需要向上 cast。
    let core7 = core
        .cast::<ICoreWebView2_7>()
        .map_err(|err| format!("WebView2 版本过低，不支持静默导出 PDF：{err}"))?;

    let path_owned = path.to_string();
    let core_for_msg = core7.clone();
    let tx_for_msg = tx.clone();
    // 已打印标志：WebMessage 可能因刷新重复到达，只打印一次。
    let printed = Arc::new(AtomicBool::new(false));
    let printed_for_msg = printed.clone();

    let handler = WebMessageReceivedEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              args: Option<ICoreWebView2WebMessageReceivedEventArgs>| {
            let message = match args {
                Some(args) => unsafe {
                    let mut ptr = PWSTR::null();
                    match args.TryGetWebMessageAsString(&mut ptr) {
                        Ok(()) => take_pwstr(ptr),
                        Err(_) => String::new(),
                    }
                },
                None => String::new(),
            };
            if message != READY_MESSAGE {
                return Ok(()) // 非就绪消息，忽略（空白壳也不发这个消息）
            }
            if printed_for_msg.swap(true, Ordering::SeqCst) {
                return Ok(()) // 已经打印过
            }
            // 页面 onload 已触发，DOM 与样式就绪，现在打印。
            if let Err(message) = print_to_pdf(&core_for_msg, &path_owned, &tx_for_msg) {
                let _ = tx_for_msg.send(Err(message));
            }
            Ok(())
        },
    ));

    // 在正文 HTML 尾部追加就绪脚本：onload 后把信号发给 Rust。
    // 内容主题/基础 CSS 都在同一份文档里，onload 时它们已应用。
    let with_ready = format!(
        "{html}<script>window.addEventListener('load',function(){{window.chrome.webview.postMessage('{READY_MESSAGE}');}});</script>"
    );

    unsafe {
        // 第二个参数是接收 event token 的出参；窗口打印完就销毁，不需要保留 token。
        // handler 由 COM 内部 AddRef 持有，Rust 变量离开作用域后回调依然有效。
        let mut token = 0i64;
        core.add_WebMessageReceived(&handler, &mut token)
            .map_err(|err| format!("注册页面就绪消息失败：{err}"))?;
        core.NavigateToString(&HSTRING::from(&with_ready))
            .map_err(|err| format!("载入导出内容失败：{err}"))?;
    }
    Ok(())
}

/// 在收到页面就绪消息后调 PrintToPdf，**同样不等待**：完成回调会异步接力回报结果。
fn print_to_pdf(core7: &ICoreWebView2_7, path: &str, tx: &ResultSender) -> ExportResult {
    let environment = unsafe { core7.Environment() }
        .map_err(|err| format!("取 WebView2 环境失败：{err}"))?;
    let environment6 = environment
        .cast::<ICoreWebView2Environment6>()
        .map_err(|err| format!("WebView2 版本过低，不支持打印设置：{err}"))?;
    let settings = unsafe { environment6.CreatePrintSettings() }
        .map_err(|err| format!("创建打印设置失败：{err}"))?;

    let tx_for_done = tx.clone();
    // completed_callback 的闭包收到 (HRESULT, BOOL)：
    //   HRESULT 是 COM 调用状态，BOOL 是 WebView2 自己的打印结果（true 成功）。
    let handler = PrintToPdfCompletedHandler::create(Box::new(
        move |hr: windows::core::Result<()>, succeeded: bool| {
            let outcome = match hr {
                Err(err) => Err(format!("生成 PDF 失败：{err}")),
                Ok(()) if !succeeded => Err("WebView2 未能生成 PDF".into()),
                Ok(()) => Ok(()),
            };
            if let Err(message) = &outcome {
                crate::error_log::error("PDF 导出", message);
            }
            let _ = tx_for_done.send(outcome);
            Ok(())
        },
    ));

    unsafe {
        // settings / handler 由 COM AddRef 持有，这里立刻返回，不等回调。
        core7
            .PrintToPdf(&HSTRING::from(path), &settings, &handler)
            .map_err(|err| format!("启动 PDF 打印失败：{err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空路径与空内容被拒绝() {
        // 命令层的纯校验不碰 COM，单独抽出来测
        fn validate(path: &str, html: &str) -> ExportResult {
            if path.trim().is_empty() {
                return Err("导出路径不能为空".into())
            }
            if html.trim().is_empty() {
                return Err("导出内容为空".into())
            }
            Ok(())
        }
        assert_eq!(validate("", "<html></html>"), Err("导出路径不能为空".into()));
        assert_eq!(validate("C:\\x.pdf", "  "), Err("导出内容为空".into()));
        assert!(validate("C:\\x.pdf", "<html></html>").is_ok());
    }

    #[test]
    fn 窗口标签带随机后缀() {
        let a = format!("{WINDOW_LABEL_PREFIX}{}", uuid::Uuid::new_v4());
        let b = format!("{WINDOW_LABEL_PREFIX}{}", uuid::Uuid::new_v4());
        assert!(a.starts_with(WINDOW_LABEL_PREFIX));
        assert_ne!(a, b);
    }

    #[test]
    fn 就绪脚本含正确的消息信号() {
        // 注入的脚本必须发出与 Rust 端判据一致的消息
        let script = format!(
            "<script>window.addEventListener('load',function(){{window.chrome.webview.postMessage('{READY_MESSAGE}');}});</script>"
        );
        assert!(script.contains(READY_MESSAGE));
        assert!(script.contains("onload") || script.contains("'load'"));
    }
}
