//! 积分：把上游那一坨资源包算成「还剩多少、什么时候过期」。
//!
//! 上游给的是**逐包列表**，不是余额。这里面有几个必须做对的判断：
//!
//! - 剩余量有三对字段（周期 / 非周期、精确 / 整数），要按优先顺序取，缺一个就用另一个推；
//! - 到期时刻认 `DeductionEndTime`（可抵扣窗口结束），**不是** `CycleEndTime`（周期边界）——
//!   免费包这两个字段能差好几年，只认周期边界会让账号每到月底被误判成"快过期"；
//! - 到期超过 730 天算"永不过期"（上游拿它表示无期限）；
//! - 企业号根本没有资源包列表，额度在另一个接口上，要拿「额度 − 已用」自己算。
//!
//! 纯逻辑：吃 JSON、吐结构体，不碰网络。

use serde::Serialize;
use serde_json::Value;

/// 超过这个天数就算"永不过期"。上游用它表示无期限的包。
pub const EXPIRY_SENTINEL_DAYS: f64 = 730.0;

/// 一个资源包。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub code: String,
    pub remain: f64,
    pub used: f64,
    pub size: f64,
    /// Unix 秒。`None` 表示上游没给或解析不出来
    pub expires_at: Option<i64>,
    /// 上游明确表示无期限
    pub no_expiry: bool,
    /// 还剩几天。`None` 表示不知道
    pub days_left: Option<f64>,
}

/// 一次余额快照。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    pub remain: f64,
    pub used: f64,
    pub size: f64,
    pub packages: Vec<Package>,
    /// 最早到期的那个包（用于"先花快过期的"提示）
    pub earliest_expiring: Option<Package>,
    /// 企业额度：按周期重置，不是作废
    pub enterprise: bool,
    pub updated_at: i64,
}

#[allow(dead_code)] // empty / remain_percent 由 S8 的界面接入
impl Credits {
    /// 空快照：没查到、或者账号还没被查询过。
    pub fn empty() -> Self {
        Self {
            remain: 0.0,
            used: 0.0,
            size: 0.0,
            packages: Vec::new(),
            earliest_expiring: None,
            enterprise: false,
            updated_at: now_secs(),
        }
    }

    /// 剩余百分比（0–100）。总量为 0 时给 100（"没有可用的东西"不等于"用光了"）。
    pub fn remain_percent(&self) -> f64 {
        if self.size > 0.0 {
            (self.remain / self.size * 100.0).clamp(0.0, 100.0)
        } else {
            100.0
        }
    }
}

/// 解析 `Response.Data.Accounts` 那一层里的包。
///
/// 传进来的是单个包的 JSON 对象（不是数组）—— 外层遍历是调用方的事，
/// 这样这里只负责"一个包怎么读"。
pub fn parse_package(raw: &Value) -> Package {
    let size = number(raw, &[
        "CycleCapacitySizePrecise",
        "CycleCapacitySize",
        "CapacitySizePrecise",
        "CapacitySize",
    ]);
    let mut remain = number(raw, &[
        "CycleCapacityRemainPrecise",
        "CycleCapacityRemain",
        "CapacityRemainPrecise",
        "CapacityRemain",
    ]);
    let mut used = number(raw, &[
        "CycleCapacityUsedPrecise",
        "CycleCapacityUsed",
        "CapacityUsedPrecise",
        "CapacityUsed",
    ]);

    // 三个数里任意两个能凑出第三个。上游偶尔只给两个，缺的那个补出来 ——
    // 不补的话，界面上会出现"总量 100、剩余 0、已用 0"这种自相矛盾的行。
    if size > 0.0 && used <= 0.0 && remain <= size {
        used = (size - remain).max(0.0);
    } else if size > 0.0 && remain <= 0.0 && used < size {
        remain = (size - used).max(0.0);
    }

    let expires_at = expiry_of(raw);
    let (no_expiry, days_left) = match expires_at {
        Some(at) => {
            let seconds = at - now_secs();
            if seconds as f64 > EXPIRY_SENTINEL_DAYS * 86400.0 {
                (true, None)
            } else {
                (false, Some((seconds as f64 / 86400.0 * 10.0).round() / 10.0))
            }
        }
        None => (false, None),
    };

    Package {
        name: text(raw, "PackageName").unwrap_or_else(|| "资源包".to_string()),
        code: text(raw, "PackageCode").unwrap_or_default(),
        remain,
        used,
        size,
        expires_at,
        no_expiry,
        days_left,
    }
}

