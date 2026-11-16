# Workbench 代码审查报告

审查范围：`apps/desktop/src/renderer/src`（173 个 `.vue` / 138 个 `.ts`）、`apps/desktop/src-tauri/src`（90 个 `.rs`）、`packages/*`（19 个域包 / 222 个 `.ts`）。
审查维度：耦合度、内聚性、复用度、冗余、CSS 可精简空间。
文中 `路径:行号` 均可直接跳转。

---

## 0. 先说结论

**这是一个纪律很好的代码库**，问题不在"脏"，在"长"——总体架构（域包 + 适配层 + 契约层）立得住，真正的技术债集中在三处结构性堆积：


| 排序 | 问题                                | 位置                                 | 量级                            |
| ---- | ----------------------------------- | ------------------------------------ | ------------------------------- |
| 1    | 截图页一个文件装下五套职责          | `capture/CaptureApp.vue`（2 526 行） | 全仓库最长 5 个函数有 4 个在此  |
| 2    | `WorkbenchApi` 299 个成员的单体接口 | `types/api.ts`（1 184 行）           | 一改全量重算，测试无法分域 mock |
| 3    | 网关适配层被绕过，同一通道两条路    | `workbench/gateway.ts` vs 34 处直连  | 6 个组件里 5 个两套写法并存     |

另外四类**低风险高收益**的清理：4 棵树的重复外壳、93 处手写省略号、12 段 `is-resizing` 兜底、22 个文件里重复定义的选择器。

**做得好的地方（别去动）**：

- 域包依赖图无环、最浅两层（只有 `notes`/`core` 被依赖 4 次），边界清楚。
- Rust ↔ TS 契约有生成与门禁（`types/contract.generated.ts` + `pnpm run contract:check`），这在同类项目里少见。
- 颜色令牌化彻底：组件里硬编码颜色仅 ~91 处（`tokens.css` 自身 91 处），`!important` 44 处里 35 处是拖拽兜底 —— 合理。
- 共享组件复用率高：`EmptyState` 89 处、`AppDialog` 38 处（`<el-dialog>` 直写仅 1 处）、`.panel` 63 处。
- 全仓库 **0 处** `TODO/FIXME/HACK`；注释解释的是"为什么这么写"，不是"这行在做什么"。

---

## 1. 耦合度

### 1.1【高】`WorkbenchApi` 是 299 个成员的单体接口

`types/api.ts:154` 起是一个 `interface`，到 1 184 行结束，299 个成员按 `gateway*` / `qoder*` / `mail*` / `kb*` / `ai*` 混排。

后果：

1. **改动放大器**：任何一个域的载荷类型变化，都让引用 `WorkbenchApi` 的文件全部重新检查。
2. **测试不可分域**：`workbench/index.ts:301` 已经出现 `implementedApi as unknown as WorkbenchApi` —— 因为没人能只实现自己那一段。store 单测要么整份 mock 299 个方法，要么断言绕过类型。
3. **新人读不出边界**：域包已经把 19 个域拆开了，契约层却把它们糊回一坨。

建议（纯类型改动，零运行时风险）：

```ts
// types/api/ 按域拆成 gateway.ts / mail.ts / kb.ts / ai.ts / system.ts …
export interface WorkbenchApi
  extends GatewayChannel, QoderChannel, MailChannel, KbChannel,
    AiChannel, NotesChannel, SystemChannel, SyncChannel { /* 共用的 logError 等 */ }
```

调用方一行不用改（`window.workbench.gatewayStart()` 仍然成立），但测试可以只实现 `GatewayChannel`，`as` 断言可以逐步去掉。

### 1.2【高】网关适配层被大面积绕过

`workbench/gateway.ts` 提供了 30+ 个带类型的薄封装（`gatewayStatus`、`gatewayUsageRows`、`syncGatewayUsage`…），但组件里同时存在 34 处 `window.workbench.gateway*` 直连：


| 组件                               | 直连处数 | 同时 import 适配层 |
| ---------------------------------- | -------- | ------------------ |
| `GatewayView.vue`                  | 17       | ✅                 |
| `PerksPane.vue`                    | 7        | ✅                 |
| `AccountTransferDialog.vue`        | 4        | ✅                 |
| `ModelsPane.vue` / `UsagePane.vue` | 2 / 2    | ✅                 |
| `RequestsPane.vue`                 | 1        | ✅                 |

