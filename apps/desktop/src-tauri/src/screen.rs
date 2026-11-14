//! Win32 抓屏、光标位置与输入注入（滚轮 / 前台窗口）。
//!
//! **为什么自己写 BitBlt 而不引截图库**（`xcap` / `screenshots` 那一类）：那类库会带进
//! 一串新编译单元（有的还要拉 D3D / 图像编解码的额外依赖），而这里要的只是「把屏幕一块
//! 矩形抠成像素」——`BitBlt` + `GetDIBits` 都在**已经开着**的 `Win32_Graphics_Gdi` 里，
//! `GetSystemMetrics` / `GetCursorPos` 在 `Win32_UI_WindowsAndMessaging` 里，
//! 一个 feature 都不用加（见 Cargo.toml 与 AGENTS.md 第 1 节的依赖口径）。
//! 滚动截图要的 `SendInput` / `SetForegroundWindow` 同理，分别在
//! `Win32_UI_Input_KeyboardAndMouse`（悬浮球的 `GetAsyncKeyState` 已开）与
//! `Win32_UI_WindowsAndMessaging` 里，也是零 feature 变更。
//!
//! **已知边界**（写清楚，免得当成 bug 查）：
//!  - 独占全屏的 D3D 游戏抓出来是**黑的**（DWM 不合成它，屏幕 DC 上就是没有）；
//!  - HDR 屏按 SDR 色调映射抓，颜色会比肉眼看到的淡；
//!  - UAC 安全桌面、DRM 保护内容抓不到（Windows 就不给，Snipaste 也一样，除非进程提权）；
//!  - 发滚轮到**管理员权限 / UWP** 窗口会被 UIPI 挡住（跟抓不到安全桌面同一族边界）。
//!
//! 要越过前三条得改走 Windows.Graphics.Capture（D3D11 帧池那套），是另一摊活。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC,
    HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, SetCursorPos, SetForegroundWindow,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// 抓屏幕上一块矩形（**虚拟桌面物理坐标**）。
///
/// 坐标与尺寸都由调用方给 —— 一般来自 Tauri 的 `available_monitors()`，那是同一个
/// 坐标系（进程是 Per-Monitor-V2 DPI 感知的，报出来的就是真实像素）。
pub fn capture_region(x: i32, y: i32, width: u32, height: u32) -> Result<image::RgbaImage, String> {
    if width == 0 || height == 0 {
        return Err("这块屏报出来的尺寸是 0".into());
    }

    unsafe {
        // 空句柄 = 整个屏幕的 DC；下面用虚拟桌面坐标从它上面抠出这一块
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("取屏幕设备上下文失败".into());
        }
        let outcome = capture_from(screen, x, y, width, height);
        ReleaseDC(std::ptr::null_mut(), screen);
        outcome
    }
}

