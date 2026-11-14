# 截图与钉图（capture）

## 约束

关键落点：`packages/capture/src/`（选区几何 / 把手 / 标注模型 / 撤销栈 / 放大镜取样 / 坐标换算 /
取字摆位（`ocr.ts`）/ 工具条摆位（`toolbar.ts`）/ 滚动拼接（`stitch.ts`），全部带单测）、`apps/desktop/src-tauri/src/{capture,screen,clipboard,ocr,pin}.rs`、
`workbench/index.ts` 里那一段通道、三个相关 HTML 入口（`index.html` / `capture.html` / `pin.html`）、
`components/settings/CapturePane.vue`。
跨模块通用事实见 [features-and-architecture.md](../features-and-architecture.md)，红线见 [AGENTS.md](../../AGENTS.md)。

- **抓屏只能在 Rust 侧做**：WebView2 没有 `getDisplayMedia`，像素只能由 `screen.rs` 的 `BitBlt` + `GetDIBits`
  拿（`Win32_Graphics_Gdi` 已在编译图里，不引 `xcap` 之类）。**已知边界（不是 bug）**：独占全屏 D3D 抓出来是黑的、
  HDR 按 SDR 映射、UAC 安全桌面与 DRM 抓不到；要越过得改走 Windows.Graphics.Capture（D3D11 帧池）。
- **一块屏一个遮罩窗口**（`capture-<代号>-<序号>`），不做横跨虚拟桌面的窗口：缩放因子按所在显示器定，
  横跨两块不同 DPI 只能有一个缩放，另一半就错。代价是**选区不跨屏**，有意接受。
- **遮罩窗口预建、跨场复用（池子），收工只藏不关**：按热键到看见遮罩要压到两百毫秒级，而建一块 WebView2
  窗口比这个预算还贵，所以 `capture_prewarm` 提前建好藏在屏幕外，每场只「塞帧 → 摆位置 → 显示」。
  新一场由 Rust 推 `capture:sync` 叫醒 JS（光显示不会让 JS 重新开场）。**显示要等每一块屏都报「画好了」**
  （`capture_show` + 一秒看门狗），抢在前面显示会露出上一场的旧表面。代价是**每块屏常驻一块 webview**，
  关掉截图功能时 `capture_prewarm(false)` 收池。别改回「一场一建一关」或「先显示再等画面」；
  旧表面那一瞬间不能是黑底（窗口与页面底都透明，露出的是桌面），**会话之外也不许渲染任何可见元素**：
  开场前那份「无会话」的初始渲染就是被 show 出来的旧表面，提示条（`capture__hint`）按会话显隐
  （`context` 非空才摆）—— 它原来 `!hasSelection && !failure` 就渲染，启动后第一场截图亮起的一瞬
  屏幕下方先闪一个深色块（踩过）。**显示与收起都不带过渡**：建窗口时与每次
  显示前压一次 `DwmSetWindowAttribute(DWMWA_TRANSITIONS_FORCEDISABLED)`（`disable_transitions`），
  否则 Windows 会给隐藏补一段 150~200ms 的淡出。
- **位置与尺寸一律按物理像素给**（`set_position(PhysicalPosition)` / `set_size(PhysicalSize)`）：builder 的
  `position` / `inner_size` 是逻辑坐标，混合 DPI 下会错位。
- **遮罩与钉图是独立入口，只装适配层，不装 store、不 initState**：各自的 JS 上下文，装 store 会与主窗口
  抢读写同一批 JSON（`workbench-data.json` 等）。设置由 Rust 随 `capture_context` 给（`CaptureOptions`）。
- **方向决定走不走 base64**（`capture_frame` / `capture_copy` / `capture_save` / `pin_create`）：
  **Rust → 渲染层的整帧走二进制 IPC**（返回 `tauri::ipc::Response`，JS 是 `ArrayBuffer` → Blob →
  `createImageBitmap`），这是最大一笔载荷，base64 多 33% 体积与两次编解码；**渲染层 → Rust 的最终图仍走 base64**
  （命令参数只走 JSON，没有原始字节通道）。**复制快路径**：没画标注走 `capture_copy_frame`，只把选区矩形给
  Rust（帧本来就是它抓的），连 PNG 都不搬。**帧不走 asset 协议**（钉图可以）：遮罩要把帧画到画布并
  `getImageData`（取色 / 马赛克）与 `toBlob`（复制 / 保存 / 钉图），asset 对页面是跨源的，`drawImage` 进画布
  会污染，这两个调用都抛 SecurityError（冒烟时先按 asset 走，`getImageData` 抛在 `onPointerMove` 最前面，
  把整个拖拽打断，症状是「选区怎么拖都出不来」）。字节包成 Blob 与页面同源，没这问题；钉图只摆图不读像素，
  照旧走 asset。旧的 base64 帧路径是 `fetch(data:)`，改后渲染层已无此调用点；生产态 `csp` 的 `connect-src` 暂时留着 `data:`（删它属于改 CSP，得在生产态复验，见
  [ipc-and-state](ipc-and-state.md)）。
- **系统剪贴板自己写 Win32**（`clipboard.rs`）：一次给 CF_DIBV5 + CF_DIB + 注册格式 `PNG`。不走
  `navigator.clipboard`（WebView2 要 `CoreWebView2` 权限回调，wry 没暴露、失败静默；且只写 PNG，认 CF_DIB 的
  老程序粘出来是空的）。新增 feature 只有 `Win32_System_DataExchange` 与 `Win32_System_Memory`。
- **两条全局快捷键一次性装齐，值由渲染层推**（`apply_hotkeys(main, capture)`，Rust 不读设置）：插件是
  「先全清再逐条注册」，分几次调会互相注销，只有 `main.rs` 的 `register_hotkeys` 动手。值也必须由渲染层给
  —— 默认值只活在 `@workbench/capture`，Rust 读盘会漏掉「刚加的字段还没写回」那段（首启按截图键没反应、
  之后也不再补注册，踩过）。旧的 `set_hotkey` / 无参 `apply_hotkeys()` 已删。
- **注册失败必须说出来**：`RegisterHotKey` 全局独占，被占（F1 常被输入法 / 录屏 / 游戏助手占）就挂不上。
  启动时失败走 `notifyWarning`，设置·截图那屏如实报 Rust 原文（「这些快捷键被别的程序占用了：截图（F1）」）。
- **文字标注的基线问浏览器自己排的那一行，别算**（`annotation-render.ts` 的 `textBaselineOffset` →
  `domBaseline`）：挂同字体同行高的
  隐藏块，里面一个零尺寸、`vertical-align: baseline` 的探针，其顶边正压基线，两位置相减；按字号缓存，
  量不到才退回度量。`textBaseline = 'top'` 认的是字体表 typo ascender，而输入框按 CSS 行盒摆（行盒高 =
  字号 × 1.3），24px 实测差 5~6px（「输入时一行字在那儿，落下去往上跳」）。**按 `fontBoundingBox*` 套行盒
  也不行**：那两个度量取整（16px 报 17 + 4，浏览器用 1/64px），14/16/18/20/24/28px 都往下错 1px、22/32px
  恰好对上（「输入结束后整块字下移」）。**输入框宽高不要用画布 `measureText`**（字体回退 / 亚像素会差，
  导致框内横向滚动），一律问输入框自己（`measureTextInput`：盒子压 0 读 `scrollWidth`）。
