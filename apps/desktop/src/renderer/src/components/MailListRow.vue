<script setup lang="ts">
import type { MailListItem } from '@/stores/mail'
/**
 * 邮件清单行（收件箱清单、推广邮件段与发件箱共用同一副）：
 * 一张浮在清单上的小卡片 —— 左侧是发件人（发件箱里是收件人）的首字头像，
 * 右侧两行：第一行「未读点 + 发件人 + 来源账户 + 日期」，第二行「主题 + 附件回形针」。
 * 行首的复选框**只在多选态出现**（入口是右键的「多选删除」，或 Ctrl / Shift 的快捷选法），
 * 平时点行就是开信。
 *
 * **发件箱里第一行摆的是收件人**（`sent`）：那儿的「发件人」是自己，摆出来没信息；
 * 未读点也一并收起来 —— 自己发出去的信没有未读这回事。
 *
 * **整行都是开信面**：点击挂在卡片容器上，内边距与空白都算；行内那颗按钮只为键盘
 * （Enter / Space 的原生 click 照样冒泡到卡片上）；复选框自己 `@click.stop`，点它只勾选、不开信。
 *
 * 来源账户（多账户时才画）压在发件人旁边、不占主题那一行：主题是这一行最该完整的东西，
 * 账户只是辅助；日期走 displayListDate 的短串（今天给时刻 / 昨天 / 月日 / 年月日）。
 *
 * 只管摆：勾选 / 开信 / 右键都原样交回父级（MailView）处置 —— 多选态、勾选批次、
 * 菜单与删除的策略都在那边。
 */
import { Loading, Paperclip } from '@element-plus/icons-vue'
import { accountTag, decodeEncodedWords, displayListDate, displayRecipients, displaySender } from '@workbench/mail'
import { computed } from 'vue'

const props = defineProps<{
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
  /** 发件箱：第一行摆收件人、不画未读点 */
  sent: boolean
}>()

const emit = defineEmits<{
  /** 勾 / 撤这封（复选框或 Ctrl+点选） */
  'toggle-pick': []
  /** 点了行主体：开信（父级按修饰键还能接住 Ctrl / Shift 的快捷选法） */
  'open': [event: MouseEvent]
  /** 右键：父级摆菜单 */
  'menu': [event: MouseEvent]
}>()

/** 第一行摆谁：收件箱是发件人，发件箱是收件人（顿号连接，全名由 title 兜着） */
const party = computed(() => {
  if (!props.sent)
    return displaySender(props.item.from)
  return displayRecipients(props.item.to) || '(无收件人)'
})

/** 头像上的那个字：展示名的首字（中文原字 / 英文大写）；拆不出名字时给 ? */
const avatarInitial = computed(() => {
  const text = party.value.trim()
  if (!text || text.startsWith('('))
    return '?'
  return (Array.from(text)[0] ?? '?').toUpperCase()
})

/** 头像底色按展示名散到八档柔和色里：同一个发件人恒定，不表达状态 */
const avatarTone = computed(() => {
  let hash = 0
  for (const char of party.value)
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % 8
})

/** 主题是原始头部文本（RFC 2047 编码词），解码在这里做 */
function subjectText(raw: string): string {
  const decoded = decodeEncodedWords(raw).trim()
  return decoded || '(无主题)'
}
</script>

