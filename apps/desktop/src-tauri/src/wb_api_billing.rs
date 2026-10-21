//! 计费查询：向"记账的那个域"要余额。
//!
//! 注意**出口与对话不是同一个域**：国际版两者都在 `workbuddy.ai`，但国内版对话走
//! `copilot.tencent.com`、记账走 `www.codebuddy.cn`。写成一个的话国内号查余额就是 403。
//!
//! 两条路：
//! - **个人号**：`/v2/billing/meter/get-user-resource`，带 `ProductCode: p_tcaca`，
//!   回一串资源包；
//! - **企业号**：`/v2/billing/meter/get-enterprise-user-usage`，回额度与已用。
//!
//! 企业号在个人接口上永远回空（`code 0` 但 `Accounts` 为 null），所以必须先分流，
//! 否则界面上永远是 0/0 —— 原项目为此长期显示过错误的余额。
//!
//! 纯 I/O 适配：解析交给 [`crate::wb_credits`]。

use crate::http;
use crate::wb_account::Account;
use crate::wb_credits::{self, Credits};
use crate::wb_fingerprint;
use crate::wb_identity;

/// 个人资源包。两个仓库都只查这一个产品码 —— 另一本账（评测/CodeBuddy 侧）
/// 网关看不到，这是已确认的边界，不是遗漏。
const PRODUCT_CODE: &str = "p_tcaca";
const RESOURCE_PATH: &str = "/v2/billing/meter/get-user-resource";
const ENTERPRISE_PATH: &str = "/v2/billing/meter/get-enterprise-user-usage";

/// 查一次余额。
pub fn fetch(account: &Account) -> Result<Credits, String> {
    if is_enterprise(account) {
        // 企业额度在另一个接口上；失败再退到个人接口（有些企业号两边都有）
        match fetch_enterprise(account) {
            Ok(credits) if credits.size > 0.0 => return Ok(credits),
            Ok(_) => {}
            Err(message) => {
                // 企业接口挂了不等于个人接口也挂了，继续往下试
                eprintln!("[workbench] 企业额度查询失败：{message}");
            }
        }
    }

    match fetch_personal(account)? {
        // 个人接口回空但确实是企业号：说明名额在企业空间里，别把 0 当答案交出去
        credits if credits.size <= 0.0 && is_enterprise(account) => {
            fetch_enterprise(account).or(Ok(credits))
        }
        credits => Ok(credits),
    }
}

fn fetch_personal(account: &Account) -> Result<Credits, String> {
    let body = serde_json::json!({
        "PageNumber": 1,
        "PageSize": 100,
        "ProductCode": PRODUCT_CODE,
        "Status": [0, 3],
        "PackageEndTimeRangeBegin": wall_clock_now(),
        "PackageEndTimeRangeEnd": "2036-01-01 00:00:00",
    });

    let value = post(account, RESOURCE_PATH, &body)?;
    // 层级：信封已经解过，这里从 data 往下
    let packages = value
        .get("data")
        .and_then(|data| {
            data.get("Response")
                .and_then(|response| response.get("Data"))
                .or(Some(data))
        })
        .and_then(|payload| payload.get("Accounts"))
        .and_then(serde_json::Value::as_array)
        .map(|list| list.iter().map(wb_credits::parse_package).collect::<Vec<_>>())
        .unwrap_or_default();

    Ok(wb_credits::aggregate(packages))
}

fn fetch_enterprise(account: &Account) -> Result<Credits, String> {
    let value = post(account, ENTERPRISE_PATH, &serde_json::json!({}))?;
    let data = value.get("data").unwrap_or(&value);
    let credit = data
        .get("credit")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let limit = data
        .get("limitNum")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let cycle_end = data
        .get("cycleEndTime")
        .or_else(|| data.get("cycleResetTime"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    Ok(wb_credits::enterprise(credit, limit, cycle_end))
}

/// 发一次 POST 并解信封。`code != 0` 一律当失败 —— 上游的 200 里什么都可能装。
///
/// 公开给任务福利那几条路：签到、新手礼包、活动补偿都走计费域，头与信封口径必须
/// 与余额查询完全一致，不能再抄一份。
pub fn call(
    account: &Account,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    post(account, path, body)
}

fn post(account: &Account, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let url = account.realm.billing_url(path);
    let payload = body.to_string();
    let headers = billing_headers(account);
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();

    let response = http::request_url("POST", &url, &refs, Some(&payload))?;
    let text = response.text();
    if response.status != 200 {
        return Err(format!(
            "查询额度失败：HTTP {} {}",
            response.status,
            excerpt(&text)
        ));
    }

    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|err| format!("额度响应不是 JSON: {err}"))?;
    if let Some(code) = value.get("code").and_then(serde_json::Value::as_i64) {
        if code != 0 {
            let message = value
                .get("msg")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("上游未说明原因");
            return Err(format!("查询额度被拒：code={code} {message}"));
        }
    }
    Ok(value)
}

/// 计费头（对外只读一份）。任务福利里的签到 / 礼包 / 补偿都用它，
/// 别在别处再拼一套 —— 国内版的三个域与 `X-*` 系列很容易漏一个。
pub fn headers(account: &Account) -> Vec<(String, String)> {
    billing_headers(account)
}

/// 计费头。与聊天头是**两套**：这里没有会话 id 家族，但有机器码与会话标识
/// （官方客户端在计费路径上确实带它们，聊天路径反而不带）。
fn billing_headers(account: &Account) -> Vec<(String, String)> {
    let cfg = account.realm.config();
    let uid = if account.uid.trim().is_empty() {
        "anonymous"
    } else {
        account.uid.as_str()
    };
    let mut headers: Vec<(String, String)> = vec![
        ("Content-Type".into(), "application/json".into()),
        ("Accept".into(), "application/json, text/plain, */*".into()),
        ("X-Requested-With".into(), "XMLHttpRequest".into()),
        ("User-Agent".into(), cfg.billing_ua.into()),
        ("Origin".into(), cfg.origin.into()),
        ("Referer".into(), format!("{}/", cfg.origin)),
        ("Authorization".into(), format!("Bearer {}", account.access_token)),
        ("X-User-Id".into(), uid.into()),
        ("X-Domain".into(), account.effective_domain()),
        ("X-CodeBuddy-Request".into(), "1".into()),
        ("Accept-Language".into(), cfg.accept_language.into()),
        ("X-Request-ID".into(), wb_identity::request_id_hex()),
        (
            "X-Machine-ID".into(),
            wb_fingerprint::machine_id(account.uid.as_str()),
        ),
        (
            "X-Session-ID".into(),
            wb_fingerprint::session_id(account.uid.as_str()),
        ),
    ];

    if !account.enterprise_id.trim().is_empty() {
        headers.push(("X-Enterprise-Id".into(), account.enterprise_id.clone()));
        headers.push(("X-Tenant-Id".into(), account.enterprise_id.clone()));
    } else {
        // 官方用 X-No-* 表达"这个头确实没有"，缺头不是同一个意思
        headers.push(("X-No-Enterprise-Id".into(), "1".into()));
    }
    if account.realm == crate::wb_realm::Realm::Codebuddy {
        headers.push(("X-Product".into(), "SaaS".into()));
    }
    headers
}

/// 企业号判定：账号文件里记了，或者 token 里带。
pub fn is_enterprise(account: &Account) -> bool {
    if !account.enterprise_id.trim().is_empty() {
        return true;
    }
    crate::wb_jwt::claims(&account.access_token)
        .map(|claims| !claims.enterprise_id.trim().is_empty())
        .unwrap_or(false)
}

/// 上游要的墙钟时间，按 **北京时间** 给。
fn wall_clock_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    format_wall_clock(now)
}

