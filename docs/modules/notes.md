# 笔记

笔记的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`apps/desktop/src-tauri/src/notes.rs`（列目录 / 读 / 写 / 新建 / 改名 / 移动 / 删除）、
`apps/desktop/src-tauri/src/md_window.rs`（资源管理器「打开方式」的独立编辑窗口）、
`apps/desktop/src-tauri/src/sync.rs`（图片上传与笔记同步）、
`apps/desktop/src/renderer/src/stores/notes.ts`、`apps/desktop/src/renderer/src/components/` 下的
`NoteTree.vue`（左栏树）、`NoteTreeMenu.vue`（树的右键菜单）、`NoteEditor.vue`（Vditor 正文）、
`OverlayScrollbar.vue`（正文悬浮滚动条）、
`NoteContextMenu.vue`（正文右键菜单）、`NotesView.vue`（页面编排），以及
`apps/desktop/src/renderer/src/markdown-window/`（独立窗口宿主）、
纯口径在 `packages/notes/src/note.ts` 与 `note-image.ts`。

**动手前先读 NoteTree.vue 顶部的注释**：空白区的 `blankHover` 标记、以及展开态清单那两条 `el-tree` 坑（`auto-expand-parent` 默认是
true、清单里不能放选中项自己）只在那里写清楚了，下面不重复。

### 数据模型

- **笔记没有数据文件**：它就是那个文件夹里的 `.md` 文件，应用只记下「当前打开的是哪个目录」（设置里的 `noteDir`）与「打开过的那几个」
  （`noteDirs`，左栏底部的「最近打开」）。两者都只对本机成立，所以不进 theme.json、也不参与同步（左栏**宽度** `noteTreeWidth`
  与右栏大纲宽度 `noteRailWidth` 是「界面长什么样」，住 theme.json）。**别为了「顺手统一」把笔记塞进同步或主数据文件** —— 旧版那棵笔记 JSON 树（`note-data.json`）就是
  反例，它早就不再读写。首次进笔记页必须先选这个文件夹，没选之前不显示任何操作入口。
- 三条不能破：**所有笔记命令都要带 root**（别把路径缓存在适配层里，用户换了文件夹来源就换了）；**路径只认相对笔记根的写法**，
  `..` / 绝对路径在 `notes.rs` 里被挡住；**结构改动一律用后端重新扫出来的树**，别在本地推算改动结果（外面用别的编辑器改过那些文件时，
  只有磁盘说了算）。
- `notes.rs` 的路径边界：逐段只接受普通名字，改名 / 移动 / 删除还要再挡一道「不能对笔记根自己下手」。

### 左栏目录树

- 树就是笔记本里的东西本身，**没有「根行」那一层**（笔记本是哪个目录写在左栏底部）。往最外层的落点是树下面的**空白区** ——
  不归 `el-tree` 管（它的落点只认节点行），得自己接 `dragover` / `drop` 并 preventDefault，用 `noteDropAllowed` 判能不能落。
- **只有文件能拖、只能落进文件夹**：`el-tree` 的 prev / next 两种落法一律不放行 —— 顺序是按名字算出来的，插一个「前后」下一秒就没了。
- 名字最终是文件名，带 `/`、`:` 或系统保留名的必须在名字弹窗里当场说清楚（`noteNameProblem`，不是只报「非法」）。
- 移动失败时要**重新扫一遍**：`el-tree` 在松手那一刻已经自己挪过它那份数据了，磁盘上真挪没挪由 store 说了算，否则左栏显示的是一个
  磁盘上并不存在的位置。
- 口径都在 [note.ts](../../packages/notes/src/note.ts) 的纯函数里：文件夹排在文件前面、同层按名字排（`buildNoteTree`，带 `numeric` 的排序规则）；
  只收 `.md` / `.markdown`。
- **展开态由笔记页持有并落盘**（设置里的 `noteTreeExpanded`，纯函数 `sanitizeNoteTreeExpanded`）：`el-tree` 的节点每次重建都会丢掉展开态，
  所以清单要一路恢复回去；**`NoteTree` 是 `expanded` 进、`update:expanded` 出，自己不留副本** —— 组件里再存一份就有了两份状态，
  「收起一层」会与上层那份打架。清单存的是**相对笔记根的文件夹路径**（就是节点的 `id`），所以**换笔记本时必须清空**
  （见 `stores/notes.ts` 的 `setRoot`）：相对路径在另一个笔记本里指的是完全不同的东西。
  收起某一支时若被自己那份清单顶回来，看 NoteTree.vue 顶部关于 `auto-expand-parent` 的注释。
- **扫描时有一份忽略名单**（`notes.rs` 的 `IGNORED_DIRS`）：点开头的一律跳（`.git`、`.obsidian`、`.vscode`、`.idea`…），外加
  `node_modules` / `dist` / `build` / `out` / `target` / `coverage` 这些不由点的噪音目录整棵不走 —— 它们动辄几万个文件，笔记也不会住在
  里面。代价是用户真有一个叫 `build` 的目录装笔记时看不见它；要么改名单，要么那个目录换个名字，**别把名单悄悄删掉**。

### 正文编辑器（Vditor）

- `cdn` 必须指向随包带的那一份（`public/vditor/`）：图标 / 语言包 / markdown 引擎（lute）/ 内容主题 / 表情 / 代码高亮都是**运行时**
  按 `options.cdn` 去取的，默认指 unpkg —— 指错了等于给「默认不联网」开了个洞。
- **升级 Vditor 后要留意它是不是又要新资源**：缺哪个就是哪个功能不生效（本地 404，不会退回联网），编辑器本身会起不来。
- localStorage 缓存要关掉（`cache.enable`），正文的落盘归 store 与适配层。
- **写作区的底色必须是透明的**：Vditor 默认给她铺一层不透明底色，于是半透明卡片里会嵌着一块实心白；这一页的底色归卡片，编辑器只管字。
- **引用块那条竖线在亮色下取 `--border-strong`**：Vditor 内容主题自带的是 `#eaecef`，比半透明卡片还亮，看着像一道白边（与 MarkdownView 的引用同一档）；
  暗色不动，它自带的那条 `#d1d5da` 已经够清楚。
- **代码块上下的空档只在收起态收掉**（`:not(.vditor-ir__node--expand)`）：展开态那两行就是围栏本身，一起删掉就没法改代码块的语言了。
- **它的 `input` 回调不是同步到的**（内部还有一层处理延迟），所以换篇 / 卸载时不能只看防抖攒下的那一份，要 `getValue()` 现取一份再交
  出去；交出去的正文**必须带上它属于哪一篇**（`{ rel, content }`）—— 换上来的那篇正是「当前选中项」，只按选中项取路径会把上一篇的
  正文写进刚点开的那一篇。
- **上传期间要在编辑器上挂一颗 loading 角标**（`uploading`）：一次上传就是一次 `git push`，几秒钟很正常，而这几秒里正文什么都不会出现。
  收尾只放在 `finally` 里；别用 `v-loading` 那层遮罩 —— 上传时用户往往还在接着写，遮罩会把正文一起锁住。
- **空文档在 Vditor 里是 `'\n'`，不是 `''`**：两者之间不算改动（`sameText`）—— 照实写下去，每打开一次空笔记都会给盘上的空文件补一个
  换行；而一旦它被当成一次改动，改名 / 删除那一下的收尾 flush 就会带着**旧路径**发出去，在旧位置凭空长出一个文件。配套的另一道闸在
  store 的 `saveContent`：路径已经不在树里就整次写盘不发出去。
