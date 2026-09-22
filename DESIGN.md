# Claude 设计规范

> 由 Workbench 样式参考库导出 ｜ 分类：AI 与大模型 ｜ 浅色系 ｜ 主色橙

Anthropic 旗下 Claude 产品的一套暖调画布编辑风界面。系统锚定在带色调的奶油色画布上，配衬线标题、暖珊瑚色的行动按钮，以及深藏青的产品表面（代码编辑器示意稿、模型展示卡片）。品牌张力来自奶油色与珊瑚色这一组搭配——在大多数 AI 品牌都用冷蓝加石板灰的时候，它刻意选择温暖与人文。字体基调是 h1/h2 用一款粗衬线标题字体（Copernicus / Tiempos Headline），正文用人文无衬线。Anthropic 标志性的黑色放射尖刺标识托住品牌字标。

## 基础

| 项目 | 值 |
| --- | --- |
| 画布色 | `#faf9f5` |
| 主色 | `#cc785c` |
| 主色上的文字 | `#ffffff` |
| 主文字 | `#141413` |
| 次文字 | `#6c6a64` |
| 卡片底色 | `#efe9de` |
| 分隔线 | `#e6dfd8` |
| 展示字体 | `Copernicus` |

## 颜色（25 个）

### 品牌与强调

| 变量名 | 含义 | 色值 |
| --- | --- | --- |
| `primary` | 主色 | `#cc785c` |
| `primary-active` | 主色·激活 | `#a9583e` |
| `primary-disabled` | 主色·禁用 | `#e6dfd8` |
| `on-primary` | 主色上的文字 | `#ffffff` |
| `accent-teal` | 强调色·青绿 | `#5db8a6` |
| `accent-amber` | 强调色·琥珀 | `#e8a55a` |

### 表面与画布

| 变量名 | 含义 | 色值 |
| --- | --- | --- |
| `canvas` | 画布 | `#faf9f5` |
| `surface-soft` | 表面·柔和 | `#f5f0e8` |
| `surface-card` | 表面·卡片 | `#efe9de` |
| `surface-cream-strong` | 表面·奶油·加重 | `#e8e0d2` |
| `surface-dark` | 表面·深色 | `#181715` |
| `surface-dark-elevated` | 表面·深色·抬升 | `#252320` |
| `surface-dark-soft` | 表面·深色·柔和 | `#1f1e1b` |

### 文字与线条

| 变量名 | 含义 | 色值 |
| --- | --- | --- |
| `ink` | 文字色 | `#141413` |
| `body` | 正文 | `#3d3d3a` |
| `body-strong` | 正文（加重） | `#252523` |
| `muted` | 弱化 | `#6c6a64` |
| `muted-soft` | 弱化·柔和 | `#8e8b82` |
| `hairline` | 细线 | `#e6dfd8` |
| `hairline-soft` | 细线·柔和 | `#ebe6df` |

### 语义状态

| 变量名 | 含义 | 色值 |
| --- | --- | --- |
| `success` | 成功 | `#5db872` |
| `warning` | 警告 | `#d4a017` |
| `error` | 错误 | `#c64545` |

### 其它

| 变量名 | 含义 | 色值 |
| --- | --- | --- |
| `on-dark` | 深色上的文字 | `#faf9f5` |
| `on-dark-soft` | 深色·柔和上的文字 | `#a09d96` |

## 字体（14 档）

| 变量名 | 含义 | 字体 | 字号 | 字重 | 行高 | 字距 |
| --- | --- | --- | --- | --- | --- | --- |
| `display-xl` | 展示字（特大） | `Copernicus, Tiempos Headline, serif` | `64px` | `400` | `1.05` | `-1.5px` |
| `display-lg` | 展示字（大） | `Copernicus, Tiempos Headline, serif` | `48px` | `400` | `1.1` | `-1px` |
| `display-md` | 展示字（中） | `Copernicus, Tiempos Headline, serif` | `36px` | `400` | `1.15` | `-0.5px` |
| `display-sm` | 展示字（小） | `Copernicus, Tiempos Headline, serif` | `28px` | `400` | `1.2` | `-0.3px` |
| `title-lg` | 标题·大 | `StyreneB, Inter, sans-serif` | `22px` | `500` | `1.3` | `0` |
| `title-md` | 标题·中 | `StyreneB, Inter, sans-serif` | `18px` | `500` | `1.4` | `0` |
| `title-sm` | 标题·小 | `StyreneB, Inter, sans-serif` | `16px` | `500` | `1.4` | `0` |
| `body-md` | 正文（中） | `StyreneB, Inter, sans-serif` | `16px` | `400` | `1.55` | `0` |
| `body-sm` | 正文（小） | `StyreneB, Inter, sans-serif` | `14px` | `400` | `1.55` | `0` |
| `code` | 代码 | `JetBrains Mono, ui-monospace, monospace` | `14px` | `400` | `1.6` | `0` |
| `button` | 按钮 | `StyreneB, Inter, sans-serif` | `14px` | `500` | `1` | `0` |
| `nav-link` | 导航链接 | `StyreneB, Inter, sans-serif` | `14px` | `500` | `1.4` | `0` |
| `caption` | 说明字 | `StyreneB, Inter, sans-serif` | `13px` | `500` | `1.4` | `0` |
| `caption-uppercase` | 说明字（全大写） | `StyreneB, Inter, sans-serif` | `12px` | `500` | `1.4` | `1.5px` |

> 行高按倍数给出：上游有的把像素行高写成不带单位的数字（`64`），直接当 CSS 用会被读成「字号的 64 倍」。

## 圆角（7 档）

