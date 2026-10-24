//! 上游对话调用：网关唯一一条真正发聊天请求的缝。//!
//! **为什么要多起一根线程**：网关得先知道上游的状态码，才能决定回给客户端的是
//! 「200 + SSE 流」还是「401 + 一段错误 JSON」。而这两件事发生在读正文之前 ——
//! 一根线程同步做完就只能要么先缓存整段（丢掉流式），要么盲猜 200。
//! 于是这里把上游调用放到单独线程，用通道把「状态码」与「正文片段」按到达顺序送回来：
//! 调用方阻塞等到状态码，再决定怎么组装自己的响应，之后继续从通道里取片段写出去。
//!
//! 通道消息是**字节**不是帧 —— 切帧是 [`crate::wb_sse`] 的事，两层各管一段。

use std::sync::mpsc::{channel, Receiver};

use crate::http;
use crate::wb_account::Account;
use crate::wb_identity;

/// 上游往回送的东西。
pub enum UpstreamEvent {
    /// 状态码，先于任何正文
    Head(u16),
    /// 正文片段（可能切在半行上）
    Chunk(Vec<u8>),
    /// 上游正常结束
    End,
    /// 本机侧失败（连接、TLS、超时、读错误）
    Failed(String),
}

/// 一次对话调用的全部输入。
pub struct ChatCall {
    pub account: Account,
    pub ids: wb_identity::Ids,
    pub model: Option<String>,
    /// 已经归一化过的请求体（JSON 文本）
    pub body: String,
}

/// 对话端点路径。
const CHAT_PATH: &str = "/v2/chat/completions";

/// 发起调用，立刻返回句柄。真正的网络动作在后台线程里。
pub fn spawn(call: ChatCall) -> StreamHandle {
    let (sender, receiver) = channel();

    let spawned = std::thread::Builder::new()
        .name("wb-chat-upstream".into())
        .spawn(move || {
            let url = crate::wb_upstream::chat_url(CHAT_PATH);

            let input = wb_identity::ChatHeaders {
                identity: call.account.product,
                uid: &call.account.uid,
                token: &call.account.access_token,
                ids: &call.ids,
                enterprise_id: &call.account.enterprise_id,
                tenant_id: "",
                department: "",
                model: call.model.as_deref(),
                device_token: None,
            };
            let owned = wb_identity::chat_headers(&input);
            let refs: Vec<(&str, &str)> = owned
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str()))
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
        // 线程都起不来，只能把错误塞进通道让调用方按失败处理
        let (fallback_sender, fallback) = channel();
        let _ = fallback_sender.send(UpstreamEvent::Failed(format!(
            "上游调用线程起不来: {err}"
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
    /// 等到状态码。**这是唯一一次阻塞等待**，之后都是按到达顺序取。
    ///
    /// 通道提前断开（线程死掉）算失败。
    pub fn head(&mut self) -> Result<u16, String> {
        loop {
            match self.receiver.recv() {
                Ok(UpstreamEvent::Head(status)) => return Ok(status),
                Ok(UpstreamEvent::Failed(message)) => return Err(message),
                // 状态码之前不该有正文；真出现了就当没看见
                Ok(UpstreamEvent::Chunk(_)) | Ok(UpstreamEvent::End) => continue,
                Err(_) => return Err("上游连接提前断开".into()),
            }
        }
    }

    /// 取下一个事件。结束或断线都返回 `None`。
    ///
    /// `Failed` 会以 `None` 的形式收尾，但错误原因已经通过 `Err` 变体交给过
    /// [`head`](Self::head) 的调用方；中途的网络错误在这里只能选择"就此打住" ——
    /// 此时响应头早就发出去了，能做的只有停。
    pub fn next(&mut self) -> Option<UpstreamEvent> {
        match self.receiver.recv() {
            Ok(UpstreamEvent::End) => None,
            Ok(UpstreamEvent::Failed(_)) => None,
            Ok(event) => Some(event),
            Err(_) => None,
        }
    }
}
