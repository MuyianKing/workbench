# 邮箱（mail）

邮箱（mail）的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`packages/mail/src/`（账户配置的形状与收敛、RFC 2047 编解码、发信报文构建
`mime.ts`、收信解析与沙箱正文 `parse.ts`、广告识别与发件人黑名单 `bulk.ts`，全部带单测；MIME 解析用 postal-mime）、
`apps/desktop/src-tauri/src/mail.rs`（Schannel TLS + 手写的 IMAP/SMTP 命令子集 + 全部
`mail_*` 命令）、`apps/desktop/src-tauri/src/mail_watch.rs`（后台监视：按设置周期的新邮件
检查 + 系统通知）、`apps/desktop/src-tauri/src/notify.rs`（Windows toast 的 WinRT FFI）、
`apps/desktop/src/renderer/src/workbench/mail.ts`（适配）、
`apps/desktop/src/renderer/src/stores/mail.ts`（缓存与策略）。

- **第十条出口，「地址由用户给」**：邮箱地址留空 = 整条出口关闭；填了地址（且授权码进了
  凭据管理器）才会连**用户配置的那两台**收发服务器，主机名不设白名单 —— 与 AI 助手的
  Base URL 同属一类出口。**外链图片跟着信里的地址加载**（营销信的主视觉直接可见，
  请求不带 Referer —— htmlBody 注入 CSP `img-src *` + no-referrer，iframe 再补一层
  `referrerpolicy`），脚本 / 字体 / 音视频 / iframe 等其余外链资源照旧一张都不许加载；
  这条功能的网络目标只有收发服务器与信里引用的图片主机，渲染层照实传 `htmlBody` 的产物，
  不要把 CSP 收回「只放行 data:」。
- **授权码只进凭据管理器，绝不落 JSON、绝不回渲染层**：`mail_key_save` 存
  `Workbench/mail/<地址>/token`（credentials.rs，DPAPI 按用户加密，按地址一条 ——
  天然多账户），之后 Rust 侧命令自己读（`auth_code`）；渲染层只在「验证并保存」那一次经参数递它。
  界面上只显示「已配置 / 未配置」。连接参数（地址 / 主机 / 端口）走 `settings.mailAccounts`
  落 workbench-data.json，由 `sanitizeMailAccounts` 收敛 —— 这两者是两条不同的落盘，别混。
- **多账户**：账户是一份清单（`settings.mailAccounts`，上限 5 —— 逐项收敛、按地址去重，
  没地址的半截丢掉），当前文件夹里各账户合并成**一条按时间排的时间线**（按头部日期新在前，
  不按来源分组），每封摘要带来源账户：多账户时清单行标注 `accountTag`（本地部分 + 域名第一段）、
  阅读栏标全地址，只有一个账户时什么都不标。清单上的操作都认 **(文件夹, 账户, uid) 复合身份**
  （`key`）—— uid 只在单个文件夹里唯一，收件箱与已发送各是一套 UID 序列；删信按
  (文件夹, 账户) 分组（一个账户一条连接，各自整批 EXPUNGE），某个账户拉取或删除失败只记
  它一句话，不挡别人。
- **两个文件夹：收件箱 / 已发送**，渲染层只说这两个逻辑名（`@workbench/mail` 的
  `MailFolder`）。**服务器上的文件夹名不写死**：网易把「已发送」报成 modified UTF-7 的
  `&XfJT0ZAB-`、腾讯报成 `Sent Messages`、自定义服务器什么都可能 —— mail.rs 先
  `LIST "" "*"` 认 RFC 6154 的 `\Sent` 特殊用途属性（服务器自己说的，最可靠），认不出再按
  候选名比（`SENT_MAILBOX_NAMES`），最后才按层级末段比一次（`INBOX.Sent` 这种写法），
  都认不出就报一句「这个账户里没找到已发送文件夹」。
  **不做任意文件夹列表**（草稿 / 垃圾 / 已删除都不进界面），也**不发 APPEND**：163 / QQ 的
  SMTP 发完服务器自己会往已发送存一份，客户端再塞一次会出两封，所以发件箱只读。
