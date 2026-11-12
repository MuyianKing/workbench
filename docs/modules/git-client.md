# Git 页

Git 页的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`apps/desktop/src-tauri/src/repo_git.rs`（只读的 git 命令与解析）、
`packages/git/src/parse.ts`（回包收敛）、`packages/git/src/patch.ts`（统一 diff 行模型）、
`packages/git/src/repos.ts`（最近打开清单的收敛）、
`apps/desktop/src/renderer/src/stores/git.ts`（页面状态）、`apps/desktop/src/renderer/src/components/git/`（页面与组件）。

- **只读**：这一页只跑 `rev-parse` / `for-each-ref` / `log` / `ls-tree` / `show` / `diff` / `cat-file -s`，
  绝不 `add` / `commit` / `checkout` / `switch` / `push` / `pull` / `fetch` / `gc`。
  没有暂存、提交、切工作区、推拉这些入口 —— 那是另一件事，别顺手加进来。
  **「切换分支」是只读浏览**：分支下拉只把 `log` / `ls-tree` 的 ref 换成另一条 `refs/heads/*`，
  工作区与 HEAD 都不动；界面上正在看别的分支时 chip 带「未切换」标记。
- **只在本机、只读用户在这一页打开的仓库**：仓库根由 `git rev-parse --show-toplevel` 得到，
  选中目录相对根的位置（`scope`）由 `--show-prefix` 得到，之后每条命令都以仓库根为工作目录
  （用户选中的可以是仓库里的子目录，也可以只是外层仓库里的一个子项目）。不联网、不新增网络出口、
  不写仓库、不碰远端配置。这条是对 [AGENTS.md](../../AGENTS.md) 第 1 节 git 范围的扩展：
  这里多了一处「用户自己打开的仓库」，**仍然只读**。
- **不让仓库配置执行外部程序**：diff / show 一律带 `--no-ext-diff` 与 `--no-textconv`；
  带 pathspec 的命令一律带 `--literal-pathspecs`（文件名里的 `*` / `?` / `[` 不是通配符）；
  全局再挂 `--no-pager`（见 `sync.rs` 的 `GIT_GLOBAL_ARGS`）。仓库里的 `.gitattributes`
  或 `diff.external` 不该因为「看一眼历史」就被执行。
- **提交号、路径与分支名都是命令行参数**：提交号只认 7 ~ 64 位十六进制（`check_hash`）；路径只认仓库内相对路径，
  拒绝盘符、开头的 `/`、`..` 与空段（`check_rel_path`）；分支名会拼成 `refs/heads/<name>` 再交给 git
  （`rev_spec`，拒绝 `-` 开头与控制字符），空串 = `HEAD`。命令直启 `git.exe`，参数不经过 shell。
- **输出有上限**：提交一页 50 条（最多 200）；一个目录最多回 5000 项；一次提交 / 对比最多列 1000 个文件；
  单侧文件超过 1 MB 不取补丁；补丁最多回 2 MB。`proc::collect` 会把 stdout 全收进内存，
  上限是这条链路的边界，别把某个 `--max-count` 去掉。
- **补丁只取当前选中的那一个文件**：右侧改动文件清单是选择器，点一行才取一行的补丁。
  不照着 GitHub 把整次提交的所有 diff 一起取回来堆在同一页 —— 那会直接撞上「1000 个文件 × 2 MB」的边界。
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
  上次**打开的那个文件夹**存在设置的 `gitRepo` 里（`sanitizeGitRepoRoot` 收敛，**不进 theme.json**、不参与同步）；
  它是仓库里的子目录也可以（`.git` 可能在外层），页面按它恢复、目录树也只展开这个子树；
  打不开只提示、不悄悄清掉路径（可能是移动硬盘 / 网络盘）。
