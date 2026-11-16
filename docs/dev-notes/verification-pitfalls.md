# 验证的量法与坑

量对比度、手写静态 HTML 的理由，以及历次踩过的坑。工作区见 [browser-preview-verification.md](browser-preview-verification.md)，
真应用里那一套见 [tauri-app-verification.md](tauri-app-verification.md)。

## 量对比度，别靠肉眼

判断"暗色主题下悬停时文字变黑、到底看不看得清"，肉眼不可靠。
读 `getComputedStyle` 拿到实际颜色，按 WCAG 算相对亮度与对比度，给出数字：

```js
const lum = (rgb) => rgb.map((c) => {
  const x = c / 255
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}).reduce((acc, cur, i) => acc + [0.2126, 0.7152, 0.0722][i] * cur, 0)
// 对比度 = (亮 + 0.05) / (暗 + 0.05)，低于 3:1 就可以判定"看不清"
```

把场景做成矩阵（暗 / 亮 × 有无主题色 × 文字取色模式），一次跑完输出一张对照表。

**背景不是纯色时，`getComputedStyle` 答不了这个问题** —— 这个应用里这种情况很常见：
画布是「壁纸 + 蒙版」的合成，卡片又是 60% 不透明度的底色叠在上面（设置里的「卡片不透明度」），
背景究竟是多少只能看最终像素。办法是让页面自己解码一张截图：

```js
// 1. 先截一条**没有文字**的窄带（背景）—— 空白的来源可以量，别从文字所在的那一行取
// 2. 把这张 PNG 的 base64 交给页面，用 canvas 取平均色
const cap = await send('Page.captureScreenshot', { format: 'png', clip: strip })
await send('Runtime.evaluate', { expression: `(async () => {
  const img = new Image(); img.src = 'data:image/png;base64,${cap.result.data}'
  await img.decode()
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, img.width, img.height).data
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n += 1 }
  return [Math.round(r/n), Math.round(g/n), Math.round(b/n)]
})()`, awaitPromise: true, returnByValue: true })
// 3. 文字色仍取 getComputedStyle，两边算 WCAG
```

取「没有文字的那条带」有个现成的落点：容器自己的 `padding`（例如首页那一行与画布上沿之间的
`--card-gap`）或卡片底部那段留白 —— 用 `getBoundingClientRect` 把它的位置算出来交给 `clip`。

顺带一个结论（2026-09 量过，也是这一节的来源）：**「主题极性与壁纸亮度相反」那一组会塌**。
蒙版是「画布色 + `1 - 图片浓淡`」的 alpha（默认浓淡 35 → alpha 0.65），深色壁纸配亮色主题时
画布合成出来是中灰 —— 而**中灰底上没有任何文字色是清楚的**：深色字实测 1.9:1，
要够 4.5:1 得用近白字（那在亮色主题里等于换了套主题）。所以这不是「换个令牌」能修的，
必须让底衬本身回到主题这一侧。两条对它有效的做法，两条都已落地：

- **别让文字直接铺在画布上**：给这类文字一副跟卡片同一套 `--card-alpha` 的底衬
  （首页那一行就是这么做的）。好处是可读性交给用户已经熟悉的那个滑块，和界面上其余文字同一档待遇。
  注意卡片本身也是 60% 底色，所以**卡片上的次要文字同样会塌**（实测 1.86:1）——
  把「卡片不透明度」拉到 100% 就全好了（实测同一处 6:1），这是那个滑块的固有取舍，不是令牌写错。
- **两套主题的 ink 阶梯要用同一条标尺量**：亮色那套原先的 `--ink-3` 在**纯白卡片上**也只有
  3.15:1、在画布上 2.83:1（暗色那套是 4.8~5.3），也就是说不用挂壁纸就已经不到 AA 了。
  修法是把三档一起按对比度重定（只压暗最低那档会让它贴到上一档、三档塌成两档）。
  判据用数字：亮色修完是 17.4 / 10.0 / 5.7，暗色是 15 / 9.4 / 5.1。
  （2026-11 暗色两档再抬到 ink-2 `#c2cbd6` / ink-3 `#98a2b0`，画布上 10.6 / 6.7 —— 这次校准用的就是
  本文件这套无头配方：喂用户的真实壁纸与卡片不透明度逐页截图量的。裸压壁纸的空态文字其后又统一提到
  最高一档 ink（白色），描边与垫底两案都被用户否掉。）

