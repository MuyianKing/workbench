//! Pi 的技能（AI 助手页那颗「技能」按钮弹出来的那份管理）：列、装、卸。
//!
//! 技能根有两处（口径在 shared/pi-skills.ts）：**全局** `%USERPROFILE%\.agents\skills`、
//! **项目** `<工作目录>\.agents\skills`。一个技能 = 根下一个带 `SKILL.md` 的子目录 ——
//! 与 skills.rs 的技能库是同一份约定，区别只有两点：这里的根是**任意目录**（可能还不存在），
//! 而且没有「在哪个仓库里」这回事（AI 的技能不记版本）。
//!
//! 装进来的东西从哪来：用户挑的 zip、用户挑的文件夹（文件夹那条走 skills.rs 的 import_skill）、
//! 用户粘的一个地址（GET 一次，跟随跳转 —— 技能市场给的常是 302 → 对象存储直链）。
//! **zip 里的脚本一律只落盘、不执行**：这个应用不跑技能，跑不跑是 Pi 自己的事（受权限档管）。
//!
//! 解包是这里手写的：zip 的中央目录 + deflate，压缩交给 flate2（已经在编译图里，
//! 见 Cargo.toml）。不支持 zip64、加密包与非 deflate/stored 的压缩方式 —— 遇到就说清楚。
//!
//! **路径安全**：条目名逐段过 `sync::is_plain_segment`（挡 `..` / 分隔符 / 盘符 / 通配字符），
//! 符号链接条目直接跳过，解压先落 `<根>/.tmp-…` 再整棵改名过去 —— 半路失败不会留下半个技能。

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use flate2::read::DeflateDecoder;
use flate2::Crc;
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::sync::is_plain_segment;

/// 技能根下一个技能的清单文件；没有它的目录不是技能（与 skills.rs 同一条约定）
pub const SKILL_MD: &str = "SKILL.md";

/// 一次安装的阀门。技能包都不是大东西（最大的那种带一份前端库也就几 MB），
/// 这几个数拦住的是「地址拿错、下回来一个安装包」那种情况，不是性能参数。
const MAX_ZIP: u64 = 64 << 20;
const MAX_TOTAL: u64 = 256 << 20;
const MAX_ENTRIES: usize = 4000;
const MAX_DOWNLOAD: usize = 64 << 20;

/// 粘地址安装时跟随跳转的跳数上限（技能市场那条链是「302 → 对象存储直链」，一跳就够）
const MAX_HOPS: usize = 5;

// ---------- 技能根 ----------

/// 全局技能根：`%USERPROFILE%\.agents\skills`。拿不到用户目录就是 None
/// （界面据此把全局那一栏置成「用不了」，而不是显示一个拼错的路径）。
///
/// 这份目录**与别的 agent 共用**（ZCode 这类也读它）—— 应用只增删自己装进去的那几个技能目录，
/// 别人的账本（比如仓库里的 skills-lock.json）一概不碰。
pub fn global_root() -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .filter(|text| !text.trim().is_empty())
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|text| !text.trim().is_empty())
        })?;
    Some(
        PathBuf::from(home.trim())
            .join(".agents")
            .join("skills")
            .to_string_lossy()
            .into_owned(),
    )
}

/// 一个技能在盘上的位置：`<根>/<技能名>`。两段都过一遍闸 —— 它们来自渲染层，
/// 接下来要拿去拼文件路径。
pub fn skill_path(root: &str, id: &str) -> Result<PathBuf, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("技能根是空的".into());
    }
    let id = clean_id(id).ok_or_else(|| format!("技能名不合法：{id}"))?;
    Ok(PathBuf::from(root).join(id))
}

/// 一个技能根里的技能：`{ id, fileCount, skillMd }`（与 `skills::list` 同一个形状，
/// 渲染层用同一套 `toSkillEntry` 收敛）。**根不存在就是空表** —— 第一次用、
/// 或者这个项目里还没装过技能，都不是错误。
///
/// 只认「带 SKILL.md 的子目录」：散在根上的裸 `.md` 不算技能（与技能页同一条约定）。
pub fn list(root: &str) -> Result<Vec<Value>, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("技能根是空的".into());
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(Vec::new());
    };

    let mut out: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        // 点开头的目录不是技能（.git、我们解包用的 .tmp-…），与 skills::list 同一条规矩
        if id.starts_with('.') {
            continue;
        }
        let Ok(skill_md) = fs::read_to_string(path.join(SKILL_MD)) else {
            continue;
        };

        let file_count = WalkDir::new(&path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|item| {
                item.depth() == 0 || !item.file_name().to_string_lossy().starts_with('.')
            })
            .filter_map(Result::ok)
            .filter(|item| item.file_type().is_file())
            .count();

        out.push(json!({ "id": id, "fileCount": file_count, "skillMd": skill_md }));
    }

    out.sort_by(|left, right| {
        left["id"]
            .as_str()
            .unwrap_or("")
            .cmp(right["id"].as_str().unwrap_or(""))
    });
    Ok(out)
}

