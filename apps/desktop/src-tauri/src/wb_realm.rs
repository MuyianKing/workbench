//! 网关的区域轴：`workbuddy`（国际版）/ `codebuddy`（国内版）。
//!
//! **这个文件是全部上游常量与版本号的唯一来源。** 原项目把它们散在四个模块里，
//! 自己注释里承认过「5.8.4 对齐时漏改了 intl 那一份」—— 同一条事实写两遍迟早对不上，
//! 所以这里只留一处，别处一律 `Realm::config()` 取。
//!
//! 命名上要说清楚一件事：上游真正的轴是**区域**（国际 / 国内），不是产品线。
//! 国内版的域名族里同样混着 `workbuddy.cn`（新版国内客户端的 JWT issuer 就是它），
//! 国际版也存在 `codebuddy.ai` 这个解析不了的边。界面与配置里叫
//! `workbuddy` / `codebuddy` 是**给用户看的叫法**（跟他实际装的两个客户端对得上），
//! 落到协议上仍然是「国际 / 国内」两套出口。两者的对应关系见 `Realm::config()`。
//!
//! 纯逻辑：不碰网络、不碰文件、不读环境变量。

use serde::{Deserialize, Serialize};

/// 区域。序列化进设置与账号文件时用 `"workbuddy"` / `"codebuddy"`。
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Realm {
    /// 国际版：`www.workbuddy.ai`。对话与记账同一个域。
    #[default]
    Workbuddy,
    /// 国内版：对话走 `copilot.tencent.com`，记账走 `www.codebuddy.cn`。
    Codebuddy,
}

/// 一个区域的全部固定参数。`&'static str` 是因为它们全是编译期常量。
#[derive(Debug)]
pub struct RealmConfig {
    /// 界面上的名字（与账号标签一致）
    pub label: &'static str,
    /// 对话 / 鉴权 / 上报的 base
    pub chat_upstream: &'static str,
    /// 计费与积分的 base
    pub billing_upstream: &'static str,
    /// `Origin` 与 `Referer` 的基础域（国内版**不等于** chat_upstream，别顺手统一）
    pub origin: &'static str,
    /// `X-Domain` 的兜底值（账号自己记了 domain 时以账号的为准）
    pub domain: &'static str,
    /// 对话身份的三段式 UA
    pub chat_ua: &'static str,
    /// 计费 / 鉴权路径用的短 UA
    pub billing_ua: &'static str,
    /// `Accept-Language`
    pub accept_language: &'static str,
    /// 有没有国内那套签到 / 成长任务体系。S5 的任务模块按它分流
    #[allow(dead_code)]
    pub has_checkin: bool,
}

/// 国际版。UA 取自官方桌面端 5.8.4 的抓包：首段大写 `WorkBuddy`、次段是 product.json
/// 里的 `applicationName`（`workbuddy-ai`，小写），末段是客户端内置 CLI 的版本。
///
/// 注意别拿 Electron 主进程自己的旁路请求来抄：那一路的 UA 两段都是 `workbuddy-ai`。
pub const WORKBUDDY: RealmConfig = RealmConfig {
    label: "WorkBuddy（国际）",
    chat_upstream: "https://www.workbuddy.ai",
    billing_upstream: "https://www.workbuddy.ai",
    origin: "https://www.workbuddy.ai",
    domain: "www.workbuddy.ai",
    chat_ua: "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0",
    billing_ua: "WorkBuddy/5.8.4",
    accept_language: "en-US",
    has_checkin: false,
};

/// 国内版。UA 取自官方桌面端 5.5.6；这一段没有抓包佐证，维持原值，不凭猜测改。
///
/// 三处容易改错：
/// 1. 对话 base 是 `copilot.tencent.com`，但 `Origin` / `Referer` 必须是 `www.codebuddy.cn`；
/// 2. 记账 base 又是第三个域 `www.codebuddy.cn`（与 origin 同域但语义不同）；
/// 3. `X-Domain` 用 `copilot.tencent.com`，不是 origin。
pub const CODEBUDDY: RealmConfig = RealmConfig {
    label: "CodeBuddy（国内）",
    chat_upstream: "https://copilot.tencent.com",
    billing_upstream: "https://www.codebuddy.cn",
    origin: "https://www.codebuddy.cn",
    domain: "copilot.tencent.com",
    chat_ua: "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1",
    billing_ua: "WorkBuddy/5.5.6",
    accept_language: "zh-CN",
    has_checkin: true,
};

