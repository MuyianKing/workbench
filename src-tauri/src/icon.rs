//! 程序图标抽取（纯 Win32，不依赖 PowerShell）。
//!
//! 用到的 API 与选型理由：
//!  - `PrivateExtractIconsW` 按指定边长直取，而不是 `ExtractIconExW`：后者只能拿系统
//!    固有的两个尺寸（16/32），程序资源里没有大图时会退回默认图标 —— 而界面上要的是 48px。
//!  - `SHGetFileInfoW` 在这里只用来「问路」，不直接拿图，两种问法对应两条路：
//!    `SHGFI_ICONLOCATION` 问「图标在哪个文件的第几条」—— 只对图标在**别的文件**里的东西有效
//!    （文件夹、自己指定了图标文件的快捷方式），图标就在自己资源里的 exe 问不出东西；
//!    `SHGFI_ICON` 是最后的兜底（32px），连 shell 都只能画通用图时用它顶着。
//!  - 快捷方式（.lnk）自己没有图标资源，对它直取必然落空，所以按它自带的 IDList 解出目标
//!    （`SHGetPathFromIDListW`）再回到上面那条路 —— 那一段 IDList 原样交给 shell 解释，
//!    不重写一遍 .lnk 的文件格式。
//!  - `GetIconInfo` → `GetDIBits` 把 HICON 摊成 32 位 BGRA，再交给 `image` 编成 PNG。
//!
//! 这里有一段 unsafe。HICON / HBITMAP / HDC 都是要手动释放的句柄，漏一个就是 GDI 句柄泄漏
//! （应用长跑会把进程的 GDI 配额耗光，界面开始画不出来），所以每一步都成对 delete，
//! 并且把释放放在闭包外，保证中途出错也照常回收。

use std::ffi::OsStr;
use std::io::Cursor;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW,
    ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, HBITMAP, HDC, HGDIOBJ,
};
use windows_sys::Win32::UI::Shell::Common::ITEMIDLIST;
use windows_sys::Win32::UI::Shell::{
    SHGetFileInfoW, SHGetPathFromIDListW, SHFILEINFOW, SHGFI_ICON, SHGFI_ICONLOCATION,
    SHGFI_LARGEICON,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetIconInfo, HICON, ICONINFO, PrivateExtractIconsW,
};

/// 界面上要显示的边长。48 是"看得清楚又不必放大到糊"的尺寸。
const EXTRACT_SIZE: i32 = 48;

/// 32 位 BGRA 每像素的字节数
const BYTES_PER_PIXEL: usize = 4;

/// 快捷方式固定头的长度，以及它的类 ID {00021401-0000-0000-C000-000000000046}
const LNK_HEADER_SIZE: u32 = 76;
const LNK_CLSID: [u8; 16] = [
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];

/// LinkFlags 里的 HasLinkTargetIDList：绝大多数快捷方式都带，没带就只能交给 shell 兜底
const LNK_HAS_IDLIST: u32 = 0x0000_0001;

