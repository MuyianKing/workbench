//! 一次 Qoder 对话请求的编排：解析 → 选号 → 续期 → 构造请求体 → 上游 → 写回。
//!
//! 与 `wb_relay` 同一套职责划分：协议细节在 `qd_body` / `qd_sse` / `qd_api_chat`，
//! 这里只把几段按顺序接起来，并在每一步失败时给出 OpenAI 形状的错误。
//!
//! 容错口径（来自 `qoder2api-hub` 的实测）：
//! - 排队（403 + 10605 / isQueued）**不是账号问题**：按 `retryAfterSeconds` 等，
//!   最多 [`QUEUE_MAX_ROUNDS`] 轮 / [`QUEUE_WAIT_BUDGET_SECS`] 秒，不冷却账号；
//! - 额度（402 / 112 / 110）给账号或模型打标记后换号；
//! - 会话被吊销（TOKEN_EXPIRE / 12153）标记需要重新登录；
//! - 首字超时直接换号，同账号重试几乎必然再超时；
//! - 其余瞬时故障同账号退避重试 [`TRANSIENT_MAX_RETRIES`] 次。

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::time::Instant;

use serde_json::{json, Value};

use crate::common::key_tail;
use crate::qd_account::Account;
use crate::qd_api_chat::{self, ChatCall, StreamHandle, UpstreamEvent};
use crate::qd_body::{self, Conversation};
use crate::qd_models;
use crate::qd_quota;
use crate::qd_sse::{Aggregator, Decoder, Envelope, LeakGuard};
use crate::qd_usage;
use crate::wb_server::{Request, Response};
use crate::wb_usage::{self, UsageRow};

/// 一次请求在账本里要记的东西。
struct Meta {
    ts: i64,
    uid: String,
    model: String,
    ua: String,
    effort: String,
    stream: bool,
    api_key_tail: String,
}

/// `GET /v1/models`。
pub fn models() -> Response {
    let list: Vec<Value> = qd_models::merged()
        .into_iter()
        .filter(|model| model.enabled)
        .map(|model| {
            json!({
                "id": model.id,
                "object": "model",
                "created": 0,
                "owned_by": "qoder",
                "name": model.display_name,
                "context_length": model.context_length,
                "max_input_tokens": model.context_length,
                "reasoning": model.reasoning,
                "vision": model.vision,
                "tool_calls": model.tool_calls,
                "reasoning_efforts": model.efforts,
                "reasoning_default_effort": model.default_effort,
            })
        })
        .collect();
    Response::json(&json!({ "object": "list", "data": list }))
}

