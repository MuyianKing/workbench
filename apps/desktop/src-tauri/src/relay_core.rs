//! 两个网关共用的外壳：配置、密钥、监听句柄与状态 / 接入信息的形状。
//!
//! 独立的是**协议与账号池**（`wb_*` 对 CodeBuddy、`qd_*` 对 Qoder），共用的是这一层：
//! 端口、密钥、随程序启动、启停、状态与接入信息两边逐字同构 —— 各写一份只会在修一处时
//! 漏掉另一处。配置文件与端口仍然**各存各的**（`gateway_settings_file` /
//! `qoder_settings_file`，默认端口 17878 / 17879），两个代理可以同时跑。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::wb_server::{self, Server};

/// 登录窗口的有效期：用户「开了浏览器就走开」是常事，过期就让他重来，
/// 别把一个 state 无限留在内存里。
pub const LOGIN_TTL_SECS: i64 = 600;

/// 落盘的配置。字段少，所以直接读写文件（不必上 `JsonStore` 的防抖那一套 ——
/// 这里没有高频写入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 应用启动时自动把网关拉起来。默认开（设置·通用里可关）；
    /// 显式写成 false 才不监听，缺字段按开处理。
    #[serde(default = "default_auto_start")]
    pub auto_start: bool,
    pub port: u16,
    /// 访问密钥。第三方客户端大多要填一个非空的 key 才肯保存配置；
    /// 同时它也是「别的本机程序别乱调」的一道闸。首次启动时自动生成。
    #[serde(default)]
    pub api_key: String,
}

fn default_auto_start() -> bool {
    true
}

fn fallback(port: u16) -> Config {
    Config {
        auto_start: true,
        port,
        api_key: String::new(),
    }
}

/// 读配置；文件不在 / 读坏了一律回到默认（默认端口由调用方给）。
pub fn load_config(path: PathBuf, default_port: u16) -> Config {
    let Ok(text) = std::fs::read_to_string(path) else {
        return fallback(default_port);
    };
    serde_json::from_str(&text).unwrap_or_else(|_| fallback(default_port))
}

pub fn save_config(path: PathBuf, config: &Config) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("建网关目录失败: {err}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|err| format!("序列化网关配置失败: {err}"))?;
    crate::fs_util::write_atomic(&path, text.as_bytes())
}

/// 一段随机密钥。`wbg-` 前缀只是让它在配置里认得出来（两套网关同一族）。
pub fn new_key() -> String {
    format!("wbg-{}", uuid::Uuid::new_v4().simple())
}

/// 读这一套网关自己的密钥；没有就生成并落盘。
pub fn ensure_key(path: PathBuf, default_port: u16) -> Result<String, String> {
    let mut config = load_config(path.clone(), default_port);
    if config.api_key.trim().is_empty() {
        config.api_key = new_key();
        save_config(path, &config)?;
    }
    Ok(config.api_key)
}

/// 起监听（幂等）：已经开着就返回当前端口。
///
/// 处理函数要一个 `'static` 的东西，所以调用方把共享状态克隆进去，而不是借用自己。
pub fn start(
    server: &mut Option<Server>,
    port: u16,
    handler: wb_server::Handler,
) -> Result<u16, String> {
    if let Some(server) = server.as_ref() {
        return Ok(server.port());
    }
    let started = Server::start(port, handler)?;
    let port = started.port();
    *server = Some(started);
    Ok(port)
}

/// 停止监听。没在跑就什么都不做。
pub fn stop(server: &mut Option<Server>) {
    if let Some(mut server) = server.take() {
        server.stop();
    }
}

/// 正在监听的端口；没在跑时用配置里的那个（界面要显示「未监听 + 打算用哪个端口」）。
pub fn running_port(server: &Option<Server>, fallback: u16) -> u16 {
    server.as_ref().map(Server::port).unwrap_or(fallback)
}

/// `http://127.0.0.1:<port>/v1`；没在跑时是 None。
pub fn base_url(server: &Option<Server>) -> Option<String> {
    server.as_ref().map(|server| wb_server::api_base(server.port()))
}

/// 界面拿它渲染开关与地址。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub accounts: usize,
    pub ready: usize,
    pub auto_start: bool,
}

/// 接入信息：地址、密钥、模型清单。界面直接展示这一块。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
}

/// 把处理函数包成 `wb_server::Handler` 时要的那层锁：锁中毒只说明上一次跑一半 panic 了，
/// 照常拿回来接着用。
pub fn lock_or_recover<T>(shared: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match shared.lock() {
        Ok(inner) => inner,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 把处理函数包成 `wb_server::Handler`（就是 `Arc<dyn Fn(&Request) -> Response>`）。
pub fn handler<F>(f: F) -> wb_server::Handler
where
    F: Fn(&wb_server::Request) -> wb_server::Response + Send + Sync + 'static,
{
    Arc::new(f)
}
