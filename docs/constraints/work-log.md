# 工作日志

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束（工作页那条时间轴）；功能说明见
[features-and-architecture.md](../features-and-architecture.md) 的「数据与隐私」一节里 `work-log.json` 那一段。

关键落点：`src/shared/work-log.ts`（时间轴口径）、`src/renderer/src/workbench/work-log.ts`（懒加载整份文件）、
`src/shared/markdown.ts`（渲染）、`src/renderer/src/components/MarkdownView.vue`（点击接管）。

- **只在本机、不进同步仓库**：它不写进 `workbench-data.json`，而是单独一份 `work-log.json`，也不随同步走 —— 工作内容是最贴近
  个人记录的东西，多机合并没有成立的口径（不像用量数字那样可相加）。数据目录迁移时它跟着搬（`paths.rs` 的 `migrate_data_dir`），
  别为了「顺手统一」把它塞进同步或主数据文件。
- **正文按 markdown 渲染，解析用 markdown-it**（[markdown.ts](../../src/shared/markdown.ts)，唯一新增的前端运行时依赖）：
  `html: false` 转义原文里的标签、`linkify` 认裸地址、`breaks` 让单个换行就是 `<br>`；链接一律 `target="_blank"`，且点击在
  [MarkdownView.vue](../../src/renderer/src/components/MarkdownView.vue) 里被接管交给 `openExternal` —— 界面是个 WebView，
  点 `<a>` 默认会把应用自己导航走。**别再自己手写解析器或引第二个 markdown 库。**
