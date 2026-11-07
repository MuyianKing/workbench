//! 构造 `agent_chat_generation` 的上游请求体。
//!
//! 以随包的 `qoder/baseprompt.json` 为骨架（官方客户端同款模板，MIT，来自
//! `qoder2api-hub`），每次覆写：请求 / 会话 id、模型配置、系统提示词与真实会话、
//! 工具、参数与 business 会话名。模板自带的示例 user 轮次必须丢掉 —— 它是样例内容，
//! 不是用户说的话。
//!
//! 出站前整段 JSON 再走 [`qd_sign::qoder_encode`]（Qoder 自定义 Base64）。
//!
//! 纯函数：不碰网络、不碰文件。

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::qd_account::Account;
use crate::qd_models::ModelInfo;
use crate::qd_tools;

/// 官方模板（只解析一次）。
fn template() -> &'static Value {
    static TEMPLATE: OnceLock<Value> = OnceLock::new();
    TEMPLATE.get_or_init(|| {
        serde_json::from_str(include_str!("qoder/baseprompt.json"))
            .unwrap_or_else(|_| json!({}))
    })
}

/// 一段对话的身份：同一个会话复用 `id` 与 `begin_at`，上游按它归组用量。
#[derive(Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub begin_at: i64,
    pub name: String,
}

/// 构造结果里给编排层看的派生信息。
pub struct Prepared {
    /// 上游路由 key
    pub model_key: String,
    /// 客户端要的思考档位（原文）
    pub effort_requested: String,
}

/// 一次请求需要的东西。
pub struct BuildInput<'a> {
    pub payload: &'a Value,
    pub account: &'a Account,
    pub model: &'a ModelInfo,
    pub conversation: Option<&'a Conversation>,
}

