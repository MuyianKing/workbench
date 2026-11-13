<script setup lang="ts">
import type { MailReplyTarget } from '@/stores/mail'
/**
 * 邮箱页：左栏邮件清单，右栏读信（与 AI / 笔记 / 视频页同一副左右分栏，
 * 左栏宽度住 theme.json 的 `mailListWidth`）。
 *
 * 这一层只管**两栏布局与那几个弹层**：左栏的清单 / 勾选 / 通讯录在 `MailSidebar.vue`，
 * 右栏的阅读区与附件在 `MailReaderPane.vue`。两个越界的动作（配置账户、写邮件 / 回复）
 * 由它们 emit 回来，弹层挂在这里 —— 换页不关弹层（见 AGENTS.md 第 4 节）。
 *
 * 进页面 / 切回来都拉一次清单（`inFlight` 挡住两次重复）；不后台轮询 ——
 * 这个应用没有「自己偷偷跑流量」这回事。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import MailAccountDialog from '@/components/MailAccountDialog.vue'
import MailComposer from '@/components/MailComposer.vue'
import MailReaderPane from '@/components/MailReaderPane.vue'
import MailSidebar from '@/components/MailSidebar.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { useMailStore } from '@/stores/mail'
import { useSettingsStore } from '@/stores/settings'

const mail = useMailStore()
const settings = useSettingsStore()

const accountVisible = ref(false)
const composerVisible = ref(false)
/** 回复的预填内容；null = 写的是新邮件 */
const replyTarget = ref<MailReplyTarget | null>(null)

function openComposer(): void {
  replyTarget.value = null
  composerVisible.value = true
}

function reply(target: MailReplyTarget): void {
  replyTarget.value = target
  composerVisible.value = true
}

onMounted(() => {
  void mail.refreshList()
})

/** KeepAlive 换页回来再拉一次（inFlight 挡住与首次挂载的重复） */
onActivated(() => {
  void mail.refreshList()
})

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
    <MailSidebar @accounts="accountVisible = true" @compose="openComposer" />

    <!-- 两栏之间的分隔条：与 AI / 知识库页同一条缝 -->
    <PanelResizer
      :width="settings.themeConfig.mailListWidth"
      body-class="is-resizing-mail-list"
      @move="width => settings.setThemeWidth('mailListWidth', width)"
      @end="() => void settings.commitThemeWidth('mailListWidth')"
    />

    <MailReaderPane @accounts="accountVisible = true" @reply="reply" />

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
</style>
