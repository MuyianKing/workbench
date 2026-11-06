//! Qoder 国内版上游的全部常量与端点 —— **唯一来源**。
//!
//! 只接国内版（qoder.com.cn）：账号与计费挂 `openapi.qoder.com.cn`，推理走
//! `gateway.qoder.com.cn`，设备授权的授权页在官网 `qoder.com.cn`。三者不是同一个域，
//! 与原项目 `qoder2api-hub` 的 `REALM_CONFIGS["cn"]` 逐项对齐。
//!
//! 纯逻辑：不碰网络、不碰文件、不读环境变量。

/// 账号 / 计费 / 模型目录的 API 基址。
pub const OPENAPI: &str = "https://openapi.qoder.com.cn";

/// 推理（COSY 签名）基址。
pub const GATEWAY: &str = "https://gateway.qoder.com.cn";

/// 官网：设备授权页挂在这里，不在 openapi 上。
pub const WEBSITE: &str = "https://qoder.com.cn";

/// 官方 CLI / 桌面端的客户端 id（设备授权 URL 参数）。
pub const CLIENT_ID: &str = "1c5e33e1-364d-4ce6-b02c-acaa81274a5c";

/// 设备授权完成后的回跳协议。
pub const REDIRECT_URI: &str = "qoder-work-cn://";

/// 账号接口的 UA（国内版是 `QoderWork/<版本>`，国际版才是 `Qoder/<版本>`）。
pub const ACCOUNT_UA: &str = "QoderWork/1.1.75";

/// COSY 协议版本（推理请求头与签名 payload 共用）。
pub const COSY_VERSION: &str = "1.1.75";

/// 推理请求的 UA：官方 CLI 不设 UA，由它的 HTTP 库补默认值。
pub const COSY_USER_AGENT: &str = "undici";

/// `cosy-clienttype`。官方 CLI 为 5。
pub const COSY_CLIENT_TYPE: &str = "5";

/// `cosy-machineos`。本应用只跑 Windows x64，与原项目 Windows 默认值一致。
pub const COSY_MACHINE_OS: &str = "x86_64_win32";

/// 账号身份里缺 `user_type` 时的兜底值（官方客户端默认档）。
pub const DEFAULT_USER_TYPE: &str = "personal_professional_trial";

/// 推理端点：`Encode=1` 表示请求体走 Qoder 自定义 Base64。
pub const CHAT_PATH: &str =
    "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

/// 上游模型目录。签名覆盖 path，body 也必须是同一个编码后的 `{}`。
pub const MODELS_PATH: &str = "/algo/api/v2/model/list?Encode=1";

// ---------- 账号 / 计费端点 ----------

pub const PATH_DEVICE_POLL: &str = "/api/v1/deviceToken/poll";
pub const PATH_DEVICE_REFRESH: &str = "/api/v1/deviceToken/refresh";
pub const PATH_JOB_REFRESH: &str = "/api/v1/jobToken/refresh";
pub const PATH_USERINFO: &str = "/api/v1/userinfo";
pub const PATH_QUOTA: &str = "/api/v2/quota/usage";
pub const PATH_PLAN: &str = "/api/v2/user/plan";

pub const PATH_CHECKIN_STATUS: &str = "/sash/api/v1/me/daily-check-in/status";
pub const PATH_CHECKIN_CLAIM: &str = "/sash/api/v1/me/daily-check-in/claim";
pub const PATH_CAMPAIGNS: &str = "/sash/api/v1/me/campaigns";
pub const PATH_CREDIT_HEATMAP: &str = "/sash/api/v1/ai-conversations/credits-heatmap";

/// 设备授权页。参数（challenge / nonce / client_id / machine_id / redirect_uri）
/// 由 [`crate::qd_auth`] 拼上去。
pub fn device_auth_url(query: &str) -> String {
    format!("{WEBSITE}/device/selectAccounts?{query}")
}

/// 账号 / 计费端点。
pub fn openapi(path: &str) -> String {
    format!("{OPENAPI}{path}")
}

/// 推理端点。
pub fn gateway(path: &str) -> String {
    format!("{GATEWAY}{path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 三个域不是同一个() {
        assert_eq!(OPENAPI, "https://openapi.qoder.com.cn");
        assert_eq!(GATEWAY, "https://gateway.qoder.com.cn");
        assert_eq!(WEBSITE, "https://qoder.com.cn");
    }

    #[test]
    fn 端点拼接保留前导斜杠() {
        assert_eq!(
            openapi(PATH_DEVICE_POLL),
            "https://openapi.qoder.com.cn/api/v1/deviceToken/poll"
        );
        assert!(gateway(CHAT_PATH).starts_with("https://gateway.qoder.com.cn/algo/"));
        assert!(gateway(CHAT_PATH).contains("Encode=1"));
    }

    #[test]
    fn 授权页在官网而不是_openapi() {
        assert!(device_auth_url("x=1").starts_with("https://qoder.com.cn/device/selectAccounts?"));
    }
}