/// 卸掉一个技能：删掉 `<根>/<技能名>` 整棵目录。
///
/// 删的是用户自己那份技能目录里的东西（全局那份与别的 agent 共用、项目那份多半在用户的仓库里）
/// —— 界面那一侧必须先问过一次，这里不做第二次判断。
pub fn remove(root: &str, id: &str) -> Result<(), String> {
    let target = skill_path(root, id)?;
    if !target.is_dir() {
        return Err(format!("找不到这个技能：{id}"));
    }
    fs::remove_dir_all(&target).map_err(|err| format!("删除失败：{err}"))
}

// ---------- 安装 ----------

/// 装一个本地 zip：解到 `<根>/<技能名>/`，返回 `{ id, files }`。
///
/// 技能名优先用调用方给的（`id`），没给就从 SKILL.md 的 frontmatter（`slug` → `name`）
/// 或包名推一个。**同名已经在时不覆盖**：返回一句「先卸载」的错，界面拿着它去问用户，
/// 确认后带 `overwrite` 重调（与 skills.rs 的 install 同一条规矩）。
pub fn install_zip(
    root: &str,
    zip: &str,
    id: Option<String>,
    overwrite: bool,
) -> Result<Value, String> {
    let zip = zip.trim();
    let path = PathBuf::from(zip);
    if !path.is_file() {
        return Err(format!("找不到这个文件：{zip}"));
    }
    let meta = fs::metadata(&path).map_err(|err| format!("读不了这个文件：{err}"))?;
    if meta.len() > MAX_ZIP {
        return Err(format!(
            "这个包太大了（{} MB），技能包一般不会这么大",
            meta.len() >> 20
        ));
    }
    let bytes = fs::read(&path).map_err(|err| format!("读不了这个文件：{err}"))?;
    let fallback = path
        .file_stem()
        .map(|text| text.to_string_lossy().into_owned())
        .unwrap_or_default();
    install_bytes(root, &bytes, &fallback, id, overwrite)
}

/// 从用户粘的地址装：GET 一次（跟随跳转），拿到什么就当 zip 解。
///
/// **这是应用的一条网络出口**（用户给的地址、点了才走，见 AGENTS.md 的出口清单）：
/// 只发这一个 GET，除了这个地址本身不带任何用户数据；跳转最多跟 `MAX_HOPS` 跳。
pub fn install_url(
    root: &str,
    url: &str,
    id: Option<String>,
    overwrite: bool,
) -> Result<Value, String> {
    let (bytes, final_url) = download(url.trim())?;
    let fallback = url_name(&final_url);
    install_bytes(root, &bytes, &fallback, id, overwrite)
}

/// 装一个本机文件夹：**那个文件夹本身就是一个技能**（根上要有 SKILL.md）。整棵复制过去，
/// 跳过点开头的项（`.git` 之类）与系统垃圾。
///
/// 一条边界上的差别值得写在这儿：这条路**不碰 git**。技能页那条「从文件夹导入」
/// （skills.rs 的 import_skill）会把这次导入提交进技能库所在的仓库，而 AI 助手这两条技能根
/// 是在**用户自己的目录**里（项目那份多半就在他的项目仓库里）—— 装个技能顺手替他提交一次，
/// 不是这个应用该做的事。要提交他自己来。
pub fn install_dir(
    root: &str,
    source: &str,
    id: Option<String>,
    overwrite: bool,
) -> Result<Value, String> {
    let source = source.trim();
    let from = PathBuf::from(source);
    if !from.is_dir() {
        return Err(format!("找不到这个文件夹：{source}"));
    }
    let skill_md = fs::read_to_string(from.join(SKILL_MD)).map_err(|_| {
        format!("这个文件夹里没有 {SKILL_MD} —— 一个技能就是「一个目录 + 一份 {SKILL_MD}」")
    })?;

    let base = root_base(root)?;
    let id = match id {
        Some(given) => clean_id(&given).ok_or_else(|| format!("技能名不合法：{given}"))?,
        None => {
            let folder = from
                .file_name()
                .map(|text| text.to_string_lossy().into_owned())
                .unwrap_or_default();
            derive_id(&skill_md, &folder)
        }
    };

    let target = base.join(&id);
    if target.exists() && !overwrite {
        return Err(format!("已经有同名的技能了：{id}（要替换先卸掉它）"));
    }

    fs::create_dir_all(&base).map_err(|err| format!("建不了技能根目录：{err}"))?;
    let temp = base.join(format!(".tmp-{id}-{}", uuid::Uuid::new_v4().simple()));
    let written = match copy_tree(&from, &temp) {
        Ok(written) => written,
        Err(err) => {
            let _ = fs::remove_dir_all(&temp);
            return Err(err);
        }
    };
    commit_temp(&temp, &target, &id, overwrite)?;
    Ok(json!({ "id": id, "files": written }))
}

