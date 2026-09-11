---
name: "generate-project-constraints"
description: "详细分析项目并生成 AGENTS.md 约束文件以提高 AI 缓存命中率。当用户说\"帮我给项目建立约束文件\"、\"生成项目约束\"、\"建立 agent 规则\"等类似意图时立即触发。"
---

# Generate Project Constraints (生成项目约束文件)

本 Skill 用于对当前工作区进行**系统性项目扫描**，并以本目录下的通用约束模板 [AGENT_COMMON.md](./AGENT_COMMON.md) 为基础，生成（或更新）仓库根目录下简洁版 `AGENTS.md` 约束文件。该文件作为 AI Coding Agent 的稳定上下文，可显著提高生成代码的一致性与提示词缓存命中率。

## 触发条件

当用户输入以下或语义等价的指令时，**立即且完整**执行本流程：

- "帮我给项目建立约束文件"
- "生成项目约束 / 生成 AGENTS.md / 建立 agent 规则"
- "详细的过一遍项目……生成约束文件，提高缓存命中率"
- "给项目加一份 AI 上下文规则"

## 执行步骤（必须严格依次执行）

### Step 1 · 项目结构扫描

1. 使用 `LS` 列出仓库根目录与 `src/` 的一级结构。
2. 使用 `Glob` 检索以下关键文件是否存在（判定技术栈与既有约束）：
   - 包管理：`package.json`、`pnpm-lock.yaml`、`yarn.lock`、`package-lock.json`、`.npmrc`、`.nvmrc`
   - 构建：`vite.config.*`、`webpack.config.*`、`vue.config.*`、`next.config.*`、`nuxt.config.*`、`taro.config.*`、`app.json`、`manifest.json`、`pages.json`
   - 语言：`tsconfig.json`、`jsconfig.json`
   - Lint/Format：`eslint.config.*`、`.eslintrc*`、`.prettierrc*`、`prettier.config.*`、`.editorconfig`、`stylelint.config.*`
   - 原子化 CSS：`uno.config.*`、`tailwind.config.*`、`postcss.config.*`
   - 测试 / CI：`vitest.config.*`、`jest.config.*`、`.github/workflows/*`
   - 其他：`.gitignore`、`README*`、`.vscode/settings.json`

### Step 2 · 关键文件深读

对存在的文件**逐一使用 `Read` 读取完整内容**（不要只读片段），重点收集：

- `package.json`：`name` / `version` / `type` / `scripts` / `dependencies` / `devDependencies` / `engines` / `packageManager`
- 构建配置：插件列表、alias、自动导入与组件解析器
- Lint/Prettier：基础预设、override 规则、是否启用 Prettier
- 原子化 CSS：preset / transformer / shortcuts
- 框架入口：`main.*` / `App.*` / 路由配置 / 状态管理注册
- `tsconfig.json` / `jsconfig.json`：路径别名、types
- `.vscode/settings.json`：保存动作、格式化器、ESLint validate 列表
- `.npmrc` / workspace 配置

### Step 3 · 建立技术栈画像

整理出以下事实清单（用于写入 AGENTS.md 项目专属章节）：

- 项目定位：应用类型（Web/小程序/桌面/Node/Monorepo）与业务领域
- 语言与版本：JS/TS/Vue SFC 等
- 主框架、状态管理、路由、UI 库、图标方案
- 原子化 CSS、预处理器（Sass/Less/Stylus/PostCSS）
- 数据请求：axios / uni.request / fetch wrapper
- 自动导入、Lint、Format、包管理器
- 构建工具、测试、CI
- 既有约束文件：根目录是否已有 `AGENTS.md` / `AGENT_COMMON.md`

### Step 4 · 生成 AGENTS.md（以通用约束模板为基础）

1. 先 `Read` 本 Skill 目录下的模板文件 `.trae/skills/generate-project-constraints/AGENT_COMMON.md`（跨项目通用约束，作为生成基础）。
2. 在仓库**根目录**创建或覆盖 `AGENTS.md`（若已存在，先 `Read` 比较后再 `Write` 覆盖），结构如下：

   - **「0. 通用约束」章节**：直接采用模板 `AGENT_COMMON.md` 的完整内容（修改原则 / 组件设计 / UI 与样式 / 验证与 Git），说明已并入本文件。
   - **项目专属章节**：在通用约束之后，用简洁的条目式写法补充，每节 3~10 条，只写**已存在的事实与强约束**，不写教程：
     1. **项目边界**：技术栈（语言 / 框架 / 构建 / 包管理器）与禁止引入的技术、库
     2. **文件落位**：页面 / 私有组件 / 公共组件 / API / store / util / 资源目录规则
     3. **编码规范**：框架版本边界、组件写法（如 `<script setup>` / Options）、弹窗表单模式、命名规则
     4. **UI 与样式**：UI 复用优先级、样式语言与作用域、样式穿透写法、原子化 CSS 约束、图标方案
     5. **请求 / 状态 / 配置**：请求封装、API 返回约定、环境变量管理、路由维护、Vuex、平台桥接
     6. **Agent 操作与验证**：可用的 npm 脚本（如 lint）、禁止事项、敏感配置保护

3. 生成结果必须与模板风格一致：**简洁、条目式、无冗余**，整体控制在 80~150 行。

### Step 5 · 写作质量要求

- 所有文件引用必须使用 `[basename](file:///绝对路径)` 格式，便于点击跳转；链接文本禁止用反引号包裹。
- 技术栈版本号必须与 `package.json` 完全一致，不得估计；不要编造未安装的依赖。
- 未引入的能力应在"项目边界"中明确"禁止引入"。
- 中文项目使用中文写作；保持与用户沟通语言一致。
- 不要写"待补充 / TBD / 占位"内容；某节确实不适用时说明"本项目不涉及"。

### Step 6 · 完成后报告

向用户输出**简短摘要**：

1. 识别到的核心技术栈（语言 / 框架 / 构建 / 包管理 / Lint / UI 库）
2. 生成的文件路径（点击链接）
3. 包含的章节标题列表
4. 任何需要用户后续确认的不确定点（如缺失 README、未发现 lint 配置等）

## 反模式（务必避免）

- ❌ 仅读 `package.json` 就生成约束（必须走完 Step 1-2）
- ❌ 把"建议"写成约束（如"建议使用 TS"），约束必须基于**已存在的事实**
- ❌ 把 AGENTS.md 写成教程文档，应是**事实清单 + 强约束**
- ❌ 忽略 `.vscode/settings.json` 中的 `prettier.enable`、`editor.codeActionsOnSave` 等关键信号
- ❌ 生成冗长的多章节模板文档，背离基础模板 `AGENT_COMMON.md` 的简洁风格

## 输出长度参考

- 完整 AGENTS.md 建议 **80~150 行**，与基础模板同样简洁；过短无法构成有效约束，过长会被截断且降低命中率。
