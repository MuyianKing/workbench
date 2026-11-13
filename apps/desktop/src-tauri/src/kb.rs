//! 知识库：仓库里物理分两层的独立项目 —— `raw/` 放**原始数据**、`data/` 放**清洗后的
//! 条目与生成物**（`data/_catalog.md` 与 `data/index.json`，是生成物、不是内容）。
//!
//! 仓库是**纯数据**：没有脚本、没有 Agent 说明文件。条目的内容不由应用写 —— 写它的是
//! 应用编排的清洗（提示词在渲染层 `packages/kb/src/kb-clean.ts`，编排与收尾在 stores/kb.ts，
//! 走的是 ai.rs 那条通用驱动链路）。这里带事实、做受控的写动作：
//!
//! - **扫一份平铺清单 + 读出清单文件**（`raw/kb.json`）：知识库列表的数据源就是这份清单，
//!   渲染层解析它得到列表（「哪些是原始数据」「有没有更新」的口径都在渲染层纯函数里）。
//!   清单**不按扩展名过滤**：原始资料可能是 pdf / docx 任何东西。
//! - **读单个文件的文本**：只认 `raw/` 与 `data/` 两层 —— 清单、条目、生成物、原始资料
//!   都在这两层里，仓库根下的其他文件（README、.git…）不对外读。
//! - **受控的写动作**（每个都有明确的前缀边界，越界一律拒）：
//!   `source_sync`（源头文件夹 → 复制进 raw，添加知识库与清洗前的源头同步共用）、
//!   `delete_tree`（删一个知识库的 raw/<名>/ 与 data/<名>/）、`file_delete`（删一个原始
//!   文件，仓库里那份与关联的源头文件一起删）、`config_write`（写清单）、`migrate`
//!   （旧结构一次性迁移：kb/ → data/、来源复制进 raw/、source 前缀改写）、
//!   `index_build`（重建生成物）、`entry_delete`（删条目）。git 的提交 / 推送在
//!   sync.rs（kb_sync / kb_pull），不在这里。
//!
//! **旧前缀 `data/raw/` 是遗留**：老结构的库内原始副本在迁移后不再有任何身份 ——
//! 不算条目、不算原始数据、应用不改不删它（迁移只搬 `kb/`，遗留副本留在原地）。
//!
//! 路径边界与 notes.rs 同一条：只认「相对某个根的路径」，逐段解析挡住 `..` / 盘符 / UNC
//! （收在 [fs_util](fs_util.rs)，这里的薄壳只把报错里的称呼说成「知识库文件夹」／「源头
//! 文件夹」）。源头文件夹由渲染层带着配置传进来（它是本机的事实，不缓存），
//! 与知识库文件夹互相套住时一律拒 —— 那样复制就是自己拷自己。
//! 噪音目录的名单只此一份，复用 `notes::is_skipped_entry`。

use crate::fs_util;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 递归的深度上限（与 notes.rs 同一个数）：拦的是「把盘根选成了知识库」
const MAX_DEPTH: usize = 12;

/// 原始数据层（相对知识库根）：物理目录，进同步
const RAW_PREFIX: &str = "raw/";

/// 清洗数据层（相对知识库根）：条目 + 生成物
const DATA_PREFIX: &str = "data/";

/// 遗留的库内原始副本（旧结构的 `data/raw/`）：不算条目、不算原始数据，应用不改不删
const LEGACY_RAW: &str = "raw/";

/// 清单文件（相对知识库根）：知识库列表的数据源，应用维护
const MANIFEST_REL: &str = "raw/kb.json";

/// 全库目录：应用重建的生成物，条目清单里不算它
const KB_CATALOG_NAME: &str = "_catalog.md";

/// 知识库根。目录不在（被移走 / 被删掉 / 网络盘没连上）时给一句能看懂的话
fn root_path(root: &str) -> Result<PathBuf, String> {
    fs_util::root_dir(root, "知识库文件夹")
}

/// 相对路径 → 绝对路径，逐段只接受普通名字（与 `notes::resolve` 同一条边界，越界一律拒）
fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    fs_util::resolve_under(root, rel, "知识库文件夹")
}

/// 前缀判断（ASCII 不敏感、按**字节**比）：字符串切前缀要用字节切片，
/// 按字符切会在多字节字符中间断开（中文路径随时踩）
fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() > prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// 渲染层只能读 `raw/` 与 `data/` 两层的文件：前缀按 ASCII 不敏感比（文件系统本来也
/// 分不清 `RAW` 与 `raw`）。仓库根下的其他文件（README、.git…）不对外读。
fn is_kb_rel(rel: &str) -> bool {
    [RAW_PREFIX, DATA_PREFIX]
        .iter()
        .any(|prefix| starts_with_ignore_case(rel, prefix))
}

/// 知识库名是一段**真实目录名**：挡分隔符、`.` / `..` 与控制字符
/// （与渲染层的 sanitizeKbName 同一条收敛 —— 名字会原样拼进路径）。
fn name_segment(name: &str) -> Result<&str, String> {
    let clean = name.trim();
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.contains('/')
        || clean.contains('\\')
        || clean.chars().any(|c| c.is_control())
    {
        return Err(format!("知识库名不合法：{name}"));
    }
    Ok(clean)
}

/// 源头文件夹与知识库文件夹互相套住时拒：dir 在 root 里（自己拷自己），
/// root 在 dir 里（复制会递归吞掉整个仓库）。Windows 路径不区分大小写与分隔符，
/// 前缀比较带上分隔符边界（`E:\a` 不能算 `E:\ab` 的前缀）。
fn check_disjoint(base: &Path, dir: &Path) -> Result<(), String> {
    let norm = |p: &Path| -> String {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let b = norm(base);
    let d = norm(dir);
    let inside =
        |outer: &str, inner: &str| inner == outer || inner.starts_with(&format!("{outer}\\"));
    if inside(&b, &d) || inside(&d, &b) {
        return Err("源头文件夹不能与知识库文件夹重叠（在它里面或包着它都不行）".into());
    }
    Ok(())
}

/// 绝对路径 → 相对知识库根的路径，统一用 `/` 分隔
fn rel_of(root: &Path, path: &Path) -> String {
    fs_util::rel_under(root, path)
}

fn mtime_ms(path: &Path) -> u64 {
    fs_util::mtime_ms(path)
}

/// 一个文件的绝对路径（给渲染层：打开文件、清洗清单里给 Pi 读的地址都用它）
fn abs_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// 递归列知识库文件夹：文件夹与**所有**文件都回（任意后缀），`rel` 相对仓库根。
///
/// 回来的是**平铺的清单**（每项带自己的相对路径、绝对路径与修改时间），不是嵌套结构 ——
/// 「哪些是原始数据」「哪些是条目」由渲染层按前缀挑，状态判定也以这里的 mtime 为准。
/// 整棵仓库都在清单里（raw、data、遗留副本都在）：`.git` 与依赖 / 构建产物由噪音
/// 名单整棵跳过。
fn walk_into(base: &Path, out: &mut Vec<Value>) {
    let entries = WalkDir::new(base)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        // 点开头的、以及依赖 / 构建产物的目录整棵跳过
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
        out.push(json!({
            "rel": rel_of(base, entry.path()),
            "name": name,
            "isDir": entry.file_type().is_dir(),
            "mtimeMs": mtime_ms(entry.path()),
            "abs": abs_of(entry.path()),
        }));
    }
}