/// 把一份 zip 的字节装进技能根。本地文件与地址下载都汇到这里。
fn install_bytes(
    root: &str,
    bytes: &[u8],
    fallback: &str,
    id: Option<String>,
    overwrite: bool,
) -> Result<Value, String> {
    let base = root_base(root)?;

    let entries = read_zip(bytes)?;
    // 先算清楚「要写哪些文件」（剥壳、挡越界、跳过目录/符号链接/系统垃圾都在这一步）
    let files = plan_files(&entries)?;
    let skill_index = files
        .iter()
        .find(|(_, rel)| rel.len() == 1 && rel[0] == SKILL_MD)
        .map(|(index, _)| *index)
        .ok_or_else(|| format!("这个包里没有 {SKILL_MD}，不是一个技能包"))?;
    let skill_md = extract_entry(bytes, &entries[skill_index])?;
    let skill_md = String::from_utf8_lossy(&skill_md).into_owned();

    let id = match id {
        Some(given) => clean_id(&given).ok_or_else(|| format!("技能名不合法：{given}"))?,
        None => derive_id(&skill_md, fallback),
    };

    let target = base.join(&id);
    if target.exists() && !overwrite {
        return Err(format!("已经有同名的技能了：{id}（要替换先卸掉它）"));
    }

    fs::create_dir_all(&base).map_err(|err| format!("建不了技能根目录：{err}"))?;
    let temp = base.join(format!(".tmp-{id}-{}", uuid::Uuid::new_v4().simple()));
    let written = match extract_all(bytes, &entries, &files, &temp) {
        Ok(written) => written,
        Err(err) => {
            let _ = fs::remove_dir_all(&temp);
            return Err(err);
        }
    };
    commit_temp(&temp, &target, &id, overwrite)?;

    Ok(json!({ "id": id, "files": written }))
}

/// 技能根：非空即可，不存在会被 `create_dir_all` 建出来（这条与 `skill_path` 是同一套口径）。
fn root_base(root: &str) -> Result<PathBuf, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("技能根是空的".into());
    }
    Ok(PathBuf::from(root))
}

/// 新装的那一棵（临时目录，同盘）改名到最终位置；覆盖时先把旧的那份整个拿掉。
/// **同盘改名是原子的**：半路失败不会留下半个技能。
fn commit_temp(temp: &std::path::Path, target: &std::path::Path, id: &str, overwrite: bool) -> Result<(), String> {
    if target.exists() {
        if !overwrite {
            let _ = fs::remove_dir_all(temp);
            return Err(format!("已经有同名的技能了：{id}（要替换先卸掉它）"));
        }
        fs::remove_dir_all(target).map_err(|err| format!("清掉旧版本失败：{err}"))?;
    }
    if let Err(err) = fs::rename(temp, target) {
        let _ = fs::remove_dir_all(temp);
        return Err(format!("收尾失败：{err}"));
    }
    Ok(())
}

/// 整棵复制（`install_dir` 用的）：只复制文件，跳过点开头的项与系统垃圾。
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> Result<usize, String> {
    fs::create_dir_all(to).map_err(|err| format!("建不了临时目录：{err}"))?;

    let mut written = 0;
    let walk = WalkDir::new(from).follow_links(false).into_iter().filter_entry(|entry| {
        entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
    });
    for entry in walk.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if matches!(name.as_ref(), ".DS_Store" | "Thumbs.db" | "desktop.ini") {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(from)
            .map_err(|err| format!("这个文件夹读不出来：{err}"))?;
        let mut path = to.to_path_buf();
        for part in rel.components() {
            if let std::path::Component::Normal(name) = part {
                path.push(name);
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("建不了目录：{err}"))?;
        }
        fs::copy(entry.path(), &path).map_err(|err| format!("复制文件失败：{err}"))?;
        written += 1;
    }
    Ok(written)
}

/// 把整包解开到 `target`（临时目录），返回写下去的文件数。
fn extract_all(
    bytes: &[u8],
    entries: &[ZipEntry],
    files: &[(usize, Vec<String>)],
    target: &std::path::Path,
) -> Result<usize, String> {
    fs::create_dir_all(target).map_err(|err| format!("建不了临时目录：{err}"))?;

    for (index, rel) in files {
        let data = extract_entry(bytes, &entries[*index])?;
        let mut path = target.to_path_buf();
        for part in rel {
            path.push(part);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("建不了目录：{err}"))?;
        }
        fs::write(&path, &data).map_err(|err| format!("写不了文件：{err}"))?;
    }
    Ok(files.len())
}

