//! AI 行业每日热点（首页「AI 热点」卡片）：热点源白名单、拉取与凭据。
//!
//! **联网边界（重要）**：这一组出口都由用户显式开启，而且**地址写在下面的 `SOURCES` 里**——
//! 渲染层只能报源 id，拼不出任意 URL，所以「应用会访问哪儿」是一份看得完的清单。
//! 默认启用的两个源（量子位、Hugging Face 每日论文）都免费、不需要 token；
//! 需要 token 的源（机器之心）由用户自己填，token 落在 Windows 凭据管理器里、不进任何 JSON。
//!
//! **职责分工与项目约定一致**：这一层只做「取原始数据（带 ETag 条件请求）/ 落盘 / 调系统能力」，
//! 解析、去重、排序、每源缓存与退避策略全在 TS 侧（`src/shared/ai-news.ts`，那边有单测、
//! 改起来走 Vite 热更新）。所以拉取命令回给渲染层的是**原始文本与状态码**，
//! 由适配层解析收敛后调 `ai_news_save` 整份写回（防抖在 Rust 侧，300ms 合并一次）。

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

use crate::credentials;
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
    /// 是否需要用户填 token 才能用
    needs_token: bool,
    /// 建议的刷新间隔（毫秒）
    ttl_ms: u64,
    /// 设置界面里的一句说明
    note: &'static str,
    /// 需要 token 的源用哪条凭据（别的源为 None）
    credential: Option<&'static str>,
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
/// **顺序就是合并视图里同一条新闻的去重优先级**（先到先得），所以中文源排在前面。
/// 加源时只改这里：`src/shared/ai-news.ts` 不需要跟着改（它按 format 分发解析器）。
const SOURCES: &[SourceSpec] = &[
    SourceSpec {
        id: "qbitai",
        name: "量子位",
        url: "https://www.qbitai.com/feed",
        format: "rss",
        needs_token: false,
        // 中文 AI 媒体，一天更新多次；实测连打 5 次无任何限流
        ttl_ms: 3 * 60 * 60 * 1000,
        note: "中文 AI 媒体，免费、无需 token",
        credential: None,
        article_hosts: &["qbitai.com"],
    },
    SourceSpec {
        id: "jiqizhixin",
        name: "机器之心",
        url: "https://mcp.applications.jiqizhixin.com/rss",
        format: "rss",
        needs_token: true,
        // 服务端响应头声明内容按天更新，且配额很紧（实测第二次请求就 429）
        ttl_ms: 24 * 60 * 60 * 1000,
        note: "需要填 RSS token，配额有限（按天算），内容按天更新",
        credential: Some("jiqizhixin-rss"),
        // 会员文落在 pro. 子域，所以两个域名都算
        article_hosts: &["jiqizhixin.com"],
    },
];

/// `ai-news.json` 的去抖存储：与工作日志同一待遇（只在本机，不进同步仓库）
static AI_NEWS: OnceLock<JsonStore> = OnceLock::new();

pub fn ai_news_store() -> &'static JsonStore {
    AI_NEWS.get_or_init(|| JsonStore::new(paths::ai_news_file, "保存 AI 热点"))
}

/// 需要 token 的源用的那条凭据。
///
/// 目前只有机器之心一个需要 token，所以「哪条凭据」是唯一的；将来多一个这样的源，
/// 这里要改成按源 id 取凭据，命令也得跟着带上源 id。
fn token_credential() -> Option<&'static str> {
    SOURCES.iter().find_map(|source| source.credential)
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

/// 送到渲染层的源信息（字段名与 `shared/ai-news.ts` 的 `AiNewsSourceInfo` 一致）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNewsSourceInfo {
    id: String,
    name: String,
    url: String,
    format: String,
    needs_token: bool,
    ttl_ms: u64,
    note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNewsSourcesPayload {
    sources: Vec<AiNewsSourceInfo>,
    /// 那个需要 token 的源有没有配好（只报有没有，**绝不把 token 带出本进程**）
    token_configured: bool,
}