被绕过的不只是"包一层"，而是**业务语义**：`gatewayUsageRows(days, repo, device)` 里的 `repo/device` 注入、`markGatewaySynced()` 的本地标记、`syncGatewayUsage()` 的门禁，直连全部拿不到。

反过来看也有一半封装没人用：`gatewayCredits` 全仓库只有 1 处引用，而 `GatewayView.vue:347` 还在直连。

建议：二选一并写进 `AGENTS.md` 第 5 节 —— 要么"组件只经 `@/workbench/<域>`，直连清零"，要么"适配层只留带语义的（`syncNow`/`pull`），纯转发删掉"。现状是最贵的那种：两条路都在，后来的改动只会跟一条。

### 1.3【中】39 个组件直接调宿主管道（176 处）

```
components/ 下 39 个 .vue 出现 window.workbench.*，合计 176 次
```

`AGENTS.md` 允许"接口调用归实际负责该动作的组件或 API 模块"，但实际结果是**同一个列表在不同组件里各拉一遍**（`KbView` / `KbAddDialog` / `NoteAssetsDialog` 各自 `window.workbench.kb*`），状态没有单一来源，刷新时机各自为政。

建议：**列表级数据下沉到 store**（谁拥有数据谁负责拉），组件只保留"一次性弹窗级动作"（导出/导入/选文件）。这条规则能同时消掉 1.2 的一半问题。

### 1.4【中】`projects` store 是启动编排器

`stores/projects.ts` import 了 `auth` / `catalog` / `environment` / `settings` / `terminal` 五个 store，`init()` 里串起所有 store 的 `installListeners()` 与首屏取数（`projects.ts:1-35` 有说明）。

注释承认了这是刻意的，但代价是：**新增任何 store 都必须改 `projects.ts`**，且"项目"这个域背上了"应用启动"的责任。渲染层根目录已经有 `bootstrap.ts`，把这段编排挪过去（`bootstrap.facade` 依赖所有 store，`projects` 只认自己的数据）更符合名称。

### 1.5【中】`notes` 包被当成基础库

```
kb  → notes   （type KbSyncInput = NoteSyncInput，kb.ts:28-30）
ai  → notes, skills, terminal
```

`packages/kb/src/kb.ts:1` 直接 `import type { NoteRepoState, NoteSyncInput, NoteSyncSummary }` 并**原样改名为** `Kb*`。这不是"复用了逻辑"，是"两个域共用了一份叫 note 的契约"：以后知识库要加一个同步字段，得先改笔记的包。

真正的共享物（root 名规范化 `sanitizeNoteRoot`、同步契约、`stripAnsi`）应上收到 `core`，`notes` 退回纯笔记域。

### 1.6【中】Rust：两套代理实现，管道层可共享

```
wb_*（25 文件，~9.5k 行）   qd_*（22 文件，~5.5k 行）   relay_core.rs（149 行）
```

AGENTS.md 明确"两套独立实现、可以同时跑"，业务层分开是对的。但**协议管道**重复了：

- `wb_sse.rs:35` 与 `qd_sse.rs:25` 各有一个 `Decoder`，pending 缓冲、按行切、跳注释行、`data:` 前缀剥离的逻辑实质相同，只是载荷处理不同。
- 两边各有一个 `Aggregator`（tool_call 增量聚合），`wb_sse.rs:271` / `qd_sse.rs:316`。

`relay_core.rs` 目前只共享了配置读写与启停（149 行），把 `Decoder`（约 40 行纯机械逻辑）和 tool_call 合并器也放进去，两边各省 100~200 行，且分帧的边界情况只需修一处。

---

## 2. 内聚性

### 2.1【高】`CaptureApp.vue` 2 526 行装下五套职责

```
script  2 238 行  |  template  142 行  |  style  141 行
```

一个文件同时是：


