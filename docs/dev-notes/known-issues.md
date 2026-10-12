# 已知问题清单（评审产出 · 待修）

> 来源：一次针对全仓的只读审计（Rust 后端 / 渲染层 / 域包 / CI / 文档一致性）。
> 只记**做的不好的**那一半，按严重度分三档。每条给「现象 → 证据 → 为什么是问题 → 怎么修」。
> 证据里的路径是相对本文件的相对路径，行号取自审计当时（2026-10）。

---

## P0 — 会真实伤害用户

### 1. `panic = "abort"` + 560 处 `.unwrap()`，中间没有任何门禁

**现象**：release 档位把 panic 设成直接中止进程，而全仓 560 处 `.unwrap()` 分散在 26 个 `.rs` 文件里，
且没有任何 lint 阻止它继续增长。

**证据**

```118:122:../../apps/desktop/src-tauri/Cargo.toml
[profile.release]
codegen-units = 16
lto = "thin"
panic = "abort"
```

- `.unwrap()` 按文件分布（近似）：`sync.rs` ≈104、`kb.rs` 62、`token.rs` 54、`skills.rs` 53、`ai.rs` 49、`notes.rs` 45。
- 全仓搜 `#![deny(...)]` / `clippy::unwrap_used` **0 命中**。
- 数据链路上的硬伤：`../../apps/desktop/src-tauri/src/token.rs` 第 137 行与第 302 行都是
  `roots[0]`（`unwrap_or_else(|| roots[0].clone())`）—— 候选根目录为空即 panic，而这是 Token 面板的必经路径。

**为什么是问题**：后果不是「弹一个错误」，而是**进程凭空消失**。`store.rs` 的落盘是 300ms 去抖，
崩溃那一刻未 flush 的数据全丢；正在跑的子进程与邮件后台监视也没机会收尾；用户看到的是
「窗口没了，刚才的改动也没了」。

**怎么修**（按 ROI）
1. CI 里加 `cargo clippy -- -D warnings` 并打开 `unwrap_used` / `expect_used`（不要整套 `pedantic`，太重）。
2. 先清数据链路上的：`token.rs:137` / `token.rs:302` 改成显式 `Result`。
3. 加一个 `std::panic::set_hook` 把 panic 写进日志文件 —— 不要引 `human-panic` 这类 crate，
   它与 AGENTS.md「不新增编译单元」的取舍冲突，自己写钩子即可。

---

### 2. 渲染层几乎零测试，而 Rust 侧覆盖很好 —— 这个不对称才是真风险

**现象**：Rust 与域包测得很扎实，渲染层近乎裸奔。

| 层 | 源文件 | 测试 | 判定 |
|---|---|---|---|
| Rust 后端 | 35 个 `.rs` | 31 个有 `#[cfg(test)]`，约 280 个用例 | 好 |
| 域包 `packages/` | 15 个包 | 64 个 `*.test.ts`，无一遗漏 | 好 |
| **渲染层** | 66 个 `.ts` + 115 个 `.vue` | **11 个** | **近乎裸奔** |

**证据**
- **115 个 `.vue` 组件零测试**。
- `apps/desktop/src/renderer/src/stores/` 下 **17 个 store 零测试**，而它们承载了全部 UI 状态与和 Rust 的桥接：
  `stores/ai.ts` 1348 行、`settings.ts` 761 行、`kb.ts` 737 行、`projects.ts` 703 行、`terminal.ts` 669 行、`mail.ts`。
- Rust 侧唯一没写测试的大文件恰恰是 **全部 IPC 入口**：`../../apps/desktop/src-tauri/src/commands.rs`（916 行）。
  （另有 `main.rs` / `screen.rs` / `store.rs` 没有 `#[cfg(test)]`。）

**为什么是问题**：这是个人项目最典型的失败模式 —— 一个人写、记得住，所以不写测试；
但 UI 恰恰是改动最频繁的部分。现在的净效果是**改一次 store 等于线上直改**。

**怎么修**：不追覆盖率，追「改坏了会红」。先补两层边界用例：
① `commands.rs` 的参数校验与错误路径；② 最大的 4 个 store（`ai` / `settings` / `projects` / `kb`）的状态迁移。

---

### 3. CI 只在打 tag 时跑，而且 `cargo test` 与 `lint` 从不执行

**证据**

```46:49:../../.github/workflows/release.yml
on:
  push:
    tags:
      - 'v*'
```

