<script setup lang="ts">
import type { MailListItem, MailReplyTarget } from '@/stores/mail'
import { ArrowDown, EditPen, Message, Paperclip, Refresh, Setting } from '@element-plus/icons-vue'
import { formatMailSize, senderAddress } from '@workbench/mail'
/**
 * 邮箱页：左栏收件箱清单，右栏读信（与 AI / 笔记 / 视频页同一副左右分栏，
 * 左栏宽度住 theme.json 的 `mailListWidth`）。
 *
 *  - **左栏**：所有账户的收件箱合并成一份清单（各账户并行各拉最近的 50 封，按时间
 *    新在前，不按来源分组；进页面 / 点刷新才拉，不后台轮询 —— 这个应用没有
 *    「自己偷偷跑流量」这回事）。右键「多选删除」进入多选态：行首亮出复选框、点行
 *    就是勾 / 撤，勾选条出「已选 N 封」；识别成推广 / 广告的信不混在这里 —— 收进
 *    清单底部分开的一段（默认折叠，展开也是自己的一段）。底部一行是两个不跟邮件走
 *    的入口：**账户**（多账户的管理弹层）与**写邮件**。
 *  - **右栏**：没配置账户时是一颗「配置邮箱账户」；配置了就是阅读栏 ——
 *    头部是主题、发件人、日期与「回复 / 标记未读」，正文按信里的形态画：
 *    有 HTML 走 sandbox 的 iframe（外链图片照常显示、脚本照旧全禁，
 *    见 @workbench/mail 的 htmlBody），没有就按纯文本排版。附件逐个「另存为」。
 *
 * 页面只做编排与状态呈现：拉列表、读信、标记、发送都在 stores/mail.ts。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import MailAccountDialog from '@/components/MailAccountDialog.vue'
import MailComposer from '@/components/MailComposer.vue'
import MailContextMenu from '@/components/MailContextMenu.vue'
import MailListRow from '@/components/MailListRow.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useMailStore } from '@/stores/mail'
import { useSettingsStore } from '@/stores/settings'

const mail = useMailStore()
const settings = useSettingsStore()

const accountVisible = ref(false)
const composerVisible = ref(false)
/** 回复的预填内容；null = 写的是新邮件 */
const replyTarget = ref<MailReplyTarget | null>(null)

/** 右键菜单的落点与它对着的那一行（哪个账户、发件人在不在黑名单、已读态，都给菜单定文案用） */
const menu = ref<{
  x: number
  y: number
  key: string
  account: string
  uid: number
  bulk: boolean
  seen: boolean
} | null>(null)

function openMenu(event: MouseEvent, item: MailListItem): void {
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    key: item.key,
    account: item.account,
    uid: item.uid,
    bulk: mail.bulkSenders.includes(senderAddress(item.from).toLowerCase()),
    seen: item.seen,
  }
}

function onMenuAct(name: 'bulk' | 'toggle-seen' | 'multi-pick' | 'multi-delete' | 'delete'): void {
  const state = menu.value
  if (!state)
    return
  if (name === 'bulk') {
    if (state.bulk)
      mail.unbulk(state.account, state.uid)
    else mail.markBulk(state.account, state.uid)
    return
  }
  if (name === 'multi-pick') {
    // 「多选删除」的入口：把这封勾进批次并进入多选态，勾选条出现后接着挑
    picking.value = true
    if (!picked.value.has(state.key))
      pickedKeys.value = [...pickedKeys.value, state.key]
    anchorKey.value = state.key
    return
  }
  if (name === 'multi-delete') {
    deletePicked()
    return
  }
  if (name === 'delete') {
    void confirmAction('服务器上的这封信也会被删掉，找不回来。', '删除这封邮件').then(async (confirmed) => {
      if (!confirmed)
        return
      const result = await mail.deleteMails([{ account: state.account, uid: state.uid }])
      if (!result.ok)
        notifyError(result.error ?? '删除失败')
    })
    return
  }
  void mail.markSeen(state.account, state.uid, !state.seen).then((result) => {
    if (!result.ok)
      notifyError(result.error ?? '标记失败')
  })
}

// ---------- 批量删除的勾选 ----------

