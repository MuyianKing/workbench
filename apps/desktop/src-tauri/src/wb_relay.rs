//! 一次对话请求的编排：解析 → 选号 → 续期 → 发出去 → 按客户端的口味写回来。
//!
//! 这一层**不实现协议**：请求体的归一化是纯函数（本文件的 `normalize_body`），
//! 帧的处理交给 [`crate::wb_sse`]，网络交给 [`crate::wb_api_chat`]。
//! 它只负责把这几段按顺序接起来，并在每一步失败时给出一个 OpenAI 形状的错误。
//!
//! 选号在这里是"第一个能用的" —— 真正的池调度（权重 / 临期 / 熔断）是 S4 的事，
//! 现在不装作已经有了。

use std::time::Instant;

use serde_json::Value;

use crate::wb_account::Account;
use crate::wb_api_chat::{self, ChatCall, UpstreamEvent};
use crate::wb_identity;
use crate::wb_server::{Request, Response};
use crate::wb_sse::{self, Aggregator, Decoder, Frame, Normalizer, DONE_FRAME};
use crate::wb_usage::{self, UsageRow};

/// 处理 `POST /v1/chat/completions`（以及 `/v1/completions` —— 上游只有 chat，
/// 老式 completions 也按 chat 语义走）。
///
/// `api_key` 只用来在流水里记下**调用方用的是哪把钥匙**（末四位），不参与鉴权 ——
/// 那是 `wb_router` 在进这里之前就做完的事。
pub fn chat(request: &Request, accounts: &mut [Account], api_key: &str) -> Response {
    let value: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(err) => {
            return Response::error(400, "invalid_request_error", &format!("请求体不是 JSON：{err}"))
        }
    };

    let Some(model) = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|name| !name.trim().is_empty())
    else {
        return Response::error(400, "invalid_request_error", "缺少 model 字段");
    };

    let wants_stream = value
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let prepared = normalize_body(value);
    let body = match serde_json::to_string(&prepared) {
        Ok(text) => text,
        Err(err) => {
            return Response::error(500, "internal_error", &format!("重新序列化请求失败：{err}"))
        }
    };

    let Some(account) = accounts.iter_mut().find(|item| item.is_ready()) else {
        return Response::error(
            503,
            "no_account",
            "没有可用的账号：先去网关页登录一个，或把已停用的账号启用",
        );
    };

    if account.needs_refresh() {
        if let Err(message) = crate::wb_api_auth::refresh(account) {
            return Response::error(401, "token_expired", &message);
        }
        // 续期成功后顺手落盘，下次启动不用再续一次
        let _ = account.save(&crate::paths::gateway_accounts_dir());
    }

    let ids = wb_identity::new_ids(
        account.product,
        &account.uid,
        request.header("x-conversation-id"),
        request
            .header("x-session-id")
            .or_else(|| prepared.get("conversation_id").and_then(Value::as_str)),
        None,
    );

    let handle = wb_api_chat::spawn(ChatCall {
        account: account.clone(),
        ids,
        model: Some(model.clone()),
        body,
    });

    let meta = UsageMeta {
        uid: account.uid.clone(),
        realm: account.realm.as_str().to_string(),
        model,
        ua: request
            .header("user-agent")
            .unwrap_or("未知")
            .chars()
            .take(120)
            .collect(),
        effort: effort_of(&prepared),
        stream: wants_stream,
        api_key: key_tail(api_key),
    };

    if wants_stream {
        stream_response(handle, meta)
    } else {
        aggregate_response(handle, meta)
    }
}

/// 一条请求记账时要用的固定信息。
struct UsageMeta {
    uid: String,
    realm: String,
    model: String,
    ua: String,
    /// 客户端要求的推理强度（见 `effort_of`）
    effort: String,
    stream: bool,
    /// 网关密钥末四位（见 `key_tail`）
    api_key: String,
}

/// 客户端要求的推理强度。各家客户端把这件事放在不同位置：
/// OpenAI 系的 `reasoning_effort`、有些放在 `reasoning.effort`、还有 `thinking.effort`。
/// 都没有就是空串 —— 依次试，不猜默认档（默认档是服务端的事，不是这次请求的事实）。
fn effort_of(body: &Value) -> String {
    let direct = body
        .get("reasoning_effort")
        .or_else(|| body.get("model_reasoning_effort"))
        .and_then(Value::as_str);
    let nested = body
        .get("reasoning")
        .and_then(|item| item.get("effort"))
        .or_else(|| body.get("thinking").and_then(|item| item.get("effort")))
        .and_then(Value::as_str);
    direct
        .or(nested)
        .unwrap_or("")
        .trim()
        .chars()
        .take(16)
        .collect()
}

