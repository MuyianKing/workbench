# 笔记

## 约束

关键落点：`apps/desktop/src-tauri/src/notes.rs`（列目录 / 读 / 写 / 新建 / 改名 / 移动 / 删除）、
`apps/desktop/src-tauri/src/md_window.rs`（资源管理器「打开方式」的独立编辑窗口）、
`apps/desktop/src-tauri/src/sync.rs`（git 基础设施 + 笔记同步）、`apps/desktop/src-tauri/src/sync_images.rs`（图片上传 /
列清单 / 删图）、`apps/desktop/src/renderer/src/stores/notes.ts`
（`stores/notes.ts`）、
`apps/desktop/src/renderer/src/components/` 下的 `NoteTree.vue`（左栏树）、`NoteTreeMenu.vue`（树右键菜单）、
`NoteEditor.vue`（Vditor 正文）、`OverlayScrollbar.vue`（正文悬浮滚动条）、`NoteContextMenu.vue`（正文右键菜单）、
`NotesView.vue`（页面编排），`apps/desktop/src/renderer/src/markdown-window/`（独立窗口宿主）、
纯口径在 `packages/notes/src/note.ts` 与 `note-image.ts`。
跨模块通用事实见 [features-and-architecture.md](../features-and-architecture.md)，红线见 [AGENTS.md](../../AGENTS.md)。

**动手前先读 NoteTree.vue 顶部的注释**：空白区的 `blankHover` 标记、展开态清单那两条 `el-tree` 坑
（`auto-expand-parent` 默认 true、清单里不能放选中项自己）只在那里写清楚。

### 数据模型

- **笔记没有数据文件**：就是那个文件夹里的 `.md`，应用只记「当前打开哪个目录」（`noteDir`）与「打开过的那几个」
  （`noteDirs`，左栏底部「最近打开」）。两者只对本机成立，不进 theme.json、不参与同步（左栏**宽度**
  `noteTreeWidth` 与右栏大纲宽度 `noteRailWidth` 是「界面长什么样」，住 theme.json）。**别把笔记塞进同步或主
  数据文件** —— 旧版那棵 `note-data.json` 就是反例，早已不读写。首次进笔记页必须先选文件夹。
- 三条不能破：**所有笔记命令都要带 root**（别把路径缓存在适配层）；**路径只认相对笔记根的写法**，`..` / 绝对
  路径在 `notes.rs` 被挡住；**结构改动一律用后端重扫出来的树**，别本地推算（外面编辑器改过时只有磁盘说了算）。
- `notes.rs` 的路径边界：逐段只接受普通名字，改名 / 移动 / 删除再挡一道「不能对笔记根自己下手」。

### 左栏目录树

- 树就是笔记本本身，**没有「根行」**（笔记本是哪个目录写在左栏底部）。往最外层的落点是树下面的**空白区** ——
  不归 `el-tree` 管（落点只认节点行），自己接 `dragover` / `drop` 并 preventDefault，用 `noteDropAllowed` 判。
- **只有文件能拖、只能落进文件夹**：`el-tree` 的 prev / next 两种落法一律不放行 —— 顺序按名字算，插「前后」
  下一秒就没了。
- 名字最终是文件名，带 `/`、`:` 或系统保留名必须在名字弹窗当场说清（`noteNameProblem`）。
- 移动失败要**重扫**：`el-tree` 松手时已自己挪过数据，磁盘真挪没挪由 store 说了算，否则左栏显示不存在的位置。
- 口径在 [note.ts](../../packages/notes/src/note.ts) 纯函数里：文件夹排在文件前、同层按名字排（`buildNoteTree`，
  `numeric` 规则）；只收 `.md` / `.markdown`。
- **展开态由笔记页持有并落盘**（`noteTreeExpanded`，`sanitizeNoteTreeExpanded`）：`el-tree` 每次重建都丢展开态，
  清单要一路恢复；**`NoteTree` 是 `expanded` 进、`update:expanded` 出，自己不留副本** —— 再存一份就两份状态打架。
  清单存**相对笔记根的文件夹路径**（节点 `id`），**换笔记本必须清空**（`setRoot`）：相对路径在另一个笔记本里
  指完全不同的东西。收起被自己清单顶回来的，看 NoteTree.vue 顶部 `auto-expand-parent` 注释。
- **扫描有忽略名单**（`IGNORED_DIRS`）：点开头的一律跳（`.git`、`.obsidian`、`.vscode`、`.idea`…），外加
  `node_modules` / `dist` / `build` / `out` / `target` / `coverage` 整棵不走 —— 动辄几万文件。代价是真有一个叫
  `build` 的目录时看不见；要么改名单、要么换名，**别把名单悄悄删掉**。

### 正文编辑器（Vditor）

- `cdn` 必须指向随包那份（`public/vditor/`）：图标 / 语言包 / markdown 引擎（lute）/ 内容主题 / 表情 / 代码高亮
  都是**运行时**按 `options.cdn` 取的，默认指 unpkg —— 指错等于给「默认不联网」开洞。
- **升级 Vditor 后留意是否又用新资源**：缺哪个哪个功能不生效（本地 404，不退回联网），编辑器会起不来。
- localStorage 缓存关掉（`cache.enable`），正文落盘归 store 与适配层。
- **写作区底色必须透明**：Vditor 默认铺不透明底色，半透明卡片里会嵌一块实心白。
- **引用块竖线亮色取 `--border-strong`**：自带 `#eaecef` 比半透明卡片还亮，像一道白边（与 MarkdownView 同档）；
  暗色不动，自带 `#d1d5da` 够清楚。
- **代码块上下空档只在收起态收掉**（`:not(.vditor-ir__node--expand)`）：展开态那两行是围栏本身。
- **展开态只留源码，预览层收掉**（`--expand[data-type='code-block'] > .vditor-ir__preview` 整层
  `display: none`）：IR 代码块在 DOM 里是源码（`.vditor-ir__marker--pre`）与高亮预览
  （`.vditor-ir__preview`）两层，折叠靠 marker 宽高切换，但 Vditor 自己的样式从不隐藏预览 ——
  点进代码块后两层一起出现，同一段代码看两遍。折叠态归上一条管（只留预览），展开态归这条管
  （只留源码），blur 收起回到高亮；预览层在输入时仍被 Vditor 同步重算，收起那一刻就是新的。
- **`input` 回调不是同步到的**（内部有处理延迟），换篇 / 卸载不能只看防抖那份，要 `getValue()` 现取；交出去的
  正文**必须带它属于哪一篇**（`{ rel, content }`）—— 换上来的正是「当前选中项」，只按选中项取路径会把上一篇
  写进刚点开的那篇。
