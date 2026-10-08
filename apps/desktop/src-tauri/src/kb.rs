//! 知识库：用户在别处维护的一个独立项目（原始资料 + 已整理的条目 + 机器可读索引）。
//!
//! 仓库是**纯数据**：没有脚本、没有 Agent 说明文件。条目的内容不由应用写 —— 写它的是
//! 应用编排的清洗（提示词在渲染层 `packages/kb/src/kb-clean.ts`，编排与收尾在 stores/kb.ts，
//! 走的是 ai.rs 那条通用驱动链路）。这里带三样事实：扫一份平铺清单、读单个文件的文本、
//! 重建目录与索引（`kb/_catalog.md` 与 `index/index.json`，是生成物、不是内容）。
//! 清单**不按扩展名过滤**：原始资料可能是 pdf / docx 任何东西。
//!
//! **原始数据的最外层是「来源」**（`RawSource`）：`data/raw/<名字>` 这一格对到本机一个
//! 文件夹 —— 资料经常就在别的项目里，为让它可见而 copy 进库里那条路不再需要。清单里的
//! `rel` 始终是**逻辑路径**（`data/raw/<名字>/<内层>`），来源实际在哪儿只影响这里扫描与
//! 读取时去哪儿找；因此每条都带上 `abs`（真实绝对路径），渲染层不再自己拼路径规则。
//! 配了路径的来源读不到时只报这一条来源（`sources` 里那个 error），不让整页读不出来。
//!
//! 「哪些是原始数据」「有没有更新」这些口径在渲染层的纯函数里（`packages/kb/src/kb.ts`），
//! 那边有单测；与 notes.rs 同一条分工——这里只管把磁盘上的事实带回去。
//!
//! 路径边界与 notes.rs 同一条：只认「相对某个根的路径」，逐段解析挡住 `..` / 盘符 / UNC。
//! 库里那份的根是知识库文件夹，来源那份的根是用户指定的那个文件夹（两者都由用户挑定，
//! 渲染层给的绝对路径只作**来源根**用，文件那一截仍然逐段挡）。
//! 实现收在 [fs_util](fs_util.rs)，这里的薄壳只把报错里的称呼说成「知识库文件夹」；
//! 噪音目录的名单只此一份，复用 `notes::is_skipped_entry`。

use crate::fs_util;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 递归的深度上限（与 notes.rs 同一个数）：拦的是「把盘根选成了知识库」
const MAX_DEPTH: usize = 12;

/// 原始资料区的逻辑前缀（相对知识库根）：来源名接在它后面
const RAW_PREFIX: &str = "data/raw/";

/// 渲染层登记进来的一个来源：来源名 → 本机的一个文件夹。
///
/// 名字是**逻辑路径的一段**（条目 frontmatter 的 source 引用它），dir 是资料实际在哪儿。
/// dir 为空 = 还没配（这一轮没得扫，来源行上标出来，用户可以在界面上指定）；配置只落
/// 渲染层的数据文件，这里每次都现收一份（它是本机的事实，不缓存）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RawSource {
    pub name: String,
    pub dir: String,
}

/// 知识库根。目录不在（被移走 / 被删掉 / 网络盘没连上）时给一句能看懂的话
fn root_path(root: &str) -> Result<PathBuf, String> {
    fs_util::root_dir(root, "知识库文件夹")
}

/// 相对路径 → 绝对路径，逐段只接受普通名字（与 `notes::resolve` 同一条边界，越界一律拒）
fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    fs_util::resolve_under(root, rel, "知识库文件夹")
}

/// `data/raw/<来源名>/<内层>` → （来源名, 内层）。不是这个形状（直接躺在 `data/raw`
/// 下的文件、条目、索引…）回 None —— 那些照旧在知识库文件夹里找。
/// 前缀按 ASCII 不敏感比（文件系统本来也分不清 `Data/Raw` 与 `data/raw`）。
fn split_raw_source(rel: &str) -> Option<(&str, &str)> {
    let head = rel.get(..RAW_PREFIX.len())?;
    if !head.eq_ignore_ascii_case(RAW_PREFIX) {
        return None;
    }
    let (name, inner) = rel[RAW_PREFIX.len()..].split_once('/')?;
    if name.is_empty() || inner.is_empty() {
        return None;
    }
    Some((name, inner))
}

