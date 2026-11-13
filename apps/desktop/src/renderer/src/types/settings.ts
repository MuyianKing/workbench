/**
 * 应用级设置：一层平铺的配置字段 + 整份默认值。
 *
 * 为什么平铺：设置只有一份文件（data 里的 settings）、一次读、一次收敛（见
 * `persisted-data.ts`），平铺让「默认值 / 收敛 / 界面」三处一眼对得上；各域自己的
 * 取值规则（比如邮件轮询分钟数、笔记目录）仍在各自的包里有 sanitize 函数。
 *
 * 这一份是**契约**（渲染层 + Rust 通道都认它），不是某个包的实现细节，所以住在
 * `@/types` 而不是 packages。
 */
import type { AiProvider, AiSession } from '@workbench/ai'
import type { AccentInkMode, AppearanceSettingKey, ThemeSource, TopBarStyle, ViewId } from '@workbench/appearance'
import type { ProjectSort } from '@workbench/core'
import type { KbSourceLink } from '@workbench/kb'
import type { MailAccount, MailContact } from '@workbench/mail'
import type { WorkRange, WorkRangeBounds, WorkSort } from '@workbench/work-log'
import { AI_PERMISSION_DEFAULT, AI_THINKING_DEFAULT } from '@workbench/ai'
import { DEFAULT_APPEARANCE, TERMINAL_BUTTON_TOP_DEFAULT } from '@workbench/appearance'
import { CAPTURE_ENABLED_DEFAULT, CAPTURE_HOTKEY_DEFAULT, CAPTURE_MAGNIFIER_DEFAULT, CAPTURE_PIN_OPACITY_DEFAULT, CAPTURE_SAVE_DIR_DEFAULT } from '@workbench/capture'
import { PROJECT_SORT_DEFAULT } from '@workbench/core'
import { WORK_RANGE_DEFAULT, WORK_SORT_DEFAULT } from '@workbench/work-log'
import { ZENTAO_POLL_MINUTES_DEFAULT } from '@workbench/zentao'

/**
 * 应用级设置（F-8.x）。
 *
 * **这是渲染层看到的那份完整设置**：外观那几项（见 APPEARANCE_SETTING_KEYS）实际存在
 * 主题文件 `theme.json` 里，由适配层读的时候合过来、写的时候按白名单分回去
 * （见 @workbench/appearance 与 persisted-data.ts 的桥接）。组件照旧在一个对象上读写，
 * 不必知道文件怎么分的。
 */