/// 从请求体里读客户端要的思考档位（三种常见写法）。
pub fn requested_effort(payload: &Value) -> String {
    for key in ["reasoning_effort", "reasoning_effort_level"] {
        if let Some(text) = payload.get(key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    for parent in ["reasoning", "thinking"] {
        if let Some(text) = payload
            .get(parent)
            .and_then(|value| value.get("effort"))
            .and_then(Value::as_str)
        {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    String::new()
}

/// 会话亲和 key：同一段对话（前两条消息相同）固定落到同一个账号。
pub fn affinity_key(messages: &[Value]) -> String {
    let mut seed = String::new();
    for message in messages.iter().take(2) {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let content = message
            .get("content")
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default();
        seed.push_str(role);
        seed.push(':');
        seed.push_str(&content.chars().take(200).collect::<String>());
        seed.push('\n');
    }
    if seed.is_empty() {
        return String::new();
    }
    let digest = crate::wb_fingerprint::md5(seed.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 构造上游请求体。
pub fn build(input: BuildInput<'_>) -> Result<(Value, Prepared), String> {
    let payload = input.payload;
    let account = input.account;
    let model = input.model;
    let raw_messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw_messages.is_empty() {
        return Err("messages 不能为空".into());
    }
    let messages = qd_tools::normalize_roles(&raw_messages);
    let deepseek = qd_tools::is_deepseek(&model.id, &model.key);
    let messages = qd_tools::backfill_reasoning(messages, deepseek);
    let structured = qd_tools::structured_enabled(&model.key, &messages);
    let flat = qd_tools::flatten(&messages, deepseek, structured);

    let mut body = template().clone();
    let object = body
        .as_object_mut()
        .ok_or_else(|| "baseprompt 模板不是对象".to_string())?;

    // ---- 请求 / 会话 id ----
    let request_id = uuid::Uuid::new_v4().to_string();
    let chat_record_id = input
        .conversation
        .map(|conversation| conversation.id.clone())
        .unwrap_or_else(|| request_id.clone());
    object.insert("request_id".into(), Value::String(request_id));
    object.insert("chat_record_id".into(), Value::String(chat_record_id));
    object.insert(
        "request_set_id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    object.insert(
        "session_id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    object.insert("stream".into(), Value::Bool(true));
    object.insert("agent_id".into(), Value::String("agent_common".into()));
    object.insert(
        "aliyun_user_type".into(),
        Value::String(if account.user_type.trim().is_empty() {
            crate::qd_upstream::DEFAULT_USER_TYPE.into()
        } else {
            account.user_type.clone()
        }),
    );

    // ---- model_config ----
    let model_config = json!({
        "key": model.key,
        "display_name": model.display_name,
        "model": "",
        "format": "openai",
        "is_vl": model.vision,
        "is_reasoning": model.reasoning,
        "api_key": "",
        "url": "",
        "source": "system",
        "max_input_tokens": if model.context_length > 0 { model.context_length } else { 180000 },
    });
    object.insert("model_config".into(), model_config.clone());

    // ---- 会话：模板只留 system 基座，再追加真实轮次 ----
    let prompt = flat
        .messages
        .iter()
        .rev()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("user")
                && message.get("content").is_some()
        })
        .and_then(|message| message.get("content"))
        .map(|content| match content {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let mut out_messages: Vec<Value> = Vec::new();
    match flat.system.as_ref() {
        Some(system) => out_messages.push(json!({ "role": "system", "content": system })),
        None => {
            // 客户端没给 system：保留模板自带的 Qoder 系统提示词
            if let Some(template_messages) = object.get("messages").and_then(Value::as_array) {
                for message in template_messages {
                    if message.get("role").and_then(Value::as_str) == Some("system") {
                        out_messages.push(message.clone());
                    }
                }
            }
        }
    }
    out_messages.extend(flat.messages.clone());
    object.insert("messages".into(), Value::Array(out_messages));

    // ---- chat_context（高亮文本与模型配置副本） ----
    let mut chat_context = object
        .get("chat_context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut text = chat_context
        .get("text")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    text.insert("text".into(), Value::String(prompt.clone()));
    chat_context.insert("text".into(), Value::Object(text));
    let mut extra = chat_context
        .get("extra")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut original = extra
        .get("originalContent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    original.insert("text".into(), Value::String(prompt.clone()));
    extra.insert("originalContent".into(), Value::Object(original));
    extra.insert("modelConfig".into(), model_config);
    chat_context.insert("extra".into(), Value::Object(extra));
    // 顶层 image_urls 不填：上游只读 messages 里的结构化 parts（实测），
    // 填了只会把出站体积撑到 SLB 的 30MB 限制
    object.insert("chat_context".into(), Value::Object(chat_context));

    // ---- parameters ----
    let mut parameters = object
        .get("parameters")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let max_tokens = payload
        .get("max_tokens")
        .or_else(|| payload.get("max_completion_tokens"))
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);
    if let Some(max_tokens) = max_tokens {
        parameters.insert("max_tokens".into(), Value::Number(max_tokens.into()));
    }
    let effort_requested = requested_effort(payload);
    if let Some(effort) = qd_tools::normalize_effort(&effort_requested, &model.efforts) {
        parameters.insert("reasoning_effort".into(), Value::String(effort));
    }
    object.insert("parameters".into(), Value::Object(parameters));

    // ---- tools：客户端给了就用客户端的，否则置空（不给桌面端自带的 agent 工具）----
    let mut tools = payload.get("tools").cloned();
    qd_tools::normalize_tools(&mut tools);
    object.insert("tools".into(), tools.unwrap_or_else(|| Value::Array(Vec::new())));

    // ---- business 会话卡片 ----
    let mut business = object
        .get("business")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match input.conversation {
        Some(conversation) => {
            business.insert("id".into(), Value::String(conversation.id.clone()));
            business.insert("begin_at".into(), Value::Number(conversation.begin_at.into()));
            business.insert(
                "name".into(),
                Value::String(if conversation.name.is_empty() {
                    short_name(&prompt)
                } else {
                    conversation.name.clone()
                }),
            );
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            business.insert("id".into(), Value::String(id));
            business.insert(
                "begin_at".into(),
                Value::Number((crate::common::now_secs() * 1000).into()),
            );
            business.insert("name".into(), Value::String(short_name(&prompt)));
        }
    }
    business
        .entry("product")
        .or_insert_with(|| Value::String("cli".into()));
    business
        .entry("type")
        .or_insert_with(|| Value::String("agent".into()));
    business
        .entry("stage")
        .or_insert_with(|| Value::String("start".into()));
    object.insert("business".into(), Value::Object(business));

    Ok((
        body,
        Prepared {
            model_key: model.key.clone(),
            effort_requested,
        },
    ))
}

fn short_name(prompt: &str) -> String {
    let name: String = prompt.chars().take(30).collect();
    if name.trim().is_empty() {
        "chat".into()
    } else {
        name
    }
}

/// 出站前的编码（Qoder 自定义 Base64）。
pub fn encode(body: &Value) -> Result<String, String> {
    let text = serde_json::to_string(body).map_err(|err| format!("序列化请求体失败：{err}"))?;
    Ok(crate::qd_sign::qoder_encode(text.as_bytes()))
}

/// 取请求体里声明的工具 schema（泄漏回读用：名字、参数属性、必填）。
pub fn tool_schemas(payload: &Value) -> Vec<qd_tools::ToolSchema> {
    payload
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    let function = tool
                        .get("function")
                        .and_then(Value::as_object)
                        .or_else(|| tool.as_object());
                    let function = function?;
                    let name = function.get("name").and_then(Value::as_str)?;
                    if name.trim().is_empty() {
                        return None;
                    }
                    let parameters = function.get("parameters").and_then(Value::as_object);
                    let properties: std::collections::HashSet<String> = parameters
                        .and_then(|parameters| parameters.get("properties"))
                        .and_then(Value::as_object)
                        .map(|properties| properties.keys().cloned().collect())
                        .unwrap_or_default();
                    let required: std::collections::HashSet<String> = parameters
                        .and_then(|parameters| parameters.get("required"))
                        .and_then(Value::as_array)
                        .map(|required| {
                            required
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(qd_tools::ToolSchema {
                        name: name.to_string(),
                        properties,
                        required,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qd_account::Account;

    fn account() -> Account {
        Account::from_login("u1", "nick", "dt-token", "drt-refresh", 0, "", "", "")
    }

    fn model() -> ModelInfo {
        crate::qd_models::merged()
            .into_iter()
            .find(|model| model.key == "qmodel_38max")
            .unwrap_or_else(|| panic!("快照里应有 qmodel_38max"))
    }

    #[test]
    fn 请求体能构造出来_并只保留一个_system() {
        let payload = serde_json::json!({
            "model": "Qwen3.8-Max",
            "messages": [
                {"role":"system","content":"你是助手"},
                {"role":"user","content":"你好"}
            ]
        });
        let (body, prepared) = build(BuildInput {
            payload: &payload,
            account: &account(),
            model: &model(),
            conversation: None,
        })
        .unwrap_or_else(|err| panic!("构造失败：{err}"));
        assert_eq!(prepared.model_key, "qmodel_38max");
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], Value::String("system".into()));
        assert_eq!(messages[0]["content"], Value::String("你是助手".into()));
        assert_eq!(messages[1]["content"], Value::String("你好".into()));
        assert_eq!(body["model_config"]["key"], Value::String("qmodel_38max".into()));
        assert!(body["tools"].as_array().map(|list| list.is_empty()).unwrap_or(false));
        assert_eq!(body["business"]["name"], Value::String("你好".into()));
        assert_eq!(body["stream"], Value::Bool(true));
    }

    #[test]
    fn 思考档位按模型支持表归一() {
        let payload = serde_json::json!({
            "model": "Qwen3.8-Max",
            "messages": [{"role":"user","content":"hi"}],
            "reasoning_effort": "xhigh",
            "max_tokens": 1234
        });
        let (body, prepared) = build(BuildInput {
            payload: &payload,
            account: &account(),
            model: &model(),
            conversation: None,
        })
        .unwrap_or_else(|err| panic!("构造失败：{err}"));
        assert_eq!(prepared.effort_requested, "xhigh");
        assert_eq!(
            body["parameters"]["reasoning_effort"],
            Value::String("xhigh".into())
        );
        assert_eq!(body["parameters"]["max_tokens"], Value::Number(1234.into()));
    }

    #[test]
    fn 没有_system_时保留模板自带提示词() {
        let payload = serde_json::json!({
            "model": "Qwen3.8-Max",
            "messages": [{"role":"user","content":"hi"}]
        });
        let (body, _) = build(BuildInput {
            payload: &payload,
            account: &account(),
            model: &model(),
            conversation: None,
        })
        .unwrap_or_else(|err| panic!("构造失败：{err}"));
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        assert_eq!(messages[0]["role"], Value::String("system".into()));
        assert!(messages[0]["content"].as_str().unwrap_or("").len() > 100);
        // 模板自带的示例 user 轮次被丢掉
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn 会话身份复用_chat_record_id() {
        let payload = serde_json::json!({
            "model": "Qwen3.8-Max",
            "messages": [{"role":"user","content":"hi"}]
        });
        let conversation = Conversation {
            id: "conv-1".into(),
            begin_at: 1_700_000_000_000,
            name: "测试会话".into(),
        };
        let (body, _) = build(BuildInput {
            payload: &payload,
            account: &account(),
            model: &model(),
            conversation: Some(&conversation),
        })
        .unwrap_or_else(|err| panic!("构造失败：{err}"));
        assert_eq!(body["chat_record_id"], Value::String("conv-1".into()));
        assert_eq!(body["business"]["id"], Value::String("conv-1".into()));
        assert_eq!(
            body["business"]["begin_at"],
            Value::Number(1_700_000_000_000i64.into())
        );
    }
}
