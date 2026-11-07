//! 会话压平与工具调用：把 OpenAI 的 messages / tools 变成 Qoder 上游能吃的形状。
//!
//! 三件事（与 `qoder2api-hub` 的 `flatten_messages` / `normalize_tools` 同口径）：
//!
//! 1. **历史工具调用**：国内版白名单模型（Qwen / GLM / DeepSeek）可以直传结构化
//!    `tool_calls` / `tool` 消息；其余模型把工具调用序列化成文本标记，
//!    再把工具结果当 user 消息发过去。只要有一个 `tool_call_id` 不完整，
//!    整轮退回文本化（宁可用旧协议，也不发畸形请求）。DeepSeek 进白名单是
//!    2026-11-07 真机补测的结果 —— 上游对它走 DSML 原生模板，文本化的历史会
//!    教模型把两种格式混着写（见 [`restore_leak`]）。
//! 2. **泄漏回读**：模型偶尔把工具调用当普通正文写出来（标记 + JSON 数组 /
//!    DSML 标签块 / 无名的 JSON 对象）。[`restore_leak`] 级联解析；输出侧由
//!    `qd_sse` 在收尾时决定是还原成 `tool_calls` 还是剥掉标签按普通正文放行。
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
/// DeepSeek 两档是 2026-11-07 补测加进来的：单轮 / 多轮结构化历史都正常，
/// 文本化反而会和上游的 DSML 原生工具模板打架（模型把两种格式混着写，见
/// [`restore_leak`]）。
const STRUCTURED_WHITELIST: [&str; 10] = [
    "qmodel",
    "qfmodel",
    "q37",
    "gmodel",
    "gfmodel",
    "gm51",
    "qmodel_latest",
    "auto",
    "dmodel",
    "dfmodel",
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

/// 工具声明摘要：名字 + 参数属性 + 必填。泄漏回读拿它做无名字段的归属推断。
#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: String,
    pub properties: std::collections::HashSet<String>,
    pub required: std::collections::HashSet<String>,
}

impl ToolSchema {
    /// 泄漏出的参数键能不能安在这份声明上：键都声明过、必填都在场。
    fn covers(&self, keys: &std::collections::HashSet<String>) -> bool {
        !keys.is_empty()
            && keys.iter().all(|key| self.properties.contains(key))
            && self.required.iter().all(|key| keys.contains(key))
    }
}

/// 标记后面那段的「JSON 数组」形态。
fn array_calls(rest: &str, allowed: &[String]) -> Option<Vec<Value>> {
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
        calls.push(build_call(index, name, arguments));
    }
    Some(calls)
}

/// 一个 DSML 特殊标签（DeepSeek 在 Qoder 上游的原生工具标记，偶尔整段或半截漏进正文）。
#[derive(Debug, PartialEq)]
pub struct DsmlTag {
    pub closing: bool,
    /// calls / invoke / parameter
    pub kind: String,
    /// `name="…"` 属性（invoke 是工具名，parameter 是参数名）
    pub attr: Option<(String, String)>,
    /// 在原文里的字节区间
    pub start: usize,
    pub end: usize,
}

/// 扫出正文里的 DSML 标签：`<| DSML | invoke name="bash">`、`</| DSML | parameter>`。
/// 竖线与空白可多可少（泄漏出来的间距不稳定）；只认 calls / invoke / parameter 三个词，
/// 语法不对就不是标签。
pub fn scan_dsml_tags(text: &str) -> Vec<DsmlTag> {
    let bytes = text.as_bytes();
    let mut tags = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at] != b'<' {
            at += 1;
            continue;
        }
        match try_parse_tag(text, at) {
            Some(tag) => {
                at = tag.end;
                tags.push(tag);
            }
            None => at += 1,
        }
    }
    tags
}

