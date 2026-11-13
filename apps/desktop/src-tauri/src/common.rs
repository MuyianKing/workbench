//! 跨模块通用小工具：时间、截断、打码、历法、白名单。
//!
//! 这些函数以前在 `wb_*` / `qd_*` 各写一份，写多了开始漂移（`key_tail` 一边
//! 加省略号一边不加、`redact` 一边认三种前缀一边认六种），这里收敛成一份。
//! 只依赖 std，不含任何业务语义；调用方（网关 / 任务引擎）自带各自的协议与落盘。

/// 当前 Unix 秒。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// 当前 Unix 毫秒。
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// 出错时把上游响应截下来给人看：裁到 `max` 个字符，超了补省略号。
pub fn excerpt(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect::<String>() + "…"
}

/// 密钥只留末四位：流水文件会被人翻着看，整把钥匙不该躺在里面。
/// 长度不够四位就整把记（那要么是短密钥，要么是空的）。
pub fn key_tail(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if key.chars().count() <= 4 {
        tail
    } else {
        format!("…{tail}")
    }
}

/// 打码 + 截断：换行折叠成一行，`Bearer` 与 `sk-` / `pt-` / `dt-` / `drt-` / `jrt-`
/// 前缀的凭据、32 位以上的连续十六进制都换成 `[redacted]`，最后裁到 200 字。
/// 上游报错里回显密钥不算罕见，要落进流水 / 活动记录的消息先过这里。
pub fn redact(message: &str) -> String {
    let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = redact_prefixed(&line);
    let line = redact_long_tokens(&line);
    excerpt(&line, 200)
}

/// 已知凭证形态：前缀后面连续的 `[alnum.-_]` 一段整体打码。
fn redact_prefixed(text: &str) -> String {
    let mut out = text.to_string();
    for prefix in ["Bearer ", "sk-", "pt-", "dt-", "drt-", "jrt-"] {
        let marker = format!("{prefix}[redacted]");
        let mut search_from = 0;
        while let Some(relative) = out[search_from..].find(prefix) {
            let at = search_from + relative;
            let start = at + prefix.len();
            let rest = &out[start..];
            let end = rest
                .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-' && ch != '_')
                .unwrap_or(rest.len());
            if end == 0 {
                search_from = start;
                continue;
            }
            out.replace_range(at..start + end, &marker);
            search_from = at + marker.len();
        }
    }
    out
}

/// 32 位以上的连续十六进制：没有前缀的裸密钥也打码。
/// `sk-` 等带前缀的形态在上面已处理，这里不再认前缀 —— 不然会把
/// 前缀阶段打出来的 `sk-[redacted]` 里的 `sk-` 又吃掉一次。
fn redact_long_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |out: &mut String, run: &mut String| {
        if run.len() >= 32 && run.chars().all(|ch| ch.is_ascii_hexdigit()) {
            out.push_str("[redacted]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            run.push(ch);
        } else {
            flush(&mut out, &mut run);
            out.push(ch);
        }
    }
    flush(&mut out, &mut run);
    out
}

/// 距 1970-01-01 的天数 → 公历日期 `(year, month, day)`（Howard Hinnant 算法）。
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 公历日期 → 距 1970-01-01 的天数（Hinnant 算法，与 [`civil_from_days`] 互逆）。
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// uid 白名单：字母、数字、连字符、下划线，长度 ≤ 64。uid 来自上游响应，
/// 直接拼路径会被穿越利用（`../../evil` 这种），落盘前先过这条闸。
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

/// 轮询周期的收敛（与渲染层各页的 sanitize 同一条）：0 = 关闭原样放行，
/// 其余夹进 `min..max`。
pub fn clamp_poll_minutes(raw: u32, min: u32, max: u32) -> u32 {
    if raw == 0 {
        return 0;
    }
    raw.clamp(min, max)
}

/// 一件要并行做的事：拿自己的键去干，干完给一个结果（失败是给一句话）。
pub type ParallelJob<T, R> = Box<dyn FnOnce(T) -> Result<R, String> + Send>;