- **上传期间挂 loading 角标**（`uploading`）：一次上传一次 `git push`，几秒很正常，这几秒正文什么都不出现。
  收尾只放 `finally`；别用 `v-loading` 遮罩 —— 上传时用户还在写，遮罩会锁住正文。
- **空文档在 Vditor 是 `'\n'` 不是 `''`**：两者不算改动（`sameText`）—— 照实写会让每打开一次空笔记就给空文件
  补一个换行；一旦当成改动，改名 / 删除的收尾 flush 会带**旧路径**发出去，旧位置凭空长出文件。配套闸在 store 的
  `saveContent`：路径不在树里就整次不写。
- **动作一律交回 Vditor**：右键菜单只记动作名、按名字点工具带按钮，别另写一套格式化（选区、markdown 往返、
  撤销栈都会分叉）。工具带只是不显示、仍在 DOM，所以 `TOOLBAR` 删项前先看菜单有没有用。
- **正文滚动条自绘**（`OverlayScrollbar.vue` + `use-overlay-scrollbar.ts`）：`pre.vditor-reset` 才是滚动容器，
  原生条在 `NoteEditor` 用 `scrollbar-width: none` 收掉，换成 5px 胶囊滑块 —— 不占宽度、无轨道箭头、可拖可点轨。
  笔记页与独立窗口共用；后者没引 global.css，原生条本是 WebView2 带箭头那副，一并盖掉。几何在 `thumbMetrics()`
  （纯函数、有单测），监听 scroll / ResizeObserver / MutationObserver / 图片 load 四类变化。
- **正文链接在组件里接管，只有按住 Ctrl 才算**（普通点击什么都不做：这页是拿来写的，点正文本是挪光标）。
  Ctrl 那下：外部地址走 `openExternal`；相对链接**只认指向笔记的**，用 `resolveNoteLink` 解析后交给上层。
  **IR 模式链接不是 `<a>`** —— lute 把 `[文字](地址)` 渲染成 `<span data-type="a" class="vditor-ir__node">`，
  地址在 `.vditor-ir__marker--link`（文字 `.vditor-ir__link`），`closest('a')` 一个都匹配不上。
- **跳转一律走 store 的 `select`**（与左栏点一下同一条路），别另开「打开某一篇」；跳前先在树上找，找不到先
  `reload` 再看（目标可能是别的编辑器刚写的），还没有就提示，**别把选中项切到不存在的路径**（右栏会显示成
  「『』是文件夹」）。只有 `.md` / `.markdown` 能跳，图片 / 附件 / 锚点说一句，别静默。
- **`options.link.isOpen` 必须关着**：Vditor 默认点击链接自己 `window.open(地址)`，`preventDefault` 拦不住（拦的是
  浏览器默认动作）—— 外链会多弹窗、相对链接在 WebView 里打开错误页，而且**它不看按没按 Ctrl**。
- **大纲在右侧、始终显示**：正文与目录两列，右栏常显（打开一篇就有它），**没有开关** —— `NoteEditor` 传
  `outlinePinned`，初始化后直接打开大纲，右键菜单不给「大纲」。只收 `#` 标题。栏宽是 theme.json 的
  `noteRailWidth`（默认 224，见 [theme.ts](../../packages/appearance/src/theme.ts)），拖栏左缘改（只改本地跟手、
  松手落盘）。四件配套：
  ① **大纲元素搬出正文区**（`outlineHost`）：Vditor 建在 `.vditor-content` 里，顶边只能贴正文、比页头低一整行
     —— 笔记页把一条与页头同高的右栏 `<aside>` 交给它，初始化后 `appendChild`；开合 / 内容 / 跳转仍是 Vditor 的；
     **卸载时把元素从栏里摘掉**，否则下一位编辑器并排挂两个。宿主是模板 ref，watcher 可能早于异步初始化 ——
     **`attachOutline` / `ensureOutlineOpen` 要连 `editor.vditor` 一起判空**（只判 `editor` 会抛
     `Cannot read properties of undefined`）。
  ② **只读的捕获拦截要让路**（`NoteEditor.onClick` 里 `.vditor-toolbar, .vditor-outline` 提前 return）：只读默认档，
     那条 `stopPropagation` 挂在捕获阶段，会把这两处点击一起吞掉 —— 工具带虽藏着、按钮照旧点得动；大纲跳转也归
     Vditor 的监听器接。
  ③ **条目整行收展**（`use-outline-row-toggle.ts`，笔记页右栏与独立窗口共用）：Vditor 只让箭头 svg 认收展，
     整行接管在宿主栏挂 **capture 阶段**的 `@click.capture` 委托：点到「有子级 `ul`」的条目行任意位置就复刻收展
     （svg 加 / 去 `--close`、子列表切 `display`）并 `stopPropagation` —— 不拦的话点箭头时 Vditor 自己也跑，同一下
     收展两次互相抵消；叶子条目与空白放行（叶子还要跳标题）。大纲 DOM 会被重建，委托按点击目标现场查找。
     **子列表显隐必须走 CSSOM（`el.style.display = …`），不许 `setAttribute('style', …)`**：独立窗口
     markdown.html 有内联 `<style>`，生产态 Tauri 加 nonce 后 CSP 的 `style-src 'unsafe-inline'` 整体失效，行内
     style 属性被静默丢弃 —— 现象是箭头转了、列表收不起来（与 sprite 占位同坑）。CSSOM 赋值不经属性解析。
  ④ **样式归 NotesView 的右栏**（元素搬出后 `.editor :deep()` 够不着）：透明底、`--border` 发丝线、`--ink` 悬停、
     `--font-ui`；条目是 19px 行高 + 4px 内边距的圆角悬停片；栏宽由 `--rail-w` 给。**拖动把手是栏左缘一条
     `--sp-4` 宽的热区**（`notes__rail-resizer`，悬停才露小竖条），拖动挂 `body.is-resizing-notes-rail` 兜光标
     与选择；**别改成 `PanelResizer`** —— 那只按左栏宽度定位、改的是左栏。搬出后 `--textarea-text-color` 不再从
     `.vditor` 继承，要在栏里补一份。页头是 `align-items: center`（**不是 baseline**：混着 15px 标题与 10.5px
     辅助文字，按基线小字会浮上去），栏首「大纲」的 `line-height: 28px` 与页头垂直居中。
