//! 上游 SSE 信封的解包、chunk 清洗与聚合。
//!
//! 上游每一帧不是 OpenAI chunk，而是：
//! `data:{"headers":{…},"body":"<内层 OpenAI chunk JSON 字符串>","statusCodeValue":200}`
//! `statusCodeValue != 200` 表示错误藏在 HTTP 200 里面（上游常用 418 表示
//! provider 故障）。结束帧的 `body` 是 `"[DONE]"`，另有 `event:finish{…}` 计时帧要忽略。
//!
//! 这里只做「字节流 → 干净的 chunk」，以及对流内泄漏工具调用的缓冲；
//! 写回客户端由 `qd_relay` 负责。
//!
//! 纯逻辑：不碰网络。

use serde_json::{Map, Value};

use crate::qd_tools::LEAK_MARKER;

/// 解包后的事件。
pub enum Envelope {
    Chunk(Value),
    Done,
    /// 信封里带的错误（status + 详情）
    Failed(u16, String),
}

/// 增量解码器：喂字节，吐事件。内部按行缓冲，能处理切在半行上的块。
#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Envelope> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=newline).collect();
            let text = String::from_utf8_lossy(&line);
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.starts_with(':') || trimmed.starts_with("event:") {
                continue;
            }
            let Some(data) = trimmed.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                events.push(Envelope::Done);
                continue;
            }
            let Ok(outer) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let status = outer
                .get("statusCodeValue")
                .and_then(Value::as_u64)
                .unwrap_or(200);
            let body = outer.get("body").and_then(Value::as_str).unwrap_or("");
            if status != 200 {
                events.push(Envelope::Failed(
                    status as u16,
                    if body.is_empty() {
                        data.chars().take(400).collect()
                    } else {
                        body.chars().take(400).collect()
                    },
                ));
                continue;
            }
            if body == "[DONE]" {
                events.push(Envelope::Done);
                continue;
            }
            if body.is_empty() {
                continue;
            }
            if let Ok(inner) = serde_json::from_str::<Value>(body) {
                if let Some(error) = inner_error(&inner) {
                    events.push(error);
                } else if let Some(chunk) = clean_chunk(inner) {
                    events.push(Envelope::Chunk(chunk));
                }
            }
        }
        events
    }

    /// 流结束时缓冲区里可能还剩半行（没有换行结尾的最后一帧）。
    pub fn finish(&mut self) -> Vec<Envelope> {
        if self.buffer.is_empty() {
            return Vec::new();
        }
        let mut tail = std::mem::take(&mut self.buffer);
        tail.push(b'\n');
        self.push(&tail)
    }
}

/// HTTP 200 信封里的内层错误（上游有时把错误放在 chunk 的 `error` 字段）。
fn inner_error(value: &Value) -> Option<Envelope> {
    let error = value.get("error")?;
    if error.is_null() {
        return None;
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_else(|| error.as_str().unwrap_or("上游内层错误"));
    Some(Envelope::Failed(502, message.to_string()))
}

/// 清洗一帧：补标准 `usage.prompt_tokens_details.cached_tokens`、删空噪声字段。
/// 返回 `None` 表示这帧没有内容（空 delta 且没有 finish_reason）。
pub fn clean_chunk(mut value: Value) -> Option<Value> {
    if !value.is_object() {
        return Some(value);
    }
    if let Some(usage) = value.get_mut("usage") {
        normalize_usage(usage);
    }
    let mut changed = false;
    if let Some(choices) = value.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices.iter_mut() {
            let Some(object) = choice.as_object_mut() else {
                continue;
            };
            let finish = object.get("finish_reason").cloned().unwrap_or(Value::Null);
            let Some(delta) = object.get_mut("delta").and_then(Value::as_object_mut) else {
                continue;
            };
            if let Some(call) = delta.get("function_call") {
                let empty = match call {
                    Value::Object(map) => !map.contains_key("name"),
                    other => other.is_null(),
                };
                if empty {
                    delta.remove("function_call");
                    changed = true;
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                if calls.is_empty() {
                    delta.remove("tool_calls");
                    changed = true;
                }
            }
            // 空字符串的 content 也是噪声（上游每帧都会补一个空 delta）
            if delta.get("content").and_then(Value::as_str) == Some("") {
                delta.remove("content");
                changed = true;
            }
            for key in ["extra_fields", "refusal", "reasoning_content"] {
                if let Some(field) = delta.get(key) {
                    if field.is_null() || field.as_str() == Some("") {
                        delta.remove(key);
                        changed = true;
                    }
                }
            }
            if delta.is_empty() && finish.is_null() {
                changed = true;
                *choice = Value::Null;
            }
        }
        choices.retain(|choice| !choice.is_null());
    }
    if changed
        && value
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|list| list.is_empty())
        && value.get("usage").is_none()
    {
        return None;
    }
    Some(value)
}

