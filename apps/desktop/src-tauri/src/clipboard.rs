//! 把一张 PNG 写进 Windows 剪贴板。
//!
//! **为什么不走 WebView 的 `navigator.clipboard`**：WebView2 的异步剪贴板要
//! `CoreWebView2` 的权限回调放行（wry 没暴露出来），失败还是静默的；而且它只写 PNG
//! 一种格式，认 CF_DIB 的老程序（画图、部分 Office 版本）粘出来是空的。
//! Win32 这条路一次能给齐三种格式，也与我们「宿主能力走 Rust」的口径一致。
//!
//! 写的三种格式：
//!  - **CF_DIBV5**（带 alpha 的 32 位 DIB）：Windows 自己的截图工具、照片、Office 认它；
//!  - **CF_DIB**（`BITMAPINFOHEADER` + 32 位 BI_RGB，不认 alpha）：最保守的那一档，老程序靠它；
//!  - 注册格式 **`PNG`**：浏览器、Electron 系（VS Code、Discord 之类）优先取这个，无损。
//!
//! DIB 头是**按字节手写**的，不用 windows-sys 的 `BITMAPV5HEADER` 结构体：那份结构体
//! 的字段名与版本绑定得紧，而这里要的只是「124 个字节、小端、字段顺序固定」，
//! 手写反而更稳、也能直接单测。像素一律**自底向上**（DIB 的经典朝向，兼容性最好）。

use std::time::Duration;

// GlobalFree 在 Foundation 里（windows-sys 把它与其余 Global* 分开放了），
// 其余三个在 System::Memory —— 都是同一份 kernel32，不新增编译单元。
use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

/// CF_DIB / CF_DIBV5：windows-sys 0.61 没有这两个常量（它们是 Win32_System_Ole 那边的枚举），
/// 值来自 winuser.h，稳定不变。上一个是 8（CF_DIB），带 alpha 的那个是 17（CF_DIBV5）。
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

/// `BITMAPV5HEADER` 的长度
const DIBV5_HEADER: u32 = 124;
/// `BITMAPINFOHEADER` 的长度
const DIB_HEADER: u32 = 40;
/// 72 DPI（像素/米），写个常见的值，很多程序读它只是为了显示尺寸
const PELS_PER_METER: i32 = 2835;

/// 把 PNG 字节写进剪贴板
pub fn write_png(png: &[u8]) -> Result<(), String> {
    let image = image::load_from_memory(png)
        .map_err(|err| format!("剪贴板：这张图解不开（{err}）"))?
        .to_rgba8();
    write_rgba(&image, png)
}

/// 把已经解好的像素写进剪贴板。`png` 是这块图对应的 PNG 字节 —— 剪贴板里的 `PNG` 格式
/// 直接用它，不重编一遍（DIB 那两个格式才需要像素）。
pub fn write_rgba(image: &image::RgbaImage, png: &[u8]) -> Result<(), String> {
    // **像素只转一遍**：两份 DIB 的像素段完全一样，共用这一份自底向上的 BGRA 缓冲
    let (dib_v5, dib) = build_dibs(image);

    with_clipboard(|| {
        // 顺序有意义：先放最精确的，后面的格式不会覆盖前面的（格式号不同）
        set_data(CF_DIBV5, &dib_v5)?;
        set_data(CF_DIB, &dib)?;
        let png_format = register_format("PNG");
        if png_format != 0 {
            set_data(png_format, png)?;
        }
        Ok(())
    })
}

