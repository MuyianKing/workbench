//! 会话压平与工具调用：把 OpenAI 的 messages / tools 变成 Qoder 上游能吃的形状。
//!
//! 三件事（与 `qoder2api-hub` 的 `flatten_messages` / `normalize_tools` 同口径）：
//!
//! 1. **历史工具调用**：国内版白名单模型（Qwen / GLM）可以直传结构化
//!    `tool_calls` / `tool` 消息；其余模型把工具调用序列化成文本标记，
//!    再把工具结果当 user 消息发过去。只要有一个 `tool_call_id` 不完整，
//!    整轮退回文本化（宁可用旧协议，也不发畸形请求）。
//! 2. **泄漏回读**：模型偶尔把工具调用当普通正文写出来（标记 + JSON 数组）。
//!    这里提供解析；输出侧由 `qd_sse` 在收尾时决定是还原成 `tool_calls`
//!    还是按普通正文放行。
//! 3. **思考档位**：按目录里 `thinking_config` 的官方档位归一，未支持的档位
//!    不硬塞（上游会 400）。
//!
//! 纯函数：不碰网络、不碰文件。

use serde_json::{Map, Value};

/// 文本化的工具调用标记（与上游参考实现逐字一致，模型已经「学会」这个形态）。
pub const LEAK_MARKER: &str = "[assistant 请求调用工具]";
/// 文本化的工具结果前缀。
pub const TOOL_RESULT_MARKER: &str = "[工具结果";

/// 结构化工具历史的模型白名单前缀（国内版实测可用）。
const STRUCTURED_WHITELIST: [&str; 8] = [
    "qmodel",
    "qfmodel",
    "q37",
    "gmodel",
    "gfmodel",
    "gm51",
    "qmodel_latest",
    "auto",
];

/// DeepSeek 族：多轮一致性与 `reasoning_content` 绑定。
pub fn is_deepseek(model: &str, model_key: &str) -> bool {
    let key = model_key.to_ascii_lowercase();
    let name = model.to_ascii_lowercase();
    key.starts_with("dmodel")
        || key.starts_with("dfmodel")
        || name.contains("deepseek")
}

/// `developer` 归一成 `system`；其余角色原样保留（未知角色由压平阶段降级为 user）。
pub fn normalize_roles(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let Some(object) = message.as_object() else {
                return message.clone();
            };
            if object.get("role").and_then(Value::as_str) != Some("developer") {
                return message.clone();
            }
            let mut copy = object.clone();
            copy.insert("role".into(), Value::String("system".into()));
            Value::Object(copy)
        })
        .collect()
}

/// 结构化工具历史能不能用：所有配对的 id 都齐全，且模型在白名单里。
pub fn tool_ids_ok(messages: &[Value]) -> bool {
    let mut called = std::collections::HashSet::new();
    for message in messages {
        let Some(object) = message.as_object() else {
            continue;
        };
        if let Some(calls) = object.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let id = call.get("id").and_then(Value::as_str).unwrap_or("");
                if id.trim().is_empty() {
                    return false;
                }
                called.insert(id.to_string());
            }
        }
    }
    for message in messages {
        let Some(object) = message.as_object() else {
            continue;
        };
        if object.get("role").and_then(Value::as_str) == Some("tool") {
            let id = object
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            if id.trim().is_empty() || !called.contains(id) {
                return false;
            }
        }
    }
    true
}

