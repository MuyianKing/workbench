<script setup lang="ts">
import type { MailContact, MailFolder } from '@workbench/mail'
import type { MailListItem } from '@/stores/mail'
import { ArrowDown, EditPen, Loading, Message, Plus, Refresh, Setting, User } from '@element-plus/icons-vue'
import { recipientAddress, senderAddress } from '@workbench/mail'
/**
 * 邮箱页左栏：三签（收件箱 / 已发送 / 联系人）、邮件清单与推广段、多选删除、通讯录。
 *
 * 从 `MailView.vue` 拆出来的整块。清单与勾选状态本来就只在这一栏里用
 * （父组件只负责两栏布局与那几个弹层），多选态的生命周期也跟着「换签」走 ——
 * 收在这里之后父组件不必再为勾选与右键菜单持有状态。
 *
 * 两个动作越出这一栏：底部「账户」与「写邮件」由父组件开弹层（`accounts` / `compose`）。
 */
import { computed, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import MailContactEditDialog from '@/components/MailContactEditDialog.vue'
import MailContactMenu from '@/components/MailContactMenu.vue'
import MailContextMenu from '@/components/MailContextMenu.vue'
import MailListRow from '@/components/MailListRow.vue'
import { confirmAction, notifyError } from '@/notify'
import { useMailStore } from '@/stores/mail'

const emit = defineEmits<{
  accounts: []
  compose: []
}>()

const mail = useMailStore()

const folderOptions = [
  { label: '收件箱', value: 'inbox' },
  { label: '已发送', value: 'sent' },
  { label: '联系人', value: 'contacts' },
]

/** 分段选择器递回来的值收敛成三个逻辑名（组件那边是宽泛的联合类型，这里收一道） */
function changeFolder(value: unknown): void {
  mail.setTab(value === 'sent' ? 'sent' : value === 'contacts' ? 'contacts' : 'inbox')
}

// ---------- 通讯录那一签 ----------

/** 新增 / 编辑联系人的小弹窗：名单在左栏那一签里摆，编辑走它 */
const contactEditVisible = ref(false)
/** 正在编辑的联系人；null = 新增 */
const editingContact = ref<MailContact | null>(null)
/** 正在删的地址（那一行上转圈） */
const removingContact = ref<string | null>(null)
/** 联系人那一行的右键菜单落点与它对着的那个人（编辑 / 删除都在菜单里，行上不带按钮） */
const contactMenu = ref<{ x: number, y: number, contact: MailContact } | null>(null)

function openContactAdd(): void {
  editingContact.value = null
  contactEditVisible.value = true
}

function openContactEdit(contact: MailContact): void {
  editingContact.value = contact
  contactEditVisible.value = true
}

function openContactMenu(event: MouseEvent, contact: MailContact): void {
  contactMenu.value = { x: event.clientX, y: event.clientY, contact }
}

function onContactMenuAct(name: 'edit' | 'delete'): void {
  const state = contactMenu.value
  if (!state)
    return
  if (name === 'edit')
    openContactEdit(state.contact)
  else void removeContact(state.contact)
}

/** 删除不做确认：名单里少一条随时能再加回来，不值得多拦一道 */
async function removeContact(contact: MailContact): Promise<void> {
  if (removingContact.value)
    return
  removingContact.value = contact.address
  const result = await mail.removeContact(contact.address)
  removingContact.value = null
  if (!result.ok)
    notifyError(result.error ?? '删除失败')
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
 *  「取消」/ Esc 与删完一批才退出 */
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

/** 只清勾选，**不退出多选态**（全选框取消勾走它）—— 复选框留着接着挑 */
function clearPicked(): void {
  pickedKeys.value = []
}

/** 退出多选态：勾选清掉、复选框收起，点行恢复开信（勾选条「取消」、Esc 与删完一批） */
function exitPicking(): void {
  picking.value = false
  pickedKeys.value = []
}

/** 换签就把多选态收掉：勾选是按旧清单的身份记的，留着会对着看不见的行报「已选 N 封」 */
watch(() => mail.tab, exitPicking)

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

/** 勾选条上的「删除」：只删此刻看得见的勾选（刷新拉回新列表后过期的勾选不算数），
 *  确认在视图层；删成一批就退出多选态 */
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
        exitPicking()
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

// ---------- 右键菜单（邮件清单行） ----------

/** 右键菜单的落点与它对着的那一行（哪个文件夹 / 账户、发件人在不在黑名单、已读态、对方在不在通讯录，
 *  都给菜单定文案用） */
const menu = ref<{
  x: number
  y: number
  key: string
  folder: MailFolder
  account: string
  uid: number
  bulk: boolean
  contact: boolean
  seen: boolean
} | null>(null)

/**
 * 这一行的「对方」地址：收件箱看发件人、发件箱看收件人（与阅读栏第一行、回复同一口径）——
 * 存联系人存的就是它。找不到（头部没法解析）给空串。
 */
function rowPartyAddress(item: MailListItem): string {
  return (item.folder === 'sent' ? recipientAddress(item.to) : senderAddress(item.from)).toLowerCase()
}

function openMenu(event: MouseEvent, item: MailListItem): void {
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    key: item.key,
    folder: item.folder,
    account: item.account,
    uid: item.uid,
    bulk: mail.bulkSenders.includes(senderAddress(item.from).toLowerCase()),
    contact: mail.isContact(rowPartyAddress(item)),
    seen: item.seen,
  }
}

function onMenuAct(name: 'contact' | 'bulk' | 'toggle-seen' | 'multi-pick' | 'multi-delete' | 'delete'): void {
  const state = menu.value
  if (!state)
    return
  if (name === 'contact') {
    // 「存为联系人 / 移出联系人」：对着谁、存什么名字都由 store 按这一行的身份自己算
    void mail.toggleContact(state.account, state.uid)
    return
  }
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
      const result = await mail.deleteMails([{ folder: state.folder, account: state.account, uid: state.uid }])
      if (!result.ok)
        notifyError(result.error ?? '删除失败')
    })
    return
  }
  void mail.markSeen({ folder: state.folder, account: state.account, uid: state.uid }, !state.seen).then((result) => {
    if (!result.ok)
      notifyError(result.error ?? '标记失败')
  })
}
</script>