- **正文左右留白固定 50px，剩下全给正文**：Vditor 默认把可读宽度钉在 `preview.maxWidth`（800）并居中，宽窗口
  下左右各留几百像素。现在 `preview.maxWidth` 给大数（让自动内边距退回最小），真正留白由 `NoteEditor` 的
  `padding-left / padding-right: 50px !important` 定 —— Vditor 的 `setPadding` 在 resize 时写**行内** padding，
  普通样式压不住。**独立窗口例外**：`MarkdownWindowApp` 用更具体的 `!important` 覆写成居中约 1200px。
- **正文底部始终留一段空白**（120px）：最后一行不贴卡片下沿。借 Vditor 的 `pre.vditor-reset::after`（高度取
  `--editor-bottom`）—— **必须长在滚动内容里**，别改成外层 `padding-bottom`（滚动条到不了它下面）。光标自动滚动
  只到「刚好可见」，所以**输入前已贴底**时回车落定后由 `markBottomStick` / `onContentInput` 把滚动补到底；
  读着上面时不抢滚动。

### 外部修改与写盘冲突

- **打开着的那篇不会自动重读**（防抖里可能还有没落盘的字）：窗口重新获得焦点（且在笔记页）、左栏底部刷新、
  树上「刷新列表」三处对齐磁盘 —— 没有未保存修改就直接换正文；有未保存修改时只有磁盘确实变了才问。
  点同一篇**不算**重读（`open()` 的提前返回仍保留）。
- **写盘必须带上次读盘 / 落盘的 mtime**（`note_write` 的 `expectedMtimeMs`，Rust 侧 `notes::write` 写前核）：
  文件被别处改过或已删时**一个字都不写**，原因挂 `saveError` 由标题栏红字显示。这是「别处修改不被静默盖掉」的
  唯一保证，别为少一次 stat 删掉。
- 切篇时补交上一篇（那时 `active` 已是新的一篇）也要带基准：store 按路径另记一份（`mtimeByRel`），换本清空。
- 「已保存 · 时间」用**文件自己的 mtime**（打开时记下、写成功后用 Rust 回的值），不用本地时钟；打开一篇时重置
  `savedAt`。
- 「有没有未保存修改」不能只看编辑器自己的基线（`saved`）：写盘被拒后它也会以为保存了。要对 store 里**最后一次
  真正落盘 / 读盘的内容**（`NoteEditor.hasUnsaved(base)`）。

### 编辑器自定义快捷键

- **表只存用户改过的项**（`editorHotkeys`，`@workbench/notes` 的
  [editor-hotkeys.ts](../../packages/notes/src/editor-hotkeys.ts)）：键是动作名（与右键菜单 / `TOOLBAR` 一致），
  值是组合键串（`Control+3`，与全局快捷键同口径）。**空串 = 禁用**该动作的自定义键（恢复默认就是从表里删掉）。
- **有一份「生效的默认键位表」**（`EDITOR_HOTKEY_DEFAULTS`）：标题六档 `Control+1` ~ `Control+6`（离手近；与
  Vditor 原厂 `Ctrl+Alt+N` 并行），其余 12 项照原厂（粗体 Ctrl+B、斜体 Ctrl+I、删除线 Ctrl+D、行内代码 Ctrl+G、
  代码块 Ctrl+U、链接 Ctrl+K、引用 Ctrl+;、无序 Ctrl+L、有序 Ctrl+O、任务 Ctrl+J、分隔线 Ctrl+Shift+H、表格
  Ctrl+M）。**拦截按「默认 + 用户覆盖」的合成表**（`mergeEditorHotkeys`，computed 缓存）：没碰过的按默认键触发
  （默认真生效、不只是显示），覆盖的换用户的键，空串禁用的不拦。
- **可配的只有 18 项常用动作**（标题六档 / 粗斜删 / 行内代码 / 代码块 / 链接 / 引用 / 三种列表 / 分隔线 / 表格）；
  **undo / redo / outline / fullscreen 不开放** —— 它们被 Vditor 内部键绑定与视图状态管着，拦下来自己
  `runAction` 会跟内部状态分叉。
- **配置住数据文件**（本机性质，不参与外观同步，与 `hotkey` / `captureHotkey` 同类），收敛在
  [persisted-data.ts](../../apps/desktop/src/renderer/src/persisted-data.ts) 调 `sanitizeEditorHotkeys`：动作名不在
  清单的丢掉、值去空白、输出按清单顺序排稳。配置界面在设置 · 通用 → 笔记，录制件与全局快捷键共用 `HotkeyField`
  （同一种按法录出的串必须一致，`acceleratorOfEvent` 纯函数从 use-hotkey-recorder 导出，录制与匹配共用一份口径）。
- **撞键自动腾位**：后配的保留，先配的腾成空串并提示（`resolveEditorHotkeyConflict`，纯函数有单测）；禁用项
  （空串）不占键位、不参与撞键。
- **设置里的显示**：没有自定义的行，按钮里垫显示**生效的默认键位**（`EDITOR_HOTKEY_DEFAULTS`）—— 显示与触发同一张
  表，不会「显示一个键按下去没反应」。`HotkeyField` 那句「点击后直接按组合键即可替换」在网格里关掉（`:hint="false"`，
  改由 title 兜着）—— 18 行各带一句会挤碎版面。键位按钮定宽（168px + nowrap），「恢复默认」那格恒定占位。
- **拦截挂在 NoteEditor 的 `onKeyCapture`**（capture 阶段、keydown 一档 —— keyup 再拦会把同一动作跑两遍）：
  命中表里的组合才 `preventDefault` + `stopPropagation` + `runAction`，**表里没有的一概不拦**（内置键位、Ctrl+S /
  Ctrl+/ 各走各的）。只认带修饰键的组合；输入法组合中（`isComposing`）让路。值由上层传 prop（`editorHotkeys`）——
  与 `imageRepo` 同一条「不读 store」的规矩；独立 Markdown 窗口在 `load()` 里从**首屏快照**取
  （`bootstrapSnapshot().settings.editorHotkeys`）—— 那扇窗不 `initState`，`getSettings()` 返回适配层内存里的
  默认数据，设置里配的自定义键只有 Rust 注入的快照里才有。不跟主窗口实时联动；快照拿不到退回内置键位。
- **标题六档带开关**（`runAction`）：光标已在**同级**标题里时改点工具带上标题那颗**主按钮** —— 它带
  `vditor-menu--current` 态（Vditor 的 `highlightToolbarIR` 维护，判断与这里同用 `closest('h1…h6')`），点它是
  「去掉标题」；不同级照旧切换（点面板里 `data-tag="hN"`）。Ctrl+1 再按取消 H1、Ctrl+2 直接把 H1 换成 H2。