- 全仓只有这一份工作流，**没有 push / PR 触发的任何检查**。
- `verify` job 只有两步：第 81 行 `pnpm run typecheck`、第 84 行 `pnpm test`（前端 Vitest）。
- **`cargo test` 从不执行**（约 280 个 Rust 单测白写了）；**`pnpm run lint` 连打 tag 时都不跑**，
  尽管 AGENTS.md 第 6 节要求「每次改完前端代码都要跑一遍 `pnpm run lint:fix`」。
- 15 个域包的 test 脚本都带 `--passWithNoTests`：`include` 一旦写坏会**静默通过**
  （只有 `apps/desktop/package.json` 没带这个旗标）。

**为什么是问题**：日常提交零闸门，退化只在发版那一刻才暴露 —— 而发版时人通常只想快点上。

**怎么修**：几十行 yaml。加一份 `.github/workflows/ci.yml`，`on: [push, pull_request]`，
跑 `pnpm run lint` + `pnpm run typecheck` + `pnpm test` + `cargo test`（cargo 那步可以只在 push 到主分支时跑）。
**这是全清单里 ROI 最高的一条。**

---

## P1 — 结构性的腐烂点

### 4. Rust 与 TS 之间没有编译期契约，全靠手写对齐

**现象**：Rust 侧绝大多数命令返回 `serde_json::Value`，TS 侧的契约是手抄的，改键名不会报错。

**证据**
- `../../apps/desktop/src-tauri/src/commands.rs`：`note_repo_state`(229)、`kb_scan`(361)、
  `nvm_status`(797)、`nrm_status`(812) 全部返回 `Value`。
- 全仓 `src-tauri` 只有 6 个文件用了 `rename_all`，其余是手写 `json!` 宏 —— 键名只有渲染层知道。
- 抽样结果：

| 通道 | 问题 |
|---|---|
| `noteRepoState` | Rust 手写 `json!({"isRepo":…,"origin":…,"branch":…})`，TS 端按字段重建 → 改键名则 TS 全绿、静默变空串 |
| `getNvmStatus` | `types.ts` 裸返回，违反 AGENTS.md「通道一律返回 `Result<T>`」 |
| `nvm_node_dir` | Rust 真返回 `Option<String>`（JSON `null`），适配层用 try/catch 把**失败也压成同一个 null**，取消与失败无法区分 |
| `checkNodeVersion` | 签名说不会失败，实现里吞了一个会失败的 invoke |

- 约有 **20 条通道绕开了 `Result<T>`**：`listProjects`、`getActivity`、`listSyncDevices`、`listQuickApps`、
  `listCommands`、`checkPackageManagers`、`checkPort`、`checkNodeVersion`、`getSettings`、`getThemeConfig`、
  `getDataDir`、`authStatus`、`getWindowState`、`getAppVersion` 等。

**怎么修**：短期 —— 把那 20 条裸返回统一成 `Result<T>`。长期 —— 让 Rust 生成 TS 类型
（`tauri-specta` 之类），但**先用 `cargo tree -e normal -i <crate>` 验证不新增编译单元**，否则不引。

---

### 5. `types.ts` 一个人干三件事，还漏了两个包

**证据**：`apps/desktop/src/renderer/src/types.ts`（1759 行）

- 既是 IPC 通道表：`WorkbenchApi` 从第 1082 行起，170 个成员、约 148 条 invoke；
- 又是 11 个域包的 re-export 桶；
- 还装着运行期常量 `DEFAULT_SETTINGS`（第 1778 行起）。

`mail` 与 `vault` 两个包 **import 了却没有 re-export**（第 15、19 行），它们的对外形状在 `types.ts` 里被
**手抄了一遍**（`VaultKeyState` / `VaultLoaded` / `VaultSyncOutcome`）—— 这就是下一次漂移的起点。

另有一处同名不同形：`types.ts:1049` 的 `AiRunInput`（给 Rust 的 IPC 载荷）与
`stores/ai.ts:120` 的 `AiRunInput`（输入框载荷 `{text, images}`）。

**怎么修**：`types.ts` 拆三层 —— 契约层（IPC 表）、re-export 层、常量层（`DEFAULT_SETTINGS` 搬出去）；
`mail` / `vault` 真正 export 出去，删掉手抄的那几份。

---

### 6. `settings.ts` 是 God Store，并且催生了重复的样板

**证据**：`apps/desktop/src/renderer/src/stores/settings.ts`

