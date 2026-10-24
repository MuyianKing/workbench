//! Win32 抓屏与光标位置。
//!
//! **为什么自己写 BitBlt 而不引截图库**（`xcap` / `screenshots` 那一类）：那类库会带进
//! 一串新编译单元（有的还要拉 D3D / 图像编解码的额外依赖），而这里要的只是「把屏幕一块
//! 矩形抠成像素」——`BitBlt` + `GetDIBits` 都在**已经开着**的 `Win32_Graphics_Gdi` 里，
//! `GetSystemMetrics` / `GetCursorPos` 在 `Win32_UI_WindowsAndMessaging` 里，
//! 一个 feature 都不用加（见 Cargo.toml 与 AGENTS.md 第 1 节的依赖口径）。
//!
//! **已知边界**（写清楚，免得当成 bug 查）：
//!  - 独占全屏的 D3D 游戏抓出来是**黑的**（DWM 不合成它，屏幕 DC 上就是没有）；
//!  - HDR 屏按 SDR 色调映射抓，颜色会比肉眼看到的淡；
//!  - UAC 安全桌面、DRM 保护内容抓不到（Windows 就不给，Snipaste 也一样，除非进程提权）。
//!
//! 要越过这三条得改走 Windows.Graphics.Capture（D3D11 帧池那套），是另一摊活。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC,
    HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
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