/// 读一个文件时的落点：落在某个**配好路径**的来源下就走那个来源的文件夹（资料在库外），
/// 其余（条目、索引、库里那份原始数据）照旧在知识库文件夹里。
///
/// 来源那一截只认「名字」，内层仍然逐段挡越界 —— 渲染层给的是逻辑路径，绝对路径只有
/// 「这个来源的根」一处、由用户挑定并存在设置里。
fn resolve_read(root: &str, rel: &str, sources: &[RawSource]) -> Result<PathBuf, String> {
    if let Some((name, inner)) = split_raw_source(rel) {
        if let Some(source) = sources.iter().find(|item| item.name.eq_ignore_ascii_case(name)) {
            if !source.dir.trim().is_empty() {
                return fs_util::resolve_under(source.dir.trim(), inner, "来源文件夹");
            }
        }
    }
    resolve(root, rel)
}

/// 绝对路径 → 相对知识库根的路径，统一用 `/` 分隔
fn rel_of(root: &Path, path: &Path) -> String {
    fs_util::rel_under(root, path)
}

fn mtime_ms(path: &Path) -> u64 {
    fs_util::mtime_ms(path)
}

/// 一个条目的绝对路径（给渲染层：打开文件、清洗清单里给 Pi 读的地址都用它）
fn abs_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// 递归列一个根：文件夹与**所有**文件都回（任意后缀），`rel` 在 `prefix` 之上接出来。
///
/// 回来的是**平铺的清单**（每项带自己的相对路径、绝对路径、来源与修改时间），不是嵌套结构 ——
/// 「原始数据是哪些」「条目是哪些」由渲染层按前缀挑，状态判定也以这里的 mtime 为准。
///
/// `origin` 是这条事实的出处：`repo` = 知识库文件夹里那一份，`source` = 某个来源文件夹里
/// 那一份。**必须分开**：同一个来源名配了外部文件夹时，库里那份副本（`repo`）要整棵让位，
/// 而外部那份（`source`）正是要用的那份 —— 光看 rel 两者一模一样，分不出来。
fn walk_into(base: &Path, prefix: &str, origin: &str, out: &mut Vec<Value>) {
    let entries = WalkDir::new(base)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        // 点开头的、以及依赖 / 构建产物的目录整棵跳过
        //（知识库仓库里的 .git / node_modules、来源项目里的都一样不该见人）
        .filter_entry(|entry| {
            entry.depth() == 0
                || !crate::notes::is_skipped_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        });

    for entry in entries {
        // 权限不够 / 刚被删掉都是常态：跳过它，别让整份清单读不出来
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        let inner = rel_of(base, entry.path());
        let rel = if prefix.is_empty() {
            inner
        } else {
            format!("{prefix}/{inner}")
        };
        out.push(json!({
            "rel": rel,
            "name": name,
            "isDir": entry.file_type().is_dir(),
            "mtimeMs": mtime_ms(entry.path()),
            "abs": abs_of(entry.path()),
            "origin": origin,
        }));
    }
}

/// 扫一遍：知识库文件夹（条目 / 索引 / 库里那份原始数据）＋ 每个配好路径的来源文件夹。
///
/// 回来的是 `{ entries, sources }` 两样：`entries` 是平铺清单（来源里的文件带的是
/// **逻辑** rel，见模块注释），`sources` 是每条来源这一轮的结果 —— 路径打不开时
/// `error` 里是给用户看的原因，**只影响那一条来源**，别的照扫（一个来源挂在没插的
/// 移动盘上，不该让整页读不出来）。
pub fn scan(root: &str, sources: &[RawSource]) -> Result<Value, String> {
    let base = root_path(root)?;
    let mut entries = Vec::new();
    walk_into(&base, "", "repo", &mut entries);

    let mut reports = Vec::new();
    for source in sources {
        let name = source.name.trim();
        if name.is_empty() {
            continue;
        }
        let dir = source.dir.trim();
        // 还没配路径：这一轮没得扫。不是错误 —— 来源行上标「还没指定路径」，用户去配
        if dir.is_empty() {
            reports.push(json!({ "name": name, "error": "" }));
            continue;
        }
        if !Path::new(dir).is_dir() {
            reports.push(json!({
                "name": name,
                "error": format!("找不到这个文件夹：{dir}"),
            }));
            continue;
        }
        walk_into(
            Path::new(dir),
            &format!("{RAW_PREFIX}{name}"),
            "source",
            &mut entries,
        );
        reports.push(json!({ "name": name, "error": "" }));
    }

    Ok(json!({ "entries": entries, "sources": reports }))
}