### 只读模式

- **默认开着，Ctrl+/ 切到可写，状态不落盘**（住 NotesView，不进设置）：进笔记页先按「读」来 —— 「看一眼」变成
  「改一处」是这页最容易犯的事（点进代码块、顺手勾框、贴图就推一次 git），默认值放在安全那侧。**不落盘**是因为
  它记的是「这一趟拿它干什么」而不是偏好：某次读着关掉应用、下次打开就写不了。标题行那颗「只读」小片就是落点
  —— 它是一颗**按钮**，点一下切到可写（切过去自己消失）；要回只读仍是 Ctrl+/。两颗入口改同一个 `readOnly`。
- **只挡正文，两处各在自己的地方实现，一处都别漏**：正文（NoteEditor 收 `readOnly`，落到 Vditor 的 `disabled()`，
  打字与工具带动作一起停）、正文格式右键菜单（不弹）。**左栏目录树不归它管**（NoteTree 没有 `readOnly` prop）：
  新建 / 重命名 / 删除 / 拖动都是用户明确点的动作（删除还有确认框），不属于「读时手一抖」；一起锁掉只读就变成
  「连整理都不许」。底部同步 / 素材管理同样不归它管。
- **Vditor 只管「不能写」，不管「还像不像编辑器」** —— 这个模式的坑几乎都在这，五条：
  1. IR 点击 / 按键处理器**不问 `contenteditable`**：点一下 `expandMarker()` 展开成源码样子（代码块围栏与灰底
     原始代码就是这么冒出来的）、点复选框直接改 DOM 再触发 input（**一次真写盘**）、空文档按退格清 `innerHTML`；
     展开态靠 `blur` 收，只读下点不出焦点，样子会一直挂着。**解法是捕获阶段整类拦掉**（`onClick` / `onKeyCapture`：
     只 `stopPropagation`、不 `preventDefault`，浏览器默认动作 —— 滚动、拖选、剪贴板 —— 都留着），别逐条堵。
  2. **`contenteditable="false"` 会把正文从可聚焦元素摘出去**，而它正是滚动容器（`.vditor-reset { overflow: auto }`）：
     点了不给焦点、`Tab` 进不去，PageUp / PageDown / 方向键全没了 —— **「只读之后滚不动了」**。只读下给正文补
     `tabindex="0"`、可写时摘掉（可写时靠 contenteditable 本就在 Tab 序里）。
  3. **禁用态自带样式是「编辑器坏了」的样子**：`opacity: .3; cursor: not-allowed`，要覆盖回 1、光标还 auto；
     空笔记那句「写点什么…」的 placeholder 在这档也错，一并收掉。
  4. **粘贴 / 拖进来的图片不走 `contenteditable`**（Vditor 把 paste / drop 挂元素上，与能否编辑无关），
     `uploadImages` 要自己挡一道 —— 那一下是往用户仓库推一次 git。
  5. **编辑器宿主元素（`.editor`）的 class 归 Vditor 管，别在它身上挂 Vue 的 `:class`**：Vditor 初始化时用 JS 加
     `vditor` 类，只要那层还有 `:class` 绑定，一变 Vue 就把整个 `class` 属性重写，把 `vditor` 抹掉 —— 少了它，
     `.vditor { display: flex; flex-direction: column }` 全失效，正文 `height: 100%` 解析不出来、**涨成内容高度**
     （实测 633px → 1603px），没有溢出（**没有滚动条、滚不动**），而卡片 `overflow: hidden` 把剩下整块裁掉。
     **只读那档的类因此挂在外壳 `.editor-wrap` 上**（选择器一并从那一层起）；这个坑查起来会往滚动上找很久。
- **不管**左栏底部那两颗按钮（同步、素材管理）：它们动的是远端与图片仓库，不是正在读的正文；同步本来就得先把
  编辑器手上的改动交出去，只读下那份是空的。
- 快捷键三条守卫（NotesView 的 `onShortcut`）：只在**笔记页显示着**时接手（KeepAlive 留着这页，不判当前页会在
  别处被按到）、焦点在输入框（起名字弹窗）里让路（**正文那层 contenteditable 不挡** —— 正读着时才最想按）、
  还没选笔记本时不动。认 `event.key` 不认 `event.code`（要的是「打出来是 `/`」，有些布局它在 Shift 那档）。

### 图片（粘贴上传）

- 笔记本里**不放图片文件**，正文只有一条外链，笔记搬到哪台机器 / 用哪个编辑器都成立。落点是**三层**：
  `<images>/<本机设备>/<笔记本>/<文件名>`（第一层是 [note-image.ts](../../packages/notes/src/note-image.ts) 的
  `NOTE_IMAGE_DIR`，不给用户配），后两层由 `imageScopeDir` 现算 —— 上传 / 列清单 / 删图三条通道用同一个算法，
  **别在某处另写路径拼法**（这三层也是素材管理成立的前提）。链路：`uploadImages` → `workbench/note.ts` 的
  `uploadNoteImage` → `sync_images.rs` 的 `publish_image`。
- 七条不能破：
  1. **`upload.handler` 必须配着**：不配 Vditor 会把图片读成 base64 内联进正文，几篇带图就把 `.md` 撑到几兆；
  2. **handler 返回字符串等于报错**，成功必须返回 `null` 并自己 `insertValue`；
  3. **图片仓库地址留空时只是提示**，不退回内联、不发任何请求 —— 这是联网出口之一，必须用户显式开；
  4. **访问地址由 TS 拼**（`imageRawUrl`），Rust 只回「仓库里的路径 + 分支」。GitHub / Gitee / GitLab 三家自动认，
     **其余一律拼不出来**（`url` 是空串）—— 那时**不要**往正文插点不开的地址，如实说明；
  5. **设备标识拿不到、或没打开笔记本时如实报错，不要退回上一层去传** —— 退回等于所有机器、所有笔记本的图混进
     同一层，素材管理的「未引用」立刻变假数字。Rust 只做最后把关（`image_relative_path`：名字带分隔符或 `..`
     就能写到克隆目录外）；
  6. 文件名（`imageFileName`：时间戳 + 随机段）与**整条子目录**都由 TS 算好，Rust 只校验边界；
  7. **`apps/desktop/src/renderer/index.html` 里 `<meta name="referrer" content="no-referrer">` 不能删**：Gitee 的
     `/raw/` 防盗链，请求带 `Referer`（且不是 gitee.com）直接 403，而 WebView 里 `<img>` **一定会带** —— 少了它所有
     Gitee 图都裂：上传成功、地址对、curl 也 200，就是显示不出来。顺手也是隐私改进。
