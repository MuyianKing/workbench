//! 账号模型与落盘。
//!
//! **这里只有数据和它的读写**，不发请求、不管调度、不碰护栏 —— 那些在各自的模块里。
//! 原项目把账号、鉴权、计费、池、护栏全塞进一个 4200 行的文件，改一处要读四千行，
//! 这类耦合不复刻。
//!
//! 落盘形态与上游生态一致（一账号一文件 `<uid>.json`，`camelCase` 键），
//! 这样以后要跟原项目的导出文件互相认，不用写转换层。
//!
//! token 是明文的。与客户端自己、与原项目都一致；真正的密钥保护（DPAPI）留给后续，
//! 文档里写明这件事，而不是假装它已加密。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::wb_identity::Identity;
use crate::wb_jwt;
use crate::wb_realm::{self, Realm};

/// 提前多久算「该续期了」。上游 refresh token 有效期很长，access token 到期前
/// 留出十分钟，够一次网络往返。
pub const REFRESH_SKEW_SECS: i64 = 600;

/// 一次 token 授予（登录或续期的响应体）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenGrant {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// 秒
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub domain: String,
}

/// 一个模型上的额度用完标记。
///
/// 上游的限额是**按模型**的（code 6004：同一个号这个模型 429、换个模型照样能用），
/// 所以它不能和整号的 [`Account::quota_exhausted_at`] 混成一个字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelQuota {
    pub model: String,
    /// Unix 秒
    pub exhausted_at: i64,
    /// 预计恢复的时刻（Unix 秒）。总是大于 `exhausted_at`
    pub resets_at: i64,
}

/// 一个账号。持久化字段之外的东西一律不写盘（`#[serde(skip)]`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub uid: String,
    #[serde(default)]
    pub nickname: String,
    /// `X-Domain` 用。空则回落到区域的规范值
    #[serde(default)]
    pub domain: String,
    pub realm: Realm,
    /// 出站身分。默认桌面端
    #[serde(default)]
    pub product: Identity,
    #[serde(default)]
    pub enterprise_id: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix 秒
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub added_at: i64,
    /// `oauth` / `import` —— 只用于界面展示来源
    #[serde(default)]
    pub source: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 手动权重，1..=100。多号轮转时的优先级（数大的先用）
    #[serde(default = "default_weight")]
    pub weight: u8,
    #[serde(default)]
    pub note: String,
    /// 额度用完的时刻（Unix 秒）。0 = 没标记
    #[serde(default)]
    pub quota_exhausted_at: i64,
    /// 预计恢复的时刻（Unix 秒）。0 = 不知道，按 [`crate::wb_quota::QUOTA_COOLDOWN_SECS`] 算
    #[serde(default)]
    pub quota_resets_at: i64,
    /// 按模型记的额度用完标记（上游 code 6004）。只挡列表里那些模型
    #[serde(default)]
    pub quota_models: Vec<ModelQuota>,

    /// 运行时：续期失败过、需要重新登录。不写盘 —— 重启后重试一次比记住"过期"更有用
    #[serde(skip)]
    pub token_expired: bool,
}

fn default_true() -> bool {
    true
}

fn default_weight() -> u8 {
    1
}

impl Account {
    /// 新建一个账号（登录成功后调用）。
    #[allow(dead_code)] // S2 接入前还没有调用方
    pub fn from_grant(uid: &str, grant: &TokenGrant, realm: Realm, nickname: &str) -> Self {
        let mut account = Self {
            uid: uid.to_string(),
            nickname: nickname.to_string(),
            domain: grant.domain.clone(),
            realm,
            product: Identity::default(),
            enterprise_id: String::new(),
            access_token: grant.access_token.clone(),
            refresh_token: grant.refresh_token.clone(),
            expires_at: 0,
            added_at: now_secs(),
            source: "oauth".to_string(),
            enabled: true,
            weight: 1,
            note: String::new(),
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        };
        account.absorb_grant(grant);
        account
    }