/// 把各家缓存命中字段搬进 OpenAI 标准位（原字段保留）。
pub fn normalize_usage(usage: &mut Value) {
    let Some(object) = usage.as_object_mut() else {
        return;
    };
    let mut cached = 0i64;
    for key in ["cached_tokens", "prompt_cache_hit_tokens"] {
        if let Some(value) = object.get(key).and_then(Value::as_i64) {
            if value > 0 {
                cached = value;
                break;
            }
        }
    }
    if cached == 0 {
        if let Some(value) = object
            .get("completion_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_i64)
        {
            if value > 0 {
                cached = value;
            }
        }
    }
    if cached == 0 {
        return;
    }
    let details = object
        .entry("prompt_tokens_details")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(details) = details.as_object_mut() {
        details.insert("cached_tokens".into(), Value::Number(cached.into()));
    }
}

/// 流内泄漏工具调用的缓冲：正文里出现 [`LEAK_MARKER`] 时先扣住，收尾再决定。
#[derive(Default)]
pub struct LeakGuard {
    held: String,
    active: bool,
}

impl LeakGuard {
    /// 喂一段正文，返回现在可以立刻发给客户端的那部分。
    pub fn feed(&mut self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        if self.active {
            self.held.push_str(text);
            return String::new();
        }
        if let Some(at) = text.find(LEAK_MARKER) {
            self.active = true;
            self.held.push_str(&text[at..]);
            return text[..at].to_string();
        }
        // 标记可能被切在帧边界上：尾部与标记前缀相同的部分先扣住
        let hold = suffix_prefix(text, LEAK_MARKER);
        if hold == 0 {
            return text.to_string();
        }
        let split = text.len() - hold;
        self.held.push_str(&text[split..]);
        self.active = true;
        text[..split].to_string()
    }

    /// 收尾。返回 `(标记前的残留正文, 还原出的调用)`；不是调用形态就原样吐出。
    pub fn finish(&mut self, allowed: &[String]) -> (String, Vec<Value>) {
        let held = std::mem::take(&mut self.held);
        self.active = false;
        if held.is_empty() {
            return (String::new(), Vec::new());
        }
        match crate::qd_tools::parse_leaked_calls(&held, allowed) {
            Some((before, calls)) => (before, calls),
            None => (held, Vec::new()),
        }
    }
}

/// `text` 的尾部有多少字符是 `marker` 的前缀（用于跨帧扣住标记）。
fn suffix_prefix(text: &str, marker: &str) -> usize {
    let text_chars: Vec<char> = text.chars().collect();
    let marker_chars: Vec<char> = marker.chars().collect();
    let max = text_chars.len().min(marker_chars.len().saturating_sub(1));
    for len in (1..=max).rev() {
        if text_chars[text_chars.len() - len..] == marker_chars[..len] {
            return text_chars[text_chars.len() - len..]
                .iter()
                .map(|ch| ch.len_utf8())
                .sum();
        }
    }
    0
}

/// 非流式聚合。
#[derive(Default)]
pub struct Aggregator {
    pub id: String,
    pub model: String,
    pub created: i64,
    content: String,
    reasoning: String,
    calls: Vec<Value>,
    usage: Value,
    finish: String,
}

impl Aggregator {
    pub fn absorb(&mut self, chunk: &Value) {
        if let Some(id) = chunk.get("id").and_then(Value::as_str) {
            self.id = id.to_string();
        }
        if let Some(model) = chunk.get("model").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        if let Some(created) = chunk.get("created").and_then(Value::as_i64) {
            self.created = created;
        }
        if let Some(usage) = chunk.get("usage") {
            if !usage.is_null() {
                self.usage = usage.clone();
            }
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
        else {
            return;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if !reason.is_empty() {
                self.finish = reason.to_string();
            }
        }
        let Some(delta) = choice.get("delta") else {
            return;
        };
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.content.push_str(text);
        }
        if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
            self.reasoning.push_str(text);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                merge_call(&mut self.calls, call);
            }
        }
    }

    pub fn into_completion(mut self, allowed: &[String]) -> Value {
        // 泄漏回读：正文里如果带标记 + JSON 数组，就还原成结构化调用
        let mut content = std::mem::take(&mut self.content);
        if self.calls.is_empty() {
            if let Some((before, calls)) = crate::qd_tools::parse_leaked_calls(&content, allowed) {
                content = before;
                self.calls = calls;
                self.finish = "tool_calls".into();
            }
        }
        let mut message = Map::new();
        message.insert("role".into(), Value::String("assistant".into()));
        message.insert("content".into(), Value::String(content));
        if !self.reasoning.is_empty() {
            message.insert("reasoning_content".into(), Value::String(self.reasoning));
        }
        if !self.calls.is_empty() {
            let calls: Vec<Value> = self
                .calls
                .into_iter()
                .map(|call| {
                    let function = call.get("function").cloned().unwrap_or_default();
                    serde_json::json!({
                        "id": call.get("id").and_then(Value::as_str).unwrap_or(""),
                        "type": "function",
                        "function": function,
                    })
                })
                .collect();
            message.insert("tool_calls".into(), Value::Array(calls));
            if self.finish.is_empty() || self.finish == "stop" {
                self.finish = "tool_calls".into();
            }
        }
        let mut out = serde_json::json!({
            "id": if self.id.is_empty() { "chatcmpl-qoder".to_string() } else { self.id },
            "object": "chat.completion",
            "created": if self.created == 0 { crate::qd_account::now_secs() } else { self.created },
            "model": self.model,
            "choices": [{
                "index": 0,
                "message": Value::Object(message),
                "finish_reason": if self.finish.is_empty() { "stop".to_string() } else { self.finish },
            }],
        });
        if !self.usage.is_null() {
            out["usage"] = self.usage;
        }
        out
    }
}