/// 解包计划：要写哪些文件（含它们在中央目录里的下标）与各自的相对几段。
///
/// 三件事一起做掉：① 逐条收敛（`..`、绝对路径、盘符、通配字符在这里就被挡回来 ——
/// 包不干净就整包不装，不偷偷丢几条）；② 目录条目、符号链接、系统垃圾不写；
/// ③ **剥掉包外面那层壳**：整包都在同一层目录里、且那层里有 SKILL.md 时剥一层
/// （GitHub 下的包就是 `<仓库>-<分支>/…` 这个形状）。
fn plan_files(entries: &[ZipEntry]) -> Result<Vec<(usize, Vec<String>)>, String> {
    let mut files: Vec<(usize, Vec<String>)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.is_dir || entry.is_link || is_junk(&entry.name) {
            continue;
        }
        files.push((index, entry_segments(&entry.name)?));
    }

    // 根上就有 SKILL.md：不用剥
    if files
        .iter()
        .any(|(_, rel)| rel.len() == 1 && rel[0] == SKILL_MD)
    {
        return Ok(files);
    }

    // 唯一的顶层目录，且它那一层里有 SKILL.md
    let mut top: Option<&str> = None;
    for (_, rel) in &files {
        if rel.len() < 2 {
            return Ok(files);
        }
        match top {
            None => top = Some(rel[0].as_str()),
            Some(name) if name == rel[0] => {}
            Some(_) => return Ok(files),
        }
    }
    let Some(top) = top else {
        return Ok(files);
    };
    let has_md = files
        .iter()
        .any(|(_, rel)| rel.len() == 2 && rel[0] == top && rel[1] == SKILL_MD);
    if !has_md {
        return Ok(files);
    }

    Ok(files
        .into_iter()
        .map(|(index, rel)| (index, rel[1..].to_vec()))
        .collect())
}

/// 条目名 → 逐段收敛过的相对路径。**zip slip 在这里挡住**：`..`、绝对路径、盘符、
/// 通配字符、结尾带点或空格的名字，一律不认。
fn entry_segments(name: &str) -> Result<Vec<String>, String> {
    let normalized = name.replace('\\', "/");
    let mut out: Vec<String> = Vec::new();
    for part in normalized.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if !is_plain_segment(part) || part.ends_with(['.', ' ']) {
            return Err(format!("包里的这个路径不能用：{name}"));
        }
        out.push(part.to_string());
    }
    if out.is_empty() {
        return Err(format!("包里的这个路径不能用：{name}"));
    }
    Ok(out)
}

/// 压缩包里那些不该落盘的东西：macOS 的 `__MACOSX/`、资源管理器的残渣
fn is_junk(name: &str) -> bool {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with("__MACOSX/") || normalized == "__MACOSX" {
        return true;
    }
    matches!(
        normalized.rsplit('/').next(),
        Some(".DS_Store" | "Thumbs.db" | "desktop.ini")
    )
}

// ---------- 技能名 ----------

/// 一个能当目录名的名字：一段、非空、不以点或空格结尾（Windows 会把它们吃掉）。
fn clean_id(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() || !is_plain_segment(text) || text.ends_with(['.', ' ']) {
        return None;
    }
    Some(text.to_string())
}

/// 技能名从哪来：frontmatter 的 `slug` → frontmatter 的 `name` → 包名（zip 文件名 /
/// 地址最后一段，去掉结尾的版本号）。都不成（空、带分隔符、中文之外还带非法字符）就回 `skill`。
fn derive_id(skill_md: &str, fallback: &str) -> String {
    let slug = frontmatter_value(skill_md, "slug");
    let name = frontmatter_value(skill_md, "name");
    let package = strip_version(fallback);
    for candidate in [slug, name, Some(package)] {
        if let Some(text) = candidate {
            if let Some(id) = clean_id(&text) {
                return id;
            }
        }
    }
    "skill".to_string()
}

/// 包名里那串版本号不是技能名的一部分：`universal--charts-1.0.1` → `universal--charts`。
/// 只认结尾的 `-1.2.3` / `_v1.2` 这类形状，认不出就原样返回。
fn strip_version(name: &str) -> String {
    let text = name.trim();
    let text = text
        .strip_suffix(".zip")
        .or_else(|| text.strip_suffix(".ZIP"))
        .unwrap_or(text);
    let Some((head, tail)) = text.rsplit_once(['-', '_']) else {
        return text.to_string();
    };
    let digits = tail.strip_prefix('v').unwrap_or(tail);
    let looks_like_version = !head.is_empty()
        && !digits.is_empty()
        && digits
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()));
    if looks_like_version {
        head.to_string()
    } else {
        text.to_string()
    }
}

/// frontmatter 里要的那个标量。与 shared/skills.ts 是**同一条最小规矩**：首行 `---` 围栏、
/// 每行一个 `键: 值`、去掉一层成对的引号；多行块标量（`|` / `>` 开头）不认。
fn frontmatter_value(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines().map(|line| line.trim());
    loop {
        match lines.next() {
            Some("") => continue,
            Some("---") => break,
            _ => return None,
        }
    }

    for line in lines {
        if line == "---" || line == "..." {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        if value.is_empty() || value.starts_with(['|', '>']) {
            continue;
        }
        let unquoted = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|rest| rest.strip_suffix('\''))
            })
            .unwrap_or(value);
        return Some(unquoted.to_string());
    }
    None
}

// ---------- 地址下载 ----------