/// 从 `open_start`（指向 `<`）尝试解析一个 DSML 标签；语法不对就是 `None`。
fn try_parse_tag(text: &str, open_start: usize) -> Option<DsmlTag> {
    const WORDS: [&str; 3] = ["calls", "invoke", "parameter"];
    let bytes = text.as_bytes();
    let mut cursor = open_start + 1;
    let closing = if cursor < bytes.len() && bytes[cursor] == b'/' {
        cursor += 1;
        true
    } else {
        false
    };
    if cursor >= bytes.len() || bytes[cursor] != b'|' {
        return None;
    }
    cursor += 1;
    cursor += ascii_ws(bytes, cursor);
    if cursor + 4 > bytes.len() || !bytes[cursor..cursor + 4].eq_ignore_ascii_case(b"DSML") {
        return None;
    }
    cursor += 4;
    cursor += ascii_ws(bytes, cursor);
    if cursor >= bytes.len() || bytes[cursor] != b'|' {
        return None;
    }
    cursor += 1;
    cursor += ascii_ws(bytes, cursor);
    let word_start = cursor;
    while cursor < bytes.len()
        && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_' || bytes[cursor] == b'-')
    {
        cursor += 1;
    }
    if cursor == word_start {
        return None;
    }
    let kind = text[word_start..cursor].to_ascii_lowercase();
    if !WORDS.contains(&kind.as_str()) {
        return None;
    }
    // 可选的 name="…" 属性（只能有一个）
    let mut attr = None;
    loop {
        cursor += ascii_ws(bytes, cursor);
        if cursor >= bytes.len() {
            return None;
        }
        if bytes[cursor] == b'>' {
            return Some(DsmlTag {
                closing,
                kind,
                attr,
                start: open_start,
                end: cursor + 1,
            });
        }
        let name_start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_')
        {
            cursor += 1;
        }
        if cursor == name_start || cursor + 1 >= bytes.len() {
            return None;
        }
        let attr_name = text[name_start..cursor].to_string();
        cursor += ascii_ws(bytes, cursor);
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            return None;
        }
        cursor += 1;
        cursor += ascii_ws(bytes, cursor);
        if cursor >= bytes.len() || bytes[cursor] != b'"' {
            return None;
        }
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != b'"' {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            return None;
        }
        if attr.is_some() {
            return None;
        }
        attr = Some((attr_name, text[value_start..cursor].to_string()));
        cursor += 1;
    }
}

fn ascii_ws(bytes: &[u8], mut at: usize) -> usize {
    let start = at;
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    at - start
}

/// 剥掉正文里的 DSML 标签（孤儿闭合标签不是给人看的）。
pub fn strip_dsml_tags(text: &str) -> String {
    if !text.contains("<") {
        return text.to_string();
    }
    let tags = scan_dsml_tags(text);
    strip_with(text, &tags, &[])
}

/// 去掉 `skip` 区间（已还原的 DSML 块）再剥掉剩下的标签。
/// 区间先合并再挖空 —— 标签和块在字节上有重叠，逐个挖会挖漏。
fn strip_with(text: &str, tags: &[DsmlTag], skip: &[(usize, usize)]) -> String {
    let mut spans: Vec<(usize, usize)> = tags
        .iter()
        .map(|tag| (tag.start, tag.end))
        .chain(skip.iter().cloned())
        .collect();
    spans.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for (start, end) in spans {
        if end <= cursor {
            continue;
        }
        let start = start.max(cursor);
        if start > cursor {
            out.push_str(&text[cursor..start]);
        }
        cursor = end.max(cursor);
    }
    out.push_str(&text[cursor..]);
    out
}

