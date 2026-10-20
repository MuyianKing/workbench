//! SSE 这层线：把上游的帧解开、按白名单重建、按需聚合。
//!
//! 上游本来就说 OpenAI `chat.completion.chunk`，所以这里**不做协议翻译** ——
//! 只做三件事：
//! 1. 从字节流里切出完整的 `data:` 负载（事件可能跨 chunk 到达）；
//! 2. 按白名单重建每一帧，把上游顺手塞的杂物丢掉（空 delta、空工具调用、
//!    未知顶层键），`finish_reason: ""` 归一成 `null`；
//! 3. 客户端要非流式时，把整条流聚合成一个 `chat.completion`。
//!
//! **纯逻辑**：不碰 socket。字节流怎么来、帧怎么写回去，都由调用方管。
//!
//! 一条容易踩的线：上游会「HTTP 200 + 流内 error 帧」地失败（真实行为，不是异常）。
//! 所以 [`Frame::Error`] 是一等公民，调用方必须处理它，不能只看状态码。

use serde_json::{json, Map, Value};

/// 一行 `data:` 负载的解析结果。
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// 一帧 JSON
    Json(Value),
    /// `[DONE]`
    Done,
    /// 上游在流里报的错（HTTP 仍是 200）。`code` 是上游错误码，`message` 给人看。
    Error { code: Option<i64>, message: String },
    /// 心跳、注释、空行 —— 丢掉
    Ignore,
}

/// 增量式的 SSE 切帧器：`push` 喂字节，回来的是这一批里**已经完整**的负载文本。
///
/// 为什么要自己缓冲：一次 `read` 可能只到半行，也可能一次到十几帧。按 `\n` 切、
/// 把不完整的尾巴留到下次，是唯一稳的做法。
#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一段字节，取出所有已完整的 `data:` 负载（已去掉前缀与首尾空白）。
    ///
    /// 只认 `data:` 前缀 —— 上游不发 `event:`，发了也不用（帧类型写在 JSON 里）。
    /// `:` 开头的注释行与空行直接跳过。
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();

        // 逐行消费；最后一段没有换行就留在 pending 里
        let mut consumed = 0usize;
        while let Some(offset) = self.pending[consumed..].iter().position(|byte| *byte == b'\n') {
            let end = consumed + offset;
            let line = &self.pending[consumed..end];
            consumed = end + 1;
            if let Some(payload) = payload_of(line) {
                out.push(payload);
            }
        }
        if consumed > 0 {
            self.pending.drain(..consumed);
        }

        // 防呆：对端一直不换行时别把内存吃光（正常帧最长的也就几十 KB）
        if self.pending.len() > 4 << 20 {
            self.pending.clear();
        }
        out
    }

    /// 流结束时把残留的不完整行也解析一次（少数实现末尾不带换行）。
    pub fn finish(&mut self) -> Vec<String> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let tail = std::mem::take(&mut self.pending);
        payload_of(&tail).into_iter().collect()
    }
}

/// 一行原始字节 → `data:` 负载。不是数据行就返回 None。
fn payload_of(line: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    let rest = trimmed.strip_prefix("data:")?.trim();
    // `data: : heartbeat` 这种也当注释
    if rest.is_empty() || rest.starts_with(':') {
        return None;
    }
    Some(rest.to_string())
}

/// 一条负载文本 → [`Frame`]。
pub fn parse_frame(payload: &str) -> Frame {
    let text = payload.trim();
    if text == "[DONE]" {
        return Frame::Done;
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Frame::Ignore;
    };
    if let Some(error) = value.get("error") {
        return Frame::Error {
            code: error.get("code").and_then(Value::as_i64),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("上游返回了一个错误")
                .to_string(),
        };
    }
    Frame::Json(value)
}

// ---------- 白名单重建 ----------

/// 帧重建器。持有「第一条真实 id」，保证整条流的帧 id 一致 ——
/// 上游偶尔漏发 id，客户端会因此把一整个回答当成两条。
#[derive(Default)]
pub struct Normalizer {
    id: Option<String>,
}

