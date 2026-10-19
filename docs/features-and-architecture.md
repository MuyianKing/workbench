# 功能与架构

Workbench 的文档按「通用 / 模块」分层：

- **本文件**只装跨模块的通用事实（导航壳层、设置面板、技术栈、目录结构、数据与隐私），
  末尾附模块索引；
- **[modules/](modules/)** 下每个模块一份 `<模块>.md`：开头「约束」一节是**不能破的规矩**（动手前先读），
  后面「实现」一节装实现细节（为什么这么做、踩过哪些坑、数据落在哪），末尾是「涉及文件」；
- 工程约束的骨架在 [AGENTS.md](../AGENTS.md)（跨模块红线 + 模块索引），概览与上手在
  [README.md](../README.md)，动手方法与施工记录在 [dev-notes/](dev-notes/)。

改功能或调架构时：**模块内的改动改对应那份模块文档（规矩动「约束」节、事实动「实现」节），
跨模块的通用事实才改本文件**。

## 模块索引

| 模块 | 文档（先读「约束」一节） |
| --- | --- |
| 首页（画布与九块卡片） | [home.md](modules/home.md) |
| 快捷启动（常用软件） | [quick-launch.md](modules/quick-launch.md) |
| 项目（含一键操作、Node 清理、nrm） | [projects.md](modules/projects.md) |
| 工作日志 | [work-log.md](modules/work-log.md) |
| 笔记 | [notes.md](modules/notes.md) |
| 技能（skill） | [skills.md](modules/skills.md) |
| 知识库（kb） | [kb.md](modules/kb.md) |
| AI 助手（ai） | [ai.md](modules/ai.md) |
| 密码保险库 | [vault.md](modules/vault.md) |
| 邮箱（IMAP 收发） | [mail.md](modules/mail.md) |
| 禅道（独立窗口 + 后台检查与通知） | [zentao.md](modules/zentao.md) |
| 样式（设计参考库） | [styles.md](modules/styles.md) |
| 视频（本地 MP4 播放器） | [video.md](modules/video.md) |
| 截图与钉图（capture） | [screenshot.md](modules/screenshot.md) |
| 终端面板 | [terminal.md](modules/terminal.md) |
| 用量与外观同步、账号登录 | [sync-and-auth.md](modules/sync-and-auth.md) |
| 通道、状态与落盘（底座） | [ipc-and-state.md](modules/ipc-and-state.md) |

## 功能

**导航与页面**

- 窗口分两层：顶部一条通栏（标题栏 + 欢迎语），下面才是「左侧导航栏 + 内容列」。导航栏 88px，
  做成一张**卡片**浮在画布上（与首页面板同一副外壳，底色浓度跟着「卡片不透明度」走），
  高度贴着内容、菜单多时自己撑高；终端留在内容列里，不横跨导航栏
- **当前项那块底会滑过去**（[NavRail.vue](../apps/desktop/src/renderer/src/components/NavRail.vue)）：
  底色不画在按钮上，而是那列里一块绝对定位的浮底 `.nav__pill` —— 位置与尺寸按当前项的盒量出来
  （横向也量：菜单长到出滚动条时内容盒会窄一点），换页 / 换序时走 `transform` 滑过去（0.24s，
  `prefers-reduced-motion` 下不动），老项闪一下新项亮一下那种做法就没了。按钮只留图标与文字，
  `z-index` 抬在浮底之上：浮底滑过中间几项时从它们下面过，不盖住图标
- **弹层开着时导航栏照样点得到**：遮罩铺满整窗，导航栏抬到它之上（`z-index` 取 int32 上限 ——
  Element Plus 弹层是 2000 起步、每开一个 +1 的动态值，写常数迟早被追平，上限追不上）。
  抬上去的只是**遮罩**，弹框不许爬进那一列：弹框按整窗居中，窗口一窄宽弹框就会钻到菜单底下，
  所以 `.el-dialog` 统一封了最大宽度 `calc(100vw - var(--dialog-inset) * 2)`
  （`--dialog-inset` = 导航栏宽度 + 卡片间距上限，见 [tokens.css](../apps/desktop/src/renderer/src/styles/tokens.css)）——
  宽弹层在各处自己给的 `width` 照旧，封顶只在窄窗口下生效，弹框因此永远落在导航栏右边。
  **换页不收弹层**：弹框挂在 `body` 上不随页面隐藏，切走再切回来还是它，填到一半的输入不丢
- **填内容的弹层不挡背后**（[AppDialog.vue](../apps/desktop/src/renderer/src/components/AppDialog.vue) 的 `penetrable`）：
  密码、工作记录、命令、常用软件、添加项目、起名字、素材管理这几个弹层，遮罩只围住弹框自己 ——
  典型场景是「添加密码」时切到笔记页复制、回来粘进弹框，全程不关弹框。
  确认框（`ElMessageBox`）与退出确认框仍然挡住（必须看见的决定），设置 / 技能这类不抄内容的照旧挡点击。
  **所有弹层都走 AppDialog**：`append-to-body`、挡不挡背后、可拖动都只写在那个组件里，调用处不必（也不该）重复
- **弹窗可以拖**（抓手是标题栏，`AppDialog` 统一开）：把弹框拖开一点，被压住的正文就露出来；
  关掉后位置复位。头部被 CSS 藏掉的弹层（自绘头部的技能详情那种）拖不了
- **提示条（`ElMessage`）浮在顶栏下沿，不是窗口最顶上**：那里是拖窗口的地方，标题栏与应用名字也在那儿，
  一条提示压上去既挡事又离「刚点的那颗按钮」很远。位置与外观都在
  [global.css](../apps/desktop/src/renderer/src/styles/global.css) 的 `.el-message` 一处给 ——
  居中、`margin-top` 让开 `--h-titlebar + --h-header`、不透明面底色 + 一条状态色左侧竖条 + 卡片阴影
  （默认那套「浅色底 + 同色字」压在壁纸上几乎看不见）。**调用处不要传 `placement` / `offset`**：
  前者会跟那条上边距打架（`bottom` 那档会被往下推），后者会绕过它。
  多条同时出现时的叠放仍由 EP 自己算（它按「基准 + 前几条的高度」排，统一加一段上边距不影响间距）
- 当前页只是 store 里的一个 id（取值登记在 `packages/appearance/src/views.ts`），**不引入 Vue Router**：
  换页就是换这个值，`App.vue` 用 `<KeepAlive><component :is>` 渲染，滚动位置不丢；
  当前页随数据文件落盘，重启回到上次那一页。新增一页 = 登记 id + 挂组件两处
- 当前十二页：**首页**（可自由布局的卡片画布）、**项目**（项目卡网格 + 分组筛选工具条）、
  **工作**（工作日志时间轴）、**笔记**（左目录树 + 右 markdown 编辑器）、
  **技能**（技能库管理，见[「技能」](modules/skills.md)一节）、**知识库**（看一个独立的知识库项目、一键清洗，
  见[「知识库（kb）」](modules/kb.md)一节）、**AI 助手**（请本机的 Pi 干活的通用控制台，
  见[「AI 助手（ai）」](modules/ai.md)一节）、**密码**（密码保险库，见[「密码保险库」](modules/vault.md)一节）、
  **样式**（74 套设计语言的参考库，见[「样式」](modules/styles.md)一节）、**视频**（本地 MP4 播放器，见[「视频」](modules/video.md)一节）、
  **邮箱**（IMAP 收发，见[「邮箱」](modules/mail.md)）与**禅道**（顶栏右侧那颗图标打开的独立窗口 + 后台检查与通知，见[「禅道」](modules/zentao.md)）。
  布局编辑态由顶栏那颗「编辑布局」进入，欢迎语那一行原地换成操作条，行高不变、画布不跳。
  那行提示**不换行**，窄窗口下让位给右侧按钮而不把顶栏顶宽：`.app` 与 `.topbar` 的列定义带 `minmax(0, 1fr)`、
  `.header` 与提示自己带 `min-width: 0` + `overflow: hidden` + 省略号 —— 这条链少一环，
  窗口一窄顶栏就横向溢出，右侧按钮被推出点不着