/// 扫一遍知识库文件夹：平铺清单 + 清单文件（`raw/kb.json`）的原文。
///
/// 清单原文原样带回去 —— 它怎么解析、列表长什么样是渲染层的口径（parseKbManifest），
/// 这里只管把磁盘上的事实带回去。清单不在（老仓库、还没添加过）时是空串，不是错误。
pub fn scan(root: &str, links: &[SourceLink]) -> Result<Value, String> {
    let base = root_path(root)?;
    let mut entries = Vec::new();
    walk_into(&base, &mut entries);
    let manifest = std::fs::read_to_string(resolve(root, MANIFEST_REL)?).unwrap_or_default();

    // 本机关联的源头文件夹：逐文件算内容指纹带回去（状态判定「本地为准」用）。
    // 名字不合法 / 文件夹打不开 / 与仓库重叠的关联跳过 —— 少一份数据只是退回
    // 「以仓库副本判状态」，不该让整页扫描失败
    let mut local = Vec::new();
    for link in links {
        let Ok(name) = name_segment(&link.name) else { continue };
        let dir = link.dir.trim();
        if dir.is_empty() {
            continue;
        }
        let path = Path::new(dir);
        if !path.is_dir() || check_disjoint(&base, path).is_err() {
            continue;
        }
        walk_local(path, name, &mut local);
    }

    Ok(json!({ "entries": entries, "manifest": manifest, "local": local }))
}

/// 递归列一个源头文件夹：每个文件带上「源头内相对路径 + 修改时间 + 内容指纹 + 绝对路径」。
/// 指纹在这里算（SHA-256，与 raw 层同一把尺）—— 渲染层拿它和条目的 `source_hash` 比，
/// 「本机改了没洗」靠它而不是 mtime（git 会重写 mtime）。读不出指纹的文件带空串，
/// 渲染层按「没有本地数据」处理。噪音名单与扫描同一条。
fn walk_local(base: &Path, name: &str, out: &mut Vec<Value>) {
    let entries = WalkDir::new(base)
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
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        let inner = rel_of(base, entry.path());
        if inner.is_empty() {
            continue;
        }
        let hash = std::fs::read(entry.path())
            .map(|bytes| hex(&crate::encoding::sha256(&bytes)))
            .unwrap_or_default();
        out.push(json!({
            "name": name,
            "rel": inner,
            "mtimeMs": mtime_ms(entry.path()),
            "hash": hash,
            "abs": abs_of(entry.path()),
        }));
    }
}