export interface AppSettings {
  /**
   * 程序名称：显示在标题栏、托盘提示与窗口标题上。
   * 空串 / 全空白 / 超长都会在落盘前被收敛，见 packages/appearance/src/app-name.ts。
   */
  appName: string
  /** 开机自启，默认开启 */
  launchAtLogin: boolean
  /** 主题，默认亮色 */
  theme: ThemeSource
  /** 全局快捷键是否启用 */
  hotkeyEnabled: boolean
  /** 唤起 / 隐藏主窗口的全局快捷键 */
  hotkey: string
  /**
   * 截图功能总开关：关掉之后快捷键与托盘项都不再起截图（功能本身还在，
   * 设置界面里那颗「试一下」照旧能按）。
   */
  captureEnabled: boolean
  /**
   * 起截图的全局快捷键（默认 F1，与 Snipaste 同一个键）。
   * 认不认得出交给 Rust 的 tauri-plugin-global-shortcut 解析，注册失败会在设置里报出来。
   */
  captureHotkey: string
  /**
   * 笔记编辑器的自定义快捷键表（动作名 → 组合键串）。
   *
   * **只存用户改过的项**：表里没有的动作走 Vditor 内置键位；显式存空串 = 禁用该动作的
   * 自定义键。动作清单、收敛与撞键腾位都在 `@workbench/notes` 的 editor-hotkeys.ts。
   * 只在本机的编辑器里生效（不注册系统级热键），进数据文件、不参与外观同步。
   */
  editorHotkeys: Record<string, string>
  /**
   * 截图的自动保存目录，空串 = 还没设置（那时「保存」会弹一次「另存为」）。
   * 只对本机成立（是本机的一个盘位），进数据文件、不参与外观同步。
   */
  captureSaveDir: string
  /** 新钉图的初始透明度（百分比，20~100） */
  capturePinOpacity: number
  /** 选区时显示放大镜与像素取色（放大镜挡视线时关掉它） */
  captureMagnifier: boolean
  /**
   * 网速球（桌面上随便摆、拖到屏幕左右边就收起来的那颗球）的总开关，默认关。
   *
   * 它是一扇独立的置顶窗口（见 docs/modules/float-ball.md），主窗口收进托盘也照样在；
   * 位置只对本机成立（是这块屏的坐标），所以它进数据文件、不参与外观同步。
   */
  ballEnabled: boolean
  /** 终端面板展开时的高度（px），由拖动面板上沿决定 */
  terminalHeight: number
  /**
   * 终端收起后，窗口最右侧那颗悬浮按钮的纵向位置。
   *
   * `null`（默认）= 没拖动过，按钮落在终端面板自己的位置上（面板纵向中线），
   * 由渲染层按当前面板高度现算；拖动过就是占窗口高度的百分比。
   *
   * 与 terminalHeight 不同，它**不进 theme.json**（见 appearance.ts 的白名单）：
   * 面板高度是「面板长什么样」，跟着主题走；而按钮落在屏幕的哪一处只对这台机器成立。
   */
  terminalButtonTop: number | null
  /**
   * 工作区背景图的磁盘路径，空串表示用默认的纯画布。
   *
   * 只落盘路径：图片本身不进数据文件（用户可能选的是几兆的照片），
   * 每次要用时由主进程读出来、压到合适尺寸后再交给渲染层。
   */
  workspaceBackground: string
  /** 背景图浓淡（百分比，越大图越清楚，蒙版越淡） */
  workspaceBackgroundOpacity: number
  /**
   * 主题色（#rrggbb）：开关、选中、聚焦这类交互态与主按钮用它。
   * 空串表示用默认的中性色（亮色近黑、暗色近白），也就是界面原本的灰度样子；
   * 只接管交互态，状态色（--st-*）与终端（--term-*）不受影响。
   */
  accentColor: string
  /**
   * 铺在主题色上的文字色：auto 按主题色深浅自动挑（红底白字、浅灰底黑字），
   * white / dark 是用户手动钉死的选择。没设主题色时无意义。
   */
  accentInk: AccentInkMode
  /** 顶部三条栏的样式，默认 clear（三条全透），设置界面里叫「正常 / 毛玻璃 / 透明」 */
  topBarStyle: TopBarStyle
  /**
   * 卡片不透明度（百分比，越大越实）：首页工作台面板与项目卡共用的底色浓度。
   * 只管背景这一层，边框、阴影与里面的文字不变；100% 就是原本的实底卡片。
   */
  cardOpacity: number
  /**
   * 毛玻璃的面要不要四周那条 1px 的描边（默认不画）。
   * 收敛与默认值都在 `packages/appearance/src/appearance.ts`，落地见 bootstrap.ts 的 writeGlassBorder。
   */
  glassBorder: boolean
  /**
   * 笔记文件夹（用户自己挑的一个目录）：笔记页的目录树就是它里面的 `.md` 文件。
   *
   * 空串表示还没选过 —— 笔记页据此显示「先选一个文件夹」的引导，
   * 在那之前不给任何操作入口（见 NotesView）。它**不进 theme.json**：
   * 这个目录只在这台机器上成立，同步时不该把它带到另一台机器上。
   * 空白与末尾分隔符由 `sanitizeNoteRoot` 收敛（`C:\` 这种盘根要留住分隔符）。
   */
  noteDir: string
  /**
   * 打开过的笔记本（最近打开的在最前面，最多 `NOTE_HISTORY_MAX` 条）。
   *
   * 与 `noteDir` 一样只对本机成立，所以也住在数据文件里、不参与同步。
   * 它是笔记页左栏底部那份「最近打开」的来源：换回上一个笔记本不必再翻一遍目录树。
   * 每一条都能单独删掉（那个目录也许已经不在了）。
   */
  noteDirs: string[]
  /**
   * 笔记里粘贴的图片推到哪个 git 仓库。空串 = 未配置（粘贴时会提示去哪儿填）。
   *
   * 这是个**新的出网口子，且由用户显式开出来**：只有填了地址、且用户真的粘贴了图片，
   * 才会走一次 git（推送目标就是用户自己填的那个仓库，不经过任何第三方服务）。
   * 与 Token 同步同一个机制（系统 git 凭据，或登录账号的 token），见 docs 的「数据与隐私」。
   * 推上去落在仓库的哪一层不在设置里，定死是 `images/<本机设备>/<笔记本>/<文件名>`
   * （见 packages/notes/src/note-image.ts 的 imageScopeDir）——分这两层是为了让素材管理只看得到
   * 「当前这个笔记本在这台机器上传的图」，仓库是所有笔记本、所有机器共用的一份。
   */
  noteImageRepo: string
  /**
   * 技能库目录（用户自己挑的一个目录）：技能就是它下面的一个个子目录（每个带一份 SKILL.md）。
   *
   * 与 `noteDir` 是同一类东西、**互不相干**：可以正好是某个笔记本文件夹、某个仓库的一部分，
   * 也可以是一个专门的技能仓库（那时它自己就是仓库根）。哪个仓库负责它的版本与同步
   * **由磁盘决定**：从它开始看有没有 `.git`，没有就往上找最近的（见 packages/skills/src/skills.ts 的
   * `SkillLibraryState`）—— 所以这里没有「技能目录是仓库里哪一层」这种配置，也没有默认值：
   * 空串 = 还没选过，技能页显示引导。只对本机成立，进数据文件、不参与外观同步。
   */
  skillDir: string
  /**
   * 知识库文件夹（用户自己挑的一个目录）：**一个独立项目的根** —— `data/raw/` 放原始资料、
   * `kb/` 放整理好的条目、`index/index.json` 由「重建索引」生成（布局见 packages/kb/src/kb.ts 的
   * 常量与 docs 的「知识库」一节）。
   *
   * 读是只读的，写只有两处、且都由用户点出来：AI 助手里那一轮整理（真正写文件的是 Pi，
   * 应用只递提示词与密钥）与重建索引（生成物）。与 `noteDir` / `skillDir` 同一类：
   * 空串 = 还没选过（知识库页与 AI 助手都显示引导），只对本机成立，进数据文件、不参与外观同步。
   */
  kbDir: string
  /**
   * 原始数据的来源（知识库页「原始数据」签最外层那一格）：来源名 → 本机一个文件夹。
   *
   * **配置只是一层映射**：应用不搬运、不复制、不删除任何文件，改的只有「去哪儿读」。
   * 逻辑路径始终是 `data/raw/<来源名>/…`（条目 frontmatter 的 source 引用的就是它），
   * 所以来源换一个位置不用改任何条目。没配过的来源照旧读库里的 `data/raw/<名字>`
   * （兼容层）；`dir` 为空 = 还没指定（树里照样占一行，点它就能再指定）。
   * 收敛与口径见 packages/kb/src/kb.ts 的 KbRawSource / sanitizeKbRawSources。
   *
   * 换台机器就不成立（路径是本机的），所以进数据文件、不参与外观同步 —— 与 `kbDir`
   * 同一类。每条带 root：来源名在不同知识库里可以重名，映射只对它那个库生效。
   */
  kbRawSources: KbSourceLink[]
  /**
   * Git 页上次打开的那个文件夹（空串 = 还没打开过）。
   *
   * 它可能是仓库里的一个子目录（`.git` 在外层）：页面按它恢复，左栏目录树也只展开这个子树。
   * 与 `noteDir` / `skillDir` / `videoDir` 同一类：本机的一个目录，进数据文件、
   * 不参与外观同步。空串时 Git 页显示「选一个仓库」的引导；打不开时照实提示，
   * 不把它悄悄清掉（仓库可能是移动硬盘 / 网络盘，下次插上还能用）。
   */
  gitRepo: string
  /**
   * Git 页「最近打开的文件夹」清单（最近打开的在前，最多 `GIT_REPO_HISTORY_MAX` 个）。
   *
   * 存的是用户选中的那个文件夹（可能是仓库里的子目录），不是解析出来的仓库根 ——
   * 从下拉里换回来时目录树还停在同一个子树。与 `gitRepo` 同一类：本机路径，进数据文件、
   * 不参与外观同步。打不开的条目照旧保留（仓库可能在移动硬盘 / 网络盘上，下次插上还能用）。
   * 收敛口径见 packages/git/src/repos.ts。
   */
  gitRepos: string[]
  /**
   * AI 助手配过的服务（模型管理弹窗里那一屏）：一个服务 = 名称 + Base URL + API 形态 +
   * 模型清单（每条带上下文与思考档位）。密钥不在这里 —— 它在 Windows 凭据管理器里
   * （`ai/<服务 id>/token`），由 Rust 取出来注入子进程的环境变量。
   *
   * 停用的服务不进 Pi 的 models.json、也不能当默认模型。形状与收敛（含限量与去重）见
   * packages/ai/src/ai.ts 的 AiProvider / sanitizeAiProviders。
   */
  aiProviders: AiProvider[]
  /**
   * 默认模型（模型管理弹窗顶上那一栏）：跑一轮用哪个服务的哪颗模型，行为记忆。
   * 空串 = 没挑过，用清单里第一个能挑的；挑过的那个被关掉 / 删掉 / 服务被停用时也退到
   * 那一个 —— 成不成、退回哪一个都在 packages/ai/src/ai.ts 的 pickAiChoice 里定。
   */
  aiDefaultProvider: string
  aiDefaultModel: string
  /**
   * 思考等级：Pi 的 `--thinking` 认的那七档之一（`off` / `minimal` / … / `max`），
   * 界面上也是一个下拉。收敛在 packages/ai/src/ai.ts 的 sanitizeAiThinking
   * （认不出的回它自己的默认档 medium）。
   */
  aiThinking: string
  /**
   * 工具权限：`auto-edit`（自动编辑，命令先问一句）或 `full`（完全访问，什么都不问），
   * composer 左边那一栏挑（形状与收敛在 packages/ai/src/ai.ts 的 AI_PERMISSION_MODES /
   * sanitizeAiPermission，默认自动编辑）。它交给 Rust 决定加不加载那份确认扩展
   * （ai.rs **只把 `full` 当「不问」**，认不出的按自动编辑走）—— 问不问是结构上的差别，
   * 不是「问了然后自动答是」。
   */
  aiPermission: string
  /**
   * AI 助手的会话（最新的在前）：一个会话 = **一个工作目录里的一段连续对话**，
   * 在 AI 助手页左栏那棵两层树上就是「项目 → 会话」里的第二层。
   *
   * 这里只存**调度用的那点东西**（id / 目录 / 标题 / 时间），对话本身不在应用的数据文件里
   * —— 它由 Pi 自己写进会话文件（数据目录的 `pi\sessions\`：安装版
   * `%APPDATA%\Workbench\data\`、开发版 `%APPDATA%\Workbench-dev\data\`，同一条 id），
   * 打开会话时经 RPC 的 `get_messages` 读回来画（见 packages/ai/src/ai.ts 的 sessionMessagesToLines）。
   * 收敛（去空、去重、限量）在 packages/ai/src/ai.ts 的 sanitizeAiSessions。
   */
  aiSessions: AiSession[]
  /**
   * 左栏上选中的那个会话（行为记忆：换台机器就不成立，所以住这儿而不是主题文件）。
   * 认不出来的（被删掉的）回最近说过话的那个，一个会话都没有时是空串。
   * 判定在 packages/ai/src/ai.ts 的 pickAiActiveSession。
   */
  aiActiveSession: string
  /**
   * **关掉的技能**（键是「技能根 + 技能名」，见 packages/ai/src/pi-skills.ts 的 skillKey）。
   *
   * 形状是「被关掉的那些」而不是「开着的那些」：新装进来、别处（技能页、别的 agent）
   * 放进来的技能默认就是开着的，不需要应用替它们登记一遍；被删掉的技能在这里留一条死键，
   * 除了占几行什么也不影响。收敛在 packages/ai/src/pi-skills.ts 的 sanitizeAiSkillsOff。
   */
  aiSkillsOff: string[]
  /**
   * 天气城市名：顶栏问候语旁显示当地实时天气，空串表示不显示（也就不联网）。
   *
   * 这是**第七个联网出口、且由用户显式开启**：填了城市才会按间隔去取 Open-Meteo 的
   * 免费接口（白名单见 src-tauri/src/weather.rs），城市名会作为查询串发出去 ——
   * 这是这条出口唯一发送的用户内容。只对本机成立，进数据文件、不参与外观同步。
   * 取值由 packages/weather/src/weather.ts 的 sanitizeWeatherCity 收敛。
   */
  weatherCity: string
  /**
   * 邮箱账户清单（`@workbench/mail` 的 MailAccount[]，可同时配多个 —— 收件箱合并成
   * 一份按时间排，清单行标注来源；旧数据的单个 mailAccount 在收敛里搬进来）。
   *
   * 这是**第十个联网出口、且由用户显式开启**：清单里有地址（且授权码在凭据管理器里）
   * 才会连各账户配置的那两台 IMAP/SMTP 服务器，主机名不设白名单 —— 与 AI 助手的
   * Base URL 同属「地址由用户给」的出口。授权码不落这份明文 JSON，它在 Windows
   * 凭据管理器（`Workbench/mail/<地址>/token`，见 src-tauri/src/mail.rs）；
   * 邮件 HTML 正文的外链资源在渲染层一律不加载 —— 除收发服务器外这条功能没有别的目标。
   * 取值由 @workbench/mail 的 sanitizeMailAccounts 收敛（逐项 sanitize / 去重 / 上限 5）。
   */
  mailAccounts: MailAccount[]
  /**
   * 广告发件人黑名单（邮箱页右击「标记为广告」攒下来的）：一个地址进去，这个发件人
   * **过去与将来**的信在清单里都算广告（@workbench/mail 的 isBulkMail 第一判法）。
   * 只对本机成立，进数据文件、不参与外观同步；取值由 sanitizeMailBulkSenders 收敛
   * （trim / 小写 / 去重 / 认不出像地址的丢掉 / 上限 500）。
   */
  mailBulkSenders: string[]
  /**
   * 通讯录（邮箱页右键「存为联系人」攒的、在联系人弹层里手动加的）：写邮件时收件人
   * 从它里面挑（也允许当场打一个新地址）。**地址就是身份**，按地址去重、名字只是叫法。
   * 只对本机成立，进数据文件、不参与外观同步；取值由 @workbench/mail 的
   * sanitizeMailContacts 收敛（没地址的丢 / 按地址去重 / 上限 500）。
   */
  mailContacts: MailContact[]
  /**
   * 后台新邮件检查的周期（分钟）：0 = 关闭（只保留进页面 / 手动刷新的检查），
   * 其余夹在 1..1440。周期由邮箱账户弹层里的「新邮件检查」下拉改，改了即生效
   * （store 的 startWatch 会把整份监视配置重登给 Rust）。取值由
   * sanitizeMailPollMinutes 收敛（非数字回默认 30）。
   */
  mailPollMinutes: number
  /**
   * 禅道后台检查间隔（分钟）：0 = 关闭，其余为 1..1440。
   * 只落本机数据文件，不参与外观同步；默认值与收敛由 @workbench/zentao 定义。
   */
  zentaoPollMinutes: number
  /**
   * Token 用量同步仓库地址（git 远程地址），空串表示不同步。
   *
   * 多台机器各自把「本机分片」推到这一个仓库里，读的时候全量合并 ——
   * 一个设备一个文件，所以永远不会有同文件冲突（详见 packages/usage/src/token-usage.ts 的文件头）。
   * 值会被 shared 的 sanitizeSyncRepo 收敛：带空白或以 `-` 开头的一律当没填。
   *
   * 仓库里放的是模型名与 token 计数，**没有对话内容**，但仍然建议用私有仓库。
   */
  tokenSyncRepo: string
  /**
   * 上次停留的页面（左侧导航栏的当前项，见 packages/appearance/src/views.ts）。
   *
   * 放在设置里，只是因为设置本来就是「随数据文件落盘的界面状态」的容身处
   * （终端高度、顶部样式、卡片不透明度都在这里）——它不是设置界面上的选项，
   * 只用来让重启后回到上次那一页。
   */
  activeView: ViewId
  /**
   * 左侧导航栏上**关掉**的页（见 packages/appearance/src/views.ts）。空数组 = 四页都显示。
   *
   * 存「关掉了哪些」而不是「显示了哪些」：将来加一页时老配置里没有它，新页对所有人就是默认
   * 可见的，不必去动谁的数据文件。收敛保证至少留一页（全关掉时留下首页）。
   *
   * 它住在 theme.json 里（见 appearance.ts 的白名单），与明暗、布局同属「界面长什么样」，
   * 同步时跟着整份配置一起带到另一台机器；而上面的 `activeView` 留在数据文件里 ——
   * 「这台机器上次停在哪儿」跟配置不是一回事。
   */
  hiddenViews: ViewId[]
  /**
   * 左侧导航栏的**显示顺序**（一个 ViewId 的排列，见 packages/appearance/src/views.ts 的 sanitizeViewOrder）。
   *
   * 与 `hiddenViews` 同一批：都是「导航栏长什么样」的配置，住在 theme.json 里、跟着外观
   * 同步走。收敛保证它恰好是全部页面的一个排列（落下的补到末尾），老文件没有这个字段
   * 时就是 VIEW_IDS 的默认顺序。
   */
  viewOrder: ViewId[]
  /**
   * 左侧导航栏整条**收起来**了吗（顶栏右上角那颗折叠按钮切换）。
   *
   * 与 `hiddenViews` 同属「导航栏长什么样」，住在 theme.json 里跟着外观同步走；
   * 收起来只是不画这一列，页面照常可以从顶栏按钮换。收敛只在明确写了 true 时才认
   * （老主题文件里没有这个字段 = 展开）。
   */
  navHidden: boolean
  /**
   * 项目页的排序方式（见 packages/core/src/project-sort.ts）。
   *
   * 从这里开始这几项是**行为记忆**：记的不是界面长什么样，而是「你习惯怎么看」——
   * 上次用的那一档，下次打开还停在那儿，不必每次都重新拉一遍。
   *
   * 所以它们住在数据文件里、**不进 theme.json**：那是「这台机器该长成什么样」的配置，
   * 会整份同步到别的机器；而「我上一眼在看什么」换台机器不成立（与 `activeView` 同一条口径）。
   */
  projectSort: ProjectSort
  /** 工作页顶栏那一排的范围（待办 / 今天 / 昨天 / 本周 / 本月 / 自定义），同上 */
  workRange: WorkRange
  /**
   * 工作页「自定义」范围的两端（YYYY-MM-DD，含两端）；null = 还没选过。
   *
   * 与 `workRange` 同属行为记忆：选中「自定义」时用它筛时间轴，换台机器不成立，
   * 所以进数据文件、不进 theme.json。收敛见 packages/work-log/src/work-log.ts 的
   * `sanitizeWorkRangeBounds`。
   */
  workRangeCustom: WorkRangeBounds | null
  /** 工作页的排序维度（按时间 / 按项目） */
  workSort: WorkSort
  /**
   * 笔记页目录树里**摊开的那几层文件夹**（相对笔记根的路径，如 `工作/周报`）。
   *
   * 只对当前这个笔记本成立，所以换笔记本时清空 —— 相对路径在另一个笔记本里
   * 指的是完全不同的东西。与 `noteDir` 一样只在本机成立，不参与同步。
   */
  noteTreeExpanded: string[]
  /**
   * 视频文件夹（用户自己挑的一个目录）：视频页的目录树就是它里面的 `.mp4` 文件。
   *
   * 与 `noteDir` / `skillDir` 同一类：本机的一个目录，进数据文件、不参与外观同步；
   * 空串表示还没选过 —— 视频页据此显示「先选一个文件夹」的引导。
   * 收敛与 `noteDir` 同一条（见 packages/video/src/video.ts 的 `sanitizeVideoRoot`）。
   */
  videoDir: string
  /**
   * 打开过的视频目录（最近打开的在最前面，最多 `VIDEO_HISTORY_MAX` 条）。
   *
   * 视频页左栏底部那份「最近打开」的来源，与 `noteDirs` 同一条口径。
   */
  videoDirs: string[]
  /**
   * 视频页目录树里**摊开的那几层文件夹**（相对视频根的路径）。
   *
   * 与 `noteTreeExpanded` 同一条口径：只对当前这个目录成立，换目录时清空。
   */
  videoTreeExpanded: string[]
  /**
   * **上次打开的视频**（相对视频根的路径）：进视频页时直接接上播放。
   *
   * 只对当前这个目录成立 —— 换目录时清空（相对路径在另一个目录里指的是别的东西）；
   * 文件被删掉 / 改名后在下次进页面时发现树里没有它，顺手清掉。与 `noteTreeExpanded`
   * 同一批行为记忆：本机成立、进数据文件、不参与外观同步。
   */
  videoLastRel: string
  /**
   * 密码页**用户拖出来的分组顺序**（「分组设置」弹窗里那一行行的先后）。
   *
   * 与上面那几项同一批行为记忆：住数据文件、不进 theme.json（那是会整份同步的「这台机器该长成
   * 什么样」），**也不进 vault.json** —— 那份只装条目本身，往信封里加视图偏好会牵动跨设备合并的口径。
   * 代价是换台机器要重新拖一次，换来的是合并规则一个字都不用动。
   *
   * 只记「拖过的那几组」：名单里没有的分组排在名单之后、按名字（新加一个分组不必先去弹窗里
   * 拖一下才看得见）。**藏起来的分组照常在名单里** —— 藏一下再放出来，位次还是原来那个。
   * 名字的收敛在 `sanitizeVaultGroupNames`（去空白、去重、限长限条数）。
   */
  vaultGroupOrder: string[]
  /**
   * 密码页**藏起来的那几组**（「分组设置」弹窗里关掉的那些开关）。
   *
   * 藏 = 整段不画、也不进搜索（想找就把开关打开）。它只管这一页画不画，
   * 不动记录本身，也不参与同步 —— 换台机器照旧全都看得见。
   */
  vaultHiddenGroups: string[]
}