impl Normalizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 重建一帧。`None` 表示这一帧没有任何有用内容（整帧丢掉）。
    pub fn normalize(&mut self, chunk: &Value) -> Option<Value> {
        if self.id.is_none() {
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                if !id.trim().is_empty() {
                    self.id = Some(id.to_string());
                }
            }
        }

        let mut out = Map::new();
        // 顶层白名单：只留这几样，其余（上游的私有字段）一律不进客户端
        for key in [
            "id",
            "object",
            "created",
            "model",
            "system_fingerprint",
            "service_tier",
        ] {
            if let Some(value) = chunk.get(key) {
                if !value.is_null() {
                    out.insert(key.to_string(), value.clone());
                }
            }
        }
        out.entry("object")
            .or_insert_with(|| json!("chat.completion.chunk"));
        out.entry("id").or_insert_with(|| {
            json!(self
                .id
                .clone()
                .unwrap_or_else(|| "chatcmpl-gateway".to_string()))
        });

        let mut choices: Vec<Value> = Vec::new();
        for choice in chunk
            .get("choices")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if let Some(cleaned) = clean_choice(choice) {
                choices.push(cleaned);
            }
        }
        out.insert("choices".to_string(), Value::Array(choices));

        // usage 有就带（上游在末帧给），没有就不写 —— 写 null 会让部分客户端报错
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            out.insert("usage".to_string(), usage.clone());
        }

        // 一帧既没内容也没结束原因，就是噪音
        let has_choices = out
            .get("choices")
            .and_then(Value::as_array)
            .map(|list| !list.is_empty())
            .unwrap_or(false);
        if !has_choices && !out.contains_key("usage") {
            return None;
        }
        Some(Value::Object(out))
    }
}

/// 单个 choice 的清洗。
fn clean_choice(choice: &Value) -> Option<Value> {
    let mut out = Map::new();
    out.insert(
        "index".to_string(),
        choice.get("index").cloned().unwrap_or_else(|| json!(0)),
    );

    if let Some(delta) = choice.get("delta").and_then(Value::as_object) {
        let cleaned = clean_delta(delta);
        if !cleaned.is_empty() {
            out.insert("delta".to_string(), Value::Object(cleaned));
        }
    }
    // 少数实现发整条 message 而不是 delta，原样带上
    if let Some(message) = choice.get("message").filter(|value| value.is_object()) {
        out.insert("message".to_string(), message.clone());
    }

    let finish = choice.get("finish_reason");
    let finish = match finish {
        // 上游把「还没结束」写成空串，客户端认 null
        Some(Value::String(text)) if text.is_empty() => Value::Null,
        Some(value) => value.clone(),
        None => Value::Null,
    };
    out.insert("finish_reason".to_string(), finish);

    // delta 空且没有结束原因：这一条 choice 是噪音
    if !out.contains_key("delta") && !out.contains_key("message") && out["finish_reason"].is_null() {
        return None;
    }
    Some(Value::Object(out))
}

/// delta 内只留这几样；空值一律不写（全量客户端里，`content: ""` 会让
/// 「有没有内容」的判断变复杂）。
fn clean_delta(delta: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["role", "content", "reasoning_content", "refusal"] {
        match delta.get(key) {
            Some(Value::String(text)) if text.is_empty() => {}
            Some(Value::Null) | None => {}
            Some(value) => {
                out.insert(key.to_string(), value.clone());
            }
        }
    }
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        if !calls.is_empty() {
            out.insert("tool_calls".to_string(), Value::Array(calls.clone()));
        }
    }
    // 老式 function_call：没有 name 的占位帧丢掉
    if let Some(call) = delta.get("function_call").and_then(Value::as_object) {
        let named = call
            .get("name")
            .and_then(Value::as_str)
            .map(|name| !name.is_empty())
            .unwrap_or(false);
        if named {
            out.insert("function_call".to_string(), Value::Object(call.clone()));
        }
    }
    out
}