/// 密钥只留末四位：流水文件会被人翻着看，整把钥匙不该躺在里面。
/// 长度不够四位就整把记（那要么是短密钥，要么是空的）。
fn key_tail(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    if key.chars().count() <= 4 {
        tail
    } else {
        format!("…{tail}")
    }
}

/// 从流里捡 token 数与首字时刻。
struct Capture {
    started: Instant,
    first_ms: Option<i64>,
    prompt: i64,
    completion: i64,
    total: i64,
    cached: i64,
    reasoning: i64,
    /// 上游在末帧给的这次扣费（积分）。没给就一直是 `None`
    credit: Option<f64>,
}

impl Capture {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            first_ms: None,
            prompt: 0,
            completion: 0,
            total: 0,
            cached: 0,
            reasoning: 0,
            credit: None,
        }
    }

    fn see(&mut self, chunk: &Value) {
        if self.first_ms.is_none() && has_content(chunk) {
            self.first_ms = Some(self.started.elapsed().as_millis() as i64);
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            let numbers = wb_usage::parse_usage(usage);
            // 末帧的 token 数才算准；前面偶尔带 0
            if numbers.total >= self.total {
                self.prompt = numbers.prompt;
                self.completion = numbers.completion;
                self.total = numbers.total;
                self.cached = numbers.cached;
                self.reasoning = numbers.reasoning;
            }
            if let Some(credit) = wb_usage::parse_credit(usage) {
                self.credit = Some(credit);
            }
        }
    }
}

