//! Qoder 账号模型与落盘。
//!
//! **这里只有数据和它的读写**：不发请求、不管调度。与 `wb_account` 同一套口径 ——
//! 一账号一个 `<uid>.json`，camelCase 键，token 明文（与官方客户端、原项目一致），
//! 文档里写明这件事，而不是假装它已加密。
//!
//! 比 TBuddy 多出来的字段都是 Qoder 上游真实存在的：`userType` / 组织信息进 COSY
//! 身份体，`plan` 给界面显示套餐，`campaignCodes` 存活动发出的兑换码（不落盘就找不回了）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use crate::common::{now_secs, sanitize_uid};

/// 到期前多久算「该续期了」：留十分钟够一次网络往返。
pub const REFRESH_SKEW_SECS: i64 = 600;

/// 一个账号。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub uid: String,
    #[serde(default)]
    pub nickname: String,
    /// 纯展示备注
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub domain: String,
    /// 只可能 `cn`（只接国内版；旧文件里别的值读入时跳过）
    #[serde(default = "default_realm")]
    pub realm: String,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix 秒
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub added_at: i64,
    /// `oauth`（只支持这一种）
    #[serde(default = "default_oauth")]
    pub source: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 最近一次失败原因（给界面看；成功时清空）
    #[serde(default)]
    pub last_error: String,
    /// 短错误 / 429 / 排队失败后的冷却截止（Unix 秒）
    #[serde(default)]
    pub cooldown_until: i64,
    /// 套餐名（`/api/v2/user/plan`）
    #[serde(default)]
    pub plan: String,
    /// 最近一次签到成功日（`YYYY-MM-DD`，UTC+8）
    #[serde(default)]
    pub last_checkin: String,
    /// 领到的兑换码：活动 id → 码
    #[serde(default)]
    pub campaign_codes: std::collections::HashMap<String, String>,
    /// 被「同人已领取」挡下的活动：活动 id → 冷却截止（Unix 秒）
    #[serde(default)]
    pub campaign_blocked_until: std::collections::HashMap<String, i64>,

    #[serde(default = "default_user_type")]
    pub user_type: String,
    #[serde(default)]
    pub organization_id: String,
    #[serde(default)]
    pub organization_name: String,

    /// 手动权重，1..=100（界面叫「优先级」，数大的先用）
    #[serde(default = "default_weight")]
    pub weight: u8,
    /// 最早一笔积分包的到期时刻（Unix 秒）。查余额时写回；0 = 没有已知到期
    #[serde(default)]
    pub credit_expires_at: i64,
    /// 整号额度用完标记
    #[serde(default)]
    pub quota_exhausted_at: i64,
    #[serde(default)]
    pub quota_resets_at: i64,
    /// 按模型记的额度用完标记
    #[serde(default)]
    pub quota_models: Vec<ModelQuota>,

    /// 运行时：续期失败 / 会话被吊销，需要重新登录。不写盘
    #[serde(skip)]
    pub token_expired: bool,
}

/// 一个模型上的额度用完标记（上游的频控 / 额度是模型粒度的）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelQuota {
    pub model: String,
    pub exhausted_at: i64,
    pub resets_at: i64,
}

fn default_true() -> bool {
    true
}

fn default_weight() -> u8 {
    1
}

fn default_realm() -> String {
    "cn".into()
}

fn default_platform() -> String {
    "CLI".into()
}

fn default_oauth() -> String {
    "oauth".into()
}

fn default_user_type() -> String {
    crate::qd_upstream::DEFAULT_USER_TYPE.into()
}


