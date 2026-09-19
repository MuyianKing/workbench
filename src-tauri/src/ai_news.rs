//! AI 行业每日热点（首页「AI 热点」卡片）：热点源白名单与拉取。
//!
//! **联网边界（重要）**：这个出口**只在首页真的画着那张卡片、且到了该源自己的刷新间隔**时才走
//! （卡片被关掉就不渲染，也就不会去取）；地址写在下面的 `SOURCES` 里 —— 渲染层只能报源 id、
//! 拼不出任意 URL，所以「应用会访问哪儿」是一份看得完的清单。清单里只收**免费、不需要凭据**的中文源
//! （曾经有过 Hugging Face 每日论文、arXiv cs.AI 两个英文源与一个需要用户填 token 的机器之心，都按要求撤掉了）。
//!
//! **职责分工与项目约定一致**：这一层只做「取原始数据（带 ETag 条件请求）/ 落盘 / 调系统能力」，
//! 解析、去重、排序、每源缓存与退避策略全在 TS 侧（`src/shared/ai-news.ts`，那边有单测、
//! 改起来走 Vite 热更新）。所以拉取命令回给渲染层的是**原始文本与状态码**，
//! 由适配层解析收敛后调 `ai_news_save` 整份写回（防抖在 Rust 侧，300ms 合并一次）。

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

use crate::http;
use crate::paths;
use crate::store::JsonStore;

/// 一个热点源的固定定义。`id` 是渲染层唯一认得的东西。
struct SourceSpec {
    id: &'static str,
    name: &'static str,
    /// 完整地址（含查询串）。**白名单就在这里**，别处不接受任意 URL。
    url: &'static str,
    /// 载荷格式，与 `src/shared/ai-news.ts` 的 `AiNewsSourceFormat` 对齐
    format: &'static str,
    /// 建议的刷新间隔（毫秒）
    ttl_ms: u64,
    /// 站内阅读允许抓的正文域名（后缀匹配，带不带 `www.` 都认）。
    ///
    /// 这是**第二道白名单**：正文地址来自各源的 feed，但 feed 的内容不受我们控制，
    /// 所以抓之前还要核一遍域名 —— 否则一条被污染的 feed 就能让应用去访问任意主机。
    /// 只列源站自己的域名，别把 CDN、图床之类加进来。
    article_hosts: &'static [&'static str],
}

/// 热点源清单。
///
/// **只放中文源**：这张卡片挂在中文界面上，混进英文标题读起来是两种东西
/// （曾经有过 Hugging Face 每日论文与 arXiv cs.AI 两个英文源，按要求撤掉了）。
///
/// **顺序就是合并视图里同一条新闻的去重优先级**（先到先得）。
/// 加源时只改这里：`src/shared/ai-news.ts` 不需要跟着改（它按 format 分发解析器）。
const SOURCES: &[SourceSpec] = &[SourceSpec {
    id: "qbitai",
    name: "量子位",
    url: "https://www.qbitai.com/feed",
    format: "rss",
    // 中文 AI 媒体，一天更新多次；实测连打 5 次无任何限流
    ttl_ms: 3 * 60 * 60 * 1000,
    article_hosts: &["qbitai.com"],
}];

/// `ai-news.json` 的去抖存储：与工作日志同一待遇（只在本机，不进同步仓库）
static AI_NEWS: OnceLock<JsonStore> = OnceLock::new();

pub fn ai_news_store() -> &'static JsonStore {
    AI_NEWS.get_or_init(|| JsonStore::new(paths::ai_news_file, "保存 AI 热点"))
}

// ---------- 数据文件 ----------

#[tauri::command]
pub fn ai_news_load() -> Value {
    ai_news_store().get()
}

#[tauri::command]
pub fn ai_news_save(value: Value) {
    ai_news_store().set(value);
    ai_news_store().schedule();
}

// ---------- 源清单 ----------

/// 送到渲染层的源信息（字段名与 `shared/ai-news.ts` 的 `AiNewsSourceInfo` 一致）。
///
/// **不带地址**：拉取时宿主自己查 `SOURCES`，渲染层只报 id 就够 ——
/// 它因此拿不到一个能出网的字符串，这一条是那道联网边界的一半。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNewsSourceInfo {
    id: String,
    name: String,
    format: String,
    ttl_ms: u64,
}

