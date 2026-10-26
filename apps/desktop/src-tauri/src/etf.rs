//! ETF 资金流（导航「ETF」页）：份额 / 净值三个只读源的拉取与本地缓存。
//!
//! **联网边界（重要）**：这个出口**只在用户打开 ETF 页（或点页面上的刷新）时才走**，
//! 三个主机全部钉死在下面的常量里 —— 都是公开的只读行情 / 信息披露接口，
//! **不需要凭据、不发任何用户内容**（请求串里只有日期、基金代码与页码）：
//! 沪市份额 **上交所**（query.sse.com.cn，单日一份）、深市份额 **深交所**（www.szse.cn，
//! 按基金代码过滤、区间批量、分页）、单位净值 **天天基金**（fund.eastmoney.com，每只基金一份全历史脚本）。
//! 渲染层拼不出地址：参数进地址前逐个校验形状（8 位日期、6 位基金代码、页码区间）。
//!
//! **职责分工与天气 / AI 热点一致**：这一层只取原始文本（JSON / 脚本不解析），
//! 解析、合并、净买卖计算全在 TS 侧（`packages/etf/src/etf.ts`，有单测、改起来走热更新）；
//! 缓存经 JsonStore 落在数据目录的 `etf.json`（只在本机，不进同步仓库）。

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

use crate::http;
use crate::paths;
use crate::store::JsonStore;

/// 沪市每日份额：上交所 commonQuery（STAT_DATE 单日一份，全市场 ETF 一张表）
const SSE_HOST: &str = "query.sse.com.cn";
/// 深市每日规模：深交所 ShowReport（区间 ≤ 6 个月，PAGENO 翻页）
const SZSE_HOST: &str = "www.szse.cn";
/// 基金单位净值：天天基金 pingzhongdata 脚本（每只一份全历史，含 Data_netWorthTrend）。
/// 路径**没有 `/js/` 段**（`/pingzhongdata/js/{code}.js` 那条老写法已 301 到 notfound，2026-10 实测）
const NAV_HOST: &str = "fund.eastmoney.com";

/// 交易所的接口要浏览器样子的请求头（Referer 缺了会被当作来路不明拒掉）
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// `etf.json` 的去抖存储：份额 / 净值缓存的唯一落点，与 AI 热点同一待遇（只在本机）
static ETF: OnceLock<JsonStore> = OnceLock::new();

pub fn etf_store() -> &'static JsonStore {
    ETF.get_or_init(|| JsonStore::new(paths::etf_file, "保存 ETF 资金流缓存"))
}

// ---------- 数据文件 ----------

#[tauri::command]
pub fn etf_load() -> Value {
    etf_store().get()
}

#[tauri::command]
pub fn etf_save(value: Value) {
    etf_store().set(value);
    etf_store().schedule();
}

// ---------- 拉取 ----------

/// 一次取回的结果：状态码 + 原始文本，判断与解析都在 TS 侧。
#[derive(Serialize, Debug)]
pub struct EtfFetchResult {
    /// 200 = 有数据；其余（403 风控 / 5xx）交给 TS 侧按失败处理
    pub status: u16,
    /// 原文（JSON 或脚本）
    pub body: String,
}

/// 四个拉取命令共用的那一趟：GET + 浏览器样子的 UA 与 Referer。
fn fetch(host: &str, path: &str, referer: &str) -> Result<EtfFetchResult, String> {
    let response = http::request(
        "GET",
        host,
        path,
        &[("User-Agent", BROWSER_UA), ("Referer", referer)],
        None,
    )?;
    Ok(EtfFetchResult {
        status: response.status,
        body: response.text(),
    })
}

/// 8 位数字日期（YYYYMMDD）→ 接口要的 `YYYY-MM-DD`；形状不对在拼地址之前就挡下。
fn dashed_date(value: &str, label: &str) -> Result<String, String> {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{label}得是 8 位数字日期（YYYYMMDD）：{value}"));
    }
    Ok(format!("{}-{}-{}", &value[0..4], &value[4..6], &value[6..8]))
}

/// 沪市某一个交易日的全市场 ETF 份额（日期由 TS 侧按回填计划逐日给）。
#[tauri::command(async)]
pub fn etf_fetch_sse(date: String) -> Result<EtfFetchResult, String> {
    let stat_date = dashed_date(&date, "沪市份额日期")?;
    fetch(SSE_HOST, &sse_path(&stat_date), "https://www.sse.com.cn/")
}

fn sse_path(stat_date: &str) -> String {
    format!(
        "/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L&STAT_DATE={stat_date}\
         &isPagination=true&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.endPage=1\
         &pageHelp.pageSize=10000&pageHelp.cacheSize=1"
    )
}