<template>
  <!-- 左栏：邮件清单（收件箱 / 已发送）或通讯录（联系人那一签） -->
  <aside class="mail-view__side panel">
    <header class="side__head">
      <el-segmented
        class="side__folders"
        size="small"
        :model-value="mail.tab"
        :options="folderOptions"
        @change="changeFolder"
      />
      <!-- 面板级动作摆在这一行的右端，只在自己那一签里出现：
           邮件签是「刷新」，通讯录签是「新增联系人」 -->
      <el-tooltip v-if="mail.tab !== 'contacts'" content="刷新" placement="bottom">
        <el-button
          class="side__refresh"
          text
          :icon="Refresh"
          :loading="mail.listLoading"
          :aria-label="`刷新${mail.folderLabel}`"
          @click="mail.refreshList()"
        />
      </el-tooltip>
      <el-tooltip v-else content="新增联系人" placement="bottom">
        <el-button
          class="side__refresh"
          text
          :icon="Plus"
          aria-label="新增联系人"
          @click="openContactAdd"
        />
      </el-tooltip>
    </header>

    <!-- 出错时清单还在（留着上一次的），每个拉取失败的账户一条压在顶部（通讯录签里与信无关，不画） -->
    <template v-if="mail.tab !== 'contacts'">
      <div v-for="(message, index) in mail.listErrors" :key="index" class="mail-list__error">
        {{ message }}
      </div>
    </template>

    <!-- 多选态的操作条：与出错条同一个位置（只在邮件签上有 —— 换签时多选态已经收掉）。
         左边那颗是三态全选框（全勾 / 半勾 / 空，取消勾选只是清掉勾选、多选态还在），
         「取消」才退出多选态 -->
    <div v-if="picking && mail.tab !== 'contacts'" class="mail-list__pick">
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

    <!-- 通讯录那一签：一行一个人（名字 / 地址）。**行上不带按钮** —— 编辑与删除都收在
         右击弹出的 MailContactMenu 里（与邮件清单行同一种做法），新增走头部那颗动作 -->
    <div v-if="mail.tab === 'contacts'" class="contact-list" role="list">
      <div
        v-for="contact in mail.contacts"
        :key="contact.address"
        class="contact-row"
        :class="{ 'is-removing': removingContact === contact.address }"
        role="listitem"
        @contextmenu.prevent="openContactMenu($event, contact)"
      >
        <span class="contact-row__name" :title="contact.name || contact.address">
          {{ contact.name || contact.address }}
        </span>
        <span v-if="contact.name" class="contact-row__addr" :title="contact.address">
          {{ contact.address }}
        </span>
        <el-icon v-if="removingContact === contact.address" class="contact-row__removing is-loading">
          <Loading />
        </el-icon>
      </div>
      <EmptyState v-if="!mail.contacts.length" compact :icon="User" text="还没有联系人" />
    </div>

    <div
      v-else
      class="mail-list"
      role="listbox"
      :aria-label="mail.folderLabel"
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
        :sent="item.folder === 'sent'"
        @toggle-pick="togglePick(item)"
        @open="onItemClick($event, item)"
        @menu="openMenu($event, item)"
      />

      <!-- 没配置账户：清单无从拉起 —— 也摆空态配图 + 一句事实
           （配置入口在右栏那颗与左栏底部「账户」） -->
      <EmptyState v-if="!mail.configured" :icon="Message" text="还没有配置邮箱账户" />

      <!-- 空态只说事实：没配置 / 拉完是空的（推广段不算空，有账户拉挂了也不算空）。
           教学式引导一律不加 -->
      <EmptyState
        v-if="
          mail.configured
            && !mail.listLoading
            && mail.list.length === 0
            && mail.bulkCount === 0
            && mail.listErrors.length === 0
        "
        :icon="Message"
        dot
        :text="mail.folder === 'sent' ? '已发送是空的' : '收件箱是空的'"
      />

      <!-- 推广 / 广告邮件段：与收件箱分开的一段 —— 默认折叠，展开也是自己的一段，
           不混进上面的清单（勾选 / 删除 / 右键与正常邮件同一套） -->
      <div v-if="mail.bulkCount > 0" class="mail-bulk">
        <button class="mail-bulk__head" type="button" @click="toggleShowBulk">
          <span class="mail-bulk__label">推广邮件<span class="mail-bulk__count">{{ mail.bulkCount }}</span>封</span>
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
            :sent="false"
            @toggle-pick="togglePick(item)"
            @open="onItemClick($event, item)"
            @menu="openMenu($event, item)"
          />
        </template>
      </div>
    </div>

    <footer class="side__foot">
      <el-button class="side__account" text :icon="Setting" @click="emit('accounts')">
        账户
      </el-button>
      <el-button class="side__compose" text :icon="EditPen" :disabled="!mail.configured" @click="emit('compose')">
        写邮件
      </el-button>
    </footer>

    <!-- 新增 / 编辑联系人的小弹窗与两份右键菜单：都只服务这一栏 -->
    <MailContactEditDialog v-model="contactEditVisible" :contact="editingContact" />
    <MailContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :bulk="menu.bulk"
      :seen="menu.seen"
      :contact="menu.contact"
      :picked-count="pickedKeys.length"
      :sent="menu.folder === 'sent'"
      @act="onMenuAct"
      @close="menu = null"
    />
    <MailContactMenu
      v-if="contactMenu"
      :x="contactMenu.x"
      :y="contactMenu.y"
      @act="onContactMenuAct"
      @close="contactMenu = null"
    />
  </aside>