- 被 **12 个 store 依赖**（`ai` / `kb` / `projects` / `vault` / `notes` / `skills` / `terminal` / `mail` /
  `nav` / `weather` / `video` / `ai-skills`）—— 它一动，半个应用重算。
- 内部混住四件事：DOM 副作用（`applyTheme`）、IPC 编排（数十个 async setter）、纯 UI 状态、背景图管理。
- 病灶模式：`setX / commitX` 三件套结构完全相同地重复了 **8 组** ——
  `setNoteTreeWidth`(493)、`setVideoTreeWidth`(515)、`setAiTreeWidth`(535)、`setMailListWidth`(547)、
  `setKbTreeWidth`(569)、`setVideoFloatGeometry`(581) …
- `stores/ai.ts`（1348 行）把 UI 状态、业务逻辑、IPC 编排、数据持久化四层混在一个 `defineStore` 里
  （60+ 个 computed、约 70 个 action）。
- **循环依赖**：`stores/ai.ts:31` → `ai-skills`，`stores/ai-skills.ts:26` → `ai`，
  且 `ai-skills.ts:37` 在 setup 体内立即 `useAiStore()`（构造即求值）。

**怎么修**：8 组 `setX/commitX` 用 `use-draft-field` 的思路抽成工厂（这个 composable 项目里已有，只是没用到 store 上）；
`ai.ts` 按「UI 状态 / IPC 编排 / 会话业务逻辑」拆三份，顺手断开与 `ai-skills.ts` 的环。

---

### 7. 四条业务线没有 store，取数逻辑散在组件里

**现象**：35 个 `.vue` 里出现 62 次 `window.workbench`。它本身就是适配层对象，所以问题不是越层调用，
而是**同一条数据被多处各自拉取**。

**证据**

| 业务 | 各自取数的组件 | 有无 store |
|---|---|---|
| 工作日志 | `WorkView.vue:67`、`TodayWorkPanel.vue:37`（同一条 `listWorkLogs`） | 无 |
| AI 热点 | `NewsPanel.vue`、`NewsArticleDialog.vue` | 无 |
| Token 用量 | `TokenPanel.vue` 内三处 | 无 |
| 笔记素材 | `NoteAssetsDialog.vue` 在弹窗里自己算图片引用次数，而该纯函数在 `@workbench/notes` 里 | 无 |

**怎么修**：这四条各补一个 store，组件只消费。（这一项的反面做得很好，别动：`renderer/src/format.ts`
是唯一的时间/路径格式化入口，components 下直接调 `dayjs(` 为 0 次；确认框统一走 `notify.ts`，只剩 1 处裸调。）

---

## P2 — 体感与维护成本

### 8. 性能：三处可以实测到的陷阱

| 位置 | 问题 |
|---|---|
| 全仓 `el-table-v2` / 虚拟列表 **0 处** | `MailView.vue:257` 把 `list + bulkList` 全量渲染，邮件多了会卡；知识库清单同理 |
| `stores/kb.ts:92-114` | `kbStats` / `kbTagCounts` / `kbLint` 在 computed 里遍历全表，`looksLikeKb` 每次重算两次 `.some()`；`sourceShape`(373) 在 computed 里 `JSON.stringify` 后当 watch 源 |
| `stores/projects.ts:438` | 全渲染层唯一一处 `{ deep: true }` watch，每次改动对**全部项目**跑 `editableOf + JSON.stringify` 再自己发 IPC 写回 |

已做对、别回退的：`terminal.ts` 用 `RingLog` + `markRaw` 把日志移出响应式；`ai.ts` 的 `STREAM_TICK` 对流做批节流。

---

### 9. 文档已经开始漂移（而本项目把文档当生命线）

- AGENTS.md 与 `../features-and-architecture.md` 都写「14 个 `@workbench/*` 包」，**实际是 15 个**（多了 `packages/capture`）。
- `../features-and-architecture.md` 的目录结构清单漏了 3 个 Rust 文件：`ai_news.rs`、`fs_util.rs`、`imaging.rs`。
  其中 `fs_util.rs` 是横跨 7 个模块的公共底座（路径守卫 / 原子写），在 `docs/` 下只被提到 1 次；`imaging.rs` 也只有 1 次。
- `../features-and-architecture.md` 第 216 行说「各模块…见 `modules/<模块>/implementation.md`」，
  但 `docs/modules/` 下是 16 份扁平 md，既无 `implementation.md` 也无子目录 —— **这行指针是坏的**。