- **已读标记只对收件箱发**：发件箱里的信本来就是读过的，别白写一趟服务器；界面那边发件箱
  也不画未读点、不摆「标记未读」，右键菜单里广告与已读两项都不出现（那儿的发件人是自己）。
- **职责切分：Rust 只做传输，邮件语义全在 TS**：Rust 按「现连现断」跑 IMAP/SMTP 命令子集，
  回结构化摘要与原始报文（base64）；MIME 解析（postal-mime 包装）、发信报文构建
  （buildMime）、RFC 2047、展示拆解全在 @workbench/mail（有单测、改动走热更新）。
  不要往 Rust 侧加 MIME / 编码逻辑。
- **附件名：两份参数都在时认 RFC 2231 的扩展那份**（`filename*=` / `name*=`）。postal-mime
  的口径正相反 —— 同名纯参数优先（它 decodeParameterValueContinuations 里那条守卫，
  changelog 4.0.3 明说的），于是我们自己发出去的
  `filename="__ DOCX __.docx"; filename*=utf-8''…` 读回来只剩那串下划线，中文名全成了 `__`。
  所以 `parseMessage` 在把字节递给它之前先跑一遍 `preferExtendedFilenames`（摘掉同名纯参数、
  只摘这两行头，报文体一个字节不碰），回调给它的解码器。**别摘这一层**，
  也别把纯参数写回去 —— 只有扩展参数的那种来信（大多数客户端发的）本来就解得对。
  报文里没有扩展参数时这一层原样把字节递过去，不做多余的文本转换。
- **网易 IMAP 必须先报身份**：不发 `ID` 命令，SELECT 直接吃 `Unsafe Login` 闭门羹
  （rust-imap 不支持这条，这就是手写协议子集的原因）。mail.rs 的流程是 LOGIN 后发 ID、
  SELECT 被拒且错误里带 Unsafe 时补发 ID 重试一次。改这段流程别把 ID 弄丢。
- **连接是现连现断的，后台只有一件事**：进页面 / 手动刷新 / 发信 / 切文件夹各是一次独立连接，
  不缓存到磁盘（正文按 (文件夹, 账户, uid) 缓存在页面会话内存里）；后台**只**有邮件监视这一条
  （见下一条）。明确不做任意文件夹（只有收件箱与已发送）、邮件搜索、STARTTLS（只用隐式 TLS
  端口，993 / 465）。
- **后台监视（mail_watch.rs）**：配了账户（渲染层 `startWatch` 登记进来）就按登记的
  周期对每个账户现连现断查一轮**收件箱**最近 50 封的摘要（只查收件箱 —— 新邮件提醒跟
  自己发出去的信没关系）—— 周期是设置里的 `mailPollMinutes`
  （分钟，默认 30，下限 5 / 上限 24 小时，0 = 关闭；账户弹层末尾的「新邮件检查」下拉改，
  改了立即重登监视配置）。判「基准之后到达且**未读**」的新信 ——
  判定刻意保守：手机上读过的不再吵；广告黑名单（`mailBulkSenders`，用户亲手标的）
  里的发件人不弹；`isBulkMail` 的完整启发式不在这里重复。UID 基准连同 UIDVALIDITY
  落 `data/mail-watch.json`（只是通知的记账，不进同步仓库；丢了无非多弹或少弹一条）。
  轮询放在 Rust 而不是渲染层：窗口收进托盘后 WebView 的定时器会被节流，靠它计时不诚实。
  清单为空 = 监视空转，出口依旧「配了账户才开」。