- **输入框量尺寸要挂原生 `input`，不能只跟 v-model；内部滚动一律钉回原点**：v-model 在输入法合成期间不更新
  （Vue 收到 `compositionstart` 就丢掉后续 input，`compositionend` 再补），而拼音照常写进 textarea —— 只跟
  v-model 量，框停在上一字宽、拼音比它宽，浏览器给合成区让路时就滚（用户报「输完『你好，』再打『世界』时
  『你好』看不见了」）。所以尺寸跟**原生 input**（合成期间照发），滚动用 `pinTextInputScroll` 按 `scroll`
  事件钉回 0。真输入法那一下复现不了，按「盒子永远装得下 + 滚动钉回原点」两道做。
- **选中一条标注之后能改位置、大小、粗细**（`annotationHandles` / `resizeAnnotation` / `restyleAnnotation`）：
  矩形 / 椭圆 / 马赛克摆八个把手（拖它就是改那一块，与选区同一套几何与容差），箭头两端各一个（只动被拖那端），
  文字与笔迹不摆把手（没有「框」这层几何：位置直接拖整条，字号 / 线宽在工具条上改）。**工具条上的参数改的是
  选中那条**（选中时先把它的参数摆上工具条，见 `adoptPickedStyle`；改了才落，值一样不记撤销）—— 于是「没选
  工具、只选中了一条」时参数排也照摆（`CaptureToolbar` 的 `optionTool`）。文字的 `size` 与量出来的 `box`
  必须成对改（命中判定与选中框都靠它）。
- **参数档位按工具分开记**（`packages/capture/src/tool-style.ts` 的 `defaultToolStyles` + `toolStyles` /
  `rememberStyle` / `recallStyle`）：每条工具
  记着自己的颜色、线宽（马赛克格子、文字字号）。参数一变就写回工具条上**正摆着**的那个工具（`optionTool`，
  包括选中 / 当前那条标注的工具），切工具时读回新工具那份 —— 否则两条工具来回切一次，刚调好的线宽 / 字号
  就被带跑。**默认一律最小档**（线宽 2 / 马赛克 6 / 字号 16）；遮罩跨场复用，上一场记下的档位下一场接着用。
- **松手不算定稿，去画下一个才算**（`freshId` / `freshOf` / `settleFresh` / `commitEdit`）：刚画完那条
  （矩形 / 椭圆 / 箭头 / 马赛克 / 笔迹 / 落下的文字）仍是「当前」—— 松手设成选中（虚线框 + 把手 +
  `Delete`）、工具条跟它（`optionTool` 先看 `freshId`）、按它身上是移动它而非起笔（命中 `hitTestAnnotation`，
  排在「有工具就起笔」前，指针给 `move`），所以能立刻挪 / 改大小 / 改参数。**它一直「当前」到你干别的**
  （起下一笔、开新框、动别的标注、重选 / 挪选区、换工具、被撤销 / 删掉），每个分支都叫 `settleFresh()`
  （只清标记，选中照旧）。代价（有意）：同工具下在它**里面**起笔，第一下会被当成拖它。**切到另一个工具要连
  选中一起清**（`watch(activeTool)` 只认切到非 null）：否则新工具第一次按下仍被「移动当前那条」抢走 ——
  文字工具就点不开输入框（用户报过）；参数排也已换成新工具档位，再改颜色会错落到旧那条。**这期间的微调不压
  撤销栈**（`commitEdit` 改「当前」那条只换 `present`、不动 `past`），「画 + 接着微调」算一步，`Ctrl+Z`
  整条退。
  **文字同一条**（`commitText` 落字即选中、收掉文字工具），不收的话点别处就直接开新框。
- **工具条左侧有拖动把手**（`onToolbarGripDown` + `toolbar.ts` 的 `clampToolbarPosition`，走
  `composables/` 的 `startPointerDrag`）：挡住要标注的部分时按住把手把整条拖走，取字模式那一副
  同样吃这套。**手动位置只记当前这一场**（`reset` 里清掉，下一场回「贴选区右下角」的自动摆位）；
  拖动落点夹回视口内（留 2px 边距），参数排出现 / 消失改了高度时重量尺寸后重夹一次。
  **拖动中键盘不参与**：window 上的 keydown 监听有两个，`onKeyDown` 先注册先触发，不挡一道的话
  Esc 会同时走「逐层退」把选区清掉 —— 放弃拖动（回拖动前位置）是 `startPointerDrag` 自己的 Esc。
- **标注一律按「这块屏的物理像素绝对坐标」存与画，两侧都在整帧尺寸的画布上画、共用 `drawAnnotations`**：
  显示侧是那块 stage（**只 clip 住选区，不平移**），导出侧先在同样大的画布上画完、最后才抠选区。三条坑：
  显示侧多平移一次就多减一个选区原点，笔迹整体偏左上、被裁掉大半；导出侧只在「选区那么大」的画布上画，
  画布尺寸与原点的少数部分一变，马赛克块色差几个点、抗锯齿也差一点；马赛克格子必须落在**绝对坐标**的网格上，
  两侧各按自己原点对齐会错半格。
- **本功能没有任何新的联网出口**：抓屏、标注、剪贴板、落盘、钉图、取字全在本机。**取字双引擎，微信优先**
  （`capture_ocr` 进 `wechat_ocr.rs`，起不来回退 `ocr.rs` 的 Windows OCR）：
  - **微信引擎**（`wechat_ocr.rs`）：微信截图「提取文字」那颗引擎（4.x 的 `wxocr.dll`），对 12px 界面小字
    明显更准、**逐块带框**（中文一字一块、拉丁字母 / 数字串整词一块），Windows OCR 只到词。协议是对 mmmojo
    的逆向（swigger/wechat-ocr，Apache-2.0）：本进程加载微信目录的 `mmmojo_64.dll`，它按 Chromium mojo 拉起
    weixin.exe 子进程（`--type=wxocr` 跑 XPlugin 解出的 `wxocr.dll`）；握手后发
    `ParseOCRReqMessage{task_id, pic_path}`，**图片走文件路径** —— 裁剪图落临时 PNG
    （`%TEMP%\workbench-wxocr-<task>.png`），认完即删（Drop 兜底）。**一个字节不随包带**：安装根（注册表
    `HKCU\SOFTWARE\Tencent\Weixin` 的 InstallPath → Program Files 两个根兜底）下翻版本目录（mmmojo_64.dll）、
    子进程用安装根的 weixin.exe、引擎用
    `%APPDATA%\Tencent\xwechat\XPlugin\Plugins\WeChatOcr\<编号>\extracted\wxocr.dll` —— 没在微信里用过一次
    「提取文字」的话 wxocr.dll 还没解出来，也走回退。**引擎是进程级单例、起（起进程+握手一两秒）之后不 Stop
    不 FreeLibrary**（mmmojo 的线程收不干净，卸载必崩），Err 也缓存。实测同一句 12px：Windows OCR 最好错
    15 字（查→亘、`::`→「：：」、5→巧），微信引擎汉字全对、只剩一个冒号丢失，冷启动整链 0.35s。
  - **Windows OCR**（回退，`Windows.Media.Ocr`）：不随包带模型、不引 wasm 引擎（onnxruntime-web 要给 CSP 开
    `wasm-unsafe-eval` 还得背 10MB 级模型），只给编译图里已有的 `windows` crate 加 feature。引擎按
    **用户语言列表**建（zh-Hans 认得了拉丁字母）；没装「文本识别」语言包时建不出引擎，给一句人话。
    **先放大再认，两遍法**：20px 上下明显吃力（20px 原样「把」拆成「扌巴」，放大 3 倍全对），第一遍按选区
    长边给档位 —— ≤1365 放 3 倍、≤2048 放 2 倍、更大的不放大（喂给引擎的长边封顶 4096，4096² 全字也就 0.5s）。
    但「选区小」只是「字小」的代理，**大段小字**会放不够；所以第一遍认完**量词框高度中位数**（真实字高），
    喂字高不在 40px 全对线附近就重认，倍数取**离线最近**那档（上限：长边 9999、像素总量 40M），词框坐标除回
    各自倍数。**倍数不是越大越好**：`ocr_factor_probe` 实测同一段 152 字，喂字高 39px 编辑距离 15、52px 反而
    17、26px 23 —— 40px 上下是甜点。探针还排除了：最近邻插值灾难性差（平滑必需）、Otsu 二值化 / 对比度拉伸 /
    拉普拉斯锐化都不赢原样、en-US 对照引擎要装语言包才有 —— 12px 小字是这台引擎上限，才换微信引擎。
    **只认横排**。**别改成云 OCR**（多一条出口），也别往渲染层搬推理。
  - **wire 口径两套一致**（`OcrLine` / `OcrWord`，选区内物理像素）：微信的**行文本是权威**（实测「文本去空白
    == 块拼接」一字不差），但**块不是一字一块**：中文一字一块，拉丁字母 / 数字串**整词一块**（`ESLint`、
    `npm`、`v4.1`），块只覆盖约八成字（87 字的行只有 66 块）—— 按**整块文本**做子序列对齐：对上的块用真框，
    缺框的字（含空格）在相邻两块间插值出位。**对齐要按整段块文本比较、命中后指针前进块的字数**：只比首字符
    + 前进一个字的话，整词块一命中后面就全体错位，症状是复制出来的字重复（「npm run build 均通过。」变成
    「npmrunbuild均通过。runbuild均通过。」，踩过）。两边认得不一样的以块为准（框是真像素）。**真框发位要
    裁到下一块左缘** —— 四角框普遍比步进宽 2~5px，不裁的话相邻半透明选中底色叠两层、深浅斑驳。
    探针：`ocr_factor_probe`（Windows OCR 各倍数）与 `wechat_ocr_probe`（微信整链）都在各自模块的 tests 里，
    `*_PROBE_IMAGE=<png> cargo test … -- --ignored --nocapture`。