/// 到期时刻。先看 `DeductionEndTime`（epoch 毫秒），再退回墙钟字符串。
fn expiry_of(raw: &Value) -> Option<i64> {
    // DeductionEndTime 是毫秒时间戳，且是"这个包什么时候不能再花"的真答案
    if let Some(value) = raw.get("DeductionEndTime").and_then(Value::as_i64) {
        if value > 0 {
            return Some(if value > 100_000_000_000 {
                value / 1000
            } else {
                value
            });
        }
    }
    for key in ["ExpiredTime", "PackageEndTime", "CycleEndTime"] {
        if let Some(text) = raw.get(key).and_then(Value::as_str) {
            if let Some(at) = parse_wall_clock(text) {
                return Some(at);
            }
        }
    }
    None
}

/// 把一批包汇总成快照。
pub fn aggregate(packages: Vec<Package>) -> Credits {
    let remain = round2(packages.iter().map(|item| item.remain).sum());
    let used = round2(packages.iter().map(|item| item.used).sum());
    let size = round2(packages.iter().map(|item| item.size).sum());

    // 最早到期：只用"还有余额、没作废、知道剩几天"的包
    let earliest = packages
        .iter()
        .filter(|item| item.remain > 0.0 && !item.no_expiry)
        .filter_map(|item| item.days_left.map(|days| (days, item)))
        .filter(|(days, _)| *days >= 0.0)
        .min_by(|left, right| left.0.total_cmp(&right.0))
        .map(|(_, item)| item.clone());

    Credits {
        remain,
        used,
        size,
        packages,
        earliest_expiring: earliest,
        enterprise: false,
        updated_at: now_secs(),
    }
}

/// 企业额度：上游只给「本周期已用」与「周期额度」，没有包列表。
///
/// `credit` 是**已用**（与个人口径的"剩余"正好相反），剩余 = 额度 − 已用。
/// 额度为 0 时不要算出负余额。
pub fn enterprise(credit: f64, limit: f64, cycle_end: &str) -> Credits {
    let size = round2(limit.max(0.0));
    let used = round2(credit.max(0.0));
    let remain = if size > 0.0 {
        round2((size - used).max(0.0))
    } else {
        0.0
    };

    let package = Package {
        name: if size > 0.0 { "企业额度" } else { "企业周期额度" }.to_string(),
        code: "enterprise".to_string(),
        remain,
        used,
        size,
        expires_at: parse_wall_clock(cycle_end),
        // 企业额度是周期重置（回满），不是到期作废：算成"快过期"会让企业号
        // 永远落在临期窗口里
        no_expiry: true,
        days_left: None,
    };

    Credits {
        remain,
        used,
        size,
        packages: if size > 0.0 { vec![package] } else { Vec::new() },
        earliest_expiring: None,
        enterprise: true,
        updated_at: now_secs(),
    }
}

// ---------- 小工具 ----------

