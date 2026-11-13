# 发版

发版走 `.github/workflows/release.yml`：push 一个 `vX.Y.Z` 的 tag → 先过闸（typecheck + 单元测试）
→ 在 windows-latest 上打 Windows x64 的 NSIS 安装包 → 建 Release 并挂上安装包。
日常提交不触发（每次提交的校验在 `ci.yml`）。**流水线里的完整约定（代码签名、runner 与产物路径等）
写在 [release.yml](../../.github/workflows/release.yml) 头部注释里**，这里只记本机要做的动作。

## 版本号先写进仓库，再打 tag

tag 不住在源码里，所以版本必须在打 tag 之前就真的写进仓库并提交一笔 —— 这样 clone 那个 tag 出来
就是那个版本，本地 `pnpm run dist` 打的包不会与发布包同名不同版本。

```bash
pnpm run bump 0.2.1     # 写进根 package.json / apps/desktop/package.json / tauri.conf.json /
                        # Cargo.toml + Cargo.lock，并把 CHANGELOG 的「未发布」升成「[0.2.1] - 今天」；
                        # 输出里会打印该 git add 哪几处（packages/* 是私有子包，钉 0.0.0 不参与版本）
# 按它给的 git add / git commit（chore: 版本号 0.2.1）提交那一笔，然后：
git tag v0.2.1 && git push origin main v0.2.1
```

流水线只**校验**（`pnpm run bump --check <版本>`，就是 [bump-version.mjs](../../scripts/bump-version.mjs)
这一个脚本、同一份清单）：tag 与仓库里那几处版本对不上，或 [CHANGELOG.md](../../CHANGELOG.md)
里这一版那一节还没写条目，都停在版本校验那一步，提示先跑 bump —— 不替谁改文件。
这一步故意放在装 Rust / 编依赖之前：打错 tag 是最常见的失手，不该等十几分钟才知道。

## 变更记录与 Release 正文

变更记录写在 [CHANGELOG.md](../../CHANGELOG.md)，分「新特性 / 修复 / 调整」三档，平时记在
`## [未发布]` 那一节（bump 会把它升成正式版本节）。Release 正文 = 这一版本节开头 + GitHub
自动生成的 `**Full Changelog**: …/compare/上一个 tag...这个 tag` 那段（由 `--notes` 与
release-notes API 取，见流水线注释）。

tag 可以带预发布后缀（如 `v0.2.1-rc.1`），那样 Release 标成 prerelease；同一个 tag 重跑是更新
已有那条、不重复建。

## 让发布出来的包「登录可用」

给仓库配一个 `OAUTH_LOCAL_JSON` Secret，内容就是本机 `apps/desktop/src-tauri/oauth.local.json`
的原文（形状见同目录 `oauth.example.json`）。没配也能构建，只是那个包里登录按钮显示「未内置凭据」。

## 其它前置

- **git**：Token 多机同步、笔记图片上传、笔记 / 知识库 / 技能库同步这些功能需要系统里有 `git`
  （`git --version` 有输出即可）；想让笔记或知识库同步，得先自己把那个文件夹做成连了远端的仓库
  （`git clone` 一个下来，或在文件夹里 `git init` + `git remote add origin <地址>`）再把文件夹选进来 ——
  应用不替你创建仓库、也不替你接远端；没有仓库的文件夹就是本机的笔记 / 知识库，页面上连同步按钮都不出现。
- **Node 22.19 或更新**：AI 助手那页的 Pi 已随应用内置（开源编码 Agent，不给安装包多背一个 Node），
  不用另装；只需要系统里有这个版本的 Node 来跑内置的那份。

这些功能的边界见[功能与架构·数据与隐私](../features-and-architecture.md#数据与隐私) 与
[AI 助手](../modules/ai.md)。
