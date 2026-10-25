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
///
/// 两遍法：第一遍按选区长边给档位（选区尺寸是小字的**代理** —— 小选区装的多半是小字，
/// 但代理会失手：大段的小字长边落在低档，就放不够）；认完**量真实字高**（词框高度的
/// 中位数，抗得住零星异常框），喂字高不在全对线附近就重认。**倍数不是越大越好** ——
/// 探针实测（`ocr_factor_probe`，见 tests）：喂字高 40px 上下是甜点，39px 编辑距离 15、
/// 52px 反而 17、26px 23（同一段 152 字），所以第二遍取**离线最近**的倍数，不追大。
fn recognize(image: &image::RgbaImage) -> Result<Vec<OcrLine>, String> {
    let factor = upscale_factor(image.width().max(image.height()));
    let mut lines = recognize_at(image, factor)?;
    if let Some(more) = second_pass_factor(
        median_word_height(&lines),
        image.width(),
        image.height(),
        factor,
    ) {
        lines = recognize_at(image, more)?;
    }
    Ok(lines)
}

/// 放大 → 引擎识别 → 词框除回倍数，喂图口径见 [recognize] 与 [upscale_factor] 的注释。
fn recognize_at(image: &image::RgbaImage, factor: u32) -> Result<Vec<OcrLine>, String> {
    // 小选区**先放大再认**：这个引擎对十几二十物理像素的界面小字明显吃力
    // （本机实测同一句「钮看得见，直接把全金」：14px 错一半、20px 把「把」拆成「扌巴」）。
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
    recognize_fed(&fed, factor as f64)
}

/// 引擎识别一块**已备好**的图，词框除回 `scale`（放大在调用方：探针要换插值试）。
fn recognize_fed(fed: &image::RgbaImage, scale: f64) -> Result<Vec<OcrLine>, String> {
    // 引擎按「用户配置的语言列表」挑（zh-Hans 的引擎认得了拉丁字母，中英混排不用换引擎）；
    // 没有任何可用的语言包时它建不出来 —— 这是这台机器的事，如实说一句
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "本机没有装文字识别语言包（设置 → 时间和语言 → 语言 → 添加语言，勾选「文本识别」）".to_string())?;
    recognize_with(&engine, fed, scale)
}

/// 指定引擎认一块图（探针要换引擎对照，生产走 [recognize_fed]）。
fn recognize_with(
    engine: &OcrEngine,
    fed: &image::RgbaImage,
    scale: f64,
) -> Result<Vec<OcrLine>, String> {
    let bitmap = software_bitmap(fed)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|err| format!("起文字识别失败（{err}）"))?
        .join()
        .map_err(|err| format!("文字识别没有完成（{err}）"))?;

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

/// 词框高度的中位数（选区原图口径）。取中位是为了抗住零星的异常框（图标误框、孤立标点）；
/// 一个词都没有（空白图那类）返回 None —— 无从量起。
fn median_word_height(lines: &[OcrLine]) -> Option<f64> {
    let mut heights: Vec<f64> = lines
        .iter()
        .flat_map(|line| line.words.iter())
        .map(|word| word.h)
        .collect();
    if heights.is_empty() {
        return None;
    }
    heights.sort_by(|a, b| a.total_cmp(b));
    Some(heights[heights.len() / 2])
}

/// 喂给引擎的词高全对线（探针实测：喂字高落在它附近最准，见 [recognize]）。
const FED_WORD_HEIGHT_TARGET: f64 = 40.0;

/// 第二遍喂图的长边上限：引擎的硬红线是 10000px（`OcrEngine::MaxImageDimension`），留一步余量。
const FED_MAX_DIM: u32 = 9999;

/// 第二遍喂图的像素总量上限：4096²（1670 万）实测 0.5s 出头，40M 约 1~2s —— 只发生在
/// 字确实小的选区上（4K 整屏 2 倍是 3300 万，也在它之内：实测整屏小字 2 倍比原样强一截）。
const FED_MAX_AREA: u64 = 40_000_000;

/// 第二遍的放大倍数：喂字高**最接近**全对线的那一档（受长边与像素总量两个上限约束）。
/// None 表示不用重认（已在线附近 / 认不出词 / 上限内升不动）。
fn second_pass_factor(h_med: Option<f64>, width: u32, height: u32, first: u32) -> Option<u32> {
    let h_med = h_med?;
    let want = (FED_WORD_HEIGHT_TARGET / h_med).round();
    if want < 1.0 {
        return None;
    }
    let dim_cap = (FED_MAX_DIM / width.max(height)).max(1);
    let area = u64::from(width) * u64::from(height);
    let area_cap = ((FED_MAX_AREA as f64 / area as f64).sqrt().floor()) as u32;
    let more = (want as u32).min(dim_cap).min(area_cap.max(1));
    (more > first).then_some(more)
}