- **动作一律交回 Vditor**：右键菜单只记动作名、按名字去点工具带上的按钮，别在菜单里另写一套格式化（选区、markdown 往返、撤销栈都会与
  工具带分叉）。工具带只是不显示、仍在 DOM 里，所以 `TOOLBAR` 里删项前先看菜单有没有用它。
- **正文滚动条是自绘的**（`OverlayScrollbar.vue` + `use-overlay-scrollbar.ts`）：Vditor 的 `pre.vditor-reset` 才是滚动容器，
  原生条在 `NoteEditor` 样式里用 `scrollbar-width: none` 收掉，换成一枚 5px 胶囊滑块 —— 不占正文宽度、没有轨道与箭头、可拖可点轨跳转。
  笔记页与独立窗口共用这一枚；后者只引了 tokens、没引 global.css，原生条本是 WebView2 那副带箭头的，这一下也一并盖掉。
  几何在 `thumbMetrics()`（纯函数、有单测），监听 scroll / ResizeObserver / MutationObserver / 图片 load 四类变化。
- **正文里的链接一律在组件里接管，而且只有按住 Ctrl 的那一下才算**（普通点击什么都不做：这一页是拿来写东西的，
  点正文里的一处本来是「把光标挪过去」，顺手换掉打开着的那一篇或弹出浏览器都很打扰）。Ctrl 那一下里：外部地址走
  `openExternal`；相对链接里**只认指向笔记的那一种**，用 [note.ts](../../packages/notes/src/note.ts) 的 `resolveNoteLink`
  解析成相对路径后交给上层。**IR 模式下的链接不是 `<a>`**——lute 把 `[文字](地址)` 渲染成
  `<span data-type="a" class="vditor-ir__node">`，地址在它那颗 `.vditor-ir__marker--link` 里（文字是
  `.vditor-ir__link`），按 `closest('a')` 找会一个都匹配不上。
- **跳转一律走 store 的 `select`**（与在左栏点一下同一条路：展开、高亮、读盘都在那里），别另开一条「打开某一篇」的路径；
  跳之前先在树上找，找不到先 `reload` 一次再看（目标可能是别的编辑器刚写下的），还没有就提示，**别把选中项切到一个不存在的
  路径上**（右栏会显示成「『』是文件夹」）。只有 `.md` / `.markdown` 能跳，图片、附件、锚点那些跳不过去 —— 说一句，别静默。
- **`options.link.isOpen` 必须关着**：Vditor 默认在点击链接时自己 `window.open(地址)`，那一下 `preventDefault` 拦不住
  （它拦的是浏览器的默认动作）—— 外链会多弹一个窗口，相对链接在 WebView 里只会打开一个错误页，而且**它不看按没按 Ctrl**。
- **大纲（目录结构）在右侧、始终显示**：正文与目录分成两列，右栏常显（打开着一篇笔记时就有它），
  **不再有开关** —— `NoteEditor` 传 `outlinePinned`，初始化完成后直接把大纲打开，右键菜单里也不给「大纲」。
  它只收 `#` 标题，没有标题的笔记打开也只剩栏首那行字。栏宽是主题里的 `noteRailWidth`
  （默认 224，见 [theme.ts](../../packages/appearance/src/theme.ts)），拖栏左缘那条缝改：
  拖动只改本地跟手、松手落盘，与左栏目录树同一套做法。三件配套不能少：
  ① **大纲元素要搬出正文区**（`NoteEditor` 的 `outlineHost`）：Vditor 把它建在 `.vditor-content` 里，
     顶边只能贴着正文，比页头（标题 / 保存状态）低一整行 —— 笔记页把一条与页头同高的右栏 `<aside>` 交给它，
     初始化完成后 `appendChild` 进去。开合 / 内容 / 跳转都还是 Vditor 的（它只拿着元素引用，不看它在谁名下）；
     **卸载时要把这枚元素从栏里摘掉**，否则下一位编辑器进来会并排挂两个。
     宿主是模板 ref，它的 watcher 可能比 Vditor 的异步初始化先跑 —— **`attachOutline` / `ensureOutlineOpen`
     要连 `editor.vditor` 一起判空**（只判 `editor` 会抛 `Cannot read properties of undefined`）。
  ② **只读模式的捕获拦截要让路**（`NoteEditor.onClick` 里 `.vditor-toolbar, .vditor-outline` 提前 return）：
     只读是默认档，而那条 `stopPropagation` 挂在捕获阶段，会把编辑器里这两处的点击一起吞掉 ——
     工具带虽然藏着，里面的按钮照旧点得动；大纲条目的跳转也归 Vditor 的监听器接。
  ③ **条目整行收展**（`use-outline-row-toggle.ts`，笔记页右栏与独立窗口目录栏共用）：
     Vditor 只让条目里那枚箭头 svg 认收展点击，整行接管在宿主栏上挂一条 **capture 阶段**
     的 `@click.capture` 委托：点到「有子级 `ul`」的条目行任意位置就复刻 Vditor 的收展
     （svg 加/去 `--close`、子列表切 `display`），并 `stopPropagation` 拦下 —— 不拦的话点在
     箭头上时 Vditor 自己那份监听也跑，同一下收展两次、互相抵消；叶子条目与空白处放行
     （叶子还要跳标题）。大纲 DOM 会被 Vditor 重建，委托按点击目标现场查找、绑在宿主栏上，不受影响。
     **子列表显隐必须走 CSSOM（`el.style.display = …`），不许 `setAttribute('style', …)`**：
     独立窗口的 markdown.html 里有内联 `<style>`，生产态 Tauri 给它加 nonce 后 CSP 的
     `style-src 'unsafe-inline'` 整体失效，行内 style 属性会被静默丢弃 —— 现象是箭头转了、
     列表收不起来（与 sprite 占位是同一个坑，见 markdown.html 里的注释）。CSSOM 赋值
     不经属性解析，CSP 不管这一路。
  ④ **样式归 NotesView 的右栏**（元素搬出去之后 `.editor :deep()` 够不着它）：透明底、`--border` 发丝线、
     `--ink` 悬停、`--font-ui` 字体，条目是 19px 行高 + 4px 内边距的圆角悬停片；栏宽由 `--rail-w`
     给（主题里的 `noteRailWidth`），不与正文抢宽度。**拖动把手是栏左缘一条 `--sp-4` 宽的热区**
     （`notes__rail-resizer`，悬停才露出小竖条），拖动期间挂 `body.is-resizing-notes-rail`
     兜住光标与文本选择；**别把它改成 `PanelResizer`** —— 那只按左栏宽度定位、改的是左栏。
     搬出去后 `--textarea-text-color` 这些变量不再从 `.vditor` 继承，要在栏里补一份，否则字掉回浏览器默认色。
     页头是 `align-items: center`（**不是 baseline**：这一行混着 15px 标题与 10.5px 辅助文字，
     按基线对齐小字会浮上去），
     栏首「大纲」的 `line-height: 28px` 就是为了让它与页头文字垂直居中对齐。
- **正文左右留白固定 50px，剩下的宽度全给正文**：Vditor 默认把可读宽度钉在 `preview.maxWidth`（800）并居中，
  宽窗口下左右各留几百像素，内容没多长就换行。现在 `preview.maxWidth` 给一个大数（让它的自动内边距退回最小值），
  真正的左右留白由 `NoteEditor` 样式里的 `padding-left / padding-right: 50px !important` 定 ——
  Vditor 的 `setPadding` 会在 resize 时写**行内** padding，普通样式压不住，必须是 `!important`。
  内容宽度跟着窗口与大纲栏自适应，拖大纲栏也不必再补 window resize。
  **独立窗口例外**：它在 `MarkdownWindowApp` 里用一条更具体的 `!important` 覆写成居中约 1200px 的行宽
  （见下文「独立编辑窗口」一节），笔记页仍是 50px。