    /// 吃下一份授予：更新三个 token 字段，并顺手把企业 id、uid 兜底填上。
    pub fn absorb_grant(&mut self, grant: &TokenGrant) {
        if !grant.access_token.trim().is_empty() {
            self.access_token = grant.access_token.clone();
        }
        if !grant.refresh_token.trim().is_empty() {
            self.refresh_token = grant.refresh_token.clone();
        }
        if !grant.domain.trim().is_empty() {
            self.domain = grant.domain.clone();
        }
        // expires_in 是相对秒；为 0 时退回 token 自己的 exp
        self.expires_at = if grant.expires_in > 0 {
            now_secs() + grant.expires_in
        } else {
            self.token_expiry_from_jwt().unwrap_or(0)
        };
        if self.uid.trim().is_empty() {
            if let Some(claims) = wb_jwt::claims(&self.access_token) {
                self.uid = claims.subject;
            }
        }
        if self.enterprise_id.trim().is_empty() {
            if let Some(claims) = wb_jwt::claims(&self.access_token) {
                self.enterprise_id = claims.enterprise_id;
            }
        }
        self.token_expired = false;
    }

    /// token 自带的过期时间。解析不出就是 None。
    pub fn token_expiry_from_jwt(&self) -> Option<i64> {
        wb_jwt::claims(&self.access_token)
            .map(|claims| claims.expires_at)
            .filter(|value| *value > 0)
    }

    /// 要不要续期。`expires_at` 为 0（不知道）时按"要续"处理 ——
    /// 宁可在请求前多跑一次续期，也别拿着可能过期的 token 去打上游。
    pub fn needs_refresh(&self) -> bool {
        self.expires_at <= 0 || now_secs() + REFRESH_SKEW_SECS >= self.expires_at
    }

    /// 能不能拿去发请求。
    pub fn is_ready(&self) -> bool {
        self.enabled && !self.token_expired && !self.access_token.trim().is_empty()
    }

    /// 额度标记是否还在生效。标记过期后自动失效，不写盘 —— 下次真正选号时再看一遍即可。
    pub fn quota_blocked(&self, now: i64) -> bool {
        self.quota_exhausted_at > 0 && now < self.quota_until()
    }

    /// 额度的恢复时刻（Unix 秒）。没标记是 0；记了恢复时间就用它，否则标记 + 24 小时。
    pub fn quota_until(&self) -> i64 {
        if self.quota_exhausted_at <= 0 {
            return 0;
        }
        if self.quota_resets_at > self.quota_exhausted_at {
            self.quota_resets_at
        } else {
            self.quota_exhausted_at + crate::wb_quota::QUOTA_COOLDOWN_SECS
        }
    }

    /// 现在能不能被选去发请求（整号口径）：token 可用、且整个号不在额度冷却里。
    /// 具体某个模型还要再过 [`Self::is_available_for`]。
    pub fn is_available(&self, now: i64) -> bool {
        self.is_ready() && !self.quota_blocked(now)
    }

    /// 打上「额度用完」标记。`resets_at` 为 0 时按 24 小时算（见 [`Self::quota_until`]）。
    pub fn mark_quota_exhausted(&mut self, now: i64, resets_at: i64) {
        self.quota_exhausted_at = now;
        self.quota_resets_at = resets_at.max(0);
    }

    /// 清掉额度标记。返回是否真的清掉了（调用方据此决定要不要写盘）。
    pub fn clear_quota(&mut self) -> bool {
        let changed = self.quota_exhausted_at > 0 || self.quota_resets_at > 0;
        self.quota_exhausted_at = 0;
        self.quota_resets_at = 0;
        changed
    }

    /// 这个模型现在能不能用：整个号可用，且这个模型不在额度冷却里。
    pub fn is_available_for(&self, model: &str, now: i64) -> bool {
        self.is_available(now) && !self.model_blocked(model, now)
    }

    /// 这个模型是否还在额度冷却里。过期就是自动失效，不写盘。
    pub fn model_blocked(&self, model: &str, now: i64) -> bool {
        self.quota_models
            .iter()
            .any(|item| item.model == model && now < item.resets_at)
    }