| 职责         | 代表函数                                                                                  | 行数            |
| ------------ | ----------------------------------------------------------------------------------------- | --------------- |
| 画布绘制     | `redraw` / `drawSelectionChrome` / `drawSizeLabel` / `drawPickedChrome` / `drawCrosshair` | 102 + 4×20     |
| 指针状态机   | `onPointerDown` / `onPointerMove` / `onPointerUp`                                         | 106 / 46 / 47   |
| 键盘         | `onKeyDown` / `nudge`                                                                     | 122 / 26        |
| OCR 流程     | `startOcr` / `ocrCopy` / `exitOcr` / `copyOcr` / `selectAllOcr`                           | ~110            |
| 滚动截屏拼接 | `runScroll` / `grabScrollBytes` / `frameFromBytes`                                        | **260** + 2×15 |
| 导出与复制   | `compose` / `blobToBase64` / `pngBase64` / `copy` / `copyScroll*`                         | ~120            |

全仓库最长函数 TOP 5 里 4 个在这个文件：`runScroll` 260 行、`onKeyDown` 122、`onPointerDown` 106、`redraw` 102。

**关键点：拆分路径已经铺好了。** `packages/capture` 里已有 17 个纯逻辑模块（`annotation` / `coords` / `history` / `stitch` / `ocr` / `handles` / `magnifier`…，共 1 861 行，全部带测试）。缺的只是把**渲染层**的门面也切一刀：

```
composables/use-capture-stage.ts        绘制（redraw + 5 个 draw*）→ stage 上下文与 sampler
composables/use-capture-interaction.ts  指针 + 键盘 + 选区几何
composables/use-scroll-stitch.ts        runScroll 那 260 行（最该先动）
capture/export.ts                       compose / blobToBase64 / pngBase64 / copy / save
```

拆完之后 `CaptureApp.vue` 剩 ~400 行（模板 + 装配），`runScroll` 那 260 行也能第一次进单测。

### 2.2【中】5 个大页面 800–1 300 行


| 文件                      | 总行  | 其中 CSS | 说明                                |
| ------------------------- | ----- | -------- | ----------------------------------- |
| `qoder/QoderView.vue`     | 1 263 | 403      | 页面 + 表格 + 弹层编排              |
| `NoteEditor.vue`          | 1 228 | ~200     | Vditor 集成 + 粘贴/拖放/素材上传    |
| `gateway/GatewayView.vue` | 1 057 | 344      | 页面壳 + 3 个 pane 的取数与轮询     |
| `NotesView.vue`           | 1 036 | 291      | 树 + 编辑 + 大纲 + 资源             |
| `gateway/UsagePane.vue`   | 976   | **444**  | KPI + 时序柱图 + 明细表全在一个文件 |

`UsagePane` 的 444 行 CSS 占 45%，说明它就是"三段内容塞进一个 scope"。拆成 `UsageKpi` / `UsageChart` / `UsageTable` 后，样式会各自收敛到 100 行以内。

### 2.3【中】设置页 27 个手写的 `.row` 块

`settings/GeneralPane.vue` 模板 318 行，里面 **27 个** `<div class="row">`，每块 10–15 行，只差 label 文案、hint 文案和控件类型：

```html
<div class="row">
  <div class="row__text">
    <span class="row__label">全局快捷键</span>
    <span class="row__hint">在任何窗口下唤起 / 隐藏 {{ ... }}。</span>
  </div>
  <el-switch :model-value="..." @update:model-value="..." />
</div>
```

一个 `SettingRow.vue`（`label` / `hint` props + 默认 slot）能把 318 行压到 ~120 行，`MenuPane` / `CapturePane` 同时受益 —— 这两个文件也各自在 scoped 样式里重写了 `.row` / `.block`。

### 2.4【低】`components/` 根目录平铺 133 个文件

只有 `etf/` `gateway/` `git/` `qoder/` `settings/` 分了子目录。要找"邮件那 6 个组件"得在 133 个文件名里翻。建议按页面域再分（`mail/` `notes/` `ai/` `work/`…），迁移成本是一次性的路径替换。

---

## 3. 复用度

### 3.1【高】四棵"树"各写一遍