<template>
  <div
    class="mail-item"
    role="option"
    :aria-selected="picked"
    :class="{
      'is-active': active,
      'is-unread': !sent && !item.seen,
      'is-picked': picked,
      'is-deleting': deleting,
    }"
    @click="emit('open', $event)"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <!-- 行首复选框：只在多选态出现（右键「多选删除」进入），平时不占位。
         `@click.stop`：点它只勾选 —— 别冒泡到卡片上变成「又开了一次信」 -->
    <el-checkbox
      v-if="picking"
      class="mail-item__check"
      :model-value="picked"
      :aria-label="`选择：${subjectText(item.subject)}`"
      @click.stop
      @change="emit('toggle-pick')"
    />
    <button class="mail-item__main" type="button">
      <span class="mail-item__avatar" :class="`is-tone-${avatarTone}`" aria-hidden="true">{{ avatarInitial }}</span>
      <span class="mail-item__content">
        <span class="mail-item__row">
          <span class="mail-item__dot" aria-hidden="true" />
          <span class="mail-item__from" :title="party">{{ party }}</span>
          <el-icon v-if="deleting" class="mail-item__deleting is-loading"><Loading /></el-icon>
          <span v-if="showSource" class="mail-item__src" :title="item.account">{{ accountTag(item.account) }}</span>
          <span class="mail-item__date">{{ displayListDate(item.date) }}</span>
        </span>
        <span class="mail-item__sub">
          <span class="mail-item__subject" :title="subjectText(item.subject)">{{ subjectText(item.subject) }}</span>
          <el-icon v-if="item.hasAttachment" class="mail-item__clip"><Paperclip /></el-icon>
        </span>
      </span>
    </button>
  </div>
</template>

<style scoped>
/*
 * 一张小卡片：底色比面板低一档，靠 1px 透明边框与 4px 的间距排开。
 * 悬停只把底色抬到 --bg-inset、边框实起来；正在读的那封换一层淡的选中底 +
 * 左边 3px 主题色窄轨，字取 --ink-accent —— 不铺整块主题色，清单才不闷。
 */
.mail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
  padding: var(--sp-2);
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  cursor: pointer;
  /* Shift 点范围时别把正文选中（勾选走的是行状态，不是 DOM 选区） */
  user-select: none;
  transition: background-color 0.16s ease, border-color 0.16s ease;
}

.mail-item:hover {
  border-color: var(--border);
  background: var(--bg-inset);
}

/* 删除中：整行退到半透明、接不住点击 —— 服务器收走之后整行消失 */
.mail-item.is-deleting {
  opacity: 0.45;
  pointer-events: none;
}

/* 正在读的这封：淡主题色底 + 左侧窄轨，字取主题色（--ink-accent） */
.mail-item.is-active {
  border-color: color-mix(in srgb, var(--el-color-primary) 32%, transparent);
  /* 卡片本身已有底色，满浓度的 --bg-selected 会压成一块实心色；与 --bg-subtle 调和到约三成 */
  background: color-mix(in srgb, var(--bg-selected) 32%, var(--bg-subtle));
}

.mail-item.is-active:hover {
  background: color-mix(in srgb, var(--bg-selected) 44%, var(--bg-subtle));
}

.mail-item.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 var(--r-pill) var(--r-pill) 0;
  background: var(--el-color-primary);
}

/* 勾选待删的行：底色稳在悬停那一档（比选中的主题色淡底轻，与正在读的那封区分开），
   勾没勾看行首复选框就够 */
.mail-item.is-picked {
  border-color: var(--border-strong);
  background: var(--bg-inset);
}

/* 行首复选框：压掉 EP 的定高与组间距，让它就是卡片左端一颗安静的勾选框 */
.mail-item__check {
  flex-shrink: 0;
  height: auto;
  margin-right: 0;
}

/* 主体：头像 + 两行字（开信挂在卡片上，键盘靠这颗按钮的原生 click 冒泡） */
.mail-item__main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: inherit;
}

/*
 * 首字头像：28px 圆片，按展示名稳定散到八档柔和色（红 / 橙 / 黄 / 绿 / 青 / 蓝 / 靛 / 紫）。
 * 选中时不再换成主题色实心 —— 身份色留在头像上，选中由卡片淡底与左侧窄轨表达。
 * 亮色浅底深字、暗色深底浅字；色相只有这八档，别在别处再调一套。
 */
.mail-item__avatar {
  --avatar-h: 212;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-pill);
  background: hsl(var(--avatar-h), 75%, 84%);
  color: hsl(var(--avatar-h), 60%, 30%);
  font-size: var(--fs-meta);
  font-weight: 600;
  line-height: 1;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.mail-item__avatar.is-tone-0 {
  --avatar-h: 4;
}