- 克隆目录是数据根目录下的 `image-sync`（安装版 `%APPDATA%/Workbench/image-sync`，开发版
  `%APPDATA%/Workbench-dev/image-sync`），**与用量同步分开两份**。

### 素材管理

左栏底部图片按钮，管的是**「当前笔记本在这台机器上的那一层图片」**：把「那层有哪些图」与「这笔记本谁还在用」
凑起来，清掉没人用的。四条口径：

1. **引用次数是数出来的，不是记下来的**：正文就是磁盘上的 `.md`，别处随时能改，所以「面板一开就重数一遍」
   （缓存只先把上次结果显示出来，**不用于决定删不删**）。数**文件名**的出现次数（同一张图可能是 raw 地址、带
   前缀、相对路径），纯函数在 note-image.ts（`buildImageAssets` / `countImageReferences`）；
2. **清单与引用都只限「这台机器 + 当前笔记本」那一层**（列它、也按它删），所以「未引用」才真等于「这笔记本没人
   用」—— **别把清单扩到上一层**：那列的是别的笔记本 / 机器的图，引用次数拿当前正文根本数不出来，看着能删、
   删了会裂图。还能删错的只剩「地址被手工抄到别处用过」，确认框如实说，这是唯一不可逆处。**没打开笔记本时
   什么都不列**，别退回上一层去猜；
3. **只放行「未引用」**（勾不动的行就是有人用的），删除是**一次提交 + 一次推送**（`delete_images_at`）；
   一张都没删到时不提交空提交；
4. **路径边界一律在 Rust 侧**（`image_repo_path`）：递回的路径必须逐段是普通名字、必须是图片、必须落在**这次传下去
   的那个目录** —— 少最后一条，删图就能删到仓库里别的东西（用量分片、配置文件、别的笔记本的图都在同一仓库）。
   渲染层只负责「哪些被选中了」。

另外：**扫描正文那条通道只回原始文本**（`note_scan_texts`），怎么算「引用了一次」是上面的纯函数；读不出来的笔记
要**计数并如实说**（少读一篇就可能把还在用的图当成没人引用）；缩略图取图片自己的访问地址（与正文显示同一条路，
按行懒加载）。

### 笔记同步

远端**不在设置里**：同步到哪儿就是那个笔记文件夹自己连着的 `origin`（`NoteRepoState`），入口是左栏底部同步按钮，
实现在 `sync.rs` 的 `sync_notes`。与另外两处同步最大的区别是**没有克隆目录**：跑 git 的地方就是笔记文件夹本身 ——
「笔记就是磁盘上那些 `.md`」不变。调用 git 的方式（直启、`GIT_TERMINAL_PROMPT=0`）见 [AGENTS.md](../../AGENTS.md) 第 1 节。

八条不能破：

1. **应用不创建仓库、也不接远端**：不是仓库 / 没有 `origin`，都只如实报一句带解决办法的话（`git init` /
   `git remote add`）—— 发现性落在文档上：「想让笔记同步就先自己 clone 或 `git init` + `remote add origin` 再把
   文件夹选进来」；**没有仓库的笔记就是本机笔记** —— 同步按钮根本不出现，别用「灰着」或「点了报去哪配」提醒；
2. **判定只认「这个文件夹自己有 `.git`」**（`repo_state` 与 `sync_notes` 两道完全一致，别各拍一个）：不放宽成
   「处在某个仓库里」—— `commit_notes` 是 `git add -A` **不带 pathspec**，现代 git 里等于整棵工作树，笔记本夹在
   别人仓库子目录里时一次同步就会把那个仓库一起提交推走。`.git` 是目录或文件都算（worktree / 子模块）；
3. **远端地址不再作为 git 参数出现**：`fetch` / `pull` / `push` 都按名字写死 `origin`，地址只用于显示（提示里写清
   「同步到 <地址>」—— 文件夹里**任何** origin 都会被当成笔记仓库）。所以原来那套地址收敛（`sanitizeNoteRepo`）
   连同 `same_remote` / `local_path_key` 比对**全删了**：别再加回来；
4. **次序固定为「提交本机改动 → pull --rebase → 推」**，提交必须在前：反过来工作区改动会挡住 rebase，还没提交
   的那份在冲突里没有落脚点；
5. **冲突不替用户挑边**：中止这次 rebase（本地那笔留着）、报回冲突文件名 —— 笔记是文字，自动挑边就是悄悄改内容。
   **只在这次是我们起的 rebase 时才 abort**：文件夹里本来就留着半截 rebase / merge 的话那是用户现场，入口直接拒绝；
6. **同步前先让编辑器把手上的那份交出去**（[NotesView.vue](../../apps/desktop/src/renderer/src/components/NotesView.vue)
   的 `editorRef.flushAll()` + `waitForWrites()`），否则提交的是按按钮前的版本；回来**重扫树 + 重读打开着的那篇**
   （远端可能刚改过），换正文由 `reloadFromProps()` 转达 —— 编辑器实例只有上层拿得到；
7. 分支按**这个工作区当前站着的**那个走（用户切过分支别去动）；只有还没提交时才交给 `sync_branch`（跟着远端已有
   分支，都没有才新建 main）；
8. 提交信息是 `notes: <设备名>`；没配过 git 身份时只写**这个仓库的本地配置**兜底（`ensure_commit_identity`），不动
   全局身份。**每个会产生提交的地方都要先走一遍它** —— 技能的自动提交（`skills.rs` 的 `commit`）不经过同步，漏了
   没配全局身份的用户会看到 "Please tell me who you are"。

仓库状态（有没有仓库、`origin`、当前分支）是**探出来的、不落盘**：通道 `note_repo_state`（`repo_state`），在
notes store 里只在「重读这个文件夹」几处与每次同步后探一次（`probeRepo`）。它只决定界面给不给入口、写哪句提示，
探不出来按「本机笔记」处理，不是错误。**`branch` 是给 AI 助手页用的**（说清在哪个分支干活，见 [ai.md](ai.md)）：
读 `symbolic-ref --short HEAD`，**不是** `rev-parse --abbrev-ref HEAD`（后者在还没提交的仓库里回 `HEAD`，看着像
分支名就叫 HEAD）；分离头指针 / 不是仓库时是空串。笔记与知识库那两页不看它。

### 独立编辑窗口（资源管理器「打开方式」）