| 组件                  | 总行 | 模板 | 样式    | 结构                                               |
| --------------------- | ---- | ---- | ------- | -------------------------------------------------- |
| `NoteTree.vue`        | 674  | 44   | **157** | `.tree` / `.node` / `node__icon` / `node__name`    |
| `VideoTree.vue`       | 275  | 33   | **113** | 同上                                               |
| `AiSessionTree.vue`   | 233  | 50   | **121** | `.tree__group` / `.row__*`（同一套东西，改了类名） |
| `git/GitFileTree.vue` | 212  | 50   | **93**  | `.tree-body` / `.node__*`                          |

CSS 属性集合重合度：NoteTree↔VideoTree **72%**，NoteTree↔AiSessionTree 61%，VideoTree↔AiSessionTree 61%，NoteTree↔GitFileTree 54%。

更能说明问题的是代码里的注释：

```css
/* AiSessionTree.vue:129 —— 行高 28px 与笔记 / 视频树一致 —— 三页的左栏挨着看是一回事。 */
```

**一致性靠注释维持，不靠变量。** 行高 28px 在至少 8 个文件里硬编码：`NoteTree:553`、`VideoTree:187`、`AiSessionTree:135`、`GitFileTree:164`、`KbList:357/380/424/452`、`AiView:701`、`FloatingMenu:131`、`AiLocationBar:75`。

建议两步走：

1. `composables/use-tree-rows.ts`：展开态集合、扁平化、键盘上下/左右、`aria-*`（四棵树现在只有部分有键盘导航）。
2. `.tree-row` 外壳进 `global.css`（与 `.panel` 同级），并补令牌 `--h-row: 28px` / `--h-row-dense: 22px` / `--w-tree-indent: 22px`。

`tokens.css` 已经有 `--h-titlebar` / `--h-header` / `--h-terminal` / `--h-project-card`，唯独最常用的"行高"没有档位 —— 这是令牌表的一个明确缺口。

### 3.2【高】省略号三件套手写 93 处，而 `.truncate` 只用 34 处

```css
min-width: 0;
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
```

`global.css` 已有 `.truncate`，但组件里另有 **93 处**手写（含 14 组完全相同的声明块，最大一组在 14 个文件里重复）。这是"CSS 能精简"里最大的一块，估计可删 220–260 行。

动手方式：先在 `global.css` 补 `.truncate`（单行）与 `.truncate-block`（多行 `-webkit-line-clamp`），再用 `grep -l "text-overflow: ellipsis"` 逐个换成 class。

### 3.3【中】3 份 base64 转换


| 位置                                | 形态                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `capture/CaptureApp.vue:1954`       | `blobToBase64(blob)`                                     |
| `components/NoteEditor.vue:803-809` | 内联 `new Uint8Array(await file.arrayBuffer())` + `btoa` |
| `packages/mail/src/base64.ts:11`    | 已有 `toBase64`                                          |

后者是唯一带测试的，应作为唯一实现（`packages/core` 更合适，`mail` 不该被笔记页依赖）。

### 3.4【中】`delay` / `sleep` 3 份

`capture/CaptureApp.vue:1518`、`workbench/auth.ts:38`、`workbench/etf.ts:58` —— 三份一字不差的 `new Promise(resolve => setTimeout(resolve, ms))`。

### 3.5【中】通知两条路

`@/notify` 封装（`notifySuccess/Warning/Error/Info` + `confirmAction`）被 store 用，但 **22 个组件里 84 处**直接 `ElMessage.*`（error 40 / success 23 / warning 18 / info 3）。

`notify.ts` 的注释说"组件里直调也仍然可以"，代价是：同一句失败提示两套写法，组件内的错误分支无法用 `vi.mock('@/notify')` 断言。要么统一，要么把这条豁免写进 `AGENTS.md`（现在的状态是"两种都被允许"，新代码只会随机选）。

### 3.6【低】Rust 侧 8 条 load/save 命令逐字重复

`commands.rs:90-136`：

```rust
pub fn data_load()  -> Result<Value, String> { data_store().read() }
pub fn data_save(v: Value) { data_store().set(v); data_store().schedule() }
// theme_* / token_* / work_log_* 三组完全同构
```

一个 `store_cmds!` 宏或把 `(read, write)` 收进一个泛型命令即可，省 40 行且以后加第 5 份存储不用复制粘贴。

---

## 4. 冗余啰嗦

