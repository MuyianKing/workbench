# Git 页

Git 页的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`apps/desktop/src-tauri/src/repo_git.rs`（只读的 git 命令与解析）、
`packages/git/src/parse.ts`（回包收敛）、`packages/git/src/patch.ts`（统一 diff 行模型）、
`apps/desktop/src/renderer/src/stores/git.ts`（页面状态）、`apps/desktop/src/renderer/src/components/git/`（页面与组件）。

- **只读**：这一页只跑 `rev-parse` / `log` / `ls-tree` / `show` / `diff` / `cat-file -s`，
  绝不 `add` / `commit` / `checkout` / `switch` / `push` / `pull` / `fetch` / `gc`。
  没有暂存、提交、分支管理、推拉这些入口 —— 那是另一件事，别顺手加进来。
- **只在本机、只读用户在这一页打开的仓库**：仓库根由 `git rev-parse --show-toplevel` 得到，
  之后每条命令都以它为工作目录（用户选中的可以是仓库里的子目录）。不联网、不新增网络出口、
  不写仓库、不碰远端配置。这条是对 [AGENTS.md](../../AGENTS.md) 第 1 节 git 范围的扩展：
  这里多了一处「用户自己打开的仓库」，**仍然只读**。
- **不让仓库配置执行外部程序**：diff / show 一律带 `--no-ext-diff` 与 `--no-textconv`；
  带 pathspec 的命令一律带 `--literal-pathspecs`（文件名里的 `*` / `?` / `[` 不是通配符）；
  全局再挂 `--no-pager`（见 `sync.rs` 的 `GIT_GLOBAL_ARGS`）。仓库里的 `.gitattributes`
  或 `diff.external` 不该因为「看一眼历史」就被执行。
- **提交号与路径都是命令行参数**：提交号只认 7 ~ 64 位十六进制（`check_hash`）；路径只认仓库内相对路径，
  拒绝盘符、开头的 `/`、`..` 与空段（`check_rel_path`）。命令直启 `git.exe`，参数不经过 shell。
- **输出有上限**：提交一页 50 条（最多 200）；一个目录最多回 5000 项；一次提交 / 对比最多列 1000 个文件；
  单侧文件超过 1 MB 不取补丁；补丁最多回 2 MB。`proc::collect` 会把 stdout 全收进内存，
  上限是这条链路的边界，别把某个 `--max-count` 去掉。
- **非 UTF-8 按字节收**：补丁走 `proc::run_direct_bytes`，再 `String::from_utf8_lossy` 解码并标 `lossy`。
  不能用 `read_to_string` —— 遇到非法 UTF-8 会提前中断，看起来就像补丁被截断。
- **v1 不做重命名跟踪**：提交间 diff 用 `--no-renames`，文件历史用 `git log -- <path>`（不 `--follow`）。
  重命名会被拆成「删旧 + 加新」，改名前的历史不显示。这是有意的取舍：列表里是旧名、点进去却查不到，
  比「看不到改名前的几笔」更让人困惑。要加跟踪时，列表、补丁路径与文件历史三处必须一起改。
  同理，**已删除的文件不在 HEAD 的树里**，也就没有入口（以后可以加一个「已删除文件」视图）。
- **空仓库、根提交、合并提交**：空仓库也能打开（`empty: true`，不报错）；
  根提交用 `git show` 取补丁（没有父提交，`base` 是空串）；合并提交只对比第一父提交，界面上标明。

## 实现

- 页面登记在 `packages/appearance/src/views.ts`（`git`，排在末尾），导航图标在
  [NavRail.vue](../../apps/desktop/src/renderer/src/components/NavRail.vue) 的 `ICONS`，
  页面组件在 [App.vue](../../apps/desktop/src/renderer/src/App.vue) 的 `VIEWS`。
  上次打开的仓库根存在设置的 `gitRepo` 里（`sanitizeNoteRoot` 收敛，**不进 theme.json**、不参与同步）；
  仓库不在了只提示、不悄悄清掉路径（可能是移动硬盘 / 网络盘）。
- 三栏：左栏是 HEAD 的目录树（`el-tree` 懒加载，展开一层问一次 `ls-tree`），中栏是提交列表
  （整仓库 / 某个文件两种来源），右栏是提交详情与补丁。点文件 = 中栏切到它的历史；
  点提交 = 右栏看它相对第一父提交的改动；点行尾「对比」= 选基准 / 目标，第二次点另一个提交就取两者差异。
- 分页：提交列表一页 50 条，滚动到底再取下一页；`hasMore` 由宿主多取一条判断。
  文件历史不分页以外的特殊处理 —— 它是同一套列表，只是 `historyPath` 有值。
- 补丁是**统一 diff**（`git diff -U3`），由 `packages/git/src/patch.ts` 拆成
  「hunk / 增 / 删 / 上下文 / 说明」的行模型，行号与增删标记在组件里画。
  没有用 `@workbench/core` 的 `buildDiffRows`：那一份要两侧完整文本（技能对比弹窗的场景），
  Git 这边只从 git 拿补丁，没有理由把上下文之外的几万行也取回来。
- 二进制文件不取行级差异（`--numstat` 的 `-` 与补丁里的 `Binary files` 两处都判）；
  单侧超过 1 MB 时宿主直接回 `tooLarge`，不跑 diff。
- 提交详情走 `git show -s --format=...`（`%B` 是完整说明，`%P` 是父提交）；
  改动清单走 `git diff --numstat -z --no-renames` 与 `--name-status -z --no-renames` 两条，
  状态、增删行数与二进制标记在 Rust 侧合并成一份数组。
- 目录树的 `ls-tree -z -l` 用 NUL 分隔（中文名、带换行的路径都不会被劈开）；
  目录在前、同层按名字（不区分大小写）排。子模块标「子模块」，点击只看它指针变化的提交。
- 补丁读取前先用 `git cat-file -s <rev>:<path>` 查两侧大小；根提交的 `base` 是空串，
  此时用 `git show --format= <hash> -- <path>`，非根用 `git diff <base> <hash> -- <path>`。
- 页面状态在 `stores/git.ts`：每个异步动作带令牌（打开仓库 / 历史 / 详情 / 对比 / 补丁各一个），
  连点两个文件或提交时只有最后一个算数；选中提交或开始对比时会把另一边清掉。

## 涉及文件

```
  src/repo_git.rs        Git 页的只读宿主：仓库信息 / 提交 / 目录树 / 文件历史 / 提交差异 / 补丁
  src/proc.rs            子进程原语；run_direct_bytes 给补丁按字节收输出
  src/sync.rs            git 管道（全局参数 / 环境 / 超时）与 run_bytes
  packages/git           回包收敛（parse.ts）、统一 diff 行模型（patch.ts）与类型（types.ts）
  workbench/git.ts       通道适配（invoke + parse，失败收敛成 Result）
  stores/git.ts          页面状态：仓库 / 历史来源 / 选中提交 / 对比 / 补丁
  components/git/        GitView / GitFileTree / GitCommitList / GitDiffPane / GitChangedFiles / GitPatchView
```