#[allow(dead_code)] // parse / markers / other / ALL 由 S2 的登录与导入接入
impl Realm {
    /// 全部区域，界面与批量操作按这个顺序遍历。
    pub const ALL: [Realm; 2] = [Realm::Workbuddy, Realm::Codebuddy];

    pub fn config(self) -> &'static RealmConfig {
        match self {
            Realm::Workbuddy => &WORKBUDDY,
            Realm::Codebuddy => &CODEBUDDY,
        }
    }

    /// 从持久化字符串解析；认不出就返回 None（由调用方决定回落到什么）。
    pub fn parse(raw: &str) -> Option<Realm> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "workbuddy" | "intl" | "global" => Some(Realm::Workbuddy),
            "codebuddy" | "cn" => Some(Realm::Codebuddy),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Realm::Workbuddy => "workbuddy",
            Realm::Codebuddy => "codebuddy",
        }
    }

    /// 对话端点（含路径）。`path` 要带前导斜杠。
    pub fn chat_url(self, path: &str) -> String {
        format!("{}{}", self.config().chat_upstream, path)
    }

    /// 计费端点（含路径）。注意与 `chat_url` **不是同一个域**：
    /// 国内版对话走 copilot、记账走 codebuddy.cn。
    pub fn billing_url(self, path: &str) -> String {
        format!("{}{}", self.config().billing_upstream, path)
    }

    /// 这个区域认得的域名标记（判归属时用）。
    pub fn markers(self) -> &'static [&'static str] {
        match self {
            Realm::Workbuddy => &WORKBUDDY_MARKERS,
            Realm::Codebuddy => &CODEBUDDY_MARKERS,
        }
    }

    /// 另一个区域。`align_domain` 判「域名属于对面」时用。
    pub fn other(self) -> Realm {
        match self {
            Realm::Workbuddy => Realm::Codebuddy,
            Realm::Codebuddy => Realm::Workbuddy,
        }
    }
}

/// 国内版出口认得的历史域名。国内换过三次出口：`copilot.tencent.com` → `codebuddy.cn`
/// → `workbuddy.cn`（新版国内客户端的 JWT issuer 就是 `https://www.workbuddy.cn/...`）。
///
/// **三个都得认**：只认前两个会把 `workbuddy.cn` 的国内账号判成国际版 ——
/// 手动导入 JSON 时「明明是国内的却进了国际版」就是这么来的。
pub const CODEBUDDY_MARKERS: [&str; 3] = ["copilot.tencent.com", "codebuddy.cn", "workbuddy.cn"];

/// 国际版出口的标记。`codebuddy.ai` 也在这里：它是国际侧的域名族（实测解析不了，
/// 客户端因此改走 `workbuddy.ai`，但 JWT 里仍可能出现）。
pub const WORKBUDDY_MARKERS: [&str; 2] = ["workbuddy.ai", "codebuddy.ai"];

/// 从 JWT 的 `iss` 与账号记下的 `domain` 推断区域。看不出返回 `None` —— **不要瞎猜**。
///
/// 先看 `iss` 再看域名，冲突时以 `iss` 为准：域名是客户端随手记的字段，切区登录过就会
/// 过期；`iss` 来自 token 本身，是真正要拿去请求的那一串。
pub fn detect(issuer: &str, domain: &str) -> Option<Realm> {
    let iss = issuer.trim().to_ascii_lowercase();
    if let Some(realm) = match_markers(&iss) {
        return Some(realm);
    }
    let dom = domain.trim().to_ascii_lowercase();
    match_markers(&dom)
}

fn match_markers(text: &str) -> Option<Realm> {
    if text.is_empty() {
        return None;
    }
    // 国内先判：`workbuddy.cn` 与 `workbuddy.ai` 只差顶级域，靠 `contains` 不会互吃，
    // 但把国内放前面能让 `copilot.tencent.com` 这种最老的形态优先命中。
    if CODEBUDDY_MARKERS.iter().any(|marker| text.contains(marker)) {
        return Some(Realm::Codebuddy);
    }
    if WORKBUDDY_MARKERS.iter().any(|marker| text.contains(marker)) {
        return Some(Realm::Workbuddy);
    }
    None
}