/// 从正文里还原泄漏的工具调用（级联，认三张脸）：
///
/// 1. 「标记 + JSON 数组」：历史文本化的模型照着历史写（既有形态）；
/// 2. DSML 块：`invoke` / `parameter` 标签成对或半截；
/// 3. JSON 对象：有名直接还原；没名字按声明过的工具 schema 推断，
///    `arguments` 字符串残缺时做有界修复（最多补 `"}` 两个字符）。
///
/// 前提是上下文里看得到泄漏痕迹（标记或 DSML 标签）——普通正文里的 JSON 示例
/// 不能被当成工具调用执行。名字没声明的整条不认（与既有口径一致）。
/// 返回 `(还原后的正文, 调用列表)`；不是泄漏形态就是 `None`。
pub fn restore_leak(content: &str, schemas: &[ToolSchema]) -> Option<(String, Vec<Value>)> {
    if content.is_empty() {
        return None;
    }
    let tags = scan_dsml_tags(content);
    let stripped = strip_with(content, &tags, &[]);
    let allowed: Vec<String> = schemas.iter().map(|schema| schema.name.clone()).collect();
    let marker_at = stripped.find(LEAK_MARKER);
    if marker_at.is_none() && tags.is_empty() {
        return None;
    }

    // 1) 标记 + JSON 数组
    if let Some(at) = marker_at {
        if let Some(calls) = array_calls(&stripped[at + LEAK_MARKER.len()..], &allowed) {
            return Some((stripped[..at].trim_end().to_string(), calls));
        }
    }

    // 2) DSML 块
    if let Some((before, calls)) = dsml_calls(content, &tags, &allowed) {
        return Some((before, calls));
    }

    // 3) JSON 对象（有名直接还原，无名按 schema 推断）
    if let Some(at) = marker_at {
        if let Some((_, _, calls)) =
            object_calls(&stripped[at + LEAK_MARKER.len()..], &allowed, schemas)
        {
            return Some((stripped[..at].trim_end().to_string(), calls));
        }
    } else if let Some((start, end, calls)) = object_calls(&stripped, &allowed, schemas) {
        let mut before = format!("{}{}", &stripped[..start], &stripped[end..]);
        if let Some(at) = before.find(LEAK_MARKER) {
            before = before[..at].trim_end().to_string();
        }
        return Some((before.trim().to_string(), calls));
    }
    None
}

/// DSML 标签序列 → 工具调用。任何 invoke 的工具名没声明就整条不认。
fn dsml_calls(
    content: &str,
    tags: &[DsmlTag],
    allowed: &[String],
) -> Option<(String, Vec<Value>)> {
    if tags.is_empty() {
        return None;
    }
    let mut calls: Vec<Value> = Vec::new();
    let mut params: Vec<(String, String)> = Vec::new();
    let mut invoke: Option<(String, usize)> = None;
    let mut param: Option<(String, usize)> = None;
    let mut consumed: Vec<(usize, usize)> = Vec::new();
    for tag in tags {
        match (tag.closing, tag.kind.as_str()) {
            (false, "invoke") => {
                if invoke.is_some() {
                    return None;
                }
                if let Some((_, name)) = &tag.attr {
                    if name.trim().is_empty() {
                        continue;
                    }
                    invoke = Some((name.clone(), tag.start));
                }
            }
            (false, "parameter") => {
                if invoke.is_some() && param.is_none() {
                    if let Some((_, name)) = &tag.attr {
                        if !name.trim().is_empty() {
                            param = Some((name.clone(), tag.end));
                        }
                    }
                }
            }
            (true, "parameter") => {
                if let Some((name, start)) = param.take() {
                    params.push((name, content[start..tag.start].trim().to_string()));
                }
            }
            (true, "invoke") => {
                let Some((name, start)) = invoke.take() else {
                    continue;
                };
                param = None;
                if !allowed.iter().any(|item| item == &name) {
                    return None;
                }
                consumed.push((start, tag.end));
                calls.push(build_call(calls.len(), &name, args_from_params(&params)));
                params.clear();
            }
            _ => {}
        }
    }
    // 收尾截断：invoke 没闭合但参数已经齐了，也认
    if let Some((name, start)) = invoke {
        if !params.is_empty() {
            if !allowed.iter().any(|item| item == &name) {
                return None;
            }
            consumed.push((start, content.len()));
            calls.push(build_call(calls.len(), &name, args_from_params(&params)));
        }
    }
    if calls.is_empty() {
        return None;
    }
    let mut before = strip_with(content, tags, &consumed);
    if let Some(at) = before.find(LEAK_MARKER) {
        before = before[..at].trim_end().to_string();
    }
    Some((before.trim().to_string(), calls))
}