### 4.1【高】`global.css` 里 12 段 `body.is-resizing-*`，9 段完全相同

`global.css:54-169` 是一串：

```css
body.is-resizing-notes-tree,  body.is-resizing-notes-tree * { cursor: ew-resize !important; user-select: none !important; }
body.is-resizing-notes-rail,  body.is-resizing-notes-rail * { ... 同上 ... }
body.is-resizing-etf-range,   ...  { ... 同上 ... }
body.is-resizing-video-tree,  ...  { ... 同上 ... }
body.is-resizing-ai-tree,     ...  { ... 同上 ... }
body.is-resizing-ai-preview,  ...  { ... 同上 ... }
body.is-resizing-git-pane,    ...  { ... 同上 ... }
body.is-resizing-kb-tree,     ...  { ... 同上 ... }
body.is-resizing-mail-list,   ...  { ... 同上 ... }
```

9 段一字不差，只有类名不同 → 合成一条逗号选择器，省 ~40 行。另外 3 段（`terminal` 的 `ns-resize`、`etf-range` 的 `grabbing`、`video-float` 的 `move`/`nwse-resize`）保留。

顺带的收益：以后加一处拖动分隔条，只需在 TS 里加一个类名，不用回来改 CSS。

### 4.2【中】22 个文件在同一个 `<style>` 里重复定义同一选择器

典型的"追加而不是修改"痕迹：


| 文件                       | 重复项                                                                                | 后果                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `settings/GeneralPane.vue` | `.hotkey-grid__row` ×2                                                               | 前一条的 `grid-template-columns: 1fr auto 44px` 被后面的 `48px` 覆盖，**前一条是死代码** |
| `gateway/UsagePane.vue`    | `.usage__cost-hero` ×**3**、`.usage__cost.panel` ×2、`.is-match` ×2、`.is-hit` ×2 | 需读三处才知道最终值                                                                     |
| `MarkdownView.vue`         | `.md :deep(h1/h2/ol/.md-table th)` ×2                                                | 同上                                                                                     |
| `WorkView.vue`             | `.day__relative` / `.day__count` ×2                                                  | 同上                                                                                     |
| `VideoUpNext.vue`          | `.vplayer__next-*` ×3 类                                                             | 同上                                                                                     |
| 其余 17 个                 | 各 1–2 处                                                                            | 同上                                                                                     |

建议：加一条 `stylelint` 或直接一次性清理（`sed` 层面可查，语义层面要人看一眼 —— 有的是真覆盖，有的纯属粘贴重复）。

### 4.3【中】116 组完全相同的声明块

```
14 处  display:flex; flex-direction:column; gap:2px; min-width:0;
 9 处  display:flex; align-items:center; gap:var(--sp-2); min-width:0;
 6 处  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;   ← 3.2 那一类
 6 处  flex-shrink:0; font-size:var(--fs-micro); color:var(--ink-3);
 ...
```

这类是"该抽组件而没抽"的副产物（最集中的一处在 `AccountDialog` / `AiModelDialog` / `AiModelPicker` / `AiPresetGrid` / `QuitConfirmDialog` 这组弹窗之间）。抽组件时自然消失，不需要单独治。

### 4.4【低】16 处页面外壳

`display:flex; flex-direction:column; height:100%; min-height:0` 在 16 个视图里各写一遍（`KbView` / `GitView` / `EtfView` / `QoderView` / `GatewayView` / `GitCommitList` / `GitDiffPane` / `GitFileTree` / `GitPatchView` / `GitChangedFiles` / `KbCleanPanel` / `KbRawViewer` / `AiRunPanel`…）。一个 `.page` 类进 `global.css` 即可，与 `.panel` 同级。

---

## 5. CSS 能不能精简 —— 数据与结论

### 5.1 现状