- **系统通知（notify.rs）是手写的 WinRT toast**：不给 tauri-plugin-notification 那串新
  编译单元开口子 —— 与 Schannel / Hello 同一条口径，只给已有的 `windows` crate 加
  feature。非打包应用弹 toast 的前提是开始菜单里有挂着 AUMID 的快捷方式：安装器建的
  那条自带 identifier（tauri-bundler 模板的 `${BUNDLEID}`），dev / 便携运行由
  `ensure_aumid_shortcut` 补一条。点击挂 in-process 的 `Activated` 事件 —— 进程死了
  toast 也不在场，不存在「点了没反应」的第三种情况；点击后 Rust 唤出主窗口并发
  `mail:notify-click`（账户, uid），渲染层换到邮箱页、打开那封（找不到只开页面）。
  **一个排查过的坑（2026-10-07）**：Windows 对每个 AUMID 有一条**按应用的通知开关**，
  关着的时候 `Show()` 照样成功、通知却静默消失（事件日志
  `Microsoft-Windows-PushNotification-Platform/Operational` 里记 `ToastSettingDisabled`）。
  这个开关的**权威存储是通知库** `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`
  的 `HandlerSettings.s:toast`（每个 AUMID 一行，0 = 禁），注册表
  `HKCU\...\Notifications\Settings\<AUMID>` 的 `Enabled` 只是镜像 —— 只改镜像平台不认。
  notify.rs 弹之前用 `ToastNotifier.Setting` 自查，被禁时给出指路「设置 > 系统 > 通知」
  的报错而不是静默；ZCode 的通知能用不是因为代码不同（同为系统 toast），是它的
  `s:toast` 没被关过。
- **HTML 正文渲染是 sandbox 的 iframe**：脚本、同源、表单、弹窗全禁
  （只放行 `allow-top-navigation-by-user-activation`）—— 与 AI 预览栏（AiPreviewHtml.vue）
  同一条硬边界：邮件的 HTML 绝不能在带宿主能力的 webview 里执行。没有 HTML 正文时按
  纯文本排版，两者不混渲染。**边界上两个刻意的口子**：
  ① **外链图片** —— CSP `img-src * data:`（htmlBody 注入）放行，营销信的主视觉直接可见，
  请求不带 Referer；其余外链资源（脚本、字体、音视频、iframe）照样掐死。
  ② **链接** —— 三处配套：`htmlBody`（parse.ts）把每个 `<a>` 统一改写成
  `target="_top"`（点链接在 iframe 里走不通，只能往顶层窗口导航）→ MailView.vue 的 iframe
  只放行「用户点出来的顶层导航」（脚本自动跳转照样被沙箱掐死）→ main.rs 的
  `on_navigation` 把这次导航拦下：应用自己的页面照常放行，http(s) / mailto 交给系统浏览器
  开，其余 scheme 一律取消。改任何一处都要三处一起看。
- **大小上限两侧同源**：发信 30 MB（`mime.ts` 的 `MAX_MESSAGE_BYTES` = Rust `mail.rs` 的
  `MAX_MESSAGE_BYTES`，构建这一步就拦）、拉正文 24 MB（与 AI 预览栏二进制同一口径）。
  改就两边一起改。

## 实现

- **页面**（MailView.vue）：左清单右阅读的左右分栏（与 AI / 笔记 / 视频页同一副外壳），
  左栏宽度住 theme.json 的 `mailListWidth`（拖两栏之间那条缝改，PanelResizer 三段式：
  拖动只改本地、松手落盘）。**左栏头部是一颗分段选择器**（`el-segmented`，收件箱 / 已发送；
  换文件夹就把多选态收掉 —— 勾选是按旧文件夹的身份记的）。清单行拆在 MailListRow.vue
  （收件箱清单 / 推广段 / 发件箱共用一副）：行首复选框，
  第一行「未读点 + 发件人 + 日期」（发件箱里换成收件人、不画未读点）、
  第二行「主题 + 附件回形针 + 来源（多账户时）」；
  底部一行是「账户 / 写邮件」两个入口。拉列表的时机：页面挂载、
  KeepAlive 换页回来（onActivated）、点刷新、切文件夹；`listInFlight` 挡住重复，
  拉的中途切了文件夹就把这批结果丢掉（`requested !== folder` 那条比对）。
  发件人展示名与主题的 RFC 2047 解码在行组件里做（`displaySender` / `decodeEncodedWords`），
  收件人那一路是 `displayRecipients`（顿号连接，引号串里的逗号不当分隔符）。
