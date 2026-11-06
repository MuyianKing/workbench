//! Qoder 模型目录：随包 CN 快照打底 + COSY 从上游拉取。
//!
//! 与 TBuddy 的「每次进模型栏探一次」不同，Qoder 的目录接口只认 COSY 签名，
//! 所以这里给三层来源（与原项目一致）：
//! 1. 随包 `qoder/catalog-cn.json`（MIT，来自 `qoder2api-hub`）—— 没有账号也能显示；
//! 2. 上一次成功拉取的 `models.json`（请求路径读它，不出网）；
//! 3. 上游 `/algo/api/v2/model/list`（COSY 签名，body 必须是编码后的 `{}`）。
//!
//! 合并规则：**动态清单为准**，只拿有值的字段覆盖静态快照（上游对部分条目回
//! `null`，静默 null 会把快照里的真实值抹掉）；静态独有、上游此刻没列的条目不外塞。
//!
//! 纯解析 + 一次网络调用；不碰账号池的调度。

use std::sync::OnceLock;

use serde::Serialize;

use crate::qd_account::Account;
use crate::qd_sign::{CosyCache, qoder_encode};
use crate::qd_upstream;

/// 上游不是对话模型的 key：`lite` 与代码补全系列。
fn is_chat_model(key: &str) -> bool {
    if key.is_empty() || key == "lite" {
        return false;
    }
    if key.starts_with("codewise-") || key.starts_with("completion-") {
        return false;
    }
    !["-image-alpha", "-image-alpha-edit", "-taco-completion"]
        .iter()
        .any(|suffix| key.ends_with(suffix))
}

/// 给界面与 `/v1/models` 用的模型信息（字段只取上游真实有的，不编造）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// 客户端填的 id：官方显示名（如 `Qwen3.8-Max`）
    pub id: String,
    /// 上游路由 key（`qmodel_38max`）
    pub key: String,
    pub display_name: String,
    pub enabled: bool,
    pub disabled_reason: String,
    pub description: String,
    pub context_length: i64,
    pub context_windows: Vec<i64>,
    pub context_window_labels: Vec<String>,
    pub context_window_default: String,
    pub reasoning: bool,
    pub vision: bool,
    pub tool_calls: bool,
    pub efforts: Vec<String>,
    pub default_effort: String,
    pub price_factor: Option<f64>,
    pub price_factor_peak: Option<f64>,
    pub price_factor_valley: Option<f64>,
    pub is_free: bool,
    pub is_new: bool,
}