| 指标               | 数值                                   | 评价                           |
| ------------------ | -------------------------------------- | ------------------------------ |
| 组件 scoped CSS    | **19 730 行** / 162 个文件             | 偏多，主要来自 3.1 / 3.2       |
| `global.css`       | 1 605 行 / 177 条规则                  | 合理（含 EP 收敛与拖拽兜底）   |
| `tokens.css`       | 148 个变量                             | 结构清晰，缺"行高/控件高"档    |
| 硬编码颜色         | 182 处，其中 91 处在 `tokens.css` 本身 | **很干净**，组件里仅 ~91 处    |
| `rgba()` 硬编码    | 111 处                                 | 多为遮罩/阴影，可接受          |
| 硬编码 px（≥4px） | 1 124 处                               | 图标/头像/图表尺寸占大头，合理 |
| `!important`       | 44（35 在 global.css 的拖拽兜底）      | 合理                           |
| `:deep()`          | 224 处                                 | EP / Vditor 集成需要，正常     |
| 同作用域重复选择器 | 22 个文件                              | 该清（4.2）                    |

### 5.2 可精简清单（按收益/风险比排序）


| # | 动作                                       | 预计收益                   | 风险                                 |
| - | ------------------------------------------ | -------------------------- | ------------------------------------ |
| 1 | 93 处手写省略号 → `.truncate`             | −220~260 行               | 极低                                 |
| 2 | 4 棵树抽 `.tree-row` 外壳 + `--h-row` 令牌 | −350~420 行               | 低（要先补回归观察：三页左栏并排看） |
| 3 | 9 段 `is-resizing` 合并                    | −40 行                    | 极低                                 |
| 4 | 22 个文件删重复选择器                      | −80~120 行                | 低（需人眼确认覆盖意图）             |
| 5 | 16 处页面外壳 → `.page`                   | −50 行                    | 极低                                 |
| 6 | `SettingRow` 组件化（GeneralPane 27 块）   | −200 行模板 + −60 行 CSS | 低                                   |

合计：**约 −950~1 100 行**，其中 1/3/5 可以纯机械完成，不需要理解业务。

### 5.3 一个该修的令牌问题：两套"整页字号放大"

同一诉求（"这一页信息密度高，字号整体上调一档"）有两种写法：

- **网关页**：`tokens.css:135-138` 另立 `--gw-fs-title/body/meta/micro`（16/14/13/12px），并注明"只有 `components/gateway/*` 用"。
- **Git 页**：`git/GitView.vue:318-320` **就地重定义全局令牌** `--fs-micro: 12px; --fs-meta: 13px; --fs-body: 14px;`。

后者的代价：① 全局令牌的语义被局部篡改，任何嵌进 GitView 的子组件都会跟着变；② 以后调全局档位，Git 页不响应（因为写死了）；③ 读代码的人不知道页面上看到的 14px 从哪来。

建议：统一到平行令牌（`--git-fs-*`，与 `--gw-fs-*` 对称），或抽 `--fs-page-*` 一族由页面容器一次性覆盖。不要就地改写全局变量。

### 5.4 明确不建议动

- 手写 CSS、不用原子化 CSS（`AGENTS.md` 第 4 节的红线）—— 现状执行得很好，不要为了"少写几行"引入 Tailwind。
- `.panel` / `.facts` / `.filter` / `.sort` / `.form` 这组跨页外壳 —— 复用率高（`.panel` 63 次），是现有体系能成立的原因。
- 颜色与间距令牌化 —— 组件里仅 ~91 处硬编码色，这个数字在 20k 行 CSS 的规模下非常低。

---

## 6. 建议的处理顺序

如果要真的动手，按"风险从低到高、收益从高到低"交错排：

1. **`WorkbenchApi` 按域拆接口**（纯类型，零运行时风险，收益长期）
2. **CSS 机械清理**：`is-resizing` 合并 → `.truncate` 统一 → 删重复选择器 → `.page`（半天量级，可分批提交）
3. **`SettingRow` 组件化**（单文件内，易验证）
4. **树组件统一**（先 `use-tree-rows.ts`，再迁样式，一次迁一棵）
5. **网关适配层定一条规则并清直连**（需要产品/维护者拍板"哪条是正统"）
6. **`CaptureApp.vue` 拆 4 个 composable + 1 个导出模块**（收益最大也最需要测试兜底，放最后做，先给 `runScroll` 补一个快照级测试）

前 5 项都不动运行时行为，可以放心做；第 6 项建议单独排期。

---

## 7. 执行记录（2026-11-16）