- **正文底部始终留一段空白**（120px）：最后一行不贴着卡片下沿、能往下多滚一点（Typora 那种手感）。
  空白借 Vditor 自己的 `pre.vditor-reset::after`（高度取 `--editor-bottom`，`NoteEditor` 里给的值）——
  **必须长在滚动内容里**，别改成外层容器的 `padding-bottom`：那样滚动条到不了它下面，最后一行还是贴底，
  也白占了卡片高度。光标自动滚动只把光标带到「刚好可见」，留白会留在视野外；所以**输入前已经贴着底**时，
  回车落定后由 `NoteEditor` 的 `markBottomStick` / `onContentInput` 把滚动位置补到底，留白稳定留在光标下方；
  读着上面时这一条不成立，不抢滚动。

### 外部修改与写盘冲突

- **打开着的那一篇不会自动重读**（编辑器防抖里可能还有没落盘的字）：窗口重新获得焦点（且当前在笔记页）、
  左栏底部刷新、树上「刷新列表」三处会把它对齐磁盘 —— 编辑器没有未保存的修改就直接换正文；
  有未保存的修改时，只有磁盘确实变了才问一句「按磁盘重读 / 保留这里的」。
  点同一篇笔记**不算**重读（`open()` 里的提前返回仍然保留）。
- **写盘必须带上一次读盘 / 落盘拿到的文件 mtime**（`note_write` 的 `expectedMtimeMs`，Rust 侧
  `notes::write` 写前核一遍）：文件被别处改过、或已经被删掉时**一个字都不写**，原因挂在
  `saveError` 上由标题栏红字显示。这是「别处的修改不会被静默盖掉」的唯一保证，
  别为了少一次 stat 把它删掉。
- 编辑器切篇时补交上一篇的那一段（那时 `active` 已经是新的一篇）也要带基准：store 里按路径
  另记一份（`mtimeByRel`），换笔记本时清空。
- 「已保存 · 时间」用**文件自己的 mtime**（打开时记下、写成功后用 Rust 回的值），不要用本地时钟；
  打开一篇时重置 `savedAt`，否则会挂着上一篇 / 上一次保存的时间（看着像保存了）。
- 编辑器里的「有没有未保存的修改」不能只看它自己的基线（`saved`）：写盘被拒之后它也会以为
  保存了。要对的是 store 里**最后一次真正落盘 / 读盘的内容**（`NoteEditor.hasUnsaved(base)`）。

### 编辑器自定义快捷键

- **表只存用户改过的项**（设置里的 `editorHotkeys`，`@workbench/notes` 的
  [editor-hotkeys.ts](../../packages/notes/src/editor-hotkeys.ts)）：键是动作名
  （与右键菜单 / `TOOLBAR` 一致），值是组合键串（`Control+3` 这种写法，与全局快捷键同口径）。
  显式存**空串 = 禁用**这个动作的自定义键（「恢复默认」就是把这一项从表里删掉）。
- **有一份「生效的默认键位表」**（`EDITOR_HOTKEY_DEFAULTS`，同一文件）：标题六档
  `Control+1` ~ `Control+6`（离手近；与 Vditor 原厂的 `Ctrl+Alt+N` 并行，两边同时有效），
  其余 12 项照原厂（粗体 Ctrl+B、斜体 Ctrl+I、删除线 Ctrl+D、行内代码 Ctrl+G、
  代码块 Ctrl+U、链接 Ctrl+K、引用 Ctrl+;、无序 Ctrl+L、有序 Ctrl+O、任务 Ctrl+J、
  分隔线 Ctrl+Shift+H、表格 Ctrl+M）。**拦截按「默认 + 用户覆盖」的合成表**
  （`mergeEditorHotkeys`，computed 缓存）：没碰过的动作按默认键触发（默认是真的生效，
  不只是显示）；用户覆盖的动作换用户的键；空串禁用的动作不拦（只剩原厂键位）。
- **可配的只有 18 项常用动作**（标题六档 / 粗斜删 / 行内代码 / 代码块 / 链接 / 引用 /
  三种列表 / 分隔线 / 表格）；**undo / redo / outline / fullscreen 不开放** —— 它们被
  Vditor 内部键绑定与视图状态管着，拦下来自己 `runAction` 一遍会跟内部状态分叉。
- **配置住在数据文件**（本机性质，不参与外观同步，与 `hotkey` / `captureHotkey` 同类），
  收敛在 [persisted-data.ts](../../apps/desktop/src/renderer/src/persisted-data.ts) 调
  `sanitizeEditorHotkeys`：动作名不在清单的丢掉、值去空白（键串认不认得不在这一层 ——
  匹配层查不到就当作没配）、输出按清单顺序排稳。配置界面在设置 · 通用 → 笔记，
  录制件与全局快捷键共用 `HotkeyField`（**同一种按法录出的串必须一致**，为此
  `acceleratorOfEvent` 纯函数从 use-hotkey-recorder 导出，录制与匹配共用一份口径）。
- **撞键自动腾位**：后配的保留，先配的那个被腾成空串并提示一声
  （`resolveEditorHotkeyConflict`，纯函数有单测）；禁用项（空串）不占键位、不参与撞键。
- **设置里的显示**：没有自定义的那一行，按钮里垫显示的就是**生效的默认键位**
  （`EDITOR_HOTKEY_DEFAULTS`）—— 显示与触发同一张表，不会「显示一个键按下去没反应」。
  用户配了同一个动作后显示与触发都换用户的。
  `HotkeyField` 那句「点击后直接按组合键即可替换」在网格里关掉（`:hint="false"`，改由
  title 兜着）—— 18 行各带一句会把版面挤碎。键位按钮定宽（168px + nowrap），
  「恢复默认」那格恒定占位（没配的行渲染等宽空占位），18 行两列各自落在一条竖线上。
- **拦截挂在 NoteEditor 的 `onKeyCapture`**（capture 阶段、keydown 一档 —— keyup 再拦
  会把同一动作跑两遍）：命中表里的组合才 `preventDefault` + `stopPropagation` + `runAction`，
  **表里没有的组合一概不拦**（内置键位、Ctrl+S / Ctrl+/ 各走各的）。只认带修饰键的组合；
  输入法组合中（`isComposing`）让路。值由上层传 prop（`editorHotkeys`）——
  与 `imageRepo` 同一条「不读 store」的规矩；独立 Markdown 窗口在 `load()` 里从
  **首屏快照**取一份（`bootstrapSnapshot().settings.editorHotkeys`）—— 那扇窗不
  `initState`，`getSettings()` 返回的是适配层内存里的默认数据，设置里配的自定义键
  只有 Rust 注入的快照里才有。不跟主窗口实时联动；快照拿不到退回内置键位。
- **标题六档带开关**（`runAction`）：光标已在**同级**标题里时改点工具带上标题那颗
  **主按钮** —— 它带 `vditor-menu--current` 态（Vditor 的 `highlightToolbarIR` 在点击 /
  输入 / 聚焦时维护，判断与这里同用 `closest('h1…h6')`），点它是「去掉标题」；
  不同级照旧是切换（点面板里 `data-tag="hN"` 那颗）。Ctrl+1 再按一下取消 H1、
  Ctrl+2 直接把 H1 换成 H2，右键菜单与两个窗口的快捷键共用这一份。

### 只读模式