pub fn structured_enabled(model_key: &str, messages: &[Value]) -> bool {
    if !tool_ids_ok(messages) {
        return false;
    }
    let key = model_key.to_ascii_lowercase();
    STRUCTURED_WHITELIST
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

/// 压平后的会话。
pub struct Flattened {
    /// 第一个 system / developer 的正文（模板 system 的替换源）
    pub system: Option<String>,
    /// 真实会话（user / assistant / 可选 tool）
    pub messages: Vec<Value>,
}

/// 把 content（字符串或 parts 列表）压成文本，图片单独收集。
fn content_text(content: Option<&Value>) -> (String, Vec<String>) {
    let Some(content) = content else {
        return (String::new(), Vec::new());
    };
    match content {
        Value::String(text) => (text.clone(), Vec::new()),
        Value::Array(parts) => {
            let mut texts = Vec::new();
            let mut images = Vec::new();
            for part in parts {
                match part {
                    Value::String(text) => texts.push(text.clone()),
                    Value::Object(object) => {
                        let kind = object
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if matches!(
                            kind,
                            "text" | "input_text" | "output_text" | "summary_text"
                        ) {
                            if let Some(text) = object.get("text").and_then(Value::as_str) {
                                texts.push(text.to_string());
                            }
                        } else if kind == "image_url" || kind == "image" || kind == "input_image" {
                            if let Some(url) = image_url_of(object) {
                                images.push(url);
                            }
                        }
                    }
                    _ => {}
                }
            }
            (texts.join("\n"), images)
        }
        // 单个 part 对象（有的客户端直接当 content 传）
        Value::Object(object) => content_text(Some(&Value::Array(vec![Value::Object(
            object.clone(),
        )]))),
        other => (other.to_string(), Vec::new()),
    }
}

fn image_url_of(object: &Map<String, Value>) -> Option<String> {
    if let Some(url) = object.get("image_url") {
        if let Some(text) = url.as_str() {
            return Some(text.to_string());
        }
        if let Some(text) = url.get("url").and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }
    if let Some(text) = object.get("url").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(data) = object.get("data").and_then(Value::as_str) {
        let mime = object
            .get("mimeType")
            .or_else(|| object.get("mime_type"))
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        return Some(format!("data:{mime};base64,{data}"));
    }
    None
}

/// 历史工具结果截短：首尾各留 2000 字符，中间换成固定省略标记。
///
/// 只动**历史**（最后一轮的 tool 结果必须完整保留）；削后的字节恒定，不随轮次
/// 变化 —— 上游按前缀缓存，每轮重削会让缓存整段失效。
pub fn shrink_tool_result(text: &str, keep: usize) -> String {
    if keep == 0 {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= keep * 2 + 200 {
        return text.to_string();
    }
    let head: String = chars[..keep].iter().collect();
    let tail: String = chars[chars.len() - keep..].iter().collect();
    format!("{head}\n…[中间省略 {} 字符]…\n{tail}", chars.len() - keep * 2)
}

/// 压平整段会话。`structured` 决定工具历史走结构化还是文本化。
pub fn flatten(messages: &[Value], keep_reasoning: bool, structured: bool) -> Flattened {
    let mut system = None;
    let mut flat: Vec<Value> = Vec::new();
    // 最后一轮的工具结果完整保留，更早的截短（结构化 / 文本化都适用）
    let last_tool = messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("tool"));
    for (index, message) in messages.iter().enumerate() {
        let Some(object) = message.as_object() else {
            continue;
        };
        let role = object.get("role").and_then(Value::as_str).unwrap_or("");
        let (mut text, found_images) = content_text(object.get("content"));
        let had_images = !found_images.is_empty();
        if role == "system" || role == "developer" {
            if system.is_none() && !text.trim().is_empty() {
                system = Some(text);
            }
            continue;
        }
        if role == "tool" {
            if Some(index) != last_tool {
                text = shrink_tool_result(&text, 2000);
            }
            if structured {
                flat.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": object.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                    "content": text,
                }));
            } else {
                let name = object
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(|name| format!(" ({name})"))
                    .unwrap_or_default();
                flat.push(serde_json::json!({
                    "role": "user",
                    "content": format!("{TOOL_RESULT_MARKER}{name}]\n{text}"),
                }));
            }
            continue;
        }
        if role == "assistant" {
            if let Some(calls) = object.get("tool_calls").and_then(Value::as_array) {
                if !calls.is_empty() {
                    if structured {
                        let normalized: Vec<Value> = calls
                            .iter()
                            .map(|call| {
                                let function = call.get("function").cloned().unwrap_or_default();
                                let arguments = function
                                    .get("arguments")
                                    .map(|value| match value {
                                        Value::String(text) => text.clone(),
                                        other => other.to_string(),
                                    })
                                    .unwrap_or_default();
                                serde_json::json!({
                                    "id": call.get("id").and_then(Value::as_str).unwrap_or(""),
                                    "type": call.get("type").and_then(Value::as_str).unwrap_or("function"),
                                    "function": {
                                        "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                                        "arguments": arguments,
                                    },
                                })
                            })
                            .collect();
                        let mut item = serde_json::json!({
                            "role": "assistant",
                            "content": text,
                            "tool_calls": normalized,
                        });
                        if keep_reasoning {
                            if let Some(reasoning) = object.get("reasoning_content") {
                                item["reasoning_content"] = reasoning.clone();
                            }
                        }
                        flat.push(item);
                        continue;
                    }
                    // 文本化：标记 + 精简的 JSON 数组
                    let calls: Vec<Value> = calls
                        .iter()
                        .map(|call| {
                            let function = call.get("function").cloned().unwrap_or_default();
                            serde_json::json!({
                                "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                                "arguments": function.get("arguments").cloned().unwrap_or(Value::String(String::new())),
                            })
                        })
                        .collect();
                    text = format!(
                        "{text}\n\n{LEAK_MARKER}\n{}",
                        serde_json::to_string(&calls).unwrap_or_else(|_| "[]".into())
                    );
                }
            }
            let mut item = serde_json::json!({ "role": "assistant", "content": text });
            if keep_reasoning {
                if let Some(reasoning) = object.get("reasoning_content") {
                    item["reasoning_content"] = reasoning.clone();
                }
            }
            flat.push(item);
            continue;
        }
        if role == "user" || role == "assistant" {
            if had_images {
                // 上游只读消息 content 里的结构化 parts，不读顶层 image_urls
                if let Some(parts) = object.get("content") {
                    if parts.is_array() {
                        flat.push(serde_json::json!({ "role": role, "content": parts }));
                        continue;
                    }
                }
            }
            flat.push(serde_json::json!({ "role": role, "content": text }));
        } else if !role.is_empty() {
            // 未知角色一律降级为 user，不静默丢弃
            flat.push(serde_json::json!({ "role": "user", "content": text }));
        }
    }
    Flattened {
        system,
        messages: flat,
    }
}

