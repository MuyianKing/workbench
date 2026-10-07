<script setup lang="ts">
import type { MailListItem } from '@/stores/mail'
/**
 * 收件箱的清单行（收件箱清单与推广邮件段共用同一副）：
 * 两行内容 —— 第一行「未读点 + 发件人 + 日期」，第二行「主题 + 附件回形针 +
 * 来源（配了多个账户才画）」。行首的复选框**只在多选态出现**（入口是右键的
 * 「多选删除」，或 Ctrl / Shift 的快捷选法），平时点行就是开信。
 *
 * 只管摆：勾选 / 开信 / 右键都原样交回父级（MailView）处置 —— 多选态、勾选批次、
 * 菜单与删除的策略都在那边。
 */
import { Loading, Paperclip } from '@element-plus/icons-vue'
import { accountTag, decodeEncodedWords, displayDate, displaySender } from '@workbench/mail'

defineProps<{
  /** 这一行画哪封 */
  item: MailListItem
  /** 多选态：行首亮出复选框，点行从「开信」变成「勾 / 撤」 */
  picking: boolean
  /** 勾选态（批次在父级手里） */
  picked: boolean
  /** 正在读的这封 */
  active: boolean
  /** 删除中：整行变淡转圈接不住点 */
  deleting: boolean
  /** 来源标注画不画（配了多个账户才画，一个账户没什么可标的） */
  showSource: boolean
}>()

const emit = defineEmits<{
  /** 勾 / 撤这封（复选框或 Ctrl+点选） */
  'toggle-pick': []
  /** 点了行主体：开信（父级按修饰键还能接住 Ctrl / Shift 的快捷选法） */
  'open': [event: MouseEvent]
  /** 右键：父级摆菜单 */
  'menu': [event: MouseEvent]
}>()

/** 主题是原始头部文本（RFC 2047 编码词），解码在这里做 */
function subjectText(raw: string): string {
  const decoded = decodeEncodedWords(raw).trim()
  return decoded || '(无主题)'
}

/** 发件人展示名（@workbench/mail 的 displaySender，列表与阅读栏同一套解码） */
function senderText(raw: string): string {
  return displaySender(raw)
}
</script>

<template>
  <div
    class="mail-item"
    role="option"
    :aria-selected="picked"
    :class="{
      'is-active': active,
      'is-unread': !item.seen,
      'is-picked': picked,
      'is-deleting': deleting,
    }"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <!-- 行首复选框：只在多选态出现（右键「多选删除」进入），平时不占位 -->
    <el-checkbox
      v-if="picking"
      class="mail-item__check"
      :model-value="picked"
      :aria-label="`选择：${subjectText(item.subject)}`"
      @change="emit('toggle-pick')"
    />
    <button class="mail-item__main" type="button" @click="emit('open', $event)">
      <span class="mail-item__row">
        <span class="mail-item__dot" aria-hidden="true" />
        <span class="mail-item__from" :title="senderText(item.from)">{{ senderText(item.from) }}</span>
        <el-icon v-if="deleting" class="mail-item__deleting is-loading"><Loading /></el-icon>
        <span class="mail-item__date">{{ displayDate(item.date) }}</span>
      </span>
      <span class="mail-item__sub">
        <span class="mail-item__subject" :title="subjectText(item.subject)">{{ subjectText(item.subject) }}</span>
        <el-icon v-if="item.hasAttachment" class="mail-item__clip"><Paperclip /></el-icon>
        <span v-if="showSource" class="mail-item__src" :title="item.account">{{ accountTag(item.account) }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
/*
 * 一行两段：复选框贴左居中，主体吃剩余宽度。悬停与选中与别处同一副令牌
 * （--bg-inset / --bg-selected；没有 --bg-hover / --bg-active 这两个令牌）。
 */
.mail-item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
  padding: var(--sp-2);
  border-radius: var(--r-2);
  /* Shift 点范围时别把正文选中（勾选走的是行状态，不是 DOM 选区） */
  user-select: none;
}

.mail-item:hover {
  background: var(--bg-inset);
}

/* 删除中：整行退到半透明、接不住点击 —— 服务器收走之后整行消失 */
.mail-item.is-deleting {
  opacity: 0.45;
  pointer-events: none;
}

.mail-item.is-active {
  background: var(--bg-selected);
}

/* 勾选待删的行：底色稳在悬停那一档（比 --bg-selected 轻，与正在读的那封区分开），
   勾没勾看行首复选框就够 */
.mail-item.is-picked {
  background: var(--bg-inset);
}

/* 行首复选框：压掉 EP 的定高与组间距，让它就是行首一颗安静的勾选框 */
.mail-item__check {
  flex-shrink: 0;
  height: auto;
  margin-right: 0;
}

/* 主体：开信在它身上，铺满复选框之外的整行 */
.mail-item__main {
  flex: 1;
  min-width: 0;
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

/* 第一行：未读点 + 发件人 + 日期（未读的整行字重抬一档，这是第二个未读信号） */
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

.mail-item__deleting {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
}

.mail-item__date {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

/* 第二行：主题吃剩余宽度，附件回形针与来源跟在右边（主题长就先裁主题） */
.mail-item__sub {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-top: 2px;
  padding-left: calc(6px + var(--sp-1));
  min-width: 0;
}

.mail-item__subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
}

.mail-item__clip {
  flex-shrink: 0;
  color: var(--ink-3);
}

/* 来源标注（多账户时）：跟日期一档的安静小字，压住宽度靠 title 兜全地址 */
.mail-item__src {
  flex-shrink: 1;
  min-width: 0;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

/* 选中态文字整体抬一档：主题最重，发件人次之，日期别抢眼 */
.mail-item.is-active .mail-item__subject {
  color: var(--ink);
  font-weight: 600;
}

.mail-item.is-active .mail-item__from {
  color: var(--ink);
}

.mail-item.is-active .mail-item__date,
.mail-item.is-active .mail-item__clip {
  color: var(--ink-2);
}

.mail-item.is-unread .mail-item__subject {
  font-weight: 600;
  color: var(--ink);
}
</style>