/// `POST /v1/chat/completions`（以及 `/v1/completions`，按 chat 语义走）。
pub fn chat(
    request: &Request,
    accounts: &mut [Account],
    api_key: &str,
    conversations: &mut HashMap<String, Conversation>,
) -> Response {
    let value: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(err) => {
            return Response::error(400, "invalid_request_error", &format!("请求体不是 JSON：{err}"))
        }
    };
    let Some(model_name) = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|name| !name.trim().is_empty())
    else {
        return Response::error(400, "invalid_request_error", "缺少 model 字段");
    };
    let wants_stream = value.get("stream").and_then(Value::as_bool).unwrap_or(false);

    let Some((_key, model)) = qd_models::resolve(&model_name) else {
        return Response::error(
            400,
            "invalid_request_error",
            &format!("未知模型「{model_name}」：请先在 Qoder 页刷新模型目录，再填 /v1/models 里的 id"),
        );
    };
    if !model.enabled {
        return Response::error(
            400,
            "invalid_request_error",
            &format!("模型「{model_name}」当前未开放：{}", model.disabled_reason),
        );
    }

    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let affinity = qd_body::affinity_key(&messages);
    // 会话身份要在**第一次**请求前就建好，否则首轮的 chat_record_id 与后续几轮不同，
    // 上游用量面板会把同一次对话拆成两条
    let conversation_ref = conversation_for(conversations, &affinity, &messages);

    let now = crate::common::now_secs();
    let order = qd_pool_order(accounts, &model.id, now, &affinity, conversations);
    if order.is_empty() {
        return unavailable(accounts, &model.id, now);
    }

    let ua: String = request
        .header("user-agent")
        .unwrap_or("未知")
        .chars()
        .take(120)
        .collect();
    let api_key_tail = key_tail(api_key);
    let mut last_error: Option<(u16, String, &'static str)> = None;
    let mut saw_throttle = false;
    let mut tried: HashSet<String> = HashSet::new();

    for index in order {
        let account = &mut accounts[index];
        tried.insert(account.uid.clone());

        if account.needs_refresh() {
            if let Err(message) = crate::qd_auth::refresh(account) {
                account.last_error = message.clone();
                let _ = account.save(&crate::paths::qoder_accounts_dir());
                last_error = Some((401, message, "auth_error"));
                continue;
            }
            let _ = account.save(&crate::paths::qoder_accounts_dir());
        }

        let (body, prepared) = match qd_body::build(qd_body::BuildInput {
            payload: &value,
            account,
            model: &model,
            conversation: conversation_ref.as_ref(),
        }) {
            Ok(built) => built,
            Err(message) => return Response::error(400, "invalid_request_error", &message),
        };
        let encoded = match qd_body::encode(&body) {
            Ok(encoded) => encoded,
            Err(message) => return Response::error(500, "internal_error", &message),
        };
        let meta = Meta {
            ts: now,
            uid: account.uid.clone(),
            model: model.id.clone(),
            ua: ua.clone(),
            effort: prepared.effort_requested.clone(),
            stream: wants_stream,
            api_key_tail: api_key_tail.clone(),
        };
        let schemas = qd_body::tool_schemas(&value);

        // 同一账号内的排队 / 瞬时故障重试
        let mut transient = 0u8;
        let mut queue_rounds = 0u8;
        let queue_start = Instant::now();
        loop {
            let mut handle = qd_api_chat::spawn(ChatCall {
                account: account.clone(),
                model_key: prepared.model_key.clone(),
                body: encoded.clone(),
            });
            let status = match handle.head() {
                Ok(status) => status,
                Err(message) => {
                    // 传输层失败：同账号退避重试，仍失败换号
                    if transient < qd_quota::TRANSIENT_MAX_RETRIES {
                        transient += 1;
                        std::thread::sleep(std::time::Duration::from_secs(transient as u64));
                        continue;
                    }
                    record_failure(&meta, &message, 0);
                    last_error = Some((502, message, "upstream_error"));
                    break;
                }
            };

            if status == 200 {
                return if wants_stream {
                    stream_response(handle, meta, schemas.clone())
                } else {
                    aggregate_response(handle, meta, schemas.clone())
                };
            }

            let text = qd_api_chat::drain_text(&mut handle);

            // 排队：等，不冷却账号
            let wait = qd_quota::queue_wait(&text);
            if wait > 0
                && queue_rounds < qd_quota::QUEUE_MAX_ROUNDS
                && wait <= qd_quota::QUEUE_WAIT_MAX_SECS
                && queue_start.elapsed().as_secs() as i64 + wait
                    <= qd_quota::QUEUE_WAIT_BUDGET_SECS
            {
                queue_rounds += 1;
                std::thread::sleep(std::time::Duration::from_secs(wait as u64 + 1));
                continue;
            }

            if qd_quota::session_dead(&text) {
                account.token_expired = true;
                account.enabled = false;
                account.last_error = "会话已失效，需要重新登录".into();
                let _ = account.save(&crate::paths::qoder_accounts_dir());
                record_failure(&meta, &account.last_error, status);
                last_error = Some((401, account.last_error.clone(), "session_dead"));
                break;
            }

            if let Some((kind, resets_at)) = qd_quota::quota_kind(status, &text, now) {
                match kind {
                    qd_quota::QuotaKind::Exhausted if status == 429 => {
                        // 429 是模型粒度：只挡这个模型
                        account.mark_model_exhausted(&model.id, now, resets_at);
                        saw_throttle = true;
                    }
                    qd_quota::QuotaKind::Exhausted => {
                        account.mark_quota_exhausted(now, resets_at);
                    }
                    qd_quota::QuotaKind::Daily => {
                        account.cooldown_until = resets_at;
                    }
                }
                account.last_error = format!("额度 / 频控：HTTP {status}");
                let _ = account.save(&crate::paths::qoder_accounts_dir());
                record_failure(&meta, &account.last_error, status);
                let (message, kind_name) = qd_quota::friendly(status, &text);
                last_error = Some((if status == 402 { 402 } else { 429 }, message, kind_name));
                break;
            }

            if qd_quota::is_request_fault(status, &text) {
                record_failure(&meta, &text, status);
                let (message, kind) = qd_quota::friendly(status, &text);
                return Response::error(
                    if (400..500).contains(&status) { status } else { 400 },
                    kind,
                    &message,
                );
            }

            if qd_quota::first_token_timeout(&text) {
                // 首字超时：换号，不原地退避
                record_failure(&meta, "首字超时", status);
                last_error = Some((504, "上游首字超时，已换账号重试".into(), "upstream_timeout"));
                break;
            }

            if qd_quota::transient_upstream(status, &text)
                && transient < qd_quota::TRANSIENT_MAX_RETRIES
            {
                transient += 1;
                std::thread::sleep(std::time::Duration::from_secs(transient as u64));
                continue;
            }

            if status == 429 {
                saw_throttle = true;
            }
            record_failure(&meta, &text, status);
            let (message, kind) = qd_quota::friendly(status, &text);
            last_error = Some((status, message, kind));
            break;
        }
    }

    // 未识别的 429：再换一个号试（只多试一个）
    if saw_throttle {
        let now = crate::common::now_secs();
        let retry = qd_pool_order(accounts, &model.id, now, &affinity, conversations);
        for index in retry {
            if tried.contains(&accounts[index].uid) {
                continue;
            }
            let account = &accounts[index];
            let (body, prepared) = match qd_body::build(qd_body::BuildInput {
                payload: &value,
                account,
                model: &model,
                conversation: conversation_ref.as_ref(),
            }) {
                Ok(built) => built,
                Err(_) => continue,
            };
            let encoded = match qd_body::encode(&body) {
                Ok(encoded) => encoded,
                Err(_) => continue,
            };
            let meta = Meta {
                ts: crate::common::now_secs(),
                uid: account.uid.clone(),
                model: model.id.clone(),
                ua: ua.clone(),
                effort: prepared.effort_requested.clone(),
                stream: wants_stream,
                api_key_tail: api_key_tail.clone(),
            };
            let mut handle = qd_api_chat::spawn(ChatCall {
                account: account.clone(),
                model_key: prepared.model_key.clone(),
                body: encoded,
            });
            match handle.head() {
                Ok(200) => {
                    return if wants_stream {
                        stream_response(handle, meta, qd_body::tool_schemas(&value))
                    } else {
                        aggregate_response(handle, meta, qd_body::tool_schemas(&value))
                    };
                }
                Ok(status) => {
                    let text = qd_api_chat::drain_text(&mut handle);
                    record_failure(&meta, &text, status);
                }
                Err(message) => record_failure(&meta, &message, 0),
            }
        }
    }

    match last_error {
        Some((status, message, kind)) => Response::error(status, kind, &message),
        None => Response::error(503, "no_account", "没有可用的 Qoder 账号，请先在 Qoder 页登录"),
    }
}