- **取字是一个「模式」，不是一次动作**（遮罩不收，直到复制 / 退出）：认出来的行与词摆成一层**可拖选**的透明
  文字 —— 字透明、`::selection` 半透明主题蓝，高亮贴着原字走。**Ctrl+C / Enter / 工具条那颗「复制」是同一个
  动作：复制所选（没选就全部）并收工** —— 复制但不收工界面上没任何反馈、看着就像没复制。Esc / 右键退出回到
  标注。**不想在图上挑就用「复制文字」**：识别选区全部文字、整段进剪贴板并收工（不进文字层）。这层
  `inset: 0` 盖满画布、**必须压在工具条下面**（模板顺序在它前面 + z-index 双保险，排在后面按钮看着在、点不到），
  选区与标注的指针交互也进不来；**键盘只接 Esc / Enter / Ctrl+C / Ctrl+A**，其余交给浏览器原生选区 ——
  不分流的话 Ctrl+Z 会动底下的标注、Enter 会把**图**复制走。词内字符按框宽均分、**空格只补在字母数字词身边**
  （中文不用空格分词，见缝就补会把「直接把」拆成「直 接 把」）、非末行行尾补换行位 —— 摆位纯逻辑在
  `packages/capture/src/ocr.ts`（带单测），换算到视口在 CaptureApp 的 `ocrSpans`（与 `canvasToViewport`
  同一套比例）。
- **滚动截图也是一个「模式」**（工具条那颗「滚动」进入，遮罩不收）：**点「滚动」直接开滚，没有
  「开始」确认步** —— run（自动「发滚轮 → 等稳 → 抓帧 → 拼接」循环）→ result（复制 / 保存）两相
  全在**同一块遮罩窗口**里换装，不新开 HTML 入口、不新开窗口；控制条是 `CaptureScrollBar.vue`
  （照 CaptureOcrBar 仿写），摆位与拖动把手照旧复用。**run 相遮罩对鼠标穿透**
  （`set_ignore_cursor_events(true)`，Rust 设 —— capability 那句「穿透由 Rust 设」说的就是这类）。
  停止唯一可靠手段是**再按一次截图热键**：运行中遮罩穿透、按钮点不到、Esc 会漏进目标窗口；
  `toggle` 看到 `Session::scroll` 非空只调 `stop_scroll`（解穿透 + 焦点还给遮罩 +
  推 `capture:scroll-stop` 叫 JS 停循环），**不 abort** —— 拼到一半的长图别丢。`abort` 同样要先解穿透
  （窗口跨场复用，留着穿透下一场点什么都是空的）。
- **滚轮怎么喂进目标窗口（三件事缺一不可）**：① `start` 亮遮罩**之前** `GetForegroundWindow` 记下目标
  窗口（`Session::target`）—— 真要滚的时候前台已经是遮罩自己，再问就问错了；② `capture_scroll_begin`
  把焦点 `SetForegroundWindow` 还给它、光标 `SetCursorPos` 钉进选区中心：滚轮默认去前台窗口，
  「悬停滚动非活动窗口」开着的机器按光标落点派发，两条路互为保险；③ 遮罩穿透（不穿透的话光标落点
  压着的是遮罩自己，滚轮全被吃掉）。**用 `SendInput` 不用 `PostMessage(WM_MOUSEWHEEL)`**：注入的是系统
  输入栈里的「真输入」，Chromium / Qt / Win32 各路窗口都认，PostMessage 对 UWP 与不少现代窗口静默无效。
  齿数由渲染层按上一步实际位移自适应（`stitch.ts` 的 `planNotches`），步长贴着选区高度 25% 走、
  夹在「选区高 − 最小重叠」以内 —— 跨过整个视口就没有重叠可比了。feature 全在已开的两个里
  （`Win32_UI_Input_KeyboardAndMouse` 的 `SendInput`、`Win32_UI_WindowsAndMessaging` 的前台 / 光标），
  零 feature 变更。
- **滚动抓的是「现在」的屏幕**：`capture_scroll_grab` 走 `screen::capture_region` 现抓（选区矩形 =
  遮罩那块屏原点 + 画布坐标，`clamp_region` 对这块屏再夹一次），不走会话缓存 —— 目标窗口正在动，
  开场冻结帧早过时了。**回的是原始 RGBA 字节**（`capture_region` 的直出）：拼接循环每步要抓好几帧，
  PNG 编解码一来一回约 50ms 全省掉 —— JS 拿到字节就是 `ImageData`，`putImageData` 直接上长图画布。
  **等稳判定靠原始字节相等**（抓屏是确定的，静止内容两次 BitBlt 必同字节）；一直在动（视频 / 加载
  占位）就抓最后一帧硬拼，拼不拼得上交给匹配判。
