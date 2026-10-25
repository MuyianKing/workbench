//! 截图取字：把选区那一块交给 Windows 自带的 OCR（`Windows.Media.Ocr`）。
//!
//! ## 为什么用系统的、不随包带模型
//!
//! - **零体积**：识别引擎与语言包都是系统组件，安装包一个字节都不用加（前端本地方案
//!   （onnxruntime-web + PaddleOCR）要背 10MB 级的 wasm 引擎加模型，还得给 CSP 开
//!   `wasm-unsafe-eval`）；
//! - **零新依赖**：`windows` crate 已在编译图里（tao 引进来的），这里只是给它加
//!   `Media_Ocr` / `Graphics_Imaging` / `Storage_Streams` 几个 feature；
//! - **词级坐标现成**：中文一字一框、英文一词一框（都是物理像素），渲染层照着摆
//!   透明文字层就能逐字选中（Snipping Tool 的「文字操作」用的也是这一套引擎）。
//!
//! ## 这条路的边界
//!
//! - **语言包跟着系统走**：没装「文本识别」语言包时 `TryCreateFromUserProfileLanguages`
//!   建不出引擎，给一句人话了事（中文 Windows 上 zh-Hans 默认在）；
//! - **只认横排**：旋转 / 竖排的文字认不出（截图场景几乎全是横排，不处理）；
//! - **单边上限 10000px**（`OcrEngine::MaxImageDimension`）：放大后也不许越线（见下面那条）。
//!
//! ## 坐标口径
//!
//! 词框是**选区裁剪图上的物理像素**，原点在选区左上角 —— 与 `capture_copy_frame`
//! 收到的选区矩形同一套换算（渲染层取整后给，这里再夹一次到帧内）。

use serde::Serialize;
use windows::core::Interface;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{Buffer, IBuffer};
use windows::Win32::System::WinRT::IMemoryBufferByteAccess;

use crate::capture;

/// OCR 认出的一个词（中文通常一字一词，英文一空格一词）。
/// 坐标是选区裁剪图上的物理像素。
#[derive(Clone, Debug, Serialize)]
pub struct OcrWord {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// OCR 认出的一行（行内词已按阅读顺序排好；空行不进来）
#[derive(Clone, Debug, Serialize)]
pub struct OcrLine {
    pub words: Vec<OcrWord>,
}

/// 把选区那一块认成文字。**图不用搬**：Rust 手里就有这一场的原始帧（遮罩窗口的画布坐标、
/// 物理像素），照 `capture_copy_frame` 的口径裁出来识别 —— 标注不算在内（它只画在显示侧，
/// 取字读的是屏幕当时的样子）。遮罩**不收**：取字之后还要回到遮罩里选中、复制。
#[tauri::command(async)]
pub fn capture_ocr(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<Vec<OcrLine>, String> {
    let png = capture::take_frame_png(&window, &app)?;
    let image = image::load_from_memory(&png)
        .map_err(|err| format!("这张图解不开（{err}）"))?
        .to_rgba8();
    let (left, top, crop_width, crop_height) =
        capture::clamp_region(image.width(), image.height(), x, y, width, height)?;
    let cropped = image::imageops::crop_imm(&image, left, top, crop_width, crop_height).to_image();
    recognize(&cropped)
}

/// 对一块 RGBA 像素跑一遍识别。抽出成独立函数：单测与探针都从这儿进。
fn recognize(image: &image::RgbaImage) -> Result<Vec<OcrLine>, String> {
    // 小选区**先放大再认**：这个引擎对十几二十物理像素的界面小字明显吃力
    // （本机实测同一句「钮看得见，直接把全金」：14px 错一半、20px 把「把」拆成「扌巴」、
    // 40px 起全对）。选区尺寸是小字的最好代理 —— 小选区里装的多半就是小字。
    // 放大后仍在 10000px 上限内（2048×2 = 4096），大选区（整屏那类）不放大：本来就慢。
    let factor = upscale_factor(image.width().max(image.height()));
    let fed = if factor > 1 {
        image::imageops::resize(
            image,
            image.width() * factor,
            image.height() * factor,
            image::imageops::FilterType::CatmullRom,
        )
    }
    else {
        image.clone()
    };

    // 引擎按「用户配置的语言列表」挑（zh-Hans 的引擎认得了拉丁字母，中英混排不用换引擎）；
    // 没有任何可用的语言包时它建不出来 —— 这是这台机器的事，如实说一句
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "本机没有装文字识别语言包（设置 → 时间和语言 → 语言 → 添加语言，勾选「文本识别」）".to_string())?;

    let bitmap = software_bitmap(&fed)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|err| format!("起文字识别失败（{err}）"))?
        .join()
        .map_err(|err| format!("文字识别没有完成（{err}）"))?;

    let scale = factor as f64;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(|err| format!("读识别结果失败（{err}）"))? {
        let mut words = Vec::new();
        for word in line.Words().map_err(|err| format!("读识别结果失败（{err}）"))? {
            let text = word.Text().map_err(|err| format!("读识别结果失败（{err}）"))?.to_string();
            let rect = word.BoundingRect().map_err(|err| format!("读识别结果失败（{err}）"))?;
            // 空词与零尺寸的框直接丢：它们在文字层上摆不出任何东西，只会挡选区
            if text.trim().is_empty() || rect.Width <= 0.0 || rect.Height <= 0.0 {
                continue;
            }
            // 词框除回放大倍数：文字层要原样对齐选区上的字
            words.push(OcrWord {
                text,
                x: rect.X as f64 / scale,
                y: rect.Y as f64 / scale,
                w: rect.Width as f64 / scale,
                h: rect.Height as f64 / scale,
            });
        }
        if !words.is_empty() {
            lines.push(OcrLine { words });
        }
    }
    Ok(lines)
}

