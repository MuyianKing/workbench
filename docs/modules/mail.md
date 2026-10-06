# 邮箱（mail）

邮箱（mail）的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`packages/mail/src/`（账户配置的形状与收敛、RFC 2047 编解码、发信报文构建
`mime.ts`、收信解析与沙箱正文 `parse.ts`，全部带单测；MIME 解析用 postal-mime）、
`apps/desktop/src-tauri/src/mail.rs`（Schannel TLS + 手写的 IMAP/SMTP 命令子集 + 全部
`mail_*` 命令）、`apps/desktop/src/renderer/src/workbench/mail.ts`（适配）、
`apps/desktop/src/renderer/src/stores/mail.ts`（缓存与策略）。

- **第十条出口，「地址由用户给」**：邮箱地址留空 = 整条出口关闭；填了地址（且授权码进了
  凭据管理器）才会连**用户配置的那两台**收发服务器，主机名不设白名单 —— 与 AI 助手的
  Base URL 同属一类出口。**除收发服务器本身，这个功能不得产生任何别的网络请求**：
  邮件 HTML 正文的外链资源（跟踪像素）一张都不许加载 —— `htmlBody`（parse.ts）注入的
  CSP 只放行 `data:` 图片，渲染层照实传 `htmlBody` 的产物，不要改回「外链照旧加载」。
- **授权码只进凭据管理器，绝不落 JSON、绝不回渲染层**：`mail_key_save` 存
  `Workbench/mail/<地址>/token`（credentials.rs，DPAPI 按用户加密），之后 Rust 侧
  命令自己读（`auth_code`）；渲染层只在「验证并保存」那一次经参数递它。界面上只显示
  「已配置 / 未配置」。连接参数（地址 / 主机 / 端口）走 `settings.mailAccount` 落
  workbench-data.json，由 `sanitizeMailAccount` 收敛 —— 这两者是两条不同的落盘，别混。
- **职责切分：Rust 只做传输，邮件语义全在 TS**：Rust 按「现连现断」跑 IMAP/SMTP 命令子集，
  回结构化摘要与原始报文（base64）；MIME 解析（postal-mime 包装）、发信报文构建
  （buildMime）、RFC 2047、展示拆解全在 @workbench/mail（有单测、改动走热更新）。
  不要往 Rust 侧加 MIME / 编码逻辑。
- **网易 IMAP 必须先报身份**：不发 `ID` 命令，SELECT 直接吃 `Unsafe Login` 闭门羹
  （rust-imap 不支持这条，这就是手写协议子集的原因）。mail.rs 的流程是 LOGIN 后发 ID、
  SELECT 被拒且错误里带 Unsafe 时补发 ID 重试一次。改这段流程别把 ID 弄丢。
- **只收发不驻留**：不做后台轮询 / 新邮件提醒（进页面与手动刷新才联网）、不缓存到磁盘
  （正文按 uid 缓存在页面会话内存里）、明确不做多文件夹（只 INBOX）、多账户、邮件搜索、
  STARTTLS（只用隐式 TLS 端口，993 / 465）。
- **HTML 正文渲染是 sandbox 全禁的 iframe**：`sandbox="''"`（脚本、同源、表单、弹窗全禁）
  —— 与 AI 预览栏（AiPreviewHtml.vue）同一条硬边界：邮件的 HTML 绝不能在带宿主能力的
  webview 里执行。没有 HTML 正文时按纯文本排版，两者不混渲染。
- **大小上限两侧同源**：发信 30 MB（`mime.ts` 的 `MAX_MESSAGE_BYTES` = Rust `mail.rs` 的
  `MAX_MESSAGE_BYTES`，构建这一步就拦）、拉正文 24 MB（与 AI 预览栏二进制同一口径）。
  改就两边一起改。

## 实现

- **页面**（MailView.vue）：左清单右阅读的左右分栏（与 AI / 笔记 / 视频页同一副外壳），
  左栏宽度住 theme.json 的 `mailListWidth`（拖两栏之间那条缝改，PanelResizer 三段式：
  拖动只改本地、松手落盘）。左栏清单行上是「未读点 + 发件人 + 附件回形针 + 日期」、
  下一行主题；底部一行是「账户 / 写邮件」两个入口。拉列表的时机：页面挂载、KeepAlive
  换页回来（onActivated）、点刷新；`listInFlight` 挡住重复。发件人展示名与主题的
  RFC 2047 解码在渲染前做（`displaySender` / `decodeEncodedWords`）。