/// 打开 → 清空 → 做事 → 关闭。打开会被别的进程挡住，所以要重试。
fn with_clipboard<F: FnOnce() -> Result<(), String>>(task: F) -> Result<(), String> {
    let mut opened = false;
    for _ in 0..8 {
        // 空窗口句柄：剪贴板是「一个会话」而不是某个窗口的，谁先打开归谁
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !opened {
        return Err("剪贴板正被别的程序占用，稍后再试一次".into());
    }

    // 必须先清空：不清的话上一次留下的那些格式还在，粘出来会是旧址
    unsafe { EmptyClipboard() };
    let outcome = task();
    // 失败也要关：不关的话剪贴板一直被我们占着，用户复制别的程序会失败
    unsafe { CloseClipboard() };
    outcome
}

/// 把一段字节作为某种剪贴板格式放上去
fn set_data(format: u32, bytes: &[u8]) -> Result<(), String> {
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if handle.is_null() {
            return Err("剪贴板：内存分配失败".into());
        }

        let target = GlobalLock(handle);
        if target.is_null() {
            GlobalFree(handle);
            return Err("剪贴板：内存锁定失败".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
        GlobalUnlock(handle);

        // 交出去之后这块内存归剪贴板管，**不能**再 GlobalFree —— 那是双重释放，
        // 而剪贴板里那些数据还在被别的程序读
        if SetClipboardData(format, handle as HANDLE).is_null() {
            GlobalFree(handle);
            return Err("剪贴板：写入失败".into());
        }
    }
    Ok(())
}

/// 自定义格式要先注册拿格式号（同一个名字重复注册会拿到同一个号）
fn register_format(name: &str) -> u32 {
    use std::os::windows::ffi::OsStrExt;

    let mut wide: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().collect();
    wide.push(0);
    unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
}

// ---------- DIB 构造（纯函数，可单测） ----------

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// 像素：自底向上按行写 BGRA。
///
/// **一趟转完、两份 DIB 共用这一份缓冲**：从前 `CF_DIBV5` / `CF_DIB` 各走一遍逐像素循环，
/// 同一张图要写两遍（4K 下是两趟 33MB）。这里换成「先写进一块预分配的缓冲、两份 DIB
/// 各自 `extend_from_slice` 拷过去」—— 换色与翻行只做一次，剩下的是内存带宽。
fn bgra_bottom_up(image: &image::RgbaImage) -> Vec<u8> {
    let (width, height) = image.dimensions();
    let stride = (width as usize) * 4;
    let data = image.as_raw();
    let mut out = vec![0u8; stride * height as usize];

    for row in 0..height as usize {
        let source = &data[(height as usize - 1 - row) * stride..][..stride];
        let target = &mut out[row * stride..][..stride];
        for (src, dst) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
            dst[0] = src[2]; // B
            dst[1] = src[1]; // G
            dst[2] = src[0]; // R
            dst[3] = src[3]; // A
        }
    }
    out
}

/// `BITMAPV5HEADER` + 32 位 BGRA（带 alpha、`BI_BITFIELDS`、sRGB）
fn build_dib_v5(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIBV5_HEADER as usize + pixels.len());

    push_u32(&mut out, DIBV5_HEADER);
    push_i32(&mut out, width as i32);
    push_i32(&mut out, height as i32); // 正数 = 自底向上
    push_u16(&mut out, 1); // 平面数
    push_u16(&mut out, 32); // 位深
    push_u32(&mut out, 3); // BI_BITFIELDS：下面四个掩码才有效
    push_u32(&mut out, width * height * 4); // 图像数据长度
    push_i32(&mut out, PELS_PER_METER);
    push_i32(&mut out, PELS_PER_METER);
    push_u32(&mut out, 0); // 调色板条目数
    push_u32(&mut out, 0); // 重要颜色数
    push_u32(&mut out, 0x00ff_0000); // 红掩码
    push_u32(&mut out, 0x0000_ff00); // 绿掩码
    push_u32(&mut out, 0x0000_00ff); // 蓝掩码
    push_u32(&mut out, 0xff00_0000); // alpha 掩码
    push_u32(&mut out, 0x7352_4742); // bV5CSType = 'sRGB'（LCS_WINDOWS_COLOR_SPACE）
    out.extend_from_slice(&[0u8; 36]); // CIEXYZTRIPLE，sRGB 下不用
    push_u32(&mut out, 0); // gamma 红
    push_u32(&mut out, 0); // gamma 绿
    push_u32(&mut out, 0); // gamma 蓝
    push_u32(&mut out, 4); // bV5Intent = LCS_GM_IMAGES
    push_u32(&mut out, 0); // 色彩配置文件偏移
    push_u32(&mut out, 0); // 色彩配置文件长度
    push_u32(&mut out, 0); // 保留

    out.extend_from_slice(pixels);
    out
}