/// 深市某只基金、一段区间（≤ 6 个自然月，服务端限制）的每日规模，第 `page` 页。
/// `txtDm` 是报表的「代码或简称」过滤条件（页面上没露出输入框，接口认）：不给它，
/// 一页 20 条的全市场表要翻几十页 —— 五年回填就是几万个请求。区间切批、每只的翻页
/// 与请求间隔都由 TS 侧规划。
#[tauri::command(async)]
pub fn etf_fetch_szse(code: String, start: String, end: String, page: u32) -> Result<EtfFetchResult, String> {
    let txt_start = dashed_date(&start, "深市起始日期")?;
    let txt_end = dashed_date(&end, "深市截止日期")?;
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("基金代码得是 6 位数字：{code}"));
    }
    if !(1..=500).contains(&page) {
        return Err(format!("页码越界：{page}"));
    }
    fetch(
        SZSE_HOST,
        &szse_path(&code, &txt_start, &txt_end, page),
        "https://www.szse.cn/market/fund/volume/etf/index.html",
    )
}

fn szse_path(code: &str, txt_start: &str, txt_end: &str, page: u32) -> String {
    // random 是深交所页面上带着的防缓存参数，给个定值即可
    format!(
        "/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=scsj_fund_jjgm&TABKEY=tab1\
         &txtDm={code}&txtStart={txt_start}&txtEnd={txt_end}&jjlb=ETF&PAGENO={page}&random=0.618"
    )
}

/// 一只基金的单位净值全历史脚本。基金代码只是行情接口的参数（与天气那条出口的
/// 「城市名」同类）：主机钉死在上面，代码形状不对在这儿挡下，拼不出别的地址。
#[tauri::command(async)]
pub fn etf_fetch_nav(code: String) -> Result<EtfFetchResult, String> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("基金代码得是 6 位数字：{code}"));
    }
    let path = format!("/pingzhongdata/{code}.js");
    fetch(NAV_HOST, &path, &format!("https://fund.eastmoney.com/{code}.html"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日期只认 8 位数字，拼出来的就是带横线的形状
    #[test]
    fn dashed_dates_are_validated_and_formatted() {
        assert_eq!(dashed_date("20240205", "沪市份额日期").unwrap(), "2024-02-05");
        assert!(dashed_date("2024-02-05", "沪市份额日期").is_err());
        assert!(dashed_date("2024025", "沪市份额日期").is_err());
        assert!(dashed_date("2024020a", "沪市份额日期").is_err());
        assert!(dashed_date("", "沪市份额日期").is_err());
    }

    /// 坏参数在拼地址之前就被拒，不会往下发请求
    #[test]
    fn rejects_bad_params_before_building_paths() {
        assert!(etf_fetch_sse("2024-02-05".into()).is_err());
        assert!(etf_fetch_szse("159919".into(), "20240205".into(), "20240430".into(), 0).is_err());
        assert!(etf_fetch_szse("159919".into(), "20240205".into(), "20240430".into(), 501).is_err());
        assert!(etf_fetch_szse("15991".into(), "20240205".into(), "20240430".into(), 1).is_err());
        assert!(etf_fetch_szse("159919.html".into(), "20240205".into(), "20240430".into(), 1).is_err());
        assert!(etf_fetch_nav("51030".into()).is_err());
        assert!(etf_fetch_nav("510300.html".into()).is_err());
        // 日期先于代码与页码校验：日期坏了报的是日期那句
        let err = etf_fetch_szse("159919".into(), "bad".into(), "20240430".into(), 3).unwrap_err();
        assert!(err.contains("深市起始日期"));
    }

    /// 沪市路径带上了 sqlId 与单日统计日期（这份表按日查询，参数错了只会拿到空表）
    #[test]
    fn sse_path_carries_sql_and_day() {
        let path = sse_path("2024-02-05");
        assert!(path.starts_with("/commonQuery.do?"));
        assert!(path.contains("sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L"));
        assert!(path.contains("STAT_DATE=2024-02-05"));
        assert!(path.contains("pageHelp.pageSize=10000"));
    }

    /// 深市路径带代码过滤、区间、类别与页码（区间超长由 TS 侧切批，这里只管拼装）
    #[test]
    fn szse_path_carries_code_range_and_page() {
        let path = szse_path("159919", "2024-02-05", "2024-04-30", 3);
        assert!(path.starts_with("/api/report/ShowReport/data?"));
        assert!(path.contains("CATALOGID=scsj_fund_jjgm"));
        assert!(path.contains("txtDm=159919"));
        assert!(path.contains("txtStart=2024-02-05"));
        assert!(path.contains("txtEnd=2024-04-30"));
        assert!(path.contains("jjlb=ETF"));
        assert!(path.contains("PAGENO=3"));
    }
}
