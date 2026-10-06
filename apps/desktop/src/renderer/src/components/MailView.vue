<script setup lang="ts">
/**
 * 邮箱页：左栏收件箱清单，右栏读信（与 AI / 笔记 / 视频页同一副左右分栏，
 * 左栏宽度住 theme.json 的 `mailListWidth`）。
 *
 *  - **左栏**：最近 50 封的清单（进页面 / 点刷新才拉，不后台轮询 —— 这个应用没有
 *    「自己偷偷跑流量」这回事）。行上是发件人、日期、主题与两处标记：未读点、附件回形针。
 *    底部一行是两个不跟邮件走的入口：**账户**（连接参数与授权码的管理弹层）与**写邮件**。
 *  - **右栏**：没配置账户时是一颗「配置邮箱账户」；配置了就是阅读栏 ——
 *    头部是主题、发件人、日期与「回复 / 标记未读」，正文按信里的形态画：
 *    有 HTML 走 sandbox 全禁的 iframe（CSP 只放行 data: 图片，外链跟踪像素一张不取，
 *    见 @workbench/mail 的 htmlBody），没有就按纯文本排版。附件逐个「另存为」。
 *
 * 页面只做编排与状态呈现：拉列表、读信、标记、发送都在 stores/mail.ts。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import { EditPen, Message, Paperclip, Refresh, Setting } from '@element-plus/icons-vue'
import { decodeEncodedWords, displayDate, formatMailSize } from '@workbench/mail'
import PanelResizer from '@/components/PanelResizer.vue'
import MailAccountDialog from '@/components/MailAccountDialog.vue'
import MailComposer from '@/components/MailComposer.vue'
import { useMailStore, type MailReplyTarget } from '@/stores/mail'
import { useSettingsStore } from '@/stores/settings'
import { notifyError, notifySuccess } from '@/notify'

const mail = useMailStore()
const settings = useSettingsStore()

const accountVisible = ref(false)
const composerVisible = ref(false)
/** 回复的预填内容；null = 写的是新邮件 */
const replyTarget = ref<MailReplyTarget | null>(null)

onMounted(() => {
  void mail.refreshList()
})

/** KeepAlive 换页回来再拉一次（inFlight 挡住与首次挂载的重复） */
onActivated(() => {
  void mail.refreshList()
})

/** 主题是原始头部文本（RFC 2047 编码词），解码在这里做 */
function subjectText(raw: string): string {
  const decoded = decodeEncodedWords(raw).trim()
  return decoded || '(无主题)'
}

/** 清单里当前这封信的已读态（阅读栏「标记未读」按钮的依据） */
const activeSeen = computed(() => mail.list.find((item) => item.uid === mail.active?.uid)?.seen ?? true)

function toggleSeen(): void {
  const message = mail.active
  if (!message) return
  void mail.markSeen(message.uid, !activeSeen.value).then((result) => {
    if (!result.ok) notifyError(result.error ?? '标记失败')
  })
}

function openComposer(): void {
  replyTarget.value = null
  composerVisible.value = true
}

function reply(): void {
  const message = mail.active
  if (!message) return
  replyTarget.value = {
    to: message.fromAddress,
    subject: message.subject,
    text: message.text
  }
  composerVisible.value = true
}

/** 附件另存为：路径用户挑，落盘走 store（Rust 的 mail_attachment_save） */
async function downloadAttachment(name: string, base64: string): Promise<void> {
  const path = await window.workbench.pickSavePath({
    title: '保存附件',
    defaultPath: name
  })
  if (!path) return
  const result = await mail.downloadAttachment(path, base64)
  if (result.ok) notifySuccess('附件已保存')
  else notifyError(result.error ?? '保存附件失败')
}

/** 附件字节数（base64 长 × 3/4，去 padding 的近似在展示层够用） */
function attachmentSize(base64: string): string {
  return formatMailSize(Math.floor((base64.length * 3) / 4))
}

/**
 * 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频 / AI 页同一套做法）。
 * 列宽用 auto —— 宽度长在左栏自己身上，grid 这一行跟着缩。
 */
const bodyStyle = computed(() => ({
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  '--tree-w': `${settings.themeConfig.mailListWidth}px`
}))
</script>