- **每个模块的首次取数都有自己的加载态**（[PanelLoading.vue](../apps/desktop/src/renderer/src/components/PanelLoading.vue)）：
  一枚转圈加一句浅灰说明，加在卡片 / 页面自己身上，**没有全屏 loading**；盒子与 global.css 的 `.empty` 同款，
  在 `.panel` 这类纵向 flex 容器里自动撑满。底线是「首帧不说『还没有』」，由 `projects.ready` 或各自组件的读取标志说了算。
  三处需要 store 专门出标志：environment store 的 `probing`（初值 true —— refreshAll 排在 loadData 之后才发出，
  那几秒「还没问到」已成立）、vault store 的 `keyChecked`（不闪「创建保险库」引导）、
  skills store 的 `loading`（从探测仓库那步就置位，探测慢时不说「还没有技能」）
- **空态要配图**（[EmptyState.vue](../apps/desktop/src/renderer/src/components/EmptyState.vue)）：一栏 / 一整页 /
  弹层的正文区空着时，摆的是一张**小图**（一张浮着的小卡片里顶一枚图标，底下压一道投影，
  沿用邮箱那一栏空态原本那副场景）+ 一句事实，第二行小字说「空着的原因 / 去哪儿做」，
  动作按钮走 `#actions`；窄地方用 `compact` 那档。**不许只留一行干字**。
  面板里那种几十像素高的地方（首页卡片、日志框里的一行、编辑态的空栏提示、下拉里的空项）
  仍走 global.css 的 `.empty` + `.empty__icon`（淡淡一枚图标）—— 那里塞不下一张图，
  也是这套规矩的例外，别把大图硬塞进小格子。
- **导航栏显示哪几页、按什么顺序，都可以在设置里配**（设置 → 菜单那一屏）：存的是「关掉了哪些」（`hiddenViews`）
  与「显示的先后」（`viewOrder`）—— 存这一侧是为了将来加一页时老配置没有它、新页默认可见，不必动谁的数据文件。
  四条约定：**顺序由用户拖出来**（首页钉在最上；顺序只影响先后、与关没关无关，收敛见 `sanitizeViewOrder`，落下的新页补在末尾）；
  **至少留一页**（`sanitizeHiddenViews` 拦下全关，界面上最后一颗开关禁用）；
  **关掉只是收起来不是删掉**（当前页被关时退到第一页可见的，主动切页照旧 —— 那条 watch 只认「关掉的清单变了」，见 stores/nav.ts）
- 这两项都住在 `theme.json` 里跟着外观同步走；「上次停在哪一页」的 `activeView` 留在数据文件里 ——
  那是机器状态，不是配置
- **整条导航栏可以收起来**（顶栏右上角那颗折叠按钮，`navHidden`）：收起后内容列占满整行，换页入口在那颗按钮上。
  收起**不是卸载**：导航栏常驻挂载，`is-hidden` 一组过渡把宽、边距与边框收到 0（0.2s，`visibility` 拖到动画走完才生效），
  外壳不占、没有跳变；它也住 `theme.json` 跟外观同步走，重启保持收起前的样子

**截图与钉图**

- 按截图快捷键（默认 **F1**）或托盘菜单里的「截图」起一次：**抓齐所有屏**、每块屏铺一层
  「冻结画面」的遮罩（无边框、置顶、不上任务栏），光标在哪块屏就在哪块屏上动手。同一个快捷键
  再按一次 = 取消整场。遮罩窗口是**预建好、跨场复用**的（每块屏常驻一块 webview）：
  按热键之后只走「抓屏 → 编码 → 塞帧 → 显示」，不再现等一块 WebView2 起来 ——
  这是这条链能快到两百毫秒级的唯一原因（见[「截图与钉图」](modules/screenshot.md)）
- 框选一块、双击选整屏、Ctrl+A 全选；八个把手可调、方向键微调（按住 Shift 走十格）、
  拖选区内部是整体挪动。选区角上实时给出「宽 × 高」，光标旁边有**放大镜与像素颜色读数**
  （挡视线时可在设置里关掉）。右键先取消选区，没选区了才退出整场
- 七个标注工具：**矩形 / 椭圆 / 箭头 / 画笔 / 荧光笔 / 马赛克 / 文字**（文字可多行：
  回车换行、不限长度，输入框宽高跟着内容长）；颜色八档、线宽三档、
  马赛克格子三档、字号三档。画过的东西还能**点中**（虚线框 + 把手）：拖整条挪位置、
  **拖把手改大小**（矩形 / 椭圆 / 马赛克八个把手，箭头两端各一个）、
  **工具条上的颜色 / 线宽 / 字号改的就是它这一条**、Delete 删掉，
  Ctrl+Z / Ctrl+Shift+Z 撤销重做 —— 不是「画完就烘死」
- 三个出口：**复制到剪贴板**（Enter / Ctrl+C，一次给齐 DIB 与 PNG 两种格式，老程序也粘得上）、
  **保存成 PNG**（Ctrl+S）、**钉到屏幕上**（Ctrl+D）。设过「自动保存位置」就直接落进去
  （同名自动加序号），没设过才弹一次「另存为」。Esc 逐层退：输入框 → 工具 → 选区 → 退出
- **钉图**是一张置顶、无边框、拖着就走的图窗口：滚轮缩放（以光标为不动点、保持长宽比）、
  Ctrl+滚轮调透明度（20%~100%）、右键菜单（复制 / 另存为 / 适应屏幕 / 关闭）、
  双击或 Esc 关掉，悬停时描一圈边好认出边界。**位置、大小与透明度会记账** —— 下次启动
  照原样钉回来（图还在的话）
- 已知边界（都是有意留的，见[「截图与钉图」](modules/screenshot.md)）：独占全屏的游戏画面抓出来是黑的、
  HDR 屏颜色偏淡、UAC 的安全桌面抓不到（Windows 就不给）；**选区不跨屏**（拖到屏幕边缘就停）；
  **没有取字 / OCR** —— 云 OCR 会多出一条联网出口，这一版不做

**系统集成（设置面板）**

- 面板是「左侧菜单 + 右侧内容」两栏：菜单五屏 —— **通用**（程序、天气、快捷键、启动、笔记、账号与同步）、
  **截图**（截图快捷键、自动保存位置、钉图初始透明度、放大镜开关）、
  **外观**（主题、背景、顶部样式、卡片不透明度与间距、毛玻璃描边）、
  **菜单**（导航栏留哪几页，首页页下还挂着它自己的九块卡片）与
  **关于**（版本、数据目录、登录状态），右侧各区独立滚动、菜单不跟着走。
  「菜单」单独一屏：它管**入口留哪几个**，与「这一屏长什么样」不是一回事；
  「关于」也单独一屏 —— 它把「这是什么、数据在哪」如实摊开，这一屏**只读**
- 程序名称：标题栏、托盘提示与窗口标题上的名字（默认 `MUYIAN`），
  **首页问候行只在没登录时用它**（登录时那个名字归账号用户名，见[「首页」](modules/home.md)一节）。
  托盘提示与窗口标题归系统画，只能在 Rust 侧设（`set_app_name` 一条通道同时改两处）：
  名字一改就推一次，启动时由 settings store 的 `immediate` watch 补第一次
- 「关于」里的版本号取自 `tauri.conf.json` 编译期内嵌的那一份（`app_version` 命令），界面上不写死
- **上次看的那一档会被记住**：项目页排序方式、工作页时间范围与维度、笔记树**摊开的那几层**。
  它们是「你习惯怎么看」，住在数据文件里、**不进 theme.json**（那份会整份同步到别的机器，
  而「上一眼在看什么」换台机器不成立，与 `activeView` 同口径，见 [constraints/ipc-and-state.md](modules/ipc-and-state.md)）。
  刻意**不记**的两项：项目页分组筛选、工作页「只看待办」—— 临时的镜片，记住了下次打开少一半。
  目录树展开态**换笔记本时清空**（清单存的是相对路径，换本就指向别的东西）