fn wide(path: &str) -> Vec<u16> {
    OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 从目标路径抽一张 PNG，包成 data URL。失败时带出原因。
///
/// 分四步走，前一步成不了才走下一步：
///  1. 从文件自己的图标资源里按 48px 直取 —— .exe / .dll 一步到位；
///  2. 图标在别的文件里时（文件夹、自己指定了图标文件的快捷方式），shell 问得出「哪个文件的第几条」，
///     拿回来仍旧按 48px 直取；
///  3. 快捷方式：.lnk 自己没有图标资源，图标在它指向的程序里，先解出目标再回到第 1 步；
///  4. 都不行就认下 shell 画的那张（32px，快捷方式那张还带着小箭头）——
///     快捷方式指向的东西已经不在、目标是 UWP 这类 shell 命名空间时只有它出得来。
pub fn extract(source: &str) -> Result<String, String> {
    if let Some(icon) = resource_icon(source, 0) {
        return encode_icon(icon);
    }

    if let Some((file, index)) = shell_icon_location(source) {
        if let Some(icon) = resource_icon(&file, index) {
            return encode_icon(icon);
        }
    }

    if let Some(target) = shortcut_target(source) {
        if let Some(icon) = resource_icon(&target, 0) {
            return encode_icon(icon);
        }
    }

    match shell_icon(source) {
        Some(icon) => encode_icon(icon),
        None => Err("这个文件里没有可用的图标资源".to_string()),
    }
}

/// 快捷方式指向的目标路径。
///
/// .lnk 里存的是目标在 shell 目录树里的位置（IDList），所以这里不重写一遍那个文件格式：
/// 只把 IDList 原样抠出来，交给 [`SHGetPathFromIDListW`] 自己解释 —— 盘符、
/// 超长路径、非 ASCII 字符都归它管，比自己拼 LinkInfo 里那段 ANSI 路径稳。
/// 老式快捷方式（没有 IDList）、指向 shell 命名空间的（UWP 应用）解不出来，返回 `None`。
fn shortcut_target(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;

    // 认文件头而不是认扩展名：扩展名可以随便改，这段头是快捷方式独有的
    if bytes.len() < 78
        || u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != LNK_HEADER_SIZE
        || bytes[4..20] != LNK_CLSID
    {
        return None;
    }

    let flags = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if flags & LNK_HAS_IDLIST == 0 {
        return None;
    }

    // IDList 紧跟在固定头后面，前面有 2 字节的长度
    let size = u16::from_le_bytes([bytes[76], bytes[77]]) as usize;
    let end = 78 + size;
    if size == 0 || end > bytes.len() {
        return None;
    }

    // 抄进 u16 缓冲再交给 shell：IDList 是 2 字节对齐的结构，直接拿 &[u8] 转指针不保证对齐。
    // 末尾补一个终止项 —— IDList 自己带，多补一个不碍事
    let idlist: Vec<u16> = bytes[78..end]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .chain(std::iter::once(0))
        .collect();

    let mut buffer = [0u16; MAX_PATH as usize];
    let found = unsafe {
        SHGetPathFromIDListW(idlist.as_ptr() as *const ITEMIDLIST, buffer.as_mut_ptr())
    };
    if found == 0 {
        return None;
    }

    let terminator = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    let target = String::from_utf16_lossy(&buffer[..terminator]);

    if target.trim().is_empty() {
        None
    } else {
        Some(target)
    }
}

/// 从文件自己的图标资源里取一张 HICON，没有图标资源（或路径不存在）时返回 `None`。
///
/// `index` 传负数是按资源 ID 取：快捷方式里把图标写成 `shell32.dll,-101` 这种就靠它。
/// 拿到的句柄交给调用方，回收在 [`encode_icon`] 里成对做。
fn resource_icon(source: &str, index: i32) -> Option<HICON> {
    let file = wide(source);
    let mut icons: [HICON; 1] = [std::ptr::null_mut()];
    let mut ids: [u32; 1] = [0];

    // 返回取到的图标个数；0 表示这个文件里没有图标资源（或路径不存在）
    let count = unsafe {
        PrivateExtractIconsW(
            file.as_ptr(),
            index,
            EXTRACT_SIZE,
            EXTRACT_SIZE,
            icons.as_mut_ptr(),
            ids.as_mut_ptr(),
            1,
            0,
        )
    };

    if count == 0 || icons[0].is_null() {
        None
    } else {
        Some(icons[0])
    }
}

/// 问 shell：这个文件显示哪张图标，图标在哪个文件的第几条。
///
/// 关键在于 shell 会**解析快捷方式** —— .lnk 自己没有图标资源（所以直取必然落空），
/// 而这一步拿到的要么是它指向的程序，要么是快捷方式里自定的图标位置。
/// 路径不存在、这类文件没有图标位置时返回 `None`。
fn shell_icon_location(source: &str) -> Option<(String, i32)> {
    let mut info = SHFILEINFOW::default();
    let file = wide(source);

    let found = unsafe {
        SHGetFileInfoW(
            file.as_ptr(),
            0,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICONLOCATION,
        )
    };
    if found == 0 {
        return None;
    }

    // szDisplayName 是定长缓冲，读到第一个 '\0' 为止
    let end = info
        .szDisplayName
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(info.szDisplayName.len());
    let location = String::from_utf16_lossy(&info.szDisplayName[..end]);
    if location.trim().is_empty() {
        return None;
    }

    Some((location, info.iIcon))
}

/// 直接问 shell 要一张 HICON，调用方负责 `DestroyIcon`。
///
/// `SHGFI_LARGEICON` 给的是系统的大图标（32px），比 [`EXTRACT_SIZE`] 小一档；
/// 换来的是「shell 画得出来的东西都取得到」，包括 UWP 应用和图标已经丢了的快捷方式。
fn shell_icon(source: &str) -> Option<HICON> {
    let mut info = SHFILEINFOW::default();
    let file = wide(source);

    let found = unsafe {
        SHGetFileInfoW(
            file.as_ptr(),
            0,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };

    if found == 0 || info.hIcon.is_null() {
        None
    } else {
        Some(info.hIcon)
    }
}

/// HICON → PNG data URL，顺带把这枚句柄还回去。
fn encode_icon(icon: HICON) -> Result<String, String> {
    let pixels = unsafe { icon_to_rgba(icon) };
    // 无论取像素成功与否，图标句柄都要还回去
    unsafe { DestroyIcon(icon) };

    let (width, height, rgba) = pixels?;
    let image = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "图标像素数据不完整".to_string())?;

    let mut bytes: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|err| format!("编码 PNG 失败：{err}"))?;

    Ok(format!(
        "data:image/png;base64,{}",
        crate::encoding::base64(&bytes)
    ))
}