/** 勾选待批量删除的邮件身份（Ctrl+点选勾 / 撤，Shift+点选范围）；普通点击开信并清空勾选 */
const pickedKeys = ref<string[]>([])
/** Shift 范围选择的锚点：最近一次点中的那封（普通与 Ctrl 点击都重设） */
const anchorKey = ref<string | null>(null)
/** 勾选集合（行上的对勾与底色查它） */
const picked = computed(() => new Set(pickedKeys.value))
/** 有行在删（批量或右键单封）：勾选条的两颗按钮都按住，删完这批再说 */
const deleting = computed(() => mail.deletingKeys.length > 0)

/** 多选态：进了它行首才亮复选框、点行从「开信」变成「勾 / 撤」。
 *  是显式的开关，不跟着勾选数走 —— 清空勾选（全选框取消勾）不算退出，
 *  「取消」/ Esc 才退出；删完一批也留着，方便接着挑下一批 */
const picking = ref(false)

/** 勾 / 撤一封（多选态点行、复选框与 Ctrl+点选同一条），并记下锚点 —— Shift 范围选从这儿起算。
 *  平时（非多选态）走它 = 进多选态的又一条路 */
function togglePick(item: MailListItem): void {
  picking.value = true
  anchorKey.value = item.key
  pickedKeys.value = picked.value.has(item.key)
    ? pickedKeys.value.filter(key => key !== item.key)
    : [...pickedKeys.value, item.key]
}

/**
 * 清单行的点击：多选态里点行就是勾 / 撤（Shift 还能从锚点整段勾）；平时 Ctrl / Shift
 * 是两条快捷选法（顺带进多选态），普通点击开信。
 */
function onItemClick(event: MouseEvent, item: MailListItem): void {
  const items = visibleItems.value
  const at = items.findIndex(entry => entry.key === item.key)
  if (at < 0)
    return
  if (event.shiftKey) {
    const from = anchorKey.value == null ? at : items.findIndex(entry => entry.key === anchorKey.value)
    const start = Math.min(from < 0 ? at : from, at)
    const end = Math.max(from < 0 ? at : from, at)
    pickedKeys.value = items.slice(start, end + 1).map(entry => entry.key)
    picking.value = true
    return
  }
  if (picking.value || event.ctrlKey) {
    togglePick(item)
    return
  }
  anchorKey.value = item.key
  void mail.openMail(item)
}

/** 只清勾选，**不退出多选态**（全选框取消勾 / 删完一批都走它）—— 复选框留着接着挑 */
function clearPicked(): void {
  pickedKeys.value = []
}

/** 退出多选态：勾选清掉、复选框收起，点行恢复开信（勾选条「取消」与 Esc） */
function exitPicking(): void {
  picking.value = false
  pickedKeys.value = []
}

/** 此刻看得见的行：收件箱清单 + 展开着的推广段 —— 全选、删除与收起时的修剪都只认这些 */
const visibleItems = computed(() => (mail.showBulk ? [...mail.list, ...mail.bulkList] : mail.list))

/** 全选（勾选条那颗三态框 / 清单里 Ctrl+A）：勾上此刻看得见的全部 —— 推广段收着时它里面的不算。
 *  平时按 Ctrl+A 也从这儿进多选态 */
function pickAll(): void {
  picking.value = true
  pickedKeys.value = visibleItems.value.map(item => item.key)
}

/** 勾选条头那颗三态复选框的状态：看得见的全勾上 = 勾，勾了一部分 = 半勾，一个没勾 = 空 */
const allVisiblePicked = computed(() => {
  const items = visibleItems.value
  return items.length > 0 && items.every(item => picked.value.has(item.key))
})

const someVisiblePicked = computed(() => visibleItems.value.some(item => picked.value.has(item.key)))

/** 点那颗全选框：全勾着就取消全选，空着 / 半勾就勾上全部 */
function togglePickAll(): void {
  if (allVisiblePicked.value)
    clearPicked()
  else pickAll()
}

/** 勾选条上的「删除」：只删此刻看得见的勾选（刷新拉回新列表后过期的勾选不算数），确认在视图层 */
function deletePicked(): void {
  const items = visibleItems.value.filter(item => picked.value.has(item.key))
  if (!items.length)
    return
  void confirmAction(`选中的 ${items.length} 封会从服务器上删掉，找不回来。`, `删除 ${items.length} 封邮件`).then(
    async (confirmed) => {
      if (!confirmed)
        return
      const result = await mail.deleteMails(items)
      if (result.ok)
        pickedKeys.value = []
      else notifyError(result.error ?? '删除失败')
    },
  )
}