- 主题：跟随系统 / 亮色 / 暗色（默认暗色）
- 主题色：交互态用的颜色，内置几档预置也可自选，留空是中性灰；只影响交互态，运行状态色与终端不变。
  **选中块的底色**（`--bg-selected`）不是铺满主色，而是按同一档浓度混出的主色浅底 ——
  换主题色只换色相、深浅不变（亮色往白里混到两成主色，暗色少混些，见 `accent-color.ts`）
- **选中块里的字取主题色**（`--ink-accent`，目前用在邮箱清单里正在读的那封：主题行与发件人）：主色直接当字色
  多半读不清（亮绿那类在它自己的浅底上只有 2.1:1），所以这一档是主色按对比度推深（亮色）/ 推亮
  （暗色）到 4.5:1 的结果，**色相还是主题色那个**；主色本身够对比时原样用。没配主题色时它是 `--ink`
- 主题色文字：铺在主题色上的字按深浅自动取黑或白，也可手动指定
- **分段控件（`el-segmented`）的选中项是主色实心块** —— 这是 Element Plus 的原样，也正是
  「主题色接管交互态」里的那个选中态：配了主题色就是主题色高亮，没配时主色是中性近黑 / 近白，
  不引入彩色。铺在上面的字取 `--el-color-white`（同一条自动判定），别写死白色。
  样式口径在 [global.css](../apps/desktop/src/renderer/src/styles/global.css) 的 `.el-segmented` 一处
- 卡片不透明度与间距（外观那一屏两行挨着）：前者是卡片底色浓度（20%–100%，默认 30% 半透，
  调低让背景透出来，只动底色、边框与文字不变；**卡片与面板在这层底色之下还有一道毛玻璃**，
  调低时透出来的是磨过的壁纸、不是原样的图案，见下面「浮在壁纸上的面一律是毛玻璃」一条）；
  后者是卡片之间与页面四周的留白（px）
- **毛玻璃描边**（紧挨着上面两行）：那些磨砂的面四周要不要那条 1px 的灰线，默认**不画** ——
  磨砂自己就画得出边界，那条线是多余的。取值住在 theme.json，落地是把 `--glass-border-color`
  一族在 `<html>` 上写成 transparent（见 [bootstrap.ts](../apps/desktop/src/renderer/src/bootstrap.ts)
  的 `writeGlassBorder`）—— **不是把 border 去掉**：那条 1px 照旧占着位，开关一下不会让定高的
  卡片挪 1px。写根元素不写 `.app`，因为弹层都 Teleport 到 body，写 `.app` 上它们看不见。
  已知代价：把「工作区背景」设成「无背景」时画布是平的，卡片只剩一层淡投影，边界会比较弱 ——
  这是不画描边的固有取舍，觉得难分就把这个开关打开（**别反过来默认加回那条线**）
- 左侧导航栏（菜单那一屏）：一行一页、一个开关，关掉的页从导航栏上收起来
  （至少留一页；全关掉时首页会留下）
- **首页那一页下面挂着它自己的九块卡片**（同一屏，缩进一层 + 一条竖线把父子关系摆明）：
  一行一块、一个开关，关掉的卡片不画在首页上（位置与高度留着，再打开回到原处），至少留一块。
  两块开关清单都排在说明文字下面，一行两个，不给某一屏撑出一整屏高
- 全局快捷键唤起或隐藏窗口（默认 `Ctrl+M`，可自行录制）；截图那一条在设置·截图里。
  **被别的程序占用时会在界面上提示**（`RegisterHotKey` 是全局独占的，挂不上就是按了没反应），
  而不是安静地什么都不做
- **关闭按钮 = 收进托盘**：窗口不会真的关掉，托盘常驻，点托盘图标或快捷键都能找回来；最小化是否也收进托盘可单独设置（默认收进托盘）
- 右键不弹 WebView2 的原生菜单（返回 / 刷新 / 另存为 / 打印 / 更多工具 / 检查 那一套）：界面是自绘的，浏览器这套菜单在这里没有意义；
  菜单键与 Shift+F10 触发的是同一个事件，也一样不出。调试因此没有「检查」可点，改走远程调试端口（见 [AGENTS.md](../AGENTS.md) 第 6 节）
- 开机自启（默认开启，仅打包后生效）
- 网速球（默认关闭）：打开后桌面上出现一颗显示实时下载 / 上传速度的球，拖到哪就停在哪儿；
  拖到屏幕左 / 右边缘会收成贴边的一条竖流量条，鼠标移开收回去、移上来再摊开
  （见 [float-ball.md](modules/float-ball.md)）。
  它与主窗口互不相干 —— 主窗口收进托盘、最小化，它都照样在桌面上
- 账号与同步：账号在通用屏最后（登录前只有「登录状态」一行，登录后多出同步仓库地址，留空即不同步）；
  **从别的机器取外观**（列出仓库里有文件的机器，含标「本机」的那条，逐台「应用」换成本机外观）
  在**外观屏最上面**，旁边「同步一次」就地推拉一次（做法见[「外观配置同步」](modules/sync-and-auth.md)）
- 退出提醒（`el-dialog`，遮罩 / 焦点 / Esc 与其他弹窗同一套）：从托盘真正退出时若还有项目在运行，
  弹窗二选一 —— 「关闭所有项目并退出」先结束进程再退，「直接退出」保留进程交给下次启动的残留清理。
  **收不收进程只由这个选择决定**：Rust 侧退出钩子（`RunEvent::Exit`）不再兜底收一次
  （它是所有退出路径的必经之处，在那儿收等于把选择抹平）。「运行中」包括本次会话启动的进程
  与启动检测按端口认出的外部服务（后者按端口结束）。**推事件前先把窗口唤到最前**
  （`request_quit` 调 `show_main_window`）：这是应用内弹窗，窗口收在托盘或压在别的程序后面时弹了没人看得见，
  而 Rust 侧要等满 60 秒超时；「取消」则把窗口放回唤出前的样子
- 工作区背景可以放一张图，也可以只用蒙版定底色；顶栏与导航栏按「顶部样式」三档决定怎么让壁纸透上来：
  「正常 / 毛玻璃」是画得出边界的板子（实底 / 磨砂，内容与它之间留「卡片间距」），
  「透明」没有可见的边，内容顶到下沿不另留缝
- **浮在壁纸上的面一律是毛玻璃**（苹果那种磨砂板）：底色之外，还给背后那层壁纸一道 `backdrop-filter`。
  配方**只有一份**，在 [tokens.css](../apps/desktop/src/renderer/src/styles/tokens.css) 的「毛玻璃」一节 ——
  `--glass-filter`（模糊 + 提饱和，提饱和是苹果那套 vibrancy，不提的话隔着玻璃的颜色会发灰）、
  `--glass-fill`（浮层用的厚底色）、`--glass-border-color`（四周那条 1px 的线，见设置里的「毛玻璃描边」）。
  各处只引用，不复制配方；要加厚 / 改薄只改那一处。
  **玻璃没有上沿高光**（原先那块 `inset 0 1px 0` 的白线已经删掉）：一块玻璃的边界只剩底色与壁纸
  的交界、以及它自己的投影（`--shadow-card` / `--shadow-hover`）—— 那道白线在每块面上、顶栏顶上
  都看得见，用户明确不要。
  **两个厚度参数**（卡片默认不透明度 30%、磨砂 32px）是照一张手机桌面的毛玻璃截图定的：
  模糊量要够大、底色要够薄，背后的图案才真的化开成色块、颜色才穿得过来（草上是暖绿、
  暗处发灰）—— 底色调到 55% 那档偏「奶白板」，模糊再重也还是板子。
  吃这一套的：**面板**（`.panel` —— 首页那几张卡与笔记 / 邮箱 / 知识库 / AI / 视频的每一栏）、
  项目卡、技能卡、工作记录、密码卡、AI 输入卡、导航栏那张卡、详情抽屉、
  **所有下拉与选择器**（EP 的 `.el-popper`，`.el-bg-color-overlay` 那一枚换成玻璃底色）、
  弹窗与确认框、提示条、以及四个自绘的浮层菜单（邮件两份、笔记两份）。
  底色分两档：卡片 / 面板跟设置里的「卡片不透明度」走，要读成句文字的浮层取 `--glass-fill`
  （固定厚度，不跟用户的滑块走 —— 调到 20% 会读不清）。
  **刻意不磨的**：终端面板（始终深色，日志要读字）、顶部栏的「正常 / 透明」两档（用户显式选的档位）、
  压在玻璃上的**控件**（按钮 / 输入框 / 标签 —— 小、要读字，白底就是为了从壁纸上立起来）、
  深色 tooltip（是标签不是面）、面板里那些「框里的框」（如 AI 助手那条等确认的卡片）；
  三个辅助窗口（截图遮罩 / 钉图 / 网速球）也不磨 —— 它们的窗口是透明的（背后是桌面，
  不是网页磨得着的东西，模糊取不到画面、只会剩一层半透），截图遮罩里那条工具条还压在冻结的
  截图上（深色实底，磨开反而看不清要标注的地方）。**遮罩照旧完全透明**：
  玻璃浮起来靠它自己那层磨砂与投影，不靠压暗背景