- **默认就开着，Ctrl+/ 切到可写，状态不落盘**（住在 NotesView，不进设置）：进笔记页先按「读」来，
  想写才按那一下 —— 「看一眼」变成「改一处」是这一页最容易犯的事（点进代码块、顺手勾一个框、
  贴一张图就推一次 git），默认值放在安全那一侧，代价只是想写时多按一次。**不落盘**是因为它记的是
  「这一趟拿它干什么」而不是「我偏好什么」：某次读着关掉应用、下次打开就写不了，而那时未必想得起来按什么切回来。
  标题行里那颗「只读」小片（带提示）就是这一档的落点 —— 它是一颗**按钮**，点一下直接切到可写
  （切过去之后它自己就消失了）；要回只读仍是 Ctrl+/。两颗入口改的是同一个 `readOnly`，别另立一份状态。
- **挡的只有正文，两处各在自己的地方实现，改的时候一处都不要漏**：正文（NoteEditor 收
  `readOnly`，落到 Vditor 的 `disabled()`，打字与工具带动作一起停）、正文的格式右键菜单（不弹）。
  **左栏目录树不归它管**（NoteTree 没有 `readOnly` 这个 prop）：新建 / 重命名 / 删除 / 拖动都是
  用户明确点下去的动作（删除还有确认框），不属于「读的时候手一抖」那类误触 —— 把它们一起锁掉，
  只读就变成「连整理笔记都不许」了。左栏底部那两颗按钮（同步 / 素材管理）同样不归它管。
- **Vditor 只管「不能写」，不管「还像不像编辑器」** —— 这个模式的坑几乎都在这儿，五条：
  1. 它的 IR 点击 / 按键处理器**不问 `contenteditable`**：点一下就 `expandMarker()`，把点到的那个节点
     展开成源码样子（代码块的围栏与那块灰底的原始代码就是这么冒出来的、「看着还能编辑」说的就是它）、
     点复选框直接改 DOM 再触发一次 input（**一次真写盘**）、空文档上按退格清 `innerHTML`；而展开态
     靠 `blur` 收，只读下又点不出焦点，于是那副样子会一直挂着。**解法是捕获阶段整类拦掉**
     （NoteEditor 的 `onClick` / `onKeyCapture`：只 `stopPropagation`、不 `preventDefault`，
     浏览器的默认动作 —— 滚动、拖选、剪贴板 —— 都留着），别去逐条堵 Vditor 的处理器。
  2. **`contenteditable="false"` 会把正文从「可聚焦元素」里摘出去**，而它正是那个滚动的容器
     （`.vditor-reset { overflow: auto }`）：点了不给焦点、`Tab` 也进不去，PageUp / PageDown / 方向键
     就全没了 —— 现象是**「只读之后滚不动了」**。只读下要给正文补一个 `tabindex="0"`、可写时摘掉
     （可写时它靠 contenteditable 本来就在 Tab 序里，这是把同一件事补回来，不是新增一个入口）。
  3. **禁用态自带的样式是「编辑器坏了」的样子**：`opacity: .3; cursor: not-allowed`，要覆盖回 1、
     光标还它 auto；空笔记那句「写点什么…」的 placeholder 在这一档里也是错的，一并收掉。
  4. **粘贴 / 拖进来的图片不走 `contenteditable`**（Vditor 把 paste / drop 挂在元素上，与能不能编辑
     无关），`uploadImages` 里要自己挡一道 —— 那一下是往用户仓库推一次 git。
  5. **编辑器宿主元素（`.editor`）的 class 归 Vditor 管，别在它身上挂 Vue 的 `:class`**：Vditor
     初始化时用 JS 给宿主加上 `vditor` 类，而只要那一层还有 `:class` 绑定，它一变 Vue 就把整个
     `class` 属性重写成「自己算出来的那一份」，把 `vditor` 抹掉 —— 少了这个类，它那套
     `.vditor { display: flex; flex-direction: column }` 全都不再适用，正文的 `height: 100%` 解析不出来、
     **涨成内容高度**（实测 633px → 1603px），于是没有溢出（界面上就是**没有滚动条、滚不动**），
     而卡片是 `overflow: hidden`，剩下被整块裁掉。**只读那一档的类因此挂在外壳 `.editor-wrap` 上**
     （样式选择器一并从那一层起）；这个坑的现象看着与布局无关，查起来会往滚动上找很久。
- **不管**左栏底部那两颗按钮（同步、素材管理）：它们动的是远端与图片仓库，不是正在读的正文；
  同步本来就得先把编辑器手上的改动交出去，只读下那一份是空的。
- 快捷键的三条守卫（见 NotesView 的 `onShortcut`）：只在**笔记页显示着**时接手（KeepAlive 把这一页留在内存里，
  不判当前页就会在别处被按到）、焦点在输入框（起名字的弹窗）里时让路（**正文那层 contenteditable 不挡**
  —— 正读着的时候才最想按这一下）、还没选笔记本时不动。认 `event.key` 而不是 `event.code`（要的是
  「打出来是 `/`」，有些布局上它在 Shift 那一档）。

### 图片（粘贴上传）

- 笔记本里**不放图片文件**，正文里只有一条外链，于是笔记搬到哪台机器、用哪个编辑器打开都成立。落点是**三层**：
  `<images>/<本机设备>/<笔记本>/<文件名>`（第一层是 [note-image.ts](../../packages/notes/src/note-image.ts) 的 `NOTE_IMAGE_DIR`，不给用户配），
  后两层由同一份代码的 `imageScopeDir` 现算 —— 上传 / 列清单 / 删图三条通道用的是同一个算法，**别在某一处另写一份路径拼法**（这三层也是素材管理成立的前提）。链路是
  NoteEditor 的 `uploadImages` → `workbench/note.ts` 的 `uploadNoteImage` → `sync.rs` 的 `publish_image`。
- 七条不能破：
  1. **`upload.handler` 必须配着**。不配的话 Vditor 会把图片读成 base64 直接内联进正文，几篇带图的笔记就能把 `.md` 撑成几兆；
  2. **handler 返回字符串等于报错**，成功时必须返回 `null` 并自己 `insertValue`（别指望它替你把 markdown 插进去）；
  3. **图片仓库地址留空时只是提示**，不退回内联、也不发任何请求：这是联网边界上的出口之一，必须由用户显式开出来；
  4. **访问地址由 TS 拼**（`imageRawUrl`），Rust 只回「仓库里的路径 + 分支」。GitHub / Gitee / GitLab 三家自动认，**其余一律拼不出来**
     （`url` 是空串）—— 那时**不要**往正文里插一个点不开的地址，如实说明这个仓库推不出访问地址；
  5. **设备标识拿不到、或者没打开笔记本时如实报错，不要退回上一层目录去传** —— 退回等于让所有机器、所有笔记本的图混进同一层，素材
     管理里那列「未引用」立刻变成假数字。Rust 侧只做最后一道把关（`image_relative_path`：名字里带分隔符或 `..` 就能写到克隆目录外面去）；
  6. 文件名（时间戳 + 随机段，`imageFileName`）与**整条子目录**都由 TS 算好，Rust 只校验边界；
  7. **`apps/desktop/src/renderer/index.html` 里那条 `<meta name="referrer" content="no-referrer">` 不能删**：Gitee 的 `/raw/` 有防盗链 ——
     请求带 `Referer`（且不是 gitee.com）时直接 403，而 WebView 里 `<img>` **一定会带** —— 少了这一条，所有 Gitee 图都会裂：
     上传成功、地址也对、curl 也 200，就是显示不出来。顺手也是个隐私改进。
- 克隆目录是用户数据根目录下的 `image-sync`（安装版 `%APPDATA%/Workbench/image-sync`，开发版
  `%APPDATA%/Workbench-dev/image-sync`），**与用量同步那个分开两份**（两个仓库地址可以完全不同）。

### 素材管理

