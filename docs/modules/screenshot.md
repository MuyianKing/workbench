# 截图与钉图（capture）

截图（框选、标注、复制 / 保存 / 钉到屏幕上）的文档：先读「约束」一节（不能破的规矩）；
「实现」一节装为什么这么做、踩过哪些坑。跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`packages/capture/src/`（选区几何 / 把手 / 标注模型 / 撤销栈 / 放大镜取样 / 坐标换算 /
文件名，全部带单测）、`apps/desktop/src-tauri/src/{capture,screen,clipboard,pin}.rs`、
`workbench/index.ts` 里那一段通道、三个 HTML 入口（`index.html` / `capture.html` / `pin.html`）、
`components/settings/CapturePane.vue`。

- **抓屏只能在 Rust 侧做**：WebView2 没有 `getDisplayMedia`，webview 里拿不到屏幕像素。
  实现走 `screen.rs` 的 `BitBlt` + `GetDIBits`（**已在编译图里的 `Win32_Graphics_Gdi`**，
  一个 feature 都不用加、不引 `xcap` 之类的截图库）。**已知边界，不是 bug**：独占全屏的 D3D 画面
  抓出来是黑的、HDR 屏按 SDR 映射、UAC 安全桌面与 DRM 内容抓不到。要越过这三条得改走
  Windows.Graphics.Capture（D3D11 帧池那套），是另一摊活。
- **一块屏一个遮罩窗口**（label `capture-<代号>-<序号>`），**不做一个横跨虚拟桌面的窗口**：WebView 的缩放
  因子按所在显示器定，横跨两块不同 DPI 的窗口只能有一个缩放，另一半画面就是错的。
  代价是**选区不跨屏**（拖到屏幕边缘就停住）—— 有意接受的，不是漏掉的。
- **遮罩窗口是预建、跨场复用的（池子），收工只藏不关**：按热键到看见遮罩要压到两百毫秒级，
  而**建一块 WebView2 窗口本身就比这个预算还贵**，所以窗口由 `capture_prewarm` 提前建好藏在屏幕外，
  每场截图只是「塞帧 → 摆位置 → 显示」。新的一场由 Rust 推 `capture:sync` 通知窗口里的 JS
  （光显示它不会让 JS 重新开场）。**显示要等每一块屏都报「画好了」**（`capture_show` + 一秒看门狗）——
  抢在那一帧前面显示就是先闪一块黑。代价是**每块屏常驻一块 webview**，关掉截图功能时由
  `capture_prewarm(false)` 把池子收掉。别改回「一场一建一关」，也别改回「先显示再等画面」。
  **显示与收起都不带过渡**：窗口建出来就压一遍 `DwmSetWindowAttribute(DWMWA_TRANSITIONS_FORCEDISABLED)`
  （建窗口时一次、每次显示前再一次，见 `disable_transitions`）—— 不压的话 Windows 会给「隐藏」
  补一段约 150~200ms 的淡出，收工那一下看着就是画面在渐渐变没（实测过帧）。
- **窗口的位置与尺寸一律按物理像素给**（`set_position(PhysicalPosition)` / `set_size(PhysicalSize)`）：
  builder 上的 `position` / `inner_size` 是逻辑坐标，混合 DPI 下用它正好错位。
- **遮罩与钉图是独立入口，只装适配层，不装 store、不 initState**：它们是各自的 JS 上下文，
  装主界面那套 store 就会与主窗口**抢着读 / 写同一批 JSON**（`workbench-data.json` 等）。
  它们要的设置由 Rust 随 `capture_context` 一起给（见 capture.rs 的 `CaptureOptions`）。