/// 读一个文件的文本（原始资料 / 条目 / 清单 / 生成物）。BOM 不在这里剥：它是
/// 「内容怎么解释」的事，归渲染层。只认 `raw/` 与 `data/` 两层（见 is_kb_rel）。
///
/// **有关联的知识库以本机源头为准**：`raw/<名字>/<内层>` 且这台机器给那个知识库关联了
/// 源头文件夹时，本机里有这份就读本机的（本机改了还没清洗，界面看到的就该是最新内容；
/// 路径、修改时间、外部打开同样落在它上面，见渲染层 matchKbRawStatus 的本地覆盖）；
/// 本机没有这份（文件夹打不开 / 文件不在 / 关联不合法）再读仓库里的副本 ——
/// 没关联的知识库从头到尾就是仓库副本。
pub fn read(root: &str, rel: &str, links: &[SourceLink]) -> Result<String, String> {
    let clean = rel.replace('\\', "/");
    if !is_kb_rel(&clean) {
        return Err(format!("只能读取 raw/ 与 data/ 下的文件：{rel}"));
    }
    let base = root_path(root)?;

    if starts_with_ignore_case(&clean, RAW_PREFIX) {
        let rest = &clean[RAW_PREFIX.len()..];
        if let Some((name, inner)) = rest.split_once('/') {
            if !inner.is_empty() {
                if let Some(link) = links.iter().find(|link| link.name.trim() == name) {
                    let dir = link.dir.trim();
                    if !dir.is_empty() {
                        let source = Path::new(dir);
                        if source.is_dir() && check_disjoint(&base, source).is_ok() {
                            if let Ok(path) = fs_util::resolve_under(
                                source.to_str().unwrap_or(""),
                                inner,
                                "源头文件夹",
                            ) {
                                if path.is_file() {
                                    return std::fs::read_to_string(&path)
                                        .map_err(|err| format!("读取失败：{err}"));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let path = resolve(root, &clean)?;
    std::fs::read_to_string(&path).map_err(|err| format!("读取失败：{err}"))
}

/// 字节 → 小写十六进制（指纹写进条目 frontmatter 的 `source_hash`）
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// 一批原始文件的内容指纹：逻辑路径 → SHA-256（小写十六进制）。
///
/// 只算渲染层挑出来的那些（**有条目指向的**；未入库的文件不参与），跨设备判定「已入库 /
/// 有更新」靠它而不是 mtime —— git checkout / pull 会重写 mtime。单个文件读不出来
/// （权限 / 刚被删 / 是目录）就**不放进结果**，渲染层按「无法判定」回落 mtime；
/// 只有知识库根读不到才整体失败。
pub fn fingerprints(root: &str, rels: &[String]) -> Result<Value, String> {
    root_path(root)?;
    let mut out = serde_json::Map::new();
    for rel in rels {
        let clean = rel.replace('\\', "/");
        if !is_kb_rel(&clean) {
            continue;
        }
        let Ok(path) = resolve(root, &clean) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        out.insert(clean, Value::String(hex(&crate::encoding::sha256(&bytes))));
    }
    Ok(Value::Object(out))
}

/// 仓库根的 `AGENTS.md`：给任何会进仓库的 AI（Claude Code、Codex 这些会自动读
/// AGENTS.md 的工具）描述「这是什么、结构长什么样、怎么用」。**内容是应用的口径**
/// （布局常量与清洗约定都在这里），所以由应用生成；**已存在时不覆盖** —— 用户可能
/// 在里面补了自己的说明。添加知识库与迁移之后由渲染层调一次（那时清单刚落盘）。
const AGENTS_DOC: &str = r#"<!-- 本文件由 Workbench 自动生成（已存在时不覆盖），描述这个知识库仓库的结构与用法 -->

# 知识库

这是一个由 Workbench（Windows 桌面应用）管理的知识库仓库，**纯数据**：没有脚本，
只有原始资料与整理好的知识条目。

## 结构

- `raw/<知识库名>/…` — 原始资料：每个子目录是一个知识库，内容是从本机源头文件夹复制来的副本（清洗的输入）。
- `raw/kb.json` — 知识库清单（有哪些知识库、何时添加）。由 Workbench 维护，请勿手改。
- `data/<知识库名>/…` — 知识条目：由 Workbench 编排 AI「清洗」`raw/` 里的原始资料生成，回答问题所需的知识都在这里。
- `data/index.json` 与 `data/_catalog.md` — 由 Workbench 自动重建的机器索引与全库目录，请勿手改。

## 条目格式

`data/` 下每个 `.md` 是一个条目，frontmatter 字段：

- `title` 条目标题；`tags` 标签列表；`status` 状态（清洗生成一律 `reviewed`）
- `created` / `updated` 建与改的日期（YYYY-MM-DD）
- `source` 原始文件在本仓库的路径（`raw/<知识库名>/…`）；`source_hash` 那份原始文件的内容指纹
- `summary` 一句话概括

条目之间用相对路径互链（`[xx](./xx.md)`、`[yy](../02-主题/yy.md)`），不用 `[[双链]]` 写法。

## 给 AI 的使用说明

- 回答问题前，先在 `data/` 下按关键词检索条目；条目不够再读它 `source` 指向的 `raw/` 原始资料。
- 条目内容由 Workbench 的清洗流程维护：**不要手工编辑 `data/`** —— 要改内容，去改 `raw/` 里
  对应的原始文件，然后在 Workbench 里重新清洗。
- `raw/kb.json`、`data/index.json`、`data/_catalog.md` 是应用生成物，不要手改。
- 本仓库的 git 提交与推送由 Workbench 负责。
"#;

pub fn agents_doc_write(root: &str) -> Result<Value, String> {
    let path = resolve(root, "AGENTS.md")?;
    if path.exists() {
        return Ok(json!({ "written": false }));
    }
    std::fs::write(&path, AGENTS_DOC.as_bytes())
        .map_err(|err| format!("写 AGENTS.md 失败：{err}"))?;
    Ok(json!({ "written": true }))
}

/// 删除一批条目（受控例外）。
///
/// 只删 `data/` 下的 `.md`：前缀、后缀、生成物 `_catalog.md`、遗留的 `data/raw/`
/// 都挡，路径仍走逐段越界检查（`..` / 盘符 / UNC 一律拒）。文件已经不在了不算失败 ——
/// 重扫后它本来就不该在清单里。删除后由渲染层重建索引（与清洗收尾同一条路）。
pub fn delete_entries(root: &str, rels: &[String]) -> Result<Value, String> {
    root_path(root)?;
    let mut deleted = 0usize;
    for rel in rels {
        let clean = rel.replace('\\', "/");
        let name = clean.rsplit('/').next().unwrap_or("");
        if !starts_with_ignore_case(&clean, DATA_PREFIX)
            || !name.to_lowercase().ends_with(".md")
            || name.eq_ignore_ascii_case(KB_CATALOG_NAME)
        {
            return Err(format!("只能删除 data/ 下的条目：{rel}"));
        }
        if clean[DATA_PREFIX.len()..].to_lowercase().starts_with(LEGACY_RAW) {
            return Err(format!("data/raw/ 是遗留的原始副本，不在这里删：{rel}"));
        }
        let path = resolve(root, &clean)?;
        if !path.is_file() {
            continue;
        }
        std::fs::remove_file(&path).map_err(|err| format!("删除失败（{rel}）：{err}"))?;
        deleted += 1;
    }
    Ok(json!({ "deleted": deleted }))
}

// ---------- 源头同步（添加知识库与清洗前的源头同步共用） ----------

#[derive(Default)]
struct CopyStats {
    copied: usize,
    scanned: usize,
}

/// 把一个文件夹整棵复制进目标（目标不存在就创建）：内容有出入的文件覆盖、一样的跳过。
/// **只增改不删** —— 源头里删掉的文件在 raw 层保留（删除走界面上那个「删除文件」入口，
/// 那里才同时删得到两边）。目录不跟随符号链接；噪音目录（.git、node_modules…）与
/// 点开头的隐藏文件整棵跳过（与扫描同一条名单）。
fn copy_tree(source: &Path, target: &Path, stats: &mut CopyStats) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|err| format!("创建目录失败（{}）：{err}", target.display()))?;
    let entries = WalkDir::new(source)
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
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let inner = rel_of(source, entry.path());
        if inner.is_empty() {
            continue;
        }
        let dest = target.join(&inner);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|err| format!("创建目录失败（{}）：{err}", dest.display()))?;
            continue;
        }

        stats.scanned += 1;
        let bytes = std::fs::read(entry.path())
            .map_err(|err| format!("读取失败（{}）：{err}", entry.path().display()))?;
        // 内容一致就跳过（mtime 不作数：复制会刷新它，内容才是事实）
        let differs = match std::fs::read(&dest) {
            Ok(existing) => existing != bytes,
            Err(_) => true,
        };
        if !differs {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("创建目录失败（{}）：{err}", parent.display()))?;
        }
        std::fs::write(&dest, &bytes)
            .map_err(|err| format!("写入失败（{}）：{err}", dest.display()))?;
        stats.copied += 1;
    }
    Ok(())
}

/// 把源头文件夹同步进 `raw/<名字>/`：新增 / 有变化的文件复制进去，一样的跳过，**不删除**。
///
/// 添加知识库（目标还不存在 = 全量复制）与清洗前的源头同步（增量）共用这一条。
/// 源头文件夹必须存在、且与知识库文件夹互不重叠（见 check_disjoint）。
pub fn source_sync(root: &str, name: &str, dir: &str) -> Result<Value, String> {
    let base = root_path(root)?;
    let name = name_segment(name)?;
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("还没有指定源头文件夹".into());
    }
    let source = Path::new(dir);
    if !source.is_dir() {
        return Err(format!("找不到源头文件夹：{dir}"));
    }
    check_disjoint(&base, source)?;

    let mut stats = CopyStats::default();
    copy_tree(source, &base.join(RAW_PREFIX).join(name), &mut stats)?;
    Ok(json!({ "copied": stats.copied, "scanned": stats.scanned }))
}

/// 删掉一个知识库的两层：`raw/<名字>/` 与 `data/<名字>/`（存在才删）。
///
/// 这是**删仓库里的内容**，本机关联的源头文件夹一个字都不动（解除关联归渲染层改配置）。
pub fn delete_tree(root: &str, name: &str) -> Result<Value, String> {
    let base = root_path(root)?;
    let name = name_segment(name)?;
    let raw_dir = base.join(RAW_PREFIX).join(name);
    let data_dir = base.join(DATA_PREFIX).join(name);
    let mut removed_raw = false;
    let mut removed_data = false;
    if raw_dir.is_dir() {
        std::fs::remove_dir_all(&raw_dir)
            .map_err(|err| format!("删除原始数据失败（{}）：{err}", raw_dir.display()))?;
        removed_raw = true;
    }
    if data_dir.is_dir() {
        std::fs::remove_dir_all(&data_dir)
            .map_err(|err| format!("删除条目失败（{}）：{err}", data_dir.display()))?;
        removed_data = true;
    }
    Ok(json!({ "raw": removed_raw, "data": removed_data }))
}

/// 删一个原始文件：仓库里那份（`raw/<名字>/<内层>`）与**关联的源头文件夹里那份**一起删
/// —— 源头是持续关联的（清洗前还会从它复制），只删仓库里那份会在下一次源头同步时回来。
/// `dir` 为空串 = 这台机器没有关联（照常删仓库里那份）。删除后的条目清理与索引重建
/// 由渲染层编排。
pub fn file_delete(root: &str, name: &str, dir: &str, rels: &[String]) -> Result<Value, String> {
    let base = root_path(root)?;
    let name = name_segment(name)?;
    let prefix = format!("{RAW_PREFIX}{name}/");

    let source_root = match dir.trim() {
        "" => None,
        dir => {
            let path = Path::new(dir);
            if !path.is_dir() {
                return Err(format!("找不到源头文件夹：{dir}"));
            }
            check_disjoint(&base, path)?;
            Some(path.to_path_buf())
        }
    };

    let mut deleted = 0usize;
    for rel in rels {
        let clean = rel.replace('\\', "/");
        // 必须是这一层自己的文件：raw/<名字>/<内层>
        if !starts_with_ignore_case(&clean, &prefix) {
            return Err(format!("只能删除 raw/{name}/ 下的文件：{rel}"));
        }
        let inner = &clean[prefix.len()..];
        let repo_path = resolve(root, &clean)?;
        if repo_path.is_file() {
            std::fs::remove_file(&repo_path)
                .map_err(|err| format!("删除失败（{rel}）：{err}"))?;
            deleted += 1;
        }
        if let Some(source_root) = &source_root {
            let src = fs_util::resolve_under(
                source_root.to_str().unwrap_or(""),
                inner,
                "源头文件夹",
            )?;
            if src.is_file() {
                std::fs::remove_file(&src).map_err(|err| format!("删除源头文件失败（{inner}）：{err}"))?;
            }
        }
    }
    Ok(json!({ "deleted": deleted }))
}

/// 写清单文件（`raw/kb.json`）。内容由渲染层拼好（名字收敛与去重是渲染层的口径），
/// 这里只保证两件事：路径落在清单该在的位置、内容是**合法 JSON** —— 清单是机器读的，
/// 写坏了整页列表就没了。
pub fn config_write(root: &str, content: &str) -> Result<Value, String> {
    root_path(root)?;
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|err| format!("清单内容不是合法 JSON：{err}"))?;
    let path = resolve(root, MANIFEST_REL)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
    }
    std::fs::write(&path, content.as_bytes()).map_err(|err| format!("写清单失败：{err}"))?;
    Ok(json!({ "bytes": content.len() }))
}