/// DSML 参数列表 → arguments JSON。
/// `arguments` 参数的内容是 JSON 就合并进来；其余参数按名字落键。
fn args_from_params(params: &[(String, String)]) -> String {
    let mut map = Map::new();
    for (name, value) in params {
        let parsed: Option<Value> = serde_json::from_str(value).ok();
        match parsed {
            Some(Value::Object(inner)) if name == "arguments" => {
                for (key, item) in inner {
                    map.insert(key, item);
                }
            }
            Some(item) => {
                map.insert(name.clone(), item);
            }
            None => {
                map.insert(name.clone(), Value::String(value.clone()));
            }
        }
    }
    Value::Object(map).to_string()
}

/// 在一段正文里找 JSON 对象形态的泄漏。返回 `(对象起点, 对象终点, 调用列表)`，
/// 坐标相对 `region`。多个对象从后往前试（越靠近泄漏尾部越像调用）。
fn object_calls(
    region: &str,
    allowed: &[String],
    schemas: &[ToolSchema],
) -> Option<(usize, usize, Vec<Value>)> {
    for (start, end) in balanced_objects(region).into_iter().rev() {
        let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&region[start..=end]) else {
            continue;
        };
        // 有名：名字声明过就直接还原
        if let Some(name) = object.get("name").and_then(Value::as_str) {
            if !allowed.is_empty() && allowed.iter().any(|item| item == name) {
                let arguments = match object.get("arguments") {
                    Some(Value::String(text)) => repair_json(text),
                    Some(other) => other.to_string(),
                    None => {
                        let mut rest = object.clone();
                        rest.remove("name");
                        Value::Object(rest).to_string()
                    }
                };
                return Some((start, end + 1, vec![build_call(0, name, arguments)]));
            }
            continue;
        }
        // 无名：按声明过的 schema 推断，唯一匹配才还原
        let Some(Value::Object(arguments)) = args_from_object(&object) else {
            continue;
        };
        let keys: std::collections::HashSet<String> =
            arguments.keys().cloned().collect();
        let matched: Vec<&ToolSchema> =
            schemas.iter().filter(|schema| schema.covers(&keys)).collect();
        if matched.len() == 1 {
            let name = matched[0].name.clone();
            let arguments = Value::Object(arguments).to_string();
            return Some((start, end + 1, vec![build_call(0, &name, arguments)]));
        }
    }
    None
}

/// 无名对象 → arguments：`arguments` 键（字符串 / 对象）展开后与其余键合并。
/// `arguments` 字符串连修复都救不回来时不敢认。
fn args_from_object(object: &Map<String, Value>) -> Option<Value> {
    let mut base = Map::new();
    match object.get("arguments") {
        Some(Value::String(text)) => match repair_json_object(text) {
            Some(Value::Object(inner)) => base = inner,
            _ => return None,
        },
        Some(Value::Object(inner)) => base = inner.clone(),
        Some(other) => {
            base.insert("arguments".into(), other.clone());
        }
        None => {}
    }
    for (key, value) in object {
        if key == "arguments" || key == "name" {
            continue;
        }
        base.insert(key.clone(), value.clone());
    }
    if base.is_empty() {
        return None;
    }
    Some(Value::Object(base))
}

/// 残缺 JSON 的有界修复：模型常把结尾的 `\"}` 写丢，最多补两个字符。
/// 救回来必须是 JSON 对象，否则原样返回（调用方再判）。
fn repair_json(text: &str) -> String {
    match repair_json_object(text) {
        Some(value) => value.to_string(),
        None => text.to_string(),
    }
}