- **读信**：点清单行 → `mail.openMail(item)` → 高亮（`activeKey`）在点击那一刻就切，
  正文缓存查一次，有就开；没有才 `mail_fetch_body`（base64 回来；收件箱顺带标已读，
  发件箱不标）→
  `parseMessage` 拆成
  文本 / HTML / 附件 / 内联图 → `htmlBody` 生成沙箱文档（注入 CSP、cid 换 data URL、
  链接统一 `target="_top"`）。下载期间又点别的不再被吞：排队等当前这封完事接着开
  （只记最后一封）；下载完时若用户最新点的已不是它，只进缓存不换内容 —— 高亮与
  阅读栏永远指同一封。
  列表上的未读点就地更新。阅读栏头部是「回复」（发件箱里第一行摆收件人，前面挂一个
  安静的「收件人」小字；回复也发给当初收到这封的人 —— `recipientAddress`）、
  「标记已读（未读）」（只在收件箱画），多账户时还标收自哪个邮箱 —— 回信默认就从它发；
  附件一颗一片，按 `attachmentKind`（packages/mail）分三种打开方式：**能在应用里打开的，
  整片都是打开的入口**（片子是「一颗内层按钮 + 右端一颗另存图标」拼的 —— 按钮不能套按钮，
  另存留在外层）—— 图进 EP 的 `el-image-viewer`（页面持一个实例：该封里所有图左右切、
  滚轮缩放、Esc 或点外面关掉，`teleported` 才不会被子栏的 overflow 裁掉）；**md / docx /
  pptx 进预览弹层**（MailAttachmentDialog：md 借 MarkdownView、docx 借 AiPreviewDoc、
  pptx 借 AiPreviewSlides —— 三件都只吃 base64、都在浏览器里画、都不出网，pptx 的
  pdfjs 兜底在那边显式关着）；应用里画不了的（pdf / 压缩包 / 老式 .doc .ppt）整片点开
  就是「另存为」（pickSavePath 挑路径 + `mail_attachment_save` 落盘，与 vault_key_export
  同一个信任模型）。片子的样子：左首是**这张片子的样子** —— 图给缩略图、其余给
  `attachmentBadge` 出的类型角标（DOCX / MD / PPTX / PDF，定宽所以名字对得齐），
  名字走 `--ink`、大小退到 `--ink-3`；图与缩略图都取 `attachmentDataUrl` —— 手里的 base64
  拼 data URL，预览不落盘。**md 是唯一一处把邮件内容画进宿主 webview 的地方**：
  走 markdown-it（`html: false`，原文标签早被转义过，v-html 拿到的是安全片段），
  正文里的外链图片跟着信里写的地址加载 —— 与 HTML 正文那条外链图片的口子同一个口径，
  别在这条路上放脚本。
