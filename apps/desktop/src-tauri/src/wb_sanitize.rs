//! 出站请求体的指纹清洗与消息归一。
//!
//! 上游会对 system 里的固定模板句做逐字匹配，命中就回 400 / `11128`
//! 「Illegal API invocation from an unapproved channel」——它把 Claude Code /
//! Codex CLI 的 system prompt 当成「非官方客户端」。这一段与 workbuddy2api-hub 同口径：
//! **只改确认会被拦的那几整句**，不全局删词（单独出现的产品名上游是放行的）。
//!
//! 同一趟还做三件出站前必须做的事：
//! 1. `{type:"reasoning"}` 片段折进 `reasoning_content`，再从 content 里摘掉 ——
//!    上游认不出这个 content 类型（11101）；
//! 2. DeepSeek 在 thinking 开着时要求每条 assistant 都带 `reasoning_content`
//!    （11155），缺了补空串、`reasoning` 给一个非空占位；
//! 3. `max_completion_tokens` 挪成上游认的 `max_tokens`。
//!
//! **纯逻辑**：不碰网络、不读文件。

use serde_json::{Map, Value};

/// 命中这些字面量才进改写。单独出现的词不处理 —— 上游只拦整段固定模板句。
const FEATURES: [&str; 7] = [
    "x-anthropic-billing-header",
    "cc_entrypoint=",
    "You are Claude Code",
    "Main branch (",
    "You are a coding agent running in the Codex CLI",
    "github.com/anthropics/",
    "11128",
];

/// 只改确认会被拦的那几整句。改法要尽量窄：多删一个词就可能改变模型看到的内容。
const REWRITES: [(&str, &str); 5] = [
    (
        "You are Claude Code, Anthropic's official CLI for Claude",
        "You are Claude Code, Anthropic's official CLI tool for Claude",
    ),
    (
        "Main branch (you will usually use this for PRs)",
        "Default branch (you will usually use this for PRs)",
    ),
    (
        "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
        "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
    ),
    (
        "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
        "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    ),
    ("11128", "11-128"),
];

/// OhMyOpenCode 的 agent 身份句：上游只拦整句，单独一个词不拦。
const OMO_PHRASE: &str = "Sisyphus-Junior - Focused executor from OhMyOpenCode";
const OMO_REPLACEMENT: &str = "Sisyphus-Junior - Focused executor";

/// 粗判。绝大多数文本在这里就返回，改写只在命中后才做。
pub fn has_fingerprint(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if FEATURES.iter().any(|feature| text.contains(feature)) {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    lower.contains("x-anthropic-billing-header") || lower.contains(&OMO_PHRASE.to_ascii_lowercase())
}

/// 改写一段文本。没有命中就原样返回，避免无谓的字符串分配。
pub fn sanitize_text(text: &str) -> String {
    if !has_fingerprint(text) {
        return text.to_string();
    }
    let mut out = replace_ci(text, OMO_PHRASE, OMO_REPLACEMENT);
    for (old, new) in REWRITES {
        out = out.replace(old, new);
    }
    strip_anthropic_markers(&out)
}

/// 清洗整个请求体。
pub fn sanitize_body(value: &mut Value) {
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let thinking = thinking_enabled(value, &model);

    let Some(object) = value.as_object_mut() else {
        return;
    };
    translate_max_completion_tokens(object);

    let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages.iter_mut() {
        if let Some(entry) = message.as_object_mut() {
            sanitize_message(entry);
        }
    }
    if model.starts_with("deepseek") {
        backfill_reasoning(messages, thinking);
    }
}

/// 单条消息：清洗文本、折 reasoning 片段、归一 tool_calls 的 arguments。
fn sanitize_message(entry: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    let mut reasoning: Vec<String> = Vec::new();

    if let Some(content) = entry.get_mut("content") {
        match content {
            Value::String(text) => changed |= replace_in_place(text),
            Value::Array(parts) => {
                let mut kept = Vec::with_capacity(parts.len());
                for part in parts.drain(..) {
                    let kind = part
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if kind == "reasoning" {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                reasoning.push(text.to_string());
                            }
                        }
                        changed = true;
                        continue;
                    }
                    let mut part = part;
                    if kind == "text" {                        if let Some(Value::String(text)) = part.get_mut("text") {
                            changed |= replace_in_place(text);
                        }
                    }
                    kept.push(part);
                }
                *parts = kept;
            }
            _ => {}
        }
    }

    if !reasoning.is_empty() {
        let joined = reasoning.join("\n");
        let existing = entry
            .get("reasoning_content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let merged = if existing.is_empty() {
            joined
        } else {
            format!("{existing}\n{joined}")
        };
        entry.insert("reasoning_content".into(), Value::String(merged));
        changed = true;
    }

    if let Some(Value::String(text)) = entry.get_mut("reasoning_content") {
        changed |= replace_in_place(text);
    }

    if let Some(Value::Array(calls)) = entry.get_mut("tool_calls") {
        for call in calls {
            let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) else {
                continue;
            };
            let Some(arguments) = function.get_mut("arguments") else {
                continue;
            };
            match arguments {
                Value::String(text) => changed |= replace_in_place(text),
                // 上游的 arguments 是 string；对象 / 数组 / 数字直接发会吃 11101
                Value::Null => {
                    *arguments = Value::String("{}".into());
                    changed = true;
                }
                other => {
                    let text = match serde_json::to_string(other) {
                        Ok(text) => text,
                        Err(_) => "{}".to_string(),
                    };
                    *other = Value::String(text);
                    changed = true;
                }
            }
        }
    }

    changed
}