- 两处代价（改这些面时一并想着）：`backdrop-filter` 会给元素造一个层叠上下文，
  里面的浮动内容得 Teleport 到 `body` 才出得了头；它同时给 `position: fixed` 的子元素换定位参照
  （所以弹层都必须 append-to-body，见 [ipc-and-state.md](modules/ipc-and-state.md) 与
  [dev-notes](../docs/dev-notes/browser-preview-verification.md) 的那条坑）

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2（Windows 上走系统 WebView2，不再随包附带 Chromium） |
| 后端 | Rust（窗口 / 托盘 / 单实例、子进程与日志、文件与 sqlite、系统能力） |
| 前端 | Vue 3（组合式 API + `<script setup>`）+ Element Plus + Pinia |
| 工作日志渲染 | markdown-it（只服务工作日志正文：`html: false` 转义原文里的标签、`linkify` 认裸地址、`breaks` 让单个换行就是 `<br>`，链接统一新窗口 + 交系统浏览器打开） |
| 笔记编辑器 | Vditor（只服务笔记正文；静态资源随包带一份、不走 CDN，见[「笔记」](modules/notes.md)那一节） |
| 构建 | Vite 8（渲染层，打包器是 rolldown）+ cargo / Tauri CLI（后端）。根与 `apps/desktop` 的 `package.json` 都是 `"type": "module"`，所以各 vite / vitest 配置里用 `import.meta.dirname`（`__dirname` 只在旧的打包式加载器下被 shim 出来；仓库里也不要有 CJS 的 `.js` / `.cjs`，它们会被当成 ESM） |
| 语言 | TypeScript（渲染层）+ Rust（后端）；契约与纯逻辑按域拆在 `packages/` 的 17 个 `@workbench/*` 包 |
| 持久化 | 本地 JSON，由 Rust 侧 `store.rs` 负责（防抖 300ms、临时文件 + rename、退出前同步落盘） |
| 子进程 | `std::process` 起 shell 命令（按批回传输出，Windows 下 `taskkill /T /F` 结束整棵进程树） |
| 端口 → 进程 | `GetExtendedTcpTable`（iphlpapi，一次系统调用拿到监听表）+ `QueryFullProcessImageNameW`；不再起 `netstat` / `tasklist` 解析文本输出（全量检测会并发问十几个端口，原先每个端口两个子进程） |
| Coding 用量数据源 | ZCode：`rusqlite` 只读打开本地 sqlite（WAL 并发读）；DeepSeek Harness：Rust 逐帧解压 `~/.dsh/sessions` 的多帧 zstd 会话；CodeBuddy：Rust 列扩展日志清单、渲染层读内容并解析；WorkBuddy：Rust 列会话正文清单、渲染层读内容并解析；Qoder：Rust 列 `~/.qoder-cn/projects` 的会话正文清单、渲染层读内容并解析（只取 `usage.credits`，它不报 token）。五者都只读，且只取用量数字 |
| Token 多机同步 | 可选（默认关闭）：`std::process` 直启系统的 `git`（不经 `cmd`，参数行不会被二次解析），推 / 拉一个用户指定的仓库；`token-usage/` 与 `config/` 两个目录、都是一台机器一个文件，且是两条互不相干的出口（用量自动 + 手动都只动前者，外观只在设置里点「同步一次」时动后者；采用别人的配置也只能手动点）。凭据默认走系统 git，登录过账号则改用该账号的 token（按 host 限定注入请求头，过期前自动续期，见下） |
| 账号登录 | 可选：GitHub / Gitee 的授权码流程 + 本机回环回调（RFC 8252 那套，与 VS Code 同路）。HTTPS 走系统自带的 WinHTTP，access_token 与 refresh_token 存 Windows 凭据管理器（DPAPI）—— 两者都只给已有的 `windows-sys` 加 feature，**没有引入任何新的 crate**。两家都要求 clientId + clientSecret，凭据由 `build.rs` 编译期内置 |
| 依赖取舍 | 新增 crate 的标准是**「不新增编译单元」**而不是「不新增名字」：`url` / `percent-encoding` / `form_urlencoded` / `walkdir` / `base64` / `sha2` 都已被 tauri / tao / wry / tauri-utils 拉进编译图（`cargo tree -e normal -i <crate>` 可查），所以直接用它们替掉手写的 URL 编解码、目录递归与摘要实现，代价为零。反过来，`reqwest`（hyper + tower + TLS 整套）、`git2`（libgit2 的 C 依赖）、`sysinfo` 会新增成片的编译单元，一律不引 |
| 测试 | Vitest（渲染层与域包）+ `cargo test`（Rust） |
| 打包 | Tauri CLI → NSIS 安装包（Windows x64） |

架构上单独说一句：**后端刻意做薄** —— 只提供「取原始数据 / 落盘 / 调系统能力」，
合并、排序、修剪、状态机、命令构造这些业务语义都在渲染层适配层
（`apps/desktop/src/renderer/src/workbench/`）。绝大多数改动因此仍是 Vite 的秒级热更新，
只有动系统能力才重编 Rust（实测增量 4~15 秒，见 [dev-notes](dev-notes/)）。

适配层顶替的是 Electron 时代「preload + 主进程」那条**进程边界**，递给渲染层的列表一律是快照
（`structuredClone`）：渲染层的乐观追加不会与适配层刚改过的数据叠在一起，往自己列表里 push
也写不进要落盘的数据 —— 边界搬进同一个 JS 上下文后必须自己补，漏掉的表现是
「添加一个程序先变成两个，刷新又合成一个」。

**IPC 命令默认跑在主线程上**：`#[tauri::command]` 不加参数时函数体会在主线程内联跑完，
凡会起子进程、读写文件、解码图片、跑 SQL 的命令都标 `(async)`（落 `async_runtime::spawn` 到工作线程），
只有纯内存读写与窗口控制保持同步；漏标的后果不是「慢」而是「界面卡死」（消息循环被堵住，
渲染层的 `await` / `Promise.all` 挡不住）。启动路径踩过一次：包管理器探测加壁纸缩略图把首屏冻了好几秒，
现在都改成「挂载之后再拉」。

**工作区背景图与视频播放走 asset 协议，后端不碰它们的字节**：渲染层只调一次 `allow_background`
（后端读文件头确认能解码，1ms 量级），把**这一个文件**的读取权限授给 asset 协议，
URL 由 `convertFileSrc` 转出交给 CSS，图片由 webview 自己读、自己缩放 —— 代价是全尺寸原图进
webview 内存（旧方案「解码 → 缩放 → 编 JPEG → base64」一张 3824×2400 实测 249ms，且每次启动重算）。
视频同一套思路（`allow_video`：核后缀与 MP4 文件头 `ftyp`，协议自带 Range，拖进度条不用整份下完）。
AI 预览栏显示回答里提到的图片也走 `allow_background` 这条命令（同一条「验图 + 单文件授权」边界，
见适配层 `allowPreviewImage`）。`assetProtocol.scope` 刻意留空 —— 授权一律运行时按文件给，
**别为了省事写成 `**`**。