// ---------- 一次性迁移（旧结构 → raw/ + data/） ----------

/// 渲染层带进来的一条「知识库 ↔ 本机源头文件夹」关联（名字 + 本机文件夹）：
/// 扫描时用它顺路给源头文件夹算内容指纹（状态判定「本地为准」用），
/// 迁移时用它把旧结构的来源复制进 raw。dir 为空串 / 打不开的跳过。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SourceLink {
    pub name: String,
    pub dir: String,
}

/// 旧结构一次性迁移：
///
/// 1. 各来源文件夹复制进 `raw/<名字>/`（跳过噪音；已存在的文件不动）；
/// 2. `kb/` 整体搬进 `data/`（保留内层结构；data 已存在时逐个挪进去，撞名如实失败）；
/// 3. 条目里的旧前缀改写：`data/raw/` → `raw/`（frontmatter 的 source 与正文里的
///    相对链接同一段写法，一并改对）；
/// 4. 删掉旧的 `index/` 生成物（新位置在 `data/index.json`，迁移后由应用重建）；
/// 5. 写清单（内容由渲染层拼好）。
///
/// 只能迁移一次：`raw/kb.json` 已存在时拒绝。迁移**不动**遗留的 `data/raw/` 原始副本
/// （用户自己的文件，应用不删）—— 它在新结构里没有任何身份，不算条目也不算原始数据。
pub fn migrate(root: &str, sources: &[SourceLink], manifest: &str) -> Result<Value, String> {
    let base = root_path(root)?;
    let manifest_path = resolve(root, MANIFEST_REL)?;
    if manifest_path.exists() {
        return Err("这个仓库已经是新结构了（raw/kb.json 已存在），不用再迁移".into());
    }
    let kb_dir = base.join("kb");
    if !kb_dir.is_dir() {
        return Err(format!("找不到旧条目目录：{}", kb_dir.display()));
    }

    // 1. 来源文件夹 → raw/<名字>/
    let mut copied = 0usize;
    for source in sources {
        let name = name_segment(&source.name)?;
        let dir = source.dir.trim();
        if dir.is_empty() {
            continue;
        }
        let path = Path::new(dir);
        if !path.is_dir() {
            return Err(format!("找不到来源文件夹（{name}）：{dir}"));
        }
        check_disjoint(&base, path)?;
        let mut stats = CopyStats::default();
        copy_tree(path, &base.join(RAW_PREFIX).join(name), &mut stats)?;
        copied += stats.copied;
    }

    // 2. kb/ → data/
    let data_dir = base.join(DATA_PREFIX);
    std::fs::create_dir_all(&data_dir).map_err(|err| format!("创建 data 目录失败：{err}"))?;
    let children =
        std::fs::read_dir(&kb_dir).map_err(|err| format!("读取 kb 目录失败：{err}"))?;
    for child in children {
        let child = child.map_err(|err| format!("读取 kb 目录失败：{err}"))?;
        let dest = data_dir.join(child.file_name());
        if dest.exists() {
            return Err(format!(
                "data/ 里已经有同名的东西：{}",
                child.file_name().to_string_lossy()
            ));
        }
        std::fs::rename(child.path(), &dest)
            .map_err(|err| format!("搬移失败（{}）：{err}", child.path().display()))?;
    }
    std::fs::remove_dir(&kb_dir).map_err(|err| format!("移除空的 kb 目录失败：{err}"))?;

    // 3. 旧前缀改写（只动 data/ 下的条目，不碰遗留的 data/raw/）
    let rewritten = rewrite_legacy_prefixes(&data_dir)?;

    // 4. 旧的 index/ 生成物删掉（新位置 data/index.json，之后由应用重建）
    let legacy_index = base.join("index");
    if legacy_index.is_dir() {
        std::fs::remove_dir_all(&legacy_index)
            .map_err(|err| format!("删除旧 index 目录失败：{err}"))?;
    }

    // 5. 清单落盘
    serde_json::from_str::<serde_json::Value>(manifest)
        .map_err(|err| format!("清单内容不是合法 JSON：{err}"))?;
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
    }
    std::fs::write(&manifest_path, manifest.as_bytes())
        .map_err(|err| format!("写清单失败：{err}"))?;

    Ok(json!({ "copied": copied, "rewritten": rewritten }))
}