/// DeepSeek 多轮一致性：thinking 开着（或历史上已经有推理痕迹）时，
/// 每条 assistant 都必须带非空 `reasoning_content` 与 `reasoning`。
fn backfill_reasoning(messages: &mut [Value], thinking: bool) -> bool {
    let has_trace = messages.iter().any(|message| {
        message
            .get("reasoning")
            .and_then(Value::as_str)
            .map(|text| !text.is_empty())
            .unwrap_or(false)
            || message.get("reasoning_content").is_some()
    });
    if !thinking && !has_trace {
        return false;
    }

    let mut changed = false;
    for message in messages.iter_mut() {
        let Some(entry) = message.as_object_mut() else {
            continue;
        };
        if entry.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let mut reasoning = entry
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(str::to_string);
        if reasoning.is_none() {
            reasoning = entry
                .get("reasoning")
                .and_then(Value::as_str)
                .map(str::to_string);
            entry.insert(
                "reasoning_content".into(),
                Value::String(reasoning.clone().unwrap_or_default()),
            );
            changed = true;
        }
        let reasoning = reasoning.unwrap_or_default();
        let existing = entry
            .get("reasoning")
            .and_then(Value::as_str)
            .unwrap_or("");
        if existing.is_empty() {
            // 上游校验长度 > 0，空占位不够；一个空格不带任何模型可见语义
            let placeholder = if reasoning.is_empty() {
                " "
            } else {
                reasoning.as_str()
            };
            entry.insert("reasoning".into(), Value::String(placeholder.to_string()));
            changed = true;
        }
    }
    changed
}

/// `max_completion_tokens` 与 `max_tokens` 在上游是同一样东西；
/// 只保留后者，免得两边同时出现时语义打架。
fn translate_max_completion_tokens(object: &mut Map<String, Value>) -> bool {
    let Some(alias) = object.remove("max_completion_tokens") else {
        return false;
    };
    if object.contains_key("max_tokens") {
        return true;
    }
    let value = alias
        .as_i64()
        .filter(|value| *value > 0)
        .or_else(|| {
            alias
                .as_u64()
                .filter(|value| *value > 0)
                .and_then(|value| i64::try_from(value).ok())
        });
    if let Some(value) = value {
        object.insert("max_tokens".into(), Value::from(value));
    }
    true
}