笔记页左栏底部那颗图片按钮，管的是**「当前这个笔记本在这台机器上的那一层图片」**：把「那一层里有哪些图」与「这个笔记本里谁还在用」
凑起来，让你把没人用的清掉。四条口径：

1. **引用次数是数出来的，不是记下来的**。正文就是磁盘上的 `.md`，别处编辑器随时能改，所以口径是「面板一开就重新数一遍」（缓存只用于
   先把上次的结果显示出来，**不用于决定删不删**）。数的是**文件名**的出现次数（同一张图在正文里可能是 raw 地址、带前缀的地址、相对
   路径），纯函数在 note-image.ts（`buildImageAssets` / `countImageReferences`）；
2. **清单与引用都只限「这台机器 + 当前笔记本」那一层**（列它、也按它删）。所以「未引用」才真的等于「这个笔记本里没人用」——
   **别把清单扩到上一层去**：那样列出来的是别的笔记本、别的机器的图，它们的引用次数拿当前笔记本的正文根本数不出来，看着能删、删了会
   裂图。还能删错的只剩一种情形：地址被**手工抄到别处**用过，确认框里如实说这一句，这是这个功能唯一不可逆的地方。
   **没打开笔记本时这一页什么都不列**，不要退回上一层去猜；
3. **只放行「未引用」的那些**（勾不动的行就是有人用的），删除是**一次提交 + 一次推送**（参数见 `sync.rs` 的 `delete_images_at`）；
   一张都没删到时不提交空提交；
4. **路径边界一律在 Rust 侧**（`image_repo_path`）：递回去的路径必须逐段是普通名字、必须是图片、必须落在**这次传下去的那个目录**里
   —— 少最后一条，删图就能删到仓库里别的东西上（用量分片、配置文件、别的笔记本的图都在同一个仓库里）。渲染层只负责「哪些被选中了」。

另外两条：**扫描正文那条通道只回原始文本**（`note_scan_texts`），怎么算「引用了一次」是上面的纯函数；读不出来的笔记要**计数并如实说给
用户**（少读一篇就可能把还在用的图当成没人引用）；面板里那点缩略图取的就是图片自己的访问地址（与正文里显示图片同一条路，按行懒加载）。

### 笔记同步

远端**不在设置里**：同步到哪儿就是那个笔记文件夹自己连着的 `origin`（`packages/notes/src/note.ts` 的 `NoteRepoState`），
入口是笔记页左栏底部那颗同步按钮，实现在 `sync.rs` 的 `sync_notes`。
与另外两处同步最大的区别是**没有克隆目录**：跑 git 的地方就是用户那个笔记文件夹本身
—— 「笔记就是磁盘上那些 `.md`」这条不变。调用 git 的方式（直启、`GIT_TERMINAL_PROMPT=0`）见 [AGENTS.md](../../AGENTS.md) 第 1 节。

八条不能破：

1. **应用不创建仓库、也不接远端**：不是仓库、没有 `origin`，都只如实报一句带解决办法的话（`git init` / `git remote add`）；
   **没有仓库的笔记就是本机的笔记** —— 笔记页那颗同步按钮根本不出现，别用「灰着」或「点了报去哪配」来提醒。
   代价（认下）：发现性落在文档上，「想让笔记同步就先自己 clone 或 `git init` + `remote add origin` 再把文件夹选进来」；
2. **判定只认「这个文件夹自己有 `.git`」**（`repo_state` 与 `sync_notes` 入口两道完全一致，别各拍一个）：
   不放宽成「它处在某个仓库里」—— `commit_notes` 是 `git add -A` **不带 pathspec**，那在现代 git 里等于整棵工作树，
   笔记本夹在别人的仓库子目录里时（实测有这种笔记本）一次同步就会把那个仓库里的东西一起提交并推走。
   `.git` 是目录或文件都算（worktree / 子模块）；
3. **远端地址不再作为 git 参数出现**：`fetch` / `pull` / `push` 都是按名字写死 `origin` 的，
   地址只用于显示（按钮的提示里写清楚「同步到 <地址>」—— 文件夹里**任何** origin 都会被当成笔记仓库，
   用户可能早先为别的用途连过一个）。所以原来那套「地址会被当成命令行参数」的收敛（`sanitizeNoteRepo`）
   连同 `same_remote` / `local_path_key` 的比对**全删了**：别再把它加回来；
4. **次序固定为「提交本机改动 → pull --rebase → 推」**，提交必须在前：反过来的话工作区里的改动会挡住 rebase，而还没提交的那一份在
   冲突里没有落脚点；
5. **冲突不替用户挑边**：中止这次 rebase（本地那笔提交留着）、把冲突的文件名报回去 —— 笔记是文字，自动挑一边就是悄悄改掉人家的内容。
   **只在这次是我们起的 rebase 时才 abort**：文件夹里本来就留着半截 rebase / merge 的话，那是用户的现场，入口直接拒绝动手；
6. **同步前必须先让编辑器把手上的那一份交出去**（[NotesView.vue](../../apps/desktop/src/renderer/src/components/NotesView.vue) 的
   `editorRef.flushAll()` + store 的 `waitForWrites()`），否则提交的是按下按钮之前的那一版；回来之后**重扫树 + 重读打开着的那一篇**
   （远端可能刚好改过它），换正文由 `reloadFromProps()` 转达 —— 编辑器实例只有上层拿得到；
7. 分支按**这个工作区当前站着的**那个走（用户在自己文件夹里切过分支，别去动它）；只有还没有提交时才交给 `sync_branch`（跟着远端已有
   分支，都没有才新建 main）；
8. 提交信息是 `notes: <设备名>`；用户没配过 git 身份时只写**这个仓库的本地配置**兜底（`ensure_commit_identity`），不动他的全局身份。
   **每个会产生提交的地方都要先走一遍它** —— 技能的自动提交（`skills.rs` 的 `commit`）不经过同步，漏了的话没配过全局身份的用户
   会看到 git 那句 "Please tell me who you are"。

仓库状态（有没有仓库、`origin` 是什么、当前站在哪个分支）是**探出来的、不落盘**：通道 `note_repo_state`
（`sync.rs` 的 `repo_state`），在 notes store 里只在「重新读一遍这个文件夹」的几处与每次同步之后探一次
（`probeRepo`）。它只决定界面给不给入口、写哪句提示，所以探不出来按「本机的笔记」处理，不是错误 ——
别为它造一个设置项或一份持久状态。
**分支那一项（`branch`）是给 AI 助手页用的**（说清在哪个分支上干活，见 [ai.md](ai.md)）：读的是
`symbolic-ref --short HEAD`，**不是** `rev-parse --abbrev-ref HEAD`（后者在还没有提交的仓库里会回一个
`HEAD`，看着像分支名就叫 HEAD）；分离头指针 / 不是仓库时是空串。笔记与知识库那两页不看它。

### 独立编辑窗口（资源管理器「打开方式」）

笔记页之外还有一扇**只装一块工作台面板**的窗口（第六个 HTML 入口 `markdown.html`，Rust 在
`md_window.rs`）：安装后在资源管理器右击 `.md` / `.markdown` →「打开方式」→ Workbench，
就直接编辑那一个文件。它与笔记页共用 `notes.rs` 的读 / 写与 mtime 冲突保护，但没有笔记本、
没有目录树、没有导航栏；面板里有标题栏、正文、大纲栏与底栏。

- **文件关联由安装器登记**：`tauri.conf.json` 的 `bundle.fileAssociations`（`.md` / `.markdown`）。
  Tauri 的 NSIS 模板会把这两个后缀的**默认打开程序**改成 Workbench（卸载时恢复备份值）——
  这是明知的取舍。开发模式不登记；改完要重新构建安装包才生效。