/// 一批键各做一件事，**并行**做，结果按输入顺序收回。
///
/// 键按值交给闭包（闭包独占自己的键，不用借用）；主线程另留一份用于 panic 兜底 ——
/// 某个线程 panic 了也认得出是哪一个键，那一项单独标成失败，
/// 其余照常给结果，不让一项把整批带走。
///
/// 闭包类型擦成 `Box<dyn FnOnce…>`：一批里各项要干的事不一样（返回类型也不同），
/// 擦掉之后才能放进同一个 `Vec`。
///
/// 为什么要它：网关里「一个号一次上游往返」的地方有好几处（查余额之外的积分流水、
/// 福利汇总…）。上游一发的接收超时是 15 秒，几个号排着来就够等上一分钟；
/// 并行之后等的是最慢的那一发。
pub fn run_parallel<T, R>(items: Vec<(T, ParallelJob<T, R>)>) -> Vec<(T, Result<R, String>)>
where
    T: Clone + Send + 'static,
    R: Send + 'static,
{
    // 主线程留一份键：线程 panic 时键已经跟着进了线程，只能按索引找回
    let fallback_keys: Vec<T> = items.iter().map(|(key, _)| key.clone()).collect();
    let handles: Vec<_> = items
        .into_iter()
        .map(|(key, work)| {
            std::thread::spawn(move || {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(key)))
            })
        })
        .collect();

    handles
        .into_iter()
        .enumerate()
        .map(|(index, handle)| {
            let key = fallback_keys[index].clone();
            match handle.join() {
                // join 成功 → catch_unwind 的结果：闭包自己的 Ok / Err
                Ok(Ok(Ok(value))) => (key, Ok(value)),
                Ok(Ok(Err(message))) => (key, Err(message)),
                // 闭包 panic 了
                Ok(Err(_)) => (key, Err("这一项没能完成".to_string())),
                // 线程本身 panic 了
                Err(_) => (key, Err("这一项没能完成".to_string())),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密钥只留末四位且加省略号() {
        assert_eq!(key_tail("sk-abcdef12345678"), "…5678");
        assert_eq!(key_tail("abcd"), "abcd");
        assert_eq!(key_tail(""), "");
        assert_eq!(key_tail("  "), "");
    }

    #[test]
    fn 截断超长补省略号() {
        assert_eq!(excerpt("abcdef", 10), "abcdef");
        assert_eq!(excerpt("abcdef", 3), "abc…");
    }

    #[test]
    fn 敏感串被打码() {
        let text = redact("refresh failed: Bearer abcdef1234567890 and sk-1234567890");
        assert!(!text.contains("abcdef1234567890"));
        assert!(text.contains("Bearer [redacted]"));
        assert!(text.contains("sk-[redacted]"));
    }

    #[test]
    fn 裸十六进制长串被打码且消息被截断() {
        let text = redact(&format!("失败: {}", "a".repeat(48)));
        assert!(!text.contains(&"a".repeat(48)));
        assert!(text.contains("[redacted]"));
        assert!(text.chars().count() <= 201);
    }

    #[test]
    fn 公历天数往返一致() {
        for days in [-10_000, -1, 0, 1, 19_000, 30_000] {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
        // 2026-10-21 的前一天跨月
        let october = days_from_civil(2026, 10, 1);
        assert_eq!(civil_from_days(october - 1), (2026, 9, 30));
    }

    #[test]
    fn uid白名单() {
        assert_eq!(sanitize_uid("abc-123_x"), Some("abc-123_x".into()));
        assert_eq!(sanitize_uid("../../evil"), None);
        assert_eq!(sanitize_uid("a b"), None);
        assert_eq!(sanitize_uid(""), None);
        assert_eq!(sanitize_uid(&"x".repeat(65)), None);
        assert!(sanitize_uid("92af3923-a7cb-49e3-af38-a8f39398ae14").is_some());
    }

    #[test]
    fn 轮询周期零值放行其余夹取() {
        assert_eq!(clamp_poll_minutes(0, 5, 60), 0);
        assert_eq!(clamp_poll_minutes(3, 5, 60), 5);
        assert_eq!(clamp_poll_minutes(30, 5, 60), 30);
        assert_eq!(clamp_poll_minutes(90, 5, 60), 60);
    }

    #[test]
    fn 并行按输入顺序收回结果() {
        let jobs: Vec<(String, ParallelJob<String, i64>)> = vec![
            (
                "a".into(),
                Box::new(|key: String| Ok(key.len() as i64)),
            ),
            (
                "bb".into(),
                Box::new(|key: String| Ok(key.len() as i64)),
            ),
            (
                "ccc".into(),
                Box::new(|key: String| Ok(key.len() as i64)),
            ),
        ];
        let results = run_parallel(jobs);
        let keys: Vec<&str> = results.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, vec!["a", "bb", "ccc"]);
        let values: Vec<i64> = results
            .iter()
            .map(|(_, outcome)| outcome.as_ref().ok().copied().unwrap_or(-1))
            .collect();
        assert_eq!(values, vec![1, 2, 3]);
    }

    #[test]
    fn 并行里一项失败只影响它自己() {
        let jobs: Vec<(&str, ParallelJob<&str, i64>)> = vec![
            ("ok", Box::new(|_key: &str| Ok(7))),
            ("bad", Box::new(|_key: &str| Err("读不到".to_string()))),
        ];
        let results = run_parallel(jobs);
        assert_eq!(results[0].1.as_ref().ok().copied(), Some(7));
        assert_eq!(results[1].1.as_ref().ok().copied(), None);
        assert_eq!(results[1].1.as_ref().err().map(String::as_str), Some("读不到"));
    }

    #[test]
    fn 并行里一项炸了不带走其余() {
        let jobs: Vec<(&str, ParallelJob<&str, i64>)> = vec![
            ("before", Box::new(|_key: &str| Ok(1))),
            (
                "boom",
                Box::new(|_key: &str| -> Result<i64, String> { panic!("炸了") }),
            ),
            ("after", Box::new(|_key: &str| Ok(3))),
        ];
        let results = run_parallel(jobs);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].1.as_ref().ok().copied(), Some(1));
        assert_eq!(results[1].1.as_ref().ok().copied(), None);
        assert!(results[1].1.as_ref().is_err());
        assert_eq!(results[2].1.as_ref().ok().copied(), Some(3));
    }

    #[test]
    fn 并行空输入不报错() {
        let jobs: Vec<(u8, ParallelJob<u8, u8>)> = Vec::new();
        assert!(run_parallel(jobs).is_empty());
    }
}
