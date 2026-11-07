//! Qoder 积分 / 套餐 / 额度：查询与归一。
//!
//! 上游 `quota/usage` 的额度是「多桶」结构：套餐内、资源包、SOTA / 专属积分、
//! 组织共享池。这里把任意形态归一成一组 [`CreditPackage`]，再给出合计 ——
//! **上游没给的字段留空 / 0，不拿估算值冒充事实**。
//!
//! 账号接口只需要 Bearer + 官方客户端 UA；推理才需要 COSY 签名。

use serde::{Deserialize, Serialize};

use crate::http;
use crate::common::{excerpt, now_secs};
use crate::qd_account::Account;
use crate::qd_upstream;

/// 一个额度包（界面按它渲染余额条与到期明细）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditPackage {
    pub name: String,
    /// `plan` / `pack` / `sota` / `shared`
    pub kind: String,
    pub remain: f64,
    pub size: f64,
    pub used: f64,
    /// Unix 秒；`None` = 无期限 / 上游没给
    pub expires_at: Option<i64>,
    pub available: bool,
}

/// 一个账号的积分快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    pub packages: Vec<CreditPackage>,
    pub remain: f64,
    pub size: f64,
    pub used: f64,
    pub plan: String,
    /// 团队 / 企业号（有组织共享池）
    pub team: bool,
    /// 共享池剩余（含在 `remain` 里）
    pub shared_remain: f64,
    pub shared_unlimited: bool,
    pub fetched_at: i64,
    pub error: String,
}

impl Credits {
    /// 最近一笔「还花得出去、明确会作废」的到期时刻。
    pub fn soonest_expiry(&self, now: i64) -> Option<i64> {
        self.packages
            .iter()
            .filter(|package| package.available && package.remain > 0.0)
            .filter_map(|package| package.expires_at)
            .filter(|at| *at > now)
            .min()
    }
}

/// 账号接口的统一请求头（签到 / 额度 / 活动共用）。
pub fn account_headers(account: &Account) -> Vec<(&'static str, String)> {
    vec![
        ("Accept", "application/json".into()),
        ("User-Agent", "Qoder".into()),
        ("Authorization", format!("Bearer {}", account.access_token)),
        ("Cosy-ClientType", "10".into()),
        ("Cosy-Version", qd_upstream::COSY_VERSION.into()),
    ]
}

fn call(
    account: &Account,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let url = qd_upstream::openapi(path);
    let headers = account_headers(account);
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let response = http::request_url_limited(method, &url, &refs, body, 4 * 1024 * 1024)?;
    let _ = timeout_secs;
    let text = response.text();
    if response.status != 200 {
        return Err(format!("HTTP {} {}", response.status, excerpt(&text, 160)));
    }
    serde_json::from_str(&text).map_err(|err| format!("响应不是 JSON：{err}"))
}

/// 查一个账号的积分与套餐。`plan` 查询失败不影响额度结果。
pub fn fetch(account: &Account) -> Credits {
    let mut credits = Credits {
        fetched_at: now_secs(),
        ..Credits::default()
    };
    let quota = match call(account, "GET", qd_upstream::PATH_QUOTA, None, 15) {
        Ok(value) => value,
        Err(message) => {
            credits.error = message;
            return credits;
        }
    };
    let payload = quota.get("data").cloned().unwrap_or(quota);
    normalize_quota(&payload, &mut credits);
    if credits.plan.is_empty() {
        if let Ok(plan) = call(account, "GET", qd_upstream::PATH_PLAN, None, 10) {
            credits.plan = plan
                .get("data")
                .unwrap_or(&plan)
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
        }
    }
    credits
}

/// 额度归一：按字段名猜桶（与参考实现的 `_QUOTA_BUCKETS` 同序）。
pub fn normalize_quota(payload: &serde_json::Value, credits: &mut Credits) {
    let Some(object) = payload.as_object() else {
        return;
    };
    for (key, value) in object {
        let lower = key.to_ascii_lowercase();
        let (kind, default_name) = if matches!(
            lower.as_str(),
            "userquota" | "planquota" | "subscriptionquota" | "basequota" | "plan"
        ) {
            ("plan", "套餐内 Credits")
        } else if lower.contains("sota") || lower.contains("exclusive") {
            ("sota", "SOTA 专属积分")
        } else if matches!(
            lower.as_str(),
            "addonquota"
                | "resourcepackage"
                | "resourcepackages"
                | "addon"
                | "package"
                | "packages"
                | "bonus"
                | "dedicatedresourcepackages"
                | "dedicatedresourcepackage"
                | "sotapackages"
        ) {
            ("pack", "资源包")
        } else if matches!(
            lower.as_str(),
            "orgresourcepackage" | "sharedquota" | "teamquota" | "poolquota" | "sharedcredits"
        ) {
            ("shared", "共享额度池")
        } else {
            continue;
        };
        if let Some(list) = value.as_array() {
            for item in list {
                if let Some(package) = package_of(item, kind, default_name) {
                    push_package(credits, package);
                }
            }
        } else if let Some(package) = package_of(value, kind, default_name) {
            push_package(credits, package);
        }
    }
    credits.remain = credits.packages.iter().filter(|package| package.available).map(|package| package.remain).sum();
    credits.size = credits.packages.iter().filter(|package| package.available).map(|package| package.size).sum();
    credits.used = (credits.size - credits.remain).max(0.0);
    credits.shared_remain = credits
        .packages
        .iter()
        .filter(|package| package.kind == "shared" && package.available)
        .map(|package| package.remain)
        .sum();
    credits.team = credits.packages.iter().any(|package| package.kind == "shared");
}