/// 读一个文件的文本（条目正文 / index.json / 某个来源里的原始资料）。
/// BOM 不在这里剥：它是「内容怎么解释」的事，归渲染层。
pub fn read(root: &str, rel: &str, sources: &[RawSource]) -> Result<String, String> {
    let path = resolve_read(root, rel, sources)?;
    std::fs::read_to_string(&path).map_err(|err| format!("读取失败：{err}"))
}


// ---------- 索引重建 ----------
//
// 这是应用**唯一直接写知识库的地方**，写的是生成物（`kb/_catalog.md` 与
// `index/index.json`）、不是内容。索引只由应用生成：仓库转成纯数据后没有别的生成者，
// 谁都不会把谁的成果改回去。格式保持稳定 —— 字段与顺序就是既有生成物的形状，
// 一次重建不该让整份文件变成另一副样子。

/// index.json 里的一条。字段与顺序固定下来（既有生成物就是这个形状），所以这里用
/// 结构体而不是 `json!` 宏：宏背后是 BTreeMap，会把键排成字母序。
#[derive(serde::Serialize)]
struct IndexEntry {
    path: String,
    title: String,
    tags: Vec<String>,
    status: String,
    created: String,
    updated: String,
    summary: String,
}

#[derive(serde::Serialize)]
struct IndexFile {
    generated_at: String,
    count: usize,
    root: &'static str,
    entries: Vec<IndexEntry>,
}

/// frontmatter 的解析结果：围栏内的元数据 + 围栏之后的正文
struct Parsed<'a> {
    meta: HashMap<String, String>,
    tags: Vec<String>,
    body: &'a str,
}

/// 极简 frontmatter 解析：首行围栏、围栏内每行一个 `键: 值`、tags 认 `[a, b]` 列表写法
/// （值一律去一层引号）。多行块标量不认 —— 仓库的条目规范里没有它。
///
/// tags 写成裸标量时按「单个标签」处理，不按字符拆。规范本来就要求列表写法，
/// 真碰上裸标量也只有这一种解释合理。
/// 没有可认的 frontmatter：元数据全空、正文就是全文
fn bare_parsed(body: &str) -> Parsed<'_> {
    Parsed {
        meta: HashMap::new(),
        tags: Vec::new(),
        body,
    }
}

fn parse_frontmatter(text: &str) -> Parsed<'_> {
    // 开头围栏：`---` 之后只能有空白；带 BOM 的文件第一行不是 `---`，按无 frontmatter 处理
    let first_end = text.find('\n').unwrap_or(text.len());
    if text[..first_end].trim_end() != "---" {
        return bare_parsed(text);
    }

    let mut meta: HashMap<String, String> = HashMap::new();
    let mut tags: Vec<String> = Vec::new();
    let mut offset = first_end + 1;
    let mut body_start: Option<usize> = None;

    while offset < text.len() {
        let end = text[offset..]
            .find('\n')
            .map(|index| offset + index)
            .unwrap_or(text.len());
        let line = &text[offset..end];

        // 结束围栏
        if line.trim_end() == "---" {
            body_start = Some((end + 1).min(text.len()));
            break;
        }

        if !line.trim_start().starts_with('#') {
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim().to_lowercase();
                let value = value.trim();
                if value.len() >= 2 && value.starts_with('[') && value.ends_with(']') {
                    let list: Vec<String> = value[1..value.len() - 1]
                        .split(',')
                        .map(|part| unquote(part.trim()))
                        .filter(|part| !part.is_empty())
                        .collect();
                    if key == "tags" {
                        tags = list;
                    }
                } else if key == "tags" {
                    let single = unquote(value);
                    tags = if single.is_empty() { Vec::new() } else { vec![single] };
                } else {
                    meta.insert(key, unquote(value));
                }
            }
        }

        if end == text.len() {
            break;
        }
        offset = end + 1;
    }

    match body_start {
        Some(start) => Parsed {
            meta,
            tags,
            // 围栏后的空白一并吃掉
            body: text[start..].trim_start(),
        },
        None => bare_parsed(text),
    }
}

