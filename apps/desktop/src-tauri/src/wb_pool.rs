//! 账号池的选号顺序。
//!
//! 规则只有一条：**优先级高的先用**（`weight` 降序），同优先级按加入时间先来先用。
//! 停用、token 过期、额度标记还没到期的号一律跳过 —— 额度用完的号不是「坏了」，
//! 只是这一段时间不该再被选中（标记与自动解除在 `wb_account`）。
//!
//! 额度标记分两档：整号（余额 / 积分用完）与**按模型**（上游 code 6004）。
//! 后者只挡那一个模型 —— 同一个号换模型还能用，不能把整个号踢出池子。
//!
//! 这里只算顺序，不发请求、不改状态；失败接手由 `wb_relay` 按这个顺序逐个试。

use crate::wb_account::Account;

/// 能发 `model` 的号，按优先级排好的下标。
///
/// 返回下标而不是引用，调用方才能拿着 `&mut accounts` 就地续期 / 打标记。
pub fn order(accounts: &[Account], model: &str, now: i64) -> Vec<usize> {
    ranked(accounts, |account| account.is_available_for(model, now))
}

/// 顺序里的第一个。给「拉模型目录」这类只需要一个号的动作用 ——
/// 那里没有具体模型，只看整号的额度标记。
pub fn first(accounts: &[Account], now: i64) -> Option<usize> {
    ranked(accounts, |account| account.is_available(now))
        .into_iter()
        .next()
}

/// 按「权重降序、同权重先来的先上」排一遍能用的号。
fn ranked(accounts: &[Account], usable: impl Fn(&Account) -> bool) -> Vec<usize> {
    let mut indices: Vec<usize> = accounts
        .iter()
        .enumerate()
        .filter(|(_, account)| usable(account))
        .map(|(index, _)| index)
        .collect();
    indices.sort_by(|left, right| {
        accounts[*right]
            .weight
            .cmp(&accounts[*left].weight)
            .then_with(|| accounts[*left].added_at.cmp(&accounts[*right].added_at))
    });
    indices
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wb_identity::Identity;

    fn account(uid: &str, weight: u8, added_at: i64) -> Account {
        Account {
            uid: uid.into(),
            nickname: String::new(),
            domain: String::new(),
            product: Identity::Workbuddy,
            enterprise_id: String::new(),
            access_token: "tok".into(),
            refresh_token: String::new(),
            expires_at: 0,
            added_at,
            source: "oauth".into(),
            enabled: true,
            weight,
            note: String::new(),
            quota_exhausted_at: 0,
            quota_resets_at: 0,
            quota_models: Vec::new(),
            token_expired: false,
        }
    }

    #[test]
    fn 优先级高的排前面() {
        let list = vec![account("low", 1, 1), account("high", 9, 2)];
        let order = order(&list, "m", 0);
        assert_eq!(order, vec![1, 0]);
    }

    #[test]
    fn 同优先级先加的先用() {
        let list = vec![account("new", 5, 200), account("old", 5, 100)];
        let order = order(&list, "m", 0);
        assert_eq!(order, vec![1, 0]);
    }

    #[test]
    fn 停用与待续期的号不进池子() {
        let mut disabled = account("disabled", 9, 1);
        disabled.enabled = false;
        let mut expired = account("expired", 8, 2);
        expired.token_expired = true;
        let list = vec![disabled, expired, account("ok", 1, 3)];
        assert_eq!(order(&list, "m", 0), vec![2]);
    }

    #[test]
    fn 额度标记没过期的号跳过_过期后自动回来() {
        let mut blocked = account("blocked", 9, 1);
        blocked.mark_quota_exhausted(1_000, 1_000 + 60);
        let list = vec![blocked, account("ok", 1, 2)];

        assert_eq!(order(&list, "m", 1_030), vec![1], "标记期内跳过");
        assert_eq!(order(&list, "m", 1_061), vec![0, 1], "标记过期后自动回到池子");
    }

    #[test]
    fn 按模型的标记只挡那一个模型() {
        let mut blocked = account("blocked", 9, 1);
        blocked.mark_model_exhausted("deepseek", 1_000, 1_600);
        let list = vec![blocked, account("ok", 1, 2)];

        assert_eq!(order(&list, "deepseek", 1_030), vec![1], "这个模型跳过它");
        assert_eq!(order(&list, "glm-5.3-flash", 1_030), vec![0, 1], "别的模型照用");
        assert_eq!(order(&list, "deepseek", 1_600), vec![0, 1], "到期自动回来");
        assert_eq!(first(&list, 1_030), Some(0), "找号拉模型目录时不受模型标记影响");
    }

    #[test]
    fn first_就是顺序里的第一个() {
        let list = vec![account("a", 1, 1), account("b", 2, 2)];
        assert_eq!(first(&list, 0), Some(1));
        assert_eq!(first(&[], 0), None);
    }
}