- **重叠匹配与拼接计划在 `stitch.ts`（纯逻辑带单测）**：**按行打分，不按条带**（条带方案在两类真实
  页面上挂过）——
  - **只拿「有内容」的行打分**：一行里 RGB 各通道自己的极差 ≤ 门槛算「平行」（大片留白）。留白行
    在任何 Δ 下都一样，拿它们打分只会稀释信号 —— GitHub 首页那一类「整页几乎全白、只有零星几块字」
    的页面，条带全落在留白里会被平坦保护误判成「匹配无意义」（真机踩过）。整页纯色（一个有内容的
    行都没有）才放弃匹配；
  - **中位数聚合**：每个候选 Δ 逐行算绝对差、取**中位数**当分数。会动的行（彩虹渐变带、视频、
    加载占位）与粘头 / 粘底的行都是个别离群值，平均值会被拖高、中位数不受 —— 只要「有内容且静止」
    的行超过一半，真解稳稳胜出。静止内容的真解中位差是 0，门槛可以收到 3；
  - **Δ=0 快速通道**：全体有内容行的中位差 ≤ 门槛 = 页面没滚（到底、滚轮没生效、大面积静止），
    直接报 0 —— 与全量扫里 Δ=0 胜出的旧口径完全一致，只是不用把其余候选也扫一遍；
  - **静态行剔除**：两帧在**同一屏幕位置**一模一样的行是「粘住画面」的行（粘头 / 粘底 / 悬浮件，
    内容滚它们不滚），从匹配行集里剔掉 —— 它们在任何 Δ 下都对得上，留在集里只会制造并列、把
    粘底页面拉去错的档。剔完行数不足复核最少行数、或剔行集对不上时退回整集再扫一次（剔除只该
    帮忙，不该把行数削到凑不齐复核的量）；
  - **预测窗口**：滚轮是渲染层自己发的，本步位移 ≈ 上一步实测 × 本步实发齿数，先在预测值 ±48px
    （`WINDOW_TOLERANCE`）的小窗口里找，命中直接用 —— 稳态候选从「选区高」个掉到百来个，
    **每步不再卡顿靠的就是这个**；不中（布局位移、预测失灵）回退全量扫；
  - **并列破平局**：与最优分差 ≤1 的候选视为并列，取离预测最近的 Δ —— 重复纹理（列表行 /
    代码行）天然给出多个「完美」档，锁到过小的 Δ 会把内容拼重（拼接处杂糅的来源之一）；
    没预测（首步）保持初筛序取最小；
  - **两段式**：初筛按粗采样的行 / 列（≤48 行 × 步距 8）算平均差、留下最像的 8 个候选，复核才用
    匹配行集算中位数 —— 全量行的中位数每个候选都算一遍太贵。搜索上限给重叠留 48px
    （`MIN_OVERLAP`），Δ 最大到「选区高 − 它」。
- **只贴新露出的条带（`planBand`）**：向下滚 Δ 时条带**不从 h−Δ 起**，起点 = h − Δ − stickyBottom − 8
  —— 向上越过粘底栏多要一段（eSearch makePatch 同款）。条带起点的**绝对位置**只跟粘底栏厚度有关
  （`top + h − Δ − stickyBottom − 8 = 上一步的 top + h − stickyBottom − 8`，与 Δ 无关），每一步都恰好
  盖住上一帧贴下来的粘底副本 —— **粘底栏最终只在最后一帧的位置出现一次**（旧实现每步重复一次，
  已解）；Δ 估错时污染也只落在条带里，不再抹过整个重叠区（旧实现整帧覆盖，杂糅面是整个重叠区）。
  stickyTop / stickyBottom 由匹配一并报回（`analyzeScrollOffset`），条带起点夹在 stickyTop 之下
  （粘头只在第 0 帧出现一次）。
- **匹配跑在 worker 里（`capture/scroll-match.worker.ts`，无状态）**：像素比较是几十万到上千万次
  同步运算，主线程上跑每步要冻结遮罩几十到几百毫秒（首步与回退全量扫最重）—— 挪进 worker 后
  主线程只剩字节搬运与贴画布。worker 建不起来 / 中途出错回退主线程同步直调（结果一致，那一步
  会卡）；`vite.config.ts` 的 `worker.format: 'es'` 是它的 build 配套（`{ type: 'module' }` 起的
  worker 产物必须是 ES 格式），CSP 的 `worker-src 'self' blob:` 已放行。
- **滚动节奏是「滚 → 停稳 → 抓」，一步步的顿挫是固有形态**（Snipaste / PixPin 同款；但每步的
  **冻结卡顿**不是 —— 那是匹配在主线程上跑出来的，解法见上面 worker 与预测窗口两条）：**拼进
  长图的就是抓到的像素**，滚动动画中途抓到的帧是合成器过滤出来的过渡态（内容差着不到一个像素），
  拼进去就是一条条模糊带 —— 所以不能边滚边抓。能做的是把一步的量压小：首步 1 齿，之后按实际位移
  自适应（`planNotches` 贴着选区高度 25% 走、上限 3 齿）；等稳先等 tick —— 首步 150ms（动画跑完
  大半），之后按上一步实测的轮询数自适应（`planTickDelay`，40~150ms：瞬时跳滚的应用一路降到 40，
  平滑滚动的应用升回 150），再以 80ms 轮询到「连续两帧字节一致」。**到底要连着两次 Δ=0 才收**
  （`SCROLL_ZERO_CONFIRM`）—— 防的是「这一齿还没生效就抓了一帧」的假到底，代价只是到底时多滚
  一齿确认。
- **run 相的每个 await 后都有「活着」守卫**（`token === sessionSeq && scrollState === state`）：
  滚动跑着的时候 abort / 新一场随时可能来（与 beginSession 的 token 守卫同一条口径）。无论哪条路出
  循环，`finally` 里都解穿透（幂等：热键那条路 Rust 已收过尾，命令报「没有在滚动」照单全收）。
- **长图上限 `MAX_STITCH_HEIGHT = 16000`**（Chromium 画布超过 16384 一档在 GPU 纹理上不可靠）；
  选区高度下限 `MIN_SCROLL_REGION_HEIGHT = 192`（匹配要有内容行，更要留得出最小重叠 —— 一齿滚轮
  普遍 ~100px，选区比「两倍最小重叠」高不了多少时一步就把重叠吃光了）。长图画布**翻倍扩容**，
  每次扩容把已拼内容搬过去 —— 搬家次数是对数级的。拼好的长图**只在内存里**（随模式退出丢掉），
  复制 / 保存走 `capture_copy` / `capture_save` 那条 base64 路，不新增落盘与联网出口。
- **已知边界（写清楚，免得当成 bug 查）**：管理员权限 / UWP 窗口滚不动（UIPI，与抓不到安全桌面
  同族）；滚动中 Esc / 点击会漏进目标窗口（焦点在那边）；无暂停（停即出结果）；动画内容接缝可能有
  残影；选区中心若不是可滚区域就滚不动（Δ=0 如实收场）；首步 Δ=0 的「滚轮没起作用」与「已在底部」
  不区分 —— 都按「拼完了」收，第一屏也是完整的长图。