**关键**：探针里复算主题色的算法（`mix` 混色、`inkOf` 取字色）必须和
[`packages/appearance/src/color.ts`](../../packages/appearance/src/color.ts) 的 `mixHex`、
[`accent-color.ts`](../../packages/appearance/src/accent-color.ts) 的 `inkOnAccent` 真实实现**同源照抄**，
并且切场景的方式要和 `bootstrap.ts` 的 `writeAccentColor` 一致（空值就是逐个摘掉内联属性）。
算法不一致的话，量出来的是一份假象。

## 为什么有些页要手写静态 HTML

组件的 `<style scoped>` 平时很难单独观察。要精确量间距时，可以写一个独立静态页，
把组件的结构和它的 scoped 样式**原样复制**进去，在浏览器里量准了再回头改组件。
这样做的前提是"原样复制"——复制时偷懒改了两行，量出来的结论也就不作数了。

## 已知的坑

- **`backdrop-filter` 会把元素变成层叠上下文，里面的浮动面板会被后画的卡片盖住**：
  顶栏（`.topbar`）在「毛玻璃」那一档带 `backdrop-filter`，于是顶栏内部那张搜索结果面板的
  `z-index: 30` 只在这个上下文里比大小 —— 而画布里的卡片是定位元素（`position: relative`、
  `z-index: auto`），按**树序**排在顶栏之后，整块盖在面板上面。卡片自己又是半透明的
  （卡片不透明度），两层叠起来就是「面板透底、底下的卡片内容透上来」。
  顶栏显式 `position: relative; z-index` 抬一手即可。**这一档才会露馅**：透明 / 正常两档
  顶栏不构成层叠上下文，面板的 z-index 直接和卡片在同一层比，所以只截那两档是验不出来的 ——
  验证浮动面板时要把顶栏三档都过一遍。
  **现在面板、卡片、弹层、下拉都带这一层**（见 features-and-architecture.md 的
  「浮在壁纸上的面一律是毛玻璃」一条），谁里面要放浮动内容，谁就得 Teleport 到 `body` 画
  （`el-tooltip` / `el-dropdown` 默认就是）。
- **弹层自己也带 `backdrop-filter` 之后要多看一眼**：`.el-dialog` / `.el-drawer` / `.el-message-box`
  现在是磨砂面（global.css 的「浮层的玻璃」）。历史上「弹层整块画不出来 / 只画出一截」出过，
  当时的解法是每个弹层都 **append-to-body**（离开 `.app` 子树）—— 这条前提不能破；
  真再遇到那个症状，先把这三个选择器的 `backdrop-filter` 关掉对比，再往深里查。
- **祖先上有 `opacity` / `filter` / `isolation` 时，毛玻璃会「什么都取不到」**：
  `backdrop-filter` 只在自己那个 backdrop root 里取样，遇到这类祖先就只剩祖先内部那点画面。
  实例：首页拖卡片时那张卡是 `.board-card.is-floating { opacity: 0.92 }`，卡里面板的磨砂
  取不到壁纸，看着像一张平的半透白 —— 这一帧的差别接受掉了（要修就把那点透明度去掉）。
  注意 `transform` **不**构成 backdrop root，所以卡片悬停那 1px 抬升不影响磨砂。
- **Element Plus 的弹层不信 `offsetParent`**：popper 是 `position: fixed`，可见时
  `offsetParent` 照样是 `null`，拿它当「面板打开了吗」的判据会一直判成没打开。
  用 `getComputedStyle(popper).display !== 'none'`（或 `aria-hidden`）来判断。
