# 视频（本地 MP4 播放器）

## 约束

关键落点：`packages/video/src/video.ts`（MP4 过滤 / 目录树口径 / 倍速档位 / 播放顺序 / 浮窗几何，带单测）、
`apps/desktop/src-tauri/src/video.rs`（扫描与时长解析、`allow_video`）、
`apps/desktop/src-tauri/src/video_window.rs`（独立窗口与两条事件通道）、`workbench/video.ts`、
`workbench/video-window.ts`、`stores/video.ts`、`components/VideoPlayer.vue`（全局单例播放器）、
`components/VideoPlayerBar.vue` / `VideoUpNext.vue`（小窗与独立窗口共用的手柄栏 / 倒计时卡片）、`composables/use-video-stage.ts`（画中画传送宿主）、`src/renderer/video.html` +
`src/renderer/src/video-window/`。
跨模块通用事实见 [features-and-architecture.md](../features-and-architecture.md)，红线见 [AGENTS.md](../../AGENTS.md)。

- **视频按文件交给 webview 自己读，走 asset 协议**：与工作区背景图同一条边界 —— 播放前 `allow_video` 核两道（后缀
  `.mp4`、文件头第 4..8 字节 `ftyp`）后把**这一个文件**的读取权限授给 asset 协议；`tauri.conf.json` 的
  `assetProtocol.scope` 保持为空，**别往里写 `**`**（见 [../ipc-and-state/constraints.md](ipc-and-state.md)）。
- **树只收文件夹与 `.mp4`**（别的容器 webview 解码器不一定有）；点开头的目录与依赖 / 构建产物按 `notes.rs` 同一份
  名单整棵跳过。
- **左栏右键只有「读」**（笔记树那套写操作一件都不搬）：**视频行**右击给三件 —— 用默认程序打开 / 在资源管理器中显示 /
  复制路径，**文件夹行不给菜单**；三项都不动播放状态、选中与落盘，绝对路径由 `videoAbsPath` 按视频根拼。**菜单贴指针
  落点**出现（`VideoContextMenu`，与笔记正文 / 邮件清单行共用 `use-floating-position` / `use-floating-dismiss`）——
  `el-dropdown` 的 contextmenu 触发器锚在整行上、右击行尾会弹回行首，**不要再用它**；**同一时刻只有一份**。
- **播放器本体是全局单例，挂在 App.vue 上**（与终端面板同层，不随换页切换）；视频页只留目录树、头部与空态，画布上是
  一个传送宿主 —— 画中画靠 Teleport 搬元素，**元素不重建，播放一秒不断**。**悬浮是显式意图**：离开视频页**不**自动浮窗
  （接着当背景音播），点头部「悬浮播放」才浮；进视频页、在页里挑了别的视频或点小窗「回到视频页」就收回（意图是 video
  store 的内存态，不落盘）。
- **独立窗口是另一条播放路，不是 Teleport**：头部「在独立窗口播放」把当前秒数与播放态交给 `video.html` 那扇真正的顶层
  窗口（**第五个 HTML 入口**，Rust 在 `video_window.rs` 建窗），主窗口随即卸掉自己的 `<video>`（`store.detached`）。两边
  只经两条事件同步（`video-window:command` 主 → 窗口、`video-window:event` 窗口 → 主）：换视频 / 速率 / 收回 / 关闭都在
  这一对里。窗口**与主窗口同进程**，托盘、单实例与退出仍是同一套；它只读本地 MP4（asset 授权进程级共享），**不是新出口、
  不新增数据文件**。窗口入口照 pin / ball 的规矩**只装适配层，不装 store、不 initState**。
- **独立窗口的几何与置顶不落盘**：位置 / 尺寸是建窗时按主窗口摆的默认值，置顶是 Rust 内存开关，下次启动回到不置顶。
  窗口是自绘深色栏（`VideoPlayerBar`）：拖标题栏、双击最大化、拖边缘缩放、Win+方向键贴靠都保留；默认不置顶，栏上那颗
  按钮可切。
- **快捷键挂 window 的捕获阶段**：没有正播视频时一个键都不拦；视频页内整套接管（KeepAlive 的 activated / deactivated），
  悬浮小窗浮着时**只拦空格**，**独立窗口播着时主窗口一个键都不拦**（窗口自己有整套）。
