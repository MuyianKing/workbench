//! 视频：用户自己挑的一个文件夹里的 MP4 文件。
//!
//! 与笔记（notes.rs）同一套分工：这一层只做文件系统那点事（递归扫目录、
//! 放行一个要播放的文件），树怎么组、速率怎么算那些口径由 `src/shared/video.ts`
//! 的纯函数决定 —— 那边有单测，改一版显示口径也不必重编 Rust。
//!
//! 扫描**只读**：视频目录是用户的收藏，应用不在里面创建、改名或删除任何东西。
//!
//! 播放走 asset 协议：webview 按文件自己读（协议自带 HTTP Range，拖进度条
//! 不用把整份文件下完），所以这一层还负责「放行前核一遍它确实是 MP4」——
//! webview 解码失败是静默的（黑屏、控制台也不响），坏文件必须在这里就报出来。

use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 只认这一种后缀：别的容器（mkv / avi / flv…）webview 里的解码器不一定有，先不收
const VIDEO_EXTENSION: &str = ".mp4";

/// 递归的深度上限。与笔记同一个数：正常视频库用不到，拦住的是「有人把盘根选成了视频目录」
const MAX_DEPTH: usize = 12;

fn is_video_file(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(VIDEO_EXTENSION)
}

/// 视频根本身。目录不在（被移走 / 被删掉 / 网络盘没连上）时给一句能看懂的话
fn root_path(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("还没有选择视频文件夹".into());
    }
    let base = PathBuf::from(trimmed);
    if !base.is_dir() {
        return Err(format!("找不到视频文件夹：{trimmed}"));
    }
    Ok(base)
}

/// 绝对路径 → 相对视频根的路径，统一用 `/` 分隔（渲染层只认这一种写法）
fn rel_of(root: &PathBuf, path: &PathBuf) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 列目录：一层层往下走，只回文件夹与 MP4 文件。
///
/// 回来的是**平铺的清单**（每项带自己的相对路径；视频带时长），不是嵌套结构 ——
/// 树由渲染层组，这样「文件夹排在视频前面、同层按名字排」这类口径改起来只动 TS。
/// 点开头的目录、依赖 / 构建产物的目录与笔记用同一份跳过名单（notes.rs 的
/// `is_skipped_entry`）——「哪些目录是噪音」只该有一份口径。
pub fn scan(root: &str) -> Result<Vec<Value>, String> {
    let base = root_path(root)?;
    let mut out = Vec::new();

    let entries = WalkDir::new(&base)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !crate::notes::is_skipped_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        });

    for entry in entries {
        // 权限不够 / 刚被删掉都是常态：跳过它，别让整棵树读不出来
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().is_dir();
        if !is_dir && !is_video_file(&name) {
            continue;
        }

        // 树上关心的是时长不是体积：每个 MP4 解一遍容器拿秒数（读不出来按 0，树上留空）
        let duration = if is_dir {
            0
        } else {
            mp4_duration_seconds(&entry.path())
        };

        out.push(json!({
            "rel": rel_of(&base, &entry.path().to_path_buf()),
            "name": name,
            "isDir": is_dir,
            "duration": duration,
        }));
    }

    Ok(out)
}

/// 一个盒子的头（ISO BMFF 的基本单位）：类型，与载荷的绝对起点和长度。
/// `size == 1` 的 64 位大盒子（真长度在随后的 largesize 里）与
/// `size == 0` 的「直到边界为止」都收进 `payload_len`。
struct BoxHead {
    kind: [u8; 4],
    payload_start: u64,
    payload_len: u64,
}

/// 读一个盒子头（调用方先把 reader 定位在盒子起点；`limit` 是这段数据自己的边界）
fn read_box_header(file: &mut std::fs::File, limit: u64) -> Option<BoxHead> {
    let head_pos = file.stream_position().ok()?;
    let mut buf = [0u8; 8];
    file.read_exact(&mut buf).ok()?;
    let kind: [u8; 4] = buf[4..8].try_into().ok()?;

    let (payload_start, payload_len) = match u32::from_be_bytes(buf[..4].try_into().ok()?) as u64 {
        1 => {
            let mut large = [0u8; 8];
            file.read_exact(&mut large).ok()?;
            (head_pos + 16, u64::from_be_bytes(large).checked_sub(16)?)
        }
        0 => (head_pos + 8, limit.checked_sub(head_pos + 8)?),
        size => (head_pos + 8, size.checked_sub(8)?),
    };
    Some(BoxHead {
        kind,
        payload_start,
        payload_len,
    })
}