fn has_content(chunk: &Value) -> bool {
    chunk
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(Value::as_object)
        .map(|delta| {
            delta
                .get("content")
                .and_then(Value::as_str)
                .map(|text| !text.is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn record(meta: &UsageMeta, capture: &Capture, ok: bool, error: &str) {
    let duration = capture.started.elapsed().as_millis() as i64;
    let row = UsageRow {
        ts: now_secs(),
        uid: meta.uid.clone(),
        realm: meta.realm.clone(),
        machine: crate::sync::host_name(),
        model: meta.model.clone(),
        prompt_tokens: capture.prompt,
        completion_tokens: capture.completion,
        total_tokens: capture.total,
        cached_tokens: capture.cached,
        ttft_ms: capture.first_ms.unwrap_or(duration),
        duration_ms: duration,
        ok,
        error: error.to_string(),
        ua: meta.ua.clone(),
        effort: meta.effort.clone(),
        stream: Some(meta.stream),
        reasoning_tokens: capture.reasoning,
        credit: capture.credit,
        api_key: meta.api_key.clone(),
        // 估算花费在记账时折一次并落盘：价表以后会改，这一行记的是当时那笔账
        cost_cny: wb_usage::cost_for(&meta.model, capture.prompt, capture.completion)
            .map(wb_usage::round2),
    };
    // 记账失败不打断用户：账本的问题不该让对话报错
    let _ = wb_usage::append(&row);
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// 流式：先判状态码，再决定回 200 的流还是一段错误。
fn stream_response(mut handle: wb_api_chat::StreamHandle, meta: UsageMeta) -> Response {
    match handle.head() {
        Ok(200) => Response::sse(move |writer| {
            let mut decoder = Decoder::new();
            let mut normalizer = Normalizer::new();
            let mut capture = Capture::new();
            let mut emitted = false;

            while let Some(event) = handle.next() {
                let UpstreamEvent::Chunk(bytes) = event else {
                    continue;
                };
                for payload in decoder.push(&bytes) {
                    if !emit(&payload, writer, &mut normalizer, &mut capture, &mut emitted)? {
                        record(&meta, &capture, true, "");
                        return Ok(());
                    }
                }
            }
            for payload in decoder.finish() {
                if !emit(&payload, writer, &mut normalizer, &mut capture, &mut emitted)? {
                    record(&meta, &capture, true, "");
                    return Ok(());
                }
            }

            // 一帧有效内容都没有：按上游空流报错，别让客户端干等
            if !emitted {
                writer.write_text(&wb_sse::frame_text(&serde_json::json!({
                    "error": {
                        "message": "上游返回了空流",
                        "type": "upstream_error",
                        "code": "empty_stream"
                    }
                })))?;
            }
            writer.write_text(DONE_FRAME)?;
            record(&meta, &capture, true, "");
            Ok(())
        }),
        Ok(status) => {
            // 非 200：正文就是上游的错误说明，收下来原样翻给调用方
            let text = drain_text(&mut handle);
            record(&meta, &Capture::new(), false, &format!("HTTP {status}"));
            Response::error(
                status,
                "upstream_error",
                &if text.trim().is_empty() {
                    format!("上游返回 HTTP {status}")
                } else {
                    text
                },
            )
        }
        Err(message) => {
            record(&meta, &Capture::new(), false, &message);
            Response::error(502, "upstream_error", &message)
        }
    }
}

/// 处理一帧。返回 false 表示这一轮该收尾了。
fn emit(
    payload: &str,
    writer: &mut crate::wb_server::ChunkedWriter<'_>,
    normalizer: &mut Normalizer,
    capture: &mut Capture,
    emitted: &mut bool,
) -> Result<bool, String> {
    match wb_sse::parse_frame(payload) {
        Frame::Done => {
            writer.write_text(DONE_FRAME)?;
            // 上游自己给了结束标记：到此为止，外层不要再补一个
            *emitted = true;
            Ok(false)
        }
        Frame::Error { code, message } => {
            writer.write_text(&wb_sse::frame_text(&serde_json::json!({
                "error": { "message": message, "type": "upstream_error", "code": code }
            })))?;
            writer.write_text(DONE_FRAME)?;
            *emitted = true;
            Ok(false)
        }
        Frame::Ignore => Ok(true),
        Frame::Json(chunk) => {
            capture.see(&chunk);
            if let Some(clean) = normalizer.normalize(&chunk) {
                writer.write_text(&wb_sse::frame_text(&clean))?;
                *emitted = true;
            }
            Ok(true)
        }
    }
}

/// 非流式：把整条流聚合成一个 `chat.completion`。
fn aggregate_response(mut handle: wb_api_chat::StreamHandle, meta: UsageMeta) -> Response {
    match handle.head() {
        Ok(200) => {
            let mut decoder = Decoder::new();
            let mut aggregator = Aggregator::new();
            let mut capture = Capture::new();
            let mut saw_done = false;

            while let Some(event) = handle.next() {
                let UpstreamEvent::Chunk(bytes) = event else {
                    continue;
                };
                for payload in decoder.push(&bytes) {
                    match wb_sse::parse_frame(&payload) {
                        Frame::Done => {
                            saw_done = true;
                            break;
                        }
                        Frame::Error { code, message } => {
                            return Response::error(
                                502,
                                "upstream_error",
                                &match code {
                                    Some(code) => format!("{message}（code {code}）"),
                                    None => message,
                                },
                            )
                        }
                        Frame::Ignore => {}
                        Frame::Json(chunk) => {
                            capture.see(&chunk);
                            aggregator.push(&chunk);
                        }
                    }
                }
                if saw_done {
                    break;
                }
            }

            // 没等到 [DONE] 就是被截断了：聚合时丢掉半截工具调用
            record(&meta, &capture, true, "");
            Response::json(&aggregator.finish(!saw_done))
        }
        Ok(status) => {
            let text = drain_text(&mut handle);
            Response::error(
                status,
                "upstream_error",
                &if text.trim().is_empty() {
                    format!("上游返回 HTTP {status}")
                } else {
                    text
                },
            )
        }
        Err(message) => Response::error(502, "upstream_error", &message),
    }
}

fn drain_text(handle: &mut wb_api_chat::StreamHandle) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(event) = handle.next() {
        if let UpstreamEvent::Chunk(piece) = event {
            bytes.extend_from_slice(&piece);
            if bytes.len() > 64 << 10 {
                break;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// 请求体归一化。**只做上游要求的那几件事**，不偷偷改写用户的消息：
/// 1. 强制 `stream: true` —— 上游拒绝非流式（这是硬要求，不是优化）；
/// 2. 缺 `stream_options.include_usage` 就补上，否则拿不到 token 数；
/// 3. `developer` 角色改 `system` —— 上游只认 system。
///
/// 工具配对、思考档位、指纹清洗那些不在这里：它们各自有归属（S3）。
pub fn normalize_body(mut value: Value) -> Value {
    let Some(object) = value.as_object_mut() else {
        return value;
    };

    object.insert("stream".to_string(), Value::Bool(true));

    let needs_usage = object
        .get("stream_options")
        .and_then(Value::as_object)
        .map(|options| !options.contains_key("include_usage"))
        .unwrap_or(true);
    if needs_usage {
        let mut options = object
            .get("stream_options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        options.insert("include_usage".to_string(), Value::Bool(true));
        object.insert("stream_options".to_string(), Value::Object(options));
    }

    if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            let Some(entry) = message.as_object_mut() else {
                continue;
            };
            let is_developer = entry
                .get("role")
                .and_then(Value::as_str)
                .map(|role| role == "developer")
                .unwrap_or(false);
            if is_developer {
                entry.insert("role".to_string(), Value::String("system".to_string()));
            }
        }
    }

    // 上游的渠道校验会拦 Claude Code / Codex 的 system 模板句；reasoning 片段与
    // DeepSeek 的 reasoning_content 也在这里归一。见 wb_sanitize 的文件头。
    crate::wb_sanitize::sanitize_body(&mut value);

    value
}

/// `GET /v1/models`。优先给缓存里的真实目录（用户点「重新获取」时拉的，见 `wb_models`）；
/// 一次都没拉过才回落种子清单 —— 首启时别让客户端拿到空数组。
pub fn models() -> Response {
    let cached = crate::wb_models::cached();
    let ids: Vec<String> = if cached.is_empty() {
        SEED_MODELS.iter().map(|id| (*id).to_string()).collect()
    } else {
        cached.into_iter().map(|item| item.id).collect()
    };
    let list: Vec<Value> = ids
        .iter()
        .map(|id| {
            serde_json::json!({
                "id": id,
                "object": "model",
                "owned_by": "workbuddy",
            })
        })
        .collect();
    Response::json(&serde_json::json!({
        "object": "list",
        "data": list,
    }))
}

/// 首启兜底清单：**只在一次都没拉过上游目录时**给 `/v1/models` 用（免得客户端拿到空数组）。
/// 真实目录由 `wb_models` 拉并缓存，界面只读那一份。
const SEED_MODELS: [&str; 4] = ["hy3", "hy4-preview-f", "glm-5.2", "deepseek-v4.1-flash"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wb_server::Body;

    fn body(value: Value) -> Value {
        normalize_body(value)
    }

    /// 三家客户端的写法都认；都没有就是空串（不替服务端猜一个默认档）
    #[test]
    fn 推理强度从哪个字段来都认() {
        assert_eq!(effort_of(&serde_json::json!({ "reasoning_effort": "max" })), "max");
        assert_eq!(
            effort_of(&serde_json::json!({ "reasoning": { "effort": "high" } })),
            "high"
        );
        assert_eq!(
            effort_of(&serde_json::json!({ "thinking": { "effort": "low" } })),
            "low"
        );
        assert_eq!(effort_of(&serde_json::json!({})), "");
    }

    /// 流水会被人翻着看，整把密钥不该躺在里面
    #[test]
    fn 密钥只记末四位() {
        assert_eq!(key_tail("wbg-0123456789abcdef"), "…cdef");
        assert_eq!(key_tail(""), "");
        assert_eq!(key_tail("ab"), "ab");
    }

    #[test]
    fn 强制_stream_并补上用量选项() {
        let out = body(serde_json::json!({
            "model": "glm-5.2",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": false
        }));
        assert_eq!(out["stream"], true);
        assert_eq!(out["stream_options"]["include_usage"], true);
    }

    #[test]
    fn 已有的_stream_options_被保留() {
        let out = body(serde_json::json!({
            "stream": true,
            "stream_options": {"include_usage": false, "other": 1}
        }));
        // 客户端明说了 false 就不改它 —— 那是它的选择
        assert_eq!(out["stream_options"]["include_usage"], false);
        assert_eq!(out["stream_options"]["other"], 1);
    }

    #[test]
    fn developer_角色改成_system() {
        let out = body(serde_json::json!({
            "messages": [
                {"role": "developer", "content": "规则"},
                {"role": "user", "content": "hi"}
            ]
        }));
        assert_eq!(out["messages"][0]["role"], "system");
        assert_eq!(out["messages"][1]["role"], "user");
    }

    #[test]
    fn 出站前清洗_system_里的渠道指纹() {
        let out = body(serde_json::json!({
            "model": "glm-5.2",
            "messages": [{
                "role": "system",
                "content": "Main branch (you will usually use this for PRs): main"
            }]
        }));
        assert_eq!(
            out["messages"][0]["content"],
            "Default branch (you will usually use this for PRs): main"
        );
    }

    #[test]
    fn 非对象请求体原样返回() {
        let out = body(serde_json::json!("字符串"));
        assert_eq!(out, serde_json::json!("字符串"));
    }

    #[test]
    fn 缺_model_时给_400() {
        let request = Request {
            method: "POST".into(),
            path: "/v1/chat/completions".into(),
            query: String::new(),
            headers: Vec::new(),
            body: br#"{"messages":[]}"#.to_vec(),
        };
        let response = chat(&request, &mut [], "");
        assert_eq!(response.status, 400);
    }

    #[test]
    fn 没有可用账号时给_503() {
        let request = Request {
            method: "POST".into(),
            path: "/v1/chat/completions".into(),
            query: String::new(),
            headers: Vec::new(),
            body: br#"{"model":"glm-5.2","messages":[]}"#.to_vec(),
        };
        let response = chat(&request, &mut [], "");
        assert_eq!(response.status, 503);
    }

    #[test]
    fn 模型清单是_openai_形状() {
        let response = models();
        assert_eq!(response.status, 200);
        let Body::Bytes(bytes) = &response.body else {
            panic!("模型清单不该是流");
        };
        let value: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(value["object"], "list");
        assert!(value["data"].as_array().unwrap().len() >= 4);
        assert_eq!(value["data"][0]["object"], "model");
    }
}