fn qd_pool_order(
    accounts: &[Account],
    model: &str,
    now: i64,
    affinity: &str,
    conversations: &HashMap<String, Conversation>,
) -> Vec<usize> {
    // 会话亲和 key 本身不指向 uid；真正的亲和账号记在 Conversation 里没存。
    // 这里用「同一段对话固定用顺序里的第一个可用号」已经够用：前缀缓存按账号存，
    // 而账号池里能用的号通常只有一个到两个。
    let _ = (affinity, conversations);
    crate::qd_pool::order(accounts, model, now)
}

/// 取（必要时新建）这一段对话的身份。`affinity` 为空时不建（无法归组）。
fn conversation_for(
    conversations: &mut HashMap<String, Conversation>,
    affinity: &str,
    messages: &[Value],
) -> Option<Conversation> {
    if affinity.is_empty() {
        return None;
    }
    if let Some(conversation) = conversations.get(affinity) {
        return Some(conversation.clone());
    }
    let name = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get("content"))
        .map(|content| content.as_str().unwrap_or("").chars().take(30).collect())
        .unwrap_or_default();
    let conversation = Conversation {
        id: uuid::Uuid::new_v4().to_string(),
        begin_at: crate::common::now_secs() * 1000,
        name,
    };
    conversations.insert(affinity.to_string(), conversation.clone());
    Some(conversation)
}