- **帧与最终图都走 base64**（`capture_frame` / `capture_copy` / `capture_save` / `pin_create`），
  与邮箱附件、笔记图片同一条路（IPC 只走 JSON，二进制要编一手），别为此去引 `ipc::Response`
  的原始字节。
  **帧为什么不走 asset 协议（而钉图可以）**：遮罩窗口要把这一帧画到画布上，还要 `getImageData`
  （放大镜取色、马赛克）与 `toBlob`（复制 / 保存 / 钉图）；asset 协议对页面来说是**跨源**的，
  把它的图 `drawImage` 进画布会把画布**污染**掉 —— 那两个调用都会抛 SecurityError，整条导出链就废了
  （这不是纸上推演：冒烟验证时先按 asset 走的，症状是「选区怎么拖都出不来」—— `getImageData` 抛在
  `onPointerMove` 的最前面，把整个拖拽打断了）。代价是每帧多一次 base64 往返（几兆的 PNG，几十毫秒），
  换来的是这几条路都能走。钉图窗口只把图摆出来、从不读像素，所以它照旧走 asset（便宜、也不用编字符串）。
- **系统剪贴板自己写 Win32**（`clipboard.rs`）：一次给齐 **CF_DIBV5 + CF_DIB + 注册格式 `PNG`**。
  不走 `navigator.clipboard` —— WebView2 那条要 `CoreWebView2` 的权限回调放行（wry 没暴露，
  失败还是静默的），而且它只写 PNG 一种格式，认 CF_DIB 的老程序粘出来是空的。
  新增的 feature 只有 `Win32_System_DataExchange` 与 `Win32_System_Memory`。
- **两条全局快捷键一次性装齐，而且值由渲染层推**（`apply_hotkeys(main, capture)`，
  Rust 自己不读设置）：插件注册是「先全清再逐条注册」，分几次调会互相注销，所以只有 `main.rs` 的
  `register_hotkeys` 一处动手。**值也必须由渲染层给** —— 默认值只活在 `@workbench/capture` 里，
  Rust 去数据文件里读会漏掉「刚加上的字段还没被写回盘」那一段：首启按截图键没反应，
  而且之后再也不会补注册（踩过一次，就是照着盘读的写法）。旧的 `set_hotkey` / 不带参数的
  `apply_hotkeys()` 都已删。
- **注册失败必须说出来**：`RegisterHotKey` 是全局独占的，某条键被别的程序占着时它压根挂不上
  （F1 就常被占 —— 输入法、录屏、游戏助手那一类）。界面上看着「设过了」、按下去没反应是最难查的
  那一种，所以启动时那一次失败会走 `notifyWarning` 说一句，设置·截图那一屏也会把 Rust 的原文
  （「这些快捷键被别的程序占用了：截图（F1）」）如实报出来。
- **标注一律按「这块屏的物理像素绝对坐标」存与画，两侧都在整帧尺寸的画布上画、共用同一个
  `drawAnnotations`**：显示侧就是那块 stage（**只 clip 住选区，不平移**），导出侧先在同样大的
  画布上画完、最后才把选区抠出来。三条踩过的坑：显示侧多平移一次就是多减一个选区原点，笔迹会整体
  偏向左上、被裁掉大半甚至完全看不见；导出侧图省事只在「选区那么大」的画布上画，画布尺寸与原点的
  小数部分一变，马赛克的块色就差几个点、普通标注的抗锯齿也差一点；马赛克的格子必须落在**绝对坐标**
  的网格上，两侧各自按自己的原点对齐会错半格。这几条做到了，看到什么就存下来什么。
- **本功能没有任何新的联网出口**：抓屏、标注、剪贴板、落盘、钉图全在本机。所以「取字 / OCR」
  **不在这一版**（云 OCR 会多出一条出口，见 features-and-architecture 的「数据与隐私」；
  它要做也只能是本机模型，那是另一件大事）。
- **数据落点**：截图的每一帧**只在内存里**（见上面那条，不落盘、也没有临时目录要收拾，进程没了就没了）；
  钉图的图在 `%APPDATA%\Workbench\data\pins\<id>.png`、记账在 `data\pins.json`（进 JsonStore 防抖落盘，
  退出前 `flush_all` 一起写）。都没进同步仓库。
- **设置项住数据文件、不进外观同步**（都是「这台机器」的事）：`captureEnabled` / `captureHotkey` /
  `captureSaveDir` / `capturePinOpacity` / `captureMagnifier`（开着时放大镜读数按 Shift 进剪贴板）。
  默认 F1 起截图
  （**F1 很常见地被别的程序占着**，装完先按一下试，没反应就换成别的键）。