fn push_package(credits: &mut Credits, package: CreditPackage) {
    if package.kind == "shared" && package.size < 0.0 {
        credits.shared_unlimited = true;
    }
    // 同一类包合并成一个展示项：上游常把一个资源的多个分片拆成数组
    if let Some(existing) = credits
        .packages
        .iter_mut()
        .find(|item| item.kind == package.kind && item.name == package.name && item.expires_at == package.expires_at)
    {
        existing.remain += package.remain;
        existing.size += package.size;
        existing.used += package.used;
        return;
    }
    credits.packages.push(package);
}

fn package_of(value: &serde_json::Value, kind: &str, default_name: &str) -> Option<CreditPackage> {
    if let Some(number) = value.as_f64() {
        return Some(CreditPackage {
            name: default_name.into(),
            kind: kind.into(),
            remain: number,
            size: number,
            used: 0.0,
            expires_at: None,
            available: true,
        });
    }
    let object = value.as_object()?;
    let number = |key: &str| -> Option<f64> {
        object.get(key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
    };
    let remain = number("remaining")
        .or_else(|| number("remain"))
        .or_else(|| number("balance"));
    let used = number("used");
    let size = number("total")
        .or_else(|| number("cap"))
        .or_else(|| number("size"));
    let (remain, size) = match (remain, size, used) {
        (Some(remain), _, Some(used)) => (remain, remain + used),
        (Some(remain), Some(size), _) => (remain, size),
        (None, Some(size), Some(used)) => ((size - used).max(0.0), size),
        (None, Some(size), None) => (0.0, size),
        (Some(remain), None, None) => (remain, remain),
        (None, None, _) => return None,
    };
    let mut name = String::new();
    if let Some(labels) = object.get("displayLabels").and_then(|value| value.as_array()) {
        for label in labels {
            if label.get("dimension").and_then(serde_json::Value::as_str) != Some("title") {
                continue;
            }
            if let Some(i18n) = label.get("valueI18n").and_then(|value| value.as_object()) {
                name = i18n
                    .get("zh-CN")
                    .or_else(|| i18n.get("en-US"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            if name.is_empty() {
                name = label
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            if !name.is_empty() {
                break;
            }
        }
    }
    if name.is_empty() {
        name = object
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(default_name)
            .to_string();
    }
    let expires_at = ["expiresAt", "expireAt", "expires_at", "expiredAt", "validUntil", "dueAt"]
        .iter()
        .find_map(|key| object.get(*key).map(epoch));
    let available = object
        .get("available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    Some(CreditPackage {
        name,
        kind: kind.into(),
        remain,
        size,
        used: used.unwrap_or((size - remain).max(0.0)),
        expires_at,
        available,
    })
}

fn epoch(value: &serde_json::Value) -> i64 {
    let number = value
        .as_i64()
        .or_else(|| value.as_f64().map(|value| value as i64))
        .unwrap_or(0);
    if number > 100_000_000_000 {
        number / 1000
    } else {
        number
    }
}


/// 把「最近到期」写回账号（选号的第一关键字）。
pub fn apply_expiry(account: &mut Account, credits: &Credits) {
    account.credit_expires_at = credits.soonest_expiry(now_secs()).unwrap_or(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 多桶额度能归一成合计() {
        let payload = serde_json::json!({
            "planQuota": { "remaining": 100, "total": 500 },
            "addOnQuota": [
                { "remaining": 200, "total": 200, "expiresAt": 1893456000000i64 },
                { "remaining": 50, "total": 100 }
            ],
            "sota": { "remaining": 30, "used": 10 }
        });
        let mut credits = Credits::default();
        normalize_quota(&payload, &mut credits);
        assert_eq!(credits.remain, 380.0);
        // 套餐 1 + 两个资源包（到期日不同，不合并）+ SOTA 1
        assert_eq!(credits.packages.len(), 4);
        let pack = credits
            .packages
            .iter()
            .find(|package| package.expires_at == Some(1_893_456_000))
            .unwrap_or_else(|| panic!("应解析出到期时刻"));
        assert_eq!(pack.remain, 200.0);
        assert!(!credits.team);
    }

    #[test]
    fn 共享池与不可用包() {
        let payload = serde_json::json!({
            "orgResourcePackage": { "remaining": 900, "total": 1000 },
            "resourcePackages": [
                { "remaining": 10, "total": 10, "available": false }
            ]
        });
        let mut credits = Credits::default();
        normalize_quota(&payload, &mut credits);
        assert!(credits.team);
        assert_eq!(credits.shared_remain, 900.0);
        assert_eq!(credits.remain, 900.0, "不可用的包不计入合计");
    }

    #[test]
    fn 最近到期只挑还有剩余的() {
        let now = 1_700_000_000;
        let credits = Credits {
            packages: vec![
                CreditPackage {
                    name: "a".into(),
                    kind: "pack".into(),
                    remain: 0.0,
                    size: 10.0,
                    used: 10.0,
                    expires_at: Some(now + 100),
                    available: true,
                },
                CreditPackage {
                    name: "b".into(),
                    kind: "pack".into(),
                    remain: 5.0,
                    size: 10.0,
                    used: 5.0,
                    expires_at: Some(now + 500),
                    available: true,
                },
            ],
            ..Credits::default()
        };
        assert_eq!(credits.soonest_expiry(now), Some(now + 500));
    }
}
