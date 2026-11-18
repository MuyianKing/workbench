//! 把一张 PNG 或一段文本写进 Windows 剪贴板。
//!
//! **为什么不走 WebView 的 `navigator.clipboard`**：WebView2 的异步剪贴板要
//! `CoreWebView2` 的权限回调放行（wry 没暴露出来），失败还是静默的；而且它只写 PNG
//! 一种格式，认 CF_DIB 的老程序（画图、部分 Office 版本）粘出来是空的。文本同理：
//! `navigator.clipboard.writeText` 同样卡在那个权限回调上，所以取色 / 取字的文本出口
//! 也一并走这里。Win32 这条路图片一次能给齐三种格式，文本给 `CF_UNICODETEXT`，
//! 也与我们「宿主能力走 Rust」的口径一致。
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
//!
//! ## DPI 要按截到的那块屏写
//!
//! 截出来的像素是**物理像素**，而 DPI-aware 的程序（WPS / Word 这类）是照
//! `biXPelsPerMeter` 决定「一个像素该占多大」的。从前这里一律写 2835（72 DPI），
//! 于是 96/72 = 1.33 倍铺开、字就发虚 —— 值必须跟着屏走：`96 × scale`，100% 是
//! 3780，150% 是 5670。PNG 那份同理，补一个 `pHYs` 块（单位米），让不带 DIB 头的
//! 消费方也读得到。
//!
//! Chromium 系（含 Electron）粘图时先取注册格式 `PNG`、整条读图路径**不看 DPI**，
//! 所以这一项对它们没有效果；有影响的正是按 DPI 摆图的那批程序。

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
/// CF_UNICODETEXT：Unicode 文本（UTF-16LE + 结尾 NUL），值同样来自 winuser.h。
/// 取色 / 取字复制的字符都是 BMP 内的十六进制 / OCR 文本，UTF-16 编码一一对应。
const CF_UNICODETEXT: u32 = 13;

/// `BITMAPV5HEADER` 的长度
const DIBV5_HEADER: u32 = 124;
/// `BITMAPINFOHEADER` 的长度
const DIB_HEADER: u32 = 40;
/// 96 DPI 对应的「像素/米」（96 / 0.0254 = 3779.5，Windows 那几家都取 3780）。
/// 其余档位按 96 这一档等比算：120 DPI → 4725，144 DPI → 5670
const PELS_PER_METER_96: i32 = 3780;

/// 某块屏的缩放 → 这份截图该声明的 DPI（96 × scale）
pub fn dpi_for_scale(scale: f64) -> u32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (96.0 * scale).round() as u32
}

/// 把 PNG 字节写进剪贴板。`dpi` 见文件头「DPI 要按截到的那块屏写」
pub fn write_png(png: &[u8], dpi: u32) -> Result<(), String> {
    let image = image::load_from_memory(png)
        .map_err(|err| format!("剪贴板：这张图解不开（{err}）"))?
        .to_rgba8();
    write_rgba(&image, png, dpi)
}

/// 把已经解好的像素写进剪贴板。`png` 是这块图对应的 PNG 字节 —— 剪贴板里的 `PNG` 格式
/// 直接用它（补一个 `pHYs` 之后），不重编一遍；DIB 那两个格式才需要像素。
pub fn write_rgba(image: &image::RgbaImage, png: &[u8], dpi: u32) -> Result<(), String> {
    // **像素只转一遍**：两份 DIB 的像素段完全一样，共用这一份自底向上的 BGRA 缓冲
    let (dib_v5, dib) = build_dibs(image, dpi);

    with_clipboard(|| {
        // 顺序有意义：先放最精确的，后面的格式不会覆盖前面的（格式号不同）
        set_data(CF_DIBV5, &dib_v5)?;
        set_data(CF_DIB, &dib)?;
        let png_format = register_format("PNG");
        if png_format != 0 {
            set_data(png_format, &with_phys(png, dpi))?;
        }
        Ok(())
    })
}

/// 把一段文本写进剪贴板（`CF_UNICODETEXT`，UTF-16LE + 结尾 NUL）。
/// 取色的十六进制串、取字的 OCR 文本都走这条，不再经 WebView 的异步剪贴板。
pub fn write_text(text: &str) -> Result<(), String> {
    let bytes = utf16le_with_nul(text);
    with_clipboard(|| set_data(CF_UNICODETEXT, &bytes))
}

