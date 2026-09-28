//! 知识库：用户在别处维护的一个独立项目（原始资料 + 已整理的条目 + 机器可读索引）。
//!
//! 应用对知识库是**只读**的：条目怎么写、目录与索引怎么生成，都是那个仓库自己的事
//! （它带着自己的脚本与 Agent 使用说明，用户在 ZCode 等 Agent 里完成整理）。
//! 这里只做两件事——扫一份平铺清单与读单个文件的文本。清单**不按扩展名过滤**：
//! 原始资料可能是 pdf / docx 任何东西，这是它与 `notes::scan` 唯一的差别
//! （`note_scan` 只回 markdown）。
//!
//! 「哪些是原始数据」「有没有更新」这些口径在渲染层的纯函数里（`src/shared/knowledge.ts`），
//! 那边有单测；与 notes.rs 同一条分工——这里只管把磁盘上的事实带回去。
//!
//! 路径边界与 notes.rs 同一条：只认「相对知识库根的路径」，逐段解析挡住 `..` / 盘符 / UNC。
//! （这一小段路径代码与 notes.rs 各有一份：报错里说的文件夹不是同一个，「找不到笔记文件夹」
//! 出现在知识库页上会让人找错地方；噪音目录的名单则只此一份，复用 `notes::is_skipped_entry`。）

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

/// 递归的深度上限（与 notes.rs 同一个数）：拦的是「把盘根选成了知识库」
const MAX_DEPTH: usize = 12;

/// 知识库根。目录不在（被移走 / 被删掉 / 网络盘没连上）时给一句能看懂的话
fn root_path(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("还没有选择知识库文件夹".into());
    }
    let base = PathBuf::from(trimmed);
    if !base.is_dir() {
        return Err(format!("找不到知识库文件夹：{trimmed}"));
    }
    Ok(base)
}

/// 相对路径 → 绝对路径，逐段只接受普通名字（与 `notes::resolve` 同一条边界，越界一律拒）
fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let mut path = root_path(root)?;
    for raw in rel.split(['/', '\\']) {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        let mut parts = Path::new(part).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(name)), None) => path.push(name),
            _ => return Err(format!("路径不合法：{rel}")),
        }
    }
    Ok(path)
}

/// 绝对路径 → 相对知识库根的路径，统一用 `/` 分隔
fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// 列目录：一层层往下走，文件夹与**所有**文件都回（任意后缀，见模块注释）。
///
/// 回来的是**平铺的清单**（每项带自己的相对路径与修改时间），不是嵌套结构 ——
/// 「原始数据是哪些」「条目是哪些」由渲染层按前缀挑，状态判定也以这里的 mtime 为准。
pub fn scan(root: &str) -> Result<Vec<Value>, String> {
    let base = root_path(root)?;
    let mut out = Vec::new();

    let entries = WalkDir::new(&base)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        // 点开头的、以及依赖 / 构建产物的目录整棵跳过（知识库仓库里的 .git / node_modules 一样不该见人）
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
        let is_dir = entry.file_type().is_dir();
        out.push(json!({
            "rel": rel_of(&base, entry.path()),
            "name": name,
            "isDir": is_dir,
            "mtimeMs": mtime_ms(entry.path()),
        }));
    }

    Ok(out)
}

/// 读一个文件的文本（条目正文 / index.json）。BOM 不在这里剥：它是「内容怎么解释」的事，归渲染层。
pub fn read(root: &str, rel: &str) -> Result<String, String> {
    let path = resolve(root, rel)?;
    std::fs::read_to_string(&path).map_err(|err| format!("读取失败：{err}"))
}

// ---------- 索引重建 ----------
//
// 这件事本来由知识库仓库自己的 `scripts/build_index.py` 做。搬进应用的理由只有一个：
// 那个脚本要 Python，而这个应用对用户的外部依赖只有 git 一件（见 AGENTS.md 第 1 节）。
// 输出与脚本**逐字节对齐** —— 谁最后跑的都不会把对方的成果改回去（除了 generated_at
// 那一天的日期），用户在两处来回切也不会看到无意义的 diff。

/// index.json 里的一条。字段与顺序都照脚本的输出写，所以这里用结构体而不是 `json!` 宏：
/// 宏背后是 BTreeMap，会把键排成字母序，和脚本的 dict 顺序对不上。
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