impl Account {
    /// 登录成功后的新账号。
    #[allow(clippy::too_many_arguments)]
    pub fn from_login(
        uid: &str,
        nickname: &str,
        access_token: &str,
        refresh_token: &str,
        expires_at: i64,
        user_type: &str,
        org_id: &str,
        org_name: &str,
    ) -> Self {
        Self {
            uid: uid.to_string(),
            nickname: nickname.to_string(),
            note: String::new(),
            domain: "qoder.com.cn".into(),
            realm: "cn".into(),
            platform: "CLI".into(),
            access_token: access_token.to_string(),
            refresh_token: refresh_token.to_string(),
            expires_at,
            added_at: now_secs(),
            source: "oauth".into(),
            enabled: true,
            last_error: String::new(),
            cooldown_until: 0,
            plan: String::new(),
            last_checkin: String::new(),
            campaign_codes: Default::default(),
            campaign_blocked_until: Default::default(),
            user_type: if user_type.trim().is_empty() {
                crate::qd_upstream::DEFAULT_USER_TYPE.into()
            } else {
                user_type.to_string()
            },
            organization_id: org_id.to_string(),
            organization_name: org_name.to_string(),
            weight: 1,
            credit_expires_at: 0,
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        }
    }

    /// 该不该续期。到期时间未知（0）也按要续处理。
    pub fn needs_refresh(&self) -> bool {
        self.expires_at <= 0 || now_secs() + REFRESH_SKEW_SECS >= self.expires_at
    }

    pub fn is_ready(&self) -> bool {
        self.enabled && !self.token_expired && !self.access_token.trim().is_empty()
    }

    /// 整号口径的额度冷却。
    pub fn quota_blocked(&self, now: i64) -> bool {
        self.quota_exhausted_at > 0 && now < self.quota_until()
    }

    pub fn quota_until(&self) -> i64 {
        if self.quota_exhausted_at <= 0 {
            return 0;
        }
        if self.quota_resets_at > self.quota_exhausted_at {
            self.quota_resets_at
        } else {
            self.quota_exhausted_at + crate::qd_quota::QUOTA_COOLDOWN_SECS
        }
    }

    pub fn is_available(&self, now: i64) -> bool {
        self.is_ready() && !self.quota_blocked(now) && now >= self.cooldown_until
    }

    pub fn is_available_for(&self, model: &str, now: i64) -> bool {
        self.is_available(now) && !self.model_blocked(model, now)
    }

    pub fn mark_quota_exhausted(&mut self, now: i64, resets_at: i64) {
        self.quota_exhausted_at = now;
        self.quota_resets_at = resets_at.max(0);
    }

    pub fn clear_quota(&mut self) -> bool {
        let changed = self.quota_exhausted_at > 0 || self.quota_resets_at > 0;
        self.quota_exhausted_at = 0;
        self.quota_resets_at = 0;
        changed
    }

    pub fn model_blocked(&self, model: &str, now: i64) -> bool {
        self.quota_models
            .iter()
            .any(|item| item.model == model && now < item.resets_at)
    }

    pub fn mark_model_exhausted(&mut self, model: &str, now: i64, resets_at: i64) {
        self.quota_models.retain(|item| now < item.resets_at);
        let resets_at = if resets_at > now {
            resets_at
        } else {
            now + crate::qd_quota::QUOTA_COOLDOWN_SECS
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

    pub fn clear_model_quota(&mut self) -> bool {
        if self.quota_models.is_empty() {
            return false;
        }
        self.quota_models.clear();
        true
    }

    pub fn label(&self) -> String {
        if self.nickname.trim().is_empty() {
            self.uid.chars().take(8).collect()
        } else {
            self.nickname.clone()
        }
    }

    /// 团队 / 企业账号：有组织字段（OAuth 登录即带），或 `userType` 含 team / enterprise。
    pub fn is_team(&self) -> bool {
        !self.organization_id.trim().is_empty()
            || !self.organization_name.trim().is_empty()
            || {
                let kind = self.user_type.to_ascii_lowercase();
                kind.contains("team") || kind.contains("enterprise")
            }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let path = account_path(dir, &self.uid)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("建账号目录失败: {err}"))?;
        }
        let text =
            serde_json::to_string_pretty(self).map_err(|err| format!("序列化账号失败: {err}"))?;
        crate::fs_util::write_atomic(&path, text.as_bytes())
    }
}