- **数据落点**：截图的每一帧**只在内存里**（不落盘、没有临时目录要收拾）；**唯一例外是取字走微信引擎时**：
  裁剪图落临时 PNG（`%TEMP%\workbench-wxocr-<task>.png`），认完立刻删（错误路径也有 Drop 兜底）；钉图的图在
  数据目录的 `pins\<id>.png`（安装版 `%APPDATA%\Workbench\data\`，开发版 `%APPDATA%\Workbench-dev\data\`）、
  记账在同目录的 `pins.json`（JsonStore 防抖落盘，退出前 `flush_all` 一起写）。都没进同步仓库。
- **设置项住数据文件、不进外观同步**（都是「这台机器」的事）：`captureEnabled` / `captureHotkey` /
  `captureSaveDir` / `capturePinOpacity` / `captureMagnifier`（开着时放大镜读数按 Shift 进剪贴板）。
  默认 F1 起截图（**F1 很常见地被别的程序占着**，装完先按一下试，没反应就换）。
- **capability 单独一份**（`capabilities/capture.json`，覆盖 `capture-*` 与 `pin-*`）：只给 `core:default` +
  `core:window:allow-start-dragging`（钉图整张标了 `data-tauri-drag-region`，被 ACL 拦下是**静默失效**：
  拖不动也不报错）+ `dialog:default`（「另存为」）。窗口位置 / 尺寸 / 置顶都由 Rust 设，前端一条都不碰。

## 实现

**一次截图的完整走法**（`capture.rs`）：

1. 热键 / 托盘 / 设置按钮 → `capture::request`（**丢工作线程**：抓屏加 PNG 编码在多屏上几百毫秒，热键回调
   与托盘菜单都在主线程派发）；
2. `start` 先确认遮罩池子对得上当前屏幕 —— 对得上**一块窗口都不建**；
3. 逐屏 BitBlt 抓图、编成 PNG 字节留在内存；**顺序不能反**（窗口一显示就会被拍进去）；
4. 帧进状态后给每块遮罩推一条 `capture:sync`（带这场编号）—— 窗口复用，光显示不会让 JS 知道又开一场。
   **到这里还不显示**；
5. 遮罩 JS 收到 `capture:sync` 就取上下文、取帧、画到画布，画完调 `capture_show` 送回编号；
6. Rust 收到**每一块屏**的 `capture_show` 才摆位置、显示，焦点给**光标所在那块屏**（Esc / Enter / Ctrl+Z
   只有拿到焦点收得到）。一秒看门狗兜底；
7. 做完动作（复制 / 保存 / 钉图）或取消 → `capture_abort`：遮罩**藏起来**（留着复用）、丢掉这场帧，再推一条
   **不带编号**的 `capture:sync` 清掉上一场的帧 / 选区 / 标注。**复制这条是反过来的**：`capture_copy` /
   `capture_copy_frame` 一进来先 `abort`，再解码 / 裁图 / 构 DIB / 写剪贴板 —— 遮罩不该停在屏幕上等；
   失败经 `capture:failed` 推给主窗口（与「起截图失败」同一条路）。

**为什么要养一池遮罩窗口（预建 + 复用）**：按热键到看见遮罩要压到两百毫秒级，靠的就这一条：**建一块
WebView2 窗口比整个预算还贵**（起 webview、加载 JS 包、跑起 Vue）。所以窗口在 `capture_prewarm`（渲染层
载入设置之后调一次，见 workbench/index.ts 的 `syncSystemIntegration` —— 它是那几项里**最先发起**的，不排在
开机自启 / 快捷键之后 await）里建好藏屏幕外。五条边界：

- **每块屏常驻一块 webview**（有意换来的）；关掉截图会经 `capture_prewarm(false)` 收池；
- 屏幕数变了（插拔显示器）池子对不上，**整批重建**：旧一代先 `close()`（异步的，还在事件队列里没销毁），
  新的一代换**代号**（`capture-<代号>-<序号>`），免得新窗口顶着同一标签建不出来（`capture-*` 通配盖得住）；
- **收工只 `hide()` 不 `close()`**：藏起来不进合成，既不会被下一场抓进去，也不占屏幕；
- **显示要等每一块屏都报「画好了」**（`capture_show`）。抢在前面用户看到「先闪一块黑、再出画面」——
  那一帧要走 IPC（几兆、几十毫秒）。一秒看门狗：JS 万一没起来，到点也照亮；编号对不上的一律忽略；
- 窗口里的 JS **一场只跑一次**：新一场靠 `capture:sync` 叫醒（订阅先于「补问一次当前有没有会话」，否则漏
  中间那条 —— 见 bridge.ts 的 `listenReady`），`reset()` 掉上一场的帧 / 选区 / 标注。送回编号取自
  `captureContext` 的 `session`，不是事件载荷 —— 起手补问那次没收到过事件。

**为什么遮罩窗口也是透明的**：`hide()` / `show()` 走 `ShowWindow`，`document.visibilityState` 一直是
`visible`（实测藏着的窗口 rAF 照跑 60 帧/秒），但**合成器不给藏着的窗口交新帧** —— `show()` 头一帧还是
上一次合成的旧表面（实测：只有页面底色与提示条）。所以遮罩跟钉图一样开 `transparent(true)`、页面底也透明
（见 capture.html）：旧表面那一刻露出的是**桌面本身**，与冻结帧几乎一样，看不出切换；底色给黑就是「按热键
先闪一块黑」。那条实测里的「提示条」后来自己成了问题：它的显隐条件原是 `!hasSelection && !failure`，
开场之前就渲染出来了 —— 预建窗口装载完的那份渲染正是第一场被 show 出来的旧表面，启动后第一场截图亮起的
一瞬屏幕下方先闪一块深色（用户报过「第一次截图闪一个色块」；之后的场次旧表面是上一场的冻结帧 ≈ 桌面，
所以只有第一场看得见）。现在提示条按会话显隐（`context` 非空），会话之外整页全透明。**透明不影响点击**：
真鼠标框选（`SetCursorPos` + `mouse_event`）与真回车复制都验过。

**这条路上每一笔开销**（1080p 单屏、release 构建、CDP 驱动，见「验证」。这场屏幕上是 4.28MB 的帧）：

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| 复用遮罩窗口 | ~1ms | 池子命中只有一次查找。**一场一建光 `build()` 返回就 124~155ms**，之后还得等 JS 包加载、Vue 起来 |
| BitBlt + GetDIBits + BGRA→RGBA | ~40ms | 都是系统调用；换通道按 DWORD 走。`CreateDIBSection` 那条量过，没有更快 |
| PNG 编码 | ~36ms | `Fast` + `Sub`；默认「自适应滤波」同屏要 166ms（多屏成倍） |
| 取帧（二进制 IPC） | 原 base64 为 75~81ms，改后待复测 | 直接传 4.28MB PNG 原始字节（不再撑成 5.7MB 字符串）；省掉 base64 编解码，量级按字节线性涨 |
| 包成 Blob | ~1ms | 不再 `fetch` data: URL |
| `createImageBitmap` 解 PNG | ~26ms | |
| 重画到画布 | ~30ms | 取样画布挪到「第一次取色时」做，不在这一笔 |
| **合计（按下 → 遮罩出现）** | **原 248~276ms，改后待复测** | 去掉 base64 后应当少一截（载荷少 25% + 两次编解码）；**遮罩仍在画布有画面之后才出现** |

**这张表是把帧改成二进制 IPC 之前量的**（2026-10），帧那一行与合计需按新路径复测；其余不受影响。三件事
值得记住：**建窗口那一笔是热身省掉的**（最值钱）；**取帧与内容相关**（4.28MB 就是这么来的）；**dev 下多
几百毫秒**，在 Cargo.toml 里给 `image` / `png` / `flate2` / `fdeflate` / `miniz_oxide` 开了 `opt-level = 3`
（同屏 295ms → 158ms）。

**复制到剪贴板这条路**（用户报过「复制有点慢」）：

- **没画标注走 `capture_copy_frame`**：渲染层只给选区矩形（画布坐标），Rust 从这场缓存的原始 PNG 裁。
  省掉「JS 整帧合成 → 选区 PNG 编码 → base64 → IPC → Rust 解码」一整圈。
- **画了标注才走 `capture_copy`**：标注只有渲染层会画（与显示共用 `drawAnnotations`），图那圈往返躲不掉。
- **DIB 只转换一遍像素**（`clipboard.rs` 的 `bgra_bottom_up`）：两份 DIB 像素段完全一样，先写一份自底向上
  BGRA 缓冲，两个头各自 `extend_from_slice` 拷过去。从前两趟逐像素 `Vec::push`，4K 下就是两趟 33MB。
- **遮罩在命令一开始就收**，剪贴板后台写完；失败时遮罩已没了，经 `capture:failed` 唤出主窗口并弹提示。
- **剪贴板里的 `PNG` 仍是裁剪后的图**：整屏时复用缓存 PNG 字节，非整屏时用同一编码档（`Fast` + `Sub`）
  在 Rust 重编一次 —— 快路径唯一多出来的一笔。
- 依赖档位见 `Cargo.toml`：`base64` 在 dev、`image` / `png` / `flate2` / `fdeflate` / `miniz_oxide` 在
  release 都按 `opt-level = 3`（release 全局是 `s`，按体积编的解码会慢一截）。**这些数要在 release 里量**。

**取字这条路**（`ocr.rs` + CaptureApp 取字那一节 + `@workbench/capture` 的 `layoutOcrSpans`）：

- **图不过渲染层**：Rust 手里就有这场原始帧，`capture_ocr` 只收选区矩形（画布像素、渲染层取整后给，
  与 `capture_copy_frame` 同一口径再夹一次）—— 裁选区、按长边档位放大、量字高不在全对线附近再按最近倍数
  重认、RGBA 换 BGRA（WinRT 只吃 Bgra8 / Gray8）、灌进 `SoftwareBitmap` 交 `OcrEngine::RecognizeAsync`，
  词框再除回倍数。**标注不算在内**：取字读屏幕当时的样子。全程在 `#[tauri::command(async)]` 工作线程，
  遮罩不收。
