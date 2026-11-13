<script setup lang="ts">
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { CircleCheck, Delete, Finished, Flag, Hide, User, View } from '@element-plus/icons-vue'
import { computed } from 'vue'
import FloatingMenu from '@/components/FloatingMenu.vue'
/**
 * 邮件清单行的右键菜单：存联系人 / 标记广告 / 翻已读 / 多选删除 / 删信。
 *
 * **存为联系人**是通讯录的主入口：把这一行的**对方**（收件箱看发件人、发件箱看收件人 ——
 * 与阅读栏第一行同一口径）攒进设置里的 `mailContacts`。已经在通讯录里时这一项变成
 * 「移出联系人」。它不挑文件夹：发件箱里对着收件人也一样能用。
 *
 * **标记为广告**是广告过滤的主入口：发件人地址进黑名单（设置里的 mailBulkSenders），
 * 这个发件人过去与将来的信在清单里都算广告 —— 自动启发式只兜显然的那种，
 * 什么算广告最终由主人说了算。对着黑名单里的发件人再右击，这一项变成「取消广告标记」。
 * **发件箱里（`sent`）这两项不画**：那儿的发件人是自己（标自己为广告说不过去），
 * 自己发出去的信也没有已读未读这回事。
 *
 * **多选删除**跟着勾选态变：还没勾选时它是个入口 —— 把右击的这封勾进批次（行首
 * 复选框随之亮起，勾选条出现）；已勾选时它变成「删除所选 N 封」，直接确认删掉整批。
 * 「删除邮件」始终只删右击的那一封。
 *
 * 只管摆和收：外壳、贴指针与收起都在 FloatingMenu（与其他几处右键菜单共用）；
 * 点选动作经 act 交回 MailView。
 */
const props = defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
  /** 这一行的发件人已在黑名单里：首项变成「取消广告标记」 */
  bulk: boolean
  /** 这一行的已读态：中间项在「标记为已读 / 未读」之间切换 */
  seen: boolean
  /** 这一行的对方已在通讯录里：首项变成「移出联系人」 */
  contact: boolean
  /** 此刻勾了几封（0 = 还没勾）：决定「多选删除」是入口还是直接删这批 */
  pickedCount: number
  /** 发件箱里的一行：广告与已读两项不画 */
  sent: boolean
}>()

const emit = defineEmits<{
  /** 选中了一项：contact（存 / 移出联系人）、bulk（标记 / 取消广告）、toggle-seen（翻已读态）、
   *  multi-pick（把这封勾进批次）、multi-delete / delete（删勾选批次 / 删这一封，确认在视图层） */
  act: [name: MenuAct]
  close: []
}>()

type MenuAct = 'contact' | 'bulk' | 'toggle-seen' | 'multi-pick' | 'multi-delete' | 'delete'

/** 菜单项：发件箱里没有广告与已读两项（收件人是自己，这两件事都没意义），
 *  勾选与删除那一组前面画一道分隔线 —— 收件箱里它正好把联系人那组也隔开 */
const items = computed<FloatingMenuItem[]>(() => [
  {
    name: 'contact' as const,
    label: props.contact ? '移出联系人' : '存为联系人',
    icon: props.contact ? CircleCheck : User,
    sep: false,
  },
  ...(props.sent
    ? []
    : [
        {
          name: 'bulk' as const,
          label: props.bulk ? '取消广告标记' : '标记为广告',
          icon: props.bulk ? CircleCheck : Flag,
          sep: false,
        },
        {
          name: 'toggle-seen' as const,
          label: props.seen ? '标记为未读' : '标记为已读',
          icon: props.seen ? Hide : View,
          sep: false,
        },
      ]),
  props.pickedCount > 0
    ? { name: 'multi-delete' as const, label: `删除所选 ${props.pickedCount} 封`, icon: Delete, danger: true, sep: true }
    : { name: 'multi-pick' as const, label: '多选删除', icon: Finished, sep: true },
  {
    name: 'delete' as const,
    label: '删除邮件',
    icon: Delete,
    danger: true,
    sep: !props.sent && props.pickedCount === 0,
  },
])
</script>

<template>
  <FloatingMenu
    :x="props.x"
    :y="props.y"
    :items="items"
    @act="name => emit('act', name as MenuAct)"
    @close="emit('close')"
  />
</template>