| 变量名 | 含义 | 值 |
| --- | --- | --- |
| `xs` | 极小 | `4px` |
| `sm` | 小 | `6px` |
| `md` | 中 | `8px` |
| `lg` | 大 | `12px` |
| `xl` | 特大 | `16px` |
| `pill` | 胶囊 | `9999px` |
| `full` | 全 | `9999px` |

## 间距（8 档）

| 变量名 | 含义 | 值 |
| --- | --- | --- |
| `xxs` | 微小 | `4px` |
| `xs` | 极小 | `8px` |
| `sm` | 小 | `12px` |
| `md` | 中 | `16px` |
| `lg` | 大 | `24px` |
| `xl` | 特大 | `32px` |
| `xxl` | 超大 | `48px` |
| `section` | 区块 | `96px` |

## 组件

### 按钮

**主按钮** `button-primary`

- 底色：`#cc785c`
- 文字：`#ffffff`
- 圆角：`8px`
- 内边距：`12px 20px`
- 尺寸：`40px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1，字距 0

**主按钮（激活）** `button-primary-active`

- 底色：`#a9583e`
- 文字：`#ffffff`
- 圆角：`8px`

**主按钮（禁用）** `button-primary-disabled`

- 底色：`#e6dfd8`
- 文字：`#6c6a64`
- 圆角：`8px`

**次按钮** `button-secondary`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`8px`
- 内边距：`12px 20px`
- 尺寸：`40px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1，字距 0

**次按钮（深色上）** `button-secondary-on-dark`

- 底色：`#252320`
- 文字：`#faf9f5`
- 圆角：`8px`
- 内边距：`12px 20px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1，字距 0

**文字链接按钮** `button-text-link`

- 底色：`transparent`
- 文字：`#141413`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1，字距 0

**圆形图标按钮** `button-icon-circular`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`9999px`
- 尺寸：`36px`

**文字链接** `text-link`

- 底色：`transparent`
- 文字：`#cc785c`
- 字体：StyreneB, Inter, sans-serif，16px，字重 400，行高 1.55，字距 0

**分类标签页** `category-tab`

- 底色：`transparent`
- 文字：`#6c6a64`
- 圆角：`8px`
- 内边距：`8px 14px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1.4，字距 0

**分类标签页（激活）** `category-tab-active`

- 底色：`#efe9de`
- 文字：`#141413`
- 圆角：`8px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1.4，字距 0

**胶囊徽标** `badge-pill`

- 底色：`#efe9de`
- 文字：`#141413`
- 圆角：`9999px`
- 内边距：`4px 12px`
- 字体：StyreneB, Inter, sans-serif，13px，字重 500，行高 1.4，字距 0

**徽标·珊瑚** `badge-coral`

- 底色：`#cc785c`
- 文字：`#ffffff`
- 圆角：`9999px`
- 内边距：`4px 12px`
- 字体：StyreneB, Inter, sans-serif，12px，字重 500，行高 1.4，字距 1.5px

另有 2 个同类组件未展开。

### 卡片

**首屏·插画·卡片** `hero-illustration-card`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`16px`

**功能卡片** `feature-card`

- 底色：`#efe9de`
- 文字：`#141413`
- 圆角：`12px`
- 内边距：`32px`
- 字体：StyreneB, Inter, sans-serif，18px，字重 500，行高 1.4，字距 0

**产品·示意稿·卡片·深色** `product-mockup-card-dark`

- 底色：`#181715`
- 文字：`#faf9f5`
- 圆角：`12px`
- 内边距：`32px`
- 字体：StyreneB, Inter, sans-serif，18px，字重 500，行高 1.4，字距 0

**代码·窗口·卡片** `code-window-card`

- 底色：`#181715`
- 文字：`#faf9f5`
- 圆角：`12px`
- 内边距：`24px`
- 字体：JetBrains Mono, ui-monospace, monospace，14px，字重 400，行高 1.6，字距 0

**模型·对比·卡片** `model-comparison-card`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`12px`
- 内边距：`32px`
- 字体：StyreneB, Inter, sans-serif，18px，字重 500，行高 1.4，字距 0

**定价档卡片** `pricing-tier-card`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`12px`
- 内边距：`32px`
- 字体：StyreneB, Inter, sans-serif，22px，字重 500，行高 1.3，字距 0

另有 4 个同类组件未展开。

### 表单

**输入框** `text-input`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`8px`
- 内边距：`10px 14px`
- 尺寸：`40px`
- 字体：StyreneB, Inter, sans-serif，16px，字重 400，行高 1.55，字距 0

**输入框（聚焦）** `text-input-focused`

- 底色：`#faf9f5`
- 文字：`#141413`
- 圆角：`8px`

### 版式

**顶部导航** `top-nav`

- 底色：`#faf9f5`
- 文字：`#141413`
- 尺寸：`64px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 500，行高 1.4，字距 0

**首屏色带** `hero-band`

- 底色：`#faf9f5`
- 文字：`#141413`
- 内边距：`96px`
- 字体：Copernicus, Tiempos Headline, serif，64px，字重 400，行高 1.05，字距 -1.5px

**页脚** `footer`

- 底色：`#181715`
- 文字：`#a09d96`
- 内边距：`64px`
- 字体：StyreneB, Inter, sans-serif，14px，字重 400，行高 1.55，字距 0

## 使用说明

- 颜色、字号、字重、字距、行高、圆角、间距一律取本文档的值，不要另拍一套；需要中间值时，取相邻的一档。
- 界面以「画布色」打底、「主文字」为正文色，主色只用于强调与主要动作。
- 字体按上文声明的字体族与字重来；字体文件可能没装，回落到系统字体没问题，但字号、字重、字距的比例要保留。
- 按钮、输入框、卡片等按「组件」一节给出的底色、描边、圆角、内边距实现。
- 不要为这套样式引入新的 UI 库、字体 CDN 或其它外部资源。