/// `BITMAPINFOHEADER` + 32 位 BGRA（`BI_RGB`，alpha 被忽略）—— 最保守的那一档
fn build_dib(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIB_HEADER as usize + pixels.len());

    push_u32(&mut out, DIB_HEADER);
    push_i32(&mut out, width as i32);
    push_i32(&mut out, height as i32);
    push_u16(&mut out, 1);
    push_u16(&mut out, 32);
    push_u32(&mut out, 0); // BI_RGB
    push_u32(&mut out, width * height * 4);
    push_i32(&mut out, PELS_PER_METER);
    push_i32(&mut out, PELS_PER_METER);
    push_u32(&mut out, 0);
    push_u32(&mut out, 0);

    out.extend_from_slice(pixels);
    out
}

fn build_dibs(image: &image::RgbaImage) -> (Vec<u8>, Vec<u8>) {
    let (width, height) = image.dimensions();
    let pixels = bgra_bottom_up(image);
    (
        build_dib_v5(&pixels, width, height),
        build_dib(&pixels, width, height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两行两列，颜色能区分行与列，用来核对「自底向上 + BGRA」这两件事
    fn fixture() -> image::RgbaImage {
        let mut image = image::RgbaImage::new(2, 2);
        image.put_pixel(0, 0, image::Rgba([1, 2, 3, 255])); // 左上
        image.put_pixel(1, 0, image::Rgba([4, 5, 6, 128])); // 右上
        image.put_pixel(0, 1, image::Rgba([7, 8, 9, 255])); // 左下
        image.put_pixel(1, 1, image::Rgba([10, 11, 12, 255])); // 右下
        image
    }

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn read_i32(bytes: &[u8], offset: usize) -> i32 {
        i32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn dibv5_头长与关键字段() {
        let (bytes, _) = build_dibs(&fixture());
        assert_eq!(bytes.len(), (DIBV5_HEADER + 16) as usize);
        assert_eq!(read_u32(&bytes, 0), 124);
        assert_eq!(read_i32(&bytes, 4), 2);
        // 正高度 = 自底向上
        assert_eq!(read_i32(&bytes, 8), 2);
        assert_eq!(read_u32(&bytes, 16), 3); // BI_BITFIELDS
        assert_eq!(read_u32(&bytes, 20), 16); // 图像数据长度
        assert_eq!(read_u32(&bytes, 40), 0x00ff_0000); // 红掩码
        assert_eq!(read_u32(&bytes, 56), 0x7352_4742); // 'sRGB'
        assert_eq!(read_u32(&bytes, 108), 4); // LCS_GM_IMAGES
    }

    #[test]
    fn dib_头长与关键字段() {
        let (_, bytes) = build_dibs(&fixture());
        assert_eq!(bytes.len(), (DIB_HEADER + 16) as usize);
        assert_eq!(read_u32(&bytes, 0), 40);
        assert_eq!(read_u32(&bytes, 16), 0); // BI_RGB
        assert_eq!(read_u32(&bytes, 20), 16);
        assert_eq!(read_i32(&bytes, 28), PELS_PER_METER);
    }

    #[test]
    fn 像素是自底向上的_bgra() {
        // 先写的是最后一行（左下角那个像素）：7,8,9 → B=9 G=8 R=7 A=255
        let (v5, _) = build_dibs(&fixture());
        assert_eq!(&v5[124..128], &[9, 8, 7, 255]);
        // 再是右下角：10,11,12
        assert_eq!(&v5[128..132], &[12, 11, 10, 255]);
        // 然后是上一行：左上 1,2,3（alpha 128 的那个在它后面）
        assert_eq!(&v5[132..136], &[3, 2, 1, 255]);
        assert_eq!(&v5[136..140], &[6, 5, 4, 128]);
    }

    #[test]
    fn 两种dib的像素段完全一致() {
        let (v5, dib) = build_dibs(&fixture());
        assert_eq!(&v5[124..], &dib[40..]);
    }
}