/// 极简 frontmatter 解析，与脚本的 `parse_frontmatter` 同一套认法：首行围栏、围栏内每行
/// 一个 `键: 值`、tags 认 `[a, b]` 列表写法（值一律去一层引号）。多行块标量不认 ——
/// 仓库的条目规范里没有它。
///
/// 一处**有意的偏离**：tags 写成裸标量时，脚本把它当字符串、随后按字符拆成一个个标签
/// （`for t in "标题"` 逐个字符），这里按「单个标签」处理。规范本来就要求列表写法，
/// 真碰上也只有这一种输入会不一致。
/// 没有可认的 frontmatter：元数据全空、正文就是全文
fn bare_parsed(body: &str) -> Parsed<'_> {
    Parsed {
        meta: HashMap::new(),
        tags: Vec::new(),
        body,
    }
}

fn parse_frontmatter(text: &str) -> Parsed<'_> {
    // 开头围栏：`---` 之后只能有空白（脚本的正则从行首锚定，这里同样不兼容 BOM）
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
            // 脚本把围栏后的空白一并吃掉（正则里的 `\s*`），这里照做
            body: text[start..].trim_start(),
        },
        None => bare_parsed(text),
    }
}

/// 去一层成对的引号（单双都认，可以混着来，与 Python 的 `strip("'\"")` 同义）
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