/// 把同一 index 的分片工具调用合并成完整调用。
pub fn merge_call(calls: &mut Vec<Value>, delta: &Value) {
    let index = delta.get("index").and_then(Value::as_i64).unwrap_or(0) as usize;
    while calls.len() <= index {
        calls.push(serde_json::json!({
            "id": "", "type": "function",
            "function": { "name": "", "arguments": "" }
        }));
    }
    let target = &mut calls[index];
    if let Some(id) = delta.get("id").and_then(Value::as_str) {
        if !id.is_empty() {
            target["id"] = Value::String(id.to_string());
        }
    }
    let Some(function) = delta.get("function") else {
        return;
    };
    if let Some(name) = function.get("name").and_then(Value::as_str) {
        if !name.is_empty() {
            target["function"]["name"] = Value::String(name.to_string());
        }
    }
    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
        let existing = target["function"]["arguments"]
            .as_str()
            .unwrap_or("")
            .to_string();
        target["function"]["arguments"] = Value::String(existing + arguments);
    }
}

/// 给缺 id 的增量调用补 id（按 index 稳定）。
pub fn fill_call_ids(chunk: &mut Value, ids: &mut std::collections::HashMap<i64, String>) {
    let Some(choices) = chunk.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices.iter_mut() {
        let Some(calls) = choice
            .get_mut("delta")
            .and_then(|delta| delta.get_mut("tool_calls"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for call in calls.iter_mut() {
            let index = call.get("index").and_then(Value::as_i64).unwrap_or(0);
            let id = call.get("id").and_then(Value::as_str).unwrap_or("");
            if id.trim().is_empty() {
                call["id"] = Value::String(crate::qd_tools::ensure_call_id(ids, index));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(body: &str) -> String {
        format!(
            "data:{}\n",
            serde_json::json!({ "headers": {}, "body": body, "statusCodeValue": 200 })
        )
    }

    #[test]
    fn 信封能解出内层_chunk_并处理切块() {
        let mut decoder = Decoder::default();
        let first = envelope(r#"{"id":"c1","choices":[{"delta":{"content":"你"},"finish_reason":null}]}"#);
        let second = envelope("[DONE]");
        let mut events = decoder.push(first.as_bytes());
        // 第二行只推一半，应该没有新事件
        events.extend(decoder.push(&second.as_bytes()[..10]));
        assert_eq!(events.len(), 1);
        events.extend(decoder.push(&second.as_bytes()[10..]));
        match &events[0] {
            Envelope::Chunk(chunk) => {
                assert_eq!(chunk["choices"][0]["delta"]["content"], Value::String("你".into()));
            }
            _ => panic!("第一帧应是 chunk"),
        }
        assert!(events.iter().any(|event| matches!(event, Envelope::Done)));
    }

    #[test]
    fn 信封里的非_200_是错误() {
        let mut decoder = Decoder::default();
        let line = format!(
            "data:{}\n",
            serde_json::json!({ "body": "provider_error", "statusCodeValue": 418 })
        );
        let events = decoder.push(line.as_bytes());
        assert!(matches!(events[0], Envelope::Failed(418, _)));
    }

    #[test]
    fn 空_delta_被丢掉_usage_缓存位被补上() {
        let empty = clean_chunk(serde_json::json!({
            "choices": [{"delta": {"content": ""}, "finish_reason": null}]
        }));
        assert!(empty.is_none());
        let chunk = clean_chunk(serde_json::json!({
            "choices": [{"delta": {"content": "x"}, "finish_reason": null}],
            "usage": { "prompt_cache_hit_tokens": 9 }
        }))
        .unwrap_or_else(|| panic!("应保留"));
        assert_eq!(
            chunk["usage"]["prompt_tokens_details"]["cached_tokens"],
            Value::Number(9.into())
        );
    }

    #[test]
    fn 非流式聚合把分片调用拼起来() {
        let mut aggregator = Aggregator::default();
        aggregator.absorb(&serde_json::json!({
            "id": "c1",
            "model": "M",
            "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "read", "arguments": "{\"a\":"}}]}, "finish_reason": null}]
        }));
        aggregator.absorb(&serde_json::json!({
            "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "1}"}}]}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}
        }));
        let out = aggregator.into_completion(&[])
        ;
        assert_eq!(out["choices"][0]["finish_reason"], Value::String("tool_calls".into()));
        let calls = out["choices"][0]["message"]["tool_calls"].as_array().cloned().unwrap_or_default();
        assert_eq!(calls[0]["function"]["arguments"], Value::String("{\"a\":1}".into()));
        assert_eq!(out["usage"]["total_tokens"], Value::Number(7.into()));
    }

    #[test]
    fn 泄漏工具调用在流式收尾时还原() {
        let mut guard = LeakGuard::default();
        let first = guard.feed("我先读文件 ");
        assert_eq!(first, "我先读文件 ");
        let second = guard.feed(&format!(
            "{LEAK_MARKER}\n[{{\"name\":\"read\",\"arguments\":\"{{}}\"}}]"
        ));
        assert_eq!(second, "");
        let (before, calls) = guard.finish(&["read".to_string()]);
        assert!(before.is_empty());
        assert_eq!(calls.len(), 1);
    }

    #[test]
    fn 普通正文不会被泄漏缓冲吞掉() {
        let mut guard = LeakGuard::default();
        assert_eq!(guard.feed("普通正文"), "普通正文");
        let (tail, calls) = guard.finish(&[]);
        assert!(tail.is_empty());
        assert!(calls.is_empty());
    }
}