.mail-item__avatar.is-tone-1 {
  --avatar-h: 28;
}

.mail-item__avatar.is-tone-2 {
  --avatar-h: 48;
}

.mail-item__avatar.is-tone-3 {
  --avatar-h: 150;
}

.mail-item__avatar.is-tone-4 {
  --avatar-h: 182;
}

.mail-item__avatar.is-tone-5 {
  --avatar-h: 212;
}

.mail-item__avatar.is-tone-6 {
  --avatar-h: 252;
}

.mail-item__avatar.is-tone-7 {
  --avatar-h: 292;
}

/* 暗色下同色相换深底浅字。整条选择器一起放进 :global()：只包 `:root[...]`
   那一截的话，scoped 编译会把后面的 `.mail-item__avatar` 丢掉，规则落到根元素上 */
:global(:root[data-theme='dark'] .mail-item__avatar) {
  background: hsl(var(--avatar-h), 40%, 30%);
  color: hsl(var(--avatar-h), 65%, 82%);
}

/* 右侧两行：第一行发件人 + 来源 + 日期，第二行主题 + 附件 */
.mail-item__content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}

/* 第一行：未读点 + 发件人 + 来源账户 + 日期（未读的整行字重抬一档） */
.mail-item__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

/* 未读点：没读才画，读了的占位保持对齐 */
.mail-item__dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: var(--r-pill);
}

.mail-item.is-unread .mail-item__dot {
  background: var(--ink);
}

.mail-item.is-active .mail-item__dot {
  background: var(--el-color-primary);
}

.mail-item__from {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-meta);
  font-weight: 500;
  line-height: 16px;
  letter-spacing: 0.01em;
  color: var(--ink-2);
}

.mail-item.is-unread .mail-item__from {
  color: var(--ink);
  font-weight: 600;
}

.mail-item__deleting {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
}

/* 来源账户：发件人旁边一小截等宽字，前面挂一个中点；完整地址由 title 兜着 */
.mail-item__src {
  flex-shrink: 0;
  max-width: 82px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 16px;
  letter-spacing: 0.02em;
}

.mail-item__src::before {
  content: '·';
  margin-right: 4px;
  color: var(--ink-3);
}

.mail-item__date {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 16px;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 第二行：主题吃剩余宽度，附件回形针跟在右边；缩进对齐到发件人（跨过未读点） */
.mail-item__sub {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding-left: calc(5px + var(--sp-1));
  min-width: 0;
}

.mail-item__subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  line-height: 18px;
  color: var(--ink);
}

.mail-item__clip {
  flex-shrink: 0;
  color: var(--ink-3);
}

/* 选中态文字整体抬一档：主题与发件人取主题色，日期 / 回形针 / 来源退到 --ink-2。
   主题最重（加粗），发件人跟着同色、字重照旧 —— 这样「现在在读哪封、是谁写的」
   在清单里一眼认得出，而不是靠比别处深一点的灰 */
.mail-item.is-active .mail-item__from,
.mail-item.is-active .mail-item__subject {
  color: var(--ink-accent);
}

.mail-item.is-active .mail-item__subject {
  font-weight: 600;
}

.mail-item.is-active .mail-item__date,
.mail-item.is-active .mail-item__clip,
.mail-item.is-active .mail-item__src,
.mail-item.is-active .mail-item__deleting {
  color: var(--ink-2);
}

.mail-item.is-active .mail-item__src::before {
  color: var(--ink-2);
}

/* 未读那行整行字重抬一档、字色到 --ink 为止；但**正在读的那封走上面的主题色**
   （它比未读更该拿这个色），所以这里把选中态排除掉 */
.mail-item.is-unread:not(.is-active) .mail-item__subject {
  font-weight: 600;
  color: var(--ink);
}
</style>
