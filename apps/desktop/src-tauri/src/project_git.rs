//! 项目仓库的 git 操作：提交记录（只读）与用户显式触发的 `git pull`。
//!
//! 工作日志的「从提交生成」走 `log()`：对仓库一个字节都不写，只跑 `git log` 与
//! `git config user.email`，不 add、不 commit、不 push，也不碰远端配置。
//!
//! `pull()` 对应项目卡「⋯」里的 git pull，**只在用户点它时才跑**：只做快进，不合并 /
//! 不 rebase、不 autostash，分叉与未提交改动都交给用户自己处理。
//!
//! 范围以**项目目录自身**起算（`git log -- .` 在项目路径下跑）：
//! 项目是 monorepo 的子目录时，只带出改过这个子目录的提交，同仓库别的模块不会串进来；
//! 项目自己就是仓库根时，`.` 就是整棵仓库。
//!
//! 返回的是原始提交（哈希 / 作者时间 / 作者邮箱 / 标题）。按天分组、只留自己的、
//! 已导入的去重这些语义都在 `@workbench/work-log` 的 `git-import.ts` 里 ——
//! 那儿有单测，改口径不用重编 Rust。

use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

use crate::sync::{describe, run, run_git_quiet, GIT_TIMEOUT};

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

/// 一次 git pull 的结果：当前分支 + 有没有拉到新提交（界面据此选提示语）。
// @contract
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitPull {
    pub branch: String,
    pub received: bool,
}

/// 用户点项目卡的 git pull 时走这里：在项目目录里跑一次 `git pull --ff-only`。
///
/// 只快进：本地和远端都动过（分叉）或有未提交改动时，git 自己会拒绝，用户拿到原话后
/// 自己处理。这里**不** `--autostash`、不 rebase、不替用户合并 —— 项目仓库的现场
/// 不该被应用改写；`--ff-only` 也保证不会凭空多出一个合并提交。
///
/// 凭据只用系统 git 已存的那一套（`run()` 默认只带 `GIT_TERMINAL_PROMPT=0`），
/// **不注入同步仓库的账号 token**：那是发给应用自己的同步仓库的，不该被带到项目的
/// 远端去。超时与失败都收敛成一句给用户看的话。
pub fn pull(dir: &str) -> Result<ProjectGitPull, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("还没有选择项目文件夹".into());
    }

    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("找不到项目文件夹：{dir}"));
    }
    // 不是仓库时 git 也会报，但这句话更短、更像给人看的；`--is-inside-work-tree`
    // 也认「项目是 monorepo 子目录」—— 拉的是它所在的那棵仓库，和命令行里一样
    if !run_git_quiet(&["rev-parse", "--is-inside-work-tree"], root) {
        return Err("这个项目文件夹不是 git 仓库".into());
    }

    let branch = stdout_of(root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let before = stdout_of(root, &["rev-parse", "HEAD"]);

    let outcome = run(&["pull", "--ff-only"], Some(root), GIT_TIMEOUT)?;
    if outcome.timed_out {
        return Err("git pull 超时（网络不通或被防火墙拦了）".into());
    }
    if !outcome.ok() {
        return Err(describe("pull", &outcome));
    }

    Ok(ProjectGitPull {
        branch,
        // HEAD 变过才算「拉到了新提交」；Already up to date 时两次读到的是同一个哈希
        received: before != stdout_of(root, &["rev-parse", "HEAD"]),
    })
}

/// 读一条 git 命令的 stdout；读不到给空串 —— 拉取本身成功时，这两个值只影响
/// 提示语怎么写，不该把一次成功的 pull 报成失败。
fn stdout_of(root: &Path, args: &[&str]) -> String {
    run(args, Some(root), GIT_TIMEOUT)
        .map(|outcome| outcome.stdout.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc;
    use crate::sync::GIT_ENVS;

    fn git_ok(args: &[String], cwd: Option<&Path>) {
        let outcome = proc::run_direct("git", args, GIT_TIMEOUT, cwd, &GIT_ENVS).unwrap();
        assert!(outcome.ok(), "git {args:?} 失败: {}", outcome.stderr);
    }

    fn git(args: &[&str], cwd: Option<&Path>) {
        git_ok(&args.iter().map(|arg| (*arg).to_string()).collect::<Vec<_>>(), cwd);
    }

    /// 真跑一遍：A 推一笔 → B 拉下来（快进）→ 再拉一次应当「没有新提交」。
    /// 用本地裸仓库当远端，不碰网络、不需要凭据。
    #[test]
    fn pull_fast_forwards_and_second_time_receives_nothing() {
        if proc::probe_version("git").is_none() {
            eprintln!("跳过：本机没有 git");
            return;
        }

        let root = std::env::temp_dir().join(format!("wb-project-pull-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote.git");
        let work_a = root.join("a");
        let work_b = root.join("b");
        std::fs::create_dir_all(&root).unwrap();

        let remote_s = remote.to_string_lossy().into_owned();
        let work_a_s = work_a.to_string_lossy().into_owned();
        let work_b_s = work_b.to_string_lossy().into_owned();

        git(&["init", "--bare", remote_s.as_str()], None);
        // 裸仓库的默认分支显式指向 main，克隆出来的两个工作区都在同一条分支上
        git(&["symbolic-ref", "HEAD", "refs/heads/main"], Some(&remote));
        git(&["clone", remote_s.as_str(), work_a_s.as_str()], None);
        git(&["config", "user.email", "workbench@localhost"], Some(&work_a));
        git(&["config", "user.name", "Workbench"], Some(&work_a));

        std::fs::write(work_a.join("first.txt"), "one").unwrap();
        git(&["add", "first.txt"], Some(&work_a));
        git(&["commit", "-m", "first"], Some(&work_a));
        git(&["push", "-u", "origin", "main"], Some(&work_a));

        // B 在 A 第一笔提交之后才克隆，所以它一开始就是最新的
        git(&["clone", remote_s.as_str(), work_b_s.as_str()], None);

        std::fs::write(work_a.join("second.txt"), "two").unwrap();
        git(&["add", "second.txt"], Some(&work_a));
        git(&["commit", "-m", "second"], Some(&work_a));
        git(&["push", "origin", "main"], Some(&work_a));

        let pulled = pull(work_b_s.as_str()).unwrap();
        assert_eq!(pulled.branch, "main");
        assert!(pulled.received, "A 推了新提交，B 应当拉到");
        assert_eq!(std::fs::read_to_string(work_b.join("second.txt")).unwrap(), "two");

        let again = pull(work_b_s.as_str()).unwrap();
        assert!(!again.received, "已经是最新时不该报有新提交");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 不是仓库的目录给一句明确的提示，而不是把 git 那句 fatal 原样甩出来。
    #[test]
    fn pull_rejects_non_repo_directory() {
        let root = std::env::temp_dir().join(format!("wb-project-pull-norepo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let result = pull(root.to_string_lossy().as_ref());
        let _ = std::fs::remove_dir_all(&root);
        assert!(result.unwrap_err().contains("不是 git 仓库"));
    }
}