## 目录结构

树里只留底座与一行式条目；各模块自己的文件与链路注解，见 `modules/<模块>.md` 的「涉及文件」。

```
apps/desktop/            桌面应用（自包含：渲染层 + Rust + 随包资源 + 构建脚本）
  src-tauri/               Rust 后端
  src/main.rs            入口、窗口、托盘、单实例、生命周期
  src/panic_log.rs       panic 落痕（release 是 panic=abort，崩溃证据只留这一份）—— 注解见 modules/ipc-and-state.md
  src/commands.rs        IPC 命令层（薄：取数据 / 落盘 / 调系统能力）
  src/session.rs         子进程会话：起命令、按批回传输出、按进程树终止
  src/proc.rs            带超时的子进程原语 + 进程树终止
  src/store.rs           去抖 JSON 落盘（300ms 合并 + 临时文件 rename）
  src/fs_util.rs         文件底座：路径守卫（is_plain_segment）与原子写 —— 注解见 modules/ipc-and-state.md
  src/paths.rs           数据目录与指针（与旧 Electron 版同一位置）
  src/system.rs          端口检测（GetExtendedTcpTable）、资源管理器、ShellExecute
  src/nvm.rs             nvm 只读探测 —— 注解见 modules/projects.md
  src/nrm.rs             nrm 探测与镜像源切换 —— 注解见 modules/projects.md
  src/token.rs           用量数据源聚合 —— 注解见 modules/sync-and-auth.md
  src/notes.rs           笔记文件夹的扫描 / 读写 / 增删改名 —— 注解见 modules/notes.md
  src/sync.rs            同步与 git 管道 —— 注解见 modules/sync-and-auth.md
  src/design.rs          设计规范落盘 —— 注解见 modules/styles.md
  src/skills.rs          技能库 —— 注解见 modules/skills.md
  src/kb.rs              知识库 —— 注解见 modules/kb.md
  src/ai.rs              AI 助手宿主侧 —— 注解见 modules/ai.md
  src/pi_skills.rs       Pi 的技能 —— 注解见 modules/ai.md
  src/video.rs           视频文件夹扫描与 allow —— 注解见 modules/video.md
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
                         以及那扇禅道窗口（建窗 / 导航边界 / 登录页自动填表）
                         —— 注解见 modules/zentao.md
  src/notify.rs          Windows toast 的手写 WinRT FFI —— 注解见 modules/mail.md
  src/credentials.rs     Windows 凭据管理器读写 —— 注解见 modules/ipc-and-state.md
  src/vault.rs           密码保险库宿主侧 —— 注解见 modules/vault.md
  src/encoding.rs        base64 / SHA-256 / UTF-16 —— 注解见 modules/ipc-and-state.md
  src/icon.rs            程序图标抽取 —— 注解见 modules/quick-launch.md
  src/imaging.rs         图片解码校验与缩略（背景图核文件头、壁纸缩略图）—— 注解见 modules/ipc-and-state.md
  oauth.example.json     OAuth 应用凭据与禅道账号密码模板（真实凭据放 oauth.local.json，不入库）
  tauri.conf.json        窗口、打包、资源映射
  capabilities/          能力白名单

  src/renderer/           四个 HTML 入口：index.html（主界面）、capture.html（截图遮罩）、
                         pin.html（钉图）、ball.html（网速球）。后三个是独立窗口、各自的 JS 上下文，
                         只装适配层、不装 store（见 modules/screenshot.md、modules/float-ball.md）
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
                         use-draft-field：设置 / 抽屉的草稿字段。拖拽与浮层那几个带单测）
  notify.ts              非组件代码「说一句话 / 问一句」的唯一出口（可被测试顶替）
  stores/                跨组件状态，按领域分文件：nav.ts（当前页与首页布局编辑态）与
                         settings.ts（设置、外观、首页布局、别台机器的外观）是壳层，
                         见上面的「导航与页面」「系统集成」；其余各 store 的注解见
                         modules/<模块>.md 的「涉及文件」
  types.ts               应用级契约（Project / AppSettings / WorkbenchApi / IPC 通道表 /
                         DEFAULT_SETTINGS），并从各域包 re-export 保持 `@/types` 一站式取类型
  persisted-data.ts      数据文件的收敛编排 + theme.json ↔ 数据文件的分流桥接

packages/                按域拆出的 17 个 @workbench/* 包（TS 源码直出、各自带 vitest；
                         包之间与应用都只按包名走各自的 index.ts 桶导入）：
  core/                  平台原语：Result 与 ok/fail、端口与项目路径、dev-port、扫描
                         （scanner，fs 注入）、命令与快捷启动的收敛、图标缓存、残留进程判定、
                         项目标识色的分配、项目排序的取值、markdown 渲染、text-diff
  notes/                 笔记的文件名与目录树口径、图片的命名与访问地址拼接
  video/                 MP4 过滤 / 目录树口径 / 倍速档位与时间、时长的显示
  appearance/            外观口径与默认外观的唯一来源、主题、views、工作区背景与壁纸、
                         设计样式的 token 模型与键名中文标签规则、色系判定与筛选排序、
                         设计示例页面的颜色角色解析（design-demo）、设计规范与提示词的
                         生成（design-export）
  terminal/              ansi、log-ring、log-scroll、terminal-key
  kb/                    知识库的布局常量 / 入库状态口径（kb.ts）、清洗提示词（kb-clean.ts）、
                         巡检与条目链接的解析（kb-lint.ts）
  skills/                技能的 frontmatter 解析与路径口径、项目副本与库的差异判定
                         （compareSkillCopy，见 modules/skills.md）
  ai/                    AI 服务与模型清单的形状 / 收敛、厂商预设表、按模型名认上下文、
                         内置模型目录（ai-builtin-models.generated.ts，由 vendor-pi 生成）、
                         AI 热点的 RSS 解析与缓存策略（ai-news.ts）、Pi 技能的根与开关口径
                         （pi-skills.ts）
  usage/                 Token 用量口径（token-usage.ts）、同步配置（sync-config.ts）、
                         四个 IDE 日志源（codebuddy / qoder / dsh / workbuddy-log）
  work-log/              工作日志的时间轴
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

## 开发

```bash
pnpm install

pnpm run dev             # 启动开发态（Rust 后端 + 渲染层热更新）
pnpm run typecheck       # 根目录单一 TS 工程覆盖渲染层与全部域包
pnpm test                # Vitest 单元测试（根配置收 18 个项目，一条进程跑全量）
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # Rust 侧测试
pnpm run build:renderer  # 只编渲染层，产物落 apps/desktop/out/renderer
pnpm run preview:renderer # 只把渲染层跑在浏览器里，方便看布局（产物落 apps/desktop/.preview/）
```

环境前置：pnpm（版本钉在根 `package.json` 的 `packageManager`）+ Rust stable（`x86_64-pc-windows-msvc`）+ MSVC 生成工具 + Windows SDK。
不需要再为 native 模块准备编译环境 —— `better-sqlite3` / `node-gyp` 那套随 Electron 一起去掉了。

用 Token 多机同步还需系统里有 `git`（`git --version` 有输出即可）。**登录后不必再配 git 凭据**：
同步用账号的 token 推送（凭据管理器里存着就自动用），token 到期自动用 refresh_token 续一次
（Gitee 的只有一天，不续每天都会失败一回）。不登录也能同步、走系统 git 凭据，但首次同步私有仓库
会直接报错而不是弹输入框（子进程没有终端可问），得先在命令行对这个仓库 `git clone`（或 `git fetch`）
一次把凭据存下来，或改用 SSH 地址。

## 打包

```bash
pnpm run icons        # 需要改图标时：重新生成 src-tauri/icon.ico（窗口与托盘共用）
pnpm run dist:dir     # 产出免安装目录（只编不打包，用于快速验证）
pnpm run dist         # 产出 NSIS 安装包
```

打包配置见 [`apps/desktop/src-tauri/tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json)；NSIS 安装包落在
`apps/desktop/src-tauri/target/release/bundle/nsis/`。几点需要留意：

