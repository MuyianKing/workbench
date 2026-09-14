//! 图片缩放与 data URL 编码（目前只剩内置壁纸的缩略图走这里）。
//!
//! 缩略图要在设置面板里铺一排，原图整张塞进 data URL 既占内存又拖慢渲染，所以统一压到
//! `max_edge` 以内再编码。**工作区背景图不再走这里** —— 它由 webview 按文件直接加载
//! （asset 协议），我们这边不碰它的像素，见 commands.rs 的 `allow_background`。
//!
//! 编码格式按有没有透明通道分：带 alpha 的走 PNG（JPEG 会把透明区域压成黑色，
//! 铺在窗口上会看到黑块），其余走 JPEG 控制体积 —— 壁纸绝大多数是照片。
//! `thumbnail` 用的是快速缩放（不做高质量重采样）：这是给界面铺满用的，不是出图。

use std::io::Cursor;
use std::path::Path;

use crate::encoding::base64;

/// 这张图是否真的用到了透明。
///
/// 不能只看色彩类型：`Rgba8` 的图片哪怕每个像素都是不透明的（截图、设计稿导出很常见），
/// `has_alpha()` 也是 true，那样就会一路走 PNG，体积压不下来 —— 而压体积正是这个函数的全部意义。
fn has_transparency(image: &image::DynamicImage) -> bool {
    if !image.color().has_alpha() {
        return false;
    }
    image.to_rgba8().pixels().any(|pixel| pixel.0[3] < 255)
}

/// 只读文件头核一遍「这确实是一张能解码的图」，不做整图解码
/// （实测 9 百万像素的 JPEG 也就 1ms 上下）。
///
/// 背景图授权给 asset 协议之前用它把关：webview 那边解码失败是静默的（画不出来而已，
/// 控制台都没有），用户会以为自己选的图没问题，所以「读不出来」必须在选图那一刻就报出来。
pub fn check_decodable(path: &str) -> Result<(), String> {
    image::image_dimensions(path)
        .map(|_| ())
        .map_err(|err| format!("读取图片失败：{err}"))
}

/// 压到最长边不超过 `max_edge`，编码成 data URL
pub fn data_url(path: &str, max_edge: u32, quality: u8) -> Result<String, String> {
    let source = image::open(Path::new(path)).map_err(|err| format!("读取图片失败：{err}"))?;

    let scaled = if source.width() > max_edge || source.height() > max_edge {
        source.thumbnail(max_edge, max_edge)
    } else {
        source
    };

    let mut bytes: Vec<u8> = Vec::new();
    let has_alpha = has_transparency(&scaled);

    if has_alpha {
        scaled
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .map_err(|err| format!("编码 PNG 失败：{err}"))?;
    } else {
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
        encoder
            .encode_image(&scaled)
            .map_err(|err| format!("编码 JPEG 失败：{err}"))?;
    }

    let mime = if has_alpha { "image/png" } else { "image/jpeg" };
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张纯色 PNG 当素材，省得测试依赖仓库里的壁纸
    fn write_fixture(path: &Path, width: u32, height: u32, transparent: bool) {
        if transparent {
            let mut image = image::RgbaImage::new(width, height);
            for pixel in image.pixels_mut() {
                *pixel = image::Rgba([200, 30, 40, 0]);
            }
            image.save(path).expect("写测试图片失败");
        } else {
            let mut image = image::RgbImage::new(width, height);
            for pixel in image.pixels_mut() {
                *pixel = image::Rgb([200, 30, 40]);
            }
            image.save(path).expect("写测试图片失败");
        }
    }

    #[test]
    fn scales_down_to_the_max_edge() {
        let dir = std::env::temp_dir().join("wb-imaging-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("wide.png");
        write_fixture(&file, 400, 200, false);

        let url = data_url(&file.to_string_lossy(), 100, 80).expect("应当能编码");
        assert!(url.starts_with("data:image/jpeg;base64,"));

        // 解回来量一下：最长边不该超过 100，且保持长宽比
        let encoded = url.trim_start_matches("data:image/jpeg;base64,");
        let bytes = decode_base64(encoded);
        let decoded = image::load_from_memory(&bytes).expect("应当能解回图片");
        assert!(decoded.width() <= 100 && decoded.height() <= 100);
        assert_eq!(decoded.width(), 100);
        assert_eq!(decoded.height(), 50);

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn keeps_png_for_images_with_alpha() {
        let dir = std::env::temp_dir().join("wb-imaging-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("alpha.png");
        write_fixture(&file, 20, 20, true);

        let url = data_url(&file.to_string_lossy(), 100, 80).expect("应当能编码");
        // 透明通道必须保住：转成 JPEG 会变成黑块
        assert!(url.starts_with("data:image/png;base64,"), "实际是 {url:.40}");

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn missing_file_is_an_error_with_a_reason() {
        let err = data_url("C:/definitely/not/here.png", 100, 80).unwrap_err();
        assert!(err.contains("读取图片失败"), "实际是 {err}");
    }

    /// 测试用的最简 base64 解码（只处理标准字母表与填充）
    fn decode_base64(input: &str) -> Vec<u8> {
        const TABLE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buffer: u32 = 0;
        let mut bits = 0;

        for ch in input.chars().filter(|ch| *ch != '=') {
            let Some(value) = TABLE.find(ch) else { continue };
            buffer = (buffer << 6) | value as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push(((buffer >> bits) & 0xff) as u8);
            }
        }
        out
    }
}
