//! Qoder 本地网关的路由表。
//!
//! 与 `wb_router` 同一套鉴权口径：除 `/health` 外都要 `Authorization: Bearer <key>`
//! （`x-api-key` 也认）。密钥来自共享槽，与 TBuddy 是同一把。

use std::collections::HashMap;

use crate::qd_account::Account;
use crate::qd_body::Conversation;
use crate::qd_relay;
use crate::wb_server::{Request, Response};

pub fn route(
    request: &Request,
    accounts: &mut [Account],
    api_key: &str,
    conversations: &mut HashMap<String, Conversation>,
) -> Response {
    let path = request.path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };

    if (request.method.as_str(), path) == ("GET", "/health") {
        return health(accounts);
    }
    if !api_key.trim().is_empty() && !key_matches(request, api_key) {
        let expected = key_tail(api_key);
        let supplied = supplied_key(request);
        let supplied = if supplied.is_empty() {
            "未带".to_string()
        } else {
            format!("…{}", key_tail(supplied))
        };
        return Response::error(
            401,
            "invalid_api_key",
            &format!(
                "缺少或错误的 API Key：请在请求头带 Authorization: Bearer <网关密钥>（当前密钥末四位 …{expected}；请求带的密钥末四位 {supplied}）"
            ),
        );
    }

    match (request.method.as_str(), path) {
        ("GET", "/health") => health(accounts),
        ("GET", "/v1/models" | "/models") => qd_relay::models(),
        (
            "POST",
            "/v1/chat/completions" | "/chat/completions" | "/v1/completions" | "/completions",
        ) => qd_relay::chat(request, accounts, api_key, conversations),
        ("GET", "/") => Response::text(200, "workbench qoder gateway"),
        (method, path) => Response::error(
            404,
            "not_found",
            &format!("没有这条路由：{method} {path}"),
        ),
    }
}

fn supplied_key(request: &Request) -> &str {
    let bearer = request
        .header("authorization")
        .and_then(|value| value.split_once(' '))
        .map(|(scheme, rest)| (scheme.eq_ignore_ascii_case("bearer"), rest.trim()))
        .filter(|(is_bearer, _)| *is_bearer)
        .map(|(_, rest)| rest);
    bearer.or_else(|| request.header("x-api-key")).unwrap_or("")
}

fn key_matches(request: &Request, expected: &str) -> bool {
    let supplied = supplied_key(request);
    supplied.len() == expected.len() && supplied == expected
}

fn key_tail(key: &str) -> String {
    key.chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn health(accounts: &[Account]) -> Response {
    let ready = accounts.iter().filter(|account| account.is_ready()).count();
    Response::json(&serde_json::json!({
        "ok": true,
        "proxy": "qoder",
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
        let mut conversations = HashMap::new();
        let response = route(&request("GET", "/nope"), &mut [], "", &mut conversations);
        assert_eq!(response.status, 404);
    }

    #[test]
    fn 健康检查公开且带_proxy_标记() {
        let mut conversations = HashMap::new();
        let response = route(&request("GET", "/health"), &mut [], "", &mut conversations);
        assert_eq!(response.status, 200);
        let crate::wb_server::Body::Bytes(bytes) = &response.body else {
            panic!("健康检查不该是流");
        };
        let value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(value["proxy"], "qoder");
        assert!(value.get("uid").is_none());
    }

    #[test]
    fn 配了密钥就要校验() {
        let mut conversations = HashMap::new();
        assert_eq!(
            route(&request("GET", "/v1/models"), &mut [], "wbg-x", &mut conversations).status,
            401
        );
        let mut ok = request("GET", "/v1/models");
        ok.headers = vec![("authorization".into(), "Bearer wbg-x".into())];
        assert_eq!(route(&ok, &mut [], "wbg-x", &mut conversations).status, 200);
    }
}