/// 全库目录 `_catalog.md` 的正文：按目录分组，组内按路径排 —— 与脚本的 write_catalog 一致。
/// 没有标签的行会多出一个空格（脚本的 `"%s %s"` 留下的），这里照样保留。
fn catalog_text(entries: &[IndexEntry]) -> String {
    let mut lines = vec![
        "<!-- 本文件由 scripts/build_index.py 自动生成，请勿手改 -->".to_string(),
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

/// `YYYY-MM-DD`：日期由渲染层按**本机时区**算出来（脚本用的是 `date.today()`，同一条口径），
/// 这里只校验形状 —— 时区换算不该在 Rust 侧再实现一遍。
fn is_iso_date(value: &str) -> bool {
    value.len() == 10
        && value.chars().enumerate().all(|(index, c)| match index {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        })
}

/// 写盘前把换行翻成 CRLF：脚本用的是 Python 的 `write_text`，在 Windows 上是文本模式，
/// `\n` 会被翻成 `\r\n` —— 仓库里那两个生成物实际就是 CRLF。跟着写才逐字节对得上，
/// 谁最后跑的都不会把整份文件重写成另一副换行。
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
        // 与脚本的 rglob("*.md") 同一条：Windows 上后缀不分大小写；
        // 脚本自己生成的目录（_catalog.md）不算条目
        if !name.to_lowercase().ends_with(".md") || name.eq_ignore_ascii_case("_catalog.md") {
            continue;
        }
        files.push(rel_of(&kb_dir, entry.path()));
    }
    // 脚本按 Path 排序，在 Windows 上那是**大小写不敏感**的比较，这里照做
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

        let found = rels(&scan(path).unwrap());
        assert!(found.contains(&"README.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw/mu-ui/button.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw/手册.pdf".to_string()), "非 markdown 的原始资料不该被漏掉: {found:?}");
        assert!(found.contains(&"kb/button.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/raw".to_string()), "文件夹也该在清单里: {found:?}");
        assert!(!found.iter().any(|rel| rel.contains(".git")), "点开头的目录该整棵跳过: {found:?}");
        assert!(!found.iter().any(|rel| rel.contains("__pycache__")), "噪音目录该整棵跳过: {found:?}");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 读文件来回一趟；越界一律挡住；根目录不在 / 空地址给一句能看懂的话
    #[test]
    fn read_and_path_guards() {
        let root = temp_root("read");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("kb")).unwrap();
        std::fs::write(root.join("kb/条目.md"), "# 标题").unwrap();

        assert_eq!(read(path, "kb/条目.md").unwrap(), "# 标题");
        // Windows 反斜杠的写法也认（渲染层一般传 `/`，这里兜住）
        assert_eq!(read(path, "kb\\条目.md").unwrap(), "# 标题");

        assert!(read(path, "../别的目录/秘密.md").is_err());
        assert!(read(path, "C:/Windows/win.ini").is_err());
        assert!(read(path, "kb/../../外.md").is_err());
        assert!(read(path, "kb/不存在的.md").is_err());

        assert!(scan("   ").is_err());
        assert!(scan("wb-kb-not-there").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// frontmatter 与脚本同一套认法：围栏、每行一个键值、tags 列表、引号剥一层
    #[test]
    fn frontmatter_is_parsed_like_the_script() {
        let text = "---\ntitle: \"带引号\"\ntags: [a, 'b', c d]\nstatus: reviewed\nsummary: 摘要\n---\n# 正文\n";
        let parsed = parse_frontmatter(text);
        assert_eq!(parsed.meta.get("title").map(String::as_str), Some("带引号"));
        assert_eq!(parsed.tags, vec!["a", "b", "c d"], "引号剥一层，空的丢掉");
        assert_eq!(parsed.meta.get("status").map(String::as_str), Some("reviewed"));
        assert_eq!(parsed.body, "# 正文\n", "围栏与紧随其后的换行都不算正文");

        // tags 写成裸标量：按单个标签处理（脚本会按字符拆，那是个 bug，不跟）
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

    /// 索引重建：目录与 index.json 的**实际内容**（换行按 CRLF 写盘，与脚本一致）
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
        // 脚本自己的产物不该被当成条目（跑第二遍时它就在那儿了）
        std::fs::write(root.join("kb/_catalog.md"), "上一轮的目录").unwrap();

        let result = index_build(path, "2026-09-28").unwrap();
        assert_eq!(result["count"], 2);

        let catalog = std::fs::read_to_string(root.join("kb/_catalog.md")).unwrap();
        assert!(catalog.contains("\r\n"), "与脚本一致：写盘是 CRLF");
        assert_eq!(
            catalog.replace("\r\n", "\n"),
            concat!(
                "<!-- 本文件由 scripts/build_index.py 自动生成，请勿手改 -->\n",
                "\n",
                "# 知识库目录\n",
                "\n",
                "## kb/01-示例\n",
                "\n",
                "- [有元数据](kb/01-示例/有元数据.md) `alpha` `beta` — 一句话摘要\n",
                "\n",
                "## kb/02-另外\n",
                "\n",
                // 没有标签的那行多一个空格：脚本的 `"%s %s"` 留下的，照样保留
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

    /// 把一棵目录原样复制到另一处（只给下面那次手工核对用）
    fn copy_tree(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in WalkDir::new(from) {
            let entry = entry.unwrap();
            let target = to.join(entry.path().strip_prefix(from).unwrap());
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&target).unwrap();
            } else {
                std::fs::copy(entry.path(), &target).unwrap();
            }
        }
    }

    /// **手工核对**（`cargo test -- --ignored crosscheck`）：拿这台机器上那份真知识库的
    /// 一份副本，重建索引，与 `scripts/build_index.py` 的产物逐字节比对。
    /// 常规测试不跑它 —— 它依赖机器上的具体路径，也不该在别人机器上乱翻文件。
    #[test]
    #[ignore = "手工核对：与 Python 脚本的输出逐字节比对"]
    fn crosscheck_real_kb() {
        let source = Path::new("E:/muyian/agent");
        if !source.is_dir() {
            eprintln!("跳过：这台机器上没有 {} 那份知识库", source.display());
            return;
        }

        let copy = temp_root("crosscheck");
        for dir in ["kb", "index"] {
            copy_tree(&source.join(dir), &copy.join(dir));
        }
        // 日期取成与现有 index.json 同一天，否则比的是日期栏
        let date = "2026-09-28";
        let result = index_build(copy.to_str().unwrap(), date).unwrap();
        eprintln!("重建了 {} 条", result["count"]);

        for rel in ["kb/_catalog.md", "index/index.json"] {
            let before = std::fs::read(source.join(rel)).unwrap();
            let after = std::fs::read(copy.join(rel)).unwrap();
            if before != after {
                let before_text = String::from_utf8_lossy(&before);
                let after_text = String::from_utf8_lossy(&after);
                let first_diff = before_text
                    .lines()
                    .zip(after_text.lines())
                    .position(|(a, b)| a != b);
                panic!(
                    "{rel} 与脚本产物不一致：脚本 {} 字节 / 应用 {} 字节，第一处不同在第 {:?} 行",
                    before.len(),
                    after.len(),
                    first_diff
                );
            }
        }

        std::fs::remove_dir_all(&copy).unwrap();
    }
}
