# 视频（本地 MP4 播放器）

视频（本地 MP4 播放器）的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`shared/video.ts`（MP4 过滤 / 目录树口径 / 倍速档位 / 浮窗几何，带单测）、
`apps/desktop/src-tauri/src/video.rs`（扫描与时长解析、`allow_video`）、`workbench/video.ts`、`stores/video.ts`、
`components/VideoPlayer.vue`（全局单例播放器）、`composables/use-video-stage.ts`（画中画传送宿主）。

- **视频按文件交给 webview 自己读，走 asset 协议**：与工作区背景图同一条边界 ——
  播放前 `allow_video` 核两道（后缀 `.mp4`、文件头第 4..8 字节 `ftyp`）后把**这一个文件**
  的读取权限授给 asset 协议；`tauri.conf.json` 的 `assetProtocol.scope` 保持为空，
  **别往里写 `**`**（见 [../ipc-and-state/constraints.md](ipc-and-state.md)）。
- **树只收文件夹与 `.mp4`**（别的容器 webview 里的解码器不一定有）；点开头的目录与
  依赖 / 构建产物目录按 `notes.rs` 的同一份名单整棵跳过。
- **播放器本体是全局单例，挂在 App.vue 上**（与终端面板同层，不随换页切换）；
  视频页只留目录树、头部与空态，画布上是一个传送宿主 —— 画中画靠 Teleport 搬运元素，
  **元素不重建，播放一秒不断**。
- **快捷键挂在 window 的捕获阶段**：没有正播视频时一个键都不拦；视频页内整套接管
  （KeepAlive 的 activated / deactivated），悬浮小窗在别的页上时**只拦空格**。
- **落盘的只有四样行为记忆**：`videoDir` / `videoDirs` / `videoTreeExpanded` / `videoLastRel`
  （收敛复用笔记那几个函数）；**播放速率是会话里的记忆**（video store 内存态），不落盘。
- **恢复只加载不自动播**（停在首帧）：要不要开播是 store 里的显式意图（`autoplayNext`），
  `<video>` 上没有 `autoplay` 属性 —— 开播只有 watch 调 `play()` 这一个来源。

## 实现


- 与笔记同一套骨架：用户挑一个文件夹当**视频库**（`videoDir`，本机目录不参与同步），左栏目录树、
  右边播放器。树只收**文件夹与 `.mp4`**（别的容器 webview 里的解码器不一定有），点开头与
  依赖目录按 `notes.rs` 同一份名单整棵跳过；每个视频带**时长徽章**（Rust 扫描解 `moov/mvhd`
  得秒数，读不出按 0），点视频**立刻开播**、点文件夹撑开 / 收起（展开态 `videoTreeExpanded`，
  换目录清空）。**缝可拖**（`videoTreeWidth`，与笔记页同一副把手）；**整栏也能收**
  （`videoTreeCollapsed`：0.2s 过渡收到 0 宽、`visibility` 拖到动画走完才生效，与导航栏收起同一套；
  收起时那条缝一并藏起，拖动期间左栏的宽度过渡摘掉 —— 每帧都在改目标值，过渡只会拖泥带水）
- **播放器本体是全局单例**（[VideoPlayer.vue](../../apps/desktop/src/renderer/src/components/VideoPlayer.vue)，
  挂在 App.vue 与终端面板同层，不随换页切换）：`<video>` 与速率、快捷键、播完接续都住在那里，
  视频页只留目录树、头部与空态，画布上是一个**传送宿主**
  （[use-video-stage.ts](../../apps/desktop/src/renderer/src/composables/use-video-stage.ts)）。
  **画中画** = 切到别的页时同一个元素改在悬浮小窗渲染 —— 传送只搬元素，**元素不重建，播放一秒不断**。
  小窗带拖动手柄（视频名、速率、「回到视频页」、关闭）与**右下 / 左下两枚缩放手柄**
  （抓哪一角、对角钉住；左下是右上角不动、往左下长 —— 宽度变化折进左缘，不得越过视口），
  口径在 [video.ts](../../packages/video/src/video.ts) 的 `fitVideoFloatGeometry` / `resizeVideoFloat`
  （带单测）。位置与尺寸落 `videoFloatX / Y / W / H`（位置存**视口百分比**、尺寸存像素，渲染时按当前
  视口再压一次），拖动只改本地、松手落盘；「关闭」是停止播放，「回到视频页」只是切页。
  **层级压过顶栏**（z-index 20 > 10：默认落点在右上角，恰好压住窗口按钮 —— 挡住了拖开它就是）；
  弹层与导航栏仍在它之上