- **像素怎么进 WinRT**：`Buffer::Create` 只给容量，**不能直接 QI 出字节接口**（实测 E_NOINTERFACE）、
  `IBuffer` 上没有 `CreateReference` —— 得经 `IBufferStatics` 的 `CreateMemoryBufferOverIBuffer` 架一个共享
  内存的 `MemoryBuffer`，从它 QI `IMemoryBufferByteAccess` 拿原始指针拷像素；拷完还要显式 `IBuffer::SetLength`
  （经字节接口写不带长，`CreateCopyFromBuffer` 按 Length 拷贝，0 就报 0xC00D7170，看着像内存不足）。等异步用
  `windows_future` 的 `join` —— 与保险库 Windows Hello（vault.rs）同一条口径。
- **词框 → 文字层**：`layoutOcrSpans`（纯逻辑、带单测）摊成逐字位：词内字符均分框宽、词间空隙过门槛补空格位、
  非末行行尾补换行位（那层全是绝对定位 span，浏览器串选区文本**不会自己**补 `\n`）。渲染层 `ocrSpans` 再按
  `canvasToViewport` 同一套比例换成 CSS 像素；`user-select` 要在层上显式开回 `text`（遮罩整页是 `none`）。
- **复制**：`navigator.clipboard.writeText`（遮罩窗口里实测通）。Ctrl+C / Enter / 工具条「复制」都走 `copyOcr`：
  有所选复制所选、没选复制全部，**复制完收工**。失败走「两秒自己收」的短提示（`failTransient`）。
