# 终端、子进程与日志

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束（起命令 / 收输出 / 停进程）；功能说明见
[features-and-architecture.md](../features-and-architecture.md) 的「项目」与「终端」相关小节。

关键落点：`src-tauri/src/session.rs`（按会话起命令与回传）、`src-tauri/src/proc.rs`（带超时的子进程原语与进程树终止）、
`src/renderer/src/workbench/session.ts`（事件翻译）、`src/renderer/src/stores/terminal.ts`（运行态与日志缓冲）。

- 子进程输出由 `session.rs` 按批（200 行 / 50ms）回推 `session:lines`，`session:exit` 单独回退出码。
- 适配层把事件翻译成 `ProcessLogEvent` / `ProcessStatusEvent` 后广播，store 按帧写入 `RingLog`。日志缓冲刻意 `markRaw`、
  不参与响应式，靠 `logVersion` 触发渲染，读取日志用 `activeLogs`。
- 子进程一律按**进程树**终止（`taskkill /T`）：`cmd /C npm run dev` 之下才是真正的 dev server，只杀 cmd 会留下占着端口的孙进程，
  表现为「已停止」但端口仍被占。**超时清理也要走同一条路**，否则超时形同虚设。
