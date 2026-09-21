## 目标

把 awesome-design-md 的 74 套设计语言做成 Workbench 里的一个新导航页「样式」：**原生渲染**（不加载任何外部 HTML、不用截图），界面文案与 74 条品牌设计分析**全部中文**，并且不再有「原版 / 生成」这套来源区分。

## 一、数据产物

新增 `src/renderer/public/design-styles.json`（约 700KB，**提交入库**），74 条，每条：

- 基本：`brand` / `title` / `theme`(light|dark) / `accent` / `canvas` / `category`（中文分类，如「AI 平台」「开发工具」「汽车」）
- `description`：中文译文（原文是那 74 段英文设计语言分析，共约 5.3 万英文字符）
- `colors` / `typography` / `rounded` / `spacing` / `components`：沿用已解析结果，保留 `{colors.primary}` 这类引用（渲染时展开）
- `labels`：**只给那 10 个「散文格式」品牌**（kraken / lamborghini / lovable / mastercard / runwayml / sanity / spotify / starbucks / tesla / theverge）带键名→中文映射，因为它们的键名是人写的散文式（`Hero Display`、`Spotify Green`），规则译不出来
- `_meta`：来源仓库、快照时间、计数（交代出处）

数据取自上一轮那个画廊已经解析好的 `tokens.json`（74 套全量），加上新一轮的 74 条中译。不引 Python 流程、不加 npm 依赖 —— 上游是冻结快照，这个 JSON 就是真源。

**为什么放 `public/` 而不塞进 JS bundle**：700KB 进主 bundle 会拖慢启动，还要被 vue-tsc 类型推导。放 `public/` 后按 AGENTS.md 的约定用 `${import.meta.env.BASE_URL}design-styles.json` 引用，**首次打开这一页时同源读取一次并缓存在 store**。这是读随包资源，不是网络出口，也不新增任何 IPC 通道。

## 二、共享纯逻辑

新增 `src/shared/design-styles.ts` + 同目录 `design-styles.test.ts`：

- 类型：`DesignStyle` / `DesignColorToken` / `DesignTypeToken` / `DesignComponentToken`
- `sanitizeDesignStyles(raw)`：外部 JSON 收敛，手改坏不能白屏
- `resolveRef(value, tokens)`：展开 `{colors.primary}` 这类引用
- 颜色工具：`parseHex`、`inkOn(hex)`（按对比度自动定黑白字）、`colorFamily(hex)` → 中文色系（红/橙/黄/绿/青/蓝/紫/粉/中性）
- **中文标签规则**（这是「全中文」的核心）：段词典（`primary`→主色、`canvas`→画布、`ink`→文字、`surface`→表面、`on-`→…上的文字、`hairline`→细线、`pressed/active/disabled/hover`、`text-input`→输入框、`button`→按钮…）＋高频键覆盖表，导出 `colorLabel` / `typeLabel` / `componentLabel` / `roundedLabel` / `spacingLabel`。长尾键（色板去重后 677 个、组件 829 个）靠规则而非手写词典覆盖
- 筛选排序：`filterDesignStyles`（关键词 / 明暗 / 色系）、`sortDesignStyles`（名称 / 色相 / 深色优先）

## 三、渲染层

- `stores/styles.ts`（Pinia setup store）：懒加载 JSON 一次并缓存、`query` / `mode` / `family` / `sort` 状态、loading 与 error
- `components/StylesView.vue`：`.filter` 工具带（搜索框 + 明暗 chip + 色系 chip + `.sort` 排序下拉 + 右侧计数）＋ 自滚网格 ＋ 两种空态（「筛没了」与「加载失败」）
- `components/StyleCard.vue`：整卡可点、可键盘操作（照 `SkillCard.vue` 的 `role="button"` + Enter/Space）；卡面 = **用该品牌自己的色值画色条、用它的 display 字号渲染品牌名** + 中文描述 2–3 行截断 + 统计（N 色 · N 字阶 · N 组件）+ 明暗/色系角标
- `components/StyleDetailDialog.vue`：`AppDialog`，七段原生样张，全中文标题
  1. **配色** —— 按角色分组色块，中文标签 + hex，点击复制
  2. **字体** —— 字阶表（字号/字重/行高/字距）+ 用该字号渲染的中文示例句
  3. **按钮** 4. **卡片** 5. **表单**（含输入框聚焦态）6. **间距**（标尺）7. **圆角**
  第 3–5 段直接用组件 token 渲染真实样张（背景/文字/圆角/内边距/高度全取 token）；三个没有组件规格的品牌（lamborghini / runwayml / tesla）该段显示一行中文说明

按你选的默认：**token 键名保留为次级 mono 小字**（如中文标签「主色·激活」下面跟一行 `primary-active`，可点击复制），方便把这个设计用到别的项目时抄变量名。不想看到英文标识符的话，实现时我去掉这一行即可。

复用现成东西，不重造：`.filter` / `.chip` / `.sort` / `.empty` / `.facts` 用 global.css 外壳，弹窗走 `AppDialog`，颜色间距圆角字号一律取 `tokens.css`，卡片底色用 `rgba(var(--bg-surface-rgb), var(--card-alpha,1))` 以跟随「卡片不透明度」设置。

## 四、页面注册（4 处必改）

| 文件 | 改动 |
| --- | --- |
| `src/shared/views.ts` | `VIEW_IDS` 加 `'styles'`；`VIEW_LABELS` 加 `styles: '样式'` |
| `src/renderer/src/components/NavRail.vue` | `ICONS` 加图标（Element Plus `Brush`） |
| `src/renderer/src/App.vue` | import 新页面 + `VIEWS` 加一项 |
| `src/shared/views.test.ts` | 第 44、48 行硬编码的期望数组同步（否则必挂） |

设置里的「导航菜单」开关是动态遍历 `VIEW_IDS`，新页自动出现，不用改。

## 五、74 条中译怎么做

并行派 8 个 subagent，各领 9–10 个品牌，统一术语表（canvas=画布、ink=文字、hairline=细线、CTA=行动按钮、wordmark=品牌字标、token=设计变量），保留品牌名/字体名/hex 原文，输出严格 JSON。我汇总后校验：条数齐、无残留英文句子、术语一致。

## 六、验证

- `npm run typecheck`（vue-tsc + tsc）、`npm test`（新增 `design-styles.test.ts` 与改过的 `views.test.ts`）
- 起 `npm run dev`，用 CDP 进渲染层核对：74 张卡、搜索按 HEX/中文/字体、明暗与色系筛选、三种排序、弹窗七段、亮暗主题下都正常
- 本次**不动 Rust**，所以只需渲染层验证；按 AGENTS.md，视觉验证的工作区用完即删

## 七、文档

- `docs/features-and-architecture.md`：补「样式」页的功能说明、数据来源与「随包静态 JSON 放 `public/`」这一新落点
- 若定了新的跨模块约定，同步 `docs/constraints/`

## 明确不做

- 不加 IPC 通道、不改 Rust、不加 npm 依赖
- 不带截图缩略图：原版预览页本身是英文的，与全中文冲突，这正是「预览来源」筛选自然消失的原因