// ---------- 聚合（非流式） ----------

/// 把一条流聚合成一个 `chat.completion`。
#[derive(Default)]
pub struct Aggregator {
    id: Option<String>,
    model: Option<String>,
    created: Option<i64>,
    content: String,
    reasoning: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ToolCall {
    index: u32,
    id: Option<String>,
    kind: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl Aggregator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &Value) {
        if self.id.is_none() {
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                self.id = Some(id.to_string());
            }
        }
        if self.model.is_none() {
            if let Some(model) = chunk.get("model").and_then(Value::as_str) {
                self.model = Some(model.to_string());
            }
        }
        if self.created.is_none() {
            self.created = chunk.get("created").and_then(Value::as_i64);
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            // 末帧的 usage 才算；前面偶尔带的是 0
            let total = usage
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let previous = self
                .usage
                .as_ref()
                .and_then(|value| value.get("total_tokens"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if total >= previous {
                self.usage = Some(usage.clone());
            }
        }

        let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
            return;
        };
        // 只取第 0 条：上游 n>1 时网关也不多做，这与原项目口径一致
        let Some(choice) = choices.first() else {
            return;
        };
        if let Some(delta) = choice.get("delta") {
            self.absorb_delta(delta);
        }
        if let Some(message) = choice.get("message") {
            self.absorb_delta(message);
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if !reason.is_empty() {
                self.finish_reason = Some(reason.to_string());
            }
        }
    }

    fn absorb_delta(&mut self, delta: &Value) {
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.content.push_str(text);
        }
        if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
            self.reasoning.push_str(text);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                self.absorb_tool_call(call);
            }
        }
        // 兼容老式 function_call：当成 index 0 的工具调用
        if let Some(call) = delta.get("function_call") {
            let wrapped = json!({ "index": 0, "function": call });
            self.absorb_tool_call(&wrapped);
        }
    }

    fn absorb_tool_call(&mut self, call: &Value) {
        let index = call
            .get("index")
            .and_then(Value::as_f64)
            .map(|value| value as u32)
            .unwrap_or_else(|| self.tool_calls.len() as u32);

        let slot = match self.tool_calls.iter_mut().find(|item| item.index == index) {
            Some(existing) => existing,
            None => {
                self.tool_calls.push(ToolCall {
                    index,
                    ..ToolCall::default()
                });
                self.tool_calls
                    .last_mut()
                    .expect("刚 push 过，必然有值")
            }
        };

        if let Some(id) = call.get("id").and_then(Value::as_str).filter(|v| !v.is_empty()) {
            slot.id = Some(id.to_string());
        }
        if let Some(kind) = call.get("type").and_then(Value::as_str).filter(|v| !v.is_empty()) {
            slot.kind = Some(kind.to_string());
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
            {
                slot.name = Some(name.to_string());
            }
            if let Some(args) = function.get("arguments").and_then(Value::as_str) {
                slot.arguments.push_str(args);
            }
        }
    }

    /// 收尾。参数被截断时（`length` / 没等到 `[DONE]`）丢掉工具调用 ——
    /// 半截 JSON 交给客户端只会让它崩在参数解析上。
    pub fn finish(mut self, truncated: bool) -> Value {
        let mut message = Map::new();
        message.insert("role".to_string(), json!("assistant"));
        message.insert("content".to_string(), json!(self.content));
        if !self.reasoning.is_empty() {
            message.insert("reasoning_content".to_string(), json!(self.reasoning));
        }

        let finish_reason = self.finish_reason.unwrap_or_else(|| "stop".to_string());
        if !self.tool_calls.is_empty() && !truncated && finish_reason != "length" {
            self.tool_calls.sort_by_key(|call| call.index);
            let calls: Vec<Value> = self
                .tool_calls
                .into_iter()
                .map(|call| {
                    json!({
                        "id": call.id.unwrap_or_default(),
                        "type": call.kind.unwrap_or_else(|| "function".to_string()),
                        "function": {
                            "name": call.name.unwrap_or_default(),
                            "arguments": call.arguments,
                        }
                    })
                })
                .collect();
            message.insert("tool_calls".to_string(), Value::Array(calls));
        }

        let mut out = Map::new();
        out.insert(
            "id".to_string(),
            json!(self.id.unwrap_or_else(|| "chatcmpl-gateway".to_string())),
        );
        out.insert("object".to_string(), json!("chat.completion"));
        out.insert(
            "created".to_string(),
            json!(self.created.unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_secs() as i64)
                    .unwrap_or(0)
            })),
        );
        out.insert(
            "model".to_string(),
            json!(self.model.unwrap_or_else(|| "unknown".to_string())),
        );
        out.insert(
            "choices".to_string(),
            json!([{
                "index": 0,
                "message": Value::Object(message),
                "finish_reason": finish_reason,
            }]),
        );
        if let Some(usage) = self.usage {
            out.insert("usage".to_string(), usage);
        }
        Value::Object(out)
    }
}