/// HICON → (宽, 高, RGBA 字节)。调用方负责 `DestroyIcon`。
unsafe fn icon_to_rgba(hicon: HICON) -> Result<(u32, u32, Vec<u8>), String> {
    let mut info: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut info) == 0 {
        return Err("读取图标信息失败".to_string());
    }

    let (color, mask) = (info.hbmColor, info.hbmMask);

    // 中途任何一步失败都要把这两个位图还回去，所以真正的活放在闭包里
    let result = read_pixels(color, mask);

    if !color.is_null() {
        DeleteObject(color as HGDIOBJ);
    }
    if !mask.is_null() {
        DeleteObject(mask as HGDIOBJ);
    }

    result
}

fn read_pixels(color: HBITMAP, mask: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    if color.is_null() {
        return Err("图标没有颜色位图".to_string());
    }

    let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
    let loaded = unsafe {
        GetObjectW(
            color as HGDIOBJ,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bitmap as *mut BITMAP as *mut core::ffi::c_void,
        )
    };
    if loaded == 0 {
        return Err("读取位图尺寸失败".to_string());
    }

    let width = bitmap.bmWidth as u32;
    let height = bitmap.bmHeight as u32;
    if width == 0 || height == 0 {
        return Err("图标尺寸为 0".to_string());
    }

    let screen = unsafe { GetDC(std::ptr::null_mut()) };
    let dc = unsafe { CreateCompatibleDC(screen) };

    let outcome = (|| -> Result<Vec<u8>, String> {
        let mut buffer = vec![0u8; width as usize * height as usize * BYTES_PER_PIXEL];

        // 负高度 = 自上而下，省得自己翻转行序
        let mut header = header_for(width, -(height as i32), 32);
        let lines = unsafe {
            GetDIBits(
                dc,
                color,
                0,
                height,
                buffer.as_mut_ptr() as *mut core::ffi::c_void,
                &mut header,
                DIB_RGB_COLORS,
            )
        };
        if lines == 0 {
            return Err("读取图标像素失败".to_string());
        }

        // 老图标（24 位色 + AND 掩码）没有 alpha 通道，摊出来的 alpha 全是 0。
        // 不处理的话整张图会被当成全透明，铺在界面上就是一块黑底。
        if buffer.chunks_exact(BYTES_PER_PIXEL).all(|px| px[3] == 0) {
            apply_mask(dc, mask, width, height, &mut buffer)?;
        }

        // BGRA → RGBA，就地对调首尾两字节
        for px in buffer.chunks_exact_mut(BYTES_PER_PIXEL) {
            px.swap(0, 2);
        }
        Ok(buffer)
    })();

    unsafe {
        DeleteDC(dc);
        ReleaseDC(std::ptr::null_mut(), screen);
    }

    outcome.map(|buffer| (width, height, buffer))
}