- **删除（右键入口，多选态勾选）**：右键菜单的「多选删除」是入口 —— 把右击的这封勾进
  批次的同时进入**多选态**（Ctrl+点选 / Shift+点范围 / Ctrl+A 也进）：每封左侧亮出复选框
  （**不常驻**，平时点行就是开信），点行从「开信」变成「勾 / 撤」（Shift 从锚点整段勾），
  清单上方出一条操作条「已选 N 封」——删除（确认框过一道，只删此刻看得见的勾选）与取消。
  **多选态是显式的开关，不跟着勾选数走**：勾选条左侧那颗**三态全选框**（看得见的全勾上 =
  勾、勾了一部分 = 半勾）取消勾选只是**清掉勾选**——复选框还亮着、接着挑；删完一批也
  留在多选态里；只有操作条上的「取消」或 Esc 才退出（复选框收起，点行恢复开信）。
  全选框勾上 / Ctrl+A = 勾上看得见的全部（含展开着的推广段）。右键菜单跟着勾选态变：
  已勾选时「多选删除」变成「删除所选 N 封」——直接确认删掉整批；「删除邮件」始终只删
  右击的那一封。服务器侧只有一条
  链路：`mail_delete` 收 (文件夹, uid 数组)，一条 IMAP 会话 `UID STORE 3,5,9` 整批标 \Deleted、
  一次 EXPUNGE（EXPUNGE 收走的是**所有**带 \Deleted 的信 —— 本命令每次独立连接、只标
  这一批，所以收走的就只有它们；单封也走它）；勾选跨账户时 store 按 (文件夹, 账户) 分组，
  一个账户一条连接，某个账户失败只记它一句话、其余照删。删成后清单就地摘掉、正文缓存扔掉、
  正在读的关掉，不等下次刷新；删中那几行变淡转圈接不住点。推广段收着时看不见的行
  不参与勾选与删除。
- **账户弹层**（MailAccountDialog.vue，penetrable）：上半是已配账户的清单（逐个
  「编辑 / 删除」，可同时配多个，上限 5），下半是表单 —— 新增一个，或编辑选中的那个。
  弹层末尾隔着一条细线是全局项「新邮件检查」（设置里的 `mailPollMinutes`，下拉：
  关闭 / 每 1..60 分钟）—— 后台监视的周期，改了立即落盘并重登监视配置，不进
  「验证并保存」链路。
  平常只有地址与授权码两样 —— 163 / 126 / QQ（含 foxmail.com）的收发服务器跟着地址
  后缀自动带出（`presetForAddress`），整段收进「服务器设置」；认不出的域名（自定义邮箱）
  才自动摊开，手改过服务器（`hostsTouched`）预设就不再覆盖。**编辑模式里地址锁死** ——
  地址是账户的身份，换地址走「删除 + 新增」，不做静默改名（免得旧账户的授权码被顺手
  清掉）。「验证并保存」一条链路：授权码重填了先 `mail_verify`（收发各连一遍）→ 连接
  参数 `updateSettings` 并进 `mailAccounts` 清单 → `mail_key_save` 存授权码；新增保存后
  弹层留着接着添下一个，编辑保存后关掉。**「删除」**（清单行上，走 ElMessageBox 确认）：
  该账户的授权码清出凭据管理器 + 从清单摘掉。校验失败就地显示（formError 行），不飘 toast。
- **写信弹层**（MailComposer.vue，penetrable）：配了多个账户才摆「发件邮箱」选择
  （回信默认收信的那个，新邮件是清单第一个；一个账户不画这栏）；收件人支持逗号 / 分号 /
  空白分隔、逐个验 @；附件 `pickFiles` 多选 + `readBinaryFile` 读成 base64（文件是用户
  亲手挑的，不需要圈范围）；回信预填 `Re:` 与 `> ` 引用体。发送失败表单原样留着，
  改一改能再发。**发送成功不主动重拉收件箱**（新信未必排得进最近 50 封，用户自己点刷新），
  但发件箱正开着就顺手重拉一次 —— 服务器把刚发的存进了已发送，切过去也一定能看到
  （`setFolder` 会重拉）。
- **列表摘要的来路**：Rust 按序号区间拉最近 N 封的 `UID FLAGS BODY[HEADER.FIELDS
  (FROM TO SUBJECT DATE)] BODYSTRUCTURE`，ENVELOPE 不用 —— 头部四件套是原始文本，
  拆解（编码词 / 名字与地址 / 日期）全在 TS。收件人（TO）收件箱用不上，发件箱的清单行
  与回信落点都要它，两个文件夹走同一条 FETCH（一份代码路径，不为一个字段分岔）。
  附件标记是 BODYSTRUCTURE 里找
  ATTACHMENT 的启发式，宁漏勿误。