**第 1 项（`WorkbenchApi`）已完成**：`types/api.ts` 拆成 `types/api/` 下 22 个 `*Channel`（一个域一份，299 个成员一个不少），
`types/api/index.ts` 只做并集；`MissingChannels` 那道编译期检查与所有调用方一行未改。`ipc-and-state.md` 的契约路径与
「新增通道三步」已同步。

**第 2 项（CSS 机械清理）已完成**，与报告数字有出入的地方按实际改：

| 子项 | 实际数 | 处理 |
|---|---|---|
| `is-resizing` 合并 | 9 段 | 合成一条逗号选择器；`is-panning-etf-range` 与两条 iframe `pointer-events` 保留 |
| 手写省略号 | **117 条规则**（报告 93） | 113 条换成 `.truncate`（63 个文件）；4 条是 `:deep(.el-tag__content)` / `.device .sort__value`，保留 |
| 重复选择器 | **2 处**（报告 22 个文件） | `BoardCard` 的 `.is-editing`、`GeneralPane` 的 `.hotkey-grid__row` 已合并；报告把 `@media` 与 `@keyframes` 里的同名覆盖也算进去了，那些是合法的响应式 / 关键帧规则 |
| `.page` 外壳 | **13 个**（报告 16） | 13 个视图根改用全局 `.page`；另 4 个命中是视频播放器 / 独立视频窗口 / 两个对比弹窗，不算页面外壳 |

`.page` 与 `.truncate` 的口径已补进 `features-and-architecture.md` 的「UI 与样式通用口径」。

**第 3 项（`SettingRow`）未做**：`GeneralPane` 实际 10 个 `.row`（报告 27 是把 `row__*` 一起数了），且 `.row` / `.row__text` /
`.row__label` / `.row__hint` 的样式集中在 `SettingsDialog.vue` 的 `:deep()` 里，四个 pane 并没有各写一份；抽组件只剩模板重复，
收益不到报告估算的零头，先不动。

**第 4 / 5 项复核后不做**（报告前提与实际代码不符）：

- **第 4 项（四棵树）**：`NoteTree` / `VideoTree` / `GitFileTree` 都用 `el-tree` —— 展开、键盘、aria、扁平化都是 EP 的；
  `GitFileTree` 还是懒加载、没有展开态。只有 `NoteTree` / `VideoTree` 各有一段相同的 `expand` / `collapse`（约 8 行），
  `AiSessionTree` 是有意用「收起来的集合」（不落盘）。抽 `use-tree-rows` 能省的实际只有十几行，CSS 合并那半需要
  「三页左栏并排看」的视觉回归，没做。
- **第 5 项（网关两条路）**：**不存在两条路**。组件里的 `window.workbench.gateway*` 就是契约本身，它的实现
  （`api-sync.ts`）已经做了 `repo/device` 注入与节流；`@/workbench/gateway` 的函数是它的实现与跨适配层复用，
  组件只 `import type`（例外是 `gatewayAccountNames` 这个非通道小工具，2 处直调，没有绕过语义）。不需要拍板，也没改。

**第 3.3 / 3.4 项（base64、delay 去重）已完成**：

- `packages/core/src/base64.ts`：`bytesToBase64` / `base64ToBytes` / `blobToBase64`（带单测）。`@workbench/mail` 改从 core 取，
  桶文件仍 re-export；`CaptureApp` 的 `blobToBase64` 与 `NoteEditor` 的 `toBase64` 都改用这一份。
- `packages/core/src/delay.ts`（带单测）：`CaptureApp` 的 `delay`、`workbench/auth.ts` 的 `delay`、`workbench/etf.ts` 的 `sleep` 三份合一。

**第 6 项只做了第一刀（导出侧）**：`compose` 与 `blobToBase64` 从 `CaptureApp.vue` 搬到
`capture/export.ts` 的 `composePng`（参数显式化：帧 / 选区 / 边界 / 标注 / draft），`CaptureApp` 只留守卫与取数。
`use-capture-stage` / `use-capture-interaction` / `use-scroll-stitch` 三块未动 —— 它们与绘制、指针状态机、滚动循环强耦合，
要先有 `runScroll` 的快照级测试兜底，按报告建议单独排期。

验证：`pnpm run verify` 全绿（lint / typecheck / contract:check / build:renderer / 20 个项目测试）。