/// 用 AND 掩码补出 alpha：掩码里 1 表示透明，0 表示不透明。
///
/// 掩码是 1 位深，按 32 位摊开后每位变成 0x00 或 0xFF，
/// 所以看蓝色分量是不是 0xFF 就知道该点是透明还是不透明。
fn apply_mask(
    dc: HDC,
    mask: HBITMAP,
    width: u32,
    height: u32,
    buffer: &mut [u8],
) -> Result<(), String> {
    if mask.is_null() {
        // 没有掩码又完全没有 alpha：只能当作不透明，总比整张消失强
        for px in buffer.chunks_exact_mut(BYTES_PER_PIXEL) {
            px[3] = 255;
        }
        return Ok(());
    }

    let mut mask_buffer = vec![0u8; width as usize * height as usize * BYTES_PER_PIXEL];
    let mut header = header_for(width, -(height as i32), 32);
    let lines = unsafe {
        GetDIBits(
            dc,
            mask,
            0,
            height,
            mask_buffer.as_mut_ptr() as *mut core::ffi::c_void,
            &mut header,
            DIB_RGB_COLORS,
        )
    };
    if lines == 0 {
        return Err("读取图标掩码失败".to_string());
    }

    for (px, mask_px) in buffer
        .chunks_exact_mut(BYTES_PER_PIXEL)
        .zip(mask_buffer.chunks_exact(BYTES_PER_PIXEL))
    {
        px[3] = if mask_px[0] == 0xFF { 0 } else { 255 };
    }
    Ok(())
}