/// MP4 文件的时长（秒，四舍五入到整数）：顶层盒子逐个走，找到 `moov` 里的
/// `mvhd`，时长 = duration / timescale。
///
/// 只走盒子头、不读大块内容 —— `mdat` 整个 seek 过去，一个文件通常就是几次小读，
/// `moov` 在文件尾（没做 faststart 的下载片）也一样够得着，扫一库视频花不了多少 IO。
/// 读不出来（截断的文件、分片 MP4 的时长不在这里）返回 0：树上那一格留空，不挡播放。
fn mp4_duration_seconds(path: &Path) -> u64 {
    let Ok(mut file) = std::fs::File::open(path) else {
        return 0;
    };
    let Ok(file_len) = file.metadata().map(|meta| meta.len()) else {
        return 0;
    };

    let mut pos = 0u64;
    while pos + 8 <= file_len {
        if file.seek(SeekFrom::Start(pos)).is_err() {
            return 0;
        }
        let Some(head) = read_box_header(&mut file, file_len) else {
            return 0;
        };
        if head.kind == *b"moov" {
            return mvhd_duration(&mut file, &head).unwrap_or(0);
        }
        // 盒子必须往前走：长度坏掉（越界 / 原地打转）的数据直接放弃，别死循环
        match head.payload_start.checked_add(head.payload_len) {
            Some(next) if next > pos => pos = next,
            _ => return 0,
        }
    }
    0
}

/// 在 `moov` 的载荷里找 `mvhd`，读出 duration / timescale。
///
/// `mvhd` 载荷开头 4 字节是 version + flags；v0 的 timescale / duration 是两个 u32
/// （各跳过 creation / modification 的 u32），v1 对应两个 u64。
fn mvhd_duration(file: &mut std::fs::File, moov: &BoxHead) -> Option<u64> {
    let end = moov.payload_start + moov.payload_len;
    let mut pos = moov.payload_start;

    while pos + 8 <= end {
        file.seek(SeekFrom::Start(pos)).ok()?;
        let head = read_box_header(file, end)?;
        if head.kind == *b"mvhd" {
            file.seek(SeekFrom::Start(head.payload_start)).ok()?;
            let mut head4 = [0u8; 4];
            file.read_exact(&mut head4).ok()?;

            if head4[0] == 1 {
                let mut fixed = [0u8; 20];
                file.read_exact(&mut fixed).ok()?;
                let timescale = u32::from_be_bytes(fixed[16..20].try_into().ok()?);
                let mut dur = [0u8; 8];
                file.read_exact(&mut dur).ok()?;
                return duration_seconds(u64::from_be_bytes(dur), timescale);
            }

            let mut fixed = [0u8; 16];
            file.read_exact(&mut fixed).ok()?;
            let timescale = u32::from_be_bytes(fixed[8..12].try_into().ok()?);
            let duration = u32::from_be_bytes(fixed[12..16].try_into().ok()?);
            return duration_seconds(u64::from(duration), timescale);
        }
        match head.payload_start.checked_add(head.payload_len) {
            Some(next) if next > pos => pos = next,
            _ => return None,
        }
    }
    None
}

/// duration / timescale → 秒（四舍五入）；timescale 是 0 的坏数据按读不出算
fn duration_seconds(duration: u64, timescale: u32) -> Option<u64> {
    if timescale == 0 {
        return None;
    }
    Some((duration as f64 / f64::from(timescale)).round() as u64)
}