- **这套管不到「语言包在不在」**：`TryCreateFromUserProfileLanguages` 建不出引擎时 Rust 回一句人话，
  渲染层照实显示。真机验只能真按一遍热键；单测只钉换算与摆位。`ocr_probe` 是 `#[ignore]` 手动探针：
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ocr_probe -- --ignored`。

**滚动截图这条路**（`capture.rs` 的滚动四命令 + CaptureApp 的滚动模式 + `@workbench/capture` 的
`stitch.ts`；矩形口径与 `capture_copy_frame` 一致 —— 这块屏的画布像素，Rust 再夹一次）：

- **两相与各自能点什么**：点工具条那颗「滚动」**直接进 run**（`startScroll` 校验选区高度后置
  `phase: 'run'` 并起循环 —— 没有「开始」确认步，停止靠再按一次截图热键）。画布**不画冻结帧**
  —— 透出的是实时内容，滚轮滚的是底下的真窗口；**选区外压一层暗**（evenodd 暗层，与标注模式
  同一口径的 `rgba(0,0,0,0.45)`）：一眼看出要滚的是哪块，选区内保持原亮度 —— 洞的边缘落在
  整数像素上，抓帧抓不到半透明过渡行（**暗层只能压选区外**，压进选区就会被拼进长图）；描边
  画在暗层**之后**（不被压灰）、仍然画在矩形**外面**（外扩 3.5px、线宽 3）：抓帧抓的是矩形
  内部，画进里面就会把线拼进长图。run 相穿透、控制条只剩进度文案 → result（选区里挂长图
  预览 + 复制 / 保存 / 取消 + 尺寸读数，拼不上的原因挂在尺寸前面）。**开场失败（穿透设不上）
  没有确认步可回**：`exitScroll` 退回标注那套 + `failTransient` 说清楚原因。
- **开场**：`capture_scroll_begin`（画布矩形 → `clamp_region` → 记 `ScrollRun{overlay}` →
  解锁穿透 → 还焦点、钉光标）。**设穿透失败要回滚 `Session::scroll`** —— 别留下「标记说在滚、
  遮罩不穿透」的中间态（滚轮被遮罩吃掉，JS 那边看着像卡死）。
- **主循环（CaptureApp 的 `runScroll`，业务语义归渲染层，Rust 只出「发滚轮」「抓矩形」两件原生件）**：
  `scrollWheel(notches)` → 等稳（先等 tick —— 首步 `SCROLL_TICK_DELAY=150ms`，之后按上一步实测
  的轮询数自适应（`planTickDelay`，40~150ms）；再以 `SCROLL_SETTLE_POLL=80ms` 轮询到连续两帧
  原始字节一致，最多 8 次；一直在动就抓最后一帧硬拼）→
  `scrollGrab`（原始 RGBA）→ `frameFromBytes` 长度校验 → `matchScroll`（worker 里的
  `analyzeScrollOffset`，预测位移 = 上一步实测 × 本步实发齿数）→
  `null` **放慢重试**（改发 1 齿 + 等稳轮询翻倍，连着 `SCROLL_NULL_LIMIT=2` 次才收，note 说清楚）、
  `Δ=0` 连着 `SCROLL_ZERO_CONFIRM=2` 次才收（防假到底）→ `planBand` 算条带起点、**只贴新露出条带**
  进长图画布（`frame.data.subarray(bandTop·w·4)` 构 ImageData）→ `planNotches(Δ, h)`。
  第 0 帧也走实时抓取（不用冻结帧），整帧贴。步骤间守卫与收尾见「约束」里那两条。
  **停止响应**：请求在每一轮开头、轮询间隙、匹配失败分支、贴完这一步后都查 —— 按下去最多再等
  一个轮询（~80ms）或把在途的一步拼完（滚出去的内容不丢），不会卡着把整步走完。
- **热键停止**：`toggle` → `scrolling()`（`Session::scroll` 非空）→ `stop_scroll(app, true)`：
  清标记、解穿透、`set_focus` 回遮罩、`emit_to` 推 `capture:scroll-stop`。JS 那边 `onScrollStop`
  **只置 `scrollStopRequested` 标记**，循环每一轮自己查 —— 不能就地动 `scrollState`（那是循环线程的活）。
- **结果相**：拼好的长图**先画回选区做预览**（等比缩到选区以内、居中，细边一圈 —— run 相不画，
  那块要透出实时内容；「复制前先看一眼」是这类功能的基本预期），再走
  长图画布 → `toBlob` → `blobToBase64`（照 pngBase64 的分块，长图几 MB）→
  `capture_copy` / `capture_save`（复用既定的 base64 口径；命令一进来就 abort 收场，失败走
  `capture:failed`）。取消 / Esc / 右键退回标注那套（冻结帧还在、选区原样），再一层 Esc 才是收场 ——
  与取字同一套逐层退。
- **验证**：`stitch.ts` 全单测离线跑；真机按一遍 —— 真实网页框选 → 滚动（**选区外应是置灰的、
  选区内实时**）→ 进度走（**滚动过程应流畅，每步不该有冻结感**）→ F1 停止（**按下就收，不该等
  整步走完**）→ **结果相选区里能看到长图预览** → 复制粘贴核对长图接缝（**接缝处不得有重复 /
  错位的杂糅带，长图里也不得混进控制条 / 描边的像素**）；粘头与粘底页面
  （粘栏在长图里各只出现一次：粘头在最上、粘底在最末一屏）与到底自动停各验一遍；带粘底栏的
  页面长图末尾核对粘底栏不重复；瞬时跳滚的页面（终端类）与平滑滚动的页面各滚一遍（tick 自适应
  的速度差异应感觉得到）；选区 < 192px 高要提示；
  **abort / 换场后遮罩不能再是穿透态**（收工后点一下选区试试就知道）；运行中按 Esc 应该进的是目标
  窗口而不是收遮罩（焦点在那边，不是 bug）。

**坐标有三层**（口径在 `packages/capture/src/coords.ts` 文件头）：虚拟桌面物理坐标（Rust 摆窗口、钉图定位）
→ 画布像素（某块屏的物理像素，与那帧 PNG 一一对应）→ 视口 CSS 像素（鼠标事件）。**鼠标事件一律经
`viewportToCanvas` 换算**，不自己乘 `devicePixelRatio` —— 那个值跨屏拖动时会变。

**遮罩渲染分两块画布**：可见的 `stage`（画法「冻结帧 → 标注 → 选区外暗层 → 选区与把手 → 十字线」，每次
整块重画：一次 `drawImage` 加几十条路径，4K 也是毫秒级；**暗层排在标注之后**：马赛克从这块画布读像素取平均，
暗层先画会让贴边打码的格子把暗色平均进来，而导出侧没暗层 —— 两边对不上），外加一块不进 DOM 的 `sampler`
（只有原图干净副本）。**像素读数必须从 sampler 取**。**画标注前先把「正被拖的那一条」从清单摘掉**
（`settledAnnotations` 按 `draft.id` 过滤）：拖动期间数组里还是旧几何，两份都画旧边就一直留在屏幕上
（挪位置更明显，踩过）；显示与导出都按这份画再补 `draft`（选中框与把手那一路本来就取 `draft`，见
`drawPickedChrome`）。**「取色」的出口是 Shift**：读数卡是画在遮罩上的
文本（整页 `user-select: none`），按 Shift 把当前十六进制写剪贴板、读数卡回一句并**直接收工**（失败才留在
遮罩里说「复制失败」）；只在放大镜露着时认（有选区时 Shift+方向键是「步进十格」）。sampler 现用现做（第一次
取色才画整帧）。马赛克：**别用 `getImageData` + 逐像素循环**（要 GPU 读回，750×500 每帧 5~7ms，区域大就卡）；
做法是「整格对齐那块」**缩到一格一像素再放大铺回**，`imageSmoothingQuality` **必须 high**（默认 low 大比例
缩小时只采几个像素，白底字变零星色块），放大关插值；scratch 画布复用。**格子对齐原图绝对网格**
（`origin` 就是 0），画的范围**只用 clip 收在拖的矩形里**（不然网格外扩几格会让边一格一格跳）。

**箭头是一块填出来的多边形**（`ARROW_SPREAD` / `arrowHeadLength` / `arrowOutline` 在 annotation.ts，渲染层
只负责填一次色）：**杆是收尖的锥形、头是实心三角**，粗细与头都按线宽算，细 / 中 / 粗整体等比放大。三个比例
对着参考样式量出（147px 长、线宽 8px）：头长 ≈ 3.25 × 线宽、头半宽 = 头长 × tan(21°)、尾巴收到 0.18 × 线宽；
头另有 10px 下限与「最多占整条七成」上限。**一次填充而不是「先描杆、再填三角」**：接缝与双重抗锯齿都不会有。
`annotationBounds` 对箭头**按轮廓算**（不是两端点矩形）—— 头角比杆宽得多，只按端点给框会把头切掉。

**选区与标注手感**照 Snipaste：拖出建选区、八个把手（角优先、命中取最近、拖过对边可翻转）、拖选区内是移动、
拖选区外是重框、**右键一次取消整场**（只清选区用 Esc，它才是逐层退的那条）；**选区把手优先于别的动作**
（八个排在选中标注那几个前面）：选着工具时按在选区把手上仍是改尺寸、按在**选中标注把手**上也是改尺寸，
鼠标形状给缩放（`updateHoverCursor`）；没选工具时点已有标注是**选中它**，有工具时点击是画 —— **只除了还
「当前」的那条：按在它身上是动它**（见上「松手不算定稿」）。撤销栈存**整份标注数组快照**（比维护可逆操作
便宜）。Esc 逐层退：收输入框 → 收工具 → 清选区 → 取消整场。**工具条贴选区右下角**（横向按选区右边缘对齐、
纵向贴下方，放不下翻到上面；摆位纯逻辑在 `toolbar.ts` 的 `autoToolbarPosition`），**有选区时一直显示、
打字时也不收**；但**拖新选区那会儿不收、松手才出现**
（拖时它只会贴着右下角跳）。**把手拖出的手动位置压过这套自动摆位**（非空时不再跟着选区跳，见「约束」）。
文字标注走原生 `<textarea>`（输入法、光标交给系统），**多行、不限长度**：回车
换行、宽高跟内容长（空时留半个字宽，不然零宽光标看不见），长句不折行不截断。**回车不结输入、也不跨过输入法**：
中文输入法用回车选词那下由输入法吃掉，换行交给 textarea 默认行为。**长得和落下去的字一模一样**（无边框
底色，只留光标，字号 / 颜色跟当前档位、宽高行高由量尺寸那套给：`white-space: pre` 挡折行、`line-height` 取
`TEXT_LINE_HEIGHT`）—— 结束输入画面不变，不会看见框「收起」成纯色字；用画布 `measureText` 逐行量尺寸存进
标注，**按色块实心字画，不描边**。**结束输入只认点别处与 Esc**（提交在 `pointerdown` 里先做一次：那时输入框
正要失焦，`blur` 里再提交时 ref 可能已被「文字工具点一下开新框」换成空的一段，踩过：打完字点别处那几个字
直接没了）；`blur` 兜「点到工具栏 / 窗口外」，Esc 用 `.stop` 拦在输入框自己这儿。

**钉图窗口**就是一块和图片一样大的窗口（`pin.rs`）：`always_on_top` + `decorations(false)` + `skip_taskbar`
+ **`transparent(true)`**（透明度只能靠 CSS `opacity`，而 WebView2 窗口底色默认不透明 —— 不开 transparent，
透出来的是窗口底色而不是桌面；`html` / `body` 也必须真透明）。**拖动交给系统**（整张标
`data-tauri-drag-region`），位置不用前端回传：Rust 挂 `Moved` / `Resized` 把几何读回来补记（`sync_geometry`，
JsonStore 防抖把拖动连发合并成一次写）。滚轮缩放**以光标为不动点**（`zoomAround`）并保持长宽比、夹上下限
（`clampPinSize`），Ctrl+滚轮调透明度。**尺寸与位置一律取整**：`pin_update` 收 u32/i32，`* 1.1` 的小数会被
serde 拒掉（`invalid type: floating point …, expected u32`，踩过）。记账里的路径 / 尺寸 / 透明度下次启动由
`restore` 照原样钉回；Alt+F4 关掉时也要抹掉记账（否则下次又把已关的图钉回）。

**验证**：`pnpm run typecheck` → `pnpm run lint` → `pnpm run build:renderer`（**相关 HTML 入口的模板都要真编
一遍**：`typecheck` 查不出标签不配平、也查不出模板里用了没 import 的组件）→ `pnpm test` → `cargo test` +
`cargo build`。

**取字也只能在真应用里验**（WinRT 链与语言包都吃真机）：框选有文字的区域 → 工具条「取字」→ 字位原样贴在
图上（中文逐字、英文逐词）、拖选高亮贴原字走；Ctrl+C 后剪贴板里是**文字**（PowerShell
`[Windows.Forms.Clipboard]::GetText()` 核对，空格与换行都在）；Enter 复制并收工、Esc 退出回标注（选区还在）、
右键同理；对着没字区域取字应说「这一块里没认出文字」并在两秒后自己收。**文字层本身（摆位 / 选中 / 复制）
浏览器里就能验** —— 把 `ocrRegion` 桩成回一份现造的行业与词即可，仓库一个文件都不用加。

上面这些管不到「抓屏真的抓到没有、窗口真的起来没有」—— 只能在真应用里验。跑法（配方见
[dev-notes/browser-preview-verification.md](../dev-notes/browser-preview-verification.md) 的「在真应用里验证」）：
把 `APPDATA` 指到临时目录再起
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" pnpm run dev`，连 CDP 求值驱动一遍：
**应用起来后 `/json/list` 里已经有 `capture.html` target**（窗口预建 —— 预热生效的判据）→ `beginCapture` 的
屏数 → `.capture__stage` 尺寸等于这块屏物理像素 → **画布取一个像素、alpha 是 255**（证明 BitBlt → PNG →
二进制 IPC → Blob → `drawImage` 通了）→ 合成 PNG 有几十上百 KB → `abortCapture` 后**target 还在**（复用）、
画布 alpha 回 0、再问 `captureContext` 应回「截图会话已经结束了」→ 再 `beginCapture` 一次照常（第二场走
复用）→ `pinImage` / `pinContext` / `pinState`（透明度）/ `pinClose` 各走一遍。