/// 下载一个地址的字节 + 最终落到的地址（跟随跳转之后的那个，包名从它取更准）。
fn download(url: &str) -> Result<(Vec<u8>, String), String> {
    if url.is_empty() {
        return Err("还没有填地址".into());
    }

    let mut current = url.to_string();
    for _ in 0..=MAX_HOPS {
        let response = crate::http::request_url_limited(
            "GET",
            &current,
            &[
                ("Accept", "application/zip, application/octet-stream, */*"),
                ("User-Agent", "Workbench"),
            ],
            None,
            MAX_DOWNLOAD,
        )?;

        if (300..400).contains(&response.status) {
            let Some(location) = response.location.as_deref() else {
                return Err(format!(
                    "这个地址回了 {}，但没说下一个地址在哪儿",
                    response.status
                ));
            };
            current = resolve_url(&current, location)?;
            continue;
        }
        if response.status != 200 {
            return Err(format!("下载失败：HTTP {}", response.status));
        }
        if response.body.is_empty() {
            return Err("下载回来的内容是空的".into());
        }
        return Ok((response.body, current));
    }

    Err(format!(
        "跳转太多次了（超过 {MAX_HOPS} 次）—— 地址可能不对，或者对面在绕圈"
    ))
}

/// Location 相对当前地址展开成下一个绝对地址。只认 http / https（协议头、同主机绝对路径、
/// 相对路径三种写法都见得到；`//host/path` 用当前协议补全）。
fn resolve_url(base: &str, location: &str) -> Result<String, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("下一个地址是空的".into());
    }
    if location.starts_with("http://") || location.starts_with("https://") {
        return Ok(location.to_string());
    }

    let (scheme, rest) = base
        .split_once("://")
        .ok_or_else(|| format!("地址要以 http:// 或 https:// 开头：{base}"))?;
    let authority = rest.split('/').next().unwrap_or("");

    if let Some(path) = location.strip_prefix("//") {
        return Ok(format!("{scheme}://{path}"));
    }
    if location.starts_with('/') {
        return Ok(format!("{scheme}://{authority}{location}"));
    }

    // 相对路径：接在当前路径的最后一段目录后面
    let trimmed = rest.rsplit_once('/').map(|(head, _)| head).unwrap_or(rest);
    Ok(format!("{scheme}://{trimmed}/{location}"))
}

/// 地址最后一段当包名（去掉查询串）。取不出就是空串，调用方再往下回落。
fn url_name(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    path.rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
        .unwrap_or_default()
}

// ---------- zip 读取 ----------

/// zip 里的一条。尺寸与偏移都取**中央目录**那一份：本地头在有 data descriptor（bit 3）时
/// 那几个字段写的是 0，靠它解不出东西。
struct ZipEntry {
    name: String,
    method: u16,
    crc: u32,
    compressed: usize,
    size: usize,
    offset: usize,
    is_dir: bool,
    is_link: bool,
}

/// 读一个 zip 的中央目录（EOCD → 逐条）。只读目录，不碰内容。
fn read_zip(bytes: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let eocd = find_eocd(bytes)
        .ok_or_else(|| "这不是一个 zip 文件（找不到结尾的目录记录）".to_string())?;
    let count = read_u16(bytes, eocd + 10)? as usize;
    let offset = read_u32(bytes, eocd + 16)? as usize;
    if count == 0xFFFF || offset >= 0xFFFF_FFFE {
        return Err("这是 zip64 格式的大包，不支持".into());
    }
    if count > MAX_ENTRIES {
        return Err(format!("这个包里的条目太多了（{count} 个）"));
    }

    let mut entries: Vec<ZipEntry> = Vec::new();
    let mut cursor = offset;
    let mut total: u64 = 0;

    for _ in 0..count {
        if read_u32(bytes, cursor)? != 0x0201_4b50 {
            return Err("zip 的中央目录读不出来（结构对不上）".into());
        }
        let flags = read_u16(bytes, cursor + 8)?;
        let method = read_u16(bytes, cursor + 10)?;
        let crc = read_u32(bytes, cursor + 16)?;
        let compressed = read_u32(bytes, cursor + 20)? as u64;
        let size = read_u32(bytes, cursor + 24)? as u64;
        let name_len = read_u16(bytes, cursor + 28)? as usize;
        let extra_len = read_u16(bytes, cursor + 30)? as usize;
        let comment_len = read_u16(bytes, cursor + 32)? as usize;
        let external = read_u32(bytes, cursor + 38)?;
        let local = read_u32(bytes, cursor + 42)? as u64;
        let raw = bytes
            .get(cursor + 46..cursor + 46 + name_len)
            .ok_or_else(|| "zip 的中央目录被截断了".to_string())?;

        if flags & 0x0001 != 0 {
            return Err("这个包是加密的，装不了".into());
        }
        if compressed >= 0xFFFF_FFFE || size >= 0xFFFF_FFFE || local >= 0xFFFF_FFFE {
            return Err("这是 zip64 格式的大包，不支持".into());
        }
        if method != 0 && method != 8 {
            return Err(format!("这个包用了不支持的压缩方式（{method}）"));
        }

        total += size;
        if total > MAX_TOTAL {
            return Err(format!("解压出来太大了（超过 {} MB）", MAX_TOTAL >> 20));
        }

        let name = decode_name(raw, flags & 0x0800 != 0);
        let mode = (external >> 16) & 0xFFFF;
        let is_link = mode & 0xF000 == 0xA000;
        let is_dir = name.ends_with('/') || name.ends_with('\\');

        entries.push(ZipEntry {
            name,
            method,
            crc,
            compressed: compressed as usize,
            size: size as usize,
            offset: local as usize,
            is_dir,
            is_link,
        });

        cursor += 46 + name_len + extra_len + comment_len;
    }

    Ok(entries)
}