- **读信**：点清单行 → `mail.openMail(uid)` → 正文缓存查一次 → 没有才
  `mail_fetch_body`（base64 回来，顺带标已读）→ `parseMessage` 拆成
  文本 / HTML / 附件 / 内联图 → `htmlBody` 生成沙箱文档（注入 CSP、cid 换 data URL）。
  列表上的未读点就地更新。阅读栏头部有「回复 / 标记已读（未读）」；附件一颗一片、
  点开走「另存为」（pickSavePath 挑路径 + `mail_attachment_save` 落盘，与
  vault_key_export 同一个信任模型）。
- **账户弹层**（MailAccountDialog.vue，penetrable）：平常只有地址与授权码两样 —— 163 / 126
  的收发服务器跟着地址后缀自动带出（`presetForAddress`），整段收进「服务器设置」；
  认不出的域名（自定义邮箱）才自动摊开，手改过服务器（`hostsTouched`）预设就不再覆盖。
  「验证并保存」一条链路：授权码重填了先 `mail_verify`（收发各连一遍）→ 连接参数
  `updateSettings` 落盘 → `mail_key_save` 存授权码 → 换了地址再 `mail_key_clear` 旧的。
  校验失败就地显示（formError 行），不飘 toast。
- **写信弹层**（MailComposer.vue，penetrable）：收件人支持逗号 / 分号 / 空白分隔、
  逐个验 @；附件 `pickFiles` 多选 + `readBinaryFile` 读成 base64（文件是用户亲手挑的，
  不需要圈范围）；回信预填 `Re:` 与 `> ` 引用体。发送失败表单原样留着，改一改能再发。
- **列表摘要的来路**：Rust 按序号区间拉最近 N 封的 `UID FLAGS BODY[HEADER.FIELDS
  (FROM SUBJECT DATE)] BODYSTRUCTURE`，ENVELOPE 不用 —— 头部三件套是原始文本，
  拆解（编码词 / 名字与地址 / 日期）全在 TS。附件标记是 BODYSTRUCTURE 里找
  ATTACHMENT 的启发式，宁漏勿误。
- **测试**：@workbench/mail 的 23 个用例（收敛 / 编码词 / 报文构建 / 解析与沙箱正文）；
  mail.rs 的 `#[cfg(test)]`（字面量标记 / 括号项解析 / 头部折叠展开 / EXISTS /
  点填充 / SMTP 多行应答 / 参数收敛）。协议层没有真连接测试 —— 改了收发流程要拿
  真邮箱跑一遍（见 AGENTS.md 第 6 节的验证脚本）。

## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

Rust 侧：

```text
apps/desktop/src-tauri/src/mail.rs
  邮箱（网易 163/126）宿主侧：Schannel TLS + 手写的 IMAP/SMTP 命令子集 +
  mail_* 九个命令 —— 第十条联网出口（用户配置的收发服务器，授权码进凭据管理器）；
  网易 IMAP 要先发 ID 命令（否则 SELECT 报 Unsafe Login），见模块文档「约束」
```

渲染层：

```text
apps/desktop/src/renderer/src/workbench/mail.ts
  邮箱适配层：mail_* 命令的 invoke → Result 收敛；MIME 解析与报文构建在 @workbench/mail
apps/desktop/src/renderer/src/stores/mail.ts
  邮箱页状态：列表 / 正文（按 uid 的会话内存缓存）/ 发送；拉取时机与不做后台轮询在这层
apps/desktop/src/renderer/src/components/MailView.vue
  邮箱页：左清单右阅读；HTML 正文走 sandbox 全禁 iframe（CSP 只放行 data: 图片）
apps/desktop/src/renderer/src/components/MailAccountDialog.vue
  账户弹层：连接参数 + 授权码（凭据管理器），163/126 预设自动带出
apps/desktop/src/renderer/src/components/MailComposer.vue
  写信弹层：收件人 / 主题 / 正文 / 附件，回复预填
```

域包：

```text
packages/mail/src/mail.ts
  账户配置的形状与收敛（sanitizeMailAccount）、163/126 服务器预设
packages/mail/src/rfc2047.ts
  RFC 2047 编码词的解（B/Q、各字符集经 TextDecoder）与中文主题的 B 编码
packages/mail/src/mime.ts
  发信报文构建（multipart/mixed、RFC 2231 文件名、30 MB 上限）与附件的
  Content-Type 猜测
packages/mail/src/parse.ts
  postal-mime 包装（parseMessage）、沙箱正文生成（htmlBody：CSP + cid → data URL）、
  发件人与日期的展示拆解
```
