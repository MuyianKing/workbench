//! 模型目录：从上游拉真实清单，落盘一份缓存供界面与 `/v1/models` 读。
//!
//! **不轮询**。拉一次目录就是一次真实的上游往返，而模型一天也不变几回；
//! 所以只在用户点「重新获取」时拉，平时读 `models.json` 里那一份。
//!
//! 两个已知入口，按顺序试，第一个拿到清单就用：
//! - `GET {chat}/v3/config` —— 字段最全（名称、消费倍率、上下文、最大输出、思考档位）；
//! - `GET {chat}/console/enterprises/personal/models` —— 老入口，只有 id 与少量字段。
//!
//! 纯 I/O + 解析：不认识账号池，也不做"哪个号该去拉"的判断（由调用方给一个账号）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::wb_account::Account;

/// 目录里的一条模型。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    /// 上游给的名字（`GLM-5.2`）。老入口与窄表形态可能没有
    #[serde(default)]
    pub name: String,
    /// 消费倍率原文（`0.29x` / `0x`）。**只用于显示**，不参与计价 ——
    /// 折算成人民币是 `wb_pricing` 的事，两套口径别混
    #[serde(default)]
    pub rate: String,
    /// 上下文窗口（token）
    #[serde(default)]
    pub context: i64,
    /// 最大输出（token）
    #[serde(default)]
    pub max_output: i64,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_tools: bool,
    #[serde(default)]
    pub supports_reasoning: bool,
    /// 支持的思考档位（`low` / `high` / `max`…），空的表示上游没说
    #[serde(default)]
    pub efforts: Vec<String>,
    /// 默认思考档位
    #[serde(default)]
    pub default_effort: String,
}

/// 一次拉取的整份快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    /// 拉取时刻（Unix 秒）
    pub fetched_at: i64,
    pub models: Vec<ModelEntry>,
}

/// 上游两个入口的路径，按优先级排。谁先给非空清单就用谁。
const PROBE_PATHS: [&str; 2] = ["/v3/config", "/console/enterprises/personal/models"];

/// 用一个账号去拉目录。两个入口都失败才算失败（错误拼在一起，便于判断是哪一边的问题）。
pub fn fetch(account: &Account) -> Result<Catalog, String> {
    let mut failures = Vec::new();
    for path in PROBE_PATHS {
        match probe(account, path) {
            Ok(models) if !models.is_empty() => {
                return Ok(Catalog {
                    fetched_at: now_secs(),
                    models,
                });
            }
            Ok(_) => failures.push(format!("{path}：返回空清单")),
            Err(message) => failures.push(format!("{path}：{message}")),
        }
    }
    Err(format!("拉取模型目录失败（{}）", failures.join("；")))
}

