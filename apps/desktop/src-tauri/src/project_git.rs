//! 项目仓库的提交记录：**只读、本地**。
//!
//! 工作日志的「从提交生成」用它。与笔记 / 技能那几处 git 相比，这里对仓库一个字节都不写：
//! 只跑 `git log` 与 `git config user.email`，不 add、不 commit、不 push，也不碰远端配置。
//!
//! 范围以**项目目录自身**起算（`git log -- .` 在项目路径下跑）：
//! 项目是 monorepo 的子目录时，只带出改过这个子目录的提交，同仓库别的模块不会串进来；
//! 项目自己就是仓库根时，`.` 就是整棵仓库。
//!
//! 返回的是原始提交（哈希 / 作者时间 / 作者邮箱 / 标题）。按天分组、只留自己的、
//! 已导入的去重这些语义都在 `@workbench/work-log` 的 `git-import.ts` 里 ——
//! 那儿有单测，改口径不用重编 Rust。

use serde_json::{json, Value};
use std::path::Path;

use crate::sync::{describe, run, GIT_TIMEOUT};

/// 一次最多读多少条。个人项目一个月远到不了这个数；真到了说明范围开得太大，
/// 少的是最早那几条，而不是最新的一批。
const MAX_COMMITS: usize = 1000;

/// 读一个项目目录的提交。
///
/// `since` / `until` 是毫秒时间戳（调用方按选中那天的前后各放一天算好）：
/// 拿它们做 git 的 `--since` / `--until` **粗筛**，精确到天的过滤留给调用方 ——
/// git 这两个参数按提交时间算，而分组按作者时间，两者在 rebase / cherry-pick 之后
/// 会差很远，不能拿它们当边界。
///
/// 不是 git 仓库时返回 `isRepo: false`（这是正常情况，不是错误）；
/// 目录不存在、git 起不来、git 自己报错才是 `Err`。
pub fn log(dir: &str, since: Option<i64>, until: Option<i64>) -> Result<Value, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("还没有选择项目文件夹".into());
    }

    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("找不到项目文件夹：{dir}"));
    }

    let since_arg = since.map(|ms| format!("--since=@{}", (ms.max(0) / 1000)));
    let until_arg = until.map(|ms| format!("--until=@{}", (ms.max(0) / 1000)));
    let max_arg = format!("--max-count={MAX_COMMITS}");
    let mut args: Vec<&str> = vec![
        "log",
        // 分支上还没合回来的提交也算：当天切过分支再切走，工作记录不该少一截。
        // 重复由 git 自己按提交去重，作者过滤与日期过滤在调用方。
        "--all",
        // 合并提交不产生「做了什么」，只会把两个分支的标题重复一遍
        "--no-merges",
        "--format=%H%x1f%at%x1f%ae%x1f%s",
    ];
    if let Some(arg) = &since_arg {
        args.push(arg.as_str());
    }
    if let Some(arg) = &until_arg {
        args.push(arg.as_str());
    }
    args.push(max_arg.as_str());
    args.push("--");
    args.push(".");

    let outcome = run(&args, Some(root), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err("读取项目提交记录超时".into());
    }
    if !outcome.ok() {
        // 不是仓库：按「没有可导入的」处理，别让一条失败提示打断整批生成。
        // 只看 stderr/stdout 里那一句，git 换了措辞时仍会落到下面的正常失败路径。
        let detail = format!("{}\n{}", outcome.stdout, outcome.stderr);
        if detail.contains("not a git repository") {
            return Ok(json!({ "isRepo": false, "userEmail": "", "commits": [] }));
        }
        return Err(describe("log", &outcome));
    }

    // 仓库配了身份就带回去（作者过滤在 TS 侧做）；读不到只是空串，不是错误
    let user_email = run(&["config", "user.email"], Some(root), GIT_TIMEOUT)
        .map(|outcome| outcome.stdout.trim().to_string())
        .unwrap_or_default();

    let mut commits: Vec<Value> = Vec::new();
    for line in outcome.stdout.lines() {
        // 提交标题里理论上可以有任意字符，所以用单元分隔符切；splitn 让标题那一段
        // 即便混进分隔符也能原样留下
        let mut parts = line.trim_end().splitn(4, '\u{1f}');
        let (Some(hash), Some(seconds), Some(email), Some(subject)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };

        let Ok(seconds) = seconds.trim().parse::<u64>() else {
            continue;
        };
        let subject = subject.trim();
        if hash.trim().is_empty() || subject.is_empty() {
            continue;
        }

        commits.push(json!({
            "hash": hash,
            // %at 是秒；渲染层统一用毫秒
            "time": seconds.saturating_mul(1000),
            "authorEmail": email,
            "subject": subject,
        }));
    }

    Ok(json!({
        "isRepo": true,
        "userEmail": user_email,
        "commits": commits,
    }))
}