笔记页之外还有一扇**只装一块工作台面板**的窗口（第六个 HTML 入口 `markdown.html`，Rust 在 `md_window.rs`）：
安装后右击 `.md` / `.markdown` →「打开方式」→ Workbench 直接编辑那一个文件。它与笔记页共用 `notes.rs` 的读 / 写
与 mtime 冲突保护，但没有笔记本、目录树、导航栏；面板有标题栏、正文、大纲栏与底栏。

- **文件关联由安装器登记**：`tauri.conf.json` 的 `bundle.fileAssociations`（`.md` / `.markdown`）。NSIS 会把这两个
  后缀的**默认打开程序**改成 Workbench（卸载恢复备份值）—— 明知取舍。开发模式不登记；改完要重构建安装包才生效。
- **一个文件一扇窗**（label `markdown-<uuid>`）：同一路径再次打开只聚焦已有窗口，不同文件各开一扇。启动参数里有 md
  文件时主窗口照建但**不显示**（托盘与后台服务照旧）；关掉编辑窗口后应用留托盘。
- **无边框**：`decorations(false)`，系统标题栏不画 —— 最小化 / 最大化 / 关闭三颗键由渲染层自绘在标题栏右端（规格照
  `TitleBar.vue` 的手画 SVG，但那份引着 store；这扇窗不装 store，图标照抄不引）；标题栏与底栏都标
  `data-tauri-drag-region`（双击最大化 / 还原由 Tauri 注入脚本接管，组件里**不要**再写 `@dblclick` 自己 toggle）。
  拖动要 capabilities 放行：`markdown-window.json` 的 `core:window:allow-start-dragging`（`core:default` 不含它，
  被 ACL 拦下静默失效）。最大化状态由 Rust 推（`Resized` 里比对后发 `markdown-window:state-changed`，用**这扇窗
  自己的**上次观测值 —— 全局 `MaximizedFlag` 是主窗口的，共用会互相顶掉），渲染层经 `onMarkdownWindowState` 订阅、
  `markdownWindowIsMaximized` 问初值；最小化 / 最大化复用 `window_minimize` / `window_toggle_maximize`，关闭走
  `markdown_window_close`（防抖那份由输入路径交出去，见下「关闭是握手」）。
- **路径只从 Rust 会话取**：`markdown_window_context` / `markdown_window_save` 按窗口 label 查会话，不接受渲染层传
  路径 —— 这扇窗没法读写它被打开的文件以外的任何东西；读写走 `notes::read` / `notes::write`，冲突规则与笔记页一致。
- **独立入口只装适配层、不装 store、不 initState**：正文与保存状态由 `markdown-window/` 自己持有；装 store 会与主
  窗口抢写同一批数据文件（与 video / pin / ball 同一条规矩）。`NoteEditor` 为此把图片仓库与「允不允许上传图片」
  改成 props（笔记页传仓库地址，独立窗口传 `allowImageUpload=false`）—— 独立窗口没有「笔记本」这一层，粘贴图片会
  推到图片仓库里一个临时层级，不是期待的动作。
- **铺满整窗**：窗口里只有一块 `.md-panel`（`--bg-surface`），**贴到窗口四边** —— 不留那圈画布底色，
  也不画外边框 / 圆角 / 卡片阴影（那会让它像浮着的一张纸）；层次只靠标题栏与底栏那两条发丝线。标题栏 52px、
  底栏 34px，加载与打开失败也落在这块面板里。标题栏左边是文件图标与文件名（`Markdown` 副行已删），
  右端三颗自绘窗口键。
- **底栏保存状态**：`保存中…`（队列里还有笔数）→ `已保存 · MM-DD HH:mm`（`savedAt`，读盘与每次落盘后更新）；失败
  切 `保存失败`（`--st-fail`）。状态只展示，写盘仍走串行队列。
- **底栏**：最左是大纲开关（无边框改版后从标题栏挪下来），接着保存状态（失败改显原因与「重试」）；右端是「N 字」
  （**非空白字符数，含 markdown 记号** —— 正文本身，不是渲染结果）+ `Markdown`。整条标拖动区（按钮自己不拖）。
- **左侧大纲**：目录与正文两列（`.md-body`），左栏 `.md-rail` **默认 320px、可拖**（这扇窗不接主题、不写
  theme.json；宽度只活在本次窗口，关窗回 320。区间沿用 `noteRailWidth` 的 160–420，见 `clampWidth('noteRailWidth', …)`）。
  拖右缘高热区改宽，拖动挂 `body.is-resizing-md-rail`（这扇窗没引 global.css，光标与选择由 markdown.html 的内联
  样式兜住）；热区落在栏右内边距里、是栏的子元素，静止只露正中小竖条。笔记页那条宽度是 theme.json 的
  `noteRailWidth`，两边互不影响。条目底子与笔记页 `.notes__rail` 同一套（各自 scoped，**改条目样式要两边一起改**：
  27px 行片、缩进、悬停底、箭头规格一致）。条目**整行收展**与笔记页共用 `use-outline-row-toggle`（挂 `.md-rail`
  上；**显隐走 CSSOM**，这扇窗的 CSP nonce 会丢行内 style）。`NoteEditor` 传 `outlineHost` + `outlinePinned`：
  初始化后把大纲元素搬进左栏并直接打开；钉死这档右键菜单不再给「大纲」（`NoteContextMenu` 的 `hidden`），否则能从
  菜单关成一条空栏。**底栏开关做宽度过渡**（`.md-body.is-rail-closed` 把宽度 / 左右内边距 / 不透明度一起归零，
  0.2s `--ease-out`；栏始终留 DOM，不碰 Vditor 大纲），**箭头同时转 180°**；系统开「减少动态效果」时都直接跳。
  窄窗口（< 820px）打开时默认收起。**栏宽不跟正文抢**。
- **正文滚动条**：原生条收掉，由共享 `OverlayScrollbar` 画。这扇窗没引 global.css，原生条本是 WebView2 带箭头
  那副，一并盖掉。正文排版单独松一档（15.5px / 1.8、单行约 1200px、左右内边距居中），只在 `MarkdownWindowApp`
  的 scoped 样式里，笔记页不受影响。
- **关闭是握手**：Rust 先 `prevent_close` 并推 `markdown-window:flush`，渲染层先回 `markdown_window_cancel_close`
  撤掉兜底计时，再把防抖那份交出去、等保存落地，最后 `markdown_window_close` 销毁；保存失败问「仍然关闭 / 留在窗口」。
  收不到回执时 10 秒兜底销毁，防止永远关不掉。