- **一个文件一扇窗**（label `markdown-<uuid>`）：同一路径再次打开只聚焦已有窗口，不同文件各开一扇。
  启动参数里有 md 文件时主窗口照建但**不显示**（托盘与后台服务照旧）；关掉编辑窗口后应用留在托盘，
  从托盘「显示主界面」仍能叫出主窗口。
- **无边框**：`md_window.rs` 建窗时 `decorations(false)`，系统标题栏不画 —— 最小化 / 最大化 / 关闭
  三颗窗口键由渲染层自绘在标题栏右端（规格照 `TitleBar.vue` 的手画 SVG，但那份引着 store，
  这扇窗不装 store，图标照抄不引）；标题栏与底栏都标了 `data-tauri-drag-region` 兼做拖动带
  （双击最大化 / 还原由 Tauri 的注入脚本接管，组件里**不要**再写 `@dblclick` 自己 toggle）。
  拖动要 capabilities 放行：`markdown-window.json` 里的 `core:window:allow-start-dragging`
  （`core:default` 不含它，被 ACL 拦下是静默失效）。最大化状态从 Rust 推
  （`md_window.rs` 在 `Resized` 事件里比对后发 `markdown-window:state-changed`，与主窗口
  main.rs 那条同款但用**这扇窗自己的**上一次观测值 —— 全局那份 `MaximizedFlag` 是主窗口的，
  两边共用会互相顶掉），渲染层经 `onMarkdownWindowState` 订阅、`markdownWindowIsMaximized` 问初值，
  第三颗按钮据此画「最大化」还是「还原」；最小化 / 最大化复用主窗口同款的
  `window_minimize` / `window_toggle_maximize`（两条都按调用方窗口生效），关闭按钮直接走
  `markdown_window_close`（防抖里那一份由输入路径交出去，见下面的「关闭是握手」）。
- **路径只从 Rust 会话取**：`markdown_window_context` / `markdown_window_save` 都按窗口 label 查会话，
  不接受渲染层传路径 —— 这扇窗没法读写它被打开的那个文件以外的任何东西；读写走 `notes::read` /
  `notes::write`，冲突规则与笔记页完全一致（写盘带 mtime，别处改过就拒绝）。
- **独立入口只装适配层、不装 store、不 initState**：正文与保存状态由 `markdown-window/` 自己持有；
  装 store 会与主窗口抢着写同一批数据文件（与 video / pin / ball 同一条规矩）。
  `NoteEditor` 为此把图片仓库与「允不允许上传图片」改成 props（笔记页传仓库地址，独立窗口
  传 `allowImageUpload=false`）—— 独立窗口没有「笔记本」这一层，粘贴图片会把图推到图片仓库里
  一个临时层级，不是那个窗口里期待的动作。
- **工作台面板**：窗口内边距 `--sp-4`，里面一块 `.md-panel`（`--bg-surface` + `--border` + `--r-lg` +
  `--shadow-card`）；标题栏 52px、底栏 34px，加载与打开失败也落在这块面板里（不再是一整页白）。
  标题栏左边是文件图标与文件名（`Markdown` 副行已删），右端是三颗自绘窗口键（见上面「无边框」）。
- **底栏的保存状态**：`保存中…`（队列里还有笔数）→ `已保存 · MM-DD HH:mm`（`savedAt`，读盘与每次落盘后更新）；
  失败时切到 `保存失败`（`--st-fail`）。状态只用于展示，写盘仍走原来的串行队列。
- **底栏**：左边「N 字」（**非空白字符数，含 markdown 记号** —— 它是正文本身，不是渲染后的结果）+ `Markdown`；
  右端是保存状态与大纲开关（无边框改版后从标题栏挪下来），保存失败时改显原因与「重试」——
  原来的右下角浮动提示搬到了这里。整条标了拖动区（按钮自己不拖）。
- **左侧大纲**：目录与正文分成两列（`.md-body`），左栏 `.md-rail` **默认 320px、可拖**
  （这扇窗不接主题、也不写 theme.json；宽度只活在本次窗口里，关窗回到 320。区间沿用
  `noteRailWidth` 的 160–420，见 `clampNoteRailWidth`）。拖右缘那条通高热区改宽（指针往右拉），
  拖动期间挂 `body.is-resizing-md-rail`（这扇窗没引 global.css，光标与文本选择由
  `markdown.html` 的内联样式兜住）；热区落在栏的右内边距里（不压正文的悬浮滚动条），
  是栏的子元素（收起时随栏一起裁掉），静止时只露正中间一枚小竖条。
  笔记页那条的宽度是 theme.json 的 `noteRailWidth`，两边互不影响。条目底子与笔记页的
  `.notes__rail` 是同一套
  （各自 scoped，没法共用，**改条目样式要两边一起改**：27px 行片、缩进、悬停底、箭头规格一致）。
  条目的**整行收展**与笔记页共用
  `use-outline-row-toggle`（见上文「约束」③，这扇窗挂在 `.md-rail` 上；**显隐走 CSSOM**，
  这扇窗的 CSP nonce 会丢行内 style 属性）。`NoteEditor` 传 `outlineHost` + `outlinePinned`：
  初始化完成后把 Vditor 那枚大纲元素搬进左栏并直接打开；钉死这一档右键菜单里不再给「大纲」
  （`NoteContextMenu` 的 `hidden`），否则能从菜单把它关成一条空栏。
  **底栏那颗开关做的是宽度过渡**（`.md-body.is-rail-closed` 把宽度 / 左右内边距 / 不透明度
  一起归零，0.2s `--ease-out`；栏始终留在 DOM 里，不碰 Vditor 的大纲），**箭头同时转 180°**
  （底图是左向箭头，收起后朝右）；系统开了「减少动态效果」时两者都直接跳。
  窄窗口（< 820px）打开时默认收起。**栏宽不跟正文抢**：编辑器自己只拿剩下的宽度。
- **正文滚动条**：原生条收掉，由共享的 `OverlayScrollbar` 画（见上文「正文编辑器」那一节）；
  这扇窗没引 global.css，原生条本是 WebView2 带箭头那副，这一下也一并盖掉。
  正文排版在这扇窗里单独松一档（15.5px / 1.8、单行约 1200px、左右内边距居中），只在
  `MarkdownWindowApp` 的 scoped 样式里，笔记页不受影响。
- **关闭是握手**：Rust 先 `prevent_close` 并向窗口发 `markdown-window:flush`，渲染层收到后先回一条
  `markdown_window_cancel_close` 撤掉兜底计时（保存与确认可能要等用户慢慢决定），再把防抖里那一份交出去、
  等保存落地，最后调 `markdown_window_close` 销毁；保存失败会问「仍然关闭 / 留在窗口」。
  收不到回执时 10 秒兜底销毁，防止窗口永远关不掉。
- **正文顶上不许再出现一块白**：`markdown.html` 里那段内联 `<style>` 会让生产态的 Tauri 给 `style-src`
  加 nonce（nonce 一在场 `'unsafe-inline'` 就失效，源码里的行内 `style` 属性全被丢弃），而 Vditor 的图标
  sprite 是 `insertAdjacentHTML` 到 `body` 最前面、靠行内样式缩成 0×0 的 —— 样式被丢后它按 SVG 默认尺寸
  占成 300×150，把整扇窗往下顶 153px。所以那段 `<style>` 里有一条 `body > svg { position: absolute;
  width: 0; height: 0; overflow: hidden }` 把尺寸补回来；**别删它**，也别在这五个有内联 `<style>` 的入口
  （markdown / video / capture / pin / ball）里改用行内 style 属性（细则见
  [ipc-and-state.md](ipc-and-state.md) 的 CSP 一条）。