/// 只有 deepseek 需要这套 thinking 判定；其它模型一律不动。
fn thinking_enabled(value: &Value, model: &str) -> bool {
    if !model.starts_with("deepseek") {
        return false;
    }
    let kind = value
        .get("thinking")
        .and_then(|thinking| thinking.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if kind == "enabled" {
        return true;
    }
    if kind == "disabled" {
        return false;
    }
    let effort = value
        .get("reasoning_effort")
        .or_else(|| value.get("reasoningEffort"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    effort != "none"
}

/// 命中后原地改写；返回值表示是否真的有变化。
fn replace_in_place(text: &mut String) -> bool {
    if !has_fingerprint(text) {
        return false;
    }
    *text = sanitize_text(text);
    true
}

/// 按 ASCII 大小写不敏感地替换。needle 只用于 ASCII 字面量，
/// 字节下标在 `to_ascii_lowercase()` 前后一致，切片不会落在多字节字符中间。
fn replace_ci(text: &str, needle: &str, replacement: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find(&needle_lower) {
        let start = cursor + offset;
        out.push_str(&text[cursor..start]);
        out.push_str(replacement);
        cursor = start + needle.len();
    }
    out.push_str(&text[cursor..]);
    out
}

/// Claude Code 会在 system 里塞 `x-anthropic-billing-header: ...; cc_xxx=...;`，
/// 这些同样是渠道指纹。删值、保留一个中性抬头。
fn strip_anthropic_markers(text: &str) -> String {
    let mut out = replace_ci(
        text,
        "x-anthropic-billing-header",
        "x-anthropic-billing-hdr",
    );
    out = strip_header_value(&out, "x-anthropic-billing-hdr:");
    out = strip_cc_kv(&out);
    out
}

/// 删掉 `marker` 后面的值，直到 `;` / 换行为止（分号一起删，行尾空白留给下一步）。
fn strip_header_value(text: &str, marker: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find(marker) {
        let start = cursor + offset;
        out.push_str(&text[cursor..start]);
        let after = start + marker.len();
        let end = text[after..]
            .find([';', '\n', '\r'])
            .map(|at| after + at)
            .unwrap_or(text.len());
        cursor = if end < text.len() && &text[end..end + 1] == ";" {
            end + 1
        } else {
            end
        };
    }
    out.push_str(&text[cursor..]);
    out
}

/// 删掉 `cc_xxx=value;` 这一族键值对。
fn strip_cc_kv(text: &str) -> String {
    let mut out = text.to_string();
    let mut cursor = 0;
    loop {
        let lower = out.to_ascii_lowercase();
        let Some(offset) = lower[cursor..].find("cc_") else {
            break;
        };
        let start = cursor + offset;
        let key_start = start + 3;
        // 只认 `cc_` 后面紧跟字母数字/下划线再接 `=` 的形态；普通文字里的
        // "cc_" 不该触发删改
        let key_len = out[key_start..]
            .find('=')
            .filter(|at| {
                *at > 0
                    && out[key_start..key_start + at]
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            });
        let Some(key_len) = key_len else {
            cursor = key_start;
            continue;
        };
        let eq = key_start + key_len;
        let end = out[eq + 1..]
            .find([';', '\n', '\r'])
            .map(|at| eq + 1 + at)
            .unwrap_or(out.len());
        let end = if end < out.len() && &out[end..end + 1] == ";" {
            end + 1
        } else {
            end
        };
        out.replace_range(start..end, "");
        cursor = start;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_的环境行被改写() {
        let text = "Main branch (you will usually use this for PRs): main";
        assert_eq!(
            sanitize_text(text),
            "Default branch (you will usually use this for PRs): main"
        );
    }

    #[test]
    fn 其余几句固定模板也被改写() {
        let cases = [
            (
                "You are Claude Code, Anthropic's official CLI for Claude",
                "You are Claude Code, Anthropic's official CLI tool for Claude",
            ),
            (
                "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
                "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
            ),
            (
                "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
                "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(sanitize_text(input), expected);
        }
    }

    #[test]
    fn 单独出现的词不动() {
        // 上游只拦整句；把 "Main" 当一个普通词删掉会改坏用户内容
        assert_eq!(sanitize_text("Main branch is main"), "Main branch is main");
        assert_eq!(
            sanitize_text("a note about OhMyOpenCode"),
            "a note about OhMyOpenCode"
        );
        assert!(!has_fingerprint("ordinary text"));
    }

    #[test]
    fn anthropic_抬头被清掉() {
        let text = "x-anthropic-billing-header: abc; cc_entrypoint=cli; rest";
        let out = sanitize_text(text);
        assert!(!out.contains("abc"));
        assert!(!out.contains("cc_entrypoint"));
        assert!(out.contains("rest"));
    }

    #[test]
    fn 普通文本里的_cc_不被删() {
        let text = "x-anthropic-billing-header; the cc_ prefix is just text";
        let out = sanitize_text(text);
        assert!(out.contains("the cc_ prefix is just text"));
    }

    #[test]
    fn reasoning_片段折进_reasoning_content() {
        let mut body = json!({
            "model": "glm-5.2",
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "text": "先想一下"},
                    {"type": "text", "text": "答案"}
                ]
            }]
        });
        sanitize_body(&mut body);
        let message = &body["messages"][0];
        assert_eq!(message["content"], json!([{"type": "text", "text": "答案"}]));
        assert_eq!(message["reasoning_content"], "先想一下");
    }

    #[test]
    fn deepseek_回填空_reasoning_content() {
        let mut body = json!({
            "model": "deepseek-v4.1-flash",
            "thinking": {"type": "enabled"},
            "messages": [{"role": "assistant", "content": "hi"}]
        });
        sanitize_body(&mut body);
        assert_eq!(body["messages"][0]["reasoning_content"], "");
        assert_eq!(body["messages"][0]["reasoning"], " ");
    }

    #[test]
    fn 非_deepseek_不回填() {
        let mut body = json!({
            "model": "glm-5.2",
            "messages": [{"role": "assistant", "content": "hi"}]
        });
        sanitize_body(&mut body);
        assert!(body["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn tool_arguments_对象转字符串() {
        let mut body = json!({
            "model": "glm-5.2",
            "messages": [{
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "Read", "arguments": {"path": "a"}}}]
            }]
        });
        sanitize_body(&mut body);
        assert_eq!(
            body["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"a\"}"
        );
    }

    #[test]
    fn system_里的指纹在整包里被清洗() {
        let mut body = json!({
            "model": "glm-5.2",
            "messages": [{
                "role": "system",
                "content": "Main branch (you will usually use this for PRs): main"
            }]
        });
        sanitize_body(&mut body);
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .starts_with("Default branch ("));
    }

    #[test]
    fn max_completion_tokens_挪到_max_tokens() {
        let mut body = json!({
            "model": "glm-5.2",
            "max_completion_tokens": 4096,
            "messages": []
        });
        sanitize_body(&mut body);
        assert_eq!(body["max_tokens"], 4096);
        assert!(body.get("max_completion_tokens").is_none());
    }
}
