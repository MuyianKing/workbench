//! 国内版上游的全部常量与版本号 —— **唯一来源**。
//!
//! 网关只接国内版（CodeBuddy）：对话走 `copilot.tencent.com`，记账走 `www.codebuddy.cn`，
//! 两者不是同一个域；`Origin` / `Referer` 又是第三个口径（见下）。原项目把这些常量散在
//! 四个模块里，自己注释里承认过「5.8.4 对齐时漏改了 intl 那一份」—— 同一条事实写两遍
//! 迟早对不上，所以这里只留一处。
//!
//! 纯逻辑：不碰网络、不碰文件、不读环境变量。

/// 对话 / 鉴权 / 上报的 base。
pub const CHAT_UPSTREAM: &str = "https://copilot.tencent.com";

/// 计费与积分的 base。
pub const BILLING_UPSTREAM: &str = "https://www.codebuddy.cn";

/// `Origin` 与 `Referer` 的基础域（**不等于** [`CHAT_UPSTREAM`]，别顺手统一）。
pub const ORIGIN: &str = "https://www.codebuddy.cn";

/// `X-Domain` 的兜底值（账号自己记了 domain 时以账号的为准）。
pub const DOMAIN: &str = "copilot.tencent.com";

/// 对话身份的三段式 UA。UA 取自官方桌面端 5.5.6；这一段没有抓包佐证，维持原值，不凭猜测改。
pub const CHAT_UA: &str = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";

/// 计费 / 鉴权路径用的短 UA。
pub const BILLING_UA: &str = "WorkBuddy/5.5.6";

/// `Accept-Language`。
pub const ACCEPT_LANGUAGE: &str = "zh-CN";

/// 对话端点（含路径）。`path` 要带前导斜杠。
pub fn chat_url(path: &str) -> String {
    format!("{CHAT_UPSTREAM}{path}")
}

/// 计费端点（含路径）。注意与 [`chat_url`] **不是同一个域**：对话走 copilot、
/// 记账走 codebuddy.cn。
pub fn billing_url(path: &str) -> String {
    format!("{BILLING_UPSTREAM}{path}")
}

/// `X-Domain` 的生效值：账号自己记的优先，空则回落到规范域。
pub fn effective_domain(domain: &str) -> String {
    let dom = domain.trim();
    if dom.is_empty() {
        DOMAIN.to_string()
    } else {
        dom.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 国内版的三个域不是同一个() {
        // 这三条是原项目反复踩过的坑，钉死在这里
        assert_eq!(CHAT_UPSTREAM, "https://copilot.tencent.com");
        assert_eq!(BILLING_UPSTREAM, "https://www.codebuddy.cn");
        assert_eq!(ORIGIN, "https://www.codebuddy.cn");
        assert_eq!(DOMAIN, "copilot.tencent.com");
        assert!(!DOMAIN.contains("://"), "X-Domain 不带协议头");
    }

    #[test]
    fn 端点拼接保留前导斜杠() {
        assert_eq!(
            chat_url("/v2/chat/completions"),
            "https://copilot.tencent.com/v2/chat/completions"
        );
        assert_eq!(
            billing_url("/v2/billing/meter/get-user-resource"),
            "https://www.codebuddy.cn/v2/billing/meter/get-user-resource"
        );
    }

    #[test]
    fn 空域名回落到规范值() {
        assert_eq!(effective_domain(""), "copilot.tencent.com");
        assert_eq!(effective_domain("  "), "copilot.tencent.com");
        // 用户自己的租户域原样保留
        assert_eq!(effective_domain("tenant.example.com"), "tenant.example.com");
    }
}