impl ModelInfo {
    fn from_value(key: &str, meta: &serde_json::Value) -> Option<Self> {
        if !is_chat_model(key) {
            return None;
        }
        let display_name = meta
            .get("display_name")
            .or_else(|| meta.get("name"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or(key)
            .to_string();
        let enabled = meta
            .get("enable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let context_length = meta
            .get("max_input_tokens")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let (context_windows, context_window_labels, context_window_default) =
            context_of(meta.get("context_config"));
        let (efforts, default_effort) = efforts_of(meta.get("thinking_config"));
        let promotion = meta.get("promotion").cloned().unwrap_or_default();
        let peak = promotion
            .get("before_promotion_price_factor")
            .and_then(serde_json::Value::as_f64)
            .or_else(|| {
                meta.get("original_price_factor")
                    .and_then(serde_json::Value::as_f64)
            });
        let price = meta.get("price_factor").and_then(serde_json::Value::as_f64);
        let discount = promotion
            .get("discount_factor")
            .and_then(serde_json::Value::as_f64);
        let valley = match (peak, discount) {
            (Some(peak), Some(discount)) if discount > 0.0 && discount <= 1.0 => {
                Some((peak * discount * 10_000.0).round() / 10_000.0)
            }
            _ => price,
        };
        let reasoning = meta
            .get("is_reasoning")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || !efforts.is_empty();
        let vision = meta
            .get("is_vl")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        Some(Self {
            id: display_name.clone(),
            key: key.to_string(),
            display_name,
            enabled,
            disabled_reason: if enabled {
                String::new()
            } else {
                "需要升级或购买对应套餐后开放".into()
            },
            description: meta
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            context_length,
            context_windows,
            context_window_labels,
            context_window_default,
            reasoning,
            vision,
            tool_calls: meta
                .get("supportsToolCall")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            efforts,
            default_effort,
            price_factor: price,
            price_factor_peak: peak,
            price_factor_valley: valley,
            is_free: meta
                .get("is_free")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            is_new: meta
                .get("is_new")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
    }
}

fn context_of(config: Option<&serde_json::Value>) -> (Vec<i64>, Vec<String>, String) {
    let Some(map) = config.and_then(serde_json::Value::as_object) else {
        return (Vec::new(), Vec::new(), String::new());
    };
    let mut windows = Vec::new();
    let mut labels = Vec::new();
    let mut default = String::new();
    for (label, conf) in map {
        let Some(tokens) = conf.get("token_count").and_then(serde_json::Value::as_i64) else {
            continue;
        };
        if tokens <= 0 {
            continue;
        }
        labels.push(label.clone());
        windows.push(tokens);
        if conf
            .get("is_default")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            default = label.clone();
        }
    }
    if default.is_empty() {
        default = labels.first().cloned().unwrap_or_default();
    }
    (windows, labels, default)
}

fn efforts_of(config: Option<&serde_json::Value>) -> (Vec<String>, String) {
    let Some(config) = config else {
        return (Vec::new(), String::new());
    };
    let enabled = config.get("enabled").and_then(serde_json::Value::as_object);
    let Some(enabled) = enabled else {
        // 老形态：reasoning.supportedEfforts
        return (Vec::new(), String::new());
    };
    let Some(map) = enabled.get("efforts").and_then(serde_json::Value::as_object) else {
        return (Vec::new(), String::new());
    };
    let order = ["low", "medium", "high", "xhigh", "max"];
    let mut efforts = Vec::new();
    let mut default = String::new();
    for level in order {
        if let Some(conf) = map.get(level) {
            efforts.push(level.to_string());
            if conf
                .get("is_default")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                default = level.to_string();
            }
        }
    }
    if default.is_empty() {
        default = efforts.get(efforts.len() / 2).cloned().unwrap_or_default();
    }
    (efforts, default)
}

/// 随包 CN 快照的原始条目（只解析一次）。
fn bundled_raw() -> &'static [serde_json::Value] {
    static RAW: OnceLock<Vec<serde_json::Value>> = OnceLock::new();
    RAW.get_or_init(|| {
        let text = include_str!("qoder/catalog-cn.json");
        serde_json::from_str(text).unwrap_or_default()
    })
}

/// 随包 CN 快照（只解析一次）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn bundled() -> &'static [ModelInfo] {
    static MODELS: OnceLock<Vec<ModelInfo>> = OnceLock::new();
    MODELS.get_or_init(|| {
        bundled_raw()
            .iter()
            .filter_map(|item| {
                let key = item.get("key").and_then(serde_json::Value::as_str)?;
                ModelInfo::from_value(key, item)
            })
            .collect()
    })
}

/// 上一次成功拉取的目录（`models.json`：`{"fetchedAt":…, "models":[{key,…}]}`）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsCache {
    #[serde(default)]
    pub fetched_at: i64,
    #[serde(default)]
    pub models: Vec<serde_json::Value>,
}

pub fn load_cache() -> ModelsCache {
    let path = crate::paths::qoder_models_file();
    let Ok(text) = std::fs::read_to_string(path) else {
        return ModelsCache {
            fetched_at: 0,
            models: Vec::new(),
        };
    };
    serde_json::from_str(&text).unwrap_or(ModelsCache {
        fetched_at: 0,
        models: Vec::new(),
    })
}

pub fn save_cache(cache: &ModelsCache) -> Result<(), String> {
    let path = crate::paths::qoder_models_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建目录失败：{err}"))?;
    }
    let text = serde_json::to_string_pretty(cache)
        .map_err(|err| format!("序列化模型目录失败：{err}"))?;
    crate::fs_util::write_atomic(&path, text.as_bytes())
}

/// 合并快照与缓存：缓存优先、只覆盖有值的字段；顺序按快照，缓存独有追加。
pub fn merged() -> Vec<ModelInfo> {
    merged_with(&load_cache())
}