- 渲染层产物 `apps/desktop/out/renderer` 是在**编译期**被内嵌进可执行文件的，所以改了前端要先 `pnpm run build:renderer`
  （`pnpm run dist` 与 `pnpm run dev` 都会自动带上这一步）。
- 内置壁纸经 `bundle.resources` 映射到 `backgrounds/`，运行时 Rust 从 `resource_dir()` 读取
  （清单与缩略图用）；开发态 `list_wallpapers` 回落到仓库里的 `apps/desktop/resources/backgrounds`，
  `tauri dev` 会把资源拷到 `target/debug/backgrounds/`、实际优先命中那份。
  工作区背景图本身走 asset 协议按文件加载，不经过这条链
- release 档位是 thin LTO + 16 个 codegen 单元，链接器换成工具链自带的 `rust-lld`
  （配置在 [`apps/desktop/.cargo/config.toml`](../apps/desktop/.cargo/config.toml)）。**打包前先停掉 `pnpm run dev`**：
  两者会抢 `target/` 的构建锁并互相拖慢。取舍、实测数据与更多坑见
  [`dev-notes/build-performance.md`](dev-notes/build-performance.md)。
- 可执行文件的版本资源：`CompanyName` 取 `bundle.publisher`，**没配时回退到 `identifier` 的第二段**
  （`com.muyian.workbench` → `muyian`，所以曾经也是对的）；`LegalCopyright` **只在配了
  `bundle.copyright` 时才写**，不配就是空的（`tauri-build` 那句在 `if let Some` 里）。两个都显式配在
  `tauri.conf.json` 里，不再依赖回退 —— 否则哪天改了 identifier，`CompanyName` 会静默跟着变。
  **NSIS 安装包那颗 exe 没有 `CompanyName`**：Tauri 的 NSIS 模板只写 ProductName / FileDescription /
  LegalCopyright / FileVersion / ProductVersion。安装包在「应用和功能」里的发布者走 `${MANUFACTURER}`
  （同一个 publisher 值，本来就对），不受此影响；要给安装包也补上 `CompanyName` 得自备
  `bundle.windows.nsis.template`，代价是那份模板要一直跟着 Tauri 升级，暂时不做。
  仓库根是 MIT（`LICENSE`，2026 muyian）。

安装包为单用户、可选安装目录，卸载时保留 `workbench-data.json`，不会连带删掉项目列表。

## 数据与隐私

应用**默认不联网**。对外发请求的只有十二处，且都是你自己开出来的。
**截图与钉图一处都不占**：抓屏走 Win32（BitBlt）、剪贴板与落盘都在本机、钉图只是一扇置顶窗口，
整个过程没有一次网络请求（也正因如此，取字 / OCR 这一版不做：云端那条会多出一处出口）。

- **Token 用量同步**（可选、默认关闭）：登录账号且设置里填了仓库地址才会推 / 拉那个仓库，退出登录就停。
  **密码保险库推的是同一仓库的另一个目录**（`vault/vault.json`），推上去的只有密文
  （密钥只在本机，见[「密码保险库」](modules/vault.md)那一节），所以它不是多出来的出口；
  它**没有同步按钮** —— 登录且填了地址之后，进密码页、或在那一页增删改一条，就自动推拉一次
  （换 / 导入密钥那几步不自动推，理由见那一节）
- **账号登录**（可选）：点登录时才访问 GitHub / Gitee 的授权接口，之后不在后台反复打请求
  （头像只在打开账号弹窗时重拉）；唯一例外是 access_token 到期后的**续期** ——
  只在同步之前（或刷新账号资料时）按需发生一次，走的还是换 token 的接口
- **笔记图片上传与清理**（可选、默认关闭）：填了图片仓库、且你**真的往正文贴了图片**
  （或打开素材管理删图）才会碰那个仓库，没填就是一句提示；文档里存的是外链，图片在你自己仓库里。
  正文里的外链图与素材缩略图由 webview 按地址直接取，同一条边界
  （页面级 `no-referrer` 让请求不带来源，见[「笔记」](modules/notes.md)那一节）
- **笔记本身的同步**（可选、默认关闭）：前提是**笔记文件夹自己是个连了远端的 git 仓库**（应用不替你建），
  且你**点了同步按钮**才走一次 git，推到它自己的 `origin`。**知识库的同步复用这一条**（同一个通道、推的是
  那个知识库文件夹自己的 `origin`，不另算一处出口）：提交是 `git add -A` 不带 pathspec、等于**整棵工作树**，
  所以库里 `data/raw/` 那份**原始资料会跟着一起推到远端**；配到**库外**文件夹的来源不在这个仓库里，不进同步
- **技能库的同步**（可选、默认关闭）：前提是**技能库在连了远端的 git 仓库里**（从它往上找），
  且你**点了技能页同步按钮**。推的是技能库所在的那个仓库（可能是笔记仓库的同一远端，也可能是专门的技能仓库）；
  平时增删改只在本机提交 —— 技能不是多出来的出口
- **命令执行本身**访问网络（`npm install`、dev server 之类），那不属于应用的行为
- **AI 热点**（量子位，免费、不需要凭据）：首页「AI 热点」卡片的数据源。**源地址是内置白名单**
  （Rust 侧 `ai_news.rs` 的 `SOURCES`，**只放中文源**），渲染层只能报源 id、拿不到任何地址；
  只有首页画着那张卡片、且到了它自己的刷新间隔才 GET，只读不传
  （每源独立 TTL + ETag 条件请求 + 429 退避，见 `packages/ai/src/ai-news.ts`）。
  **站内阅读**是同一条出口的延伸：点开某一条才抓那篇正文，域名另有 `article_hosts` 白名单
  （只认源站自己的域名与子域），页面脚本不执行、只取正文纯文本
- **实时天气**（Nominatim + Open-Meteo，免费、不需要凭据）：顶栏问候旁那小段实况的数据源。
  **设置里填了天气城市（`weatherCity`）才会取**，留空整条出口是关着的；填了之后半小时一次 GET。
  白名单是 Rust 侧 `weather.rs` 里那**两个**主机名各管一段：城市名 → 经纬度走 OpenStreetMap 的
  公开 Nominatim（Open-Meteo 自带检索对部分中文名匹配不上，实测「常州」搜不到、Nominatim 能搜到），
  实况走 Open-Meteo 的 `/v1/forecast`（坐标越界发请求前就拒）。**城市名会作为查询串发出去** ——
  这条出口唯一的用户内容。解析与 WMO 码表在 [packages/weather/src/weather.ts](../packages/weather/src/weather.ts)；
  经纬度只在本机内存里缓存（换城市才重查），不落盘、不参与同步；取不到就少显示一段，问候语不报错
- **AI 助手用的模型端点**（可选、默认关闭）：配好服务（挑厂商或自定义端点 → 粘 API Key → 挑模型）、
  选了默认模型并点了发送，才会请本机 Pi 干活 —— **请求是那个子进程直接发给你配置的端点的**
  （不经应用的 HTTP 客户端），**它在工作目录里读到的内容与这段会话的历史都会发到那个端点**
  （清洗知识库那一轮还包括知识库配的各个**来源文件夹** —— 原始资料常常在知识库文件夹外面，
  见 [kb.md](modules/kb.md)）；预设表在 [packages/ai/src/ai.ts](../packages/ai/src/ai.ts)，密钥与端点的规矩见
  [docs/modules/ai.md](modules/ai.md)。**同一条出口还包括「拉模型列表」**：
  粘上 Key（或点「获取列表」）时**应用自己**按你填的 Base URL GET 一次 `{Base URL}/models`
  （Anthropic 那套是 `/v1/models`）—— 同一主机同一把 Key，不点不走。**Pi 自己的遥测与版本检查
  由应用在起进程时关掉**（`PI_TELEMETRY=0` / `PI_SKIP_VERSION_CHECK=1` / `PI_OFFLINE=1`），
  不关它会替用户往 pi.dev 发请求。「安装 Pi」跑 `npm install -g`，属于「命令执行」那一类