<template>
  <main class="mail-view" :style="bodyStyle">
    <!-- 左栏：收件箱清单 -->
    <aside class="mail-view__side panel">
      <header class="side__head">
        <span class="side__title">收件箱</span>
        <el-tooltip content="刷新" placement="bottom">
          <el-button
            class="side__refresh"
            text
            :icon="Refresh"
            :loading="mail.listLoading"
            aria-label="刷新收件箱"
            @click="mail.refreshList()"
          />
        </el-tooltip>
      </header>

      <!-- 出错时清单还在（留着上一次的），错误压在顶部一条里 -->
      <div v-if="mail.listError" class="mail-list__error">{{ mail.listError }}</div>

      <div class="mail-list" role="listbox" aria-label="收件箱">
        <button
          v-for="item in mail.list"
          :key="item.uid"
          class="mail-item"
          :class="{ 'is-active': mail.active?.uid === item.uid, 'is-unread': !item.seen }"
          type="button"
          @click="mail.openMail(item.uid)"
        >
          <span class="mail-item__row">
            <span class="mail-item__dot" aria-hidden="true" />
            <span class="mail-item__from" :title="mail.senderText(item.from)">{{ mail.senderText(item.from) }}</span>
            <el-icon v-if="item.hasAttachment" class="mail-item__clip"><Paperclip /></el-icon>
            <span class="mail-item__date">{{ displayDate(item.date) }}</span>
          </span>
          <span class="mail-item__subject" :title="subjectText(item.subject)">{{ subjectText(item.subject) }}</span>
        </button>

        <!-- 空态只说事实：没配置 / 拉完是空的。教学式引导一律不加（AGENTS.md 第 4 节） -->
        <div v-if="mail.configured && !mail.listLoading && mail.list.length === 0" class="mail-list__empty">
          收件箱是空的
        </div>
      </div>

      <footer class="side__foot">
        <el-button class="side__account" text :icon="Setting" @click="accountVisible = true">
          账户
        </el-button>
        <el-button class="side__compose" text :icon="EditPen" :disabled="!mail.configured" @click="openComposer">
          写邮件
        </el-button>
      </footer>
    </aside>

    <!-- 两栏之间的分隔条：与 AI / 知识库页同一条缝 -->
    <PanelResizer
      :width="settings.themeConfig.mailListWidth"
      body-class="is-resizing-mail-list"
      @move="settings.setMailListWidth"
      @end="() => void settings.commitMailListWidth()"
    />

    <!-- 右栏：阅读区 -->
    <section class="mail-view__main panel">
      <!-- 没配置账户：中间就一颗入口（地址、授权码都在那个弹层里填） -->
      <div v-if="!mail.configured" class="mail-view__blank">
        <el-button type="primary" :icon="Message" @click="accountVisible = true">配置邮箱账户</el-button>
      </div>

      <template v-else-if="mail.active">
        <header class="mail-head">
          <h2 class="mail-head__subject">{{ mail.active.subject }}</h2>
          <div class="mail-head__meta">
            <span class="mail-head__from">{{ mail.active.fromText }}</span>
            <span v-if="mail.active.fromAddress && mail.active.fromText !== mail.active.fromAddress" class="mail-head__addr">
              &lt;{{ mail.active.fromAddress }}&gt;
            </span>
            <span class="mail-head__date">{{ mail.active.dateText }}</span>
            <span class="mail-head__spacer" />
            <el-button size="small" text :icon="EditPen" @click="reply">回复</el-button>
            <el-button size="small" text @click="toggleSeen">
              {{ activeSeen ? '标记未读' : '标记已读' }}
            </el-button>
          </div>
          <div v-if="mail.active.attachments.length" class="mail-head__files">
            <button
              v-for="file in mail.active.attachments"
              :key="file.contentId || file.name"
              class="mail-file"
              type="button"
              :title="`${file.name}（${attachmentSize(file.base64)}），点开另存`"
              @click="downloadAttachment(file.name, file.base64)"
            >
              <el-icon class="mail-file__icon"><Paperclip /></el-icon>
              <span class="mail-file__name">{{ file.name }}</span>
              <span class="mail-file__size">{{ attachmentSize(file.base64) }}</span>
            </button>
          </div>
        </header>

        <div v-if="mail.bodyError" class="mail-body__error">{{ mail.bodyError }}</div>

        <div class="mail-body">
          <!-- HTML 正文：sandbox 全禁（脚本、同源、表单、弹窗全禁）—— 硬边界，
               与 AI 预览栏同一套；文档里的 CSP 把外链资源（跟踪像素）也掐死了 -->
          <iframe v-if="mail.active.html" class="mail-body__frame" :sandbox="''" :srcdoc="mail.active.html" title="邮件正文" />
          <pre v-else class="mail-body__text">{{ mail.active.text || '（这封邮件没有可显示的正文）' }}</pre>
        </div>
      </template>

      <!-- 配置了账户、还没选中邮件：空着，不摆教学式说明 -->
      <div v-else class="mail-view__blank" />
    </section>

    <!-- 弹层挂在最外层（换页不关弹层，见 AGENTS.md 第 4 节） -->
    <MailAccountDialog v-model="accountVisible" @saved="mail.invalidate()" />
    <MailComposer v-model="composerVisible" :reply="replyTarget" />
  </main>