/// 从尾巴往前找 EOCD 的签名（注释最长 64 KiB，所以只看最后那一段）
fn find_eocd(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 22 {
        return None;
    }
    let start = bytes.len().saturating_sub(22 + 0xFFFF);
    (start..=bytes.len() - 22).rev().find(|&index| {
        bytes[index..index + 4] == [0x50, 0x4b, 0x05, 0x06]
    })
}

/// 解一条出来，顺手验 CRC（不验的话，下载被截断这种事会以「文件内容是坏的」这种
/// 更晚、更难查的样子冒出来）。
fn extract_entry(bytes: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, String> {
    let offset = entry.offset;
    if read_u32(bytes, offset)? != 0x0403_4b50 {
        return Err(format!("「{}」的内容跟前面对不上", entry.name));
    }
    let name_len = read_u16(bytes, offset + 26)? as usize;
    let extra_len = read_u16(bytes, offset + 28)? as usize;
    let start = offset + 30 + name_len + extra_len;
    let raw = bytes
        .get(start..start + entry.compressed)
        .ok_or_else(|| "包不完整（内容被截断了）".to_string())?;

    let data = match entry.method {
        0 => raw.to_vec(),
        _ => {
            let mut out = Vec::with_capacity(entry.size.min(1 << 20));
            // 头里写的大小只是参考：解到「声明大小 + 1」就停，多出来的当场报错
            DeflateDecoder::new(raw)
                .take(entry.size as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|err| format!("「{}」解压失败：{err}", entry.name))?;
            out
        }
    };

    if data.len() != entry.size {
        return Err(format!("「{}」解压出来的大小对不上", entry.name));
    }
    let mut crc = Crc::new();
    crc.update(&data);
    if crc.sum() != entry.crc {
        return Err(format!("「{}」的校验对不上（包可能坏了）", entry.name));
    }
    Ok(data)
}

/// 条目名 → 名字。带 UTF-8 标志（bit 11）的直接按 UTF-8；没带标志的先当 UTF-8 试
/// （不少工具其实写的也是 UTF-8，只是没打那一位），再不行按系统 ANSI 解 —— 中文机器上
/// 就是 GBK，资源管理器压出来的包走的是这一路。
fn decode_name(raw: &[u8], utf8: bool) -> String {
    if utf8 {
        return String::from_utf8_lossy(raw).into_owned();
    }
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => ansi_to_string(raw),
    }
}

/// 按系统 ANSI 代码页（CP_ACP）解字节。解不出来就退回有损 UTF-8 —— 名字难看总好过装不进去。
fn ansi_to_string(raw: &[u8]) -> String {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    let lossy = || String::from_utf8_lossy(raw).into_owned();
    if raw.len() > i32::MAX as usize {
        return lossy();
    }
    unsafe {
        let need = MultiByteToWideChar(0, 0, raw.as_ptr(), raw.len() as i32, std::ptr::null_mut(), 0);
        if need <= 0 {
            return lossy();
        }
        let mut buffer = vec![0u16; need as usize];
        let wrote = MultiByteToWideChar(0, 0, raw.as_ptr(), raw.len() as i32, buffer.as_mut_ptr(), need);
        if wrote <= 0 {
            return lossy();
        }
        String::from_utf16_lossy(&buffer[..wrote as usize])
    }
}

