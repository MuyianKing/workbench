# 终端面板

## 约束

关键落点：`apps/desktop/src-tauri/src/session.rs`（起命令与回传）、`proc.rs`（带超时的子进程原语与进程树终止）、
`apps/desktop/src/renderer/src/workbench/session.ts`（事件翻译）、`stores/terminal.ts`（运行态与日志缓冲）。
跨模块通用事实见 [features-and-architecture.md](../features-and-architecture.md)，红线见 [AGENTS.md](../../AGENTS.md)。

- 输出由 `session.rs` 按批（200 行 / 50ms）回推 `session:lines`，`session:exit` 单独回退出码。
  **50ms 窗必须有定时驱动**：只在新行到来时检查，突发输出的最后几行会一直压在内存里
  （dev server 打完横幅就不再输出，界面「日志停在某一行」）。
- 适配层把事件翻译成 `ProcessLogEvent` / `ProcessStatusEvent` 后广播，store 按帧写入 `RingLog`；
  缓冲 `markRaw` 不进响应式，靠 `logVersion` 触发渲染，读取走 `activeLogs`。
- 子进程一律按**进程树**终止（`taskkill /T`）：`cmd /C pnpm run dev` 之下才是真正的 dev server，
  只杀 cmd 会留下占端口的孙进程；**超时清理走同一条路**，否则超时形同虚设。
- 退出码只说明**那条命令自己**跑完了：启动类是包装链（`pnpm run dev` → `tauri dev` → `beforeDevCommand`），
  包装层会吞掉子进程失败、退出码仍是 0 而服务没起来。状态灯的绿不能解读成「服务起来了」，
  文案也别把启动说成成功（只有打包谈得上「打包成功」，见 `status.ts` 的 `statusLabel`）。

## 实现

- **一个项目的一类操作一个终端**：启动 / 打包 / 安装依赖 / 每条自定义命令各占一个 Tab，输出互不覆盖
- 终端可关（Tab 上的 ×，运行中的先停）；日志只在内存里，重开应用清空
- 没有终端时面板条不渲染；跑过一次命令后面板条常驻
- **收起 = 收进窗口右缘的一颗悬浮按钮**（工具栏与面板条左侧的 `→` 都是收起，按钮是 `←`）：
  面板向右滑出窗口、按钮从右缘滑出，面板高度等它淡出后才收拢（内容不会被「往下折」的面板带走），
  展开倒着走同一套
- 那颗按钮挂 `body` 上、贴死右边（只留左两个圆角），不参与页面布局；纵向默认落在面板中线，
  可按住上下拖，位置存本机 `terminalButtonTop`（占窗口高度百分比）
- 有命令在跑（黄点呼吸）或上次失败（红点）时按钮右上角带角标 —— 收起后 Tab 状态点看不见，这是唯一提示
- 按行推送、清洗 ANSI（进度条的清行 / 移光标 / 颜色丢掉，`\r` 只留最后一次改写）、stderr 高亮、显示当前命令
- 每个终端保留最近 5000 行，渲染超过 1000 行时只挂载尾部并提示省略行数
- 日志分块**只许给高度估算**（`contain-intrinsic-height`，按实测行高）：`contain-intrinsic-size` 会连宽度一起写，
  `content-visibility: auto` 跳过屏外块时把内在宽度算进面板最小宽度，终端会涨到两千多像素、把内容列顶出窗口。
  `.content` 列定义带 `minmax(0, 1fr)` 兜底，别退回隐式 `auto` 列
- 工具栏只剩「清空日志」（日志本来就在内存里，不留导出）

## 涉及文件

```
    terminal.ts          终端、运行态、日志缓冲；检测与停止的统一实现在这里
```