- **展开的日历 / 下拉会盖住旁边的控件**：popper 按输入框左缘定位、宽 300+，
  很容易压住同一行右边那个输入框，这时点右边的框其实点在面板上。
  换控件前先发一次 `Input.dispatchKeyEvent` 的 Esc 关掉它。
- **指针停在图表柱子上会弹出一块深色提示，它会吃掉那一带的合成点击**：`el-tooltip` 挂在柱子上，
  指针停够 `show-after` 就弹出；此时若指针不动、只让数据变（例如切「天/周/月」页签），
  提示会原地留着不走 —— 在这套无头环境里它还被摆到 `x=0`，正好压住卡片标题行。
  症状是「点某个控件毫无反应」，很容易误判成新写的控件坏了。
  定位办法：`document.elementFromPoint(控件中心)` 看命中的是谁（我这边命中 `DIV.tip`，
  就是柱子提示的正文）。规避办法：每次点击前先把指针挪到卡片外的空白处再移回来
  （`Input.dispatchMouseEvent` 的 `mouseMoved`），别让它停在图表上。
  这是柱子提示本来就有的毛病（跟改动无关，指针一移开就散），别顺着新控件的代码找。
- **`el-popover` 的 `width` 默认值是 150，而且写成内联 `style="width:150px"`**：
  内联样式压过样式表，面板内容会直接溢出那 150px 的盒子，画到边框与阴影外面。
  要按内容自适应，得用 `popper-style="width: auto"` 覆盖（`min-width` 另配样式表改），
  别只在 CSS 里写 `width` / `min-width`。
- **注入 HTML 必须用 Node 读写，不要用 PowerShell 的 `Get-Content` / `Set-Content`**：
  它按本地代码页解码，会把中文注释的字节连同换行一起吃掉，注入后的脚本直接语法错误。
- **`el-dialog` 想做成「左菜单 + 右内容」这类分区时要同时拆三层，而且弹窗得给定高**：
  EP 自己在 `.el-dialog` 上留了 16px 内边距、在 `.el-dialog__body` 上留了 30/20 内边距，
  两栏的可用宽度是「弹窗宽 − 32 − 正文内边距 − 滚动条 10」量出来的（按 920 宽的弹窗算只剩 669）；
  `class` 落在 `.el-dialog` 上、`body-class` 落在正文上，正文还是 EP 生成的元素，scoped 样式够不着，
  这两条只能写进 `global.css`。
  正文高度必须由弹窗的 `height` 定死（`min(700px, calc(100vh - var(--h-titlebar) - 48px))`），
  只给 `max-height` 让弹窗按内容定高的话，正文高度成了内容反推的结果，
  右侧内容区拿不到滚动高度、会被 `overflow: hidden` 整块裁掉（滚都滚不到），
  `height: 100%` 也解析不出来 —— 症状是「两栏高过弹窗、下半截直接没了」。
- **去掉页脚的弹窗要自己收紧正文内边距**：上面那个 30/20 是 EP 按「正文下面还有一个按钮行」留的，
  只靠右上角 × 关闭时不放页脚，底部就会空出一大块、内容看着像没对齐 ——
  放大截图里一眼能看见，正常尺寸下只是「说不上来哪里怪」。
  写法是给弹窗挂个 class、在 `global.css` 里把 `.el-dialog__header` / `.el-dialog__body`
  的内边距按实际结构定死（见 `.account-dialog`）。
- **鼠标指针是真的移过去才能量 `:hover`**（`Input.dispatchMouseEvent` 的 `mouseMoved`）：
  量到的 `getComputedStyle(...).backgroundColor` 才是悬停色，只读静态样式会得到「没反应」的错觉。
  **滚动伪元素是例外，它不随 `:hover` 重算**（见下面那条）。