- **capability 单独一份**（`capabilities/capture.json`，覆盖 `capture-*` 与 `pin-*`）：只给
  `core:default` + `core:window:allow-start-dragging`（钉图整张标了 `data-tauri-drag-region`，
  被 ACL 拦下是**静默失效**：拖不动，也不报错）+ `dialog:default`（「另存为」）。
  窗口的位置 / 尺寸 / 置顶都由 Rust 设，前端一条都不碰，那几项权限一个都不给。

## 实现

**一次截图的完整走法**（`capture.rs`）：

1. 热键 / 托盘 / 设置里的按钮 → `capture::request`（**丢工作线程**：抓屏加 PNG 编码在多屏上是
   几百毫秒的活，而热键回调与托盘菜单事件都在主线程派发）；
2. `start` 先确认遮罩窗口的池子对得上当前这几块屏 —— 对得上就**一块窗口都不建**（见下一节）；
3. 再逐屏 BitBlt 抓图、编成 PNG 字节留在内存里；**顺序不能反**（窗口一显示就会被拍进去）；
4. 帧进状态之后给每一块遮罩推一条 `capture:sync`（带上这一场的编号）—— 窗口是复用的，
   光显示它不会让里面的 JS 知道又开了一场。**到这里还不显示**（见下一节）；
5. 遮罩里的 JS 收到 `capture:sync` 就取上下文、取帧、画到画布上，画完调 `capture_show` 把编号送回来；
6. Rust 收到**每一块屏**的 `capture_show` 才摆位置、显示出来，焦点给**光标所在的那块屏**
   （Esc / Enter / Ctrl+Z 只有拿到焦点的窗口收得到）。一秒的看门狗兜底（见下）；
7. 做完动作（复制 / 保存 / 钉图）或取消 → `capture_abort`：把遮罩**藏起来**（窗口留着复用）、
   丢掉这场会话的帧，再推一条**不带编号**的 `capture:sync` —— 那一条的意思就是
   「把上一场的帧、选区与标注清掉」。没有落盘的东西，也就没有清不干净的风险。

**为什么要养一池遮罩窗口（预建 + 复用）**：

「按下热键到看见遮罩」要压到两百毫秒级，靠的就只有这一条：**建一块 WebView2 窗口本身就比
整个预算还贵**（要起 webview、加载 JS 包、跑起 Vue）。所以窗口在 `capture_prewarm`
（渲染层载入设置之后调一次，见 workbench/index.ts 的 `syncSystemIntegration`）里就建好、藏在屏幕外，
之后每场截图只是「塞帧 → 摆位置 → 显示」。五条边界：

- **每块屏常驻一块 webview**（有意换来的，不是漏掉的）；设置里关掉截图会经 `capture_prewarm(false)` 收掉池子；
- 屏幕数变了（插拔显示器）池子就对不上，那就**整批重建**：旧的一代先 `close()`（异步的，还在
  事件队列里没销毁），新的一代换个**代号**（`capture-<代号>-<序号>`），免得新窗口顶着同一个标签建不出来
  （`capabilities/capture.json` 那条 `capture-*` 通配盖得住新旧两种标签）；
- **收工只 `hide()` 不 `close()`**：藏起来的窗口不进合成，既不会被下一场抓进去，也不占屏幕；
- **显示要等每一块屏都报「画好了」**（`capture_show`）。抢在那一帧前面显示，用户看到的就是
  「先闪一块黑、再出画面」—— 那一帧要走 IPC 过来（几兆、几十毫秒），慢不过它。
  一秒的看门狗兜底：窗口里的 JS 万一没起来，到点也照亮，不能「按一下什么都没发生」；
  编号对不上的一律忽略（上一场那半截不该把这一场提前亮出来）；
- 窗口里的 JS **一场只跑一次**：新的一场靠 `capture:sync` 叫醒（订阅要先于「补问一次当前有没有会话」，
  否则会漏掉中间那一条 —— 见 bridge.ts 的 `listenReady`），`reset()` 掉上一场的帧、选区与标注。
  送回去的那个编号取自 `captureContext` 的 `session`，不是事件载荷 —— 起手补问那一次没收到过事件。