/// 没有可用账号时的错误：把每个号为什么不行的原因说清楚。
fn unavailable(accounts: &[Account], model: &str, now: i64) -> Response {
    if accounts.is_empty() {
        return Response::error(503, "no_account", "还没有 Qoder 账号，请先在 Qoder 页登录");
    }
    let mut reasons = Vec::new();
    for account in accounts {
        let reason = if !account.enabled {
            "已停用".to_string()
        } else if account.token_expired || account.access_token.trim().is_empty() {
            "需要重新登录".to_string()
        } else if account.quota_blocked(now) {
            format!("额度用完，{} 后恢复", account.quota_until() - now)
        } else if now < account.cooldown_until {
            format!("冷却中，{} 秒后重试", account.cooldown_until - now)
        } else if account.model_blocked(model, now) {
            format!("模型「{model}」额度用完")
        } else {
            "可用".to_string()
        };
        reasons.push(format!("{}：{reason}", account.label()));
    }
    Response::error(
        503,
        "no_available_account",
        &format!("没有能发「{model}」的 Qoder 账号 —— {}", reasons.join("；")),
    )
}

/// 流式返回。
fn stream_response(mut handle: StreamHandle, meta: Meta, schemas: Vec<crate::qd_tools::ToolSchema>) -> Response {
    Response::sse(move |writer| {
        let started = Instant::now();
        let mut decoder = Decoder::default();
        let mut aggregator = Aggregator::default();
        let mut guard = LeakGuard::default();
        let mut ids: HashMap<i64, String> = HashMap::new();
        let mut first_at: Option<Instant> = None;
        let mut error: Option<String> = None;
        let mut done = false;

        let write_chunk = |writer: &mut crate::wb_server::ChunkedWriter<'_>, value: &Value| {
            let text = format!("data: {}\n\n", value);
            writer.write_text(&text)
        };

        while !done {
            let Some(event) = handle.next() else {
                break;
            };
            let events = match event {
                UpstreamEvent::Chunk(bytes) => decoder.push(&bytes),
                UpstreamEvent::End => {
                    done = true;
                    decoder.finish()
                }
                UpstreamEvent::Failed(message) => {
                    error = Some(message);
                    done = true;
                    Vec::new()
                }
                UpstreamEvent::Head(_) => Vec::new(),
            };
            for envelope in events {
                match envelope {
                    Envelope::Done => {
                        done = true;
                    }
                    Envelope::Failed(status, detail) => {
                        error = Some(format!("上游返回 HTTP {status}：{detail}"));
                        done = true;
                    }
                    Envelope::Chunk(mut chunk) => {
                        crate::qd_sse::fill_call_ids(&mut chunk, &mut ids);
                        aggregator.absorb(&chunk);
                        // 泄漏缓冲：正文先过一遍，收尾再决定是正文还是工具调用
                        let text = chunk
                            .pointer("/choices/0/delta/content")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Some(text) = text {
                            let emit = guard.feed(&text);
                            if emit.is_empty() {
                                continue;
                            }
                            if let Some(delta) = chunk
                                .pointer_mut("/choices/0/delta")
                                .and_then(Value::as_object_mut)
                            {
                                delta.insert("content".into(), Value::String(emit));
                            }
                        }
                        if first_at.is_none() {
                            first_at = Some(Instant::now());
                        }
                        let _ = write_chunk(writer, &chunk);
                    }
                }
            }
        }

        let (tail, calls) = guard.finish(&schemas);
        if !tail.is_empty() {
            let chunk = json!({
                "id": "chatcmpl-qoder",
                "object": "chat.completion.chunk",
                "created": crate::common::now_secs(),
                "model": meta.model,
                "choices": [{ "index": 0, "delta": { "content": tail }, "finish_reason": null }],
            });
            let _ = write_chunk(writer, &chunk);
        }
        if !calls.is_empty() {
            let chunk = json!({
                "id": "chatcmpl-qoder",
                "object": "chat.completion.chunk",
                "created": crate::common::now_secs(),
                "model": meta.model,
                "choices": [{ "index": 0, "delta": { "tool_calls": calls }, "finish_reason": "tool_calls" }],
            });
            let _ = write_chunk(writer, &chunk);
        }
        match error {
            Some(message) => {
                let chunk = json!({ "error": { "message": message, "type": "upstream_error" } });
                let _ = write_chunk(writer, &chunk);
            }
            None => {
                let _ = writer.write_text("data: [DONE]\n\n");
            }
        }
        let _ = writer.write_text("\n");
        let completion = aggregator.into_completion(&schemas);
        record_success(&meta, &completion, started, first_at);
        Ok(())
    })
}

