//! Qoder 账号池的选号顺序。
//!
//! 与 TBuddy 同一套第一关键字：**积分到期时刻**（谁家的流量先作废就先花谁家的），
//! 同一档再按优先级（`weight` 降序）与加入时间。停用、token 过期、额度标记未到期的
//! 号跳过；按模型的标记只挡那一个模型。
//!
//! 顺序是确定性的：同一段对话只要首选号还可用，就一直落在同一个账号上
//! （上游按账号缓存前缀，这一点比轮询更重要）。`order_for` 预留了「会话亲和 →
//! 固定 uid」的入口，等把会话身份绑到账号后再接。
//!
//! 只算顺序，不发请求、不改状态。

use std::collections::HashSet;

use crate::qd_account::Account;

/// 能发 `model` 的号，按选号顺序排好的下标。
pub fn order(accounts: &[Account], model: &str, now: i64) -> Vec<usize> {
    ranked(accounts, now, |account| account.is_available_for(model, now))
}

/// 顺序里的第一个。给「拉模型目录」「查余额」这类只需要一个号的动作用。
pub fn first(accounts: &[Account], now: i64) -> Option<usize> {
    ranked(accounts, now, |account| account.is_available(now))
        .into_iter()
        .next()
}

/// 带排除集合与亲和的顺序：亲和账号能用在最前，其余按普通顺序。
///
/// 目前中转层只用 [`order`]（会话身份还没绑到 uid 上）；这个函数留给后续
/// 把「会话亲和 → 固定账号」接进来时直接用，测试覆盖着，不算死代码。
#[allow(dead_code)]
pub fn order_for(
    accounts: &[Account],
    model: &str,
    now: i64,
    affinity: Option<&str>,
    tried: &HashSet<String>,
) -> Vec<usize> {
    let mut order = ranked(accounts, now, |account| {
        account.is_available_for(model, now) && !tried.contains(&account.uid)
    });
    if let Some(uid) = affinity {
        if let Some(at) = order
            .iter()
            .position(|index| accounts[*index].uid == uid)
        {
            let preferred = order.remove(at);
            order.insert(0, preferred);
        }
    }
    order
}

fn expiry_key(account: &Account, now: i64) -> i64 {
    if account.credit_expires_at > now {
        account.credit_expires_at
    } else {
        i64::MAX
    }
}

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

    fn account(uid: &str, weight: u8, added_at: i64) -> Account {
        Account::from_login(uid, "", "tok", "", 0, "", "", "")
            .tap(|account| {
                account.weight = weight;
                account.added_at = added_at;
            })
    }

    // 小工具：在构造表达式里顺手改字段
    trait Tap: Sized {
        fn tap(mut self, edit: impl FnOnce(&mut Self)) -> Self {
            edit(&mut self);
            self
        }
    }
    impl<T> Tap for T {}

    #[test]
    fn 优先级高的先上() {
        let list = vec![account("low", 1, 1), account("high", 9, 2)];
        assert_eq!(order(&list, "m", 0), vec![1, 0]);
    }

    #[test]
    fn 到期早的压过优先级() {
        let later = account("later", 9, 1).tap(|a| a.credit_expires_at = 11_000);
        let sooner = account("sooner", 1, 2).tap(|a| a.credit_expires_at = 10_000);
        assert_eq!(order(&[later, sooner], "m", 1_000), vec![1, 0]);
    }

    #[test]
    fn 停用与过期的号不进池子() {
        let disabled = account("off", 9, 1).tap(|a| a.enabled = false);
        let expired = account("exp", 8, 2).tap(|a| a.token_expired = true);
        let ok = account("ok", 1, 3);
        assert_eq!(order(&[disabled, expired, ok], "m", 0), vec![2]);
    }

    #[test]
    fn 按模型的标记只挡那一个模型() {
        let blocked = account("blocked", 9, 1).tap(|a| {
            a.mark_model_exhausted("Qwen3.8-Max", 1_000, 1_600);
        });
        let ok = account("ok", 1, 2);
        assert_eq!(
            order(&[blocked.clone(), ok.clone()], "Qwen3.8-Max", 1_030),
            vec![1]
        );
        assert_eq!(order(&[blocked.clone(), ok.clone()], "GLM-5.3", 1_030), vec![0, 1]);
        assert_eq!(first(&[blocked, ok], 1_030), Some(0));
    }

    #[test]
    fn 亲和账号排最前_不在池子里就退回普通顺序() {
        let a = account("a", 9, 1);
        let b = account("b", 1, 2);
        assert_eq!(
            order_for(&[a.clone(), b.clone()], "m", 0, Some("b"), &HashSet::new()),
            vec![1, 0]
        );
        assert_eq!(
            order_for(&[a, b], "m", 0, Some("missing"), &HashSet::new()),
            vec![0, 1]
        );
    }

    #[test]
    fn 试过的号不再出现() {
        let list = vec![account("a", 9, 1), account("b", 1, 2)];
        let tried: HashSet<String> = ["a".to_string()].into_iter().collect();
        assert_eq!(order_for(&list, "m", 0, None, &tried), vec![1]);
    }
}