    /// 还在生效的按模型标记。
    pub fn model_quotas(&self, now: i64) -> impl Iterator<Item = &ModelQuota> {
        self.quota_models.iter().filter(move |item| now < item.resets_at)
    }

    /// 给一个模型打上「额度用完」。同一个模型重复打标就是刷新时刻；
    /// `resets_at` 早于现在（或为 0）按 24 小时兜底。
    pub fn mark_model_exhausted(&mut self, model: &str, now: i64, resets_at: i64) {
        // 先把过期的摘掉：模型清单是有限集，但上游改口径时旧条目不该一直留着
        self.quota_models.retain(|item| now < item.resets_at);
        let resets_at = if resets_at > now {
            resets_at
        } else {
            now + crate::wb_quota::QUOTA_COOLDOWN_SECS
        };
        match self.quota_models.iter_mut().find(|item| item.model == model) {
            Some(item) => {
                item.exhausted_at = now;
                item.resets_at = resets_at;
            }
            None => self.quota_models.push(ModelQuota {
                model: model.to_string(),
                exhausted_at: now,
                resets_at,
            }),
        }
    }

    /// 清掉所有按模型的标记。返回是否真的动过。
    pub fn clear_model_quota(&mut self) -> bool {
        if self.quota_models.is_empty() {
            return false;
        }
        self.quota_models.clear();
        true
    }

    /// `X-Domain` 的生效值：账号自己记的优先，否则区域的规范域。
    #[allow(dead_code)] // S2 接入前还没有调用方
    pub fn effective_domain(&self) -> String {
        wb_realm::align_domain(self.realm, &self.domain)
    }

    /// 从 token / 域名推断区域。看不出返回 None（**不要瞎猜**）。
    ///
    /// S2 的登录流程用它核对「用户选的区域」与「token 说的区域」是否一致，
    /// 现在还没有调用方。
    #[allow(dead_code)]
    pub fn detect_realm(&self) -> Option<Realm> {
        let issuer = wb_jwt::claims(&self.access_token)
            .map(|claims| claims.issuer)
            .unwrap_or_default();
        wb_realm::detect(&issuer, &self.domain)
    }

    /// 显示名：没有昵称就用 uid 前 8 位。
    pub fn label(&self) -> String {
        if self.nickname.trim().is_empty() {
            self.uid.chars().take(8).collect()
        } else {
            self.nickname.clone()
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let path = account_path(dir, &self.uid)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("建账号目录失败: {err}"))?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|err| format!("序列化账号失败: {err}"))?;
        crate::fs_util::write_atomic(&path, text.as_bytes())
    }
}

/// 账号文件的落点。uid 先过白名单 —— 它来自上游响应，直接拼路径会被路径穿越利用
/// （`../../evil` 这种）。
pub fn account_path(dir: &Path, uid: &str) -> Result<PathBuf, String> {
    let safe = sanitize_uid(uid).ok_or_else(|| format!("uid 含非法字符，拒绝落盘：{uid:?}"))?;
    Ok(dir.join(format!("{safe}.json")))
}

/// uid 白名单：字母、数字、连字符、下划线。腾讯侧的 uid 实测是 UUID 形态，
/// 这条闸只是防着"上游被换掉"那种情况。
pub fn sanitize_uid(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() || text.len() > 64 {
        return None;
    }
    if !text
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return None;
    }
    Some(text.to_string())
}

/// 目录里的全部账号，按添加时间排。坏文件跳过并记一行 —— 一个坏文件不该让整池起不来。
pub fn load_all(dir: &Path) -> Vec<Account> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut accounts: Vec<Account> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        match serde_json::from_str::<Account>(&text) {
            Ok(account) => accounts.push(account),
            Err(err) => {
                eprintln!("[workbench] 跳过坏账号文件 {}：{err}", path.display());
            }
        }
    }
    accounts.sort_by_key(|account| account.added_at);
    accounts
}