- 头部两颗名字各带一个下拉：
  - **仓库名** → 三组：**项目**（项目页里的项目，顺序跟项目页一致；直接用项目目录打开，目录不存在的置灰）、
    **最近打开的文件夹**（设置里的 `gitRepos`，最近打开在前、最多 10 个、由
    `packages/git/src/repos.ts` 去重收敛）与「打开其他文件夹…」。最近打开里会去掉与项目重复的文件夹；
    存的是用户选中的那个文件夹（不一定是仓库根），成功打开时把它排到最前面，换回来时目录树还停在同一个子树。
    **还没打开仓库（或上次那个打不开）的空态里也有同一份菜单**：空态动作区在「打开仓库」左边多一颗下拉按钮
    （有项目时叫「选择项目」，只剩最近打开时叫「最近打开」），不用先去系统文件选择器里翻目录；
    两处共用 `components/git/GitRepoMenu.vue`，别各写一份。
  - **分支名** → `refs/heads` 的本地分支清单（`for-each-ref --sort=-committerdate`，最近提交的在前）。
    选中一条只是换 `viewBranch`：中间的历史、左栏的目录树与文件历史都带上它，`resetDetail` / `resetCompare`
    清掉右侧；工作区与 HEAD 不动。`viewBranch` 为空串 = 跟着 HEAD；正在看别的分支时 chip 挂「未切换」。
    刷新会保住原来那条分支（它被删掉了才退回 HEAD）；detached HEAD 时下拉里多一条说明，
    选中分支后照旧只读浏览。
- 三栏：左栏是**用户选中的那个文件夹**（`scope`）的目录树（`el-tree` 懒加载，展开一层问一次 `ls-tree`），
  中栏是提交列表（整仓库 / 某个文件两种来源），右栏是提交详情与补丁。点文件 = 中栏切到它的历史；
  点提交 = 右栏看它相对第一父提交的改动；右下角的「对比」平时不占位，悬停 / 键盘聚焦或已经
  选成基准 / 目标时才浮出来（不常驻一列按钮），点它 = 选基准 / 目标，第二次点另一个提交就取两者差异。
  列表行只写标题 / 作者 / 时间 / 引用与合并标记，**不显示短提交号**（那对认出这一笔没有帮助）；
  短号只在右栏详情与对比条里保留。
  `scope` 由 `open` 用 `git rev-parse --show-prefix` 得到（空串 = 仓库根本身）：`.git` 可能在外层，
  用户只想看自己那个子项目；**提交 / 文件历史 / 补丁仍按仓库根解释路径**，树节点带的也是仓库相对路径。
  换的分支上没有这个子目录时，宿主回空清单（`cat-file -t` 先判类型），不报读取失败。
- 三处栏宽都可拖：文件树 / 提交列表 / 右栏里的改动文件清单分别住在 `theme.json` 的
  `gitTreeWidth` / `gitHistoryWidth` / `gitFilesWidth`（与笔记 / 视频 / 邮箱页同一套做法：
  把手是通用的 `PanelResizer`，拖动只改本地跟手，松手才落盘；越界由 `clampGit*Width` 收敛）。
- 这一页信息密度高，原先几乎全靠 `--fs-micro` / `--fs-meta` 两档（10.5 / 12px）。
  字号在 `.git-view` 上整体上调一档（`micro` 12 / `meta` 13 / `body` 14），子组件的 scoped 样式
  都取这些令牌，会一起跟着变；两个下拉挂在 body 上，字号在 global.css 里单独补到 `--fs-meta`。
- 右栏下半截分两列：左边是**竖排的改动文件清单**（状态字母 + 路径 + 增删数，纵向滚动），
  右边是选中文件的补丁；补丁栏首行写文件名与增删数，右上角切「并排 / 统一」。
  文件多时清单自己滚，不挤占补丁的横向空间 —— 原来那条横向文件条在十几个文件时就要来回拖。
- 提交 / 对比加载完默认打开哪个改动文件：优先**当前正在看的历史来源**（左栏点开的那个文件，
  从文件历史点进来的提交一定包含它），它不在改动清单里时才是第一个；选中行会自动滚进清单可视区，
  文件多时不至于「高亮了但看不见」。
