//! 路由表。一张 `match`，每个分支只做一件事 —— 不做原项目那种两条 `if path == ...`
//! 的长链（21k 行的单文件里，找一条路由要先读两百行）。
//!
//! 纯调度：不解析协议、不碰网络、不认识数据库。它做的唯一判断是「这个方法 + 这个路径
//! 归哪个处理函数」。

use crate::wb_account::Account;
use crate::wb_relay;
use crate::wb_server::{Request, Response};

/// 分发。`accounts` 可写是因为对话请求可能要顺手续期账号 token。
///
/// `api_key` 非空时，除 `/health` 之外都要带 `Authorization: Bearer <key>`。
/// 本地也拦：端口开着的时候，本机任何一个程序都能连上来，密钥是唯一一道闸。
pub fn route(request: &Request, accounts: &mut [Account], api_key: &str) -> Response {
    let path = request.path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };

    // 探活不鉴权：它只回数量，不含任何账号信息，界面与 curl 都要能直接打
    if (request.method.as_str(), path) == ("GET", "/health") {
        return health(accounts);
    }
    if !api_key.trim().is_empty() && !key_matches(request, api_key) {
        return Response::error(
            401,
            "invalid_api_key",
            "缺少或错误的 API Key：请在请求头带 Authorization: Bearer <网关密钥>",
        );
    }

    match (request.method.as_str(), path) {
        ("GET", "/health") => health(accounts),
        ("GET", "/v1/models" | "/models") => wb_relay::models(),
        (
            "POST",
            "/v1/chat/completions" | "/chat/completions" | "/v1/completions" | "/completions",
        ) => wb_relay::chat(request, accounts, api_key),
        ("GET", "/") => Response::text(200, "workbench gateway"),
        (method, path) => Response::error(
            404,
            "not_found",
            &format!("没有这条路由：{method} {path}"),
        ),
    }
}

/// 请求里的密钥是否匹配。`Authorization: Bearer x` 为主，`x-api-key` 兼容一些客户端。
fn key_matches(request: &Request, expected: &str) -> bool {
    let bearer = request
        .header("authorization")
        .and_then(|value| value.split_once(' '))
        .map(|(scheme, rest)| (scheme.eq_ignore_ascii_case("bearer"), rest.trim()))
        .filter(|(is_bearer, _)| *is_bearer)
        .map(|(_, rest)| rest);
    let supplied = bearer.or_else(|| request.header("x-api-key")).unwrap_or("");
    // 长度不同直接 false，再逐字节比 —— 本机场景不做常数时间，但别用 == 比较 String 的分支
    supplied.len() == expected.len() && supplied == expected
}

/// 健康检查。**不要求鉴权** —— 它是给界面和 curl 探活用的，不含任何账号信息。
fn health(accounts: &[Account]) -> Response {
    let ready = accounts.iter().filter(|account| account.is_ready()).count();
    Response::json(&serde_json::json!({
        "ok": true,
        "accounts": accounts.len(),
        "ready": ready,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            query: String::new(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    #[test]
    fn 未知路由给_404() {
        let response = route(&request("GET", "/nope"), &mut [], "");
        assert_eq!(response.status, 404);
    }

    #[test]
    fn 健康检查是公开的且不泄露账号() {
        let response = route(&request("GET", "/health"), &mut [], "");
        assert_eq!(response.status, 200);
        let crate::wb_server::Body::Bytes(bytes) = &response.body else {
            panic!("健康检查不该是流");
        };
        let value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["accounts"], 0);
        assert!(value.get("uid").is_none());
    }

    #[test]
    fn 四个对话路径都归到同一个处理函数() {
        for path in [
            "/v1/chat/completions",
            "/chat/completions",
            "/v1/completions",
            "/completions",
        ] {
            let mut post = request("POST", path);
            // 带上最小可用请求体，才能走过 400 那道校验、落到「没有账号」
            post.body = br#"{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}]}"#.to_vec();
            let response = route(&post, &mut [], "");
            // 没有账号 → 503（证明已经进到 chat 处理器了，而不是 404）
            assert_eq!(response.status, 503, "{path}");
        }
    }

    #[test]
    fn 尾斜杠不影响匹配() {
        assert_eq!(route(&request("GET", "/health/"), &mut [], "").status, 200);
    }

    #[test]
    fn 配了密钥就要校验() {
        let mut request = request("GET", "/v1/models");
        // 没带钥匙
        assert_eq!(route(&request, &mut [], "wbg-x").status, 401);
        // 带错钥匙
        request.headers = vec![("authorization".into(), "Bearer wrong".into())];
        assert_eq!(route(&request, &mut [], "wbg-x").status, 401);
        // 带对钥匙
        request.headers = vec![("authorization".into(), "Bearer wbg-x".into())];
        assert_eq!(route(&request, &mut [], "wbg-x").status, 200);
        // x-api-key 也认
        request.headers = vec![("x-api-key".into(), "wbg-x".into())];
        assert_eq!(route(&request, &mut [], "wbg-x").status, 200);
        // 探活永远放行
        assert_eq!(route(&self::request("GET", "/health"), &mut [], "wbg-x").status, 200);
    }

    #[test]
    fn 没配密钥时不校验() {
        assert_eq!(route(&request("GET", "/v1/models"), &mut [], "").status, 200);
    }

    #[test]
    fn 方法不对时是_404_而不是_405() {
        // 网关自己用，不追求 HTTP 语义完备；把 405 的复杂度留给不需要它的场景
        assert_eq!(route(&request("DELETE", "/health"), &mut [], "").status, 404);
    }
}
