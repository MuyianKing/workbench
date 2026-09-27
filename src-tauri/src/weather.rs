//! 顶栏问候语旁的实时天气。
//!
//! **联网边界（重要）**：这是又一个「由用户显式开启」的出口 —— 只有设置里的城市
//! （`weatherCity`）填了内容才会发请求，留空即关闭；渲染层到间隔才触发（约半小时一次）。
//! 白名单是下面两个主机名、各管一段（都免费、不需要凭据）：
//! 城市名 → 经纬度走 **OpenStreetMap 的 Nominatim**（`nominatim.openstreetmap.org`，
//! 它对中文城市名的匹配比 Open-Meteo 自带的检索可靠 —— 实测「常州」只有它能搜到），
//! 经纬度 → 实况走 **Open-Meteo**（`api.open-meteo.com` 的 `/v1/forecast`）。
//! **城市名会作为查询串出现在 geocoding 请求里** —— 这是这条出口唯一发出去的用户内容，
//! 设置界面与架构文档里都照实写了。
//!
//! **职责分工与 AI 热点一致**：这一层只取原始文本（JSON 不解析、天气码不认），
//! 解析、WMO 码表与显示口径全在 TS 侧（`src/shared/weather.ts`，有单测、改起来走热更新）。

use serde::Serialize;

use crate::http;

/// 城市名检索（geocoding）的白名单主机：OpenStreetMap 的公开 Nominatim 实例
const GEOCODING_HOST: &str = "nominatim.openstreetmap.org";
/// 实况（forecast）的白名单主机：Open-Meteo
const FORECAST_HOST: &str = "api.open-meteo.com";

/// 一次取回的结果：状态码 + 原始文本，交给 TS 侧判断与解析。
#[derive(Serialize, Debug)]
pub struct WeatherFetchResult {
    /// 200 = 有数据；404 = geocoding 没找到这个城市；其余是服务端错误
    pub status: u16,
    /// 原文（JSON）
    pub body: String,
}

/// 城市名 → 经纬度。城市名经百分号编码进查询串（中文城市名在这条路上是常态）。
#[tauri::command(async)]
pub fn weather_geocode(city: String) -> Result<WeatherFetchResult, String> {
    let name = city.trim();
    if name.is_empty() {
        return Err("城市名是空的，不去问天气".into());
    }
    let response = http::request(
        "GET",
        GEOCODING_HOST,
        &geocode_path(name),
        &[("User-Agent", "Workbench")],
        None,
    )?;
    Ok(WeatherFetchResult {
        status: response.status,
        body: response.text(),
    })
}

/// geocoding 的请求路径：Nominatim 的 `/search`，只取第一条结果。
/// 要经纬度就够了，不带语言参数 —— 地名怎么显示不影响坐标本身。
fn geocode_path(city: &str) -> String {
    format!("/search?q={}&format=json&limit=1", percent_encode(city))
}

/// 经纬度 → 当前天气。经纬度来自上一步 geocoding 的回包，越界值在发请求之前就拒掉。
#[tauri::command(async)]
pub fn weather_forecast(latitude: f64, longitude: f64) -> Result<WeatherFetchResult, String> {
    let path = forecast_path(latitude, longitude)?;
    let response = http::request("GET", FORECAST_HOST, &path, &[("User-Agent", "Workbench")], None)?;
    Ok(WeatherFetchResult {
        status: response.status,
        body: response.text(),
    })
}

/// forecast 的请求路径。经纬度必须是有限的数、且落在各自的区间里 ——
/// 数值进地址之前把住这道门：渲染层就算递来 NaN / 无穷大，也拼不出一个意外的地址。
fn forecast_path(latitude: f64, longitude: f64) -> Result<String, String> {
    let in_range = |value: f64, bound: f64| value.is_finite() && value.abs() <= bound;
    if !in_range(latitude, 90.0) || !in_range(longitude, 180.0) {
        return Err(format!("经纬度越界，不去问天气：{latitude}, {longitude}"));
    }
    Ok(format!(
        "/v1/forecast?latitude={latitude}&longitude={longitude}&current=temperature_2m,weather_code&forecast_days=1&timezone=auto"
    ))
}

/// 查询串值的百分号编码（RFC 3986 的 unreserved 字符原样放行，其余按 UTF-8 逐字节编）。
///
/// 不用 `form_urlencoded`：它把空格编成 `+`，靠服务端肯不肯把 `+` 当空格 ——
/// 自己编成 `%20` 就没有这份解释权的问题。
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            rest => out.push_str(&format!("%{rest:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中文城市名按 UTF-8 编码、空格编成 %20，ASCII 原样放行
    #[test]
    fn percent_encodes_query_values() {
        assert_eq!(percent_encode("上海"), "%E4%B8%8A%E6%B5%B7");
        assert_eq!(percent_encode("New York"), "New%20York");
        assert_eq!(percent_encode("Berlin"), "Berlin");
        // 保留字符也不放行：& 会被当成参数分隔符，必须编掉
        assert_eq!(percent_encode("a&b=c"), "a%26b%3Dc");
    }

    /// 经纬度越界 / 非有限数一律拒绝，且拒绝发生在拼地址这一步（不会再往下发请求）
    #[test]
    fn forecast_rejects_out_of_range_coordinates() {
        assert!(forecast_path(39.9, 116.4).is_ok());
        assert!(forecast_path(91.0, 0.0).is_err());
        assert!(forecast_path(-91.0, 0.0).is_err());
        assert!(forecast_path(0.0, 181.0).is_err());
        assert!(forecast_path(f64::NAN, 0.0).is_err());
        assert!(forecast_path(f64::INFINITY, 0.0).is_err());
    }

    /// forecast 的路径带上了经纬度与要的字段（温度 + 天气码）
    #[test]
    fn forecast_path_carries_coordinates() {
        let path = forecast_path(39.9, 116.4).unwrap();
        assert!(path.starts_with("/v1/forecast?"));
        assert!(path.contains("latitude=39.9"));
        assert!(path.contains("longitude=116.4"));
        assert!(path.contains("current=temperature_2m,weather_code"));
    }

    /// 城市名空白直接报错，不会发请求
    #[test]
    fn geocode_rejects_blank_city() {
        let result = weather_geocode("   ".into());
        assert!(result.is_err());
    }

    /// geocoding 的路径带上了编码过的城市名（Nominatim 的 /search，取第一条）
    #[test]
    fn geocode_path_carries_the_city() {
        let path = geocode_path("上海");
        assert!(path.starts_with("/search?q="));
        assert!(path.contains("%E4%B8%8A%E6%B5%B7"));
        assert!(path.ends_with("format=json&limit=1"));
    }
}