/// 放大倍数按选区长边分档，**喂给引擎的长边封顶 4096**（实测 4096×4096 全是字的图 0.5s 出头，
/// 再大就往秒级走了）：小选区装的多半是小字，放得越多错字越少 —— 20px 的界面字放 3 倍
/// 后同一句全对（见 recognize 里那条实测）。整屏那一档（长边 > 2048）不放大：内容杂、本来就慢。
fn upscale_factor(max_dim: u32) -> u32 {
    if max_dim <= 1365 {
        3
    }
    else if max_dim <= 2048 {
        2
    }
    else {
        1
    }
}

/// RGBA 像素 → OCR 认的 `SoftwareBitmap`（Bgra8）。
///
/// 像素灌进 WinRT 的 `Buffer`：它对外只给一个不公开的 COM 接口
/// （`IMemoryBufferByteAccess`）拿原始指针，这也是所有 WinRT 字节缓冲的标准走法。
fn software_bitmap(image: &image::RgbaImage) -> Result<SoftwareBitmap, String> {
    let bgra = to_bgra(image.as_raw());
    let buffer = Buffer::Create(bgra.len() as u32)
        .map_err(|err| format!("申请像素缓冲失败（{err}）"))?;

    unsafe {
        // 像素往 Buffer 里写要走它不公开的 COM 接口（IMemoryBufferByteAccess）。
        // **不能在 Buffer 上直接 QI**（实测 E_NOINTERFACE 0x80004002，CreateReference 也不在
        // IBuffer 上）：得先经 IBufferStatics 的 CreateMemoryBufferOverIBuffer 架一个**共享同一块
        // 内存**的 MemoryBuffer，从它的引用 QI —— 这是 WinRT 字节缓冲拿原始指针的标准走法
        let memory = Buffer::CreateMemoryBufferOverIBuffer(&buffer)
            .map_err(|err| format!("取不到像素缓冲（{err}）"))?;
        let reference = memory
            .CreateReference()
            .map_err(|err| format!("取不到像素缓冲（{err}）"))?;
        let byte_access: IMemoryBufferByteAccess = reference
            .cast()
            .map_err(|err| format!("取不到像素缓冲（{err}）"))?;
        let mut pointer = std::ptr::null_mut();
        let mut capacity = 0u32;
        byte_access
            .GetBuffer(&mut pointer, &mut capacity)
            .map_err(|err| format!("取不到像素缓冲（{err}）"))?;
        let capacity = capacity as usize;
        if capacity < bgra.len() {
            return Err("像素缓冲不够装这一块图".into());
        }
        std::ptr::copy_nonoverlapping(bgra.as_ptr(), pointer, bgra.len());
    }

    // **Length 必须显式给**：Buffer::Create 只定了 Capacity，Length 还是 0 —— 经字节接口写进去
    // 并不会带它长。CreateCopyFromBuffer 按 Length 拷贝，0 就报 0xC00D7170
    // （消息是「响应内存不足」，看着像内存问题，其实是长度没给）
    let ibuffer: IBuffer = buffer.cast().map_err(|err| format!("准备识别图失败（{err}）"))?;
    ibuffer
        .SetLength(bgra.len() as u32)
        .map_err(|err| format!("准备识别图失败（{err}）"))?;

    SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        image.width() as i32,
        image.height() as i32,
    )
    .map_err(|err| format!("准备识别图失败（{err}）"))
}

/// RGBA 字节换成 BGRA（WinRT 那边只吃 Bgra8 / Gray8；缓帧解出来的是 PNG 的 RGBA）
fn to_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut bgra = rgba.to_vec();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    bgra
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_换成_bgra_只对调首尾两个字节() {
        let bgra = to_bgra(&[10, 20, 30, 255, 1, 2, 3, 128]);
        assert_eq!(bgra, [30, 20, 10, 255, 3, 2, 1, 128]);
        // 输入不动（缓帧那份还要留着给复制 / 保存用）
    }

    #[test]
    fn 空图与奇数字节都不炸() {
        assert!(to_bgra(&[]).is_empty());
        // chunks_exact：尾巴不足一个像素的那几个字节原样带过去，不越界
        assert_eq!(to_bgra(&[1, 2, 3]), [1, 2, 3]);
    }

    /// 小选区放大、大选区不放大：档位是这个功能准确率的根（见 recognize 里那条实测），
    /// 边界值要钉住 —— 它们决定「同一块图换一种框法会不会从 3x 掉到 1x」
    #[test]
    fn 放大倍数按选区长边分三档() {
        assert_eq!(upscale_factor(1), 3);
        assert_eq!(upscale_factor(1365), 3);
        assert_eq!(upscale_factor(1366), 2);
        assert_eq!(upscale_factor(2048), 2);
        assert_eq!(upscale_factor(2049), 1);
        // 4K 整屏那一档不放大；喂给引擎的长边封顶 4096（1365×3），离 10000px 的红线远
        assert_eq!(upscale_factor(3840), 1);
    }

    /// 手动探针：验整条 WinRT 链路在这台机器上通不通（不认任何字，只看调用都成立），
    /// `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ocr_probe -- --ignored`。
    /// 空白图认不出东西是正常结果；要认字得拿真截图在应用里走「取字」那颗按钮。
    #[test]
    #[ignore = "手动探针：只用来确认 OCR 的 WinRT 调用链在这台机器上通"]
    fn ocr_probe() {
        let blank = image::RgbaImage::from_pixel(32, 32, image::Rgba([255, 255, 255, 255]));
        let lines = recognize(&blank).expect("空白图的识别调用不该失败");
        assert!(lines.is_empty(), "空白图不该认出字：{lines:?}");
    }
}