fn merged_with(cache: &ModelsCache) -> Vec<ModelInfo> {
    // 先按 key 合并**原始 JSON**：上游对部分条目回 null，null 不能覆盖快照里的真实值
    let mut raw: Vec<serde_json::Value> = bundled_raw().to_vec();
    let mut by_key: std::collections::HashMap<String, usize> = raw
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.get("key")
                .and_then(serde_json::Value::as_str)
                .map(|key| (key.to_string(), index))
        })
        .collect();
    for item in &cache.models {
        let Some(key) = item.get("key").and_then(serde_json::Value::as_str) else {
            continue;
        };
        match by_key.get(key).copied() {
            Some(index) => {
                if let (Some(base), Some(live)) = (raw[index].as_object_mut(), item.as_object()) {
                    for (name, value) in live {
                        if !value.is_null() {
                            base.insert(name.clone(), value.clone());
                        }
                    }
                }
            }
            None => {
                by_key.insert(key.to_string(), raw.len());
                raw.push(item.clone());
            }
        }
    }
    raw.iter()
        .filter_map(|item| {
            let key = item.get("key").and_then(serde_json::Value::as_str)?;
            ModelInfo::from_value(key, item)
        })
        .collect()
}

/// 按客户端填的名字找模型：显示名、上游 key、`key (显示名)` 都认。
pub fn resolve(name: &str) -> Option<(String, ModelInfo)> {
    let wanted = name.trim();
    if wanted.is_empty() {
        return None;
    }
    for model in merged() {
        if model.id == wanted
            || model.key == wanted
            || format!("{} ({})", model.key, model.display_name) == wanted
        {
            return Some((model.key.clone(), model));
        }
    }
    None
}

/// 用第一个可用账号拉一次目录并落盘。失败返回错误，调用方保留旧缓存。
pub fn refresh(account: &Account, cosy: &mut CosyCache) -> Result<usize, String> {
    let raw_url = qd_upstream::gateway(qd_upstream::MODELS_PATH);
    let body = qoder_encode(b"{}");
    let headers = {
        let session = cosy.get_or_create(account)?;
        session.headers(&body, &raw_url, "", false, "application/json")?
    };
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let response = crate::http::request_url("GET", &raw_url, &refs, Some(&body))?;
    let text = response.text();
    if response.status != 200 {
        return Err(format!("拉取模型目录失败：HTTP {}", response.status));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|err| format!("模型目录不是 JSON：{err}"))?;
    let chat = value
        .get("chat")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for item in chat {
        let Some(key) = item
            .get("key")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        if !is_chat_model(&key) {
            continue;
        }
        // 官方原始条目全字段透传（只为补 id/name 兼容键，不裁剪）
        let mut row = item;
        if let Some(object) = row.as_object_mut() {
            object
                .entry("id")
                .or_insert_with(|| serde_json::Value::String(key.clone()));
        }
        models.push(row);
    }
    if models.is_empty() {
        return Err("上游模型目录为空".into());
    }
    let count = models.len();
    save_cache(&ModelsCache {
        fetched_at: crate::qd_account::now_secs(),
        models,
    })?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 随包快照能解析出对话模型() {
        let models = bundled();
        assert!(models.len() >= 10, "CN 快照不该只有 {} 条", models.len());
        assert!(models.iter().all(|model| !model.key.is_empty()));
        // 补全模型被过滤
        assert!(models.iter().all(|model| !model.key.starts_with("completion-")));
        let max = models
            .iter()
            .find(|model| model.key == "qmodel_38max")
            .unwrap_or_else(|| panic!("快照里应有 qmodel_38max"));
        assert_eq!(max.id, "Qwen3.8-Max");
        assert!(max.context_windows.contains(&1_000_000));
        assert!(max.efforts.contains(&"xhigh".to_string()));
    }

    #[test]
    fn 显示名与_key_都能解析() {
        assert_eq!(
            resolve("Qwen3.8-Max").map(|(key, _)| key),
            Some("qmodel_38max".into())
        );
        assert_eq!(
            resolve("qmodel_38max").map(|(key, _)| key),
            Some("qmodel_38max".into())
        );
        assert!(resolve("不存在的模型").is_none());
    }

    #[test]
    fn 缓存只覆盖有值的字段_顺序仍按快照() {
        let mut cache = ModelsCache {
            fetched_at: 1,
            models: Vec::new(),
        };
        cache.models.push(serde_json::json!({
            "key": "qmodel_38max",
            "display_name": "Qwen3.9-Max",
            "max_input_tokens": null
        }));
        let merged = merged_with(&cache);
        let max = merged
            .iter()
            .find(|model| model.key == "qmodel_38max")
            .unwrap_or_else(|| panic!("应保留快照条目"));
        assert_eq!(max.id, "Qwen3.9-Max");
        // null 不覆盖快照里的 180000
        assert_eq!(max.context_length, 180000);
        assert_eq!(merged[0].key, bundled()[0].key);
    }
}