/// 小端读一个 u16；越界一律当成「包是坏的」。
fn read_u16(bytes: &[u8], at: usize) -> Result<u16, String> {
    let slice = bytes
        .get(at..at + 2)
        .ok_or_else(|| "包不完整（读越界了）".to_string())?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

/// 同上，u32
fn read_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    let slice = bytes
        .get(at..at + 4)
        .ok_or_else(|| "包不完整（读越界了）".to_string())?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 造一个 zip：`(条目名, 内容, 是否 deflate)`。真实世界的包长什么样，这里就照那个形状写
    /// （本地头 + 数据 + 中央目录 + EOCD，CRC 照标准算）—— 不引进别的 zip 库，
    /// 读的那一侧与这里用的是同一套 CRC。
    fn make_zip(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();

        for (name, content, deflate) in files {
            let offset = out.len();
            let body = if *deflate {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(content).unwrap();
                encoder.finish().unwrap()
            } else {
                content.to_vec()
            };
            let mut crc = Crc::new();
            crc.update(content);

            let method: u16 = if *deflate { 8 } else { 0 };
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes()); // 需要的版本
            out.extend_from_slice(&0u16.to_le_bytes()); // 标志
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // 时间
            out.extend_from_slice(&0u16.to_le_bytes()); // 日期
            out.extend_from_slice(&crc.sum().to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(content.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段长度
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&body);

            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes()); // 制作版本
            central.extend_from_slice(&20u16.to_le_bytes()); // 需要的版本
            central.extend_from_slice(&0u16.to_le_bytes()); // 标志
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&crc.sum().to_le_bytes());
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(content.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // 扩展
            central.extend_from_slice(&0u16.to_le_bytes()); // 注释
            central.extend_from_slice(&0u16.to_le_bytes()); // 起始磁盘
            central.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
            central.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
            central.extend_from_slice(&(offset as u32).to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }

        let cd_offset = out.len();
        let cd_size = central.len();
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // 这个磁盘
        out.extend_from_slice(&0u16.to_le_bytes()); // 目录起始磁盘
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(cd_size as u32).to_le_bytes());
        out.extend_from_slice(&(cd_offset as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        out
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-pi-skill-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_zip(tag: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("wb-pi-{tag}-{}.zip", uuid::Uuid::new_v4()));
        fs::write(&path, bytes).unwrap();
        path
    }

    const SKILL: &str = "---\nname: charts\nslug: universal--charts\ndescription: 画图\n---\n\n正文\n";

    #[test]
    fn installs_a_flat_package_and_names_it_after_the_slug() {
        let root = temp_root("flat");
        let zip = write_zip(
            "flat",
            &make_zip(&[
                ("SKILL.md", SKILL.as_bytes(), true),
                ("references/a.md", b"ref", true),
                ("scripts/run.py", b"print(1)", false),
            ]),
        );

        let result = install_zip(&root.to_string_lossy(), &zip.to_string_lossy(), None, false)
            .expect("应当装上");
        assert_eq!(result["id"], "universal--charts");
        assert_eq!(result["files"], 3);

        let installed = root.join("universal--charts");
        assert!(installed.join("SKILL.md").is_file());
        assert!(installed.join("references").join("a.md").is_file());
        assert!(installed.join("scripts").join("run.py").is_file());
        // 临时目录不留在技能根里
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录要清掉");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&zip);
    }

    #[test]
    fn strips_the_wrapper_folder_github_ships() {
        let root = temp_root("wrap");
        let zip = write_zip(
            "wrap",
            &make_zip(&[
                ("repo-main/SKILL.md", SKILL.as_bytes(), true),
                ("repo-main/lib/x.md", b"x", true),
            ]),
        );

        let result = install_zip(&root.to_string_lossy(), &zip.to_string_lossy(), None, false)
            .expect("应当装上");
        assert_eq!(result["id"], "universal--charts");
        // 壳被剥掉了：SKILL.md 就在技能目录下，而不是 repo-main/ 里面
        assert!(root.join("universal--charts").join("SKILL.md").is_file());
        assert!(!root.join("universal--charts").join("repo-main").exists());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&zip);
    }

    #[test]
    fn refuses_a_package_without_skill_md() {
        let root = temp_root("no-md");
        let zip = write_zip("no-md", &make_zip(&[("readme.md", b"hi", false)]));
        let result = install_zip(&root.to_string_lossy(), &zip.to_string_lossy(), None, false);
        assert!(result.is_err(), "没有 SKILL.md 的包不该装上");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&zip);
    }

    #[test]
    fn blocks_zip_slip() {
        let root = temp_root("slip");
        let zip = write_zip(
            "slip",
            &make_zip(&[
                ("SKILL.md", SKILL.as_bytes(), false),
                ("../逃出去.txt", b"nope", false),
            ]),
        );
        let result = install_zip(&root.to_string_lossy(), &zip.to_string_lossy(), None, false);
        assert!(result.is_err(), "带 .. 的条目要挡住");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&zip);
    }

    #[test]
    fn asks_before_replacing_an_installed_skill() {
        let root = temp_root("again");
        let zip = write_zip("again", &make_zip(&[("SKILL.md", SKILL.as_bytes(), true)]));
        let root_text = root.to_string_lossy().into_owned();
        let zip_text = zip.to_string_lossy().into_owned();

        install_zip(&root_text, &zip_text, None, false).expect("第一次应当装上");
        assert!(
            install_zip(&root_text, &zip_text, None, false).is_err(),
            "同名再装要报错，等界面问过用户"
        );
        let again = install_zip(&root_text, &zip_text, None, true).expect("确认后应当覆盖");
        assert_eq!(again["id"], "universal--charts");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&zip);
    }

    #[test]
    fn lists_skills_and_ignores_everything_else() {
        let root = temp_root("list");
        fs::create_dir_all(root.join("charts")).unwrap();
        fs::write(root.join("charts").join(SKILL_MD), SKILL).unwrap();
        fs::write(root.join("charts").join("x.md"), "x").unwrap();
        fs::create_dir_all(root.join("还没有技能")).unwrap();
        fs::write(root.join("散着的.md"), "x").unwrap();
        fs::create_dir_all(root.join(".tmp-半份")).unwrap();

        let items = list(&root.to_string_lossy()).expect("列得出来");
        assert_eq!(items.len(), 1, "只列带 SKILL.md 的子目录：{items:?}");
        assert_eq!(items[0]["id"], "charts");
        assert_eq!(items[0]["fileCount"], 2);
        assert!(items[0]["skillMd"].as_str().unwrap().contains("画图"));

        // 根不存在 = 还没有技能，不是错误
        let missing = root.join("没有这个目录");
        assert!(list(&missing.to_string_lossy()).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removes_one_skill_and_keeps_the_rest() {
        let root = temp_root("remove");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a").join(SKILL_MD), SKILL).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();

        let root_text = root.to_string_lossy().into_owned();
        remove(&root_text, "a").expect("删得掉");
        assert!(!root.join("a").exists());
        assert!(root.join("b").exists());
        assert!(remove(&root_text, "a").is_err(), "没有了就说找不到");
        assert!(remove(&root_text, "../x").is_err(), "越界的名字要挡住");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn installs_a_folder_as_one_skill() {
        let root = temp_root("dir");
        let source = temp_root("src");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join(SKILL_MD), "---\nname: from-folder\n---\n正文").unwrap();
        fs::write(source.join("references").join("a.md"), "x").unwrap();
        // 点开头的项不带过去
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::write(source.join(".git").join("config"), "x").unwrap();

        let result = install_dir(
            &root.to_string_lossy(),
            &source.to_string_lossy(),
            None,
            false,
        )
        .expect("应当装上");
        assert_eq!(result["id"], "from-folder");
        assert_eq!(result["files"], 2);
        assert!(root.join("from-folder").join(SKILL_MD).is_file());
        assert!(!root.join("from-folder").join(".git").exists());

        // 没有 SKILL.md 的文件夹不是技能
        let plain = temp_root("plain");
        assert!(install_dir(&root.to_string_lossy(), &plain.to_string_lossy(), None, false).is_err());

        for dir in [&root, &source, &plain] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn derives_names_from_frontmatter_then_the_package() {
        assert_eq!(derive_id(SKILL, "whatever"), "universal--charts");
        // 没有 slug 用 name
        assert_eq!(
            derive_id("---\nname: my-skill\ndescription: x\n---\n", "whatever"),
            "my-skill"
        );
        // 中文名照样能当目录名
        assert_eq!(
            derive_id("---\nname: 通用图表生成器\ndescription: x\n---\n", "whatever"),
            "通用图表生成器"
        );
        // 都没有：包名去掉版本号
        assert_eq!(derive_id("没有 frontmatter", "universal--charts-1.0.1"), "universal--charts");
        assert_eq!(derive_id("", "charts_v1.2"), "charts");
        // 都不成：回一个不会出事的名字
        assert_eq!(derive_id("", "..."), "skill");

        // 名字里带分隔符的不能当目录名
        assert_eq!(derive_id("---\nslug: a/b\n---\n", "fallback"), "fallback");
        assert_eq!(clean_id("a\\b"), None);
        assert_eq!(clean_id("点结尾."), None);
        assert_eq!(clean_id("  "), None);
    }

    #[test]
    fn reads_frontmatter_the_same_minimal_way_as_the_renderer() {
        assert_eq!(frontmatter_value(SKILL, "slug"), Some("universal--charts".into()));
        assert_eq!(frontmatter_value(SKILL, "description"), Some("画图".into()));
        assert_eq!(
            frontmatter_value("---\nname: \"引号里的\"\n---\n", "name"),
            Some("引号里的".into())
        );
        // 围栏前的空行、`...` 收尾都认
        assert_eq!(frontmatter_value("\n\n---\nname: a\n...\n", "name"), Some("a".into()));
        // 多行块标量不认（内容在缩进里）
        assert_eq!(frontmatter_value("---\nname: >-\n  a\n---\n", "name"), None);
        // 没有 frontmatter
        assert_eq!(frontmatter_value("name: a\n", "name"), None);
    }

    #[test]
    fn resolves_redirect_locations_against_the_current_url() {
        let base = "https://hub.example.com/api/skills/1/download";
        assert_eq!(
            resolve_url(base, "https://cos.example.com/a.zip").unwrap(),
            "https://cos.example.com/a.zip"
        );
        assert_eq!(
            resolve_url(base, "//cos.example.com/a.zip").unwrap(),
            "https://cos.example.com/a.zip"
        );
        assert_eq!(
            resolve_url(base, "/files/a.zip").unwrap(),
            "https://hub.example.com/files/a.zip"
        );
        assert_eq!(
            resolve_url(base, "a.zip").unwrap(),
            "https://hub.example.com/api/skills/1/a.zip"
        );
        assert!(resolve_url(base, "").is_err());

        assert_eq!(url_name("https://cos.example.com/skills/177009/universal--charts/1.0.1.zip?x=1"), "1.0.1.zip");
        assert_eq!(url_name("https://example.com/"), "");
    }

    /// 真发一跳：微软的连通性探测点 302 到别处，用来验「跟着 Location 再发一次」这条路。
    /// 没网就跳过 —— 与 http.rs 里那条联网测试同一个约定。
    #[test]
    fn download_follows_a_real_redirect() {
        let result = download("http://www.msftconnecttest.com/redirect");
        let (body, final_url) = match result {
            Ok(pair) => pair,
            Err(err) => {
                println!("跳过：本机访问不了这个地址（{err}）");
                return;
            }
        };
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("Microsoft Connect Test"),
            "跟到最后应当拿到探测页（落在 {final_url}）：{}",
            &text.chars().take(120).collect::<String>()
        );
    }
}
