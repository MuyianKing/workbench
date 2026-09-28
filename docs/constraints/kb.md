# 知识库

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束（知识库页）；功能说明见
[features-and-architecture.md](../features-and-architecture.md) 的「知识库（kb）」一节。

关键落点：`src/shared/kb.ts`（布局常量、frontmatter 解析、状态判定、本机日期，带单测）、
`src-tauri/src/kb.rs`（扫描、读文本、**重建目录与索引**）、`src/renderer/src/workbench/kb.ts`（适配）、
`src/renderer/src/stores/kb.ts`（编排）。AI 助手那条链路见 [ai.md](ai.md)。

- **读是只读的，写只有两处、且都不写内容**：Rust 侧的命令是 `kb_scan`（平铺清单）、
  `kb_read`（读文本）与 `kb_index_build`（重建 `kb/_catalog.md` 与 `index/index.json` ——
  那是生成物）。条目的正文与元数据**不由应用直接写**：写它的是 AI 助手请来的那个 Agent
  （见 [ai.md](ai.md)），应用只递提示词、并在跑完重建索引。除这两处外不要再加写动作，
  也别把「跑那个仓库的 Python 脚本」做成应用功能 —— 那会引入 git 之外的预装程序依赖
  （见 AGENTS.md 第 1 节）。
- **仓库布局是两边的约定，改要一起改**：`data/raw/`（原始资料）、`kb/`（条目，`_catalog.md` 不算条目）、
  `index/index.json`（脚本生成的索引）这四个常量在 [kb.ts](../../src/shared/kb.ts)，
  与知识库仓库自己的 `scripts/build_index.py` 一一对应；用户挑的文件夹必须两块布局都认得出来
  （一块都没有时页面明说「不像知识库」，不硬扫）。
- **「有没有更新」的口径只有一份，在 kb.ts**：条目 frontmatter 的 `source` 归一化后与 raw 文件配对
  （带不带 `data/raw/` 前缀两种写法都认、大小写不敏感），没有条目指向 = 未入库；
  原始文件比指向它的条目里**最新**那份的 mtime 还新 = 有更新。它依据文件修改时间，是启发式
  （git 操作会重写 mtime）——要换口径只改 kb.ts 一处，别在组件里另拍一份。
- **frontmatter 解析认最小集合**：与 skills.ts 同一条路数（首行 `---` 围栏、单行键值、tags 认
  `[a, b]` 列表），多行块标量如实丢掉；解析失败回空值**不是错误**（没有元数据的条目照样列出，
  标题回落文件名）。索引读不到 / 认不出同样不是错误——条目清单是扫出来的，不依赖索引。
- **同步与仓库探测复用笔记那两条通道**（`note_sync` / `note_repo_state`，本来就是「对任意文件夹、
  认它自己的 origin」的实现）：不新增 git 命令包装、不新增凭据机制；知识库文件夹自己有 `.git`
  且连了远端时同步按钮才出现，**只有点同步才出网**（推的是知识库仓库自己的 origin，
  应用不 init、不改 origin）。扫描与读文本本身不出网。
- **条目在应用内只读不编辑**：右栏用 MarkdownView 渲染（工作日志同款的安全口径）。
  脚本管理的条目会被再生成覆盖，在应用里开编辑口子会让人改了白改 —— 改内容去 raw 源头；
  要重做一遍就走 AI 助手那一页（写的人是 Agent，见 [ai.md](ai.md)）。