/// 账号文件里的 `domain` 对齐到区域：写着另一个区域的域名时换成该区域的规范值。
///
/// 理由：区域既然以 token 为准，就不能让一个过期域名再把 `X-Domain` 带回另一边的出口。
/// 域名本身看不出区域时原样保留（用户可能有自己的租户域）。
#[allow(dead_code)] // 由 Account::effective_domain 调用，S2 接
pub fn align_domain(realm: Realm, domain: &str) -> String {
    let dom = domain.trim();
    if dom.is_empty() {
        return realm.config().domain.to_string();
    }
    let lowered = dom.to_ascii_lowercase();
    if realm
        .other()
        .markers()
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return realm.config().domain.to_string();
    }
    dom.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 两个区域的常量是闭合的() {
        for realm in Realm::ALL {
            let cfg = realm.config();
            assert!(cfg.chat_upstream.starts_with("https://"));
            assert!(cfg.billing_upstream.starts_with("https://"));
            assert!(cfg.origin.starts_with("https://"));
            // X-Domain 不带协议头
            assert!(!cfg.domain.contains("://"));
            assert!(cfg.chat_ua.starts_with("WorkBuddy/"));
        }
    }

    #[test]
    fn 国内版的三个域不是同一个() {
        let cfg = Realm::Codebuddy.config();
        // 这三条是原项目反复踩过的坑，钉死在这里
        assert_eq!(cfg.chat_upstream, "https://copilot.tencent.com");
        assert_eq!(cfg.billing_upstream, "https://www.codebuddy.cn");
        assert_eq!(cfg.origin, "https://www.codebuddy.cn");
        assert_eq!(cfg.domain, "copilot.tencent.com");
    }

    #[test]
    fn 国际版的对话与记账同域() {
        let cfg = Realm::Workbuddy.config();
        assert_eq!(cfg.chat_upstream, cfg.billing_upstream);
        assert_eq!(cfg.domain, "www.workbuddy.ai");
    }

    #[test]
    fn 字符串解析认历史写法() {
        assert_eq!(Realm::parse("workbuddy"), Some(Realm::Workbuddy));
        assert_eq!(Realm::parse("intl"), Some(Realm::Workbuddy));
        assert_eq!(Realm::parse("codebuddy"), Some(Realm::Codebuddy));
        assert_eq!(Realm::parse("CN"), Some(Realm::Codebuddy));
        assert_eq!(Realm::parse(""), None);
        assert_eq!(Realm::parse("不存在的区域"), None);
    }

    #[test]
    fn issuer_优先于域名() {
        // token 说国内、域名写着国际：以 token 为准
        assert_eq!(
            detect("https://www.codebuddy.cn/oauth", "www.workbuddy.ai"),
            Some(Realm::Codebuddy)
        );
        assert_eq!(
            detect("https://www.workbuddy.ai/oauth", "copilot.tencent.com"),
            Some(Realm::Workbuddy)
        );
    }

    #[test]
    fn 国内三个历史域名都认得() {
        for marker in CODEBUDDY_MARKERS {
            assert_eq!(detect("", marker), Some(Realm::Codebuddy), "{marker}");
            assert_eq!(
                detect(&format!("https://{marker}/x"), ""),
                Some(Realm::Codebuddy),
                "{marker}"
            );
        }
    }

    #[test]
    fn workbuddy_cn_不会被当成国际版() {
        // 这条是原项目明确记录过的坑
        assert_eq!(detect("", "www.workbuddy.cn"), Some(Realm::Codebuddy));
        assert_eq!(detect("", "www.workbuddy.ai"), Some(Realm::Workbuddy));
    }

    #[test]
    fn 看不出区域时不猜() {
        assert_eq!(detect("", ""), None);
        assert_eq!(detect("https://example.com", "example.com"), None);
    }

    #[test]
    fn 跨区域域名会被对齐回来() {
        assert_eq!(
            align_domain(Realm::Codebuddy, "www.workbuddy.ai"),
            "copilot.tencent.com"
        );
        assert_eq!(
            align_domain(Realm::Workbuddy, "www.codebuddy.cn"),
            "www.workbuddy.ai"
        );
        // 同区域原样保留
        assert_eq!(
            align_domain(Realm::Workbuddy, "www.workbuddy.ai"),
            "www.workbuddy.ai"
        );
        // 看不出区域的自定义域也原样保留
        assert_eq!(
            align_domain(Realm::Workbuddy, "tenant.example.com"),
            "tenant.example.com"
        );
        // 空值回落到规范域
        assert_eq!(align_domain(Realm::Codebuddy, "  "), "copilot.tencent.com");
    }
}