- 补丁两种视图：**并排（默认）** 把 `git diff -U3` 的连续删除块与新增块按顺序一一配成「修改行」
  （左旧右新，配剩的单边显示），配对口径在 `packages/git/src/patch.ts` 的 `buildSplitRows`（有单测）；
  **统一** 是 Git 原生的一列排布，顺着看大段上下文更省横向空间。两者共用同一份 `parsePatch` 行模型。
  所选的视图住在 store 的 `patchView` 里（不是补丁组件内部）：切提交时右栏会短暂清空、补丁组件被卸载重建，
  状态放组件里会弹回默认；换文件 / 换仓库 / 换页也保持，重启应用才回到并排。
- 提交列表可按日期范围筛：标题下是**两个日期框**（开始 / 结束，`el-date-picker type=date`；
  固定窄宽 128px 并排、中间一个「至」（与 daterange 的读法一致，不占窄宽、换行时留在上一行末尾），
  中栏放不下才换行，日期不会像 daterange 那样被裁掉半边，也不占满一整行；
  可以只填一侧）。值是本地日历日的
  `YYYY-MM-DD`，宿主补成当天 `00:00:00` / `23:59:59` 交给 `git log --since/--until`
  （只认日期形状，别的字符串不进参数）。范围对整仓库历史与文件历史都生效，分页在范围内继续；
  两端清空 = 不限。换仓库清空范围，换文件 / 换分支 / 刷新保留。
- 分页：提交列表一页 50 条，滚动到底再取下一页；`hasMore` 由宿主多取一条判断。
  文件历史不分页以外的特殊处理 —— 它是同一套列表，只是 `historyPath` 有值。
- 补丁行模型：`git diff -U3` 由 `packages/git/src/patch.ts` 的 `parsePatch` 拆成
  「hunk / 增 / 删 / 上下文 / 说明」的行，并排视图再经同文件的 `buildSplitRows` 配对。
  两张表的列宽都写在 `colgroup` 上：表首行是 `colspan=4` 的 hunk 头，靠 `td` 定宽会被固定布局均分
  （代码列只剩四分之一宽）。没有用 `@workbench/core` 的 `buildDiffRows`：那一份要两侧完整文本
  （技能对比弹窗的场景），Git 这边只从 git 拿补丁，没有理由把上下文之外的几万行也取回来。
- 二进制文件不取行级差异（`--numstat` 的 `-` 与补丁里的 `Binary files` 两处都判）；
  单侧超过 1 MB 时宿主直接回 `tooLarge`，不跑 diff。
- 提交详情走 `git show -s --format=...`（`%B` 是完整说明，`%P` 是父提交）；
  标题（第一行）与正文都交给 [MarkdownView](../../apps/desktop/src/renderer/src/components/MarkdownView.vue) 渲染
  （markdown-it，`html: false`；链接经 `openExternal` 交给系统浏览器）。正文盒子定高滚动（16em），
  不把下面的差异挤出去；提交列表里的标题仍是纯文本（单行截断）。
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
  src/repo_git.rs        Git 页的只读宿主：仓库信息 / 分支清单 / 提交 / 目录树 / 文件历史 / 提交差异 / 补丁
  src/proc.rs            子进程原语；run_direct_bytes 给补丁按字节收输出
  src/sync.rs            git 管道（全局参数 / 环境 / 超时）与 run_bytes
  packages/git           回包收敛（parse.ts）、diff 行模型与并排配对（patch.ts）、最近打开清单（repos.ts）、类型（types.ts）
  workbench/git.ts       通道适配（invoke + parse，失败收敛成 Result）
  stores/git.ts          页面状态：仓库 / 历史来源 / 选中提交 / 对比 / 补丁
  components/git/        GitView / GitFileTree / GitCommitList / GitDiffPane / GitChangedFiles / GitPatchView / GitRepoMenu（头部与空态共用的换仓库菜单）
```