/// 源清单 + token 状态。设置界面与适配层都问它，界面因此能如实列出「会访问哪些地址」。
#[tauri::command]
pub fn ai_news_sources() -> AiNewsSourcesPayload {
    AiNewsSourcesPayload {
        sources: SOURCES
            .iter()
            .map(|source| AiNewsSourceInfo {
                id: source.id.to_string(),
                name: source.name.to_string(),
                url: source.url.to_string(),
                format: source.format.to_string(),
                needs_token: source.needs_token,
                ttl_ms: source.ttl_ms,
                note: source.note.to_string(),
            })
            .collect(),
        token_configured: token_credential()
            .map(|name| credentials::read(name).is_some())
            .unwrap_or(false),
    }
}

// ---------- 凭据 ----------

/// 保存 / 覆盖 token（设置界面里填的那一次）。
#[tauri::command]
pub fn ai_news_token_set(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("token 不能为空".into());
    }
    let Some(name) = token_credential() else {
        return Err("当前没有需要 token 的热点源".into());
    };
    credentials::store(name, token)
}

/// 清掉 token（设置界面的「清除」）。
#[tauri::command]
pub fn ai_news_token_clear() -> Result<(), String> {
    match token_credential() {
        Some(name) => credentials::remove(name),
        None => Ok(()),
    }
}

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

/// 拉一个源。**会出网**：调用方必须先确认该源是启用且可用的（缺 token 时这里直接失败，不发请求）。
///
/// `etag` 是上一次成功拉取时存下的条件请求标记：带 `If-None-Match` 后，服务端内容没变
/// 会回 304 而不是一整份正文 —— 省流量，也少一次对源站配额的消耗。
#[tauri::command(async)]
pub fn ai_news_fetch(source_id: String, etag: String) -> Result<AiNewsFetchResult, String> {
    let source = SOURCES
        .iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| format!("未知的热点源：{source_id}"))?;

    // 需要 token 的源：从凭据管理器现取现拼，token 不出本进程
    let mut url = source.url.to_string();
    if source.needs_token {
        let Some(name) = source.credential else {
            return Err(format!("热点源「{}」没有配凭据", source.name));
        };
        let Some(token) = credentials::read(name) else {
            return Err(format!(
                "还没配置「{}」的 token。打开设置，在「通用 → AI 热点」里填一次。",
                source.name
            ));
        };
        let separator = if url.contains('?') { '&' } else { '?' };
        let encoded: String = form_urlencoded::byte_serialize(token.as_bytes()).collect();
        url = format!("{url}{separator}token={encoded}");
    }

    let (host, path) = split_url(&url)?;
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

    /// 需要 token 的源必须声明用哪条凭据；不需要的则不该有
    #[test]
    fn token_sources_declare_a_credential() {
        for source in SOURCES {
            assert_eq!(
                source.needs_token,
                source.credential.is_some(),
                "源 {} 的 needs_token 与 credential 对不上",
                source.id
            );
        }
    }

    /// 默认启用的源必须是免费、无需 token 的（否则装完就撞上「缺 token」）。
    /// 这份 id 必须与 `shared/ai-news.ts` 的 `AI_NEWS_DEFAULT_SOURCES` 一致 ——
    /// 清单改名而那边忘了改，这条会在 `cargo test` 里当场报出来。
    #[test]
    fn default_source_exists_and_needs_no_token() {
        for id in ["qbitai"] {
            let source = SOURCES.iter().find(|source| source.id == id).expect("默认源不见了");
            assert!(!source.needs_token, "默认源 {id} 不该需要 token");
        }
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

    /// 空 token 会被拦下，绝不写进凭据管理器
    #[test]
    fn empty_token_is_rejected() {
        assert!(ai_news_token_set("".into()).is_err());
        assert!(ai_news_token_set("   ".into()).is_err());
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
        assert!(is_article_host_allowed("pro.jiqizhixin.com"));
        assert!(is_article_host_allowed("www.jiqizhixin.com"));

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