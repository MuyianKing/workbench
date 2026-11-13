<script setup lang="ts">
import type { MailAttachmentKind, ParsedAttachment } from '@workbench/mail'
import type { Component } from 'vue'
import type { MailReplyTarget } from '@/stores/mail'
import { Document, Download, EditPen, Link, Memo, Message, Monitor, Notebook, Reading } from '@element-plus/icons-vue'
import { attachmentBadge, attachmentDataUrl, attachmentHint, attachmentKind, attachmentOpenable, attachmentSizeText, attachmentTint, isImageAttachment } from '@workbench/mail'
/**
 * 邮箱页右栏：阅读区（主题 / 收发人 / 附件 / 正文）与它的三种过渡态（未配置 / 拉正文骨架 / 未选中）。
 *
 * 从 `MailView.vue` 拆出来的整块。附件的两条出路（在应用里打开、另存为）与图片查看器
 * 都只服务这一栏，跟着一起搬过来；「回复」与「配置账户」要开父组件的弹层，用 emit 回去。
 */
import { computed, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import MailAttachmentDialog from '@/components/MailAttachmentDialog.vue'
import { notifyError, notifySuccess } from '@/notify'
import { useMailStore } from '@/stores/mail'

const emit = defineEmits<{
  accounts: []
  reply: [target: MailReplyTarget]
}>()

const mail = useMailStore()

/** 清单里当前这封信的已读态（阅读栏「标记未读」按钮的依据） */
const activeSeen = computed(() => mail.list.find(item => item.key === mail.active?.key)?.seen ?? true)

function toggleSeen(): void {
  const message = mail.active
  if (!message)
    return
  void mail.markSeen({ folder: message.folder, account: message.account, uid: message.uid }, !activeSeen.value).then(
    (result) => {
      if (!result.ok)
        notifyError(result.error ?? '标记失败')
    },
  )
}

/**
 * 阅读栏第一行摆谁：收件箱看发件人，发件箱看收件人（那儿摆自己没信息 ——
 * 回信也按这个走，发给当初收到这封的人）。
 */
const partyText = computed(() => {
  const message = mail.active
  if (!message)
    return ''
  return message.folder === 'sent' ? message.toText || '(无收件人)' : message.fromText
})

const partyAddress = computed(() => {
  const message = mail.active
  if (!message)
    return ''
  return message.folder === 'sent' ? message.toAddress : message.fromAddress
})

function reply(): void {
  const message = mail.active
  if (!message)
    return
  emit('reply', {
    from: message.account,
    to: message.folder === 'sent' ? message.toAddress : message.fromAddress,
    subject: message.subject,
    text: message.text,
  })
}

/** 附件另存为：路径用户挑，落盘走 store（Rust 的 mail_attachment_save） */
async function downloadAttachment(name: string, base64: string): Promise<void> {
  const path = await window.workbench.pickSavePath({
    title: '保存附件',
    defaultPath: name,
  })
  if (!path)
    return
  const result = await mail.downloadAttachment(path, base64)
  if (result.ok)
    notifySuccess('附件已保存')
  else notifyError(result.error ?? '保存附件失败')
}

/**
 * 附件片左首那枚图标：按类型给一枚（颜色见 @workbench/mail 的 attachmentTint —— 那是应用里
 * 唯一按文件类型着色的一处）。**图走缩略图**、**认不出的类型走扩展名角标**（`file` 那一档：
 * zip / rar / 老式 .doc 这些，扩展名才是唯一的信息），所以这张表里只列认得出的那五类。
 */
const FILE_ICONS: Partial<Record<MailAttachmentKind, Component>> = {
  pdf: Document,
  docx: Memo,
  pptx: Monitor,
  markdown: Notebook,
  html: Link,
}

/**
 * 左首那块小方块的样式：图标本色 + 一层同色的淡底（`#rrggbb` 尾巴上补一对十六进制 alpha，
 * 12% 那档）。名字与大小照旧走灰度 —— 彩色只在这一小块上（见 AGENTS.md 第 4 节）。
 */
function fileTintStyle(file: ParsedAttachment): Record<string, string> {
  const tint = attachmentTint(attachmentKind(file))
  return { color: tint, background: `${tint}1f` }
}

/**
 * 当前这封里所有图片附件的 data URL —— 就是查看器里左右切的那一串（顺序即附件顺序，
 * 点哪张从哪张开始）。缩略图与原图都取它，不落盘、不经过文件系统。
 */
const imagePreviewList = computed(() =>
  (mail.active?.attachments ?? []).filter(isImageAttachment).map(attachmentDataUrl),
)

/**
 * 大图查看器：null = 关着。**整片附件都能点开它**（缩略图、名字、大小任意一处），
 * 所以查看器由页面自己持一个（EP 的独立组件），不靠 el-image 自带的点击 ——
 * 那样只有缩略图那一小块能触发。
 */
const viewer = ref<{ list: string[], index: number } | null>(null)

function openImagePreview(file: ParsedAttachment): void {
  const list = imagePreviewList.value
  const index = list.indexOf(attachmentDataUrl(file))
  if (index >= 0)
    viewer.value = { list, index }
}

/** 预览弹层（md / docx / pptx）：关掉动画走完才把 file 清掉，见下面对 dialog 的用法 */
const previewOpen = ref(false)
const previewFile = ref<ParsedAttachment | null>(null)

function openAttachment(file: ParsedAttachment): void {
  if (attachmentKind(file) === 'image') {
    openImagePreview(file)
    return
  }
  previewFile.value = file
  previewOpen.value = true
}

/** 弹层里的「另存为」：与片子上那颗图标按钮同一条链路 */
function savePreviewed(): void {
  const file = previewFile.value
  if (file)
    void downloadAttachment(file.name, file.base64)
}

/** 骨架屏的正文占位：段落数给足（多余的按 overflow 裁掉），行宽错落、末行收短才像话 */
const skeletonParas = [
  [96, 88, 100, 62],
  [100, 74],
  [92, 100, 45],
  [88, 96, 100, 30],
  [100, 84],
  [94, 100, 58],
  [82, 90],
  [100, 66],
  [96, 88, 40],
  [100, 78],
  [90, 52],
]
</script>

<template>
  <section class="mail-view__main panel">
    <!-- 通讯录那一签：左边那份名单才是这一签的内容，右栏空着 -->
    <div v-if="mail.tab === 'contacts'" class="mail-view__blank" />

    <!-- 没配置账户：空态配图 + 一句事实 + 那颗入口（地址、授权码都在那个弹层里填） -->
    <EmptyState
      v-else-if="!mail.configured"
      :icon="Message"
      text="还没有配置邮箱账户"
    >
      <template #actions>
        <el-button type="primary" :icon="Message" @click="emit('accounts')">
          配置邮箱账户
        </el-button>
      </template>
    </EmptyState>

    <!-- 拉正文期间整个阅读区让位给骨架屏：铺满整栏（头像 / 落款 / 主题 / 撑满高度的正文段落），
         段落不足时均匀铺开、超出时裁掉 —— 任何窗口高度下都不留空白，内容看着正在成形 -->
    <div v-else-if="mail.bodyLoading" class="mail-skeleton" aria-hidden="true">
      <div class="mail-skeleton__head">
        <span class="sk sk--avatar" />
        <span class="mail-skeleton__who">
          <span class="sk sk--name" />
          <span class="sk sk--date" />
        </span>
        <span class="sk sk--subject" />
      </div>
      <div class="mail-skeleton__body">
        <p v-for="(para, index) in skeletonParas" :key="index" class="mail-skeleton__para">
          <span v-for="(width, line) in para" :key="line" class="sk" :style="{ width: `${width}%` }" />
        </p>
      </div>
    </div>

    <template v-else-if="mail.active">
      <header class="mail-head">
        <h2 class="mail-head__subject">
          {{ mail.active.subject }}
        </h2>
        <div class="mail-head__meta">
          <!-- 发件箱里第一行摆的是收件人：挂一个安静的小字，免得跟发件人混淆 -->
          <span v-if="mail.active.folder === 'sent'" class="mail-head__to">收件人</span>
          <span class="mail-head__from">{{ partyText }}</span>
          <span v-if="partyAddress && partyText !== partyAddress" class="mail-head__addr">
            &lt;{{ partyAddress }}&gt;
          </span>
          <span class="mail-head__date">{{ mail.active.dateText }}</span>
          <!-- 收自哪个邮箱（配了多个账户才画）：回信默认就从它发 -->
          <span v-if="mail.accounts.length > 1" class="mail-head__src" :title="mail.active.account">
            {{ mail.active.account }}
          </span>
          <span class="mail-head__spacer" />
          <el-button size="small" text :icon="EditPen" @click="reply">
            回复
          </el-button>
          <!-- 已读态只对收件箱有意义：自己发出去的信没有未读这回事 -->
          <el-button v-if="mail.active.folder === 'inbox'" size="small" text @click="toggleSeen">
            {{ activeSeen ? '标记未读' : '标记已读' }}
          </el-button>
        </div>
        <div v-if="mail.active.attachments.length" class="mail-head__files">
          <template v-for="(file, index) in mail.active.attachments" :key="`${index}-${file.name}`">
            <!-- 能在应用里打开的附件（图 / md / html / docx / pptx / pdf）：**整片**点开 —— 片子是一颗
                 内层按钮（左首的类型图标 / 缩略图 + 名字 + 大小都在它里面），打开方式按类型分：
                 图进 EP 的查看器，md / html / docx / pptx / pdf 进预览弹层。右端那颗另存按钮留在片子
                 外层（按钮不能套按钮），点它是「存」、不触发打开 -->
            <span v-if="attachmentOpenable(file)" class="mail-file mail-file--open">
              <button
                class="mail-file__open"
                type="button"
                :title="attachmentHint(file)"
                @click="openAttachment(file)"
              >
                <span class="mail-file__tile" :style="fileTintStyle(file)">
                  <el-image
                    v-if="attachmentKind(file) === 'image'"
                    class="mail-file__thumb"
                    :src="attachmentDataUrl(file)"
                    fit="cover"
                  />
                  <el-icon v-else-if="FILE_ICONS[attachmentKind(file)]" class="mail-file__icon">
                    <component :is="FILE_ICONS[attachmentKind(file)]" />
                  </el-icon>
                  <span v-else class="mail-file__ext">{{ attachmentBadge(file) }}</span>
                </span>
                <span class="mail-file__name">{{ file.name }}</span>
                <span class="mail-file__size">{{ attachmentSizeText(file.base64) }}</span>
              </button>
              <el-tooltip content="另存为" placement="top">
                <el-button
                  class="mail-file__save"
                  text
                  size="small"
                  :icon="Download"
                  :aria-label="`另存 ${file.name}`"
                  @click="downloadAttachment(file.name, file.base64)"
                />
              </el-tooltip>
            </span>
            <button
              v-else
              class="mail-file"
              type="button"
              :title="attachmentHint(file)"
              @click="downloadAttachment(file.name, file.base64)"
            >
              <span class="mail-file__tile" :style="fileTintStyle(file)">
                <el-icon v-if="FILE_ICONS[attachmentKind(file)]" class="mail-file__icon">
                  <component :is="FILE_ICONS[attachmentKind(file)]" />
                </el-icon>
                <span v-else class="mail-file__ext">{{ attachmentBadge(file) }}</span>
              </span>
              <span class="mail-file__name">{{ file.name }}</span>
              <span class="mail-file__size">{{ attachmentSizeText(file.base64) }}</span>
            </button>
          </template>
        </div>
      </header>

      <div v-if="mail.bodyError" class="mail-body__error">
        {{ mail.bodyError }}
      </div>

      <div class="mail-body">
        <!-- HTML 正文：sandbox 禁脚本 / 同源 / 表单 / 弹窗 —— 硬边界，与 AI 预览栏同一套；
             只放行用户点出来的顶层导航：htmlBody 把链接统一 target="_top"，
             这次导航被 main.rs 的 on_navigation 拦下转交系统浏览器。
             正文外链图片照常加载（CSP img-src *），请求不带 Referer -->
        <iframe v-if="mail.active.html" class="mail-body__frame" sandbox="allow-top-navigation-by-user-activation" referrerpolicy="no-referrer" :srcdoc="mail.active.html" title="邮件正文" />
        <pre v-else class="mail-body__text">{{ mail.active.text || '（这封邮件没有可显示的正文）' }}</pre>
      </div>
    </template>

    <!-- 配置了账户、还没选中邮件：一副小图 + 一句事实。
         什么都不摆的话，右边就是一整片空玻璃，看着像没加载出来 -->
    <EmptyState
      v-else
      :icon="Reading"
      text="还没有打开邮件"
      hint="在左边的清单里点一封，正文显示在这里。"
    />

    <!-- 图片附件的大图：整片附件点开它（多张之间左右切、滚轮缩放、Esc 或点外面关掉 ——
         EP 的独立查看器）。teleported 是必须的：阅读栏自己有 overflow，不挪到 body 会被裁掉 -->
    <el-image-viewer
      v-if="viewer"
      :url-list="viewer.list"
      :initial-index="viewer.index"
      :show-progress="viewer.list.length > 1"
      hide-on-click-modal
      teleported
      @close="viewer = null"
    />

    <MailAttachmentDialog
      v-model="previewOpen"
      :file="previewFile"
      @save="savePreviewed"
      @closed="previewFile = null"
    />
  </section>
</template>

<style scoped>
.mail-view__main {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

/** 通讯录那一签的右栏空着占位（名单本身就在左边；没配置账户那档已换成 EmptyState） */
.mail-view__blank {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 头部：主题 + 发件人行 + 附件行，定高内容自然撑开 */
.mail-head {
  flex-shrink: 0;
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.mail-head__subject {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
  overflow-wrap: anywhere;
}

.mail-head__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  min-width: 0;
}

.mail-head__from {
  color: var(--ink);
  font-size: var(--fs-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mail-head__addr {
  color: var(--ink-3);
  font-size: var(--fs-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mail-head__date {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 阅读栏的来源（多账户时）：完整地址摆得下，正常给 */
.mail-head__src {
  color: var(--ink-3);
  font-size: var(--fs-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 发件箱里第一行摆的是收件人：前面挂一个安静的小字，免得跟发件人混淆 */
.mail-head__to {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 后面的按钮推到行尾 */
.mail-head__spacer {
  flex: 1;
}

/** 附件行：一颗一颗像文件片。图片的片子首是个缩略图（点开看大图），其余点开另存 */
.mail-head__files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

/**
 * 附件片：一颗一号大小的「纸片」。左首是这张片子的样子（图给缩略图、其余给类型角标），
 * 中间是名字（主文字色，长了截断），末尾是大小（退一档的灰）—— 一行里读得出的主次就这三个。
 * 悬停按项目里 chip 那套给一点底色与更实的边框，别只换个字色。
 */
.mail-file {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 360px;
  padding: 5px var(--sp-2) 5px 5px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  color: var(--ink);
  font-size: var(--fs-body);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.mail-file:hover {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
}

/**
 * 左首那块小方块：类型图标 / 扩展名角标坐在一层同色的淡底上（底色与图标色都由
 * @workbench/mail 的 attachmentTint 给，行内 style 落下来）。**定宽定高**，几个片子的名字才对得齐。
 */
.mail-file__tile {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-inset);
}

.mail-file__icon {
  font-size: 20px;
}

/** 认不出的类型（zip / rar / 老式 .doc）那档：扩展名本身就是信息，角标里写它 */
.mail-file__ext {
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: 0.02em;
}

/** 图片：`fit="cover"` 让原图铺满这一小块（点它开查看器） */
.mail-file__thumb {
  display: block;
  width: 100%;
  height: 100%;
}

/**
 * 能在应用里打开的片子是「一颗内层按钮 + 右端那颗另存图标」拼的：内边距长在内层按钮上，
 * 所以整片（含角标左边那点留白）都在它的可点范围里 —— 片子本身只留边框与底色。
 */
.mail-file--open {
  gap: 0;
  padding: 0;
}

.mail-file__open {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding: 5px var(--sp-2) 5px 5px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

/* 另存的那颗图标按钮：贴着片子右端，撑满片子高（那一小条也好点中），平常安静、悬停才亮起来。
   `button.` 前缀是为了压过 EP 自己的内边距与逗号规则 */
button.mail-file__save {
  flex-shrink: 0;
  align-self: stretch;
  height: auto;
  margin: 0;
  padding: 0 var(--sp-2);
  color: var(--ink-3);
}

button.mail-file__save:hover {
  color: var(--ink);
}

.mail-file__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mail-file__size {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/** 正文读取出错的一条 */
.mail-body__error {
  flex-shrink: 0;
  margin-top: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--st-fail);
  border-radius: var(--r-md);
  color: var(--st-fail);
  font-size: var(--fs-meta);
}

/** 正文：吃剩余高度自己滚。沙箱里是别人的文档：铺白底（一般邮件都是浅色的） */
.mail-body {
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
  overflow: hidden;
  border-radius: var(--r-md);
}

/* ---------- 骨架屏（拉正文时的加载态） ---------- */

/**
 * 铺满整栏：头部按真邮件的落款排（头像 + 名字/日期 + 主题行），正文段落 list 撑满
 * 剩余高度 —— 段落不够时均匀铺开（space-evenly）、超出时裁掉（overflow），
 * 任何窗口高度下半边都不会空着。微光用内置 linear 匀速扫（tokens.css 的动效口径）；
 * reduced-motion 由 global.css 全局兜底（动画压到近 0，占位仍在）。
 */
.mail-skeleton {
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.mail-skeleton__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border);
}

.mail-skeleton__who {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  flex: 0 1 auto;
}

.mail-skeleton__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  gap: var(--sp-3);
  overflow: hidden;
}

.mail-skeleton__para {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.sk {
  display: block;
  height: 12px;
  border-radius: var(--r-sm);
  background: linear-gradient(100deg, var(--bg-inset) 42%, var(--bg-selected) 50%, var(--bg-inset) 58%);
  background-size: 220% 100%;
  animation: mail-sk-sweep 1.4s linear infinite;
}

.sk--avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
}

.sk--name {
  height: 10px;
  width: 140px;
}

.sk--date {
  height: 10px;
  width: 84px;
}

.sk--subject {
  height: 16px;
  flex: 1 1 100%;
  min-width: 40%;
  max-width: 64%;
}

@keyframes mail-sk-sweep {
  from {
    background-position: 110% 0;
  }
  to {
    background-position: -110% 0;
  }
}

.mail-body__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

/* 纯文本邮件：等宽不用、按排版文本铺，留白按原文走 */
.mail-body__text {
  height: 100%;
  margin: 0;
  padding: var(--sp-3);
  overflow-y: auto;
  border-radius: var(--r-md);
  color: var(--ink);
  font-family: inherit;
  font-size: var(--fs-body);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