- **原生媒体控件不许留住焦点**：焦点落在 `<video>` 的 UA shadow 控件（播放键 / 进度条）里时，keydown 连 window 捕获
  阶段都收不到（不是被拦，是压根不进页面），整套快捷键静默失效 —— 所以 `<video>` 的 `focus` / `focusin` 一律
  `blur()`（`releaseScreenFocus` —— 主窗口播放器与独立窗口两处都要挂）。鼠标操作不依赖焦点（click 与 pointer capture），
  别改成 `mousedown` 上 `preventDefault`：控件是脚本自己 focus 的，挡不住。
- **落盘的只有四样行为记忆**：`videoDir` / `videoDirs` / `videoTreeExpanded` / `videoLastRel`（收敛复用笔记那几个函数）；
  **播放速率与悬浮意图是会话里的记忆**（video store 内存态），不落盘；独立窗口的位置 / 尺寸 / 置顶同样只在本次运行里。
- **恢复只加载不自动播**（停在首帧）：要不要开播是 store 的显式意图（`autoplayNext`），`<video>` 上没有 `autoplay` 属性
  —— 开播只有 watch 调 `play()` 这一个来源。

## 实现

- 与笔记同一套骨架：用户挑一个文件夹当**视频库**（`videoDir`，本机目录不参与同步），左栏目录树、右边播放器。树只收
  **文件夹与 `.mp4`**，点开头与依赖目录按 `notes.rs` 同一份名单整棵跳过；每个视频带**时长徽章**（Rust 扫描解
  `moov/mvhd` 得秒数，读不出按 0），点视频**立刻开播**、点文件夹撑开 / 收起（展开态 `videoTreeExpanded`，换目录清空）。
  **缝可拖**（`videoTreeWidth`，与笔记页同一副把手）；**整栏也能收**（`videoTreeCollapsed`：0.2s 过渡收到 0 宽、
  `visibility` 拖到动画走完才生效，与导航栏收起同一套；收起时那条缝一并藏起，拖动期间左栏宽度过渡摘掉 —— 每帧都在改
  目标值，过渡只会拖泥带水）。
- **视频行右键菜单**（`VideoTree` 交给 `VideoContextMenu`：整棵树只有一份、落在指针上；右击文件夹行什么都不弹）：
  三项都是「读」——「用默认程序打开」走 `window.workbench.openPath`，「在资源管理器中显示」走 `reveal`，「复制路径」走
  `copyText`；绝对路径由 `videoAbsPath`（与笔记 `noteAbsPath` 同一份实现）按视频根拼。它们不改当前播放 / 选中 / 落盘；
  只有「打开」失败会报一句原因。
- **播放器本体是全局单例**（[VideoPlayer.vue](../../apps/desktop/src/renderer/src/components/VideoPlayer.vue)，挂在
  App.vue 与终端面板同层）：`<video>` 与速率、快捷键、播完接续都住在那里，视频页只留目录树、头部与空态，画布上是一个
  **传送宿主**（[use-video-stage.ts](../../apps/desktop/src/renderer/src/composables/use-video-stage.ts)）。**画中画** =
  点「悬浮播放」后同一个元素改在悬浮小窗渲染 —— 传送只搬元素，**元素不重建，播放一秒不断**。离开视频页**不**自动浮：
  没点过就接着出声（宿主随视频页脱离文档、画面看不见，即原先的背景音）。小窗带拖动手柄（视频名、速率、「回到视频页」、
  关闭）与**右下 / 左下两枚缩放手柄**（抓哪一角、对角钉住；左下是右上角不动、往左下长 —— 宽度变化折进左缘，不得越过
  视口），口径在 [video.ts](../../packages/video/src/video.ts) 的 `fitVideoFloatGeometry` / `resizeVideoFloat`（带单测）。
  位置与尺寸落 `videoFloatX / Y / W / H`（位置存**视口百分比**、尺寸存像素，渲染时按当前视口再压一次），拖动只改本地、
  松手落盘；「关闭」是停止播放，「回到视频页」= 收回悬浮 + 切页（进视频页、在页里挑别的视频同样收回）。**层级压过顶栏**
  （z-index 20 > 10：默认落点在右上角，恰好压住窗口按钮 —— 挡住就拖开它）；弹层与导航栏仍在它之上。