- **正文顶上不许再出现一块白**：`markdown.html` 那段内联 `<style>` 会让生产态 Tauri 给 `style-src` 加 nonce
  （nonce 在场 `'unsafe-inline'` 就失效，源码行内 `style` 属性全被丢弃），而 Vditor 的图标 sprite 是
  `insertAdjacentHTML` 到 `body` 最前、靠行内样式缩成 0×0 —— 样式被丢后按 SVG 默认尺寸占成 300×150，把整扇窗往下
  顶 153px。所以那段 `<style>` 里有 `body > svg { position: absolute;
  width: 0; height: 0; overflow: hidden }` 补回尺寸；**别删它**，也别在五个有内联 `<style>` 的入口
  （markdown / video / capture / pin / ball）里改用行内 style 属性（见 [ipc-and-state.md](ipc-and-state.md) 的 CSP 一条）。
- 已知取舍：独立窗口不上传图片、打开后不跟随主窗口实时换主题、正文里的相对链接不支持跳转（只编辑当前文件，点了
  如实提示）。

## 实现

- **笔记本就是本机的一个文件夹**（第一次进这页必须先选它）：目录树就是文件夹本来的结构，正文就是里面的 `.md` ——
  拿 VSCode / Typora 直接改那些文件也成立，切回应用（窗口重新获得焦点）或点刷新就是最新的。没选文件夹前整页只有
  一句引导与「选择文件夹」。数据模型见「数据模型」。
- 一页两栏：左目录树、右 **Vditor**（即时渲染，正文存 markdown 原文，数据不依赖编辑器）。两栏缝可拖
  （`noteTreeWidth`，只改本地、松手落盘；把手平时不显示、指针落上才露）。右栏常显大纲（宽度可拖）。左栏底部一行是
  「这个笔记本是谁」：目录名、篇数、刷新 / 换文件夹 / 素材管理。**最近打开**（`noteDirs`，最多 6 条）是**点开才弹的
  浮层**（与左栏菜单区等宽、左缘对齐）—— 不做成常显：左栏本来就窄，几天也不换一次。点一条换过去（换过的排最前、
  当前加粗点不动），右边删除叉只删历史、不关浮层。**再点一次目录名就收起**：那个弹层不用 `el-popover` 的 click
  触发 —— 它的「点外面关闭」在 window 捕获阶段先关、按钮 click 再开，一抵消就永远关不上（`RecentRoots` 里按钮自己
  切换），浮层也不带箭头。
- 树里**没有「根行」**（顶层直接铺开），空文件夹换成空态 + 新建两颗按钮。**文件夹排在文件前**、同层按名字排
  （`numeric`，`笔记 10` 在 `笔记 9` 后）—— 顺序算出来，所以没有「插到某项前面」的拖动。忽略名单见「左栏目录树」。
- **拖动只认「文件拖进文件夹」与「拖到树下面空白区」（移回最外层）**：文件夹不可拖，落在文件上 / 原处都不放行。
  松手后真挪磁盘，**失败重扫** —— `el-tree` 松手时已挪过自己那份数据，不重扫左栏显示的就是不存在的位置。
- 树的增删改都在**右键菜单**：节点行是新建笔记 / 新建文件夹 / 重命名 / 删除（整行都算），另加三项**读**的动作 ——
  在资源管理器中显示、复制路径（绝对路径，`noteAbsPath` 按笔记本根拼）、用默认程序打开（只对笔记）。菜单**贴指针
  落点**出现（`NoteTreeMenu`，与笔记正文 / 邮件行 / 视频行共用 `use-floating-position` / `use-floating-dismiss`）——
  `el-dropdown` 的 contextmenu 触发器锚在整行上、右击行尾会弹回行首，**不要再用它**；**同一时刻只有一份**，右击
  另一行直接换落点。空白区是新建两项 + 刷新列表 + 在资源管理器中打开笔记本，新建一律落笔记本根。名字上限 60 字，
  非法字符与系统保留名在弹窗当场说清（`noteNameProblem`）；**新建撞名自动退格**（`新建笔记 2`），重命名不退让。
  弹窗新建与重命名共用，聚焦与全选挂在 `@opened` 之后（写在 `watch` 里等完 `nextTick` 输入框还没进 DOM —— 踩过，
  表现成「弹窗出来、光标不在框里」）。
- **「在资源管理器中显示」用系统能力 `reveal`，不是笔记通道**：笔记命令只认相对路径，这里先用 `noteAbsPath` 拼绝对
  路径再交出去；文件会被选中、文件夹直接进去。那条路径只由扫出来的树喂进去，不必在 TS 侧再挡越界。
- **新建一篇笔记就是首页活跃度的一笔**（来源 `note`，记在 `createNote` 里、命令成功之后）。**建文件夹不算**
  （整理不是产出），**保存正文也不按次算** —— 编辑器防抖自动保存，一下午能写几百次盘（见 `SAVE_DELAY`），按它计数
  会把这一天顶成全图最亮（见 [home.md](home.md)）。
- **删文件夹带走整棵子树**，确认框写明「里面还有几项」；删掉的是当前打开那篇时右栏一并收起（否则下次自动保存会
  顺旧路径把它重建出来）。
- **选中与打开是同一件事**：点文件夹是选中（右栏说一句「这是个文件夹」），点笔记才是打开来写；选中项所在几层自动
  展开（`default-expanded-keys` 每次重建按清单恢复，清单**只放祖先不放选中项**）。展开态清单见「左栏目录树」。
  `el-tree` 两处脾气（`auto-expand-parent` 顶回展开态、名字栏那层 `.node` 必须 `min-width: 0` 且 `flex: 1` 盖住
  整行余宽 —— 否则长名字溢出、树横向错位，右键也接不住行尾）见
  [`NoteTree.vue`](../../apps/desktop/src/renderer/src/components/NoteTree.vue) 顶部注释与样式。
- 右栏标题行：左边名字 + 所在几层文件夹（面包屑，最外层无上一级就不显示），右边保存状态（「已保存 · 最后修改
  时间」，写盘失败换原因）。正文按 **600ms 防抖**落盘（先写同目录临时文件再改名，断电不留半篇），切笔记 / 离开
  先冲刷；换篇交出去的正文带它属于哪一篇的路径，上层把树交给后端重扫结果 —— 改名 / 拖动后靠后端回来的新路径接着
  认（`remapActive`）。**写盘带版本**：每笔交回读盘 / 上次落盘的 mtime，别处改过的那篇被 Rust 拒绝；打开着的那篇
  在窗口重获焦点、点刷新时重读（见「外部修改与写盘冲突」）。