**为什么藏着的窗口一显示就有画面**：`hide()` / `show()` 走的是 `ShowWindow`，**页面那边
`document.visibilityState` 一直是 `visible`**（实测：藏着的窗口 rAF 照跑 60 帧/秒）——
也就是说它一直在往自己的表面上画，显示出来的就是已经画好的那一帧，不会先白/黑一下。

**这条路上每一笔开销**（1080p 单屏、release 构建、用 CDP 驱动着量，见「验证」一节。
量这一场时屏幕上正好是 4.28MB 的帧 —— 照片 / 文字密的那种画面，PNG 压不动）：

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| 复用遮罩窗口 | ~1ms | 池子命中时只有一次查找。**一场一建的话，光 `build()` 返回就要 124~155ms**，之后还得等那一屏的 JS 包加载、Vue 起来 |
| BitBlt + GetDIBits + BGRA→RGBA | ~40ms | 都是系统调用；换通道那一趟按 DWORD 走（见 screen.rs）。`CreateDIBSection` 那条路量过，没有更快 |
| PNG 编码 | ~36ms | `Fast` + `Sub`；换成默认的「自适应滤波」同屏要 166ms（多屏成倍） |
| base64 编码 | ~2ms | |
| 取帧（base64 走 IPC） | 75~81ms | 4.28MB 的 PNG 编成 5.7MB 字符串，**约 13ms/MB** —— 按字节线性涨，帧一大它跟着涨 |
| `fetch` 解 data: URL | 1~2ms | 交给浏览器原生解，不是 JS 逐字节搬 |
| `createImageBitmap` 解 PNG | ~26ms | |
| 重画到画布 | ~30ms | 取样画布挪到「第一次取色时」做了，不在这一笔里 |
| **合计（按下 → 遮罩出现）** | **248~276ms** | Rust 侧 ~80ms、IPC 那一段 ~80ms、剩下 ~100ms 在遮罩窗口里。**遮罩就是在这时候出现的**（画布上已经有画面，见上面那条），不是提前出现再等画面 |

三件事值得记住：**建窗口那一笔是热身省掉的**（也是它最值钱）；**取帧那一段是内容相关的**
（这张屏的帧 4.28MB 就是这么来的，画面干净时它小得多，整串跟着小）；
**dev 下要多几百毫秒**，那是没优化的 Rust 代码在前面三笔上多花的 —— PNG 编码首当其冲，
已经在 Cargo.toml 里给 `image` / `png` / `flate2` / `fdeflate` / `miniz_oxide` 开了 `opt-level = 3`
（同屏 295ms → 158ms）。

**坐标有三层**（写清楚免得混，口径在 `packages/capture/src/coords.ts` 的文件头）：
虚拟桌面物理坐标（Rust 摆窗口、钉图定位用）→ 画布像素（某块屏自己的物理像素，与那帧 PNG 一一对应）
→ 视口 CSS 像素（鼠标事件）。**鼠标事件一律经 `viewportToCanvas` 换算**，不自己乘
`devicePixelRatio` —— 那个值跨屏拖动时会变，而画布的 CSS 尺寸与 backing store 的比值才是真正
决定「鼠标落在哪个像素格子」的那个比值。