fn number(raw: &Value, keys: &[&str]) -> f64 {
    for key in keys {
        match raw.get(*key) {
            Some(Value::Number(value)) => {
                if let Some(float) = value.as_f64() {
                    return float;
                }
            }
            Some(Value::String(text)) => {
                if let Ok(float) = text.trim().parse::<f64>() {
                    return float;
                }
            }
            _ => {}
        }
    }
    0.0
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// 解析上游的墙钟时间 `YYYY-MM-DD HH:MM:SS`，按 **UTC+8** 折算成 Unix 秒。
///
/// 不用本地时区：这些时间是上游按北京时间下发的，机器设在别的时区就会算错。
/// 也不用外部 crate —— 一段 civil-date 换算就够了，而且比引依赖更容易验。
pub fn parse_wall_clock(text: &str) -> Option<i64> {
    let cleaned = text.trim().replace('T', " ");
    let main = cleaned.get(..19)?;
    let mut parts = main.split(' ');
    let date = parts.next()?;
    let clock = parts.next()?;

    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;

    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let second: i64 = clock_parts.next()?.parse().ok()?;

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=60).contains(&second) {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let local = days * 86400 + hour * 3600 + minute * 60 + second;
    Some(local - 8 * 3600)
}

/// 公历日期 → 距 1970-01-01 的天数（Howard Hinnant 的算法，对负数年份也成立）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 墙钟时间按北京时间折算() {
        // 1970-01-01 08:00:00 (UTC+8) 就是 Unix 纪元
        assert_eq!(parse_wall_clock("1970-01-01 08:00:00"), Some(0));
        assert_eq!(parse_wall_clock("1970-01-01T08:00:00"), Some(0));
        assert_eq!(parse_wall_clock("1970-01-01 00:00:00"), Some(-8 * 3600));
        // 2026-10-26 23:59:59 +08:00（金标值由 Python 的 calendar.timegm 算出）
        assert_eq!(parse_wall_clock("2026-10-26 23:59:59"), Some(1793030399));
    }

    #[test]
    fn 墙钟时间认不出时返回_none() {
        assert_eq!(parse_wall_clock(""), None);
        assert_eq!(parse_wall_clock("2026-13-01 00:00:00"), None);
        assert_eq!(parse_wall_clock("2026-10-26 25:00:00"), None);
        assert_eq!(parse_wall_clock("不是时间"), None);
    }

    #[test]
    fn 三个容量字段缺一个就补出来() {
        // 只给总量与剩余：已用推出来
        let package = parse_package(&serde_json::json!({
            "PackageName": "首登赠送",
            "CapacitySize": 1500,
            "CapacityRemain": 1200
        }));
        assert_eq!(package.size, 1500.0);
        assert_eq!(package.remain, 1200.0);
        assert_eq!(package.used, 300.0);

        // 只给总量与已用：剩余推出来
        let package = parse_package(&serde_json::json!({
            "CapacitySize": 500,
            "CapacityUsed": 120
        }));
        assert_eq!(package.remain, 380.0);
    }

    #[test]
    fn 周期字段优先于非周期字段() {
        let package = parse_package(&serde_json::json!({
            "CapacitySize": 100,
            "CapacityRemain": 100,
            "CycleCapacitySize": 900,
            "CycleCapacityRemain": 800
        }));
        assert_eq!(package.size, 900.0);
        assert_eq!(package.remain, 800.0);
    }

    #[test]
    fn 到期认抵扣截止时间而不是周期边界() {
        // 周期边界在一年后，抵扣截止在一天后 —— 必须取后者
        let package = parse_package(&serde_json::json!({
            "CapacitySize": 100,
            "CapacityRemain": 100,
            "CycleEndTime": "2030-01-01 00:00:00",
            "DeductionEndTime": 1_760_000_000_000i64
        }));
        assert_eq!(package.expires_at, Some(1_760_000_000));
    }

    #[test]
    fn 超过七百三十天算永不过期() {
        let package = parse_package(&serde_json::json!({
            "CapacitySize": 100,
            "CapacityRemain": 100,
            "CycleEndTime": "2126-01-01 00:00:00"
        }));
        assert!(package.no_expiry);
        assert!(package.days_left.is_none());
    }

    #[test]
    fn 汇总与最早到期() {
        let soon = parse_package(&serde_json::json!({
            "PackageName": "快过期",
            "CapacitySize": 100,
            "CapacityRemain": 40,
            "DeductionEndTime": ((now_secs() + 2 * 86400) * 1000)
        }));
        let later = parse_package(&serde_json::json!({
            "PackageName": "还早",
            "CapacitySize": 200,
            "CapacityRemain": 200,
            "DeductionEndTime": ((now_secs() + 30 * 86400) * 1000)
        }));
        let credits = aggregate(vec![soon, later]);
        assert_eq!(credits.size, 300.0);
        assert_eq!(credits.remain, 240.0);
        assert_eq!(credits.used, 60.0);
        assert_eq!(
            credits.earliest_expiring.as_ref().map(|item| item.name.as_str()),
            Some("快过期")
        );
        assert_eq!(credits.remain_percent(), 80.0);
    }

    #[test]
    fn 已用光的包不参与最早到期() {
        let empty = parse_package(&serde_json::json!({
            "PackageName": "空的",
            "CapacitySize": 100,
            "CapacityRemain": 0,
            "DeductionEndTime": ((now_secs() + 86400) * 1000)
        }));
        let credits = aggregate(vec![empty]);
        assert!(credits.earliest_expiring.is_none());
    }

    #[test]
    fn 企业额度是额度减已用() {
        let credits = enterprise(812.45, 2000.0, "2026-10-26 23:59:59");
        assert!(credits.enterprise);
        assert_eq!(credits.size, 2000.0);
        assert_eq!(credits.used, 812.45);
        assert_eq!(credits.remain, 1187.55);
        assert_eq!(credits.packages.len(), 1);
        // 周期重置不是作废：不进临期提醒
        assert!(credits.earliest_expiring.is_none());
        assert!(credits.packages[0].no_expiry);
    }

    #[test]
    fn 企业额度为零时不算出负剩余() {
        let credits = enterprise(300.0, 0.0, "");
        assert_eq!(credits.remain, 0.0);
        assert_eq!(credits.size, 0.0);
        assert!(credits.packages.is_empty());
    }

    #[test]
    fn 空快照的百分比是满的() {
        let credits = Credits::empty();
        assert_eq!(credits.remain_percent(), 100.0);
        assert_eq!(credits.remain, 0.0);
    }
}