- 正文链接被组件接管，**只有按住 Ctrl 才打开**（Typora 那套；普通点击什么都不做）：外部地址走系统浏览器，指向本
  笔记本另一篇的相对链接就地跳（与左栏点一下同一条路：自动展开、滚进视野）。跳转路径按这篇所在文件夹解析（`../`、
  `/别的.md`、百分号编码都认，`#小节` / `?x` 切掉）；树上没有时**先重扫再看**，还没有就说「找不到这篇笔记」。能跳的
  只有 `.md` / `.markdown`，图片 / 附件 / 锚点说一句「跳不过去」，不静默。三处 Vditor 脾气（IR 链接不是 `<a>`、
  `link.isOpen` 必须关、Ctrl 隐形所以 placeholder 写了一句）见「正文编辑器」。
- **只读模式**（**默认开着**，点标题行「只读」按钮或 Ctrl+/ 切可写）只收**正文**写入口：正文不可编辑、格式菜单
  不弹。不落盘，也不管左栏（增删改拖照常、同步与素材管理照常）—— 那些是明确操作。**要点不是「关掉编辑」，而是
  别让它看着还能编辑**：点击与按键在**捕获阶段**拦在 Vditor 之外，正文另补 `tabindex` 让键盘照常滚。四条坑与
  解法见「只读模式」。**Vditor 初始化是异步的**，所以只读那档不只挂 watch：初始化完成那一刻由 options 的 `after`
  回调再核一遍（编辑器可能是「已切到只读之后」才建起来的）。
- **编辑器动作全部挪到正文右键菜单**，工具带 CSS 藏起来（元素还在）：菜单三排图标 + 两行带子菜单（段落 / 插入），
  共 17 项 —— 正好是工具带全部动作；光标在表格单元格时再多一排（见下条）。位置贴指针、不越出窗口，右边放不下子
  菜单整份翻左；点别处 / Esc / 滚轮 / 窗口变化收起。**菜单自己不实现编辑动作**：每项按名字点工具带对应按钮
  （动作名必须与 `TOOLBAR` 对得上，点不到只在控制台告警）。菜单 Teleport 到 body，按下时 `preventDefault` 掉
  mousedown —— 否则焦点挪走、**选区没了**。
- **表格行列增删在右键菜单第四排**（光标在单元格里右键才出现）：下方 / 上方插行、右侧 / 左侧插列、删行、删列六项。
  Vditor 4 的表格工具条**只挂 wysiwyg**，IR 模式没有，行列操作平时只能按它自己那组快捷键（Ctrl+= / Ctrl+Shift+F /
  Ctrl+Shift+= / Ctrl+Shift+G / Ctrl+- / Ctrl+Shift+-，菜单提示里带着）。菜单这排**不点工具带** —— 工具带没有对应
  按钮 —— 而是 NoteEditor 合成一次按键派发到 IR 元素（`runTableAction`），让 Vditor 自己的表格处理器干活（渲染 /
  光标 / 撤销栈都归它）；两个坑：匹配器在非 Mac 上把带 Shift 的 `=` / `-` 改写成 `+` / `_` 后才比 `event.key`
  （合成事件得给改写后的键），事件必须 `bubbles: true`（监听器在 IR 元素上）。动作名带 `table:` 前缀经 `execTable`
  分流，与工具带动作用同一条 `act` 事件。
- **粘贴的图片推到用户自己的 git 仓库**（不放进笔记本目录）：正文留一条
  `![图片](https://…/images/<设备>/<笔记本>/20260916-104512-ab12cd34.png)` 外链，笔记文件始终很小。一次上传一次
  `pull → 写文件 → commit → push`（与 Token 同步同一套机制、另一套地址与克隆目录）；文件名 = 时间戳 + 随机段（按名
  排即按时间排，同秒多贴不覆盖）。三层落点里，笔记本那段是「目录名小写 + 整个路径的摘要」（如 `笔记-3f2a91c4`）——
  `D:\a\笔记` 与 `E:\b\笔记` 不会落进同一层，这是素材管理「只看得见自己那份」的前提；其余（七条不能破、
  `no-referrer`、访问地址只认 GitHub / Gitee / GitLab）见「图片」与[「数据与隐私」](../features-and-architecture.md)。
  上传期间编辑器右下角挂 loading 角标（贴多张带张数）—— 一次上传一次 `git push`，几秒里正文什么都不出现，没提示
  就像按下去没反应。
- **素材管理**（左栏底部图片按钮）回答「我能安全删掉哪些图」：列表来自仓库那一层、引用次数来自当前笔记本正文，两边
  凑起来才知道哪张没人用。面板一行一张：缩略图（点开在浏览器看原图）、文件名、大小、被引用次数；**未引用排最前**
  带红字，有人用的行**勾不动**；底部「全选未引用 / 清空选择 / 删除 N 张」，删除前确认，按下去**一次提交 + 一次
  推送**（删图也要进历史，不然别处克隆出去那份还会把图带回来）。缩略图按行懒加载；拼不出访问地址的仓库显示占位
  图标，不是裂图。历史包袱：改版前平铺在 `<images>/` 的图不在任何一层里，不进素材管理，只能去仓库手工删。
- **笔记可以整体同步到你自己的 git 仓库**（**地址不在设置里**：就是笔记本文件夹自己连着的 `origin`，没仓库连按钮
  都不出现）。左栏底部那颗按钮把当前笔记本与远端对齐一次；与另外两处同步最大的区别是**没有克隆目录** —— 跑 git 的
  地方就是笔记本文件夹本身，换台机器 clone 下来还是同一份。应用不 `git init`、不接远端；判定、次序、冲突、身份
  兜底八条见「笔记同步」。按钮提示写着**这次会同步到哪个地址**（任何 `origin` 都会被当成笔记仓库，推之前你得知道
  是哪儿）；每条 git 命令都带 `-c core.quotepath=false`（中文冲突文件名才报得成人话，见 [sync-and-auth.md](sync-and-auth.md)）。
- **Vditor 静态资源随包带一份**：图标 / 语言包 / lute / 内容主题 / 表情 / 代码高亮**运行时**按 `options.cdn` 取（默认
  unpkg），所以 `cdn` 指向本地 `public/vditor/`，内容由 `scripts/sync-vditor-assets.mjs` 在 dev / build 前从
  `node_modules/vditor/dist` 复制（只带用得着的子集约 4.8MB；整包 20MB 其余是 katex / mermaid / echarts 等用不到的）。
  复制挂在 vite 的 `configResolved` 上，dev 与 build 都绕不过；版本没变就跳过。

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