/// 工具定义归一：只留 `type: function`，裸 name 形态包成 `{function:{...}}`，
/// 丢弃空 function / 非法 name / 重名，并给缺 `parameters` 的补空对象。
pub fn normalize_tools(tools: &mut Option<Value>) {
    let Some(Value::Array(list)) = tools else {
        return;
    };
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for tool in list.iter() {
        let Some(object) = tool.as_object() else {
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("function");
        if kind != "function" {
            // 服务端工具 / web_search 这类上游表达不了，透传会 400
            continue;
        }
        let function = match object.get("function") {
            Some(Value::Object(function)) => {
                let name = function.get("name").and_then(Value::as_str).unwrap_or("");
                if !valid_tool_name(name) || !seen.insert(name.to_string()) {
                    continue;
                }
                let mut function = function.clone();
                function
                    .entry("parameters")
                    .or_insert_with(|| serde_json::json!({ "type": "object", "properties": {} }));
                function
            }
            _ => {
                let name = object.get("name").and_then(Value::as_str).unwrap_or("");
                if !valid_tool_name(name) || !seen.insert(name.to_string()) {
                    continue;
                }
                let mut function = Map::new();
                function.insert("name".into(), Value::String(name.to_string()));
                if let Some(description) = object.get("description") {
                    function.insert("description".into(), description.clone());
                }
                function.insert(
                    "parameters".into(),
                    object
                        .get("parameters")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} })),
                );
                if let Some(strict) = object.get("strict") {
                    function.insert("strict".into(), strict.clone());
                }
                function
            }
        };
        normalized.push(serde_json::json!({ "type": "function", "function": function }));
    }
    *tools = Some(Value::Array(normalized));
}