/// 去一层成对的引号（单双都认，可以混着来）
fn unquote(value: &str) -> String {
    value.trim_matches(|c| c == '\'' || c == '"').to_string()
}

/// 标题回落：正文里第一个一级标题（`^#\s+(.+)$`，二级标题不算）
fn first_heading(body: &str) -> Option<String> {
    for line in body.split('\n') {
        let Some(rest) = line.strip_prefix('#') else {
            continue;
        };
        if !rest.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let text = rest.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    None
}

/// 摘要回落：正文里第一个不是标题的段落，空白压成一个空格、取前 80 个字（按字算，不按字节）
fn first_paragraph(body: &str) -> String {
    for para in body.split("\n\n") {
        let para = para.trim();
        if para.is_empty() || para.starts_with('#') {
            continue;
        }
        let collapsed = para.split_whitespace().collect::<Vec<_>>().join(" ");
        return collapsed.chars().take(80).collect();
    }
    String::new()
}

/// 一个文件 → 索引里的一条（`rel` 是相对 `kb/` 的路径）
fn index_entry_of(rel: &str, text: &str, stem: &str) -> IndexEntry {
    let parsed = parse_frontmatter(text);
    let title = parsed
        .meta
        .get("title")
        .filter(|title| !title.is_empty())
        .cloned()
        .or_else(|| first_heading(parsed.body))
        .unwrap_or_else(|| stem.to_string());
    let summary = parsed
        .meta
        .get("summary")
        .filter(|summary| !summary.is_empty())
        .cloned()
        .unwrap_or_else(|| first_paragraph(parsed.body));

    IndexEntry {
        path: format!("kb/{rel}"),
        title,
        tags: parsed.tags,
        status: parsed
            .meta
            .get("status")
            .cloned()
            .unwrap_or_else(|| "draft".to_string()),
        created: parsed.meta.get("created").cloned().unwrap_or_default(),
        updated: parsed.meta.get("updated").cloned().unwrap_or_default(),
        summary,
    }
}

/// 全库目录 `_catalog.md` 的正文：按目录分组，组内按路径排。
/// 没有标签的行会多出一个空格（既有生成物就是这个形状），照样保留。
fn catalog_text(entries: &[IndexEntry]) -> String {
    let mut lines = vec![
        "<!-- 本文件由 Workbench 自动生成，请勿手改 -->".to_string(),
        String::new(),
        "# 知识库目录".to_string(),
        String::new(),
    ];

    let mut grouped: BTreeMap<String, Vec<&IndexEntry>> = BTreeMap::new();
    for entry in entries {
        let dir = entry
            .path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_default();
        grouped.entry(dir).or_default().push(entry);
    }

    for (dir, mut list) in grouped {
        list.sort_by(|a, b| a.path.cmp(&b.path));
        lines.push(format!("## {dir}"));
        lines.push(String::new());
        for entry in list {
            let tags = entry
                .tags
                .iter()
                .map(|tag| format!("`{tag}`"))
                .collect::<Vec<_>>()
                .join(" ");
            let summary = if entry.summary.is_empty() {
                String::new()
            } else {
                format!(" — {}", entry.summary)
            };
            lines.push(format!("- [{}]({}) {}{}", entry.title, entry.path, tags, summary));
        }
        lines.push(String::new());
    }

    lines.join("\n")
}

/// `YYYY-MM-DD`：日期由渲染层按**本机时区**算出来，这里只校验形状 —— 时区换算不该
/// 在 Rust 侧再实现一遍。
fn is_iso_date(value: &str) -> bool {
    value.len() == 10
        && value.chars().enumerate().all(|(index, c)| match index {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        })
}

/// 写盘前把换行翻成 CRLF：仓库里那两个生成物实际就是 CRLF，保持这个换行 ——
/// 一次重建不该把整份文件重写成另一副换行（diff 只该有内容的变化）。
fn windows_text(text: &str) -> String {
    text.replace('\n', "\r\n")
}

/// 重建 `kb/_catalog.md` 与 `index/index.json`，返回重建后的条目数。
pub fn index_build(root: &str, generated_at: &str) -> Result<Value, String> {
    let base = root_path(root)?;
    let kb_dir = base.join("kb");
    if !kb_dir.is_dir() {
        return Err(format!("找不到知识库目录：{}", kb_dir.display()));
    }
    if !is_iso_date(generated_at) {
        return Err(format!("日期不合法：{generated_at}"));
    }

    let mut files: Vec<String> = Vec::new();
    for entry in WalkDir::new(&kb_dir)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !crate::notes::is_skipped_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        })
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Windows 上后缀不分大小写；目录生成物（_catalog.md）不算条目
        if !name.to_lowercase().ends_with(".md") || name.eq_ignore_ascii_case("_catalog.md") {
            continue;
        }
        files.push(rel_of(&kb_dir, entry.path()));
    }
    // 按 Path 排序，在 Windows 上那是**大小写不敏感**的比较
    files.sort_by_key(|rel| rel.to_lowercase());

    let mut entries: Vec<IndexEntry> = Vec::new();
    for rel in &files {
        let text = std::fs::read_to_string(kb_dir.join(rel))
            .map_err(|err| format!("读取条目失败（{rel}）：{err}"))?;
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let stem = Path::new(name)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.to_string());
        entries.push(index_entry_of(rel, &text, &stem));
    }

    let count = entries.len();
    let catalog = catalog_text(&entries);
    let json_text = serde_json::to_string_pretty(&IndexFile {
        generated_at: generated_at.to_string(),
        count,
        root: "kb/",
        entries,
    })
    .map_err(|err| format!("生成索引失败：{err}"))?;

    std::fs::write(kb_dir.join("_catalog.md"), windows_text(&catalog).as_bytes())
        .map_err(|err| format!("写目录失败：{err}"))?;
    let index_dir = base.join("index");
    std::fs::create_dir_all(&index_dir).map_err(|err| format!("创建索引目录失败：{err}"))?;
    std::fs::write(index_dir.join("index.json"), windows_text(&json_text).as_bytes())
        .map_err(|err| format!("写索引失败：{err}"))?;

    Ok(json!({ "count": count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个临时目录；用完删掉（留着的临时目录只会在盘上积垃圾）
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-kb-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rels(entries: &[Value]) -> Vec<String> {
        entries
            .iter()
            .map(|item| item["rel"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// 扫出来的清单（`scan` 现在回 `{ entries, sources }`，测试里多半只关心 entries）
    fn scan_entries(root: &str, sources: &[RawSource]) -> Vec<Value> {
        let result = scan(root, sources).unwrap();
        result["entries"].as_array().cloned().unwrap_or_default()
    }

    /// 一个来源（名字 + 文件夹）
    fn source(name: &str, dir: &Path) -> RawSource {
        RawSource {
            name: name.to_string(),
            dir: dir.to_str().unwrap().to_string(),
        }
    }

    /// 任意后缀都列出来（原始资料不一定是 markdown），文件夹也在清单里；
    /// 点开头的目录与依赖 / 构建产物整棵跳过。
    #[test]
    fn scans_every_file_type_and_skips_noise() {
        let root = temp_root("scan");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("data/raw/mu-ui")).unwrap();
        std::fs::create_dir_all(root.join("kb")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("scripts/__pycache__")).unwrap();
        std::fs::write(root.join("README.md"), "readme").unwrap();
        std::fs::write(root.join("data/raw/mu-ui/button.md"), "原始").unwrap();
        std::fs::write(root.join("data/raw/手册.pdf"), "x").unwrap();
        std::fs::write(root.join("kb/button.md"), "条目").unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join("scripts/__pycache__/x.pyc"), "x").unwrap();

        let found = rels(&scan_entries(path, &[]));
        assert!(found.contains(&"README.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw/mu-ui/button.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw/手册.pdf".to_string()), "非 markdown 的原始资料不该被漏掉: {found:?}");
        assert!(found.contains(&"kb/button.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw".to_string()), "文件夹也该在清单里: {found:?}");
        assert!(!found.iter().any(|rel| rel.contains(".git")), "点开头的目录该整棵跳过: {found:?}");
        assert!(!found.iter().any(|rel| rel.contains("__pycache__")), "噪音目录该整棵跳过: {found:?}");

        // 每条都带自己的绝对路径（渲染层打开文件、清洗清单给 Pi 的地址都用它）
        let button = scan_entries(path, &[])
            .into_iter()
            .find(|item| item["rel"] == "kb/button.md")
            .unwrap();
        assert_eq!(button["abs"], root.join("kb").join("button.md").to_string_lossy().to_string());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 来源：外部文件夹里的文件带**逻辑** rel 回来、绝对路径指向真实位置；
    /// 没配路径的来源不扫也不报错；路径打不开只报这一条来源，别的照扫。
    #[test]
    fn scans_sources_under_their_logical_path() {
        let root = temp_root("scan-source");
        let outside = temp_root("scan-source-outside");
        std::fs::create_dir_all(root.join("kb")).unwrap();
        std::fs::create_dir_all(outside.join("子目录")).unwrap();
        std::fs::create_dir_all(outside.join("node_modules")).unwrap();
        std::fs::write(outside.join("button.md"), "原始").unwrap();
        std::fs::write(outside.join("子目录/notes.txt"), "备注").unwrap();
        std::fs::write(outside.join("node_modules/x.js"), "噪音").unwrap();

        let sources = vec![
            source("mu-ui", &outside),
            // 还没配路径
            RawSource { name: "workbench".into(), dir: "  ".into() },
            // 路径打不开
            RawSource { name: "挂了".into(), dir: "Z:/wb-kb-not-there".into() },
        ];
        let result = scan(root.to_str().unwrap(), &sources).unwrap();

        let found = rels(result["entries"].as_array().unwrap());
        assert!(found.contains(&"data/raw/mu-ui/button.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw/mu-ui/子目录/notes.txt".to_string()), "{found:?}");
        assert!(
            !found.iter().any(|rel| rel.contains("node_modules")),
            "来源里的噪音目录也该整棵跳过: {found:?}"
        );

        let button = result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["rel"] == "data/raw/mu-ui/button.md")
            .unwrap();
        assert_eq!(button["abs"], outside.join("button.md").to_string_lossy().to_string());
        // 「这条事实是哪个根上扫出来的」必须交代清楚：库里那份副本与来源那份 rel 一样，
        // 渲染层要靠它决定让位（见 packages/kb/src/kb.ts 的 kbVisibleRawEntries）
        assert_eq!(button["origin"], "source");
        let repo_entry = result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["rel"] == "kb")
            .unwrap();
        assert_eq!(repo_entry["origin"], "repo");

        let reports = result["sources"].as_array().unwrap();
        assert_eq!(reports.len(), 3, "每条来源都该有一份结果: {reports:?}");
        assert_eq!(reports[0]["error"], "", "读到了就没有 error");
        assert_eq!(reports[1]["error"], "", "没配路径不算错误");
        assert!(
            reports[2]["error"].as_str().unwrap().contains("找不到这个文件夹"),
            "路径打不开时原因落在它自己那条上: {reports:?}"
        );

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// 读文件来回一趟；越界一律挡住；根目录不在 / 空地址给一句能看懂的话
    #[test]
    fn read_and_path_guards() {
        let root = temp_root("read");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("kb")).unwrap();
        std::fs::write(root.join("kb/条目.md"), "# 标题").unwrap();

        assert_eq!(read(path, "kb/条目.md", &[]).unwrap(), "# 标题");
        // Windows 反斜杠的写法也认（渲染层一般传 `/`，这里兜住）
        assert_eq!(read(path, "kb\\条目.md", &[]).unwrap(), "# 标题");

        assert!(read(path, "../别的目录/秘密.md", &[]).is_err());
        assert!(read(path, "C:/Windows/win.ini", &[]).is_err());
        assert!(read(path, "kb/../../外.md", &[]).is_err());
        assert!(read(path, "kb/不存在的.md", &[]).is_err());

        assert!(scan("   ", &[]).is_err());
        assert!(scan("wb-kb-not-there", &[]).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 读来源里的文件：逻辑路径经来源根解析；没配路径 / 不是那份来源 / 越界都读不到
    #[test]
    fn read_resolves_through_the_source_root() {
        let root = temp_root("read-source");
        let outside = temp_root("read-source-outside");
        std::fs::create_dir_all(root.join("kb")).unwrap();
        std::fs::create_dir_all(outside.join("子目录")).unwrap();
        std::fs::write(outside.join("子目录/a.md"), "来源里的正文").unwrap();
        std::fs::write(root.join("kb/条目.md"), "# 库里的条目").unwrap();

        let sources = vec![source("mu-ui", &outside)];
        assert_eq!(
            read(root.to_str().unwrap(), "data/raw/mu-ui/子目录/a.md", &sources).unwrap(),
            "来源里的正文"
        );
        // 来源名大小写不敏感（文件系统本来也分不清）
        assert!(read(root.to_str().unwrap(), "data/raw/MU-UI/子目录/a.md", &sources).is_ok());
        // 内层仍然逐段挡越界：来源根之外的东西读不到
        assert!(read(root.to_str().unwrap(), "data/raw/mu-ui/../秘密.md", &sources).is_err());
        // 没配路径的来源：退回知识库文件夹里找，找不到就如实失败
        assert!(read(root.to_str().unwrap(), "data/raw/mu-ui/子目录/a.md", &[]).is_err());
        // 库里那份（没有来源名那一段）照旧在知识库文件夹里找
        assert_eq!(
            read(root.to_str().unwrap(), "kb/条目.md", &sources).unwrap(),
            "# 库里的条目"
        );

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// frontmatter 认法：围栏、每行一个键值、tags 列表、引号剥一层
    #[test]
    fn frontmatter_is_parsed_like_the_script() {
        let text = "---\ntitle: \"带引号\"\ntags: [a, 'b', c d]\nstatus: reviewed\nsummary: 摘要\n---\n# 正文\n";
        let parsed = parse_frontmatter(text);
        assert_eq!(parsed.meta.get("title").map(String::as_str), Some("带引号"));
        assert_eq!(parsed.tags, vec!["a", "b", "c d"], "引号剥一层，空的丢掉");
        assert_eq!(parsed.meta.get("status").map(String::as_str), Some("reviewed"));
        assert_eq!(parsed.body, "# 正文\n", "围栏与紧随其后的换行都不算正文");

        // tags 写成裸标量：按单个标签处理，不按字符拆
        assert_eq!(parse_frontmatter("---\ntags: 只有一个\n---\n").tags, vec!["只有一个"]);

        // 不是围栏 / 围栏没闭合：都当没有元数据，正文原样
        assert!(parse_frontmatter("# 直接是正文\n").meta.is_empty());
        assert!(parse_frontmatter("---\ntitle: x\n").meta.is_empty(), "围栏没闭合就不算元数据");
        assert!(parse_frontmatter("--- 不是围栏\ntitle: x\n---\n").meta.is_empty());
    }

    /// 标题只认一级；摘要按**字**截断（不是字节），空白压成一个空格
    #[test]
    fn heading_and_paragraph_fallbacks() {
        assert_eq!(first_heading("## 二级\n\n# 一级\n"), Some("一级".to_string()));
        assert_eq!(first_heading("## 只有二级\n"), None);
        assert_eq!(first_heading("#\n\n# 空标题\n"), Some("空标题".to_string()));

        assert_eq!(first_paragraph("# 标题\n\n甲乙   丙\n\n丁"), "甲乙 丙");
        let long = "字".repeat(100);
        let summary = first_paragraph(&format!("# 标题\n\n{long}"));
        assert_eq!(summary.chars().count(), 80, "超长段落取前 80 个字");
        assert!(summary.chars().all(|c| c == '字'), "不能把某个字按字节切成两半");
    }

    /// 索引重建：目录与 index.json 的**实际内容**（换行按 CRLF 写盘）
    #[test]
    fn index_build_writes_the_catalog_and_index() {
        let root = temp_root("index");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("kb/01-示例")).unwrap();
        std::fs::create_dir_all(root.join("kb/02-另外")).unwrap();
        std::fs::write(
            root.join("kb/01-示例/有元数据.md"),
            "---\ntitle: \"有元数据\"\ntags: [alpha, beta]\ncreated: 2026-09-01\nupdated: 2026-09-02\nstatus: reviewed\nsummary: 一句话摘要\n---\n# 正文标题\n\n正文。\n",
        )
        .unwrap();
        std::fs::write(
            root.join("kb/02-另外/裸标题.md"),
            "# 裸标题\n\n这是裸条目的第一段。\n\n第二段。\n",
        )
        .unwrap();
        // 生成物不该被当成条目（跑第二遍时它就在那儿了）
        std::fs::write(root.join("kb/_catalog.md"), "上一轮的目录").unwrap();

        let result = index_build(path, "2026-09-28").unwrap();
        assert_eq!(result["count"], 2);

        let catalog = std::fs::read_to_string(root.join("kb/_catalog.md")).unwrap();
        assert!(catalog.contains("\r\n"), "写盘是 CRLF");
        assert_eq!(
            catalog.replace("\r\n", "\n"),
            concat!(
                "<!-- 本文件由 Workbench 自动生成，请勿手改 -->\n",
                "\n",
                "# 知识库目录\n",
                "\n",
                "## kb/01-示例\n",
                "\n",
                "- [有元数据](kb/01-示例/有元数据.md) `alpha` `beta` — 一句话摘要\n",
                "\n",
                "## kb/02-另外\n",
                "\n",
                // 没有标签的那行多一个空格（既有生成物的形状），照样保留
                "- [裸标题](kb/02-另外/裸标题.md)  — 这是裸条目的第一段。\n",
            )
        );

        let index = std::fs::read_to_string(root.join("index/index.json")).unwrap();
        assert_eq!(
            index.replace("\r\n", "\n"),
            concat!(
                "{\n",
                "  \"generated_at\": \"2026-09-28\",\n",
                "  \"count\": 2,\n",
                "  \"root\": \"kb/\",\n",
                "  \"entries\": [\n",
                "    {\n",
                "      \"path\": \"kb/01-示例/有元数据.md\",\n",
                "      \"title\": \"有元数据\",\n",
                "      \"tags\": [\n",
                "        \"alpha\",\n",
                "        \"beta\"\n",
                "      ],\n",
                "      \"status\": \"reviewed\",\n",
                "      \"created\": \"2026-09-01\",\n",
                "      \"updated\": \"2026-09-02\",\n",
                "      \"summary\": \"一句话摘要\"\n",
                "    },\n",
                "    {\n",
                "      \"path\": \"kb/02-另外/裸标题.md\",\n",
                "      \"title\": \"裸标题\",\n",
                "      \"tags\": [],\n",
                "      \"status\": \"draft\",\n",
                "      \"created\": \"\",\n",
                "      \"updated\": \"\",\n",
                "      \"summary\": \"这是裸条目的第一段。\"\n",
                "    }\n",
                "  ]\n",
                "}"
            )
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 重建索引的两条拒绝：没有 kb 目录、日期不是 `YYYY-MM-DD`
    #[test]
    fn index_build_rejects_bad_input() {
        let root = temp_root("index-bad");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("kb")).unwrap();

        assert!(index_build(path, "2026/09/28").is_err(), "日期形状不对要挡住");
        assert!(index_build(path, "").is_err());
        assert!(index_build(path, "2026-09-28").is_ok());

        std::fs::remove_dir_all(&root).unwrap();
        assert!(index_build(path, "2026-09-28").is_err(), "目录不在了就该明说");
    }
}