- 已知取舍：独立窗口不上传图片、打开后不跟随主窗口实时换主题、正文里的相对链接不支持跳转
  （只编辑当前文件，点了如实提示）。

## 实现


- **笔记本就是本机的一个文件夹**（第一次进这一页必须先选它）：目录树就是文件夹本来的结构，
  正文就是里面的 `.md` —— 拿 VSCode / Typora 直接改那些文件也成立，切回应用（窗口重新获得焦点）或点一下刷新就是最新的样子。
  没选文件夹之前整页只有一句引导与那颗「选择文件夹」按钮。数据模型（`noteDir` / `noteDirs`、
  不进同步）的口径见上文「约束」一节
- 一页两栏：左边目录树、右边 **Vditor**（即时渲染，正文存 markdown 原文，数据不依赖编辑器）。
  两栏之间的缝可拖（`noteTreeWidth`，拖动只改本地、松手落盘；把手平时不显示，指针落上才露出）。
  右栏内部常显一条大纲（宽度可拖，见上文「约束」一节）。
  左栏底部一行是「这个笔记本是谁」：目录名、篇数、刷新 / 换文件夹 / 素材管理。
  **最近打开**（`noteDirs`，最多 6 条）是**点开才弹的浮层**（与左栏菜单区等宽、左缘对齐）——
  不做成常显：左栏本来就窄，这几个目录几天也不换一次。点一条换过去（换过的排最前、当前的加粗点不动），
  每条右边的删除叉只删历史记录、不关浮层。**再点一次目录名就收起**（不必去点别处）：
  那个弹层不用 `el-popover` 的 click 触发 —— 它的「点外面关闭」在 window 捕获阶段先关、
  按钮的 click 再开，两次一抵消就永远关不上（`RecentRoots` 里由按钮自己切换），
  浮层也不带箭头（箭头那一小片浮在壁纸上、还带一圈描边，比浮层本身显眼）
- 树里**没有「根行」**（顶层条目直接铺开），空文件夹时换成空态 + 新建两颗按钮。
  **文件夹排在文件前面**、同层按名字排（`numeric`，`笔记 10` 在 `笔记 9` 后）—— 顺序是算出来的，
  所以没有「插到某项前面」的拖动。忽略名单（`IGNORED_DIRS`：点开头的目录与 `node_modules` 一类
  噪音整棵跳过）见上文「约束」一节
- **拖动只认「文件拖进文件夹」与「拖到树下面的空白区」（移回最外层）**：文件夹不可拖，
  落在文件上、落在原处都不放行。松手后真的挪磁盘文件，**失败时重新扫一遍** —— `el-tree` 在松手那一刻
  已把自己那份数据挪过了，不重扫左栏显示的就是一个磁盘上不存在的位置
- 树的增删改都在**右键菜单**：节点行是新建笔记 / 新建文件夹 / 重命名 / 删除（整行都算这一行），
  另加三项**读**的动作 —— 在资源管理器中显示、复制路径（绝对路径，`noteAbsPath` 按笔记本根拼）、
  用默认程序打开（只对笔记）。菜单**贴指针落点**出现（`NoteTreeMenu`，落点与收起跟笔记正文 /
  邮件清单行 / 视频行共用 `use-floating-position` / `use-floating-dismiss`）—— `el-dropdown`
  的 contextmenu 触发器锚在整行上、右击行尾会弹回行首，**不要再用它**；**同一时刻只有一份**，
  右击另一行直接换落点。空白区是新建两项 + 刷新列表 + 在资源管理器中打开笔记本，
  新建一律落在笔记本根。名字最终是文件名：上限 60 字，非法字符与系统保留名在名字弹窗里
  当场说清楚（`noteNameProblem`）；**新建撞名自动退格**（`新建笔记 2`），重命名不退让。
  弹窗新建与重命名共用，聚焦与全选挂在 `@opened` 之后（正文打开时才挂，写在 `watch` 里等完 `nextTick`
  输入框也还没进 DOM —— 踩过，表现成「弹窗出来了、光标不在框里」）
- **「在资源管理器中显示」用的是系统能力 `reveal`，不是笔记通道**：笔记命令只认相对路径，
  这里先用 `noteAbsPath` 拼成绝对路径再交出去；文件会被选中、文件夹直接进去。那条路径只由
  扫出来的树喂进去，所以不必在 TS 侧再挡一次越界。
- **新建一篇笔记就是首页活跃度里的一笔**（来源 `note`，记在 `workbench/note.ts` 的 `createNote`
  里、命令成功之后）。**建文件夹不算**（那是整理，不是产出），**保存正文也不按次算** ——
  编辑器是防抖自动保存的，一个下午能写几百次盘（见 `NoteEditor.vue` 的 `SAVE_DELAY`），
  按它计数会把这一天的格子里顶成全图最亮（口径见 [home.md](home.md)）
- **删文件夹会带走整棵子树**，确认框写明「里面还有几项」；删掉的是当前打开的那一篇时右栏一并收起
  （否则下一次自动保存会顺着旧路径把它重建出来）
- **选中与打开是同一件事**：点文件夹就是选中（右栏说一句「这是个文件夹」），点笔记才是打开来写；
  选中项所在的那几层自动展开（`default-expanded-keys` 每次重建按清单恢复，清单**只放祖先不放选中项**）。
  展开态清单由笔记页持有并落盘（`noteTreeExpanded`，见[设置那一节](../features-and-architecture.md)的
  「上次看的那一档会被记住」），`NoteTree` 是 `expanded` 进、`update:expanded` 出、**自己不留副本**；
  换笔记本清空。`el-tree` 的两处脾气（`auto-expand-parent` 顶回展开态、名字栏那一层 `.node`
  必须 `min-width: 0` 且 `flex: 1` 盖住整行余宽 —— 否则长名字溢出、树横向错位，右键也接不住行尾）
  见 [`NoteTree.vue`](../../apps/desktop/src/renderer/src/components/NoteTree.vue) 顶部注释与样式
- 右栏标题行：左边名字 + 所在的那几层文件夹（面包屑，最外层没有上一级就不显示），右边保存状态
  （「已保存 · 最后修改时间」，写盘失败换成原因）。正文按 **600ms 防抖**落盘（先写同目录临时文件再改名，
  断电不留半篇），切笔记 / 离开页面先冲刷；换篇交出去的正文带着它属于哪一篇的路径，上层把树交给后端的
  重扫结果 —— 改名 / 拖动后靠后端回来的新路径接着认（`remapActive`）。
  **写盘带版本**：每一笔都交回读盘 / 上次落盘时的 mtime，别处在这期间改过的那一篇会被 Rust 拒绝；
  打开着的那一篇在窗口重新获得焦点、点刷新时重读（口径见上文「外部修改与写盘冲突」）。
- 正文里的链接被组件接管，**只有按住 Ctrl 的那一下才打开**（Typora 那套；普通点击什么都不做 ——
  这页是拿来写东西的）：外部地址走系统浏览器，指向本笔记本另一篇的相对链接就地跳过去（与在左栏点一下
  同一条路：自动展开、滚进视野）。跳转路径按这一篇所在的文件夹解析（`../`、`/别的.md`、百分号编码都认，
  `#小节` / `?x` 切掉）；树上没有这一篇时**先重扫再看**，还没有就如实说「找不到这篇笔记」。
  能跳的只有 `.md` / `.markdown`，图片、附件、锚点说一句「跳不过去」，不静默。
  三处 Vditor 脾气（IR 链接不是 `<a>`、`link.isOpen` 必须关、Ctrl 隐形所以 placeholder 里写了一句）
  见上文「约束」一节