#[allow(dead_code)] // S2 的单账号命令用
pub fn load(dir: &Path, uid: &str) -> Option<Account> {
    let path = account_path(dir, uid).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[allow(dead_code)] // S2 的删除命令用
pub fn delete(dir: &Path, uid: &str) -> Result<(), String> {
    let path = account_path(dir, uid)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("删除账号失败: {err}")),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wb-account-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> Account {
        Account {
            uid: "u-1".into(),
            nickname: "小明".into(),
            domain: "www.workbuddy.ai".into(),
            realm: Realm::Workbuddy,
            product: Identity::Workbuddy,
            enterprise_id: String::new(),
            access_token: "tok".into(),
            refresh_token: "ref".into(),
            expires_at: now_secs() + 3600,
            added_at: now_secs(),
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
    fn 落盘再读回一致() {
        let dir = temp_dir("roundtrip");
        let account = sample();
        account.save(&dir).unwrap();

        let loaded = load(&dir, "u-1").unwrap();
        assert_eq!(loaded.uid, account.uid);
        assert_eq!(loaded.realm, Realm::Workbuddy);
        assert_eq!(loaded.product, Identity::Workbuddy);
        assert_eq!(loaded.access_token, "tok");
        assert_eq!(loaded.nickname, "小明");
        assert_eq!(loaded.effective_domain(), "www.workbuddy.ai");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 落盘键名是_camel_case_且不含运行时字段() {
        let dir = temp_dir("keys");
        sample().save(&dir).unwrap();
        let text = std::fs::read_to_string(account_path(&dir, "u-1").unwrap()).unwrap();
        assert!(text.contains("\"accessToken\""));
        assert!(text.contains("\"enterpriseId\""));
        assert!(!text.contains("tokenExpired"), "运行时字段不该写盘");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uid_白名单挡住路径穿越() {
        assert!(sanitize_uid("92af3923-a7cb-49e3-af38-a8f39398ae14").is_some());
        assert!(sanitize_uid("../../evil").is_none());
        assert!(sanitize_uid("a b").is_none());
        assert!(sanitize_uid("").is_none());
        assert!(sanitize_uid(&"x".repeat(65)).is_none());
        assert!(account_path(Path::new("/tmp"), "../evil").is_err());
    }

    #[test]
    fn 坏文件被跳过而不是拖垮整池() {
        let dir = temp_dir("broken");
        sample().save(&dir).unwrap();
        std::fs::write(dir.join("broken.json"), "{ 这不是 json").unwrap();
        std::fs::write(dir.join("ignored.txt"), "x").unwrap();
        let accounts = load_all(&dir);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].uid, "u-1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 额度标记到期后自动失效() {
        let mut account = sample();
        account.mark_quota_exhausted(1_000, 1_000 + 600);
        assert!(account.quota_blocked(1_000));
        assert!(account.quota_blocked(1_599));
        assert!(!account.quota_blocked(1_600));

        // token 本身可用，标记期内不进池子；到期后回来
        assert!(account.is_ready());
        assert!(!account.is_available(1_200));
        assert!(account.is_available(1_600));
    }

    #[test]
    fn 没给恢复时间就按二十四小时() {
        let mut account = sample();
        account.mark_quota_exhausted(10_000, 0);
        assert_eq!(
            account.quota_until(),
            10_000 + crate::wb_quota::QUOTA_COOLDOWN_SECS
        );
        assert!(account.quota_blocked(10_000 + 86_399));
        assert!(!account.quota_blocked(10_000 + 86_400));
    }

    #[test]
    fn 清额度标记只清一次() {
        let mut account = sample();
        assert!(!account.clear_quota(), "本来就没标记");
        account.mark_quota_exhausted(1_000, 0);
        assert!(account.clear_quota());
        assert_eq!(account.quota_exhausted_at, 0);
        assert_eq!(account.quota_resets_at, 0);
        assert!(!account.quota_blocked(1_001));
    }

    #[test]
    fn 额度字段会落盘() {
        let dir = temp_dir("quota");
        let mut account = sample();
        account.mark_quota_exhausted(1_700_000_000, 1_700_003_600);
        account.mark_model_exhausted("deepseek-v4.1-flash", 1_700_000_000, 1_700_003_600);
        account.save(&dir).unwrap();
        let loaded = load(&dir, "u-1").unwrap();
        assert_eq!(loaded.quota_exhausted_at, 1_700_000_000);
        assert_eq!(loaded.quota_resets_at, 1_700_003_600);
        assert_eq!(loaded.quota_models.len(), 1);
        assert_eq!(loaded.quota_models[0].model, "deepseek-v4.1-flash");
        assert_eq!(loaded.quota_models[0].resets_at, 1_700_003_600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 按模型的标记只挡那一个模型() {
        let mut account = sample();
        account.mark_model_exhausted("deepseek", 1_000, 1_600);

        assert!(!account.is_available_for("deepseek", 1_200), "标记期内这个模型不可用");
        assert!(account.is_available_for("glm-5.3-flash", 1_200), "别的模型照常可用");
        assert!(!account.model_blocked("deepseek", 1_600), "到期自动失效");
        assert!(account.is_available_for("deepseek", 1_600));
    }

    #[test]
    fn 按模型的标记没给恢复时间就按二十四小时() {
        let mut account = sample();
        account.mark_model_exhausted("deepseek", 10_000, 0);
        assert_eq!(
            account.quota_models[0].resets_at,
            10_000 + crate::wb_quota::QUOTA_COOLDOWN_SECS
        );
        // 同一个模型再打一次是刷新时刻，不是加一条
        account.mark_model_exhausted("deepseek", 20_000, 21_000);
        assert_eq!(account.quota_models.len(), 1);
        assert_eq!(account.quota_models[0].exhausted_at, 20_000);
        assert_eq!(account.quota_models[0].resets_at, 21_000);
    }

    #[test]
    fn 过期的按模型标记不再算数并会被新标记清掉() {
        let mut account = sample();
        account.mark_model_exhausted("old", 1_000, 2_000);
        account.mark_model_exhausted("new", 3_000, 4_000);
        assert_eq!(account.quota_models.len(), 1, "过期的那条在打新标时被摘掉");
        assert_eq!(account.quota_models[0].model, "new");
        assert!(account.clear_model_quota());
        assert!(account.quota_models.is_empty());
        assert!(!account.clear_model_quota(), "空的时候不算动过");
    }

    #[test]
    fn 续期判定的边界() {
        let mut account = sample();
        account.expires_at = now_secs() + 3600;
        assert!(!account.needs_refresh());

        account.expires_at = now_secs() + REFRESH_SKEW_SECS - 5;
        assert!(account.needs_refresh(), "进入提前量就要续");

        account.expires_at = 0;
        assert!(account.needs_refresh(), "不知道过期时间就按要续处理");
    }

    #[test]
    fn 只有启用的号能发请求() {
        let mut account = sample();
        assert!(account.is_ready());

        account.enabled = false;
        assert!(!account.is_ready());

        account.enabled = true;
        account.token_expired = true;
        assert!(!account.is_ready());

        account.token_expired = false;
        account.access_token.clear();
        assert!(!account.is_ready());
    }

    #[test]
    fn 吃授予时更新三个字段并清掉过期标记() {
        let mut account = sample();
        account.token_expired = true;
        account.absorb_grant(&TokenGrant {
            access_token: "new".into(),
            refresh_token: "new-ref".into(),
            expires_in: 3600,
            domain: "www.workbuddy.ai".into(),
        });
        assert_eq!(account.access_token, "new");
        assert_eq!(account.refresh_token, "new-ref");
        assert!(!account.token_expired);
        assert!(account.expires_at > now_secs() + 3000);
    }

    #[test]
    fn 跨区域域名会被对齐() {
        let mut account = sample();
        account.realm = Realm::Codebuddy;
        account.domain = "www.workbuddy.ai".into();
        assert_eq!(account.effective_domain(), "copilot.tencent.com");
    }

    #[test]
    fn 没有昵称时用_uid_前缀当标签() {
        let mut account = sample();
        account.nickname.clear();
        account.uid = "92af3923-a7cb".into();
        assert_eq!(account.label(), "92af3923");
    }

    #[test]
    fn 删除不存在的账号不算错() {
        let dir = temp_dir("delete");
        assert!(delete(&dir, "nope").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
