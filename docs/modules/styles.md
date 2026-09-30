# 样式（设计参考库）

样式（设计参考库）的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`shared/design-styles.ts`（token 模型、键名中文标签规则、行高归一化、色系判定）、
`shared/design-demo.ts`（示例页面文案）、`shared/design-export.ts`（DESIGN.md 与提示词的生成，带单测）、
`stores/styles.ts`、`apps/desktop/src-tauri/src/design.rs`（落盘）、`apps/desktop/src/renderer/public/design-styles.json`（数据）。

- **数据是随包静态资源，不是通道也不是用户数据**：`public/design-styles.json`（约 580KB，入库），
  第一次打开按 `import.meta.env.BASE_URL` 读一次并缓存进 store —— 读自己包里的文件，
  **不出网**，也不新增 IPC 通道。
- **颜色角色是三层匹配选出来的**（键名正则 → 中文标签正则 → 画布色与文字色现调），
  主文字与主色上的文字必须过**可读性检查**（`inkOn`）—— 深色设计里的 `ink` 键可能指深色表面，
  直接当文字色会在近黑画布上糊成一片。
- **token 引用展开不出来时宁可不画**（`expandTokenRefs` 回 `undefined`），
  不把 `{colors.x}` 原样写进样式表；所有取到的值再过 `safeCssValue`（挡 `url(...)`、分号、花括号）。
- **行高必须先归一化再绑到样式上**（`lineHeightCss`）：上游有倍数、不带单位的像素、带单位的像素
  三种写法，直接绑会把 `line-height: 64` 读成字号的 64 倍。
- **键名的中文标签由规则生成，不手写词典**：认不出的词段**原样保留**
  （`rausch` 这类专有名词硬翻反而失真）；单测守卫着「规则覆盖不住的比例」。
- **「应用到项目」先写文件再动剪贴板**（`design.rs` 临时文件 + 改名）：写失败时剪贴板里
  留一段「请读 DESIGN.md」只会误导人；剪贴板失败不算整体失败。

## 实现


- 74 套设计语言（配色 / 字体 / 圆角 / 间距 / 组件规格，取自各家公开站点的 DESIGN.md 分析）的一页浏览：
  卡片网格 + 搜索 + 明暗 / 分类 / 色系筛选 + 排序。**卡面就是这套设计的一小张页面**（导航、眉题、标题、
  副文案、按钮取它自己的 token，底色铺它的画布色），74 张并排过去是 74 种风格而不是 74 段要读完的文字简介；
  点开是「预览 / 规格」两档
- **两档都是 token 现画，没有截图也没有 iframe**。上游那套成品预览页是英文页面，塞进来等于把英文请回界面：
  - **预览**（默认档）：一整个中文示例页面（[StyleDemo.vue](../../apps/desktop/src/renderer/src/components/StyleDemo.vue)）——
    导航 / 首屏 / 功能卡 / 数据带 / 行动横幅 / 页脚，颜色、字阶、圆角、内边距取这套设计自己的值，
    看到的是「这套设计用起来是什么样」。文案按分类走（数据库的页面讲扩缩容、电商的讲当日达），
    表在 [design-demo.ts](../../packages/appearance/src/design-demo.ts)，分类认不出时用通用那套
  - **规格**：八段 token 陈列（配色 / 字体 / 按钮 / 卡片 / 表单 / 版式 / 间距 / 圆角），
    点色块或变量名直接复制 —— 预览给整体印象，规格给能抄走的值
- **颜色角色是三层匹配选出来的**，不是按固定键名直取（一半是 kebab-case 键、一半是散文格式的
  人写英文）：按 **键名正则 → 数据里的中文标签正则 → 画布色与文字色现调**（`mixHex`）三层挑，
  第三层保证一定有值。主文字与主色上的文字还要过**可读性检查**：深色设计里的 `ink` 键有时指
  深色表面（Binance 的 `#181a20`），直接当文字色会在近黑画布上糊成一片 —— 拉不开明暗差的候选
  一律不用，改按画布现算（`inkOn`）
- **数据是随包静态资源**，不是通道也不是用户数据：`apps/desktop/src/renderer/public/design-styles.json`（约 580KB，入库），
  页面第一次打开时按 `import.meta.env.BASE_URL` 读一次并缓存在 store（与 Vditor 资源同一条路）。
  读的是自己包里的文件，**不出网**；也不新增任何 IPC 通道。首屏不受影响 —— 不进这一页就不读
- **键名的中文标签是规则生成的，不是手写词典**：74 套一共 677 个颜色键、221 个字阶键、829 个组件键，
  手写无法维护。绝大多数键是 `surface-dark-elevated` 这种 kebab-case 组合，按
  [design-styles.ts](../../packages/appearance/src/design-styles.ts) 里的词段表逐段翻译（`on-` 前缀读作「……上的文字」、
  中缀 `-on-` 读作「（……上）」），高频键另有一张整键覆盖表；**认不出的词段原样保留** ——
  `rausch`（Airbnb 的品牌红）、`terraform` 这类专有名词硬翻反而失真。规则覆盖不住的只剩 2.7%，
  单测里有一条守卫盯着这个比例