- **装技能**（可选；AI 助手页「技能」按钮里的「粘地址」，第九条出口）：**你粘上地址、再点「装上」**
  应用才 GET 一次 —— **主机不设白名单**（与「你自己填的 git 仓库」同类：地址由你给），
  跟着 `Location` 最多跳 5 跳，只收 zip、超过 64 MB 就停。**除那个地址本身，这一趟不带任何用户数据**；
  下载的包**只解压落盘，脚本一概不执行**（要不要跑是 Pi 的事，受权限档管）。
  另两种安装方式（导入本地 zip / 目录）与列表、开关、卸载、`--skill` 注入全在本机。
  实现与边界见 [pi_skills.rs](../apps/desktop/src-tauri/src/pi_skills.rs) 与
  [docs/modules/ai.md](modules/ai.md) 的「技能」那几条
- **邮箱**（可选、默认关闭；第十条出口）：邮箱账户**可同时配多个**（163 / 126 / QQ 的收发服务器跟着
  地址后缀自动带出，自定义域自己填），每个账户填了地址、授权码进了凭据管理器，才会连
  **它配置的**收发服务器（IMAP 收信 993、SMTP 发信 465，隐式 TLS；主机不设白名单 —— 与「装技能」
  同类，地址由你给）。**收件箱与已发送**各合并成一条按时间排的清单（服务器上的文件夹名由应用
  现认，网易 / 腾讯各是一种写法），行上标注来源账户。授权码存 Windows 凭据管理器
  （DPAPI 按用户加密，按地址一条），不落明文、不回渲染层；
  连接参数进设置（明文 JSON，但那几项不是秘密）。**本机还有一份通讯录**（右击「存为联系人」
  攒的、写邮件时收件人从里面挑，也允许当场打新地址）—— 它只住设置里，不参与同步、不发往
  任何地方。**邮件 HTML 正文的外链图片跟着信里的地址
  加载**（营销信的主视觉能直接看到；请求不带 Referer），脚本 / 字体 / 音视频等其余外链
  资源照旧不加载：沙箱 iframe + 只放行图片的 CSP —— 除收发服务器与信里引用的图片主机，
  这条功能没有别的网络目标。进页面、点刷新、发信各是一次现连现断的连接；此外配了账户后有**后台新邮件检查**
  （`mail_watch.rs`，连的还是你配置的那台收件服务器；周期在邮箱账户弹层里设、
  默认 30 分钟、可关）：有未读的新信弹 Windows 系统通知，点通知唤出主窗口并打开那封信
  （通知是 `notify.rs` 手写的 WinRT toast，不引通知插件）。
  实现与边界见 [mail.rs](../apps/desktop/src-tauri/src/mail.rs) 与
  [docs/modules/mail.md](modules/mail.md)

- **禅道**（可选、配置开启；第十一条出口，**应用自己的请求只读**）：在 `oauth.local.json` 的
  `zentao` 节填写部署根、账号与密码后重新构建。**默认每 30 分钟后台检查一次**（通用设置里可改，0 = 关闭）：
  Rust 先 POST `/api.php/v1/tokens` 登录，随后 GET 可见产品与各产品「指派给我的」Bug 分页；
  间隔由 Rust 计时线程计时并到点发事件，取数、比编号全集与弹通知在渲染层 —— 计时放 Rust 是因为窗口收进托盘后
  WebView 定时器会被节流。只有配置完整、周期非 0 才发检查事件；第一轮成功只建立基线，之后有新增才弹系统通知
  （复用邮件那条 toast 路径，点击打开禅道窗口）。请求只发往配置的部署根与固定端点，不跟重定向；
  账号密码仅由 Rust 读取，token 仅留 Rust 内存，不回渲染层、不写数据文件或凭据管理器。配置缺失不出网；重启清 token。
  HTTP 的凭据传输不加密，个人密码随配置内嵌到二进制，不能分发带密码的构建。
  实现与边界见 [zentao.md](modules/zentao.md)。

- **禅道窗口本身**（第十二条出口，与上一条同一个部署地址，但机制不同）：顶栏右侧那颗图标（收起 / 展开菜单那颗的右边）打开的
  是一扇**独立窗口**，由 webview 直接加载禅道的网页（HTML/CSS/JS 与图片附件都由它去取），
  打开时用内嵌账号密码在登录页自动登录一次。所以这一条出口跑的是**禅道自己的前端脚本**，
  而不是我们那些「固定端点 + 字段白名单」的 JSON 请求；页面里的写操作（改状态、指派、评论）也发生在这一侧。
  窗口用系统标题栏，**`zentao` 这个 label 不登记任何 capability**：远程来源拿不到 IPC，站点脚本够不到宿主命令。
  站外链接与 `target=_blank` 交给系统浏览器，不在应用里开新窗口。
  实现与代价见 [zentao.md](modules/zentao.md)。

十二处都没有自建服务端：四处 git 同步发往你自己的仓库（知识库的同步与笔记共用同一条路、不另算），
登录走两家平台官方 OAuth，AI 热点与天气只 GET 白名单里的公开源，AI 助手发给你自己配的端点，
装技能只 GET 你粘的地址，邮箱连的是你自己配的收发服务器，禅道只访问凭据配置中的部署地址 ——
不上报任何数据。落盘除了数据文件，还有一处**应用之外**的：

- **Windows 凭据管理器**：登录凭据（access_token / refresh_token / 到期时刻）存成一条
  `Workbench/<平台>/token`，**刻意不写进 `workbench-data.json`**（那是数据目录里的明文 JSON；
  这里能在「控制面板 → 凭据管理器 → Windows 凭据」里看到并手工删，登出时应用也会删）。
  **保险库密钥也在这里**（`Workbench/vault/key` —— 落数据目录等于把明文密码摊在盘上）；
  **AI 助手的 API Key 同样在这里**（`Workbench/ai/<服务名>/token`，一个服务一条）：
  只被读出来注入子进程环境变量，**连渲染层都拿不到**。唯一的例外是**保险库密钥会过一次 IPC**
  （加解密在渲染层做，见[「密码保险库」](modules/vault.md)那一节），
  是全项目唯一一处机密进渲染层，别当先例推广
- 数据文件里的账号资料只有昵称、头像与登录名，**没有 token**
- 两处后台常驻检查的周期住本机数据文件（**不进外观同步**）：`mailPollMinutes`（邮件新邮件检查）
  与 `zentaoPollMinutes`（禅道 Bug 检查，默认 30，0 = 关闭）。两者的计时线程都在 Rust ——
  窗口收进托盘后 WebView 的定时器会被节流，靠它计时不诚实。

其余落盘都在**数据目录**里（固定 `%APPDATA%/Workbench/data/`，不跟着任何设置走；
根目录 `%APPDATA%/Workbench` 是迁到 Tauri 之前的 Electron 版留下的 Chromium 配置目录，数据文件不跟它混）：

- `workbench-data.json`：项目列表、分组、快捷启动的常用软件、应用设置（含 `activeView` 与
  「上次看的那一档」那几项行为偏好）；AI 助手的服务清单（`aiProviders`：名称 / Base URL /
  API 形态 / 模型清单，密钥不在这里）、默认模型、会话清单（只存调度字段，对话本身由 Pi 写进
  下面的 `pi/` 目录）、**关掉的技能**（`aiSkillsOff`，键是「技能根 + 技能名」；技能本体是用户
  那两个 `.agents/skills` 目录里的东西）；按天聚合的活跃度计数（**分来源**存，只留最近一年，
  总数由分项现算）、残留子进程记录、账号显示资料