**遮罩的渲染分两块画布**：可见的 `stage`（画法是「冻结的一帧 → 标注 → 选区外的暗层 → 选区与把手
→ 十字线」，每次变化整块重画：一次 `drawImage` 加几十条路径，4K 也是毫秒级；**暗层排在标注之后**
不是随手写的：标注本来就裁在选区里、先后看不出来，但马赛克是从这块画布读像素取平均的，暗层先画
进去会让贴着选区边打码的那几格把暗色平均进来，而导出侧没有暗层 —— 于是两边对不上），外加一块
不进 DOM 的 `sampler`（只有那帧原图的干净副本）。**像素读数必须从 sampler 取**，从 stage 上取会
取到暗层、颜色就不对了。**「取色」的出口是 Shift**：读数卡是画在遮罩上的文本（遮罩整页
`user-select: none`，选不中也拿不走），按一下 Shift 把当前十六进制写进剪贴板、并在读数卡上回一句
**随后直接收工**（取色是一次性的：不用再按一次 Esc；失败才留在遮罩里，并在卡上说一句「复制失败」）
—— 遮罩窗口里 `navigator.clipboard` 是通的（实测：发一个系统级 Shift 之后，剪贴板里就是卡上那个
色值，遮罩同时收起）。只在放大镜露着的时候认：有选区时它已经让开了，那会儿的 Shift+方向键是
「步进十格」，不该顺手往剪贴板里塞东西。
sampler 是**现用现做**的（第一次取色时才画）—— 那一趟是把整帧再画一遍，属于「鼠标动起来之后」
才用得上的东西，不该挡在开场那一下上。
马赛克：**别用 `getImageData` + 逐像素循环取平均** —— 那要先从 GPU 把像素读回 CPU，实测一块
750×500 每帧 5~7ms，区域一大就是卡顿（而且要 catch 画布被污染）。做法是把「整格对齐的那一块」
**缩到一格一个像素、再按原尺寸放大铺回去**，平均交给浏览器的缩放做：缩小时
`imageSmoothingQuality` **必须给 high**（默认的 low 在大比例缩小时只采几个像素，等于抽点，
白底上的字会变成零星小色块），放大时关掉插值；scratch 画布复用一块，别每帧新建。
**格子一律对齐到原图的绝对网格**（两侧画布都是整帧，`origin` 就是 0），**画出来的范围只用 clip
收在用户拖的那块矩形里** —— 不然网格往外扩出来的那几格会让拖的时候四条边一格一格地跳。
它读到的是「原图 + 先画的那几条标注」（stage 与导出画布同源）。

**选区与标注的手感**照 Snipaste：拖出来建选区、八个把手（角优先、命中取最近的那个、拖过对边可翻转）、
拖选区内是移动、拖选区外是重新框选、**右键一次就取消整场截图**（要只清选区用 Esc，它才是逐层退的那条）；
**选着工具时，按在四边 / 八个角的把手上仍然是改尺寸** —— 把手优先于落笔（鼠标形状给的也是缩放，
见 `updateHoverCursor`），不然想挪一下框得先把工具取消；没选工具时点已有的标注是**选中它**（虚线框 + Delete 可删、
拖动可整体位移），有工具时点击就是画。撤销栈存**整份标注数组的快照**（一张图上几十条，比维护可逆操作
便宜得多），Esc 逐层退：先收输入框 → 再收工具 → 再清选区 → 最后才取消整场截图。**工具条贴在选区的
右下角**（横向按选区右边缘对齐、纵向贴在选区下方，下面放不下翻到上面；这是 Snipaste 的摆法），
**有选区时一直显示，打字时也不收**（点里面的按钮会先把这段字提交掉，再执行那个动作）；但
**拖出一块新选区的那一会儿不收、松手才出现** —— 拖的时候它只会贴着右下角一路跳。挪选区 / 拖把手
不算这一类：那时候它本来就在，收掉反而一闪。文字标注走一个
原生 `<input>`（输入法、光标交给系统），**长得和落下去的字一模一样**（没有边框与底色，只留一个
光标，字号 / 颜色跟着当前档位、行高对齐 canvas 的 `textBaseline='top'`）——结束输入那一下画面不变，
不会看见一个框「收起」成纯色字；用画布 `measureText` 量出尺寸存进标注里，命中判定与选中框都靠它，
**按色块实心字画，不描边**。**结束输入不认回车**：中文输入法要用回车选词，
认了就会把字打一半掐掉 —— 结束靠点别处（提交在 `pointerdown` 里先做一次：那时输入框正要失焦，
而 `blur` 里再来提交时那个 ref 可能已经被「文字工具点一下开新输入框」换成空的一段了，踩过：
打完字点一下别处那几个字直接没了）。`blur` 留着兜「点到工具栏 / 窗口外」，Esc 用 `.stop` 拦在
输入框自己这儿、别上报给 window 上那个总键盘处理。