/// 把 `data/` 下所有 `.md` 里的 `data/raw/` 改写成 `raw/`：frontmatter 的 source 与
/// 正文里指向原始资料的相对链接是同一段写法，一并改对。改过几个文件数几个；读不出
/// 的（编码 / 权限）跳过 —— 迁移不该因为一个文件整体失败。
fn rewrite_legacy_prefixes(data_dir: &Path) -> Result<usize, String> {
    let mut rewritten = 0usize;
    let entries = WalkDir::new(data_dir)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !crate::notes::is_skipped_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        });
    for entry in entries {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        // 遗留的 data/raw/ 副本一个字不改（它不属于任何一层）
        let inner = rel_of(data_dir, entry.path());
        if inner.to_lowercase().starts_with(LEGACY_RAW) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let replaced = text.replace("data/raw/", "raw/");
        if replaced != text {
            std::fs::write(entry.path(), replaced.as_bytes())
                .map_err(|err| format!("改写失败（{}）：{err}", entry.path().display()))?;
            rewritten += 1;
        }
    }
    Ok(rewritten)
}

// ---------- 索引重建 ----------
//
// 这是应用**唯一直接生成知识库索引的地方**，写的是生成物（`data/_catalog.md` 与
// `data/index.json`）、不是内容。索引只由应用生成：仓库转成纯数据后没有别的生成者，
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

/// 一个文件 → 索引里的一条（`rel` 是相对 `data/` 的路径）
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
        path: format!("{DATA_PREFIX}{rel}"),
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

