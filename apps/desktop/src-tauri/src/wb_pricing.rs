//! 定价估算：把 token 折算成"如果在 OpenRouter 买，要花多少钱"。
//!
//! **这不是你实际花的钱**。实际扣的是积分，网关看不到那本账（见 `wb_api_billing` 的
//! `ProductCode` 注释）。这里的数字只用来横向比较"哪个模型更贵"，所以：
//! - 只有价表里有的模型才有数，缺的一律算 0 并在界面上标"未定价"——**不猜**；
//! - 单价按每百万 token、人民币给；汇率固定写在常量里，不做实时汇率（那是另一个出口）。
//!
//! 纯逻辑：一张表 + 两个乘法。

/// 每百万 token 的人民币单价。
#[derive(Debug, Clone, Copy)]
pub struct Price {
    pub input_cny: f64,
    pub output_cny: f64,
}

impl Price {
    fn per_million(rate: f64, tokens: i64) -> f64 {
        if tokens <= 0 {
            return 0.0;
        }
        rate * (tokens as f64) / 1_000_000.0
    }

    pub fn input_cny(&self, tokens: i64) -> f64 {
        Self::per_million(self.input_cny, tokens)
    }

    pub fn output_cny(&self, tokens: i64) -> f64 {
        Self::per_million(self.output_cny, tokens)
    }
}

/// 价表。键是模型 id 的**前缀**，匹配时按最长前缀取 ——
/// 上游常在 id 后面挂日期或变体后缀（`glm-5.2-0930`），精确匹配会全部落空。
///
/// 数值来源：OpenRouter 目录里对应模型在 2026-10 的公开报价，按 1 USD ≈ 7.1 CNY 折算后
/// 取整。它是估算，**不要拿它做计费**。
const TABLE: &[(&str, Price)] = &[
    ("glm-5.2", Price { input_cny: 4.0, output_cny: 16.0 }),
    ("glm-5", Price { input_cny: 4.0, output_cny: 16.0 }),
    ("hy4-preview", Price { input_cny: 2.0, output_cny: 8.0 }),
    ("hy3", Price { input_cny: 2.0, output_cny: 8.0 }),
    ("deepseek-v4.1", Price { input_cny: 0.8, output_cny: 3.2 }),
    ("deepseek", Price { input_cny: 1.5, output_cny: 6.0 }),
    ("gpt-", Price { input_cny: 18.0, output_cny: 72.0 }),
    ("claude-", Price { input_cny: 21.0, output_cny: 105.0 }),
];

/// 按模型 id 查价。查不到返回 `None` —— 调用方据此显示"未定价"，而不是显示 0。
pub fn price_of(model: &str) -> Option<Price> {
    let id = model.trim().to_ascii_lowercase();
    if id.is_empty() {
        return None;
    }
    TABLE
        .iter()
        .filter(|(prefix, _)| id.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, price)| *price)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 最长前缀优先() {
        // deepseek-v4.1 比 deepseek 更具体，必须取前者
        let specific = price_of("deepseek-v4.1-flash").unwrap();
        let generic = price_of("deepseek-chat").unwrap();
        assert!(specific.output_cny < generic.output_cny);
    }

    #[test]
    fn 带日期后缀的_id_也能匹配() {
        assert!(price_of("glm-5.2-0930").is_some());
        assert!(price_of("GLM-5.2").is_some(), "大小写不敏感");
    }

    #[test]
    fn 表里没有的模型返回_none() {
        assert!(price_of("some-unknown-model").is_none());
        assert!(price_of("").is_none());
    }

    #[test]
    fn 每百万换算正确() {
        let price = Price { input_cny: 4.0, output_cny: 16.0 };
        assert!((price.input_cny(1_000_000) - 4.0).abs() < 1e-9);
        assert!((price.output_cny(500_000) - 8.0).abs() < 1e-9);
        assert_eq!(price.input_cny(0), 0.0);
    }

}