/// Unix 秒 → `YYYY-MM-DD HH:MM:SS`（UTC+8）。
pub fn format_wall_clock(unix: i64) -> String {
    let local = unix + 8 * 3600;
    let days = local.div_euclid(86400);
    let seconds = local.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// 距 1970-01-01 的天数 → 公历日期（Hinnant 算法，与 `days_from_civil` 互逆）。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 160 {
        return trimmed.to_string();
    }
    trimmed.chars().take(160).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wb_realm::Realm;

    fn account(realm: Realm) -> Account {
        Account {
            uid: "u-1".into(),
            nickname: String::new(),
            domain: String::new(),
            realm,
            product: crate::wb_identity::Identity::Workbuddy,
            enterprise_id: String::new(),
            access_token: "tok".into(),
            refresh_token: String::new(),
            expires_at: 0,
            added_at: 0,
            source: "oauth".into(),
            enabled: true,
            weight: 1,
            note: String::new(),
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        }
    }

    #[test]
    fn 墙钟时间往返一致() {
        // 2026-10-26 23:59:59 +08:00
        assert_eq!(format_wall_clock(1793030399), "2026-10-26 23:59:59");
        assert_eq!(format_wall_clock(0), "1970-01-01 08:00:00");
        // 与解析函数互为逆运算
        let text = "2020-02-29 12:34:56";
        let unix = wb_credits::parse_wall_clock(text).unwrap();
        assert_eq!(format_wall_clock(unix), text);
    }

    #[test]
    fn 计费头带机器码与域名() {
        let headers = billing_headers(&account(Realm::Codebuddy));
        let find = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert!(find("X-Machine-ID").is_some());
        assert!(find("X-Session-ID").is_some());
        // 国内版 X-Domain 是 copilot，不是记账域的 codebuddy.cn
        assert_eq!(find("X-Domain"), Some("copilot.tencent.com"));
        assert_eq!(find("Origin"), Some("https://www.codebuddy.cn"));
        assert_eq!(find("X-No-Enterprise-Id"), Some("1"));
        assert_eq!(find("X-Product"), Some("SaaS"));

        // 国际版不发 X-Product
        let intl = billing_headers(&account(Realm::Workbuddy));
        assert!(!intl.iter().any(|(key, _)| key == "X-Product"));
    }

    /// 真打上游：拿本机已登录的账号查一次余额。
    ///
    /// 跑法：`cargo test wb_api_billing -- --ignored --nocapture`
    /// 只打印数字，不打印任何 token。
    #[test]
    #[ignore = "真打上游，需要本机已登录且在网"]
    fn 真查一次余额() {
        let accounts = crate::wb_account::load_all(&crate::paths::gateway_accounts_dir());
        assert!(!accounts.is_empty(), "本机还没有账号，先在网关页登录一个");
        for account in &accounts {
            match fetch(account) {
                Ok(credits) => println!(
                    "{} · {} · 剩余 {} / 总 {} · {} 个包 · 企业={}",
                    account.label(),
                    account.realm.as_str(),
                    credits.remain,
                    credits.size,
                    credits.packages.len(),
                    credits.enterprise
                ),
                Err(message) => panic!("{} 查询失败：{message}", account.label()),
            }
        }
    }

    #[test]
    fn 企业号判定看账号或_token() {
        let mut personal = account(Realm::Workbuddy);
        assert!(!is_enterprise(&personal));

        personal.enterprise_id = "ent-1".into();
        assert!(is_enterprise(&personal));
    }
}
