---
name: git-commit-push
version: 0.1.0
description: 把本次会话的改动提交并推送到远程（没说「全部」就只提交本次会话改过的文件），目标分支有歧义时先确认分支（只有一个分支则不确认）。当用户说“提交代码”“提交所有改动并推送”“commit and push”“推一下”“/git-commit-push”，或要求把项目代码提交到远程时使用。只做提交+推送，不创建 PR、不做代码审查、不强制推送。
metadata:
  requires:
    bins: ["git"]
---

# 提交本次会话的改动并推送

目标：把本次会话改过的文件（未说明「全部」时不含工作区里其它无关改动）提交，并推送到远程。

## 不可越过的规则

1. **分支确认是唯一的确认点**：目标分支有歧义时用 `AskUserQuestion` 问清“提交并推送到哪个分支”，确认前不要 commit、不要 push；确认之后不必再问“是否继续”。**只有一个本地分支（就是当前分支）时不确认**，直接提交并推送，报告里写明推到了哪个分支 / 远程。
2. **绝不执行破坏性或绕过操作**：`push --force`、`--force-with-lease`、`--no-verify`、`reset --hard`、`rebase`、`commit --amend`（除非用户在本轮明确要求）。
3. **推送被拒绝就停止**：不自动 pull / merge / rebase，报告领先/落后情况，交给用户决定。
4. **不加尾注**：不写 `Generated with ...`、`Co-Authored-By:` 之类的内容。
5. **提交范围默认只含本次会话的改动**：没特殊说明（没说「全部改动」「提交所有」）就只暂存本次会话里实际改过的文件，**不写 `git add -A`**。
6. **作用于整个仓库**：工作目录可能是仓库子目录，先用 `git rev-parse --show-toplevel` 定位仓库根，所有操作针对整个仓库。
7. 展示含中文的路径时加 `-c core.quotepath=false`，避免文件名变成 `\346\226\207` 形式。

## 第 1 步：检查仓库与工作区

一次性收集（可并行执行）：

```bash
git rev-parse --show-toplevel
git status --porcelain=v1 -b
git branch --show-current
git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads
git remote -v
git log --oneline -10
git diff --name-only --diff-filter=U
```

判定：

- `rev-parse` 失败 → 不是 git 仓库：停止，说明“当前项目不是 git 仓库”，**不要** `git init`。
- `branch --show-current` 为空（分离头指针）→ 停止，告诉用户需要先切到分支；可以建议 `git switch -c <name>`，但等用户确认后再做。
- 存在未解决的冲突或进行中的 merge/rebase → 停止并报告，不要提交。
- 工作区干净：
  - `status -sb` 显示 `ahead N` → 仍有未推送的提交：走第 2 步确认分支，确认后跳过提交，直接推送（第 5 步）。
  - 既无改动也无领先提交 → 报告“没有需要提交或推送的改动”，结束。

## 第 2 步：确认分支（只在有歧义时）

先看第 1 步拿到的分支列表与远程列表：**只有一个本地分支（就是当前分支）时跳过本步**，直接进第 3 步；
远程唯一但有多个本地分支时，仍需按下面提问选分支（问题里写明目标远程）。

用 `AskUserQuestion` 提问，语言跟随用户。默认中文：

> 确认提交并推送到哪个分支？

选项（第一个为推荐项，最后一个是取消）：

1. **当前分支**：label 形如 `main（当前分支，推荐）`；description 写明“N 个文件变更，将提交并推送到 `origin/main`”。
2. 再列 0–2 个最近使用的本地分支（取第 1 步分支列表的前几位，排除当前分支）；description 写明“将切换到该分支后提交并推送”。
3. **取消操作**：不做任何修改。

总选项不超过 4 个。

- 用户选了其他分支：`git switch <branch>`（不加 `-f`、不加 `--discard-changes`）。失败就停止并原样展示错误（常见原因是本地改动与该分支冲突）。
- 用户通过 Other 给出不存在的分支名：用 `git switch -c <name>` 新建。
- 用户选择取消：停止，不产生任何改动。
- 远程选择：优先 `origin`；没有 origin 但有唯一远程就用它；有多个远程且没有 origin 时，在确认前用同一个问题或一次追问确定目标远程，不要猜。

## 第 3 步：暂存本次会话的改动

先看暂存区里有没有用户自己预置的内容：

```bash
git -c core.quotepath=false diff --cached --name-only
```

- 有：报告这些已暂存文件，问用户「一起提交」还是「清出暂存区、只提交本次会话改动」；清出用
  `git restore --staged <files>`（未跟踪文件回到未跟踪状态），**不要**动工作区内容，也别 `git rm --cached`（除 unborn HEAD）。
- 无：把本次会话改过的文件逐个加进去（新增、修改、删除都要），**用路径显式指定**：

  ```bash
  git add -- <path1> <path2> ...
  ```

  **只有用户明确要求提交全部改动时才用 `git add -A`**（它遵守 `.gitignore`，仍不要用 `-f` 强加被忽略的文件）。