- **滚动条的「悬停态」选择器在这版 Chromium 里已经失效**：`global.css` 一直靠
  `:hover::-webkit-scrollbar-thumb` 表达「滑块平时透明、指针移进滚动区才浮现」，
  但 Edge 152（WebView2 跟着它走）起，**滚动容器自身的 `:hover` 不再带动滚动伪元素重算** ——
  滑块永远停在透明那一档，症状是「所有滚动区都没有滚动条」（`::-webkit-scrollbar-thumb:hover`
  同样失效，且没法用 CSS 找回来）。换成由**父元素**发号（`:hover > ::-webkit-scrollbar-thumb`）
  立刻就好：祖先的 `:hover` 照旧带动子树重算，而指针落在容器里时父元素当然也是 `:hover`。
  探针怎么问：一张最小页，两个 `overflow: auto` 的盒子分别写这两种选择器，
  把指针移进盒子里各截一张 —— 前者空白、后者出滑块，一眼定性。
  判断依据**要用截图、不要用 `getComputedStyle(el, '::-webkit-scrollbar-thumb')`**：
  它压根不随 `:hover` 重算，改前改后返回同一个值（会得出「改不改都一样」的错觉）。
- **共用外壳的类写在某个组件的 scoped 样式里时，第二个用它的页面只会吃到颜色、丢掉排版**：
  项目页那条筛选工具带的 `.filter` 当初只写在 ProjectFilterBar.vue 的 `<style scoped>` 里，
  global.css 里只有 `.app.top-band/glass/clear .filter` 那三档颜色规则。工作页照同名 class 用，
  于是 display 还是 `block`：范围标签与「记一条」各占一整行竖着堆，计数被按钮压住 ——
  截图上像「工具条被挤扁」，其实只是排版没生效。**判据是 `getComputedStyle(el).display` +
  `getBoundingClientRect()`，别照着截图猜**（用探针脚本把工具条各级节点的盒子打出来最快）。
  结论是共用外壳（`.panel`、`.facts`、`.filter` 这类）一律写进 global.css，谁都不当「规矩的出处」。
- **弹窗表单漏了 `label-position="top"` 时，症状是「标签像嵌在控件里、两行输入框对不齐」**：
  `el-form` 默认 `label-position="right"`，`.el-form-item` 又是 `display: flex`，标签于是横排在控件左边；
  而 global.css 的「弹窗表单」一节是按「标签在上」写的（`.el-form-item__label` 的 `padding` 清成了 0），
  横排时标签正好贴住控件左缘。2026-09 量「添加常用软件」：标签与预览卡左缘 436、两个输入框被标签推到 460，
  其中带「浏览」按钮那行的输入框只有 379 宽、另一行 464 —— 右缘差 85px，看着就是「这个弹窗没排过版」。
  判据是 `document.querySelector('.el-form--label-top')` 是不是 null（漏了属性时 form 的类是
  `el-form--label-right`），别照着截图猜字号或间距。**弹窗字段一律带这个属性**，见
  [features-and-architecture.md](../../docs/features-and-architecture.md) 的「UI 与样式通用口径」。
- **v-html 里的列表看不见圆点**：global.css 的 reset 把 `ul / ol` 的 `list-style` 清成了 none
  （那是给界面自己的布局列表定的），markdown 正文渲染出来后同样吃这条规则 ——
  在展示组件的 `:deep()` 里把 `list-style` 写回来（disc / decimal），否则有序列表看着像没有序号。
- **整页桩漏了某个通道时，症状是「某一块卡片只剩外壳」**：`[data-card-id]` 那层容器在，
  组件自己的根节点（例如快捷启动的 `.launch`）却不在 DOM 里 —— 说明那个组件在首次渲染时抛了
  （Vue 把错误吞进 console.error，所以 `document.title` 上那条错误钩子也接不到，页面看着毫无异常）。
  **先回真实应用确认那一格是不是好的**，再决定要不要查组件：本次就是这样发现是桩的问题
  （换一份数据喂进去照样是空壳，而真实应用里那五个图标都在）。别顺着组件代码找。