- **播放是 `<video>` 原生控件**（右下角 ⋮ 菜单整份关掉：`controlslist="nodownload noplaybackrate"` +
  `disablepictureinpicture` —— 下载对本地播放器没意义、原生速率会与 store 的 rate 脱钩、系统级画中画会把视频搬出传送
  架构），播放器补的是快捷键（挂 window **捕获阶段**，必须赶在媒体控件拿到键之前 `stopPropagation`，keyup 也拦）：
  **空格**播放 / 暂停、**← / →** 快退快进 5 秒、**↑ / ↓** 速率一档（`VIDEO_RATES` 0.5–3 倍，与两处速率下拉共用一份）。
  没有正播视频一个键都不拦；**键跟着播放器走** —— 视频页内整套接管，悬浮小窗浮着**只拦空格**（方向键让给底下那页 ——
  笔记树还要键盘导航）。树上时长徽章**定宽右对齐**成列（名字 `flex: 1` 顶过去），只有视频行有，读不出摆「--:--」。
- **原生控件焦点要当场 blur 掉**：Chromium 把媒体控件放在 `<video>` 的 UA shadow DOM 里，焦点落进那些按钮 / 进度条后
  keydown 连捕获阶段都到不了 —— 点过原生播放键、拖过进度条再按空格，要么被控件吃掉要么毫无反应（「空格暂停 / 播放偶尔
  失效」就是它：点一下画面焦点挪走就恢复）。所以 `<video>` 上 `focus` / `focusin` 都接 `releaseScreenFocus`，一贴上来就
  `blur()`；鼠标操作照常（播放键走 click、进度条走 pointer capture，都不靠焦点）。别指望 `mousedown` 上 `preventDefault`
  挡聚焦：控件是脚本里自己 focus 的，挡不住（试过）。
- **视频按文件交给 webview 读，走 asset 协议**：适配层调 `allow_video`，Rust 核两道（后缀 `.mp4`、文件头第 4..8 字节
  `ftyp`）后把**这一个文件**的读取权限授给 asset 协议，URL 由 `convertFileSrc` 转出；协议自带 Range，拖进度条不用整份下
  完；坏文件在授权那步就报错，不让用户对着黑屏猜。`assetProtocol.scope` 保持为空，**别往里写 `**`**。
- 左栏底部与笔记页同款：「**最近打开**」（`videoDirs` 最多 6 条）+ 计数 + 刷新与换文件夹。读盘失败与「里面没有视频」
  分开（前者给原因与重试）；打不开的视频在右栏把原因说出来；**选中项是视频却没在播**不冒充「是文件夹」—— 空态按真实
  kind 给「没有在播放」与原地重播。
- 播放速率是**会话里的记忆**（不落盘）：VideoPlayer 与视频页头部两个组件读同一份 store，小窗里改了回视频页还是同一个值。
  落盘的只有四样行为记忆。**上次打开的视频进页直接接上**（`videoLastRel`：树里还有才接、被删 / 改名清掉、换目录清空、
  首次扫描失败不清）；**恢复只加载不自动播**（停在首帧）：开播是 store 的显式意图（`autoplayNext`），`<video>` 上没有
  `autoplay` 属性 —— 开播只有 watch 调 `play()`。
- **播完自动接下去**：`ended` 后树里还有下一个（`nextVideoNode`，按展示顺序取当前后面的第一个）就压暗画布、摆倒计时卡片，
  `VIDEO_NEXT_SECONDS` 秒后 `goUpNext` 切过去（与点「立即播放」同一条路）；最后一个什么都不做。卡片三行：**说明 + 右端
  秒数徽章**（`--st-run` 的字压 `--st-run-soft` 的底、`margin-left: auto` 贴右缘）、名字、**主动作 + 退成纯文字的「取消」**
  （`el-button text`，两个同重的方框并排会吵）；底缘一条照秒数拉满的进度线，下面压 `--st-run-soft` 的底槽。**卡片按画布
  尺寸分两档**（`.vplayer__canvas` 是 `container-type: size` 的尺寸容器，`@container` 以「宽 400 / 高 240」为界）：大画布
  走「大气」版 —— 宽 460、四周 `--sp-5`、名字 `--fs-display` 最多两行、按钮用 EP 默认尺寸、主动作最窄 104px；画布窄于
  400 或矮于 240（默认悬浮窗 320×180 与最小的 240×135 都落这档）换紧凑版 —— 宽 340、三行之间 `--sp-2`、四周
  `--sp-2/--sp-3`、标签与秒数 `--fs-micro`、名字单行、按钮 24px 高。紧凑那档卡着最小小窗给：画布最矮只剩一百来像素，
  再松一点底缘进度线就先被顶出去。**压暗层不接事件**（pointer-events: none）—— 点重播 / 拖进度条是「用户接手了」的信号，
  遮罩拦下来这两条出口就断了。反悔都归 `clearUpNext` 一条路（点取消、动播放器、树上挑了别的）；计时器随卸载清掉。
