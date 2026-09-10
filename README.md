# Workbench

前端项目控制台 —— 把「打开终端 → cd 到项目 → 选包管理器 → `npm run serve`」这套重复动作收进一个桌面应用。

一次添加项目目录，之后一键装依赖、一键启动、一键打包；打包结束自动弹出产物目录，命令输出在应用内的终端面板里实时可见，随时可停。

需求与设计见 [`docs/superpowers/specs/2026-09-10-workbench-console-design.md`](docs/superpowers/specs/2026-09-10-workbench-console-design.md)。

## 功能

**首页**

- 卡片网格下面是四块工作台面板：**系统状态**（项目 / 分组 / 运行中、node 与 nvm、包管理器可用性、数据目录）、
  **最近使用**（点名称开详情，行内直接启动 / 停止）、**最近执行**（汇总各项目最近的运行结果与耗时）、
  **快捷操作**（全局快捷键等提示）
- 面板按剩余高度铺开：项目少的时候下面不再是大片空白，窗口越高面板越舒展，1080p 最大化时自动改成两栏两行
- 一个项目都没有时换成欢迎页：上手三步 + 本机运行环境 + 快捷操作，而不是一个孤零零的按钮
- 工作区背景不上图案，只有顶部一层很淡的光晕（有项目在跑时转成暖色），不和卡片抢视线

**项目管理**

- 选目录即自动读取 `package.json`：识别框架、版本、全部 scripts、锁文件与产物目录
- 按命名约定预分类启动命令（`serve` > `dev` > `start` > 变体）与打包命令（`build` 及变体），可在界面上改
- 包管理器按锁文件判定（`pnpm` > `yarn` > `npm`），可手动覆盖；未安装时执行前拦截并说明原因
- 分组：新建 / 双击改名 / 删除；在筛选栏或「分组管理」弹窗里**拖动分组标签调整顺序**；把卡片拖到分组标签即完成归类；「未分组」标签只在真有未归类项目时出现；按分组与关键词过滤、三种排序
- **排序结果稳定**：按「最近使用」排序时，点启动不会让卡片跳到第一位（运行过就被记录，但要等你主动切换排序方式、增删项目或重启应用时才重排），避免操作时列表在眼皮底下重排
- 目录被移动或删除时卡片标记「路径无效」并屏蔽操作，支持「重新定位」
- 列表与设置默认写在 `%APPDATA%/Workbench/` 下，**数据目录可在设置里改**（整体迁移）

**一键操作**

- 安装依赖 / 启动 / 打包 / 停止 / 重启，同一项目不并发执行
- 打包成功后自动打开产物目录（探测顺序：手动配置 > 构建配置 `outDir` > `dist` 等常见目录 > 项目根目录），可项目级关闭
- 启动日志里识别 `localhost` 端口：显示在卡片上；若该端口已被别的进程占用，启动前提示占用者名称与 PID，可选择结束它后重试（不需要手填端口）
- **不代开浏览器**：地址解析只用于显示与端口占用提示，浏览器交给项目脚本自己开（如 Vite 的 `server.open`）
- 自定义命令（名称 + 命令行）挂在项目上，卡片「⋯」菜单里一键运行
- 状态机与指示灯：灰=空闲、黄=运行/安装/打包中、绿=打包成功、红=失败

**终端面板**

- **一个项目的一类操作一个终端**：同一项目的「启动」「打包」「安装依赖」以及每条自定义命令各自占一个
  Tab，输出互不覆盖，可以一边看打包日志一边跑 dev server
- 终端可关闭（× 在 Tab 上，运行中的终端要先停止）；日志只在内存里，重开应用即清空
- 应用刚启动时底部不占位置（没有终端就不渲染）；跑过一次命令后面板条常驻，条上的箭头展开/收起，收起时只留一条显示各终端状态点的窄条
- 按行推送、ANSI 转义清洗、stderr 高亮、显示当前执行命令
- 每个终端保留最近 5000 行，渲染超过 1000 行时只挂载尾部并提示省略行数
- 清空与导出为 `.log`

**系统集成（设置面板）**

- 主题：跟随系统 / 亮色 / 暗色
- 全局快捷键唤起或隐藏窗口（默认 `Ctrl+Shift+W`，可自行录制；被占用时自动停用并提示）
- **关闭按钮 = 收进托盘**：窗口不会真的关掉，托盘常驻，点托盘图标或快捷键都能找回来；最小化是否也收进托盘可单独设置
- 开机自启（默认关闭，仅打包后生效）
- 退出行为：从托盘菜单真正退出时，有项目在运行是提示确认（默认）还是直接全部停止

**Node 版本与残留清理**

- 读取 `package.json` 的 `engines.node` 或 `.nvmrc`，与系统 node 比对，不满足时提示（不阻断）
- 检测 nvm-windows 已安装的版本，可为单个项目指定 Node 版本：执行时把该版本目录前置到子进程的
  `PATH`，不动全局软链、不需要管理员权限，多个项目可以同时跑不同版本