- **只读模式**（**默认开着**，点标题行那颗「只读」按钮或按 Ctrl+/ 切到可写）只收**正文**的写入口：
  正文不可编辑、格式菜单不弹，让人安心读它。它不落盘，也不管左栏（树上的增删改拖照常、
  底部的同步与素材管理照常）—— 那些都是明确的操作，不是读的时候手一抖。**要点不是「关掉编辑」，
  而是别让它看着还能编辑**：
  点击与按键在**捕获阶段**拦在 Vditor 之外（否则点过的代码块会一直挂着源码样子 —— 它的展开态
  只靠 blur 收，而只读下点它不给焦点），正文另补一个 `tabindex` 让键盘照样能滚它 ——
  四条坑与各自的解法见上文「约束」一节。**Vditor 的初始化是异步的**，所以只读那一档不只挂在 watch 上：
  初始化完成那一刻由 options 的 `after` 回调再核一遍（编辑器可能是「已经切到只读之后」才建起来的）
- **编辑器的动作全部挪到正文的右键菜单**，工具带 CSS 藏起来（元素还在）：菜单三排图标 + 两行带子菜单
  （段落 / 插入），共 17 项 —— 正好是工具带的全部动作；光标在表格单元格里时再多一排表格操作（见下条）。位置贴指针、不越出窗口，右边放不下子菜单整份翻左；
  点别处 / Esc / 滚轮 / 窗口变化收起。**菜单自己不实现任何编辑动作**：每一项按名字去点工具带上对应的按钮
  （动作名必须与 `TOOLBAR` 对得上，点不到只在控制台告警）。菜单 Teleport 到 body，且按下时
  `preventDefault` 掉 mousedown —— 否则焦点挪走、**选区没了**
- **表格的行列增删在右键菜单的第四排**（光标落在单元格里右键才出现）：下方 / 上方插行、右侧 / 左侧插列、
  删行、删列六项。Vditor 4 的表格工具条**只挂在 wysiwyg 模式**上，IR 模式没有，行列操作平时只能按它
  自己那组快捷键（Ctrl+= / Ctrl+Shift+F / Ctrl+Shift+= / Ctrl+Shift+G / Ctrl+- / Ctrl+Shift+-，
  菜单项的提示里带着）。菜单的这排**不点工具带** —— 工具带上没有对应按钮 —— 而是 NoteEditor 合成一次
  按键派发到 IR 元素上（`runTableAction`），让 Vditor 自己的表格处理器去干活（渲染 / 光标 / 撤销栈都归它）；
  两个坑：匹配器在非 Mac 上把带 Shift 的 `=` / `-` 改写成 `+` / `_` 之后才比 `event.key`（合成事件得给
  改写后的键），事件必须 `bubbles: true`（监听器在 IR 元素上）。动作名带 `table:` 前缀经 `execTable`
  分流，与工具带动作用同一条 `act` 事件
- **粘贴的图片推到用户自己的 git 仓库**（不放进笔记本目录）：正文里留下一条
  `![图片](https://…/images/<设备>/<笔记本>/20260916-104512-ab12cd34.png)` 外链，笔记文件始终很小。
  一次上传就是一次 `pull → 写文件 → commit → push`（与 Token 同步同一套机制、另一套地址与克隆目录）；
  文件名 = 时间戳 + 随机段（按名字排即按时间排，同秒多贴不覆盖）。三层落点里，笔记本那一段是
  「目录名小写 + 整个路径的摘要」（如 `笔记-3f2a91c4`）—— `D:\a\笔记` 与 `E:\b\笔记` 不会落进同一层，
  这是素材管理「只看得见自己那一份」的前提；其余口径（七条不能破、`no-referrer`、访问地址只认
  GitHub / Gitee / GitLab）见上文「约束」一节 与[「数据与隐私」](../features-and-architecture.md)。
  上传期间编辑器右下角挂一颗 loading 角标（贴多张带张数）—— 一次上传一次 `git push`，几秒里正文什么都不会出现，
  没提示就像按下去没反应
- **素材管理**（左栏底部图片按钮）回答「我能安全删掉哪些图」：列表来自仓库那一层、引用次数来自当前笔记本
  的正文，两边凑起来才知道哪张没人用（口径见上文「约束」一节）。面板一行一张图：
  缩略图（点开在浏览器看原图）、文件名、大小、被引用次数；**未引用的排最前**带红字，有人用的行**勾不动**；
  底部「全选未引用 / 清空选择 / 删除 N 张」，删除前确认，按下去是**一次提交 + 一次推送**（删图也要进历史，
  不然别处克隆出去的那份还会把图带回来）。缩略图按行懒加载；拼不出访问地址的仓库显示占位图标，不是裂图。
  历史包袱：改版前平铺在 `<images>/` 的图不在任何一层里，不进素材管理，要清理只能去仓库手工删
- **笔记可以整体同步到你自己的 git 仓库**（**地址不在设置里**：就是笔记本文件夹自己连着的 `origin`，
  没仓库的文件夹连同步按钮都不出现）。左栏底部那颗按钮把当前笔记本与远端对齐一次；与另外两处同步最大的
  区别是**没有克隆目录** —— 跑 git 的地方就是笔记本文件夹本身，换台机器 clone 下来还是同一份东西。
  应用不 `git init`、不接远端；判定、次序、冲突、身份兜底那八条见上文「约束」一节。
  按钮的提示里写着**这次会同步到哪个地址**（任何 `origin` 都会被当成笔记仓库，推之前你得知道是哪儿）；
  每条 git 命令都带 `-c core.quotepath=false`（中文冲突文件名才报得成人话，见
  [../sync-and-auth/constraints.md](sync-and-auth.md)）
- **Vditor 的静态资源随包带一份**：图标 / 语言包 / lute / 内容主题 / 表情 / 代码高亮是**运行时**按
  `options.cdn` 取的（默认指 unpkg），所以 `cdn` 指向本地 `public/vditor/`，内容由
  `scripts/sync-vditor-assets.mjs` 在 dev / build 前从 `node_modules/vditor/dist` 复制
  （只带用得着的子集约 4.8MB；整包 20MB 其余是 katex / mermaid / echarts 这些用不到的）。
  复制挂在 vite 的 `configResolved` 上，dev 与 build 都绕不过；版本没变就跳过


## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

```
  src/notes.rs           笔记文件夹：列目录 / 读写 / 新建 / 改名 / 移动 / 删除（只认相对笔记根的路径，
                         扫的时候跳过点开头的目录与 IGNORED_DIRS 里那批依赖 / 构建产物；写盘带
                         期望 mtime，别处改过 / 删掉时拒绝覆盖），以及「把所有笔记的正文读出来」
                         （scan_texts，素材管理算引用次数用）
  src/md_window.rs       资源管理器「打开方式」的独立编辑窗口：命令行解析 / 会话（窗口 label →
                         文件路径）/ 建窗 / markdown_window_context / save / close（关闭握手），
                         文件路径只从会话取，渲染层传不了第二个文件
```

其余两处在渲染层（同为原注解）：

```
    note.ts             笔记的适配包装（workbench/，与 video.ts / work-log.ts 等同一排）
    notes.ts             笔记：笔记本（用户挑的文件夹）、最近打开的那几个、
                         扫出来的目录树、当前打开的那一篇（stores/）
    markdown-window/     独立 Markdown 编辑窗口的宿主（markdown.html 入口）：只装适配层，
                         正文 / 保存队列 / 关闭握手都在这；不装 store
    markdown-window.ts   独立编辑窗口的适配层（workbench/：上下文 / 保存 / 关闭 / 冲刷事件）
scripts/sync-vditor-assets.mjs  dev / build 前把 Vditor 用得着的静态资源复制进渲染层 public/
```