/// 源清单。适配层问它来知道「有哪些源、各自的刷新间隔与载荷格式」。
#[tauri::command]
pub fn ai_news_sources() -> Vec<AiNewsSourceInfo> {
    SOURCES
        .iter()
        .map(|source| AiNewsSourceInfo {
            id: source.id.to_string(),
            name: source.name.to_string(),
            format: source.format.to_string(),
            ttl_ms: source.ttl_ms,
        })
        .collect()
}

// ---------- 凭据 ----------

// ---------- 拉取 ----------

/// 一次拉取的结果：状态码 + 原始文本 + 新 ETag，交给 TS 侧判断 200 / 304 / 429。
#[derive(Serialize, Debug)]
pub struct AiNewsFetchResult {
    /// 200 = 有新内容；304 = 没变（条件请求）；429 = 被限流；其余是服务端错误
    pub status: u16,
    /// 原文（解析在 TS 侧）。304 时为空串 —— 服务端没回正文
    pub body: String,
    /// 这次响应里的 ETag；服务端没给时是空串
    pub etag: String,
}

/// 拉一个源。**会出网**：调用方只在「卡片画着、且到了这个源自己的刷新间隔」时才调它。
///
/// `etag` 是上一次成功拉取时存下的条件请求标记：带 `If-None-Match` 后，服务端内容没变
/// 会回 304 而不是一整份正文 —— 省流量，也少一次对源站的消耗。
#[tauri::command(async)]
pub fn ai_news_fetch(source_id: String, etag: String) -> Result<AiNewsFetchResult, String> {
    let source = SOURCES
        .iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| format!("未知的热点源：{source_id}"))?;

    let (host, path) = split_url(source.url)?;
    let mut headers = vec![("User-Agent", "Workbench")];
    if !etag.is_empty() {
        headers.push(("If-None-Match", etag.as_str()));
    }

    let response = http::request("GET", &host, &path, &headers, None)?;
    Ok(AiNewsFetchResult {
        status: response.status,
        body: response.text(),
        etag: response.etag.unwrap_or_default(),
    })
}

/// 站内阅读：抓一条热点的**正文页**，回给渲染层原始 HTML（正文提取在 TS 侧做）。
///
/// **只允许抓热点源自己的域名**（见 `SourceSpec::article_hosts`）：正文地址虽然来自各源的 feed，
/// 但 feed 的内容不由我们控制，所以这里再核一遍域名 —— 域名不在白名单里就直接拒绝。
/// 页面里的脚本不会被我们执行（这里只取文本交给渲染层按纯文本显示）。
///
/// **用户点开某一条时才会调用**，不是后台预取：十条热点就是十次多余的请求，没必要。
#[tauri::command(async)]
pub fn ai_news_article(url: String) -> Result<String, String> {
    let (host, path) = split_url(&url)?;
    if !is_article_host_allowed(&host) {
        return Err(format!("拒绝抓取：{host} 不在热点源的域名白名单里"));
    }

    let response = http::request("GET", &host, &path, &[("User-Agent", "Workbench")], None)?;
    if response.status != 200 {
        return Err(format!("原文页面返回 HTTP {}", response.status));
    }
    Ok(response.text())
}

/// 这个主机名是不是某个热点源自己的域名（后缀匹配，`www.` / `pro.` 这类子域一并认）
fn is_article_host_allowed(host: &str) -> bool {
    SOURCES.iter().any(|source| {
        source
            .article_hosts
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    })
}