fn repair_json_object(text: &str) -> Option<Value> {
    const SUFFIXES: [&str; 5] = ["", "\"", "}", "\"}", "\"}\""];
    // 第二轮先修掉非法转义（`\'` 这类 —— 命令文本里的 `\` 没双重转义）再试
    for candidate in [text.to_string(), escape_sane(text)] {
        for suffix in SUFFIXES {
            if let Ok(value) = serde_json::from_str::<Value>(&format!("{candidate}{suffix}")) {
                if value.is_object() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// 把 JSON 字符串里非法的转义序列修成合法的：`\X`（X 不在 JSON 转义表里，
/// 常见是命令文本里的 `\'`）双重转义成 `\\X`，反斜杠按字面量保留。
/// 结尾悬空的反斜杠（截断常见）直接丢掉。字符串外的内容原样保留。
fn escape_sane(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if !in_string {
            if ch == '"' {
                in_string = true;
            }
            out.push(ch);
            continue;
        }
        if escaped {
            escaped = false;
            if matches!(ch, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') {
                out.push('\\');
                out.push(ch);
            } else {
                out.push('\\');
                out.push('\\');
                out.push(ch);
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = false;
                out.push(ch);
            }
            '\\' => escaped = true,
            other => out.push(other),
        }
    }
    out
}

/// 找出一段正文里所有配平的顶层 `{…}`（字符串感知）。
fn balanced_objects(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    out.push((start, index));
                }
                if depth < 0 {
                    depth = 0;
                }
            }
            _ => {}
        }
    }
    out
}