/// 文本 → `CF_UNICODETEXT` 的字节：UTF-16LE，末尾补一个 NUL 收尾（Windows 要求）。
/// 抽成纯函数好单测 —— 真正写剪贴板要在用户会话里打开它，单测里做不到。
fn utf16le_with_nul(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity((text.chars().count() + 1) * 2);
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out.extend_from_slice(&[0, 0]);
    out
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
fn build_dib_v5(pixels: &[u8], width: u32, height: u32, dpi: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIBV5_HEADER as usize + pixels.len());

    push_u32(&mut out, DIBV5_HEADER);
    push_i32(&mut out, width as i32);
    push_i32(&mut out, height as i32); // 正数 = 自底向上
    push_u16(&mut out, 1); // 平面数
    push_u16(&mut out, 32); // 位深
    push_u32(&mut out, 3); // BI_BITFIELDS：下面四个掩码才有效
    push_u32(&mut out, width * height * 4); // 图像数据长度
    push_i32(&mut out, pels_per_meter(dpi));
    push_i32(&mut out, pels_per_meter(dpi));
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
fn build_dib(pixels: &[u8], width: u32, height: u32, dpi: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(DIB_HEADER as usize + pixels.len());

    push_u32(&mut out, DIB_HEADER);
    push_i32(&mut out, width as i32);
    push_i32(&mut out, height as i32);
    push_u16(&mut out, 1);
    push_u16(&mut out, 32);
    push_u32(&mut out, 0); // BI_RGB
    push_u32(&mut out, width * height * 4);
    push_i32(&mut out, pels_per_meter(dpi));
    push_i32(&mut out, pels_per_meter(dpi));
    push_u32(&mut out, 0);
    push_u32(&mut out, 0);

    out.extend_from_slice(pixels);
    out
}

fn build_dibs(image: &image::RgbaImage, dpi: u32) -> (Vec<u8>, Vec<u8>) {
    let (width, height) = image.dimensions();
    let pixels = bgra_bottom_up(image);
    (
        build_dib_v5(&pixels, width, height, dpi),
        build_dib(&pixels, width, height, dpi),
    )
}

fn pels_per_meter(dpi: u32) -> i32 {
    (PELS_PER_METER_96 as f64 * dpi as f64 / 96.0).round() as i32
}

// ---------- PNG 的 pHYs（纯函数，可单测） ----------

/// PNG 的 CRC-32（IEEE 802.3，多项式 0xEDB88320，反射写法）
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

/// 往 PNG 里补一个 `pHYs` 块（紧跟 IHDR），声明 DPI。已有 pHYs 的（不该有）原样返回。
///
/// **为什么自己插**：`image` 的 PNG 编码器不写这个块，而剪贴板里 PNG 那份要交给
/// 不看 DIB 头的消费方；重编一遍整张图只为一个 21 字节的块不划算。
fn with_phys(png: &[u8], dpi: u32) -> Vec<u8> {
    const SIGNATURE: usize = 8;
    const CHUNK_HEADER: usize = 8;
    const CHUNK_TAIL: usize = 4;

    // 签名 + IHDR（长度 4 + 类型 4 + 数据 13 + CRC 4）
    if png.len() < SIGNATURE + CHUNK_HEADER + 13 + CHUNK_TAIL || &png[SIGNATURE + 4..SIGNATURE + 8] != b"IHDR" {
        return png.to_vec();
    }
    let insert_at = SIGNATURE + CHUNK_HEADER + 13 + CHUNK_TAIL;
    // 已经有就不要再来一个：同名块重复的 PNG 不合规
    if png.len() >= insert_at + 8 && &png[insert_at + 4..insert_at + 8] == b"pHYs" {
        return png.to_vec();
    }

    let per_meter = pels_per_meter(dpi) as u32;
    let mut body = Vec::with_capacity(9);
    body.extend_from_slice(&per_meter.to_be_bytes());
    body.extend_from_slice(&per_meter.to_be_bytes());
    body.push(1); // 单位：米

    let mut chunk = Vec::with_capacity(4 + 4 + body.len() + 4);
    chunk.extend_from_slice(&(body.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"pHYs");
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc32(&chunk[4..]).to_be_bytes());

    let mut out = Vec::with_capacity(png.len() + chunk.len());
    out.extend_from_slice(&png[..insert_at]);
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&png[insert_at..]);
    out
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
    fn utf16le_带结尾_nul() {
        // 取色的十六进制串：每字符一个小端 u16，末尾补 0,0
        assert_eq!(utf16le_with_nul("#A1"), vec![0x23, 0, 0x41, 0, 0x31, 0, 0, 0]);
        // 空串也有那个收尾 NUL
        assert_eq!(utf16le_with_nul(""), vec![0, 0]);
        // BMP 外字符按代理对编码，长度是 2 个 u16
        let emoji = utf16le_with_nul("😀");
        assert_eq!(emoji.len(), 6); // 代理对 4 字节 + 结尾 2 字节
        assert_eq!(&emoji[..4], &[0x3d, 0xd8, 0x00, 0xde]); // U+1F600 的 UTF-16LE
    }

    #[test]
    fn dibv5_头长与关键字段() {
        let (bytes, _) = build_dibs(&fixture(), 96);
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
        let (_, bytes) = build_dibs(&fixture(), 96);
        assert_eq!(bytes.len(), (DIB_HEADER + 16) as usize);
        assert_eq!(read_u32(&bytes, 0), 40);
        assert_eq!(read_u32(&bytes, 16), 0); // BI_RGB
        assert_eq!(read_u32(&bytes, 20), 16);
        assert_eq!(read_i32(&bytes, 28), PELS_PER_METER_96);
    }

    #[test]
    fn 像素是自底向上的_bgra() {
        // 先写的是最后一行（左下角那个像素）：7,8,9 → B=9 G=8 R=7 A=255
        let (v5, _) = build_dibs(&fixture(), 96);
        assert_eq!(&v5[124..128], &[9, 8, 7, 255]);
        // 再是右下角：10,11,12
        assert_eq!(&v5[128..132], &[12, 11, 10, 255]);
        // 然后是上一行：左上 1,2,3（alpha 128 的那个在它后面）
        assert_eq!(&v5[132..136], &[3, 2, 1, 255]);
        assert_eq!(&v5[136..140], &[6, 5, 4, 128]);
    }

    #[test]
    fn 两种dib的像素段完全一致() {
        let (v5, dib) = build_dibs(&fixture(), 96);
        assert_eq!(&v5[124..], &dib[40..]);
    }

    #[test]
    fn dpi_按屏缩放换算() {
        assert_eq!(dpi_for_scale(1.0), 96);
        assert_eq!(dpi_for_scale(1.25), 120);
        assert_eq!(dpi_for_scale(1.5), 144);
        assert_eq!(dpi_for_scale(2.0), 192);
        // 拿不到缩放（0 / NaN / 负数）按 100% 算
        assert_eq!(dpi_for_scale(0.0), 96);
        assert_eq!(dpi_for_scale(f64::NAN), 96);
        assert_eq!(dpi_for_scale(-2.0), 96);
    }

    #[test]
    fn 像素每米按_96_这一档等比() {
        assert_eq!(pels_per_meter(96), 3780);
        assert_eq!(pels_per_meter(120), 4725);
        assert_eq!(pels_per_meter(144), 5670);
        // 两份 DIB 的头里写的是同一个值
        let (v5, dib) = build_dibs(&fixture(), 144);
        assert_eq!(read_i32(&v5, 24), 5670);
        assert_eq!(read_i32(&v5, 28), 5670);
        assert_eq!(read_i32(&dib, 24), 5670);
        assert_eq!(read_i32(&dib, 28), 5670);
    }

    #[test]
    fn crc32_与_png_规范一致() {
        // IEND 块（类型 "IEND"、无数据）的 CRC 是 0xAE426082
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"IEND"), 0xae42_6082);
    }

    #[test]
    fn phys_块插在_ihdr_后面且自洽() {
        let png = tiny_png();
        let with = with_phys(&png, 144);
        assert_eq!(with.len(), png.len() + 21);

        let at = 33; // 签名 8 + IHDR（长度 4 + 类型 4 + 数据 13 + CRC 4）
        assert_eq!(be_u32(&with, at), 9); // 数据长度
        assert_eq!(&with[at + 4..at + 8], b"pHYs");
        assert_eq!(be_u32(&with, at + 8), 5670); // X
        assert_eq!(be_u32(&with, at + 12), 5670); // Y
        assert_eq!(with[at + 16], 1); // 单位：米
        assert_eq!(be_u32(&with, at + 17), crc32(&with[at + 4..at + 17]));
        // 原有的块原样接回去
        assert_eq!(&with[at + 21..], &png[at..]);
    }

    #[test]
    fn phys_不会被插两次() {
        let once = with_phys(&tiny_png(), 96);
        assert_eq!(with_phys(&once, 192), once);
    }

    #[test]
    fn 不是_png_就原样返回() {
        let junk = b"not a png at all";
        assert_eq!(with_phys(junk, 96), junk);
    }

    fn tiny_png() -> Vec<u8> {
        use image::ImageEncoder;
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]));
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(image.as_raw(), 2, 2, image::ExtendedColorType::Rgba8)
            .expect("测试图编码失败");
        out
    }

    fn be_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }
}