fn valid_tool_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// 把客户端档位映射到模型支持的档位。`None` 表示不下发。
pub fn normalize_effort(effort: &str, efforts: &[String]) -> Option<String> {
    let value = effort.trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    if matches!(value.as_str(), "none" | "off" | "disabled" | "disable" | "false" | "0" | "no") {
        return None;
    }
    if efforts.is_empty() {
        return None;
    }
    if efforts.iter().any(|item| item == &value) {
        return Some(value);
    }
    // 未支持的档位向上取最近一档；超过顶格取顶格
    const RANK: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
    let wanted = RANK.iter().position(|item| *item == value).unwrap_or(2);
    let mut best: Option<(usize, &String)> = None;
    for supported in efforts {
        if let Some(rank) = RANK.iter().position(|item| *item == supported) {
            if rank >= wanted && best.map(|(at, _)| rank < at).unwrap_or(true) {
                best = Some((rank, supported));
            }
        }
    }
    best.map(|(_, name)| name.clone())
        .or_else(|| efforts.last().cloned())
}

/// DeepSeek 族：给 assistant 历史补 `reasoning_content`（空串也算补）。
pub fn backfill_reasoning(messages: Vec<Value>, deepseek: bool) -> Vec<Value> {
    if !deepseek {
        return messages;
    }
    let has_trace = messages.iter().any(|message| {
        message.get("reasoning").is_some() || message.get("reasoning_content").is_some()
    });
    if !has_trace {
        return messages;
    }
    messages
        .into_iter()
        .map(|message| {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return message;
            }
            let mut object = message.as_object().cloned().unwrap_or_default();
            if !object.contains_key("reasoning_content") {
                let value = object
                    .get("reasoning")
                    .map(|value| Value::String(value.as_str().unwrap_or("").to_string()))
                    .unwrap_or_else(|| Value::String(String::new()));
                object.insert("reasoning_content".into(), value);
            }
            Value::Object(object)
        })
        .collect()
}

/// 把「标记 + JSON 数组」形态的工具调用从正文里还原出来。
///
/// 返回 `(标记前的正文, 调用列表)`；不是这种形态就是 `None`（正文原样输出）。
pub fn parse_leaked_calls(content: &str, allowed: &[String]) -> Option<(String, Vec<Value>)> {
    let at = content.find(LEAK_MARKER)?;
    let before = content[..at].trim_end().to_string();
    let rest = &content[at + LEAK_MARKER.len()..];
    let start = rest.find('[')?;
    let end = rest.rfind(']')?;
    if end < start {
        return None;
    }
    let array: Vec<Value> = serde_json::from_str(&rest[start..=end]).ok()?;
    if array.is_empty() {
        return None;
    }
    let mut calls = Vec::new();
    for (index, item) in array.iter().enumerate() {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        if allowed.is_empty() || !allowed.iter().any(|allowed| allowed == name) {
            return None;
        }
        let arguments = item
            .get("arguments")
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "{}".into());
        calls.push(serde_json::json!({
            "index": index,
            "id": format!("call_{}_{index}", crate::wb_fingerprint::request_id()),
            "type": "function",
            "function": { "name": name, "arguments": arguments },
        }));
    }
    Some((before, calls))
}

