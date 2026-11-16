# 目录结构

monorepo 的树与逐项注解；逐包分工与语言约定见 [features-and-architecture.md](features-and-architecture.md) 的「技术栈」。

树里只留底座与一行式条目；各模块自己的文件与链路注解，见 `modules/<模块>.md` 的「涉及文件」。

```
apps/desktop/            桌面应用（自包含：渲染层 + Rust + 随包资源 + 构建脚本）
  src-tauri/               Rust 后端
  src/main.rs            入口、窗口、托盘、单实例、生命周期
  src/panic_log.rs       panic 落痕（release 是 panic=abort，崩溃证据只留这一份）—— 注解见 modules/ipc-and-state.md
  src/hang_watch.rs      挂起看门狗（主线程停泵消息时把现场写进 hang.log）—— 注解见 modules/ipc-and-state.md
  src/error_log.rs       错误日志（后台链路的失败收进 error.log）—— 注解见 modules/ipc-and-state.md
  src/commands.rs        IPC 命令层（薄：取数据 / 落盘 / 调系统能力）
  src/session.rs         子进程会话：起命令、按批回传输出、按进程树终止
  src/proc.rs            带超时的子进程原语 + 进程树终止
  src/store.rs           去抖 JSON 落盘（300ms 合并 + 临时文件 rename）
  src/fs_util.rs         文件底座：路径守卫（is_plain_segment）与原子写 —— 注解见 modules/ipc-and-state.md
  src/paths.rs           数据目录与指针（安装版与旧 Electron 版同一位置，开发版另用 Workbench-dev）
  src/system.rs          端口检测（GetExtendedTcpTable）、资源管理器、ShellExecute
  src/nvm.rs             nvm 只读探测 —— 注解见 modules/projects.md
  src/nrm.rs             nrm 探测与镜像源切换 —— 注解见 modules/projects.md
  src/token.rs           用量数据源聚合 —— 注解见 modules/sync-and-auth.md
  src/notes.rs           笔记文件夹的扫描 / 读写 / 增删改名 —— 注解见 modules/notes.md
  src/md_window.rs       资源管理器「打开方式」的独立 Markdown 编辑窗口（会话 / 关闭握手）—— 注解见 modules/notes.md
  src/sync.rs            同步与 git 管道（各域分片的推 / 读）—— 注解见 modules/sync-and-auth.md
  src/sync_images.rs     笔记图片仓库的上传 / 列清单 / 删图 —— 注解见 modules/notes.md
  src/relay_core.rs      两套网关（TBuddy / Qoder）共用的配置 / 密钥 / 启停 / 状态形状
  src/repo_git.rs        Git 页的只读仓库读取（仓库 / 分支清单 / 提交 / 目录树 / 文件历史 / 差异 / 补丁）
                         —— 注解见 modules/git-client.md
  src/design.rs          设计规范落盘 —— 注解见 modules/styles.md
  src/skills.rs          技能库 —— 注解见 modules/skills.md
  src/kb.rs              知识库 —— 注解见 modules/kb.md
  src/ai.rs              AI 助手宿主侧 —— 注解见 modules/ai.md
  src/pi_skills.rs       Pi 的技能 —— 注解见 modules/ai.md
  src/video.rs           视频文件夹扫描与 allow —— 注解见 modules/video.md
  src/video_window.rs    独立视频窗口与两条事件通道 —— 注解见 modules/video.md
  src/screen.rs          Win32 抓屏（BitBlt）与光标位置 —— 注解见 modules/screenshot.md
  src/capture.rs         截图会话与遮罩窗口 —— 注解见 modules/screenshot.md
  src/clipboard.rs       往系统剪贴板放图（CF_DIBV5 / CF_DIB / PNG）—— 注解见 modules/screenshot.md
  src/pin.rs             钉图窗口与记账 —— 注解见 modules/screenshot.md
  src/ball.rs            网速球窗口、收起 / 展开与贴边判定 —— 注解见 modules/float-ball.md
  src/net.rs             网卡累计字节与链路速率（GetIfTable2，64 位计数器）—— 注解见 modules/float-ball.md
  src/oauth.rs           账号登录 —— 注解见 modules/sync-and-auth.md
  src/http.rs            WinHTTP 极简 HTTP 客户端 —— 注解见 modules/ipc-and-state.md
  src/weather.rs         实时天气宿主侧 —— 注解见 modules/home.md
  src/ai_news.rs         AI 热点：源白名单、ETag 条件请求与缓存落盘 —— 注解见 modules/home.md
  src/mail.rs            邮箱（IMAP/SMTP 传输）—— 注解见 modules/mail.md
  src/mail_watch.rs      邮件后台监视（按设置周期的新邮件检查 + 系统通知）—— 注解见 modules/mail.md
  src/zentao.rs          禅道：后台检查用的 API 认证与会话、只读单页请求、可见产品清单，
                         以及用系统浏览器打开站点
                         —— 注解见 modules/zentao.md
  src/notify.rs          Windows toast 的手写 WinRT FFI —— 注解见 modules/mail.md
  src/credentials.rs     Windows 凭据管理器读写 —— 注解见 modules/ipc-and-state.md
  src/vault.rs           密码保险库宿主侧 —— 注解见 modules/vault.md
  src/encoding.rs        base64 / SHA-256 / UTF-16 —— 注解见 modules/ipc-and-state.md
  src/etf.rs             ETF 资金流：三个行情主机的白名单与拉取、缓存落盘 —— 注解见 modules/etf.md
  src/icon.rs            程序图标抽取 —— 注解见 modules/quick-launch.md
  src/imaging.rs         图片解码校验与缩略（背景图核文件头、壁纸缩略图）—— 注解见 modules/ipc-and-state.md
  oauth.example.json     OAuth 应用凭据与禅道账号密码模板（真实凭据放 oauth.local.json，不入库）
  tauri.conf.json        窗口、打包、资源映射
  capabilities/          能力白名单

  src/renderer/           六个 HTML 入口：index.html（主界面）、capture.html（截图遮罩）、
                         pin.html（钉图）、ball.html（网速球）、video.html（独立视频窗口）、
                         markdown.html（资源管理器「打开方式」的独立 Markdown 编辑窗口）。
                         后五个是独立窗口、各自的 JS 上下文，只装适配层、不装 store
                         （见 modules/screenshot.md、modules/float-ball.md、modules/video.md、
                         modules/notes.md）
  src/renderer/src/       Vue 应用（组件 / Pinia store / 设计令牌）
  workbench/             window.workbench 的适配层（原 preload + 主进程逻辑的替代品）：
                         底座五件（bridge / events / state / session / scanner）的注解见
                         modules/ipc-and-state.md，各模块适配文件的注解
                         见各模块的「涉及文件」
  components/            公共与页面组件（各页组件的分工写在 modules/<模块>.md 的「涉及文件」，
                            跨页共用的几个底座：AppDialog / EmptyState / MarkdownView / PanelLoading / ProjectTag）
  composables/           跨组件复用的交互骨架（use-pointer-drag：拖拽的起手 / 收手 / Esc 取消 /
                         解绑；use-floating-dismiss：浮层的收起；use-video-stage：画中画
                         传送宿主的注册；use-wall-clock：每秒时钟与「今天 00:00」的模块级单例；
                         use-draft-field：设置 / 抽屉的草稿字段；use-token-usage：首页用量卡片的
                         快照 → 实读顺序、60 秒轮询与手动同步。拖拽与浮层那几个带单测）
  notify.ts              非组件代码「说一句话 / 问一句」的唯一出口（可被测试顶替）
  stores/                跨组件状态，按领域分文件：nav.ts（当前页与首页布局编辑态）与
                         settings.ts（设置本体与装配；主题内核 / 首页布局 / 别台机器的外观分别由
                         settings-theme.ts / settings-layout.ts / settings-sync.ts 提供，背景在
                         settings-background.ts）是壳层，见上面的「导航与页面」「系统集成」；
                         ai.ts 是 AI 助手的编排层，运行态 / 配置 / 运行时 / 服务四个叶子分别住在
                         ai-run-state.ts / ai-config.ts / ai-runtime.ts / ai-providers.ts；
                         work-log.ts 是「工作页写、首页今日完成读」的同一份日志。
                         其余各 store 的注解见 modules/<模块>.md 的「涉及文件」
  types/                 应用级契约：api/（按域的 *Channel，index.ts 只把它们的并集立成
                         WorkbenchApi）、settings.ts（AppSettings 与 DEFAULT_SETTINGS）、
                         index.ts（其余形状 + 各域包的 re-export 桶）、
                         contract.generated.ts（Rust `// @contract` 结构 → TS，`pnpm run contract:gen`
                         生成、`contract:check` 拦漂移），`@/types` 照旧一站式取类型
  persisted-data.ts      数据文件的收敛编排 + theme.json ↔ 数据文件的分流桥接