pub fn account_path(dir: &Path, uid: &str) -> Result<PathBuf, String> {
    let safe = sanitize_uid(uid).ok_or_else(|| format!("uid 含非法字符，拒绝落盘：{uid:?}"))?;
    Ok(dir.join(format!("{safe}.json")))
}

/// 读目录里的全部账号，按添加时间排。坏文件跳过并记一行 —— 一个坏文件不该让整池起不来。
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
            Ok(account) => {
                if account.realm != "cn" {
                    eprintln!(
                        "[workbench] 跳过非国内版 Qoder 账号文件 {}（realm={}）",
                        path.display(),
                        account.realm
                    );
                    continue;
                }
                accounts.push(account);
            }
            Err(err) => {
                eprintln!(
                    "[workbench] 跳过读不懂的 Qoder 账号文件 {}：{err}",
                    path.display()
                );
            }
        }
    }
    accounts.sort_by_key(|account| account.added_at);
    accounts
}

/// 账号导出内容的格式标识。导入时按它认「这段 JSON 是不是 Qoder 的账号」。
pub const EXPORT_KIND: &str = "workbench-qoder-accounts";
pub const EXPORT_VERSION: u32 = 1;
/// 粘贴进来的那段 JSON 的大小上限（正常一份导出只有几 KB）。
const MAX_IMPORT_BYTES: usize = 1 << 20;

/// 导出文件的外壳。与 TBuddy 同一套约定，`kind` 不同、账号字段各按自己的模型。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    kind: String,
    version: u32,
    exported_at: i64,
    accounts: Vec<ExportAccount>,
}

/// 一份导出账号：只放凭据、身份与偏好。额度标记、签到 / 活动记录这些
/// 是本机瞬时状态，换一台机器应当重新查。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAccount {
    uid: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    domain: String,
    #[serde(default = "default_realm")]
    realm: String,
    #[serde(default = "default_platform")]
    platform: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_at: i64,
    #[serde(default)]
    added_at: i64,
    #[serde(default = "default_user_type")]
    user_type: String,
    #[serde(default)]
    organization_id: String,
    #[serde(default)]
    organization_name: String,
    #[serde(default)]
    plan: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_weight")]
    weight: u8,
}

impl ExportAccount {
    fn of(account: &Account) -> Self {
        Self {
            uid: account.uid.clone(),
            nickname: account.nickname.clone(),
            note: account.note.clone(),
            domain: account.domain.clone(),
            realm: account.realm.clone(),
            platform: account.platform.clone(),
            access_token: account.access_token.clone(),
            refresh_token: account.refresh_token.clone(),
            expires_at: account.expires_at,
            added_at: account.added_at,
            user_type: account.user_type.clone(),
            organization_id: account.organization_id.clone(),
            organization_name: account.organization_name.clone(),
            plan: account.plan.clone(),
            enabled: account.enabled,
            weight: account.weight,
        }
    }
}

/// 把账号池导成一段 JSON 字符串，交给用户自己保管（密码管理器之类）。
pub fn export_accounts(accounts: &[Account]) -> Result<String, String> {
    let file = ExportFile {
        kind: EXPORT_KIND.to_string(),
        version: EXPORT_VERSION,
        exported_at: now_secs(),
        accounts: accounts.iter().map(ExportAccount::of).collect(),
    };
    serde_json::to_string_pretty(&file).map_err(|err| format!("生成导出内容失败: {err}"))
}