/// 把白名单里的地址拆成 WinHTTP 要的 host 与 path+query，并守住两条底线：
/// **只走 HTTPS**（客户端只实现了 443 的加密连接）、**只走默认端口**。
fn split_url(url: &str) -> Result<(String, String), String> {
    let parsed = url::Url::parse(url).map_err(|err| format!("热点源地址不合法：{err}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("热点源只支持 https：{url}"));
    }
    if let Some(port) = parsed.port() {
        if port != 443 {
            return Err(format!("热点源只支持默认端口：{url}"));
        }
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("热点源地址里没有主机名：{url}"))?
        .to_string();

    let mut path = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    Ok((host, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 源 id 不重复、地址都可拆（https + 默认端口）—— 加源时打错字会在这一步被拦住
    #[test]
    fn every_source_is_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for source in SOURCES {
            assert!(seen.insert(source.id), "源 id 重复：{}", source.id);
            assert!(!source.name.trim().is_empty(), "源 {} 没有名字", source.id);
            assert!(source.ttl_ms > 0, "源 {} 的刷新间隔得是正数", source.id);
            let (host, path) = split_url(source.url).unwrap_or_else(|err| panic!("{}: {err}", source.id));
            assert!(!host.is_empty() && path.starts_with('/'), "源 {} 拆出来的地址不对", source.id);
        }
    }

    /// 清单非空：一个源都不剩的话这张卡片就没有内容可拉，多半是误删
    #[test]
    fn list_is_never_empty() {
        assert!(!SOURCES.is_empty(), "热点源清单被清空了");
    }

    /// 卡片只放中文源：英文源撤掉之后不该有人偷偷加回来
    #[test]
    fn sources_are_chinese_only() {
        for source in SOURCES {
            assert!(
                !source.id.contains("arxiv") && !source.id.contains("hf-"),
                "源 {} 看起来是个英文源（这张卡片只放中文内容）",
                source.id
            );
        }
    }

    /// 非 https / 非默认端口一律拒绝（客户端只实现了 443 的加密连接）
    #[test]
    fn rejects_non_https_and_odd_ports() {
        assert!(split_url("http://example.com/feed").is_err());
        assert!(split_url("https://example.com:8443/feed").is_err());
        assert!(split_url("https://example.com/feed").is_ok());
    }

    /// 查询串要原样带进 path（将来加带参数的源时，滤掉 query 就会静默拿到别的结果）
    #[test]
    fn keeps_the_query_string() {
        let (host, path) = split_url("https://example.com/api/feed?limit=30&sort=hot").unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(path, "/api/feed?limit=30&sort=hot");
    }

    /// 未知源 id 直接报错，不会去访问任何地址
    #[test]
    fn unknown_source_is_rejected() {
        let result = ai_news_fetch("no-such-source".into(), String::new());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未知的热点源"));
    }

    /// 每个源都要声明正文域名，且写得规范（不带 scheme、不带路径、不带点前缀）
    #[test]
    fn every_source_declares_article_hosts() {
        for source in SOURCES {
            assert!(
                !source.article_hosts.is_empty(),
                "源 {} 没有声明正文域名，站内阅读会全被拒",
                source.id
            );
            for host in source.article_hosts {
                assert!(
                    !host.contains('/') && !host.contains(':') && !host.starts_with('.'),
                    "源 {} 的正文域名写法不对：{host}",
                    source.id
                );
            }
        }
    }

    /// 正文域名白名单：认源站自己的域名与它的子域，别的一律拒
    #[test]
    fn article_hosts_are_allowlisted_strictly() {
        assert!(is_article_host_allowed("qbitai.com"));
        assert!(is_article_host_allowed("www.qbitai.com"));

        // 后缀拼接不算：evil-qbitai.com / qbitai.com.evil.com 都不是源站的域名
        assert!(!is_article_host_allowed("evil-qbitai.com"));
        assert!(!is_article_host_allowed("qbitai.com.evil.com"));
        assert!(!is_article_host_allowed("evil.com"));
        assert!(!is_article_host_allowed(""));
    }

    /// 白名单外的地址在**发请求之前**就被拒（返回值不是网络错误，而是拒绝说明）
    #[test]
    fn article_fetch_rejects_hosts_outside_the_allowlist() {
        let result = ai_news_article("https://evil.com/article.html".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不在热点源的域名白名单"));

        // 非 https 同样在发请求之前被拦下
        assert!(ai_news_article("http://www.qbitai.com/2026/09/1.html".into()).is_err());
    }
}