// ---------- 写出 ----------

/// 一帧写成 SSE 文本（含结尾空行）。
pub fn frame_text(value: &Value) -> String {
    format!("data: {value}\n\n")
}

/// 结束标记。
pub const DONE_FRAME: &str = "data: [DONE]\n\n";

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(text: &str) -> Vec<Frame> {
        let mut decoder = Decoder::new();
        let payloads = decoder.push(text.as_bytes());
        payloads.iter().map(|item| parse_frame(item)).collect()
    }

    #[test]
    fn 切帧能跨_chunk_拼接() {
        let mut decoder = Decoder::new();
        assert!(decoder.push(b"data: {\"a\":1}").is_empty());
        let got = decoder.push(b"\n\ndata: [DONE]\n\n");
        assert_eq!(got, vec!["{\"a\":1}".to_string(), "[DONE]".to_string()]);
    }

    #[test]
    fn 一次收到多帧也能全切出来() {
        let frames = decode_all(
            "data: {\"id\":\"a\"}\n\ndata: {\"id\":\"b\"}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(frames.len(), 3);
        assert!(matches!(frames[2], Frame::Done));
    }

    #[test]
    fn 心跳与注释行被丢掉() {
        let frames = decode_all(": heartbeat\n\ndata: : ping\n\ndata: {\"id\":\"x\"}\n\n");
        assert_eq!(frames.len(), 1);
        assert!(matches!(frames[0], Frame::Json(_)));
    }

    #[test]
    fn 流里的_error_帧被识别成失败() {
        let frames = decode_all(
            "data: {\"error\":{\"code\":6004,\"message\":\"模型限流\"}}\n\ndata: [DONE]\n\n",
        );
        match &frames[0] {
            Frame::Error { code, message } => {
                assert_eq!(*code, Some(6004));
                assert_eq!(message, "模型限流");
            }
            other => panic!("应该是 Error，实际 {other:?}"),
        }
    }

    #[test]
    fn 空_delta_整帧被丢弃() {
        let mut normalizer = Normalizer::new();
        let chunk = json!({
            "id": "chatcmpl-1",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": ""}]
        });
        assert!(normalizer.normalize(&chunk).is_none());
    }

    #[test]
    fn finish_reason_空串归一成_null() {
        let mut normalizer = Normalizer::new();
        let chunk = json!({
            "id": "chatcmpl-1",
            "choices": [{"index": 0, "delta": {"content": "hi"}, "finish_reason": ""}]
        });
        let out = normalizer.normalize(&chunk).unwrap();
        assert!(out["choices"][0]["finish_reason"].is_null());
        assert_eq!(out["choices"][0]["delta"]["content"], "hi");
    }

    #[test]
    fn 未知顶层键被剥掉() {
        let mut normalizer = Normalizer::new();
        let chunk = json!({
            "id": "chatcmpl-1",
            "object": "chat.completion.chunk",
            "created": 1753600000,
            "model": "glm-5.2",
            "vendor_private": {"secret": true},
            "choices": [{"index": 0, "delta": {"content": "x"}}]
        });
        let out = normalizer.normalize(&chunk).unwrap();
        assert!(out.get("vendor_private").is_none());
        assert_eq!(out["object"], "chat.completion.chunk");
        assert_eq!(out["model"], "glm-5.2");
        assert_eq!(out["created"], 1753600000);
    }

    #[test]
    fn 缺_id_时沿用第一条的_id() {
        let mut normalizer = Normalizer::new();
        let first = json!({"id": "chatcmpl-real", "choices": [{"index": 0, "delta": {"content": "a"}}]});
        normalizer.normalize(&first);
        let second = json!({"choices": [{"index": 0, "delta": {"content": "b"}}]});
        let out = normalizer.normalize(&second).unwrap();
        assert_eq!(out["id"], "chatcmpl-real");
    }

    #[test]
    fn 聚合出完整的_非流式响应() {
        let mut aggregator = Aggregator::new();
        let frames = [
            json!({"id":"c1","model":"glm-5.2","created":100,"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}),
            json!({"id":"c1","choices":[{"index":0,"delta":{"content":"，世界"}}]}),
            json!({"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}),
        ];
        for frame in &frames {
            aggregator.push(frame);
        }
        let out = aggregator.finish(false);
        assert_eq!(out["object"], "chat.completion");
        assert_eq!(out["id"], "c1");
        assert_eq!(out["model"], "glm-5.2");
        assert_eq!(out["choices"][0]["message"]["content"], "你好，世界");
        assert_eq!(out["choices"][0]["finish_reason"], "stop");
        assert_eq!(out["usage"]["total_tokens"], 7);
    }

    #[test]
    fn 聚合时思考通道单独攒() {
        let mut aggregator = Aggregator::new();
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"reasoning_content":"想"}}]}));
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"content":"答"}}]}));
        let out = aggregator.finish(false);
        assert_eq!(out["choices"][0]["message"]["content"], "答");
        assert_eq!(out["choices"][0]["message"]["reasoning_content"], "想");
    }

    #[test]
    fn 工具调用按_index_合并参数分片() {
        let mut aggregator = Aggregator::new();
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}
        ]}}]}));
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"{\"path\""}}
        ]}}]}));
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":":\"a.md\"}"}}
        ]}}]}));
        aggregator.push(&json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}));
        let out = aggregator.finish(false);
        let calls = out["choices"][0]["message"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["function"]["name"], "read");
        assert_eq!(calls[0]["function"]["arguments"], "{\"path\":\"a.md\"}");
        assert_eq!(out["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn 被截断时丢掉半截工具调用() {
        let mut aggregator = Aggregator::new();
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"c","function":{"name":"read","arguments":"{\"path\""}}
        ]}}]}));
        aggregator.push(&json!({"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}));
        let out = aggregator.finish(false);
        assert!(out["choices"][0]["message"].get("tool_calls").is_none());
        assert_eq!(out["choices"][0]["finish_reason"], "length");
    }

    #[test]
    fn 没等到_done_也按截断处理() {
        let mut aggregator = Aggregator::new();
        aggregator.push(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"c","function":{"name":"x","arguments":"{"}}
        ]}}]}));
        let out = aggregator.finish(true);
        assert!(out["choices"][0]["message"].get("tool_calls").is_none());
    }

    #[test]
    fn 写出格式带_data_前缀与空行() {
        let text = frame_text(&json!({"id":"x"}));
        assert!(text.starts_with("data: "));
        assert!(text.ends_with("\n\n"));
        assert_eq!(DONE_FRAME, "data: [DONE]\n\n");
    }

    #[test]
    fn 非法_json_被当成噪音() {
        assert_eq!(parse_frame("not json"), Frame::Ignore);
    }
}