- `pi/`：**内置 Pi 自己的东西**（`PI_CODING_AGENT_DIR` 指到这里，与用户全局 `~/.pi` 互不掺和）：
  `models.json`（整份由应用写出，`apiKey` 只是环境变量引用）、权限扩展 `permission.js`、
  Pi 自己的 trust.json / auth.json，以及 `pi/sessions/` 下**一段对话一份的会话文件**
  （`<时间戳>_<会话 id>.jsonl`，Pi 自己写；删会话就是删这里那份）。
  不是应用的数据格式，别当第二份真源：读对话走 RPC 的 `get_messages`，删会话走 `ai_session_delete`
- `token-usage.json`：**本机** Coding 用量快照，按「工具 → 天 → 模型」聚合（只留最近一年），
  也就是同步推到 `token-usage/` 的那份（旧名 `token-data.json` 启动时自动改名）。
  明细不复制 —— 各工具的本地数据是明细账本，快照用于对抗上游清理。带一个 `credits` 字段
  （额度口径，只有 Qoder 填），同一套合并规则但**不参与 token 总量**
- `work-log.json`：工作日志。**只在本机**：不在 `workbench-data.json` 里、**不同步** ——
  工作内容最贴近个人记录，多机合并没有成立的口径（不像用量数字可相加）
- `ai-news.json`：AI 热点的上次拉取结果，**按源分开**存（每源一份 `etag / nextFetchAt /
  failCount / lastError / items`），合并视图读时现算 —— 撤掉一个源，它的内容立刻从卡片消失。
  **只在本机、不进同步仓库**。单源时代（v1）的老结构不再迁移，读到当空缓存重拉
- `vault.json`：**密码保险库**（见[「密码保险库」](modules/vault.md)那一节）。**只有密文** ——
  条目正文全在密文里，明文只在内存中，露出来的只有条目条数、每条的改动时刻与设备 id、哪些 id 被删过。
  它同时是同步到 `vault/vault.json` 的那份：与别处不同**这份文件是所有机器共写的**，
  合并规则自己定死（按 id 取并集、取改动时间新的那份），不交给 git 合
- **笔记没有数据文件**：笔记本就是用户挑的那个文件夹（见[「笔记」](modules/notes.md)那一节），
  `.md` 就是全部内容；应用只记「当前打开的目录」与「打开过的那几个」（`noteDir` / `noteDirs`，
  左栏**宽度**在 `theme.json`）。天然**不进同步仓库**，换台机器选同一个文件夹即可。
  旧版笔记 JSON 树（`note-data.json`）不再读写，盘上那份可以删掉
- `pins.json` 与 `pins/<id>.png`：**钉图的记账与图本身**（位置 / 尺寸 / 透明度）。
  （截图那几帧**只在内存里**：一场会话用完即弃，不落盘，也就没有「忘了清理」这回事。）
  **只在本机**：位置是这块屏上的坐标，换台机器不成立，也不进同步仓库。钉图关掉时连图一起删掉
- `ball.json`：**网速球的记账**（窗口左上角的 x / y + 贴着哪一侧）。与钉图同一待遇：位置是这块屏上的坐标，
  **只在本机**、不进同步仓库。它不记「收起还是展开」（那是位置的即时结果，重启按位置重算），窗口被系统关掉也不清 ——
  它是位置偏好，不是「球还开着」的凭据（见 [float-ball.md](modules/float-ball.md)）
- 快捷启动只存程序路径与参数，不放程序本体
- 程序图标按「路径 + 程序文件修改时间」缓存在 `workbench-data.json`（每个 1.5~4.4 KB）：
  修改时间没变就直接用（实测每次重抽 27~53ms）；只缓存抽成功的，失败的下次照常重试
- `device.json`：本机设备标识（uuid），首次用到同步时生成，**不会被同步**
  （两台机器同一个 id 会互相覆盖文件且无报错）

**一件需要如实说明的事**：安装包内置了 OAuth 的 client_id（Gitee 还有 client_secret）——
这是「使用者零配置」的前提（VS Code 同路），代价是 secret 理论上能从安装包逆出来。
影响面被「回调地址必须是 `127.0.0.1:45871`」限死：拿到 secret 也接不到别人的回调，且只能冒充本应用。
不接受就退回「每个使用者自己去两家平台注册应用」那条路。

同一份 `oauth.local.json` 还可包含禅道的个人账号密码，构建时整份内嵌到二进制；
修改后必须重新构建，运行时不会重读文件。这类个人密码泄漏后可以直接登录禅道，
不受 OAuth 回环地址限制；`.gitignore` 不保护构建目录或安装包，不能分发带个人密码的构建。

读取别人的数据一律只读、不改文件：ZCode 是 `~/.zcode/cli/db/db.sqlite`（WAL 只读打开，
`ZCODE_HOME` 可指别处）；DeepSeek Harness 是 `~/.dsh/sessions/<项目>/<会话>/`（`DSH_HOME` 可指别处；
v3 与旧版并存时**只读 v3**，都读会把那次会话算两遍）；CodeBuddy 是 `%APPDATA%/CodeBuddy CN/logs`
（国际版没有 `CN`，`CODEBUDDY_DATA_DIR` 可指别处）里扩展目录 `Tencent-Cloud.coding-copilot` 下的 `.log`；
WorkBuddy 是 `~/.workbuddy/projects/<项目>/`（`WORKBUDDY_HOME` 可指别处；与 Electron 那个
`%APPDATA%/WorkBuddy` 不是一个目录，后者只有窗口状态）；Qoder 是 `~/.qoder-cn/projects/<项目>/`
（国际版 `~/.qoder`，`QODER_DATA_DIR` 可指别处）。五处正文都带对话内容，只解析用量字段、
**正文不进快照** —— 同步推的只有模型名与计数。Qoder 不产生 token 计数，解析出的只有
每次请求扣掉的额度，落在 `credits` 一个字段上、只喂 credits 口径。

同步的克隆目录在 `%APPDATA%/Workbench/token-sync/`（本地缓存，删了下次同步重新克隆）。
仓库里两个目录：`token-usage/<设备id>.json`（模型名与 token 计数，**没有对话内容**）与
`config/<设备id>.json`（那份 `theme.json` 的副本：明暗 / 主题色 / 顶部样式 / 卡片不透明度 /
毛玻璃描边 / 终端高度 / 程序名称 / 工作区背景 / 导航菜单 / 首页布局）。两者**没有图片本体与项目信息**，
别的机器的文件从不改动、只读自己那份。仍建议私有仓库。

`config/` 的背景字段是原样复制的：本机若用自己磁盘上的图，那条路径会出现在文件里（只是路径）。
这份**只在设置 → 外观点「同步一次」时才推**，采用别人的配置也只能手动「应用」。

三个已知边界：重装系统 / 清掉数据目录后设备 id 变「新设备」，仓库里的旧文件会把同机历史算两遍
（需手工删掉）；日期按各机本地时区归天，跨时区对不齐；**数据目录不要设成多机共享位置**（网盘 / 网络盘）
—— 设备身份写在 `token-usage.json` 里，共享后两台机器顶着同一个 id 写同一个文件；
共享目录本来就不成立（项目列表整份覆盖写，会互相盖掉），别为了同步把它指到网盘上。

## 本期不做

多项目批量串行构建、远程部署与 Docker、代码编辑器与 Git 图形化、macOS / Linux 适配、
截图的云 OCR 取字（会多出一条联网出口）与录屏 / GIF（与截图几乎是两套东西），
交互式命令输入（伪终端）、多人协作与项目数据云同步（多机同步只做 Token 用量快照与那份主题文件，
项目列表、快捷启动、独立命令、工作日志与笔记这些本机数据不跟着走；工作日志是**刻意**不同步的，
笔记则本来就是用户自己目录里的文件，见「数据与隐私」）。