- **独立窗口**（`video.html` + `src/renderer/src/video-window/`，Rust `video_window.rs`）：点头部「在独立窗口播放」
  （`FullScreen`）时，`VideoPlayer` 先把 `<video>` 暂停、读出 `currentTime` 与暂停态，连同当前源、速率与 `playlist`
  （`flattenVideoNodes` 摊平的展示顺序）交给 Rust；Rust 建一扇无边框、可缩放的 `video-window` 窗口，页面从同一秒接上
  （`loadedmetadata` 里 seek，`playing` 为真才 `play()`）。主窗口随即卸掉自己的 `<video>`，视频页画布只说一句「正在独立窗口
  播放」并给「收回窗口」。窗口的深色手柄栏与倒计时卡片与主窗口共用 `VideoPlayerBar` / `VideoUpNext`（卡片按画布尺寸分
  两档的 `@container` 两边都成立）；播完按 `playlist` 接下一个（窗口自己调 `loadVideo` 授权），并把新的 rel / 速率回报
  主窗口。窗口里改了速率会同步回 store。「回到视频页」= 报告当前秒数与暂停态 → Rust 唤出主窗口 → 主窗口等元数据到位后
  seek 回同一秒（暂停态保持暂停）；关掉窗口（栏上的停止 / Alt+F4）则主窗口清空 `active`。主窗口在树上挑别的视频走 `load`
  命令，不另起第二个播放器；换视频文件夹会关掉窗口。窗口与主窗口**同进程**：主窗口收进托盘不影响它继续播，退出应用时
  一起关。

## 涉及文件

```
  src/video.rs           视频文件夹（用户自己挑的一个目录，见 packages/video/src/video.ts）：递归列出
                        文件夹与 MP4（跳过点开头的目录与 notes.rs 那份噪音名单；每个 MP4
                        解一遍容器拿时长 —— 只走 ISO BMFF 盒子头找到 `moov/mvhd`，
                        `mdat` 整个 seek 过去，读不出按 0），
                        外加 allow（播放前核一个文件确实是 MP4：后缀 + 文件头 `ftyp`，
                        核过了才由 commands.rs 放行 asset 协议）
  src/video_window.rs    独立视频窗口：建 / 更新 video-window（WebviewUrl::App("video.html")，
                        无边框 + 可缩放 + 深色主题 + 会话内记住的置顶），在窗口的
                        Destroyed 上清会话并回报主窗口；两条事件通道
                        （video-window:command / video-window:event）与五条
                        video_window_* 命令都在这里
```

独立窗口的其余落点：

```
  capabilities/video-window.json   video-window 的能力（core:default + start-dragging）
  src/renderer/video.html          第五个 HTML 入口（独立视频窗口）
  src/renderer/src/video-window/   那个入口的 Vue 应用（只装适配层，不装 store）
  workbench/video-window.ts        上面五条命令 + 两条事件的适配层
  components/VideoPlayerBar.vue    悬浮小窗与独立窗口共用的深色手柄栏（含置顶开关）
  components/VideoUpNext.vue       两处共用的播完倒计时卡片
```

渲染层两处（原注解）：

```
    video.ts            视频的适配包装（workbench/）
    video.ts             视频：视频目录（用户挑的文件夹）、最近打开的那几个、
                         扫出来的目录树、正在播放的那一个、播放速率与悬浮 / 独立窗口的
                         意图（内存态 —— 播放器本体是全局单例 VideoPlayer.vue，
                         画中画与独立窗口见上文）（stores/）
```