</template>

<style scoped>
/**
 * 左清单右阅读。两栏各是一张卡片（.panel 那副外壳），间距与别处同源 ——
 * 左栏宽度跟着 theme.json 里的 mailListWidth 走（拖两栏之间那条缝改它）。
 * 栏间留白挪到左栏的 margin-right 上，不用 grid 的 gap（与 AI 页同一套做法）。
 */
.mail-view {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

.mail-view__side {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: var(--tree-w, 300px);
  min-height: 0;
  margin-right: var(--card-gap, 10px);
  padding: var(--sp-3);
}

/* 表头直接贴着清单（.panel 的 gap 在这一栏归零，与 AI 页同一套） */
.side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.side__title {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.side__refresh {
  width: 24px;
  height: 24px;
  padding: 0;
}

/** 拉取失败压在清单顶部的一条：清单留着上一次的值，错误只说这一次的原因 */
.mail-list__error {
  flex-shrink: 0;
  margin-top: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--st-fail);
  border-radius: var(--r-2);
  color: var(--st-fail);
  font-size: var(--fs-meta);
}

/** 清单自己滚；行高紧凑，一屏多看几封 */
.mail-list {
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
  overflow-y: auto;
}

.mail-item {
  display: block;
  width: 100%;
  padding: var(--sp-2);
  border: 0;
  border-radius: var(--r-2);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mail-item:hover {
  background: var(--bg-hover);
}

.mail-item.is-active {
  background: var(--bg-active);
}

/* 第一行：未读点 + 发件人 + 附件 + 日期（未读的整行字重抬一档，这是第二个未读信号） */
.mail-item__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

/* 未读点：没读才画，读了的占位保持对齐 */
.mail-item__dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
}

.mail-item.is-unread .mail-item__dot {
  background: var(--ink);
}

.mail-item__from {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.mail-item__clip {
  flex-shrink: 0;
  color: var(--ink-3);
}

.mail-item__date {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.mail-item__subject {
  display: block;
  margin-top: 2px;
  padding-left: calc(6px + var(--sp-1));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
}

.mail-item.is-unread .mail-item__subject {
  font-weight: 600;
  color: var(--ink);
}

.mail-list__empty {
  padding: var(--sp-4) var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-align: center;
}

/** 左栏底部一行：账户与写邮件（与 AI 页左栏底部同一套做法） */
.side__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex-shrink: 0;
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.side__account,
.side__compose {
  height: 24px;
  padding: 0 var(--sp-1);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

/* ---------- 右栏 ---------- */

.mail-view__main {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

/** 空态：没配置时中间那颗入口；配置了没选信就空着 */
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

/* 后面的按钮推到行尾 */
.mail-head__spacer {
  flex: 1;
}

/** 附件行：一颗一颗像文件片，点开另存 */
.mail-head__files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.mail-file {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  max-width: 260px;
  padding: 2px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  background: var(--bg-surface);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  cursor: pointer;
}

.mail-file:hover {
  border-color: var(--ink-3);
  color: var(--ink);
}

.mail-file__icon {
  flex-shrink: 0;
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
}

/** 正文读取出错的一条 */
.mail-body__error {
  flex-shrink: 0;
  margin-top: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--st-fail);
  border-radius: var(--r-2);
  color: var(--st-fail);
  font-size: var(--fs-meta);
}

/** 正文：吃剩余高度自己滚。沙箱里是别人的文档：铺白底（一般邮件都是浅色的） */
.mail-body {
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
  overflow: hidden;
  border-radius: var(--r-2);
}

.mail-body__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

/* 纯文本邮件：等宽不用、按排版文本铺，留白按原文走 */
.mail-body__text {
  height: 100%;
  margin: 0;
  padding: var(--sp-3);
  overflow-y: auto;
  background: var(--bg-surface);
  border-radius: var(--r-2);
  color: var(--ink);
  font-family: inherit;
  font-size: var(--fs-body);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