packages/                按域拆出的 19 个 @workbench/* 包（TS 源码直出、各自带 vitest；
                         包之间与应用都只按包名走各自的 index.ts 桶导入）：
  core/                  平台原语：Result 与 ok/fail、base64 与 delay、端口与项目路径、dev-port、扫描
                         （scanner，fs 注入）、命令与快捷启动的收敛、图标缓存、残留进程判定、
                         项目标识色的分配、项目排序的取值、markdown 渲染、text-diff
  notes/                 笔记的文件名与目录树口径、图片的命名与访问地址拼接
  video/                 MP4 过滤 / 目录树口径 / 倍速档位与时间、时长显示、播放顺序（flattenVideoNodes）
  appearance/            外观口径与默认外观的唯一来源、主题、views、工作区背景与壁纸、
                         同步仓库里的外观配置（sync-config）、悬浮小窗的位置 / 尺寸档位
                         （video-float）、
                         设计样式的 token 模型与键名中文标签规则、色系判定与筛选排序、
                         设计示例页面的颜色角色解析（design-demo）、设计规范与提示词的
                         生成（design-export）
  terminal/              ansi、log-ring、log-scroll、terminal-key
  kb/                    知识库的布局常量（raw/ + data/ 两层 + 清单 raw/kb.json）/
                         入库状态口径（source 配对 + 内容指纹比较，旧条目回落 mtime；
                         kb.ts）、清洗提示词（kb-clean.ts）、知识库名与清单的解析收敛、
                         名称核对与失联分组（kbSourceNameHint / kbDanglingGroups，
                         见 modules/kb.md）
  skills/                技能的 frontmatter 解析与路径口径、项目副本与库的差异判定
                         （compareSkillCopy，见 modules/skills.md）
  ai/                    AI 服务与模型清单的形状 / 收敛、厂商预设表、按模型名认上下文、
                         内置模型目录（ai-builtin-models.generated.ts，由 vendor-pi 生成）、
                         AI 热点的 RSS 解析与缓存策略（ai-news.ts）、Pi 技能的根与开关口径
                         （pi-skills.ts）
  usage/                 Token 用量口径（token-usage.ts）、
                         四个 IDE 日志源（codebuddy / qoder / dsh / workbuddy-log）
  work-log/              工作日志的时间轴
  git/                   Git 页的回包收敛、统一 diff 行模型、最近打开清单与类型（见 modules/git-client.md）
  vault/                 密码保险库的条目模型 / 信封 / 合并 / 加解密
  auth/ 、 weather/       账号资料的收敛；实时天气的 WMO 码表与两条接口回包的解析
  mail/                   邮箱账户配置的收敛、通讯录的收敛（contacts.ts）、RFC 2047 编解码、
                          发信报文构建（mime.ts）、
                          收信解析与沙箱正文（parse.ts，postal-mime 包装）、广告邮件识别（bulk.ts）
  capture/               截图与钉图的纯逻辑：选区几何与八个把手、标注模型与命中判定、撤销栈、
                          放大镜取样、三层坐标换算、钉图缩放与透明度、截图文件名，以及那两个
                          窗口与后端来回的线格式（wire.ts）
  zentao/                禅道的分页校验、跨产品 Bug 汇总 / 去重 / 排序、新增判定与检查周期收敛
                         （列表已不在界面上显示，这一包只服务后台检查与通知）
  net-meter/             网速球的纯逻辑：累计字节 → 速率的换算与采样间隔的两条界、指数滑动平均、
                          单位进位（B/K/M/G，进位在取整之后复查一遍）、
                          表盘量程的自动换挡（1M / 2M / 4M / 8M…，换挡点是量程的一半）、
                          刻度环表盘的几何与尺寸常量（与 ball.rs 必须一致的那几个），以及 IPC 契约（wire.ts）
  etf/                   ETF 资金流的纯逻辑：23 只宽基名单、沪深交易所 / 天天基金三个源的
                          解析、增量缓存的收敛与合并（含跨机 `mergeEtfCacheInto`）、五年回填规划、
                          净买卖计算（含折算置零）与窗口聚合（见 modules/etf.md）

apps/desktop/scripts/    make-icons.mjs（程序化生成应用图标与托盘图标）、
                         vendor-pi.mjs（Pi 随包内置与瘦身）、
                         sync-vditor-assets.mjs（Vditor 静态资源随包 —— 注解见
                         modules/notes.md）
.github/workflows/       release.yml（打 vX.Y.Z 的 tag → 过闸 typecheck + 测试 → 打 Windows x64 的
                         NSIS 包 → 建 Release 并挂上安装包；版本字段与 CHANGELOG 对不上就停；
                         配了 SignPath 那几项就把安装包送签、发签名后的包，没配则照旧发未签名的包 ——
                         配置清单与申请步骤见该文件头部注释）
scripts/                 bump-version.mjs（发版前把版本写进那几处、把 CHANGELOG 的「未发布」升成
                         正式版本节；--check 只对账、--notes 抽 Release 正文，流水线里跑的就是它）
CHANGELOG.md             一个版本一节（新特性 / 修复 / 调整），Release 的正文取的就是这一节
```