- **浏览器预览只覆盖渲染层一半**：涉及文件系统、子进程、图像解码的都在 Rust 侧，回 `cargo test` 或真应用里验。
- **产物要用 http 打开，别用 `file://`**：Chromium 会按 CORS 拦掉 `file://` 下的
  `<script type="module">`，页面一片空白、控制台外没有任何迹象。在截图脚本里起一个十几行的
  静态服务器（`node:http` + `readFileSync`，按后缀给 `Content-Type`）指向 `.preview/dist` 即可。
- **假的 `window.workbench` 必须实现 `getBootstrap`**：`bootstrapSnapshot()` 走的就是它
  （见 [bootstrap.ts](../../apps/desktop/src/renderer/src/bootstrap.ts)），缺了它整个 store 退回 `DEFAULT_SETTINGS`
  + 异步加载那条老路 —— 而单独挂一个组件时没人调 `init()`/`loadData()`，于是设置永远是默认值。
  症状是「按设置分支渲染的区块根本不出现」（比如需要先填仓库地址才显示的那几块），
  很容易误判成新写的 `v-if` 写错了。顺手给 `getThemeConfig` 也补上。
- **桩必须拼出真正的源码，别 `JSON.stringify(带方法的对象)`**：`JSON.stringify` 会把值为函数的键整个丢掉，
  于是每个通道都落到 Proxy 兜底、返回 `{ ok: true, data: null }`，页面只剩一片空态 ——
  截图里「有外壳、有标题栏」看着像跑通了，其实一个通道都没验到（踩过一次，A/B 比对差点据此收工）。
  判据是 `document.documentElement.dataset.theme` 有没有被写上：空的就说明 `getBootstrap` 没生效。
- **`updateSettings` 必须真实现，store 不做乐观更新**：`settings.value = result.data` 在通道**回包之后**才赋值，
  桩不实现它的话，所有「点按钮改设置」的交互（折叠导航、收终端面板……）都会原地不动 ——
  界面看着毫无异常，只是值永远写不进去。桩按 store 当前值合并补丁、**回一个新对象**即可
  （store 读得到：`#app.__vue_app__.config.globalProperties.$pinia._s.get('settings')`）。
  其余通道维持「零桩语义」——Proxy 一律抛错，等价于 `window.workbench` 不存在（mount 照常、store 走默认值），
  比给每个通道编返回值安全得多；壳层 + 侧栏 / 终端这类 store 驱动的动效验证，有这一个真桩就够了。
- **动画判「怎么动」靠逐帧记录，别靠截图猜**：`Runtime.evaluate` 里起 rAF 循环，每帧记
  `getBoundingClientRect` / `getComputedStyle` 的宽高、opacity、transform（`new DOMMatrix(...)` 取位移），
  跑满一秒一次性读回 —— 谁先动、哪一拍动、曲线起步快不快（半程进度一算便知）都在数组里。
  配 `transitionend`（记 `elapsedTime`）核时长，位置类改动用「期望中心 vs 实际中心」的算术断言，
  比肉眼比对截图可靠。本次验侧栏收展、终端两拍折叠、dock 滑入全靠这一套（2026-10）。
- **纯浏览器里必定有一条 `Tauri 运行时不可用，无法调用 data_load` 异常**，这是环境造成的、不是产物的问题：
  `main.ts` 调的 `initState()`（[state.ts](../../apps/desktop/src/renderer/src/workbench/state.ts)）**直接** `invoke('data_load')`，
  不经过 `window.workbench`，所以顶替 `window.workbench` 拦不住它。它只让 `initState` 提前 reject
  （`app.mount` 在 `finally` 里，界面照常出），别顺着这条去查产物。
  反过来，`window.workbench` 的桩是有效的：`installTauriWorkbench()` 里 `hasTauri()` 为假就直接 return，不会覆盖它。
- **store 的动作是一参调用，桩别按 `{ patch }` 解包**：`window.workbench.updateSettings(patch)`
  收的就是补丁本身（`{ patch }` 那层是适配层调 Tauri 命令时的写法）。桩里写成 `args?.patch`
  会静默返回未修改的值，看起来就是「点了没反应」。
