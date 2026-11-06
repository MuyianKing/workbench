//! 账号池的选号顺序。
//!
//! 第一关键字是**积分到期时刻**：谁家还有花得出去、快作废的流量，就先花谁家的
//! （`credit_expires_at`，由查余额写回）。没有已知到期时刻（无期限 / 没查过 / 已过期）
//! 的号排在已知到期之后 —— 它们不催动作。
//! 同一档再按优先级（`weight` 降序）、加入时间先来先用。
//! 停用、token 过期、额度标记还没到期的号一律跳过 —— 额度用完的号不是「坏了」，
//! 只是这一段时间不该再被选中（标记与自动解除在 `wb_account`）。
//!
//! 额度标记分两档：整号（余额 / 积分用完）与**按模型**（上游 code 6004）。
//! 后者只挡那一个模型 —— 同一个号换模型还能用，不能把整个号踢出池子。
//!
//! 这里只算顺序，不发请求、不改状态；失败接手由 `wb_relay` 按这个顺序逐个试。

use crate::wb_account::Account;

/// 能发 `model` 的号，按选号顺序排好的下标。
///
/// 返回下标而不是引用，调用方才能拿着 `&mut accounts` 就地续期 / 打标记。
pub fn order(accounts: &[Account], model: &str, now: i64) -> Vec<usize> {
    ranked(accounts, now, |account| account.is_available_for(model, now))
}

/// 顺序里的第一个。给「拉模型目录」这类只需要一个号的动作用 ——
/// 那里没有具体模型，只看整号的额度标记。
pub fn first(accounts: &[Account], now: i64) -> Option<usize> {
    ranked(accounts, now, |account| account.is_available(now))
        .into_iter()
        .next()
}

/// 到期时刻做第一关键字。没有已知到期、或那个时刻已经过去，都算「没有紧迫的包」，
/// 用 `i64::MAX` 沉到已知到期之后。
fn expiry_key(account: &Account, now: i64) -> i64 {
    if account.credit_expires_at > now {
        account.credit_expires_at
    } else {
        i64::MAX
    }
}

/// 按「到期早的先用 → 权重降序 → 先来的先上」排一遍能用的号。
fn ranked(accounts: &[Account], now: i64, usable: impl Fn(&Account) -> bool) -> Vec<usize> {
    let mut indices: Vec<usize> = accounts
        .iter()
        .enumerate()
        .filter(|(_, account)| usable(account))
        .map(|(index, _)| index)
        .collect();
    indices.sort_by(|left, right| {
        let (left, right) = (&accounts[*left], &accounts[*right]);
        expiry_key(left, now)
            .cmp(&expiry_key(right, now))
            .then_with(|| right.weight.cmp(&left.weight))
            .then_with(|| left.added_at.cmp(&right.added_at))
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
            credit_expires_at: 0,
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
    fn 到期早的号压过优先级高的号() {
        // 账号 1：10 天后作废、优先级 9；账号 2：9 天后作废、优先级 1 —— 先花账号 2
        let mut later = account("later", 9, 1);
        later.credit_expires_at = 1_000 + 10 * 86_400;
        let mut sooner = account("sooner", 1, 2);
        sooner.credit_expires_at = 1_000 + 9 * 86_400;
        let list = vec![later, sooner];
        assert_eq!(order(&list, "m", 1_000), vec![1, 0]);
    }

    #[test]
    fn 没有已知到期的号排在已知到期之后() {
        let mut known = account("known", 1, 2);
        known.credit_expires_at = 1_000_000;
        let list = vec![account("unknown", 9, 1), known];
        assert_eq!(order(&list, "m", 1_000), vec![1, 0]);
    }

    #[test]
    fn 到期时刻已过按没有到期算() {
        let mut stale = account("stale", 9, 1);
        stale.credit_expires_at = 900;
        let mut known = account("known", 1, 2);
        known.credit_expires_at = 2_000;
        // 已经作废的时刻不能把它抬到「已知未来到期」前面
        assert_eq!(order(&[stale.clone(), known], "m", 1_000), vec![1, 0]);
        // 与「没有到期」同档，回到优先级排序
        assert_eq!(
            order(&[stale, account("plain", 1, 3)], "m", 1_000),
            vec![0, 1]
        );
    }

    #[test]
    fn 同一天到期再比优先级() {
        let mut low = account("low", 1, 1);
        low.credit_expires_at = 2_000;
        let mut high = account("high", 9, 2);
        high.credit_expires_at = 2_000;
        let list = vec![low, high];
        assert_eq!(order(&list, "m", 1_000), vec![1, 0]);
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