- 应用被强杀后，下次启动会清理上次残留的 dev server（记录里带 `ownerPid`，宿主进程还活着就一律不动；
  动手前还会比对实际进程的命令行，避免 PID 被复用后杀错）

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron |
| 前端 | Vue 3（组合式 API + `<script setup>`）+ Element Plus + Pinia |
| 构建 | Vite + electron-vite |
| 语言 | TypeScript（主进程 / 渲染进程共用 `src/shared` 类型与工具） |
| 持久化 | 本地 JSON（防抖 300ms、临时文件 + rename、退出前同步落盘） |
| 子进程 | `child_process.spawn`（按行推送日志，Windows 下 `taskkill /T /F` 结束整棵进程树） |
| 测试 | Vitest |
| 打包 | electron-builder → NSIS 安装包（Windows x64） |

## 目录结构

```
src/
  main/                  主进程
    index.ts             窗口、生命周期、托盘/快捷键/主题/退出行为
    ipc.ts               IPC 处理、项目增删改查、进程操作调度
    process-manager.ts   spawn 子进程、状态机、按行日志、进程树终止、地址识别
    scanner.ts           读取 package.json / 锁文件 / 产物目录 / Node 版本要求
    nvm.ts               只读探测 nvm 已安装的 Node 版本，并按项目给子进程注入 PATH
    store.ts             数据与设置的持久化
    app-settings.ts      设置的应用（主题、快捷键、托盘、自启）
    system.ts            目录选择、打开资源管理器、端口检测、包管理器探测
  preload/index.ts       contextBridge 白名单 API
  renderer/src/          Vue 应用（组件 / Pinia store / 设计令牌）
  shared/                两端共用的类型、IPC 契约、Node 版本区间判定
scripts/make-icons.mjs   程序化生成应用图标与托盘图标
```

## 开发

```bash
npm install

npm run dev          # 启动开发态（主进程 + 渲染进程热更新）
npm run typecheck    # 渲染层与主进程两个工程一起做类型检查
npm test             # Vitest 单元测试
npm run build        # 产出 out/（main + preload + renderer）
```

## 打包

```bash
npm run icons        # 需要改图标时：重新生成 build/icon.ico 与托盘图标
npm run dist:dir     # 只产出免安装目录 dist/win-unpacked，用于快速验证
npm run dist         # 产出 NSIS 安装包 dist/Workbench-<version>-setup.exe
```

安装包为单用户（`perMachine: false`）、可选安装目录，卸载时保留 `workbench-data.json`，不会连带删掉项目列表。

打包配置见 [`electron-builder.yml`](electron-builder.yml)，其中做了两件压体积的事：

- `electronDist` 直接复用 npm 已装好的 Electron，不再重复下载 115MB
- `files` 排除 `node_modules`：渲染层已被 Vite 打成单文件，主进程只用 electron 与 Node 内置模块，
  而 electron-builder 默认会把 60MB+ 的依赖塞进 `app.asar`（排除后 asar 从 65MB 降到 3MB）

### 打包环境说明

electron-builder 首次打包要下载 `winCodeSign` / `nsis` / `nsis-resources` 三个工具包。若网络访问不了
GitHub Releases，指定镜像即可：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
npm run dist
```

另外，Windows 上没有创建符号链接的特权时（未开启开发者模式、也非管理员），`winCodeSign` 里的 macOS
动态库会解压失败。可以先手工把缓存铺好，跳过那部分：

```powershell
$seven = 'node_modules\7zip-bin\win\x64\7za.exe'
$cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$arc   = Get-ChildItem "$cache\*.7z" | Sort-Object Length -Descending | Select-Object -First 1
& $seven x -bd $arc.FullName "-o$cache\winCodeSign-2.6.0" '-x!darwin\*' '-x!linux\*'
```

未配置代码签名证书时，签名步骤会自动跳过（日志里的
`no signing info identified, signing is skipped` 属正常现象）。

## 数据与隐私

纯本地工具，不联网、不上报任何数据（命令执行本身访问网络除外）。落盘只有两处：

- **数据目录**（默认 `%APPDATA%/Workbench/`，可在设置里改成任意目录）：当前只有一个
  `workbench-data.json`，放项目列表、分组、应用设置、上次运行残留的子进程记录；以后新增的持久化数据
  也会写进这个目录，所以设置项给的是目录而不是文件
- `data-location.json`：只在改过目录后出现，固定放在 `%APPDATA%/Workbench/`，内容就一个路径

## 本期不做

多项目批量串行构建、远程部署与 Docker、代码编辑器与 Git 图形化、macOS / Linux 适配、交互式命令输入（伪终端）、多人协作与云同步。