/// 解析一段导出的 JSON 并转回账号。校验全部做完才返回，调用方可以放心先解析再落盘。
pub fn parse_import(text: &str) -> Result<Vec<Account>, String> {
    if text.len() > MAX_IMPORT_BYTES {
        return Err("导入内容太大（上限 1 MiB）".into());
    }
    let file: ExportFile = serde_json::from_str(text)
        .map_err(|err| format!("导入内容不是 Qoder 账号导出文件：{err}"))?;
    if file.kind != EXPORT_KIND {
        return Err(format!("这不是 Qoder 账号的导出内容（kind={}）", file.kind));
    }
    if file.version > EXPORT_VERSION {
        return Err(format!(
            "导出内容版本太新（v{}），请先升级应用",
            file.version
        ));
    }
    if file.accounts.is_empty() {
        return Err("导入内容里没有账号".into());
    }

    let now = now_secs();
    let mut seen = std::collections::HashSet::new();
    let mut accounts = Vec::with_capacity(file.accounts.len());
    for (index, item) in file.accounts.into_iter().enumerate() {
        let uid = sanitize_uid(&item.uid)
            .ok_or_else(|| format!("第 {} 个账号的 uid 不合法：{:?}", index + 1, item.uid))?;
        if !seen.insert(uid.clone()) {
            return Err(format!("导出内容里有重复的账号：{uid}"));
        }
        if item.access_token.trim().is_empty() {
            return Err(format!("账号 {uid} 缺少 accessToken"));
        }
        let realm = if item.realm.trim().is_empty() {
            "cn".to_string()
        } else {
            item.realm
        };
        if realm != "cn" {
            return Err(format!("账号 {uid} 不是国内版（realm={realm}）"));
        }
        accounts.push(Account {
            uid,
            nickname: item.nickname,
            note: item.note,
            domain: if item.domain.trim().is_empty() {
                "qoder.com.cn".to_string()
            } else {
                item.domain
            },
            realm,
            platform: if item.platform.trim().is_empty() {
                default_platform()
            } else {
                item.platform
            },
            access_token: item.access_token,
            refresh_token: item.refresh_token,
            expires_at: item.expires_at,
            added_at: if item.added_at > 0 { item.added_at } else { now },
            source: "import".to_string(),
            enabled: item.enabled,
            last_error: String::new(),
            cooldown_until: 0,
            plan: item.plan,
            last_checkin: String::new(),
            campaign_codes: Default::default(),
            campaign_blocked_until: Default::default(),
            user_type: if item.user_type.trim().is_empty() {
                default_user_type()
            } else {
                item.user_type
            },
            organization_id: item.organization_id,
            organization_name: item.organization_name,
            weight: item.weight.clamp(1, 100),
            credit_expires_at: 0,
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        });
    }
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_白名单挡住路径穿越() {
        assert_eq!(sanitize_uid("abc-123_x"), Some("abc-123_x".into()));
        assert_eq!(sanitize_uid("../../evil"), None);
        assert_eq!(sanitize_uid(""), None);
        assert_eq!(sanitize_uid(&"a".repeat(65)), None);
    }

    #[test]
    fn 额度标记会随恢复时刻自解() {
        let mut account = Account::from_login("u1", "n", "t", "r", 0, "", "", "");
        let now = 1_000;
        account.mark_model_exhausted("Qwen3.8-Max", now, now + 10);
        assert!(account.model_blocked("Qwen3.8-Max", now + 1));
        assert!(!account.model_blocked("Qwen3.8-Max", now + 11));
        assert!(account.clear_model_quota());
        assert!(!account.clear_model_quota());
    }

    #[test]
    fn 续期判断按十分钟提前量() {
        let mut account = Account::from_login("u1", "n", "t", "r", now_secs() + 601, "", "", "");
        assert!(!account.needs_refresh());
        account.expires_at = now_secs() + 60;
        assert!(account.needs_refresh());
        account.expires_at = 0;
        assert!(account.needs_refresh());
    }

    #[test]
    fn 团队账号按组织字段判定() {
        let mut account = Account::from_login("u1", "n", "t", "r", 0, "", "", "");
        assert!(!account.is_team());
        account.organization_name = "某组织".into();
        assert!(account.is_team());
        account.organization_name.clear();
        account.user_type = "team_pro".into();
        assert!(account.is_team());
    }

    fn exported_value() -> serde_json::Value {
        let text = export_accounts(&[Account::from_login(
            "u1", "小明", "tok", "ref", 1_700_000_000, "personal", "org-1", "某组织",
        )])
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn 导出再导入保住凭据与身份() {
        let mut account = Account::from_login(
            "u1", "小明", "tok", "ref", 1_700_000_000, "personal", "org-1", "某组织",
        );
        account.note = "备用".into();
        account.plan = "Pro".into();
        account.weight = 9;
        account.mark_quota_exhausted(1_000, 2_000);
        account.last_checkin = "2026-11-07".into();
        account
            .campaign_codes
            .insert("campaign".into(), "code".into());

        let parsed = parse_import(&export_accounts(&[account]).unwrap()).unwrap();
        assert_eq!(parsed.len(), 1);
        let item = &parsed[0];
        assert_eq!(item.uid, "u1");
        assert_eq!(item.access_token, "tok");
        assert_eq!(item.refresh_token, "ref");
        assert_eq!(item.realm, "cn");
        assert_eq!(item.note, "备用");
        assert_eq!(item.plan, "Pro");
        assert_eq!(item.weight, 9);
        assert_eq!(item.organization_name, "某组织");
        assert_eq!(item.source, "import");
        // 本机瞬时状态不跟着搬
        assert_eq!(item.credit_expires_at, 0);
        assert_eq!(item.quota_exhausted_at, 0);
        assert!(item.quota_models.is_empty());
        assert!(item.last_checkin.is_empty());
        assert!(item.campaign_codes.is_empty());
        assert!(!item.token_expired);
    }

    #[test]
    fn 导出内容不含额度与签到活动字段() {
        let mut account = Account::from_login("u1", "n", "t", "r", 0, "", "", "");
        account.mark_quota_exhausted(1_000, 2_000);
        account.last_checkin = "2026-11-07".into();
        account
            .campaign_codes
            .insert("campaign".into(), "code".into());
        account.credit_expires_at = 123;
        account.token_expired = true;
        let text = export_accounts(&[account]).unwrap();
        for key in [
            "quotaExhaustedAt",
            "quotaResetsAt",
            "quotaModels",
            "creditExpiresAt",
            "tokenExpired",
            "lastCheckin",
            "campaignCodes",
            "lastError",
            "cooldownUntil",
        ] {
            assert!(!text.contains(key), "导出内容不该含 {key}");
        }
    }

    #[test]
    fn 导入拒绝错_kind_版本过高与非国内版() {
        let mut value = exported_value();
        value["kind"] = "workbench-gateway-accounts".into();
        let error = parse_import(&value.to_string()).unwrap_err();
        assert!(error.contains("不是 Qoder 账号"), "{error}");

        let mut value = exported_value();
        value["version"] = 2.into();
        let error = parse_import(&value.to_string()).unwrap_err();
        assert!(error.contains("版本太新"), "{error}");

        let mut value = exported_value();
        value["accounts"][0]["realm"] = "intl".into();
        let error = parse_import(&value.to_string()).unwrap_err();
        assert!(error.contains("不是国内版"), "{error}");
    }

    #[test]
    fn 导入拒绝缺_token_非法_uid_与重复号() {
        let mut value = exported_value();
        value["accounts"][0]["accessToken"] = "".into();
        let error = parse_import(&value.to_string()).unwrap_err();
        assert!(error.contains("accessToken"), "{error}");

        let mut value = exported_value();
        value["accounts"][0]["uid"] = "../evil".into();
        let error = parse_import(&value.to_string()).unwrap_err();
        assert!(error.contains("uid 不合法"), "{error}");

        let mut value = exported_value();
        let duplicate = value["accounts"][0].clone();
        value["accounts"].as_array_mut().unwrap().push(duplicate);
        let error = parse_import(&value.to_string()).unwrap_err();
        assert!(error.contains("重复"), "{error}");
    }
}