/// 非流式：把流折成一个完整响应。
fn aggregate_response(mut handle: StreamHandle, meta: Meta, schemas: Vec<crate::qd_tools::ToolSchema>) -> Response {
    let started = Instant::now();
    let mut decoder = Decoder::default();
    let mut aggregator = Aggregator::default();
    let mut ids: HashMap<i64, String> = HashMap::new();
    let mut first_at: Option<Instant> = None;
    let mut error: Option<(u16, String)> = None;
    let mut done = false;
    while !done {
        let Some(event) = handle.next() else {
            break;
        };
        let events = match event {
            UpstreamEvent::Chunk(bytes) => decoder.push(&bytes),
            UpstreamEvent::End => {
                done = true;
                decoder.finish()
            }
            UpstreamEvent::Failed(message) => {
                error = Some((502, message));
                done = true;
                Vec::new()
            }
            UpstreamEvent::Head(_) => Vec::new(),
        };
        for envelope in events {
            match envelope {
                Envelope::Done => done = true,
                Envelope::Failed(status, detail) => {
                    error = Some((status, detail));
                    done = true;
                }
                Envelope::Chunk(mut chunk) => {
                    crate::qd_sse::fill_call_ids(&mut chunk, &mut ids);
                    aggregator.absorb(&chunk);
                    if first_at.is_none() {
                        first_at = Some(Instant::now());
                    }
                }
            }
        }
    }
    if let Some((status, message)) = error {
        record_failure(&meta, &message, status);
        let (text, kind) = qd_quota::friendly(status, &message);
        return Response::error(if status >= 400 { status } else { 502 }, kind, &text);
    }
    let completion = aggregator.into_completion(&schemas);
    record_success(&meta, &completion, started, first_at);
    Response::json(&completion)
}

fn record_success(meta: &Meta, completion: &Value, started: Instant, first_at: Option<Instant>) {
    let usage = completion.get("usage").cloned().unwrap_or(Value::Null);
    let numbers = wb_usage::parse_usage(&usage);
    let ttft = first_at
        .map(|at| at.duration_since(started).as_millis() as i64)
        .unwrap_or_else(|| started.elapsed().as_millis() as i64);
    let row = UsageRow {
        ts: meta.ts,
        uid: meta.uid.clone(),
        machine: String::new(),
        model: meta.model.clone(),
        prompt_tokens: numbers.prompt,
        completion_tokens: numbers.completion,
        total_tokens: numbers.total,
        cached_tokens: numbers.cached,
        ttft_ms: ttft,
        duration_ms: started.elapsed().as_millis() as i64,
        ok: true,
        error: String::new(),
        ua: meta.ua.clone(),
        effort: meta.effort.clone(),
        stream: Some(meta.stream),
        reasoning_tokens: numbers.reasoning,
        credit: qd_usage::parse_credits(&usage),
        api_key: meta.api_key_tail.clone(),
        cost_cny: None,
    };
    let _ = qd_usage::append(&row);
}

fn record_failure(meta: &Meta, error: &str, _status: u16) {
    let message: String = error.chars().take(200).collect();
    let row = UsageRow {
        ts: meta.ts,
        uid: meta.uid.clone(),
        machine: String::new(),
        model: meta.model.clone(),
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        ttft_ms: 0,
        duration_ms: 0,
        ok: false,
        error: message,
        ua: meta.ua.clone(),
        effort: meta.effort.clone(),
        stream: Some(meta.stream),
        reasoning_tokens: 0,
        credit: None,
        api_key: meta.api_key_tail.clone(),
        cost_cny: None,
    };
    let _ = qd_usage::append(&row);
}


/// 写一行到 stdout 之外的调试口（保留给排障，不参与业务）。
#[allow(dead_code)]
fn trace(message: &str) {
    let _ = writeln!(std::io::stderr(), "[qoder] {message}");
}