- 会话里没有可识别的改动（用户要求提交的范围在工作区里查不到差异）：如实说明，不要默认扫整个工作区当「全部改动」提交。

然后核对范围就是这次会话该有的那些文件：

```bash
git -c core.quotepath=false diff --cached --stat
git -c core.quotepath=false status --short
```
- 敏感文件检查：如果暂存列表出现 `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.keystore`、`id_rsa*`、`credentials*`、`secrets*`，用 `AskUserQuestion` 让用户选择“排除这些文件后提交”（推荐）或“一并提交”。排除方式：

  ```bash
  git restore --staged <files>
  ```

  未跟踪的敏感文件被 `restore --staged` 后会回到未跟踪状态，不会被提交。若仓库还没有任何提交（unborn HEAD，`restore --staged` 报 `could not resolve 'HEAD'`），改用 `git rm --cached -r -- <files>`。
- 大于 10MB 的文件只提示，不阻塞。
- 暂存后执行 `git diff --cached --quiet`；返回 0 表示没有实际内容可提交（可能改动都在忽略列表里），报告并结束。

## 第 4 步：生成提交信息并提交

提交信息采用 **Conventional Commits + emoji 主题**：`<emoji> <类型>: <简述>`（emoji 在前，后跟一个空格、小写类型、冒号、一个空格，简述用中文）。

类型与 emoji 一一对应，按改动性质挑选唯一类型（主题里只放该类型对应的 emoji，不放其它）：

| 类型 | emoji | 用途 |
| --- | --- | --- |
| `feat` | ✨ | 新增功能 |
| `fix` | 🐛 | 修复缺陷 |
| `docs` | 📝 | 文档变更 |
| `style` | 💄 | 代码格式（不影响功能，例如空格、分号等格式修正） |
| `refactor` | ♻️ | 代码重构（不包括 bug 修复、功能新增） |
| `perf` | ⚡️ | 性能优化 |
| `test` | ✅ | 添加疏漏测试或已有测试改动 |
| `build` | 📦️ | 构建流程、外部依赖变更（如升级 npm 包、修改 vite 配置等） |
| `ci` | 🎡 | 修改 CI 配置、脚本 |
| `revert` | ⏪️ | 回滚 commit |
| `chore` | 🔨 | 对构建过程或辅助工具和库的更改（不影响源文件、测试用例） |

用户给出的带 `emoji` 字段的配置源（形如 `:sparkles:` / `:bug:` 的短码）等价于上表 emoji：`:sparkles:`→✨、`:bug:`→🐛、`:memo:`→📝、`:lipstick:`→💄、`:recycle:`→♻️、`:zap:`→⚡️、`:white_check_mark:`→✅、`:package:`→📦️、`:ferris_wheel:`→🎡、`:rewind:`→⏪️、`:hammer:`→🔨。主题里写 emoji 本身，不写短码。

- 参考 `git log --oneline -10` 的语言和风格：历史用中文就写中文，历史用 Conventional Commits 就沿用（如 `🐛 fix: ...`、`✨ feat: ...`）。
- 信息基于实际 staged diff 归纳，写清改了什么，避免“update code”“修改文件”这类空话。
- 用 heredoc 传入，避免 Windows 下引号、换行和编码问题：

  ```bash
  git commit -F - <<'MSG'
  <emoji> <类型>: <一句话主题>

  - <要点 1>
  - <要点 2>
  MSG
  ```

- 不加任何尾注。
- 提交失败（hook 拒绝、身份未配置等）：原样展示错误并停止，**不要**加 `--no-verify`。若提示 `Please tell me who you are`，告诉用户配置 `user.name` / `user.email`，不要替用户编造身份。

## 第 5 步：推送

先判断 upstream：

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

- 有 upstream：`git push`
- 无 upstream：`git push -u <remote> <branch>`
- 没有配置任何远程：停止，报告“仓库未配置远程”，不要自动添加。

推送失败处理：

- `rejected` / non-fast-forward：先 `git fetch <remote>`，再用 `git status -sb` 和 `git rev-list --left-right --count HEAD...@{u}` 报告本地领先/落后数量，然后停止。不自动 pull/rebase，不 force。
- 认证或权限错误：原样展示关键错误信息，提示检查凭据，停止。
- 网络/超时：报告后停止，不无限重试。

## 第 6 步：验证并报告

```bash
git log --oneline -1
git status -sb
git rev-parse --short HEAD
```

确认 `status -sb` 不再显示 `ahead N`（即本地与远程一致）。用简短列表报告：

- 分支：`main` → `origin/main`
- 提交：`a1b2c3d` 提交信息首行
- 变更：本次会话 12 个文件（+84 / -12）；工作区还有 3 个未纳入的文件（已原样保留）
- 结果：已推送，本地与远程一致

如果本轮没有新提交、只是推送了已有提交，明确说明“无新提交，已推送 N 个提交”。