/**
 * `workbench-data.json` 里真正落盘的那部分设置：外观与首页布局都住在 `theme.json`（见 appearance.ts）。
 * 同步时带走的也是后面那一份 —— 这里的快捷键、开机自启、仓库地址换台机器就不成立。
 */
export type StoredSettings = Omit<AppSettings, AppearanceSettingKey>

/**
 * 设置默认值。
 *
 * 不再是设计文档 4.8 里的出厂值，而是按当前正在使用的配置固化的：
 * 首次运行 / 数据文件里的 settings 整段缺失时，直接落成这一套。
 * 外观那批的默认值唯一口径在 @workbench/appearance 的 DEFAULT_APPEARANCE（从这里铺开），
 * 其余各项常量（终端按钮位置、思考档位……）也一并跟着改，保证「默认值」只有一处口径。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  ...DEFAULT_APPEARANCE,
  launchAtLogin: true,
  hotkeyEnabled: true,
  hotkey: 'Control+M',
  // 笔记编辑器的自定义快捷键：默认空表 = 全部走 Vditor 内置键位
  editorHotkeys: {},
  // 截图（见 docs/modules/screenshot.md）：默认 F1 起截图
  captureEnabled: CAPTURE_ENABLED_DEFAULT,
  captureHotkey: CAPTURE_HOTKEY_DEFAULT,
  captureSaveDir: CAPTURE_SAVE_DIR_DEFAULT,
  capturePinOpacity: CAPTURE_PIN_OPACITY_DEFAULT,
  captureMagnifier: CAPTURE_MAGNIFIER_DEFAULT,
  // 网速球默认关：新功能不自己冒出来，去设置里打开（见 docs/modules/float-ball.md）
  ballEnabled: false,
  terminalButtonTop: TERMINAL_BUTTON_TOP_DEFAULT,
  noteDir: '',
  noteDirs: [],
  noteImageRepo: '',
  skillDir: '',
  kbDir: '',
  kbRawSources: [],
  gitRepo: '',
  gitRepos: [],
  aiProviders: [],
  aiDefaultProvider: '',
  aiDefaultModel: '',
  aiThinking: AI_THINKING_DEFAULT,
  aiPermission: AI_PERMISSION_DEFAULT,
  aiSessions: [],
  aiActiveSession: '',
  aiSkillsOff: [],
  weatherCity: '',
  mailAccounts: [],
  mailBulkSenders: [],
  mailContacts: [],
  mailPollMinutes: 30,
  zentaoPollMinutes: ZENTAO_POLL_MINUTES_DEFAULT,
  tokenSyncRepo: '',
  activeView: 'home',
  // 行为记忆：第一次打开时就是这几个默认档，之后记住用户自己选的那一档
  projectSort: PROJECT_SORT_DEFAULT,
  workRange: WORK_RANGE_DEFAULT,
  workRangeCustom: null,
  workSort: WORK_SORT_DEFAULT,
  noteTreeExpanded: [],
  videoDir: '',
  videoDirs: [],
  videoTreeExpanded: [],
  videoLastRel: '',
  // 密码页：没拖过顺序（按名字排）、一组都不藏
  vaultGroupOrder: [],
  vaultHiddenGroups: [],
}