- **广告邮件默认不画**（`bulk.ts` 的 `isBulkMail`，store 里过筛）：**用户标记远在前** ——
  清单行右击「标记为广告」（MailContextMenu），发件人地址进设置的 `mailBulkSenders`
  （sanitizeMailBulkSenders 收敛），这个发件人**过去与将来**的信都算广告；对着黑名单里
  的发件人再右击是「取消广告标记」。自动启发式只兜显然的：发件人地址的批量前缀
  （promo / newsletter 这类；order / service 这类事务性前缀与裸的 `news` 刻意不收 ——
  LinkedIn 这类正常通知就从 news@ 发）与主题广告词（中文包含、英文整词；词表刻意
  收得窄，只留不可能出现在事务信里的词 —— 「优惠 / 限时 / 优惠券 / 红包 / 周刊」这类
  在续费提醒、券过期通知、订阅的周刊标题里照样出现，收了就是一串误伤）。**`List-Unsubscribe` 头已弃用**——网易收件箱实测大量正常
  通知邮件也带它，单凭它一拦就是几十封误伤；头等原则不变：**误伤一封真信比放过一封
  广告难看得多**。这些信**不进收件箱清单**——收进清单底部分开的一段（「推广邮件 N 封」，
  默认折叠，展开也是自己的一段、不与正常邮件混排），勾选 / 删除 / 右键与正常邮件同一套，
  这是唯一的痕迹。**发件箱不筛广告**（那儿的「发件人」是自己，按发件人判广告毫无道理，
  右键菜单里也没有那一项）。改词表要连着 mail.test.ts 的口径一起过。
- **后台监视的链路**：App.vue 挂载时 `mail.startWatch()` → `mail_watch_register`
  （账户 + 黑名单 + 周期，内容签名比对，变了才重登）→ Rust 的 `mail-watch` 线程每分钟醒一次、
  距上轮满登记的周期才查（失败也记账，等下一个周期，不把服务器摁着打）。第一轮只立
  基准不弹（UID 序列还没对上号）；通知正文是「账户有 N 封新邮件」，不解读主题 ——
  RFC 2047 的解码在 TS，Rust 侧不复做一份；提示音显式挂系统的
  `ms-winsoundevent:Notification.Mail`（默认那声太轻，用户注意不到弹窗）。
  `refreshList` 的并发调用共享在途的同一
  个 Promise（页面挂载与通知点击可能前后脚各调一次）。
- **测试**：@workbench/mail 的 50 个用例（收敛 / 编码词 / 报文构建 / 解析与沙箱正文 /
  附件的打开方式、类型角标与图片判定 / **附件名的归一（含「自己发的信读回来是原名」整条路）** /
  广告识别 / 收件人列表的拆解）；
  mail.rs 的 `#[cfg(test)]`（字面量标记 / 括号项解析 / 头部折叠展开 / EXISTS /
  UIDVALIDITY / **文件夹：LIST 结果的解析（引号串与字面量两种名字）、`\Sent` 属性与
  候选名的取舍、逻辑名收敛** / 点填充 / SMTP 多行应答 / 参数收敛）；mail_watch.rs 的 `#[cfg(test)]`
  （新邮件判定：基准 / 未读 / UIDVALIDITY 换茬 / 黑名单 / 高水位不倒退 / 发件人地址拆解）；
  notify.rs 的 `#[cfg(test)]`（XML 转义 / PKEY 常量）。协议层没有真连接测试 —— 改了收发
  流程要拿真邮箱跑一遍（见 AGENTS.md 第 6 节的验证脚本），**认已发送文件夹这件事尤其
  要在网易与腾讯两边的真账户上各跑一次**（`\Sent` 报不报、名字是哪种写法只有真连才知道）。

## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

Rust 侧：

