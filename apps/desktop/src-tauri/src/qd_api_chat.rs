//! 上游对话调用：COSY 签名 → POST 编码后的请求体 → 把字节流交回编排层。
//!
//! 与 `wb_api_chat` 同一个模式：**多起一根线程**，用通道先送状态码、再送正文片段。
//! 网关必须知道上游状态码才能决定回给客户端的是「200 + SSE」还是错误 JSON，
//! 而这两件事都发生在读正文之前；单线程同步做只能二选一。
//!
//! 通道送的是**字节**不是帧，切信封是 `qd_sse` 的事。

use std::sync::mpsc::{channel, Receiver};

use crate::http;
use crate::qd_account::Account;
use crate::qd_sign::CosySession;
use crate::qd_upstream;

/// 上游往回送的东西。
pub enum UpstreamEvent {
    Head(u16),
    Chunk(Vec<u8>),
    End,
    Failed(String),
}

/// 一次对话调用的输入。
pub struct ChatCall {
    pub account: Account,
    pub model_key: String,
    /// 已经编码过的请求体（`qoder_encode` 的结果）
    pub body: String,
}

/// 发起调用，立刻返回句柄。
pub fn spawn(call: ChatCall) -> StreamHandle {
    let (sender, receiver) = channel();
    let spawned = std::thread::Builder::new()
        .name("qd-chat-upstream".into())
        .spawn(move || {
            let url = qd_upstream::gateway(qd_upstream::CHAT_PATH);
            let session = match CosySession::new(
                &call.account.uid,
                &call.account.nickname,
                &call.account.access_token,
                &call.account.refresh_token,
                &call.account.user_type,
                &call.account.organization_id,
                &call.account.organization_name,
            ) {
                Ok(session) => session,
                Err(message) => {
                    let _ = sender.send(UpstreamEvent::Failed(message));
                    return;
                }
            };
            let headers = match session.headers(&call.body, &url, &call.model_key, true, "text/event-stream")
            {
                Ok(headers) => headers,
                Err(message) => {
                    let _ = sender.send(UpstreamEvent::Failed(message));
                    return;
                }
            };
            let refs: Vec<(&str, &str)> = headers
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            let head_sender = sender.clone();
            let chunk_sender = sender.clone();
            let result = http::request_url_stream(
                "POST",
                &url,
                &refs,
                Some(&call.body),
                &mut |status| {
                    let _ = head_sender.send(UpstreamEvent::Head(status));
                },
                &mut |chunk| {
                    chunk_sender
                        .send(UpstreamEvent::Chunk(chunk.to_vec()))
                        .is_ok()
                },
            );
            let _ = match result {
                Ok(_) => sender.send(UpstreamEvent::End),
                Err(message) => sender.send(UpstreamEvent::Failed(message)),
            };
        });
    if let Err(err) = spawned {
        let (fallback_sender, fallback) = channel();
        let _ = fallback_sender.send(UpstreamEvent::Failed(format!(
            "上游调用线程起不来：{err}"
        )));
        return StreamHandle { receiver: fallback };
    }
    StreamHandle { receiver }
}

/// 通道这一侧的读句柄。
pub struct StreamHandle {
    receiver: Receiver<UpstreamEvent>,
}

impl StreamHandle {
    /// 等到状态码。**唯一一次阻塞等待**。
    pub fn head(&mut self) -> Result<u16, String> {
        loop {
            match self.receiver.recv() {
                Ok(UpstreamEvent::Head(status)) => return Ok(status),
                Ok(UpstreamEvent::Failed(message)) => return Err(message),
                Ok(UpstreamEvent::Chunk(_)) | Ok(UpstreamEvent::End) => continue,
                Err(_) => return Err("上游连接提前断开".into()),
            }
        }
    }

    /// 取下一个事件。结束或断线都返回 `None`。
    pub fn next(&mut self) -> Option<UpstreamEvent> {
        match self.receiver.recv() {
            Ok(UpstreamEvent::End) | Ok(UpstreamEvent::Failed(_)) | Err(_) => None,
            Ok(event) => Some(event),
        }
    }
}

/// 把剩余正文一次性读完（错误响应体用）。
pub fn drain_text(handle: &mut StreamHandle) -> String {
    let mut buffer = Vec::new();
    while let Some(event) = handle.next() {
        if let UpstreamEvent::Chunk(bytes) = event {
            buffer.extend_from_slice(&bytes);
            if buffer.len() > 600 {
                break;
            }
        }
    }
    String::from_utf8_lossy(&buffer).to_string()
}

#[cfg(test)]
impl StreamHandle {
    /// 测试用：把一串事件装进通道，模拟上游读句柄。
    pub fn from_events(events: Vec<UpstreamEvent>) -> Self {
        let (sender, receiver) = channel();
        for event in events {
            let _ = sender.send(event);
        }
        Self { receiver }
    }
}