**钉图窗口**就是一块和图片一样大的窗口（`pin.rs`）：`always_on_top` + `decorations(false)` +
`skip_taskbar` + **`transparent(true)`**（透明度只能靠 CSS 的 `opacity`，而 WebView2 的窗口底色
默认不透明 —— 不开 transparent，透出来的是窗口底色而不是桌面；`html` / `body` 也必须真透明）。
**拖动交给系统**（整张图标 `data-tauri-drag-region`，跟手），位置不用前端回传：Rust 挂在窗口的
`Moved` / `Resized` 上把几何读回来补记（`sync_geometry`，JsonStore 防抖把拖动中的连发合并成一次写）。
滚轮缩放要**以光标为不动点**（`zoomAround`）并保持长宽比、夹住上下限（`clampPinSize`），
Ctrl+滚轮调透明度。**尺寸与位置一律取整**：`pin_update` 那边收的是 u32/i32，`* 1.1` 出来的
小数会被 serde 直接拒掉（`invalid type: floating point …, expected u32`，踩过一次）。
记账里的图片路径 / 尺寸 / 透明度在下次启动时由 `restore` 照着钉回来；
窗口被 Alt+F4 关掉时也要抹掉记账（否则下次启动会把已经关掉的图又钉回来）。

**验证**：`pnpm run typecheck` → `pnpm run lint` → `pnpm run build:renderer`（**三个 HTML 入口的
模板都要真的编一遍**：`typecheck` 查不出标签不配平，也查不出模板里用了没 import 的组件）→
`pnpm -r test` → `cargo test` + `cargo build`。

上面这些管不到「抓屏真的抓到没有、窗口真的起来没有」—— 那几条只能在真应用里验。跑法（配方见
[dev-notes/browser-preview-verification.md](../dev-notes/browser-preview-verification.md) 的
「在真应用里验证」）：把 `APPDATA` 指到临时目录再起
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" pnpm run dev`，连 CDP
在页面里求值驱动一遍，逐条看：**应用起来之后 `/json/list` 里就已经有 `capture.html` 那个 target**
（窗口是预建的 —— 这是预热生效的判据）→ `beginCapture` 的屏数 → `.capture__stage`
的尺寸等于这块屏的物理像素 → **画布上取一个像素、alpha 是 255**（证明 BitBlt → PNG → base64 →
Blob → `drawImage` 这一串真的通了）→ 合成出来的 PNG 有几十上百 KB → `abortCapture` 之后
**target 还在**（窗口复用，只藏起来）、画布 alpha 回到 0（收工清干净了）、再问一次
`captureContext` 应当回「截图会话已经结束了」→ 再 `beginCapture` 一次应当照常（第二场走的是复用那条路）
→ `pinImage` / `pinContext` / `pinState`（透明度）/ `pinClose` 各走一遍。

**量「按下到看见画面」**（改这条路之后该这么量，别凭感觉）：在遮罩页里把 `captureContext` /
`captureFrame` / `showCapture` 各包一层打时间戳，再用 `requestAnimationFrame` 盯着画布从空到有画面、
记下那一刻；触发也排进页面里（`setTimeout` 里连着起几场），然后**把调试器断开再跑** —— DevTools 挂着会给
几兆的 IPC 消息加不少开销，量出来的数会偏大；跑完再连回去读页面里那两串时间戳。
两个判据：**`showCapture` 被调用的那一刻画布 alpha 就是 255**（包 `showCapture` 时顺手读一次
`getImageData` 即可）—— 那就是「显示时已经有画面」；窗口真假可以按进程枚举顶层窗口核对
（`EnumWindows` + `IsWindowVisible`：藏着的时候 `visible=False`，截图进行中是 `True`）。
剪贴板那条**读回来核对**：`copyImage` 之后用 PowerShell 的
`[System.Windows.Forms.Clipboard]::GetImage()` 看有没有图、`GetFormats()` 里该有
`Format17`(CF_DIBV5)、`DeviceIndependentBitmap`(CF_DIB) 与 `PNG` 三种。收工别忘了
`taskkill /F /T /IM workbench.exe` 与那串 vite / cargo 子进程（见 AGENTS.md 第 6 节）。