fn build_call(index: usize, name: &str, arguments: String) -> Value {
    serde_json::json!({
        "index": index,
        "id": format!("call_{}_{index}", crate::wb_fingerprint::request_id()),
        "type": "function",
        "function": { "name": name, "arguments": arguments },
    })
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
        let schema = ToolSchema {
            name: "read".into(),
            properties: ["path".to_string()].into_iter().collect(),
            required: ["path".to_string()].into_iter().collect(),
        };
        let (before, calls) = restore_leak(&content, std::slice::from_ref(&schema))
            .unwrap_or_else(|| panic!("应还原"));
        assert_eq!(before, "我先读文件");
        assert_eq!(calls[0]["function"]["name"], Value::String("read".into()));
        // 没声明的工具名不认
        let other = ToolSchema {
            name: "write".into(),
            properties: schema.properties.clone(),
            required: schema.required.clone(),
        };
        assert!(restore_leak(&content, std::slice::from_ref(&other)).is_none());
        // 普通正文不受影响
        assert!(restore_leak("普通正文", std::slice::from_ref(&schema)).is_none());
    }

    #[test]
    fn 历史工具结果截短后字节稳定() {
        let text = "头".repeat(3000) + &"尾".repeat(3000);
        let once = shrink_tool_result(&text, 1000);
        let twice = shrink_tool_result(&once, 1000);
        assert_eq!(once, twice);
        assert!(once.contains("中间省略"));
    }

    fn bash_schema() -> ToolSchema {
        ToolSchema {
            name: "bash".into(),
            properties: ["command", "description", "timeout", "run_in_background"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            required: ["command".to_string()].into_iter().collect(),
        }
    }

    #[test]
    fn deepseek_两档也走结构化历史() {
        let ok = vec![
            serde_json::json!({"role":"assistant","tool_calls":[{"id":"call_1","function":{"name":"f","arguments":"{}"}}]}),
            serde_json::json!({"role":"tool","tool_call_id":"call_1","content":"r"}),
        ];
        assert!(structured_enabled("dfmodel", &ok));
        assert!(structured_enabled("dmodel", &ok));
        assert!(!structured_enabled("kmodel", &ok));
    }

    #[test]
    fn dsml_整块标签能还原() {
        let content = concat!(
            "我来跑一下\n",
            "<| DSML | calls>\n",
            "<| DSML | invoke name=\"bash\">\n",
            "<| DSML | parameter name=\"command\">echo hi</| DSML | parameter>\n",
            "<| DSML | parameter name=\"description\">打个招呼</| DSML | parameter>\n",
            "</| DSML | invoke>\n",
            "</| DSML | calls>",
        );
        let (before, calls) =
            restore_leak(content, &[bash_schema()]).unwrap_or_else(|| panic!("应还原"));
        assert_eq!(before, "我来跑一下");
        assert_eq!(calls[0]["function"]["name"], Value::String("bash".into()));
        let arguments = calls[0]["function"]["arguments"].as_str().unwrap_or("");
        assert!(arguments.contains("\"command\""));
        assert!(arguments.contains("echo hi"));
        assert!(arguments.contains("打个招呼"));
    }

    #[test]
    fn dsml_标签间距不稳定也能认() {
        let content =
            "<|DSML|invoke name=\"bash\"><|DSML|parameter name=\"command\">ls</|DSML|parameter></|DSML|invoke></|DSML|calls>";
        let (_, calls) =
            restore_leak(content, &[bash_schema()]).unwrap_or_else(|| panic!("应还原"));
        assert_eq!(calls[0]["function"]["name"], Value::String("bash".into()));
    }

    #[test]
    fn dsml_工具名没声明整条不认() {
        let content = "<| DSML | invoke name=\"rm\"><| DSML | parameter name=\"command\">x</| DSML | parameter></| DSML | invoke>";
        assert!(restore_leak(content, &[bash_schema()]).is_none());
    }

    /// 2026-11-07 真机泄漏的原文（DeepSeek-Flash，ZCode 会话里抓到的）：
    /// 标记 + 无名的 JSON 对象（arguments 字符串还残了结尾）+ 孤儿闭合标签。
    const SCREENSHOT_LEAK: &str = r#"[assistant 请求调用工具] {"arguments":"{\"command\":\"cd /e/project/muyian/workbench && grep -n 'formatMailSize' packages/mail/src/.ts | head -3 && grep -n 'export \\' packages/mail/src/index.ts' && sed -n '255,264p' packages/mail/src/parse.ts","description":"Check formatMailSize location"}</| DSML | parameter> </| DSML | invoke> </| DSML | calls>"#;

    #[test]
    fn 截图形态_无名残缺对象能推断还原() {
        let (before, calls) = restore_leak(SCREENSHOT_LEAK, &[bash_schema()])
            .unwrap_or_else(|| panic!("应还原"));
        assert_eq!(before, "");
        assert_eq!(calls[0]["function"]["name"], Value::String("bash".into()));
        let arguments = calls[0]["function"]["arguments"].as_str().unwrap_or("");
        let args: Value = serde_json::from_str(arguments).unwrap_or_else(|err| panic!("arguments 应是 JSON：{err}"));
        assert!(args["command"].as_str().unwrap_or("").contains("grep -n 'formatMailSize'"));
        assert_eq!(args["description"], Value::String("Check formatMailSize location".into()));
    }

    #[test]
    fn 无名字段有两个候选时不还原() {
        let other = ToolSchema {
            name: "run".into(),
            properties: bash_schema().properties,
            required: bash_schema().required,
        };
        assert!(restore_leak(SCREENSHOT_LEAK, &[bash_schema(), other]).is_none());
    }

    #[test]
    fn 无名字段缺必填不还原() {
        let picky = ToolSchema {
            name: "bash".into(),
            properties: bash_schema().properties,
            required: ["command", "timeout"].into_iter().map(str::to_string).collect(),
        };
        assert!(restore_leak(SCREENSHOT_LEAK, &[picky]).is_none());
    }

    #[test]
    fn 没有泄漏痕迹时对象不还原() {
        // 普通正文里的 JSON 示例不能被当成工具调用执行
        assert!(restore_leak(r#"示例：{"name":"bash","arguments":"{}"}"#, &[bash_schema()]).is_none());
    }

    #[test]
    fn 孤儿闭合标签在释放前被剥掉() {
        let content = "正文</| DSML | parameter> </| DSML | invoke> </| DSML | calls>";
        // 认不出调用（没有 invoke 名字也没有 JSON），还原层返回 None；
        // 释放路径（LeakGuard::finish）负责把标签剥掉再吐给用户
        assert!(restore_leak(content, &[bash_schema()]).is_none());
        assert_eq!(strip_dsml_tags(content), "正文  ");
    }

    #[test]
    fn 残缺_json_修复有边界() {
        assert_eq!(
            repair_json_object("{\"command\":\"echo\""),
            Some(serde_json::json!({"command":"echo"}))
        );
        assert_eq!(repair_json_object("完全不是JSON"), None);
    }
}