fn header_for(width: u32, height: i32, bits: u16) -> BITMAPINFO {
    let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
    header.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width as i32,
        biHeight: height,
        biPlanes: 1,
        biBitCount: bits,
        biCompression: 0, // BI_RGB
        ..unsafe { std::mem::zeroed() }
    };
    header
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真抽一次：用系统里的 notepad.exe（每台 Windows 都有图标资源）。
    /// 断言的是"出了一张带 PNG 头的 data URL"，不比对像素内容 —— 图标随系统版本会变。
    #[test]
    fn extracts_a_real_icon() {
        let url = extract("C:\\Windows\\System32\\notepad.exe").expect("notepad 应当能抽出图标");
        assert!(url.starts_with("data:image/png;base64,"), "实际是 {}…", &url[..40.min(url.len())]);
    }

    /// 抽出来的确实是一张能解码的方形 PNG，且边长就是我们要求的 48
    #[test]
    fn extracted_icon_is_decodable_and_sized() {
        let url = extract("C:\\Windows\\System32\\notepad.exe").expect("应当能抽出图标");
        let encoded = url.trim_start_matches("data:image/png;base64,");
        let bytes = crate::encoding::base64_decode(encoded).expect("base64 应当可解");
        let image = image::load_from_memory(&bytes).expect("应当能解回图片");

        assert_eq!(image.width(), EXTRACT_SIZE as u32);
        assert_eq!(image.height(), EXTRACT_SIZE as u32);
    }

    /// 没有图标资源 / 路径不存在时给出可读原因，而不是 panic
    #[test]
    fn missing_file_is_an_error_with_a_reason() {
        let err = extract("C:\\definitely\\not\\here.exe").unwrap_err();
        assert!(err.contains("没有可用的图标资源"), "实际是 {err}");
    }

    /// 自己不带图标资源的文件交给 shell 兜底：以前这里直接失败（界面上只剩首字母），
    /// 现在能拿到 shell 画的「文本文件」那张通用图标
    #[test]
    fn file_without_icon_resource_falls_back_to_the_shell() {
        let url =
            extract("C:\\Windows\\System32\\drivers\\etc\\hosts").expect("应当由 shell 兜底出一张图");
        assert!(
            url.starts_with("data:image/png;base64,"),
            "实际是 {}…",
            &url[..40.min(url.len())]
        );
    }

    /// 「问路」那一步的语义：图标在**别的文件**里时才问得出来（文件夹是典型，图标在 imageres.dll），
    /// 图标就在自己资源里的 exe 返回空 —— 那种走第 1 步。快捷方式也不会在这一步被解析，
    /// 它的图标在目标程序里，由 shortcut_target 负责。
    #[test]
    fn shell_only_reports_icon_locations_that_live_in_another_file() {
        let (file, _index) =
            shell_icon_location("C:\\Windows\\System32").expect("文件夹应当问得到图标位置");
        assert!(std::path::Path::new(&file).is_file(), "图标位置应当存在：{file}");

        assert!(
            shell_icon_location("C:\\Windows\\System32\\notepad.exe").is_none(),
            "图标就在自己资源里的 exe 不该报出图标位置"
        );
    }

    /// 快捷方式：.lnk 自己没有图标资源，图标在它指向的程序里，得先把目标解出来
    /// —— 也就是「添加常用软件时快捷方式认不出图标」那个问题。
    ///
    /// 目标已经被卸载的快捷方式解不出可用的图标（退回 shell 兜底那张带着小箭头的 32px），
    /// 所以这里挑一个目标还在的当样本。
    #[test]
    fn shortcut_icon_comes_from_the_program_it_points_to() {
        let Some(link) = shortcut_candidates().into_iter().find(|link| {
            shortcut_target(link).is_some_and(|target| std::path::Path::new(&target).is_file())
        }) else {
            // 一个「目标还在」的快捷方式都没有的机器不会出现（正常安装总有开始菜单项），真遇到就跳过
            return;
        };

        let target = shortcut_target(&link).expect("上面刚判定过");
        assert!(
            std::path::Path::new(&target).is_file(),
            "{link} 的目标应当存在：{target}"
        );

        let url = extract(&link).unwrap_or_else(|err| panic!("{link} 应当取得到图标：{err}"));
        let encoded = url.trim_start_matches("data:image/png;base64,");
        let bytes = crate::encoding::base64_decode(encoded).expect("base64 应当可解");
        let icon = image::load_from_memory(&bytes).expect("应当能解回图片");

        // 目标程序自己有 48px 图标资源时，快捷方式必须拿到同一张；
        // 掉到 32px 就说明这一张还是 shell 兜底的通用图（上面带着小箭头）
        if icon_size(&target) == EXTRACT_SIZE as u32 {
            assert_eq!(
                icon.width(),
                EXTRACT_SIZE as u32,
                "{link} 应当取到目标程序自己的图标"
            );
        }
    }

    /// 不是快捷方式的东西不该被当快捷方式解析（认文件头，认不出就退）
    #[test]
    fn plain_executable_is_not_mistaken_for_a_shortcut() {
        assert!(shortcut_target("C:\\Windows\\System32\\notepad.exe").is_none());
    }

    /// 某个路径抽出来的图标边长；抽不出来算 0
    fn icon_size(path: &str) -> u32 {
        let Ok(url) = extract(path) else {
            return 0;
        };
        let encoded = url.trim_start_matches("data:image/png;base64,");
        let Some(bytes) = crate::encoding::base64_decode(encoded) else {
            return 0;
        };
        image::load_from_memory(&bytes)
            .map(|icon| icon.width())
            .unwrap_or(0)
    }

    /// 收集一批 .lnk 当样本：开始菜单和公共桌面上的快捷方式，任何一台 Windows 都有几个
    fn shortcut_candidates() -> Vec<String> {
        let mut roots: Vec<String> = Vec::new();
        for key in ["ProgramData", "APPDATA"] {
            if let Ok(base) = std::env::var(key) {
                roots.push(format!("{base}\\Microsoft\\Windows\\Start Menu\\Programs"));
            }
        }
        roots.push("C:\\Users\\Public\\Desktop".to_string());

        let mut found: Vec<String> = Vec::new();
        for root in &roots {
            collect_shortcuts(root, 0, &mut found);
        }
        found
    }

    fn collect_shortcuts(dir: &str, depth: usize, out: &mut Vec<String>) {
        // 开始菜单下面最多就是「厂商 > 程序」两层，再深不必翻；样本够用就收手
        if depth > 3 || out.len() >= 50 {
            return;
        }

        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                subdirs.push(path);
            } else if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
            {
                out.push(path.display().to_string());
            }
        }

        for subdir in subdirs {
            collect_shortcuts(&subdir.display().to_string(), depth + 1, out);
        }
    }
}