/// 放大倍数按选区长边分档，**喂给引擎的长边封顶 4096**（实测 4096×4096 全是字的图 0.5s 出头，
/// 再大就往秒级走了）：小选区装的多半是小字，放得越多错字越少 —— 20px 的界面字放 3 倍
/// 后同一句全对。整屏那一档（长边 > 2048）不放大：内容杂、本来就慢。
/// 第一遍只是「字高」的代理，第二遍按量出的真实字高校正（见 [recognize]）。
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

    /// 两遍法的根：第二遍取「离全对线最近」的倍数，不是越大越好 —— 探针实测喂字高
    /// 39px 编辑距离 15、52px 反而 17（见 ocr_factor_probe 的注释），这些边界钉住这个口径
    #[test]
    fn 第二遍取最接近全对线的倍数() {
        // 12.5px 字在 3x 已到 37.5（离 40 差 2.5；4x 的 50 差 10）：留在 3x，不重认
        assert_eq!(second_pass_factor(Some(12.5), 1137, 52, 3), None);
        // 10px 字：round(40/10)=4，正好落在线上 → 补到 4x
        assert_eq!(second_pass_factor(Some(10.0), 1322, 76, 3), Some(4));
        // 4K 整屏不放大、字又小：长边与像素总量双重封顶后还能到 2x（实测整屏小字 2x 强一截）
        assert_eq!(second_pass_factor(Some(12.0), 3840, 2160, 1), Some(2));
        // 要 5 倍，上限内要多少给多少
        assert_eq!(second_pass_factor(Some(8.0), 1000, 400, 3), Some(5));
        // 要 7 倍但长边只许 6（9999/1600）：按封顶来
        assert_eq!(second_pass_factor(Some(6.0), 1600, 100, 2), Some(6));
        // 字已经在线上方：不重认
        assert_eq!(second_pass_factor(Some(20.0), 1000, 400, 3), None);
        assert_eq!(second_pass_factor(Some(41.0), 900, 300, 1), None);
        // 离谱大字（want 不足 1）：不重认
        assert_eq!(second_pass_factor(Some(100.0), 2000, 500, 1), None);
        // 一个词都没认出来：无从量起
        assert_eq!(second_pass_factor(None, 500, 100, 1), None);
    }

    /// 中位数要抗住零星异常框：混着几框高的也不把字高带偏
    #[test]
    fn 词高中位数抗得住异常框() {
        let line = |hs: &[f64]| OcrLine {
            words: hs
                .iter()
                .map(|&h| OcrWord { text: "字".into(), x: 0.0, y: 0.0, w: h, h })
                .collect(),
        };
        // 十几框正常字高里混两框离谱的（图标误框 80、孤立标点 2）：中位数仍是正常档
        let normal = [16.0, 15.0, 17.0, 16.0, 15.0, 16.0, 80.0, 2.0, 16.0, 15.0, 17.0, 16.0];
        assert_eq!(median_word_height(&[line(&normal)]), Some(16.0));
        // 没有词：None（空白图那类）
        assert_eq!(median_word_height(&[]), None);
        assert_eq!(median_word_height(&[line(&[])]), None);
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

    /// 手动探针：拿一张真实截图扫「放大倍数 × 预处理 × 引擎」，量这段字怎么喂才认得全
    /// —— 生产档位与预处理就照它调。
    /// ```
    /// OCR_PROBE_IMAGE=<png> [OCR_PROBE_TRUTH=<原文>] \
    ///   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ocr_factor_probe -- --ignored --nocapture
    /// ```
    /// 给了原文就打印编辑距离（去空白后比）；预处理四种：raw（原样）、otsu（放大后全局阈值
    /// 二值化）、stretch（对比度拉伸）、otsu-dark（反相后二值化，模拟暗色模式）。
    #[test]
    #[ignore = "手动探针：传 OCR_PROBE_IMAGE 看各倍数 / 预处理 / 引擎下的识别结果"]
    fn ocr_factor_probe() {
        let path = std::env::var("OCR_PROBE_IMAGE").expect("设 OCR_PROBE_IMAGE 指到截图 png");
        let image = image::open(&path).expect("图解不开").to_rgba8();
        let truth: Option<Vec<char>> = std::env::var("OCR_PROBE_TRUTH").ok().map(|text| {
            text.chars().filter(|c| !c.is_whitespace()).collect()
        });
        println!("原图 {}×{}", image.width(), image.height());

        // 主引擎 + （装了语言包的话）en-US 对照：zh 引擎常把标点与数字段认歪
        let zh = OcrEngine::TryCreateFromUserProfileLanguages().expect("主引擎建不出来");
        let mut engines = vec![("zh", zh)];
        if let Ok(lang) = windows::Globalization::Language::CreateLanguage(&"en-US".into()) {
            if let Ok(en) = OcrEngine::TryCreateFromLanguage(&lang) {
                engines.push(("en", en));
            }
            else {
                println!("（en-US 引擎建不出来，只跑 zh）");
            }
        }

        for factor in [2u32, 3, 4] {
            let fed = image::imageops::resize(
                &image,
                image.width() * factor,
                image.height() * factor,
                image::imageops::FilterType::CatmullRom,
            );
            for (pre_name, prepared) in [
                ("raw", fed.clone()),
                ("sharpen", sharpen(&fed)),
                ("otsu", otsu_binarize(&fed)),
                ("stretch", contrast_stretch(&fed)),
            ] {
                for (engine_name, engine) in &engines {
                    let lines = match recognize_with(engine, &prepared, factor as f64) {
                        Ok(lines) => lines,
                        Err(err) => {
                            println!("{factor}x {pre_name}/{engine_name}: 失败（{err}）");
                            continue;
                        }
                    };
                    let text: String = lines
                        .iter()
                        .flat_map(|line| line.words.iter().map(|word| word.text.as_str()))
                        .collect::<Vec<_>>()
                        .join("");
                    let score = match &truth {
                        Some(truth) => {
                            let got: Vec<char> =
                                text.chars().filter(|c| !c.is_whitespace()).collect();
                            format!("距离 {}/{} ", levenshtein(truth, &got), truth.len())
                        }
                        None => String::new(),
                    };
                    println!("{factor}x {pre_name}/{engine_name}: {score}\n    {text}");
                }
            }
        }
    }

    /// 亮度（0~255，BT.601 加权）
    fn luma(px: &image::Rgba<u8>) -> u32 {
        (u32::from(px[0]) * 299 + u32::from(px[1]) * 587 + u32::from(px[2]) * 114) / 1000
    }

    /// Otsu 全局阈值二值化：直方图上找类间方差最大的切点，暗的一侧压黑、亮的压白
    /// （暗色模式的白字黑底自动同极，反相与否都试）
    fn otsu_binarize(image: &image::RgbaImage) -> image::RgbaImage {
        let mut hist = [0u64; 256];
        for px in image.pixels() {
            hist[luma(px) as usize] += 1;
        }
        let total = u64::from(image.width()) * u64::from(image.height());
        let sum: u64 = hist.iter().enumerate().map(|(t, n)| *n * t as u64).sum();
        let (mut w_b, mut sum_b, mut best, mut threshold) = (0u64, 0u64, 0f64, 128u32);
        for (t, &n) in hist.iter().enumerate() {
            w_b += n;
            if w_b == 0 {
                continue;
            }
            let w_f = total - w_b;
            if w_f == 0 {
                break;
            }
            sum_b += n * t as u64;
            let m_b = sum_b as f64 / w_b as f64;
            let m_f = (sum - sum_b) as f64 / w_f as f64;
            let between = w_b as f64 * w_f as f64 * (m_b - m_f).powi(2);
            if between > best {
                best = between;
                threshold = t as u32;
            }
        }
        let mut out = image.clone();
        for px in out.pixels_mut() {
            let v = if luma(px) <= threshold { 0 } else { 255 };
            *px = image::Rgba([v, v, v, 255]);
        }
        out
    }

    /// 对比度拉伸：亮度 1%~99% 分位拉到全幅，三通道同乘同减（色相基本不动）
    fn contrast_stretch(image: &image::RgbaImage) -> image::RgbaImage {
        let mut lums: Vec<u32> = image.pixels().map(luma).collect();
        lums.sort_unstable();
        let at = |q: usize| lums[lums.len() * q / 100];
        let (lo, hi) = (at(1), at(99).max(at(1) + 1));
        let mut out = image.clone();
        for px in out.pixels_mut() {
            for c in &mut px.0[..3] {
                let stretched = (u32::from(*c)).saturating_sub(lo) * 255 / (hi - lo);
                *c = stretched.min(255) as u8;
            }
        }
        out
    }

    /// 拉普拉斯锐化（out = 5·c − 上 − 下 − 左 − 右）：插值放大会抹平笔画边缘，锐化补回来
    fn sharpen(image: &image::RgbaImage) -> image::RgbaImage {
        let (w, h) = (i64::from(image.width()), i64::from(image.height()));
        let at = |x: i64, y: i64| {
            *image.get_pixel(x.clamp(0, w - 1) as u32, y.clamp(0, h - 1) as u32)
        };
        let mut out = image.clone();
        for y in 0..h {
            for x in 0..w {
                let c = at(x, y);
                let up = at(x, y - 1);
                let down = at(x, y + 1);
                let left = at(x - 1, y);
                let right = at(x + 1, y);
                let mut px = [0u8; 4];
                for (ch, v) in px.iter_mut().enumerate().take(3) {
                    let sharp = 5 * i32::from(c[ch])
                        - i32::from(up[ch])
                        - i32::from(down[ch])
                        - i32::from(left[ch])
                        - i32::from(right[ch]);
                    *v = sharp.clamp(0, 255) as u8;
                }
                px[3] = c[3];
                out.get_pixel_mut(x as u32, y as u32).0 = px;
            }
        }
        out
    }

    /// 编辑距离（两行 DP）：探针给各倍数的识别结果打个可比的分
    fn levenshtein(a: &[char], b: &[char]) -> usize {
        let mut row: Vec<usize> = (0..=b.len()).collect();
        for (i, ca) in a.iter().enumerate() {
            let mut next = vec![i + 1];
            for (j, cb) in b.iter().enumerate() {
                let cost = usize::from(ca != cb);
                next.push((row[j] + cost).min(row[j + 1] + 1).min(next[j] + 1));
            }
            row = next;
        }
        row[b.len()]
    }
}