**「帧画上去了没有」必须另起一遍生产态**（`pnpm run build` 的 exe，或按
[dev-notes/browser-preview-verification.md](../dev-notes/browser-preview-verification.md) 手搓一个 —— 关键是
`cargo build` 要带 `--features tauri/custom-protocol`，漏了是 dev 语义）：dev 下页面来自 Vite、CSP 不生效，
资源或通道被拦只有装完才现形（踩过：旧 base64 帧路径要 `fetch` data: URL，生产态 `connect-src` 少一个 `data:`
就整条读不出来）。判据一样 —— 遮罩上**没有**「这一帧读不出来」红字、画布 alpha 是 255。两个 exe 不能同时开
（单实例按 identifier 认名 —— 装着的那份与 `target/release` 那份算同一个；`pnpm dev` 开发版例外，它不注册
单实例，可与安装版同时开，见
[dev-notes/browser-preview-verification.md](../dev-notes/browser-preview-verification.md)）。

**「显示那一瞬间闪不闪」只能靠外部抓屏量**（CDP 合成事件与 `Runtime.evaluate` 都看不见合成器那一下）：
抓一条**窄带而不是整屏** —— 整屏 `CopyFromScreen` 一次 35~55ms（约 25fps）追不上 30~50ms 的一闪，抓
1920×48 横条只十几毫秒（实测 56fps）。判据两条：带子均值在遮罩亮起前后**只差「提示条出现」那一点**（实测
239 ↔ 227），全程**没有一次掉到接近黑**；再故意让帧取不到（把 `captureFrame` 换成回 `{ok:false}` 的桩），
窗口亮起时透出的应是**桌面**而不是黑，验完把桩换回。**真实鼠标键盘别用合成事件**：`SetCursorPos` +
`mouse_event` 拖一个框、`SendKeys` 发回车，才能验到「透明窗口没被穿透」（合成事件不过 OS 命中测试）与整条
真实路径 —— 判据是提示条收起、工具条出现、剪贴板里是刚框那块像素。

**量「按下到看见画面」**（别凭感觉）：在遮罩页把 `captureContext` / `captureFrame` / `showCapture` 各包一层
打时间戳，再用 `requestAnimationFrame` 盯画布从空到有画面；触发也排进页面（`setTimeout` 里连起几场），然后
**把调试器断开再跑** —— DevTools 挂着会给几兆 IPC 加不少开销；跑完再连回去读时间戳。两个判据：
**`showCapture` 被调用那刻画布 alpha 就是 255**（包 `showCapture` 时顺手读 `getImageData`）；窗口真假按
`EnumWindows` + `IsWindowVisible` 核对（藏着 `visible=False`，进行中 `True`）。剪贴板**读回来核对**：
`copyImage`（有标注）/ `copyFrame`（没标注）后用 PowerShell 的
`[System.Windows.Forms.Clipboard]::GetImage()` 看有没有图、`GetFormats()` 里该有 `Format17`(CF_DIBV5)、
`DeviceIndependentBitmap`(CF_DIB) 与 `PNG` 三种。**这两条命令都是先收遮罩再写剪贴板**，「遮罩已没、剪贴板
暂时还没有」是正常的，读之前等一会儿（或把 `GetFormats()` 放进短轮询）。收工别忘了
`taskkill /F /T /IM workbench.exe` 与那串 vite / cargo 子进程（见 AGENTS.md 第 6 节）。

**文字那一摊（输入框跟着合成长、落点与输入框对齐）浏览器里就能验，不必起应用**：`pnpm run build:renderer`
后把 `out/renderer` 拷到**临时目录**，在 `capture.html` 的 `<head>` 插一个经典脚本假造 `window.__TAURI__`
（`core.invoke` 认 `capture_context` / `capture_frame` / `capture_show`，帧用现造的画布 PNG 现算 ——
**`capture_frame` 现在要回 `Blob` 的 `arrayBuffer()`**，不再是 base64 字符串，`event.listen` 给空订阅），再用
几十行 node 静态服务起在临时端口（**仓库里一个文件都不用加**，验完把临时目录与产物一起删）。判据：拖选区 →
点文字工具（工具条第 7 颗 `overlay-tool`）→ 画布点一下；**`compositionstart` 之后只改 `value` 不发 input，
框不跟着长（= 修复前），补一条原生 `input` 就跟着长**；把 `scrollLeft / scrollTop` 强置非 0 再发 `scroll`，
应回 0；提交后从画布读那段字的 ink 顶行，应等于 `at.y + 探针量到的基线 − inkAscent`（24px 实测
205 = 200 + 25 − 20，按度量算的旧算法给 206）。**无头浏览器没有真输入法**，合成只能模拟；真输入法还得自己
按热键敲一遍。

**「松手不定稿」也在这个搭法里验**（同一份产物、同一套合成指针事件）：拖一个矩形松手 → 应是**选中态**
（画布上有虚线框与把手，`optionTool` 参数排也跟着它）；**工具还开着**时在它身上拖 → 移动它（选区没动、没有
第二条）；在别处拖 → 起第二笔，第一笔退成普通标注；改一次颜色 → 只有它变色；期间按 `Ctrl+Z` → 连它带微调
**整条消失**（一步）；**拖它把手改大小 / 拖身体挪位置，整个过程中画布上只该有它一份**（旧的不再画）——
判据是拖动中途取的画布像素里不该同时出现新旧两条边（把 `settledAnnotations` 换回 `annotations.value` 就能
看见两份，正是修复前）；文字同理：打一段字、点别处提交 → 选中态且文字工具已收，拖得动。