```text
apps/desktop/src-tauri/src/mail.rs
  邮箱宿主侧（163 / 126 / QQ 等用户配置的账户，可同时配多个）：Schannel TLS +
  手写的 IMAP/SMTP 命令子集（含 LIST 认「已发送」文件夹）+ mail_* 十个命令 ——
  第十条联网出口（授权码进凭据
  管理器）；网易 IMAP 要先发 ID 命令（否则 SELECT 报 Unsafe Login），见模块文档「约束」
apps/desktop/src-tauri/src/mail_watch.rs
  邮件后台监视：按设置周期（mailPollMinutes）的**收件箱**新邮件检查（UID 基准 + 未读 + 黑名单，进度落
  mail-watch.json）+ 弹系统通知；账户清单由渲染层 mail_watch_register 登记
apps/desktop/src-tauri/src/notify.rs
  Windows toast 的手写 WinRT FFI：ToastNotificationManager + AUMID 快捷方式
  （安装器建的那条自带 identifier，dev/便携由 ensure_aumid_shortcut 补），
  点击经 in-process Activated 回调回到本进程
```

渲染层：

```text
apps/desktop/src/renderer/src/workbench/mail.ts
  邮箱适配层：mail_* 命令的 invoke → Result 收敛（都带 folder 逻辑名）；MIME 解析与报文构建在 @workbench/mail
apps/desktop/src/renderer/src/stores/mail.ts
  邮箱页状态：当前文件夹（收件箱 / 已发送）/ 列表 / 正文（按 (文件夹, 账户, uid) 的会话内存缓存）/
  发送 / 后台监视的登记与通知点击
  （startWatch）；拉取时机在这层
apps/desktop/src/renderer/src/components/MailView.vue
  邮箱页：左清单右阅读（头部一颗分段选择器切收件箱 / 已发送）；HTML 正文走 sandbox iframe（外链图片照常显示，脚本全禁，链接经顶层导航转交系统浏览器）；
  附件片按 attachmentKind 分打开方式：图进 EP 查看器、md / docx / pptx 进 MailAttachmentDialog，其余点开另存为
apps/desktop/src/renderer/src/components/MailAttachmentDialog.vue
  附件预览弹层：md（MarkdownView）/ docx（AiPreviewDoc）/ pptx（AiPreviewSlides）在应用里看；
  弹窗定高、宽度照 docx 一页（A4 794 / Letter 816）定的 920px —— 页外不再堆一大片白，
  中间那块自己滚（global.css 的 .mail-preview-dialog 一组），脚上一个「另存为」
apps/desktop/src/renderer/src/components/MailListRow.vue
  邮件清单行：行首复选框 + 两行内容（收件箱清单、推广邮件段与发件箱共用一副；发件箱里第一行摆收件人）
apps/desktop/src/renderer/src/components/MailAccountDialog.vue
  账户弹层：连接参数 + 授权码（凭据管理器），163/126 预设自动带出
apps/desktop/src/renderer/src/components/MailComposer.vue
  写信弹层：收件人 / 主题 / 正文 / 附件，回复预填
```

域包：

```text
packages/mail/src/mail.ts
  账户配置的形状与收敛（sanitizeMailAccount）、163/126 服务器预设、文件夹的逻辑名（MailFolder）
packages/mail/src/rfc2047.ts
  RFC 2047 编码词的解（B/Q、各字符集经 TextDecoder）与中文主题的 B 编码
packages/mail/src/mime.ts
  发信报文构建（multipart/mixed、RFC 2231 文件名、30 MB 上限）与附件的
  Content-Type 猜测
packages/mail/src/parse.ts
  postal-mime 包装（parseMessage，含附件名的归一 preferExtendedFilenames）、
  沙箱正文生成（htmlBody：CSP + cid → data URL）、
  发件人 / 收件人（displayRecipients、recipientAddress）与日期的展示拆解、
  附件的打开方式与片子上的字（attachmentKind、attachmentBadge、isImageAttachment、
  attachmentDataUrl、attachmentText）
```