/** 推广段折起来：把看不见的勾选一并撤掉（全选与删除都只认看得见的行） */
function toggleShowBulk(): void {
  mail.showBulk = !mail.showBulk
  if (!mail.showBulk) {
    const visible = new Set(visibleItems.value.map(item => item.key))
    pickedKeys.value = pickedKeys.value.filter(key => visible.has(key))
  }
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

onMounted(() => {
  void mail.refreshList()
})

/** KeepAlive 换页回来再拉一次（inFlight 挡住与首次挂载的重复） */
onActivated(() => {
  void mail.refreshList()
})

/** 清单里当前这封信的已读态（阅读栏「标记未读」按钮的依据） */
const activeSeen = computed(() => mail.list.find(item => item.key === mail.active?.key)?.seen ?? true)

function toggleSeen(): void {
  const message = mail.active
  if (!message)
    return
  void mail.markSeen(message.account, message.uid, !activeSeen.value).then((result) => {
    if (!result.ok)
      notifyError(result.error ?? '标记失败')
  })
}

function openComposer(): void {
  replyTarget.value = null
  composerVisible.value = true
}

function reply(): void {
  const message = mail.active
  if (!message)
    return
  replyTarget.value = {
    from: message.account,
    to: message.fromAddress,
    subject: message.subject,
    text: message.text,
  }
  composerVisible.value = true
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

/** 附件字节数（base64 长 × 3/4，去 padding 的近似在展示层够用） */
function attachmentSize(base64: string): string {
  return formatMailSize(Math.floor((base64.length * 3) / 4))
}

/**
 * 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频 / AI 页同一套做法）。
 * 列宽用 auto —— 宽度长在左栏自己身上，grid 这一行跟着缩。
 */
const bodyStyle = computed(() => ({
  'gridTemplateColumns': 'auto minmax(0, 1fr)',
  '--tree-w': `${settings.themeConfig.mailListWidth}px`,
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

      <!-- 出错时清单还在（留着上一次的），每个拉取失败的账户一条压在顶部 -->
      <div v-for="(message, index) in mail.listErrors" :key="index" class="mail-list__error">
        {{ message }}
      </div>

      <!-- 多选态的操作条：与出错条同一个位置。左边那颗是三态全选框（全勾 / 半勾 / 空，
           取消勾选只是清掉勾选、多选态还在），「取消」才退出多选态 -->
      <div v-if="picking" class="mail-list__pick">
        <span class="mail-list__pick-lead">
          <el-checkbox
            class="mail-list__pick-all"
            :model-value="allVisiblePicked"
            :indeterminate="someVisiblePicked && !allVisiblePicked"
            aria-label="全选或取消全选"
            @change="togglePickAll"
          />
          <span class="mail-list__pick-count">已选 {{ pickedKeys.length }} 封</span>
        </span>
        <span class="mail-list__pick-actions">
          <el-button
            class="mail-list__pick-delete"
            size="small"
            text
            :disabled="deleting || !pickedKeys.length"
            @click="deletePicked"
          >
            删除
          </el-button>
          <el-button size="small" text :disabled="deleting" @click="exitPicking">取消</el-button>
        </span>
      </div>

      <div
        class="mail-list"
        role="listbox"
        aria-label="收件箱"
        :aria-multiselectable="pickedKeys.length ? 'true' : undefined"
        @keydown.esc="exitPicking"
        @keydown.ctrl.a.prevent="pickAll"
      >
        <MailListRow
          v-for="item in mail.list"
          :key="item.key"
          :item="item"
          :picking="picking"
          :picked="picked.has(item.key)"
          :active="mail.activeKey === item.key"
          :deleting="mail.deletingKeys.includes(item.key)"
          :show-source="mail.accounts.length > 1"
          @toggle-pick="togglePick(item)"
          @open="onItemClick($event, item)"
          @menu="openMenu($event, item)"
        />

        <!-- 空态只说事实：没配置 / 拉完是空的（推广段不算空，有账户拉挂了也不算空）。
             教学式引导一律不加 -->
        <div
          v-if="
            mail.configured
              && !mail.listLoading
              && mail.list.length === 0
              && mail.bulkCount === 0
              && mail.listErrors.length === 0
          "
          class="mail-list__empty"
        >
          <div class="mail-list__empty-stage" aria-hidden="true">
            <span class="mail-list__empty-letter">
              <el-icon class="mail-list__empty-icon"><Message /></el-icon>
              <span class="mail-list__empty-dot" />
            </span>
            <span class="mail-list__empty-shadow" />
          </div>
          <span class="mail-list__empty-text">收件箱是空的</span>
        </div>

        <!-- 推广 / 广告邮件段：与收件箱分开的一段 —— 默认折叠，展开也是自己的一段，
             不混进上面的清单（勾选 / 删除 / 右键与正常邮件同一套） -->
        <div v-if="mail.bulkCount > 0" class="mail-bulk">
          <button class="mail-bulk__head" type="button" @click="toggleShowBulk">
            <span>推广邮件 {{ mail.bulkCount }} 封</span>
            <el-icon class="mail-bulk__chevron" :class="{ 'is-open': mail.showBulk }">
              <ArrowDown />
            </el-icon>
          </button>
          <template v-if="mail.showBulk">
            <MailListRow
              v-for="item in mail.bulkList"
              :key="item.key"
              :item="item"
              :picking="picking"
              :picked="picked.has(item.key)"
              :active="mail.activeKey === item.key"
              :deleting="mail.deletingKeys.includes(item.key)"
              :show-source="mail.accounts.length > 1"
              @toggle-pick="togglePick(item)"
              @open="onItemClick($event, item)"
              @menu="openMenu($event, item)"
            />
          </template>
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
        <el-button type="primary" :icon="Message" @click="accountVisible = true">
          配置邮箱账户
        </el-button>
      </div>

      <!-- 拉正文期间整个阅读区让位给骨架屏：铺满整栏（头像 / 落款 / 主题 / 撑满高度的正文段落），
           段落不足时均匀铺开、超出时裁掉 —— 任何窗口高度下都不留空白，内容看着正在成形 -->
      <div v-if="mail.bodyLoading" class="mail-skeleton" aria-hidden="true">
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
            <span class="mail-head__from">{{ mail.active.fromText }}</span>
            <span v-if="mail.active.fromAddress && mail.active.fromText !== mail.active.fromAddress" class="mail-head__addr">
              &lt;{{ mail.active.fromAddress }}&gt;
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
              <el-icon class="mail-file__icon">
                <Paperclip />
              </el-icon>
              <span class="mail-file__name">{{ file.name }}</span>
              <span class="mail-file__size">{{ attachmentSize(file.base64) }}</span>
            </button>
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

      <!-- 配置了账户、还没选中邮件：空着，不摆教学式说明 -->
      <div v-else class="mail-view__blank" />
    </section>

    <!-- 弹层挂在最外层（换页不关弹层，见 AGENTS.md 第 4 节） -->
    <MailAccountDialog v-model="accountVisible" @saved="mail.invalidate()" />
    <MailComposer v-model="composerVisible" :reply="replyTarget" />
    <MailContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :bulk="menu.bulk"
      :seen="menu.seen"
      :picked-count="pickedKeys.length"
      @act="onMenuAct"
      @close="menu = null"
    />
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

/* .side__head / .side__title / .side__foot 收在 global.css（与 AI 页左栏共用） */

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

/** 勾选待批量删除的操作条：与出错条同位同壳，删除常驻危险档 */
.mail-list__pick {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding: 2px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}

.mail-list__pick-count {
  color: var(--ink-2);
  font-size: var(--fs-meta);
  white-space: nowrap;
}

/* 全选框 + 计数一行：框压掉 EP 的定高与组间距，跟计数贴在一起 */
.mail-list__pick-lead {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

.mail-list__pick-all {
  height: auto;
  margin-right: 0;
}

.mail-list__pick-actions {
  display: flex;
  align-items: center;
}

.mail-list__pick-actions .el-button + .el-button {
  margin-left: var(--sp-1);
}

.mail-list__pick-delete {
  color: var(--st-fail);
}

.mail-list__pick-delete:hover {
  color: var(--st-fail);
  background: var(--bg-subtle);
}

/** 清单自己滚；行高紧凑，一屏多看几封（行的样式在 MailListRow.vue 里） */
.mail-list {
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
  overflow-y: auto;
}

/* 推广邮件段：与收件箱分开的一段 —— 头一行是折叠开关，展开的行不混进上面的清单 */
.mail-bulk {
  margin-top: var(--sp-2);
  padding-top: var(--sp-1);
  border-top: 1px solid var(--border);
}

.mail-bulk__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  border: 0;
  border-radius: var(--r-2);
  background: transparent;
  color: var(--ink-3);
  font: inherit;
  font-size: var(--fs-meta);
  text-align: left;
  cursor: pointer;
}

.mail-bulk__head:hover {
  color: var(--ink-2);
  background: var(--bg-inset);
}

/* 展开箭头：收展是刻意的动作，走 --ease-out（动效口径见 AGENTS.md 第 4 节） */
.mail-bulk__chevron {
  flex-shrink: 0;
  font-size: 12px;
  transition: transform 0.15s var(--ease-out);
}

.mail-bulk__chevron.is-open {
  transform: rotate(180deg);
}

/*
 * 空态：一个小场景 —— 一张微倾的信笺卡（信封 + 右上角未读点）原地轻跳，
 * 姿态随跳微微摆，影子跟着缩放。入场整组弹出、文字随后浮上来。
 * 动效口径：循环用 ease-in-out，入场用 --ease-out（AGENTS.md 第 4 节）；
 * reduced-motion 由 global.css 全局兜底（动画压到近 0，占位仍在）。
 * 颜色全走灰度令牌 —— 活泼靠构图与动效，不靠彩色。
 */
.mail-list__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  min-height: 100%;
  padding: var(--sp-4) var(--sp-2);
  text-align: center;
}

/* 舞台：信笺与影子都在这块画布上摆（居中靠 left:50% + 负 margin） */
.mail-list__empty-stage {
  position: relative;
  width: 120px;
  height: 96px;
  animation: mail-empty-in 0.4s var(--ease-out) both;
}

/* 信笺卡：素灰的一张纸（--bg-inset，比面板的底图沉一档不扎眼），微微左倾，
   右上角一枚未读点 */
.mail-list__empty-letter {
  position: absolute;
  left: 50%;
  top: 0;
  margin-left: -34px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 52px;
  border-radius: var(--r-md);
  background: var(--bg-inset);
  animation: mail-empty-hop 2.4s ease-in-out infinite;
}

.mail-list__empty-icon {
  font-size: 28px;
  color: var(--ink-2);
}

/* 未读点：压在卡角上，一圈卡色描边把它从卡上托起来 */
.mail-list__empty-dot {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 12px;
  height: 12px;
  border: 2px solid var(--bg-inset);
  border-radius: var(--r-pill);
  background: var(--ink);
}

/* 地上的影子：信跳起来它就缩小变淡，落回去就摊平 */
.mail-list__empty-shadow {
  position: absolute;
  left: 50%;
  bottom: 6px;
  margin-left: -22px;
  width: 44px;
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--ink);
  opacity: 0.1;
  animation: mail-empty-shadow 2.4s ease-in-out infinite;
}

.mail-list__empty-text {
  color: var(--ink-3);
  font-size: var(--fs-body);
  animation: mail-empty-text-in 0.45s var(--ease-out) 0.1s both;
}

@keyframes mail-empty-in {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
}

@keyframes mail-empty-text-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

/* 跳的节奏里织进姿态：跳起顺势摆正一点，回弹时歪回去，落地归位 */
@keyframes mail-empty-hop {
  0%,
  58%,
  100% {
    transform: translateY(0) rotate(-4deg);
  }
  26% {
    transform: translateY(-14px) rotate(2deg);
  }
  72% {
    transform: translateY(-5px) rotate(-7deg);
  }
  86% {
    transform: translateY(0) rotate(-4deg);
  }
}

@keyframes mail-empty-shadow {
  0%,
  58%,
  100% {
    transform: scaleX(1);
    opacity: 0.1;
  }
  26% {
    transform: scaleX(0.62);
    opacity: 0.06;
  }
  72% {
    transform: scaleX(0.86);
    opacity: 0.08;
  }
  86% {
    transform: scaleX(1);
    opacity: 0.1;
  }
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

/* 阅读栏的来源（多账户时）：完整地址摆得下，正常给 */
.mail-head__src {
  color: var(--ink-3);
  font-size: var(--fs-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border-radius: var(--r-2);
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