- **播放是 `<video>` 原生控件**，播放器补的是快捷键（挂 window **捕获阶段**，必须赶在媒体控件
  自己拿到键之前 `stopPropagation`，keyup 也拦）：**空格**播放 / 暂停、**← / →** 快退快进 5 秒、
  **↑ / ↓** 速率一档（`VIDEO_RATES` 0.5–3 倍，与两处速率下拉共用一份）。没有正播的视频一个键都不拦；
  **键跟着播放器走** —— 视频页内整套接管（KeepAlive 的 activated / deactivated），悬浮小窗在别的页上
  **只拦空格**（方向键让给那一页 —— 笔记树还要键盘导航）。树上的时长徽章**定宽右对齐**成列
  （名字 `flex: 1` 把它顶过去），只有视频行有，读不出摆「--:--」
- **视频按文件交给 webview 读，走 asset 协议**：适配层调 `allow_video`，Rust 核两道（后缀 `.mp4`、
  文件头第 4..8 字节 `ftyp`）后把**这一个文件**的读取权限授给 asset 协议，URL 由 `convertFileSrc`
  转出；协议自带 Range，拖进度条不用整份下完；坏文件在授权那步就报错，不让用户对着黑屏猜。
  `assetProtocol.scope` 保持为空，**别往里写 `**`**
- 左栏底部与笔记页同款：「**最近打开**」（`videoDirs` 最多 6 条）+ 计数 + 刷新与换文件夹。
  读盘失败与「里面没有视频」分开（前者给原因与重试）；打不开的视频在右栏把原因说出来；
  **选中项是视频却没在播**不冒充「是文件夹」—— 空态按真实 kind 给「没有在播放」与原地重播
- 播放速率是**会话里的记忆**（不落盘）：VideoPlayer 与视频页头部两个组件读同一份 store，
  小窗里改了回视频页还是同一个值。落盘的只有四样行为记忆：`videoDir` / `videoDirs` /
  `videoTreeExpanded` / `videoLastRel`（收敛复用笔记那几个函数）。**上次打开的视频进页直接接上**
  （`videoLastRel`：树里还有才接、被删 / 改名清掉、换目录清空、首次扫描失败不清）；
  **恢复只加载不自动播**（停在首帧）：开播是 store 的显式意图（`autoplayNext`），
  `<video>` 上没有 `autoplay` 属性 —— 开播只有 watch 调 `play()` 这一个来源
- **播完自动接下去**：`ended` 后树里还有下一个（`nextVideoNode`，按展示顺序取当前后面的第一个）
  就压暗画布、摆倒计时卡片（名字 + 剩余秒数用 `--st-run` + 「立即播放 / 取消」，底缘一条
  `VIDEO_NEXT_SECONDS` 秒拉满的进度线），拉满即切、与点「立即播放」同一条路（`goUpNext`）；
  最后一个就什么都不做。**压暗层不接事件**（pointer-events: none）—— 点重播 / 拖进度条是
  「用户接手了」的信号，遮罩拦下来这两条出口就断了。反悔都归 `clearUpNext` 一条路
  （点取消、动播放器、树上挑了别的）；计时器随卸载清掉


## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

```
  src/video.rs           视频文件夹（用户自己挑的一个目录，见 shared/video.ts）：递归列出
                        文件夹与 MP4（跳过点开头的目录与 notes.rs 那份噪音名单；每个 MP4
                        解一遍容器拿时长 —— 只走 ISO BMFF 盒子头找到 `moov/mvhd`，
                        `mdat` 整个 seek 过去，读不出按 0），
                        外加 allow（播放前核一个文件确实是 MP4：后缀 + 文件头 `ftyp`，
                        核过了才由 commands.rs 放行 asset 协议）
```

渲染层两处（原注解）：

```
    video.ts            视频的适配包装（workbench/）
    video.ts             视频：视频目录（用户挑的文件夹）、最近打开的那几个、
                         扫出来的目录树、正在播放的那一个、播放速率（内存态 ——
                         播放器本体是全局单例 VideoPlayer.vue，画中画见上文）（stores/）
```