- **`updateSettings` / `updateThemeConfig` 的桩要回一份新对象**：真适配层给的是拷贝，
  桩里若 `Object.assign(settings, patch)` 之后把同一个对象回出去，store 那边
  `settings.value = data` 等于赋了同一个引用 —— 依赖它的 computed / watch 全都不重算，
  表现成「改是改了（直接读 store 能读到新值），界面纹丝不动」。
  回 `{ ...settings }` 就好。这类「数据对了、界面没动」先怀疑桩，别改组件。
- **设置弹窗的滚动容器是每个 `.pane`，不是 `.settings__body`**：正文（`.settings__body`）只是过道，
  各 pane 自己滚并各留各的位置（见 SettingsDialog 里的注释）。要滚到「账号 / Token 同步」那几块，
  得挑当前可见的那个 pane 滚（`getComputedStyle(p).display !== 'none'`），
  滚 `.settings__body` 只会原地不动，症状是「截来截去都停在半截」。
- **刚打开的弹窗要在下一次求值里才查得到 DOM**：`demo.open(); document.querySelector('button.nav-item').click()`
  写在同一次 `Runtime.evaluate` 里会**点空** —— Vue 还没重新渲染，节点根本不存在，
  而 `querySelector(...)` 返回 null 时 `.click()` 抛错才看得见，写成 `?.click()` 就会静悄悄什么都不发生。
  拆成两次求值（中间 sleep 一下）即可。
- **切场景时注意状态之间的优先级**：组件里 `v-else-if` 的先后就是优先级。
  账号弹窗里「等待授权」排在「已登录」前面，所以只改账号、不清 `authPending`，
  截出来的仍然是等待态 —— 这类「改了没反应」先怀疑场景没切干净，别去改组件。
- **截图按"当时在调什么"命名，成对的用 `-before` / `-after`**。这是给当时的自己看的，
  反正是用完即删，别花心思整理成体系。
- **按约定直接返回结构的通道，桩里不能再套一层 `Result`**：`listProjects` / `getSettings` /
  `getThemeConfig` / `getDataDir` / `getActivity` / `listQuickApps` / `listCommands` /
  `checkPackageManagers` / `getNvmStatus` / `getNrmStatus` / `authStatus` / `listWallpapers` 都是
  直接给数据（见 types.ts 的 WorkbenchApi），照着别的通道写成 `{ ok: true, data: … }` 的话，
  `loadData()` 里 `data.projects` 就是 `undefined`，报出来的是某个 computed 里的
  `Cannot read properties of undefined (reading 'map')` —— 错在桩上，别顺着组件找。
- **拖拽这类交互可以用合成 PointerEvent 驱动**：`pointerdown` 派给元素本身、
  `pointermove` / `pointerup` 派给 `window`（组件的监听就挂在 window 上），
  不必为了验一次拖动去凑 `Input.dispatchMouseEvent` 的坐标。**但 Vue 是异步渲染**：
  在同一次 `Runtime.evaluate` 里派完事件紧接着读 `getComputedStyle` / `getBoundingClientRect`，
  拿到的还是渲染前的值（会误判成「拖了没反应」），要另发一次求值再读。
- **运行中的终端不让关**：要验「一个终端都没有」那一步，得先按适配层的做法推一条
  `success` / `idle` 的状态事件把它停下来，否则 `closeTerminal` 只会弹一句警告、界面纹丝不动。
- **动画往哪边走，靠逐帧记录判，别靠截图猜**：在 `Runtime.evaluate` 里起一个 rAF 循环，每帧记下
  `getComputedStyle` 的 `transform`（`new DOMMatrix(...).m41` 取横向位移）、`height`、`opacity`，
  跑满几百毫秒后一次性把数组读回来 —— 一眼就能看出「谁先动、往哪边动、哪一段是空转」。
  截图只能证明「某一帧长这样」，判定方向时很容易看成自己希望的那个答案。
  这条也是查「一条 transition 挂多个属性」的顺手工具：同一个元素上高度和位移同时走时，
  观感会被盖成另一个方向（踩过一次），把其中一个挪到 `transition: … 0.16s ease 0.18s` 的延迟里分成两拍就好了。