- 那 10 套「散文格式」的 DESIGN.md（`kraken` `lamborghini` `lovable` `mastercard` `runwayml` `sanity`
  `spotify` `starbucks` `tesla` `theverge`）键名是人写的（`Hero Display`、`Spotify Green`），
  规则译不出来，他们的中文标签在构建数据时写进了条目的 `labels` 字段，规则表优先取它 ——
  示例页面的颜色角色与组件挑选同样拿它兜底
- 组件规格里的值写的是 `{colors.primary}` 这样的引用，渲染前由 `expandTokenRefs` 展开；
  **展开不出来时宁可不画**（回 `undefined`），也不把 `{colors.x}` 原样写进样式表 ——
  那会静默画出一个错颜色。引用**夹在别的值中间**的写法也认（`{spacing.sm} {spacing.md}` →
  `8px 12px`、`2px solid {colors.ink-deep}`），组件规格的 `padding` 与 `border` 大量是这种，
  认不出来会让按钮丢掉内边距、卡片丢掉描边。所有取到的值再过一道 `safeCssValue`（挡 `url(...)`、分号、花括号）
- 三个品牌（`lamborghini` / `runwayml` / `tesla`）上游没给组件规格：规格档的组件段如实说明一句、
  预览档与卡片的按钮按主色现画（底色主色、字色按对比度定），都不留白板。挑到组件规格但展开后
  既没底色也没描边的（引用的颜色键在这套里不存在）同样算没挑到，走现画 —— 只剩一条字阶的样张等于看不见
- 字体多为品牌专有字体（Copernicus、Airbnb Cereal VF…），本机没装会回落到系统字体 ——
  **字号、字重、字距、行高这些比例仍然是真的**，界面不假装它是原字体。尺寸按档位收敛
  （卡片标题 19px、示例页面首屏 48px 封顶），字重与字距保持原样
- **行高必须先归一化再绑到样式上**（`lineHeightCss`）：上游有倍数、不带单位的像素、带单位的像素
  三种写法 —— 不带单位的那种会被 CSS 读成倍数（`line-height: 64` = 字号的 64 倍，Mastercard 的标题
  被撑到 1216px 就是这么来的），带单位的那种字号收敛后比例失真。两种像素写法都按字号换算成倍数，
  倍数收在 0.8–2，关键字与 `em` 原样放行
- 色系与分类的筛选项由数据现算，不会出现点了没有任何结果的空档；
  色系判定与卡片角标用的是同一个函数（`colorFamily`）
- **「应用到项目」把一套设计搬进用户的代码仓库**：详情弹窗头部那颗按钮 → 选一个项目（列表块与
  「安装技能到项目」同款）→ 写 `<项目根>/DESIGN.md`（同名覆盖，回执里说明原本有没有这个文件）+
  把一段提示词复制到剪贴板。规范与提示词都是渲染层按 token 现生成的
  （[design-export.ts](../../packages/appearance/src/design-export.ts)，带单测）：文档里组件规格已展开成真实色值、
  行高换算成倍数，拿到手就能用；提示词按深浅基调各写一句，点明「先读 DESIGN.md 再动手」。
  **先写文件再动剪贴板** —— 写失败时剪贴板里留一段「请读 DESIGN.md」只会误导人；
  剪贴板失败也不算整体失败（规范已经在项目里了），单独提醒一句。
  落盘走通道 `writeDesign`（Rust 侧 `design.rs`：临时文件 + 改名）。落到哪个项目由渲染层把
  `Project.path` 传下去 —— 项目列表只活在 store 里，Rust 侧不知道它，也没有「取当前项目」这回事
- 74 条品牌设计分析**全部译成中文**（约 2 万字）；其中 6 个品牌的名称在上游数据里被改写过
  （`Shopifi` / `Sentri` / `Slacc` / `Stripi` / `Supabaze` 等），中文描述里已还原成真实品牌名




## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

```
  src/design.rs          设计规范落盘：把渲染层按 token 生成好的 DESIGN.md 写到目标项目的
                         根目录（先写临时文件再改名，同名覆盖，回执里带「原本有没有这个文件」）。
                         生成什么内容属于业务语义，在 shared/design-export.ts
apps/desktop/src/renderer/public/design-styles.json  随包的 74 套设计语言数据（约 580KB，入库）：
                         中文描述 + 各套的 colors / typography / rounded / spacing / components。
                         键名的中文标签由 shared/design-styles.ts 的规则现算，数据里只带
                         那 10 套散文格式品牌的手写标签（`labels`）
```

store（原注解）：

```
    styles.ts            样式：74 套设计语言的清单、搜索 / 筛选 / 排序与首次读取的编排。
                         数据是随包静态资源（public/design-styles.json 那份），不进通道、不落盘
```