/// 核一个文件确实是能交给 webview 的 MP4，核过了才放行 asset 协议。
///
/// 两道检查都不贵：
///   - 后缀是 `.mp4`（树里点出来的视频理应满足，这里是兜底 —— 命令是可以被直接调的）；
///   - 文件头第 4..8 字节是 `ftyp`（ISO BMFF / MP4 规定文件以它开头）。
///     拿后缀骗过第一道的文件（改名、下载到一半的）在这里现出原形，
///     而不是让用户对着一个永远转圈的黑屏猜哪里坏了。
pub fn allow(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("还没有选择要播放的视频".into());
    }

    let target = PathBuf::from(trimmed);
    if !target.is_file() {
        return Err(format!("找不到这个视频：{trimmed}"));
    }
    if !is_video_file(
        &target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ) {
        return Err("只支持 MP4 格式的视频".into());
    }

    let mut head = [0u8; 12];
    let mut file = std::fs::File::open(&target).map_err(|err| format!("读取视频失败：{err}"))?;
    file.read_exact(&mut head)
        .map_err(|err| format!("读取视频失败：{err}"))?;

    if &head[4..8] != b"ftyp" {
        return Err("这不是一个有效的 MP4 文件（文件头不对），可能没有下载完整".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 拼一个盒子：4 字节长度（含头）+ 类型 + 载荷
    fn box_of(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() as u32 + 8).to_be_bytes()).to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    /// 一个只够解析出时长的最小 MP4：ftyp + mdat + moov(mvhd v0)
    fn minimal_mp4(timescale: u32, duration: u32) -> Vec<u8> {
        let mut mvhd = vec![0u8; 4]; // version 0 + flags
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // creation_time
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // modification_time
        mvhd.extend_from_slice(&timescale.to_be_bytes());
        mvhd.extend_from_slice(&duration.to_be_bytes());

        let mut mp4 = box_of(b"ftyp", b"isom....");
        // mdat 垫在中间：moov 在文件尾（没做 faststart）时也得找得到
        mp4.extend_from_slice(&box_of(b"mdat", &[0u8; 64]));
        mp4.extend_from_slice(&box_of(b"moov", &box_of(b"mvhd", &mvhd)));
        mp4
    }

    #[test]
    fn scan_只收文件夹与mp4() {
        let base = std::env::temp_dir().join(format!("wb-video-scan-{}", std::process::id()));
        let nested = base.join("第一季");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("第1集.mp4"), minimal_mp4(1000, 95_000)).unwrap();
        fs::write(nested.join("第1集.ass"), b"dialog").unwrap();
        fs::write(base.join("封面.jpg"), b"jpg").unwrap();
        fs::create_dir_all(base.join(".hidden")).unwrap();

        let result = scan(base.to_str().unwrap()).unwrap();
        let rels: Vec<&str> = result
            .iter()
            .filter_map(|item| item["rel"].as_str())
            .collect();

        assert_eq!(rels, ["第一季", "第一季/第1集.mp4"]);
        assert_eq!(result[0]["isDir"], json!(true));
        assert_eq!(result[1]["isDir"], json!(false));
        // 时长从 mvhd 解出来（95000 / 1000 = 95 秒），文件夹没有这项
        assert_eq!(result[1]["duration"], json!(95));

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn scan_读不出时长的按0() {
        let base = std::env::temp_dir().join(format!("wb-video-junk-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();

        // 顶着 MP4 后缀但不是 MP4 的文件（只有文件头那几个字节）：时长按 0，不挡它进树
        fs::write(base.join("假货.mp4"), b"ftyp-ignored-here").unwrap();
        // timescale 是 0 的坏数据同样按 0
        fs::write(base.join("坏数据.mp4"), minimal_mp4(0, 95_000)).unwrap();

        let result = scan(base.to_str().unwrap()).unwrap();
        assert_eq!(result[0]["duration"], json!(0));
        assert_eq!(result[1]["duration"], json!(0));

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn scan_目录不存在时报得能看懂() {
        let err = scan("Z:\\不存在的视频目录").unwrap_err();
        assert!(err.contains("找不到视频文件夹"));
    }

    #[test]
    fn allow_后缀与文件头两道都要过() {
        let base = std::env::temp_dir().join(format!("wb-video-allow-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();

        // 真 MP4：12 字节头，第 4..8 是 ftyp
        let mut mp4: Vec<u8> = vec![0, 0, 0, 0];
        mp4.extend_from_slice(b"ftyp");
        mp4.extend_from_slice(b"isom....");
        let good = base.join("good.mp4");
        fs::write(&good, &mp4).unwrap();
        assert!(allow(good.to_str().unwrap()).is_ok());

        // 改了后缀的假货：文件头不是 ftyp
        let fake = base.join("fake.mp4");
        fs::write(&fake, b"RIFF....WEBPVP8 ").unwrap();
        let err = allow(fake.to_str().unwrap()).unwrap_err();
        assert!(err.contains("文件头不对"));

        // 后缀不对的直接拦
        let other = base.join("movie.mkv");
        fs::write(&other, &mp4).unwrap();
        assert!(allow(other.to_str().unwrap()).unwrap_err().contains("MP4"));

        // 不存在的路径
        assert!(allow(base.join("无.mp4").to_str().unwrap()).is_err());
        assert!(allow("").is_err());

        fs::remove_dir_all(&base).ok();
    }
}