- `../../apps/desktop/src-tauri/src/ai_news.rs` 头部注释仍写着 monorepo 迁移前的路径 `src/shared/ai-news.ts`。

---

### 10. 五条 IPC 命令漏标 async，违反自己写的规矩

`../features-and-architecture.md` 第 174-178 行明写：会起子进程、读写文件、跑 SQL 的命令必须标 `(async)`。
但这五条没有：

| 命令（位置） | 在主线程上做的事 |
|---|---|
| `commands.rs:92 data_flush` | JSON 序列化 + 建目录 + 原子写（磁盘 IO） |
| `commands.rs:866 open_path` | ShellExecute 阻塞等待 |
| `commands.rs:727 open_external` | 同上 |
| `commands.rs:774 spawn_session` | 起进程 + 建三根管道 |
| `commands.rs:722 reveal` | 起 explorer（注释自辩「只发起不等结果」） |

对照：`commands.rs:733 open_in_vscode` **标了** async，`open_path` 没标 —— **同口径两处不同标注，
说明这条规则只有人脑在执行**。全仓 154 个命令里 113 个标了 async，说明整体是做到位的，只是漏了这几条。

---

### 11. 任意命令执行面：`run_command` 与 `spawn_session` 的边界

这一条**不是缺陷，是设计取舍**，但要留个记认：`proc.rs:52-53` 的
`Command::new("cmd").arg("/C").arg(program).args(args)` 是有意为之（npm / nvm 都是 `.cmd`，直启找不到），
`run_direct`(66-90) 与 `session.rs:120` 的直启形态是给 git 这类用的，两套并存是对的。

需要留意的是**后果**：`commands.rs:749 run_command` 的两个参数 `program` / `args` 完全由渲染层给定，
最终交给 cmd 做二次解析。也就是说一旦渲染层被注入 JS，就是任意命令执行。当前唯一的防线是
「没有 `shell:` 插件权限 + 渲染层没有 XSS 面」，属于够用但不厚。

---

### 12. 顺手就能加的一层防线：`csp: null` + `withGlobalTauri: true`

```14:16:../../apps/desktop/src-tauri/tauri.conf.json
"withGlobalTauri": true,
...
"csp": null,
```

危险 HTML 那条路管得很好（邮件与 AI 回答都进带 CSP 的 sandbox iframe，全仓 `v-html` 只有 2 处且都有
`html: false` 转义），唯独**全局 CSP 这层白送的防线没设**，同时把 `__TAURI_INTERNALS__` 挂到全局，
让「任意 XSS → 能力调用」少走一步。改起来成本极低，跟旁边的两个 capability 文件的克制气质不一致。

---

### 13. 组件块头偏大

23 个渲染层文件 > 600 行，最大的 `MailView.vue` 1365 行、`TokenPanel.vue` 1069 行、`ProjectDrawer.vue` 1038 行、
`TerminalPanel.vue` 1006 行、`VaultView.vue` 853 行。这几处多半已混了「列表 + 详情 + 编辑 + 工具栏」好几个职责。

---

## 建议的执行顺序（只做五件事）

1. **加 push / PR 触发的 workflow**：`lint` + `typecheck` + `vitest` + `cargo test`。半天工作量，
   把 P0-1 / P0-2 / P0-3 一次性从「靠人记」变成「机器拦」。
2. **panic 加门禁 + 落痕**：clippy `unwrap_used`，加 panic hook 写日志。
3. **补 store 与 `commands.rs` 的边界用例**，目标不是覆盖率而是「改坏了会红」。
4. **收敛 IPC 契约**：20 条裸返回统一成 `Result<T>`。
5. **拆 God Store 与循环依赖**：`settings.ts` 的 8 组三件套抽成工厂，`ai.ts` 拆三份。

---

## 附：两条曾被误报、核实后不成立的结论

- **`Cargo.lock` 未入库** —— 不成立。它存在于 `apps/desktop/src-tauri/Cargo.lock` 且被 git 跟踪
  （`git ls-files --error-unmatch` 通过），也未被 `.gitignore` 排除。`Cargo.toml` 用主版本范围是 Rust 生态常规写法。
- **截图 / 钉图子系统（capture / pin / screen / clipboard）缺文档** —— 不成立。
  `../modules/screenshot.md` 存在，目录结构清单也登记了。这一组不用补文档。