/// 重建 `data/_catalog.md` 与 `data/index.json`，返回重建后的条目数。
///
/// `data/` 还没建（第一次添加、还没洗过）不算错误：按零条目重建，生成物照写。
pub fn index_build(root: &str, generated_at: &str) -> Result<Value, String> {
    let base = root_path(root)?;
    if !is_iso_date(generated_at) {
        return Err(format!("日期不合法：{generated_at}"));
    }

    let data_dir = base.join(DATA_PREFIX);
    let mut files: Vec<String> = Vec::new();
    if data_dir.is_dir() {
        for entry in WalkDir::new(&data_dir)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                // 遗留的 data/raw/ 副本整棵跳过（旧结构的库内原始副本，不算条目）
                if entry.depth() == 1
                    && entry.file_type().is_dir()
                    && entry.file_name().to_string_lossy() == "raw"
                {
                    return false;
                }
                !crate::notes::is_skipped_entry(
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
            // Windows 上后缀不分大小写；生成物（_catalog.md）不算条目
            if !name.to_lowercase().ends_with(".md") || name.eq_ignore_ascii_case(KB_CATALOG_NAME)
            {
                continue;
            }
            files.push(rel_of(&data_dir, entry.path()));
        }
    }
    // 按 Path 排序，在 Windows 上那是**大小写不敏感**的比较
    files.sort_by_key(|rel| rel.to_lowercase());

    let mut entries: Vec<IndexEntry> = Vec::new();
    for rel in &files {
        let text = std::fs::read_to_string(data_dir.join(rel))
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
        root: "data/",
        entries,
    })
    .map_err(|err| format!("生成索引失败：{err}"))?;

    std::fs::create_dir_all(&data_dir).map_err(|err| format!("创建 data 目录失败：{err}"))?;
    std::fs::write(data_dir.join(KB_CATALOG_NAME), windows_text(&catalog).as_bytes())
        .map_err(|err| format!("写目录失败：{err}"))?;
    std::fs::write(data_dir.join("index.json"), windows_text(&json_text).as_bytes())
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

    fn scan_rels(root: &str) -> Vec<String> {
        let result = scan(root, &[]).unwrap();
        result["entries"].as_array().cloned().unwrap_or_default()
            .iter()
            .map(|item| item["rel"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// 任意后缀都列出来（原始资料不一定是 markdown），文件夹也在清单里；
    /// 点开头的目录与依赖 / 构建产物整棵跳过；清单文件原文带回来。
    #[test]
    fn scans_every_file_type_and_returns_manifest() {
        let root = temp_root("scan");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/mu-ui")).unwrap();
        std::fs::create_dir_all(root.join("data/mu-ui/01-主题")).unwrap();
        std::fs::create_dir_all(root.join("data/raw/遗留")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("scripts/__pycache__")).unwrap();
        std::fs::write(root.join("README.md"), "readme").unwrap();
        std::fs::write(root.join("raw/kb.json"), "{\"kbs\":[]}").unwrap();
        std::fs::write(root.join("raw/mu-ui/button.md"), "原始").unwrap();
        std::fs::write(root.join("raw/手册.pdf"), "x").unwrap();
        std::fs::write(root.join("data/mu-ui/01-主题/a.md"), "条目").unwrap();
        std::fs::write(root.join("data/raw/遗留/old.md"), "旧副本").unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join("scripts/__pycache__/x.pyc"), "x").unwrap();

        let found = scan_rels(path);
        assert!(found.contains(&"README.md".to_string()), "{found:?}");
        assert!(found.contains(&"raw/mu-ui/button.md".to_string()), "{found:?}");
        assert!(found.contains(&"data/mu-ui/01-主题/a.md".to_string()), "{found:?}");
        assert!(
            !found.iter().any(|rel| rel.contains(".git") || rel.contains("__pycache__")),
            "噪音该整棵跳过: {found:?}"
        );
        // 遗留副本照样在清单里（它不参与任何口径，但扫描不撒谎）
        assert!(found.contains(&"data/raw/遗留/old.md".to_string()), "{found:?}");

        let result = scan(path, &[]).unwrap();
        assert_eq!(result["manifest"], "{\"kbs\":[]}", "清单原文带回来");

        // 每条都带自己的绝对路径
        let button = result["entries"].as_array().unwrap()
            .iter()
            .find(|item| item["rel"] == "raw/mu-ui/button.md")
            .unwrap();
        assert_eq!(button["abs"], root.join("raw").join("mu-ui").join("button.md").to_string_lossy().to_string());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 源头文件夹的指纹随扫描带回来：每个文件带源头内相对路径 + SHA-256；
    /// 名字不合法 / 打不开 / 与仓库重叠的关联跳过（退回以仓库副本判状态），不让整页失败
    #[test]
    fn scan_hashes_linked_source_files() {
        let root = temp_root("scan-local");
        let outside = temp_root("scan-local-outside");
        let root_str = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/mu-ui")).unwrap();
        std::fs::create_dir_all(outside.join("子目录")).unwrap();
        std::fs::write(outside.join("a.md"), "第一版").unwrap();
        std::fs::write(outside.join("子目录/b.txt"), "备注").unwrap();
        std::fs::create_dir_all(root.join("inside")).unwrap();

        let links = vec![
            SourceLink { name: "mu-ui".into(), dir: outside.to_str().unwrap().into() },
            // 打不开的文件夹：跳过
            SourceLink { name: "挂了".into(), dir: "Z:/wb-kb-not-there".into() },
            // 与仓库重叠：跳过
            SourceLink { name: "重叠".into(), dir: root.join("inside").to_str().unwrap().into() },
            // 名字不合法：跳过
            SourceLink { name: "a/b".into(), dir: outside.to_str().unwrap().into() },
        ];
        let result = scan(root_str, &links).unwrap();
        let local = result["local"].as_array().unwrap();

        let a = local.iter().find(|item| item["rel"] == "a.md").unwrap();
        assert_eq!(a["name"], "mu-ui");
        // 「第一版」的 SHA-256
        assert_eq!(
            a["hash"],
            "812f7047193410c913d8e95673ba09353bd79236e4642a0a08f97df36b4c5788"
        );
        assert_eq!(a["abs"], outside.join("a.md").to_string_lossy().to_string());
        let b = local.iter().find(|item| item["rel"] == "子目录/b.txt").unwrap();
        assert_eq!(
            b["hash"],
            "daede9881787abe74c94e686be78a4eabc85a09688433027ea55ac583919bc1e"
        );
        assert_eq!(local.len(), 2, "打不开 / 重叠 / 名字不合法的关联都跳过");

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// 读文件来回一趟；只认 raw/ 与 data/ 两层；越界一律挡住
    #[test]
    fn read_and_path_guards() {
        let root = temp_root("read");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/a")).unwrap();
        std::fs::create_dir_all(root.join("data/b")).unwrap();
        std::fs::write(root.join("raw/a/原始.md"), "原始").unwrap();
        std::fs::write(root.join("data/b/条目.md"), "# 标题").unwrap();
        std::fs::write(root.join("README.md"), "readme").unwrap();

        assert_eq!(read(path, "raw/a/原始.md", &[]).unwrap(), "原始");
        assert_eq!(read(path, "data/b/条目.md", &[]).unwrap(), "# 标题");
        // Windows 反斜杠的写法也认（渲染层一般传 `/`，这里兜住）
        assert_eq!(read(path, "data\\b\\条目.md", &[]).unwrap(), "# 标题");

        // 仓库根下的其他文件不对外读
        assert!(read(path, "README.md", &[]).is_err());
        assert!(read(path, "kb/条目.md", &[]).is_err());
        assert!(read(path, "../别的目录/秘密.md", &[]).is_err());
        assert!(read(path, "C:/Windows/win.ini", &[]).is_err());
        assert!(read(path, "raw/a/../../外.md", &[]).is_err());
        assert!(read(path, "raw/a/不存在的.md", &[]).is_err());

        assert!(scan("   ", &[]).is_err());
        assert!(scan("wb-kb-not-there", &[]).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 有关联的知识库读文件优先读本机源头那份（最新内容）：本机没有 / 文件夹打不开 /
    /// 关联重叠时回落仓库副本；data/ 层不经关联
    #[test]
    fn read_prefers_the_linked_source_copy() {
        let root = temp_root("read-link");
        let outside = temp_root("read-link-outside");
        let root_str = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/b")).unwrap();
        std::fs::create_dir_all(root.join("data/b")).unwrap();
        std::fs::create_dir_all(root.join("inside")).unwrap();
        std::fs::write(root.join("raw/b/b.md"), "仓库里的旧版").unwrap();
        std::fs::write(root.join("data/b/条目.md"), "# 条目").unwrap();
        // rel `raw/b/b.md` 的内层是 `b.md`：本机那份在源头根下
        std::fs::write(outside.join("b.md"), "本机的最新版").unwrap();

        let links = vec![SourceLink { name: "b".into(), dir: outside.to_str().unwrap().into() }];
        // 本机有这份：读本机的
        assert_eq!(read(root_str, "raw/b/b.md", &links).unwrap(), "本机的最新版");
        // 内层越界挡得住：回落仓库副本，仓库里也没有这个文件 → 如实失败
        assert!(read(root_str, "raw/b/../秘密.md", &links).is_err());
        // 没关联的调用（links 空）：读仓库副本
        assert_eq!(read(root_str, "raw/b/b.md", &[]).unwrap(), "仓库里的旧版");
        // data/ 层不经关联
        assert_eq!(read(root_str, "data/b/条目.md", &links).unwrap(), "# 条目");

        // 关联的文件夹打不开：回落仓库副本
        let dead = vec![SourceLink { name: "b".into(), dir: "Z:/wb-kb-not-there".into() }];
        assert_eq!(read(root_str, "raw/b/b.md", &dead).unwrap(), "仓库里的旧版");

        // 关联与仓库重叠：忽略这个关联，读仓库副本
        let overlapping = vec![SourceLink { name: "b".into(), dir: root_str.into() }];
        assert_eq!(read(root_str, "raw/b/b.md", &overlapping).unwrap(), "仓库里的旧版");

        // 本机没有这个文件：回落仓库副本
        std::fs::remove_file(outside.join("b.md")).unwrap();
        assert_eq!(read(root_str, "raw/b/b.md", &links).unwrap(), "仓库里的旧版");

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// 指纹只认 raw/ 与 data/（读不到的跳过）；删除只认 data/ 下的 .md，
    /// 生成物、遗留副本与越界一律挡掉
    #[test]
    fn fingerprints_and_delete_are_scoped() {
        let root = temp_root("fingerprint");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/mu-ui")).unwrap();
        std::fs::create_dir_all(root.join("data/mu-ui/01-主题")).unwrap();
        std::fs::create_dir_all(root.join("data/raw/遗留")).unwrap();
        std::fs::write(root.join("raw/mu-ui/a.md"), "abc").unwrap();
        std::fs::write(root.join("data/mu-ui/01-主题/a.md"), "条目").unwrap();
        std::fs::write(root.join("data/_catalog.md"), "目录").unwrap();
        std::fs::write(root.join("data/raw/遗留/old.md"), "旧副本").unwrap();

        let hashes = fingerprints(
            path,
            &[
                "raw/mu-ui/a.md".to_string(),
                "raw/mu-ui/none.md".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            hashes["raw/mu-ui/a.md"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(hashes.get("raw/mu-ui/none.md").is_none(), "读不到的跳过");

        assert!(delete_entries(path, &["data/_catalog.md".into()]).is_err());
        assert!(delete_entries(path, &["raw/mu-ui/a.md".into()]).is_err(), "原始文件不在这里删");
        assert!(delete_entries(path, &["data/raw/遗留/old.md".into()]).is_err(), "遗留副本不在这里删");
        assert!(delete_entries(path, &["data/mu-ui/../x.md".into()]).is_err());
        let deleted = delete_entries(
            path,
            &["data/mu-ui/01-主题/a.md".into(), "data/mu-ui/01-主题/已经没了.md".into()],
        )
        .unwrap();
        assert_eq!(deleted["deleted"], 1);
        assert!(!root.join("data/mu-ui/01-主题/a.md").exists());
        assert!(root.join("data/_catalog.md").exists(), "生成物不该被删掉");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 源头同步：全量复制带子目录、跳过噪音；内容一致跳过、有出入覆盖；**只增改不删**。
    /// 源头与仓库重叠（谁套住谁都算）与不合法的名字一律拒。
    #[test]
    fn source_sync_copies_changed_files() {
        let root = temp_root("sync");
        let outside = temp_root("sync-outside");
        let root_str = root.to_str().unwrap();
        let out_str = outside.to_str().unwrap();
        std::fs::create_dir_all(outside.join("子目录")).unwrap();
        std::fs::create_dir_all(outside.join("node_modules")).unwrap();
        std::fs::write(outside.join("a.md"), "第一版").unwrap();
        std::fs::write(outside.join("子目录/b.txt"), "备注").unwrap();
        std::fs::write(outside.join("node_modules/x.js"), "噪音").unwrap();
        std::fs::write(outside.join(".gitignore"), "x").unwrap();

        let result = source_sync(root_str, "mu-ui", out_str).unwrap();
        assert_eq!(result["copied"], 2, "只算文件，噪音与隐藏文件不算");
        assert!(root.join("raw/mu-ui/a.md").exists());
        assert!(root.join("raw/mu-ui/子目录/b.txt").exists());
        assert!(!root.join("raw/mu-ui/node_modules").exists(), "噪音目录整棵跳过");
        assert!(!root.join("raw/mu-ui/.gitignore").exists(), "隐藏文件跳过（扫描也看不见它）");

        // 内容没变：再跑一遍一个都不复制；源头改了：覆盖；源头删了：raw 里保留
        let again = source_sync(root_str, "mu-ui", out_str).unwrap();
        assert_eq!(again["copied"], 0);
        std::fs::write(outside.join("a.md"), "第二版").unwrap();
        std::fs::remove_file(outside.join("子目录/b.txt")).unwrap();
        let third = source_sync(root_str, "mu-ui", out_str).unwrap();
        assert_eq!(third["copied"], 1);
        assert_eq!(std::fs::read_to_string(root.join("raw/mu-ui/a.md")).unwrap(), "第二版");
        assert!(root.join("raw/mu-ui/子目录/b.txt").exists(), "只增改不删");

        // 源头在仓库里 / 不存在：都拒
        std::fs::create_dir_all(root.join("inside")).unwrap();
        assert!(source_sync(root_str, "x", root.join("inside").to_str().unwrap()).is_err());
        assert!(source_sync(root_str, "x", "Z:/wb-kb-not-there").is_err());
        assert!(source_sync(root_str, "a/b", out_str).is_err(), "名字带分隔符要拒");
        assert!(source_sync(root_str, "..", out_str).is_err());
        assert!(source_sync(root_str, "mu-ui", "  ").is_err(), "没指定源头要拒");

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// 删知识库：raw/<名>/ 与 data/<名>/ 两层一起删（存在才删）；名字不合法要拒
    #[test]
    fn delete_tree_removes_both_layers() {
        let root = temp_root("delete-tree");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/a")).unwrap();
        std::fs::create_dir_all(root.join("data/a/01-主题")).unwrap();
        std::fs::create_dir_all(root.join("raw/别的")).unwrap();
        std::fs::write(root.join("raw/a/x.md"), "x").unwrap();
        std::fs::write(root.join("data/a/01-主题/y.md"), "y").unwrap();

        let result = delete_tree(path, "a").unwrap();
        assert_eq!(result["raw"], true);
        assert_eq!(result["data"], true);
        assert!(!root.join("raw/a").exists());
        assert!(!root.join("data/a").exists());
        assert!(root.join("raw/别的").exists(), "别的知识库不动");

        let again = delete_tree(path, "a").unwrap();
        assert_eq!(again["raw"], false, "不存在时如实回 false");
        assert_eq!(again["data"], false);

        assert!(delete_tree(path, "a/b").is_err());
        assert!(delete_tree(path, "..").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 删一个原始文件：仓库里那份与关联的源头文件一起删；只认 raw/<名>/ 下的路径；
    /// 没有关联（dir 空串）时只删仓库里那份
    #[test]
    fn file_delete_removes_both_copies() {
        let root = temp_root("file-delete");
        let outside = temp_root("file-delete-outside");
        let root_str = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("raw/mu-ui/子目录")).unwrap();
        std::fs::create_dir_all(outside.join("子目录")).unwrap();
        std::fs::write(root.join("raw/mu-ui/a.md"), "x").unwrap();
        std::fs::write(root.join("raw/mu-ui/子目录/b.md"), "y").unwrap();
        std::fs::write(outside.join("a.md"), "x").unwrap();
        std::fs::write(outside.join("子目录/b.md"), "y").unwrap();

        let result = file_delete(
            root_str,
            "mu-ui",
            outside.to_str().unwrap(),
            &["raw/mu-ui/a.md".to_string(), "raw/mu-ui/子目录/b.md".to_string()],
        )
        .unwrap();
        assert_eq!(result["deleted"], 2);
        assert!(!root.join("raw/mu-ui/a.md").exists());
        assert!(!outside.join("a.md").exists(), "源头里那份一起删");
        assert!(!outside.join("子目录/b.md").exists());

        // 没有关联：只删仓库里那份
        std::fs::write(root.join("raw/mu-ui/c.md"), "z").unwrap();
        let only = file_delete(root_str, "mu-ui", "", &["raw/mu-ui/c.md".to_string()]).unwrap();
        assert_eq!(only["deleted"], 1);
        assert!(!root.join("raw/mu-ui/c.md").exists());

        // 边界：别的知识库的文件、越界、名字不合法
        assert!(
            file_delete(root_str, "别的", "", &["raw/mu-ui/a.md".to_string()]).is_err(),
            "只能删自己那层"
        );
        assert!(file_delete(root_str, "mu-ui", "", &["raw/mu-ui/../../x".to_string()]).is_err());
        assert!(file_delete(root_str, "../x", "", &["raw/x/a.md".to_string()]).is_err());

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// 写清单：内容必须是合法 JSON，路径固定在 raw/kb.json（目录不存在就建）
    #[test]
    fn config_write_validates_json() {
        let root = temp_root("config");
        let path = root.to_str().unwrap();

        config_write(path, "{\"version\":1,\"kbs\":[{\"name\":\"a\"}]}").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("raw/kb.json")).unwrap(),
            "{\"version\":1,\"kbs\":[{\"name\":\"a\"}]}"
        );

        assert!(config_write(path, "not json").is_err(), "写坏清单等于砸掉列表，要拦");
        assert!(config_write("wb-kb-not-there", "{}").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// AGENTS.md：仓库根没有就生成（应用口径的说明），有就不动
    #[test]
    fn agents_doc_is_generated_once() {
        let root = temp_root("agents-doc");
        let path = root.to_str().unwrap();

        let first = agents_doc_write(path).unwrap();
        assert_eq!(first["written"], true);
        let text = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
        assert!(text.contains("raw/<知识库名>"), "描述原始数据层");
        assert!(text.contains("data/<知识库名>"), "描述条目层");
        assert!(text.contains("不要手工编辑 `data/`"), "给 AI 的用法说明在");

        // 已存在时不覆盖（用户可能补了自己的说明）
        std::fs::write(root.join("AGENTS.md"), "用户自己的说明").unwrap();
        let again = agents_doc_write(path).unwrap();
        assert_eq!(again["written"], false);
        assert_eq!(std::fs::read_to_string(root.join("AGENTS.md")).unwrap(), "用户自己的说明");

        assert!(agents_doc_write("wb-kb-not-there").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 一次性迁移：来源复制进 raw/、kb/ 搬进 data/、旧前缀改写、旧 index/ 删除、清单落盘；
    /// 只能迁移一次；遗留的 data/raw/ 一个字不动。
    #[test]
    fn migrate_moves_everything_into_place() {
        let root = temp_root("migrate");
        let outside = temp_root("migrate-outside");
        let root_str = root.to_str().unwrap();
        std::fs::create_dir_all(outside.join("子目录")).unwrap();
        std::fs::write(outside.join("a.md"), "原始").unwrap();
        std::fs::write(outside.join("子目录/b.md"), "备注").unwrap();
        std::fs::create_dir_all(root.join("kb/01-主题")).unwrap();
        std::fs::create_dir_all(root.join("data/raw/遗留")).unwrap();
        std::fs::create_dir_all(root.join("index")).unwrap();
        std::fs::write(
            root.join("kb/01-主题/条目.md"),
            "---\ntitle: 条目\nsource: data/raw/mu-ui/a.md\n---\n正文，另见 [原始](../../data/raw/mu-ui/a.md)\n",
        )
        .unwrap();
        std::fs::write(root.join("index/index.json"), "{}").unwrap();
        std::fs::write(root.join("data/raw/遗留/old.md"), "旧副本").unwrap();

        let result = migrate(
            root_str,
            &[SourceLink { name: "mu-ui".into(), dir: outside.to_str().unwrap().into() }],
            "{\"version\":1,\"kbs\":[{\"name\":\"mu-ui\",\"created\":\"2026-11-14\"}]}",
        )
        .unwrap();
        assert_eq!(result["copied"], 2);
        assert_eq!(result["rewritten"], 1);

        // 来源进了 raw/<名>/
        assert_eq!(std::fs::read_to_string(root.join("raw/mu-ui/a.md")).unwrap(), "原始");
        assert!(root.join("raw/mu-ui/子目录/b.md").exists());
        // kb/ 整体搬进 data/，frontmatter 与正文里的旧前缀一起改写
        assert!(!root.join("kb").exists());
        let entry_text = std::fs::read_to_string(root.join("data/01-主题/条目.md")).unwrap();
        assert!(entry_text.contains("source: raw/mu-ui/a.md"), "{entry_text}");
        assert!(entry_text.contains("(../../raw/mu-ui/a.md)"), "{entry_text}");
        // 旧 index/ 删掉、清单落盘、遗留副本不动
        assert!(!root.join("index").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("raw/kb.json")).unwrap(),
            "{\"version\":1,\"kbs\":[{\"name\":\"mu-ui\",\"created\":\"2026-11-14\"}]}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("data/raw/遗留/old.md")).unwrap(),
            "旧副本",
            "遗留副本一个字不动"
        );

        // 只能迁移一次；kb/ 没了之后也要明说
        assert!(migrate(root_str, &[], "{}").is_err());

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// 迁移撞名（data/ 里已经有同名的）如实失败，不悄悄合并
    #[test]
    fn migrate_refuses_name_collisions() {
        let root = temp_root("migrate-clash");
        let root_str = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("kb/raw")).unwrap();
        std::fs::create_dir_all(root.join("data/raw")).unwrap();
        std::fs::write(root.join("kb/raw/x.md"), "x").unwrap();

        assert!(migrate(root_str, &[], "{}").is_err());

        std::fs::remove_dir_all(&root).unwrap();
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

    /// 索引重建：目录与 index.json 的**实际内容**（换行按 CRLF 写盘）；data/ 不在时按零条目重建
    #[test]
    fn index_build_writes_the_catalog_and_index() {
        let root = temp_root("index");
        let path = root.to_str().unwrap();
        std::fs::create_dir_all(root.join("data/mu-ui/01-示例")).unwrap();
        std::fs::create_dir_all(root.join("data/mu-ui/02-另外")).unwrap();
        std::fs::create_dir_all(root.join("data/raw/遗留")).unwrap();
        std::fs::write(
            root.join("data/mu-ui/01-示例/有元数据.md"),
            "---\ntitle: \"有元数据\"\ntags: [alpha, beta]\ncreated: 2026-09-01\nupdated: 2026-09-02\nstatus: reviewed\nsummary: 一句话摘要\n---\n# 正文标题\n\n正文。\n",
        )
        .unwrap();
        std::fs::write(
            root.join("data/mu-ui/02-另外/裸标题.md"),
            "# 裸标题\n\n这是裸条目的第一段。\n\n第二段。\n",
        )
        .unwrap();
        std::fs::write(root.join("data/raw/遗留/old.md"), "旧副本").unwrap();
        // 生成物不该被当成条目（跑第二遍时它就在那儿了）
        std::fs::write(root.join("data/_catalog.md"), "上一轮的目录").unwrap();

        let result = index_build(path, "2026-09-28").unwrap();
        assert_eq!(result["count"], 2);

        let catalog = std::fs::read_to_string(root.join("data/_catalog.md")).unwrap();
        assert!(catalog.contains("\r\n"), "写盘是 CRLF");
        assert_eq!(
            catalog.replace("\r\n", "\n"),
            concat!(
                "<!-- 本文件由 Workbench 自动生成，请勿手改 -->\n",
                "\n",
                "# 知识库目录\n",
                "\n",
                "## data/mu-ui/01-示例\n",
                "\n",
                "- [有元数据](data/mu-ui/01-示例/有元数据.md) `alpha` `beta` — 一句话摘要\n",
                "\n",
                "## data/mu-ui/02-另外\n",
                "\n",
                // 没有标签的那行多一个空格（既有生成物的形状），照样保留
                "- [裸标题](data/mu-ui/02-另外/裸标题.md)  — 这是裸条目的第一段。\n",
            )
        );

        let index = std::fs::read_to_string(root.join("data/index.json")).unwrap();
        assert_eq!(
            index.replace("\r\n", "\n"),
            concat!(
                "{\n",
                "  \"generated_at\": \"2026-09-28\",\n",
                "  \"count\": 2,\n",
                "  \"root\": \"data/\",\n",
                "  \"entries\": [\n",
                "    {\n",
                "      \"path\": \"data/mu-ui/01-示例/有元数据.md\",\n",
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
                "      \"path\": \"data/mu-ui/02-另外/裸标题.md\",\n",
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

        // 第二遍不把生成物当条目；遗留副本也不进索引
        let again = index_build(path, "2026-09-29").unwrap();
        assert_eq!(again["count"], 2);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 重建索引的两条边界：data/ 还没建（第一次添加、还没洗过）按零条目重建；
    /// 日期不是 `YYYY-MM-DD` 要挡住
    #[test]
    fn index_build_edge_cases() {
        let root = temp_root("index-edge");
        let path = root.to_str().unwrap();

        assert!(index_build(path, "2026/09/28").is_err(), "日期形状不对要挡住");
        assert!(index_build(path, "").is_err());
        let empty = index_build(path, "2026-09-28").unwrap();
        assert_eq!(empty["count"], 0, "data/ 不在时按零条目重建");
        assert!(root.join("data/index.json").exists());

        std::fs::remove_dir_all(&root).unwrap();
        assert!(index_build(path, "2026-09-28").is_err(), "目录不在了就该明说");
    }
}