- **驱动脚本的结果要 `appendFileSync` 写文件，不要 `console.log` 走管道**：排错时最容易顺手敲成
  `node .preview/drive.mjs | tail -40`，而 `tail` 会把输出攒到进程结束才吐 —— 脚本一旦中途挂住（见下一条），
  你会对着一个空日志查半天，还以为脚本没跑。写文件则每一步都落得下。
- **开着 WebSocket 的 node 脚本不会自己结束**：CDP 的 `WebSocket` 会让事件循环一直有活干，
  于是出错退出时后台任务永远停在「运行中」。收尾放在 `finally` 里：关 ws + `process.kill(-child.pid)` 杀无头浏览器，
  最后 `process.exit()` 兜底。CDP 自己也有超时上限，进程组不杀干净会留一堆无头 Edge 在后台。
- **只顶替 `window.workbench` 拦不住适配层**：适配层（`workbench/ai.ts`、`system.ts` 这些）
  直接 `invoke()` → `__TAURI__.core.invoke`，**不吃 `window.workbench` 这一层**。
  于是「运行时探测」这类只走适配层的通道会一路吃掉拒绝、退回最差的那一档 ——
  症状是「明明配好了，界面还说 Node 太旧 / 没找到 Pi」。要把这一面也喂上：
  `window.__TAURI__ = { core: { invoke }, event: { listen } }`，**回的是裸值**（`ai_runtime`
  回运行时的结构、`ai_key_state` 回布尔），包成 Result 是 `window.workbench` 那一层
  `guard` 干的 —— 两面各自的形状不同，见 [bridge.ts](../../apps/desktop/src/renderer/src/workbench/bridge.ts)。
  顺手在桩里记一份调用名单（`window.__calls.push(command)`），「点那颗按钮到底发没发出去」就能直接问。
- **截图一片空白先量几何，别猜渲染**：把 `getBoundingClientRect()` 打出来最快。踩过的是
  「挂载点排在视口之外」—— 页面上那个空的 `#app` 占着 100% 高度，后加的盒子接在它后面，
  y 正好等于视口高度，画面只剩 body 底色（DOM 里元素一个不少，`innerText` 也读得到）。
  同类还有「根盒子高度塌成 0」：`.app` 的高度来自 App.vue 的 scoped 样式，**单挂一个组件时那份样式不在**，
  给挂载点写 `height: 100vh` 才有的量；设置也是同理，`useSettingsStore().loadAppearance()`
  得自己 await 一次（真应用里是 `initState()` 干的），否则永远是 `DEFAULT_SETTINGS`、
  页面停在引导态。
- **别占默认端口 5274**：它常被上一次会话残留的 `vite preview` 占着（有时是另一个会话正在用的 —— 别杀它）。
  子目录那一套给自己的 config 写 `preview: { port: 5275, strictPort: true }` 最省事；
  端口被占时 `strictPort` 会让你立刻看见（不然 `vite preview` 静默换端口，截图脚本照样连上、
  截到的却是别人那份产物）。收尾按命令行特征清无头 Edge：
  `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"` 筛 `CommandLine -like '*wb-edge-*'` 再 `taskkill /F /T`。
- **右键菜单用 `Input.dispatchMouseEvent` 的 `mousePressed` + `mouseReleased`（`button: 'right'`）开**：
  走的是真指针，`contextmenu` 会照常发出，也顺带把 Chromium 那套「右键落点」的默认行为带上了 ——
  比在页面里合成一个 `contextmenu` 事件更接近用户按下去的样子。菜单项的点击用 `Runtime.evaluate` 里
  直接 `.click()` 就够（Vditor 那些处理函数不看 `isTrusted`）；要展开子菜单则必须真的移指针
  （子菜单是 CSS `:hover` 开的），`mouseMoved` 之后另发一次求值再读。