/// 读上一次拉下来的目录。没有或读不动就是 `None` —— 调用方自己决定回落到什么。
pub fn load() -> Option<Catalog> {
    let text = std::fs::read_to_string(crate::paths::gateway_models_file()).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(catalog: &Catalog) -> Result<(), String> {
    let path = crate::paths::gateway_models_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建网关目录失败: {err}"))?;
    }
    let text = serde_json::to_string_pretty(catalog)
        .map_err(|err| format!("序列化模型目录失败: {err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("写模型目录失败: {err}"))
}

/// 缓存里的模型清单；没缓存时给空表。
pub fn cached() -> Vec<ModelEntry> {
    load().map(|catalog| catalog.models).unwrap_or_default()
}

fn probe(account: &Account, path: &str) -> Result<Vec<ModelEntry>, String> {
    let url = crate::wb_upstream::chat_url(path);
    let headers = headers(account);
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();

    let response = crate::http::request_url("GET", &url, &refs, None)?;
    let text = response.text();
    if response.status != 200 {
        return Err(format!("HTTP {} {}", response.status, excerpt(&text)));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("响应不是 JSON：{err}"))?;
    // 上流的信封里 code 非 0 也是失败（200 里什么都可能装）
    if let Some(code) = value.get("code").and_then(Value::as_i64) {
        if code != 0 {
            return Err(format!("code={code} {}", excerpt(&text)));
        }
    }
    Ok(parse_catalog(&value))
}

/// 从响应里抠出模型条目。两个入口的层级不完全一样，按已知的几种形态都试一遍：
/// `data.models`（v3 与多数接口）、`data.Response.Data.models`（老信封）、
/// 以及 `agents[].name == "cli"` 给的那串纯 id。
fn parse_catalog(value: &Value) -> Vec<ModelEntry> {
    let data = value.get("data").unwrap_or(value);
    let payload = data
        .get("Response")
        .and_then(|item| item.get("Data"))
        .unwrap_or(data);

    let mut list: Vec<ModelEntry> = Vec::new();
    if let Some(models) = payload.get("models").and_then(Value::as_array) {
        for item in models {
            if let Some(entry) = parse_entry(item) {
                list.push(entry);
            }
        }
    }
    if let Some(agents) = payload.get("agents").and_then(Value::as_array) {
        for agent in agents {
            let is_cli = agent
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name.eq_ignore_ascii_case("cli"))
                .unwrap_or(false);
            if !is_cli {
                continue;
            }
            let Some(names) = agent.get("models").and_then(Value::as_array) else {
                continue;
            };
            for name in names {
                if let Some(id) = name.as_str().map(str::trim).filter(|id| !id.is_empty()) {
                    list.push(ModelEntry {
                        id: id.to_string(),
                        ..ModelEntry::default()
                    });
                }
            }
        }
    }

    // 同一个 id 只留第一条（v3 那条字段更全），顺序按上游给的
    let mut seen = std::collections::HashSet::new();
    list.retain(|item| seen.insert(item.id.clone()));
    list
}

fn parse_entry(item: &Value) -> Option<ModelEntry> {
    // id 的三个可能键：常见的是 `id`；global 目录偶尔只有 `modelId` / `model`
    let id = ["id", "modelId", "model"]
        .iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())?;

    let reasoning = item.get("reasoning");
    let efforts: Vec<String> = reasoning
        .and_then(|cfg| cfg.get("supportedEfforts"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|effort| effort.trim().to_string())
                .filter(|effort| !effort.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let default_effort = reasoning
        .and_then(|cfg| cfg.get("defaultEffort"))
        .and_then(Value::as_str)
        .or_else(|| reasoning.and_then(|cfg| cfg.get("effort")).and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string();

    Some(ModelEntry {
        id: id.to_string(),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        rate: item
            .get("credits")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        context: int_of(item, "maxInputTokens"),
        max_output: int_of(item, "maxOutputTokens"),
        supports_vision: flag_of(item, "supportsImages"),
        supports_tools: flag_of(item, "supportsToolCall"),
        supports_reasoning: flag_of(item, "supportsReasoning"),
        efforts,
        default_effort,
    })
}

fn int_of(item: &Value, key: &str) -> i64 {
    item.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn flag_of(item: &Value, key: &str) -> bool {
    item.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// 拉目录用的头。与记账那套同源（Authorization / X-User-Id / X-Domain…），
/// 但 UA 取**对话**那条三段式的：`/v3/config` 要的是客户端身份，不是计费那套短 UA。
fn headers(account: &Account) -> Vec<(String, String)> {
    let mut headers = vec![
        ("Accept".to_string(), "application/json, text/plain, */*".to_string()),
        ("X-Requested-With".to_string(), "XMLHttpRequest".to_string()),
        ("Origin".to_string(), crate::wb_upstream::ORIGIN.to_string()),
        ("Referer".to_string(), format!("{}/", crate::wb_upstream::ORIGIN)),
        ("User-Agent".to_string(), crate::wb_upstream::CHAT_UA.to_string()),
        ("X-CodeBuddy-Request".to_string(), "1".to_string()),
        ("X-Product".to_string(), "SaaS".to_string()),
        ("Accept-Language".to_string(), crate::wb_upstream::ACCEPT_LANGUAGE.to_string()),
        (
            "Authorization".to_string(),
            format!("Bearer {}", account.access_token),
        ),
        ("X-User-Id".to_string(), account.uid.clone()),
        ("X-Domain".to_string(), account.effective_domain()),
        (
            "X-Request-ID".to_string(),
            crate::wb_identity::request_id_hex(),
        ),
    ];
    if !account.enterprise_id.trim().is_empty() {
        headers.push((
            "X-Enterprise-Id".to_string(),
            account.enterprise_id.clone(),
        ));
    }
    headers
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 160 {
        return trimmed.to_string();
    }
    trimmed.chars().take(160).collect::<String>() + "…"
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// v3/config 的形态：data.models 里字段最全，思考档位挂在 reasoning 下
    #[test]
    fn 解析_v3_目录() {
        let value = json!({
            "code": 0,
            "data": {
                "models": [
                    {
                        "id": "glm-5.3",
                        "name": "GLM-5.3",
                        "credits": "0.69x",
                        "maxInputTokens": 1_000_000,
                        "maxOutputTokens": 64_000,
                        "supportsImages": true,
                        "supportsToolCall": true,
                        "supportsReasoning": true,
                        "reasoning": {
                            "defaultEffort": "high",
                            "supportedEfforts": ["low", "high", "max"]
                        }
                    },
                    { "modelId": "hy3", "name": "Hy3" }
                ]
            }
        });
        let list = parse_catalog(&value);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "glm-5.3");
        assert_eq!(list[0].context, 1_000_000);
        assert_eq!(list[0].max_output, 64_000);
        assert_eq!(list[0].rate, "0.69x");
        assert_eq!(list[0].efforts, vec!["low", "high", "max"]);
        assert_eq!(list[0].default_effort, "high");
        // id 只有 modelId 的形态也认
        assert_eq!(list[1].id, "hy3");
    }

    /// 老入口的形态：models 里只有 id，另外 agents[cli] 给一串纯 id；同一个 id 只留一条
    #[test]
    fn 解析极简目录并去重() {
        let value = json!({
            "code": 0,
            "data": {
                "models": [{ "id": "hy3" }],
                "agents": [
                    { "name": "cli", "models": ["hy3", "glm-5.2"] },
                    { "name": "other", "models": ["不应该出现"] }
                ]
            }
        });
        let list = parse_catalog(&value);
        let ids: Vec<&str> = list.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["hy3", "glm-5.2"]);
    }

    /// 老信封：模型列表在 data.Response.Data.models 下面
    #[test]
    fn 解析套了两层信封的目录() {
        let value = json!({
            "code": 0,
            "data": {
                "Response": {
                    "Data": {
                        "models": [{ "id": "deepseek-v4.1-flash", "name": "DeepSeek", "credits": "0.11x" }]
                    }
                }
            }
        });
        let list = parse_catalog(&value);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].rate, "0.11x");
    }
}