/// `screen` 之外的资源都在这里成对地建与还，任何一步失败都不会漏掉句柄
unsafe fn capture_from(
    screen: HDC,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<image::RgbaImage, String> {
    let memory = CreateCompatibleDC(screen);
    if memory.is_null() {
        return Err("建内存设备上下文失败".into());
    }

    let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
    if bitmap.is_null() {
        DeleteDC(memory);
        return Err("建位图失败".into());
    }
    let previous = SelectObject(memory, bitmap as HGDIOBJ);

    // CAPTUREBLT：连分层窗口一起抓（带阴影的菜单、半透明窗口都在里面）；
    // 不加它时那些窗口所在的位置抓回来是空的
    let copied = BitBlt(
        memory,
        0,
        0,
        width as i32,
        height as i32,
        screen,
        x,
        y,
        SRCCOPY | CAPTUREBLT,
    ) != 0;

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // 负高度 = 自上而下。DIB 默认是自底向上，用负高度省掉之后翻行的那一步
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: width * height * 4,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
    let lines = if copied {
        GetDIBits(
            memory,
            bitmap,
            0,
            height,
            buffer.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        )
    } else {
        0
    };

    // 位图先摘下来再删：还选在 DC 里的位图删不掉
    SelectObject(memory, previous);
    DeleteObject(bitmap as HGDIOBJ);
    DeleteDC(memory);

    if !copied {
        return Err("抓屏失败：BitBlt 没成功".into());
    }
    if lines == 0 {
        return Err("抓屏失败：读不出屏幕像素".into());
    }

    // 屏幕上的 32 位像素是 **BGRA**，而且 alpha 位是 0（BI_RGB 根本不写 alpha）：
    // 原样当成 RGBA 用会得到一张全透明的图，所以换一次通道再补上不透明。
    //
    // **按 DWORD 换，不按字节 swap**：这一趟是几兆像素的循环，逐字节写（`pixel.swap(0, 2)`）
    // 在 debug 下要一百多毫秒（每个下标一次边界检查），按字读写快一倍多。屏幕像素的这 4 个
    // 字节是连在一块的，`read_unaligned` / `write_unaligned` 对任意对齐都成立 ——
    // 不必假设这个 Vec 的地址是 4 对齐的（`Vec<u8>` 只保证 1）。
    for chunk in buffer.chunks_exact_mut(4) {
        let value = unsafe { std::ptr::read_unaligned(chunk.as_ptr() as *const u32) };
        // 小端下这 4 个字节读成 `0xAARRGGBB`；换成 `0xFFBBGGRR` 落回内存就是 R,G,B,A
        let swapped = ((value & 0x00ff_0000) >> 16)
            | (value & 0x0000_ff00)
            | ((value & 0x0000_00ff) << 16)
            | 0xff00_0000;
        unsafe { std::ptr::write_unaligned(chunk.as_mut_ptr() as *mut u32, swapped) };
    }

    image::RgbaImage::from_raw(width, height, buffer).ok_or_else(|| "屏幕像素尺寸对不上".into())
}

/// 光标位置（虚拟桌面物理坐标）。取不到时回 `None`（锁屏 / 安全桌面上会这样）。
pub fn cursor_point() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return None;
    }
    Some((point.x, point.y))
}

/// 光标位置，取不到时回 (0, 0)：抓屏那一摊只拿它算选框，兜个底就够了。
pub fn cursor_position() -> (i32, i32) {
    cursor_point().unwrap_or((0, 0))
}

/// 整块虚拟桌面的位置与尺寸（所有显示器都包进去的那个矩形）。
/// 只在 Tauri 报不出显示器列表时兜底用（远程桌面、刚切完显示模式那一下）。
pub fn virtual_desktop() -> Option<(i32, i32, u32, u32)> {
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return None;
    }
    Some((
        unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) },
        unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) },
        width as u32,
        height as u32,
    ))
}

// ---------- 滚动截图的输入侧：前台窗口、光标、滚轮 ----------
//
// 三件事合起来才把滚轮喂进目标窗口：**焦点路径**（滚轮默认去前台窗口）与**光标路径**
// （「悬停滚动非活动窗口」开着的机器按光标落点派发）双保险，遮罩那侧再把自己设成
// 鼠标穿透（见 capture.rs 的 `capture_scroll_begin`）。用 `SendInput` 而不是
// `PostMessage(WM_MOUSEWHEEL)`：注入的是系统输入栈里的「真输入」，Chromium / Qt /
// Win32 各路窗口都认，PostMessage 对 UWP 与不少现代窗口是静默无效的。

/// 一格滚轮的量（Windows 的 `WHEEL_DELTA`；自己定一份，省一个跨模块 import 的悬念）
const WHEEL_DELTA: i32 = 120;

/// 现在的前台窗口。**开场时记下**（见 capture.rs 的 `ScrollRun`）—— 等真要滚的时候
/// 前台已经是遮罩自己了，再问就问错了。
pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow() as isize }
}

/// 把某个窗口扶回前台。返回值不管：被系统的前台锁拒绝时还有光标那道保险
/// （`capture_scroll_begin` 会把光标钉进选区中心）。
pub fn set_foreground(hwnd: isize) {
    unsafe { SetForegroundWindow(hwnd as _) };
}

/// 把光标摆到虚拟桌面物理坐标（滚动截图把它钉进选区中心，滚轮跟着光标走）。
pub fn set_cursor_pos(x: i32, y: i32) {
    unsafe { SetCursorPos(x, y) };
}

/// 向下滚 `notches` 齿（每齿一格 `WHEEL_DELTA`）。
pub fn send_wheel(notches: u32) {
    // 向下滚 = 负的 delta；`mouseData` 按 u32 存，负值经补码转过去
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: -(WHEEL_DELTA * notches as i32) as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(1, &input, std::mem::size_of::<INPUT>() as i32);
    }
}