/// 给缺 id 的增量 tool_call 补一个稳定 id（按 index 记住）。
pub fn ensure_call_id(ids: &mut std::collections::HashMap<i64, String>, index: i64) -> String {
    ids.entry(index)
        .or_insert_with(|| format!("call_{}", crate::wb_fingerprint::request_id()))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn developer_归一成_system() {
        let messages = vec![serde_json::json!({"role":"developer","content":"x"})];
        assert_eq!(
            normalize_roles(&messages)[0]["role"],
            Value::String("system".into())
        );
    }

    #[test]
    fn 结构化历史要求_id_齐全() {
        let ok = vec![
            serde_json::json!({"role":"assistant","tool_calls":[{"id":"call_1","function":{"name":"f","arguments":"{}"}}]}),
            serde_json::json!({"role":"tool","tool_call_id":"call_1","content":"r"}),
        ];
        assert!(tool_ids_ok(&ok));
        let bad = vec![serde_json::json!({"role":"tool","tool_call_id":"missing","content":"r"})];
        assert!(!tool_ids_ok(&bad));
    }

    #[test]
    fn 文本化历史把工具调用写进正文() {
        let messages = vec![serde_json::json!({
            "role": "assistant",
            "content": "我来查一下",
            "tool_calls": [{"id":"call_1","function":{"name":"read","arguments":"{\"p\":1}"}}]
        })];
        let flat = flatten(&messages, false, false);
        let content = flat.messages[0]["content"].as_str().unwrap_or("");
        assert!(content.contains(LEAK_MARKER));
        assert!(content.contains("\"name\":\"read\""));
    }

    #[test]
    fn 工具结果文本化时保留前缀() {
        let messages = vec![serde_json::json!({"role":"tool","tool_call_id":"c","content":"结果"})];
        let flat = flatten(&messages, false, false);
        assert!(flat.messages[0]["content"]
            .as_str()
            .unwrap_or("")
            .starts_with(TOOL_RESULT_MARKER));
    }

    #[test]
    fn 工具定义只留_function_并去重() {
        let mut tools = Some(serde_json::json!([
            {"type":"function","function":{"name":"a"}},
            {"type":"function","function":{"name":"a"}},
            {"type":"function","name":"b","description":"x"},
            {"type":"web_search"}
        ]));
        normalize_tools(&mut tools);
        let list = tools.and_then(|value| value.as_array().cloned()).unwrap_or_default();
        assert_eq!(list.len(), 2);
        assert!(list[0]["function"]["parameters"].is_object());
        assert_eq!(list[1]["function"]["name"], Value::String("b".into()));
    }

    #[test]
    fn 思考档位向上取最近一档() {
        let efforts = vec!["low".to_string(), "medium".to_string(), "high".to_string()];
        assert_eq!(normalize_effort("high", &efforts), Some("high".into()));
        assert_eq!(normalize_effort("xhigh", &efforts), Some("high".into()));
        assert_eq!(normalize_effort("minimal", &efforts), Some("low".into()));
        assert_eq!(normalize_effort("none", &efforts), None);
        assert_eq!(normalize_effort("high", &[]), None);
    }

    #[test]
    fn 泄漏的工具调用能还原() {
        let content = format!(
            "我先读文件\n\n{LEAK_MARKER}\n[{{\"name\":\"read\",\"arguments\":\"{{\\\"path\\\":\\\"a\\\"}}\"}}]"
        );
        let (before, calls) =
            parse_leaked_calls(&content, &["read".to_string()]).unwrap_or_else(|| panic!("应还原"));
        assert_eq!(before, "我先读文件");
        assert_eq!(calls[0]["function"]["name"], Value::String("read".into()));
        // 没声明的工具名不认
        assert!(parse_leaked_calls(&content, &["write".to_string()]).is_none());
        // 普通正文不受影响
        assert!(parse_leaked_calls("普通正文", &["read".to_string()]).is_none());
    }

    #[test]
    fn 历史工具结果截短后字节稳定() {
        let text = "头".repeat(3000) + &"尾".repeat(3000);
        let once = shrink_tool_result(&text, 1000);
        let twice = shrink_tool_result(&once, 1000);
        assert_eq!(once, twice);
        assert!(once.contains("中间省略"));
    }
}