</template>

<style scoped>
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

/* 文件夹切换（收件箱 / 已发送）：外壳（底色 / 圆角 / 选中态）在 global.css，
   这里只补字号与内边距 —— 压到与 .side__title 同一档，不把表头那一行撑高 */
.side__folders.el-segmented {
  flex-shrink: 0;
  font-size: var(--fs-meta);
}

.side__folders :deep(.el-segmented__item) {
  padding: 1px 10px;
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
  border-radius: var(--r-md);
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
  border-radius: var(--r-md);
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

/** 清单自己滚；一行一张小卡片，卡片之间留一档缝（行的样式在 MailListRow.vue 里） */
.mail-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--sp-1);
  min-height: 0;
  margin-top: var(--sp-2);
  overflow-y: auto;
}

/* 通讯录那一签的名单：一行一个人，与邮件清单同一副行的分量（名字主色、地址退一档）。
   行上不带按钮，动作用右击（MailContactMenu）—— user-select: none 与邮件清单行同理 */
.contact-list {
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
  overflow-y: auto;
}

.contact-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-md);
  user-select: none;
}

.contact-row:hover {
  background: var(--bg-inset);
}

/* 删除中：整行退到半透明接不住点（与邮件清单里那几行同一口径） */
.contact-row.is-removing {
  opacity: 0.45;
  pointer-events: none;
}

.contact-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-body);
}

/* 地址：有名字时才跟着摆（没名字时它已经在名字那一格了） */
.contact-row__addr {
  flex-shrink: 1;
  min-width: 0;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 正在删的那一行：行尾转个圈（与邮件清单里删信那几行同一副信号） */
.contact-row__removing {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
}

/* 推广邮件段：与收件箱分开的一段 —— 头一行是折叠开关，展开的行不混进上面的清单 */
.mail-bulk {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-top: var(--sp-2);
  padding-top: var(--sp-1);
  border-top: 1px solid var(--border);
}

/* 折叠开关上的「推广邮件 N 封」：数字收进一枚安静的小胶囊里 */
.mail-bulk__label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}

.mail-bulk__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}

.mail-bulk__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  border: 0;
  border-radius: var(--r-md);
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

.side__account,
.side__compose {
  height: 24px;
  padding: 0 var(--sp-1);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}
</style>
