<script setup lang="ts">
/**
 * 设置弹窗的外壳：左侧菜单 + 右侧内容区。
 *
 * 四屏各自成片（components/settings/ 下）：外观（看起来什么样：主题、背景、顶部样式
 * 与首页画布的布局）、菜单（左侧导航栏上留哪几页）、通用（程序、快捷键、启动、
 * 天气、笔记、账号与同步）、关于（这个应用是什么、数据住在哪、什么时候才会联网）。
 * 选中项不随关闭重置，下次打开还停在上一屏，省得每次都要再点一次。
 *
 * 这一壳只管三件事：弹窗骨架与菜单、每屏的显隐（v-show —— 各屏各滚、滚动位置
 * 与切屏前的输入都留在原地）、以及「打开时压一次内置壁纸的缩略图」。
 * 各屏的取数时机（设备列表、版本号）由 pane 自己盯 open / active。
 */
import { computed, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import AppDialog from '@/components/AppDialog.vue'
import AppearancePane from './settings/AppearancePane.vue'
import MenuPane from './settings/MenuPane.vue'
import GeneralPane from './settings/GeneralPane.vue'
import AboutPane from './settings/AboutPane.vue'

/** 弹层开关:v-model 一条口径(与 AppDialog / el-dialog 相同,全应用的弹层都这么开) */
const open = defineModel<boolean>({ required: true })

const settings = useSettingsStore()

const visible = computed({
  get: () => open.value,
  set: (value: boolean) => {
    open.value = value
  }
})

type SettingsTab = 'appearance' | 'menu' | 'general' | 'about'

const tabs: Array<{ value: SettingsTab; label: string }> = [
  { value: 'appearance', label: '外观' },
  { value: 'menu', label: '菜单' },
  { value: 'general', label: '通用' },
  { value: 'about', label: '关于' }
]

const activeTab = ref<SettingsTab>('appearance')

// 内置壁纸的缩略图要现压，按需在第一次打开面板时取（见 store 的 ensureWallpapers）
watch(visible, (open) => {
  if (open) void settings.ensureWallpapers()
})
</script>

<template>
  <!--
    class / body-class：两栏骨架与固定高度都在 global.css 里（见 .el-dialog.settings-dialog）。
    没有 footer：这里的设置都是改完即生效的，留一个「完成」按钮只是关窗用，不如省掉那一条 ——
    关窗走右上角的 ×、Esc 或点遮罩，三条都是 EP 自带的（所以这里要挡住背后、也不传 penetrable：
    「点遮罩关掉」是这一屏的主要关闭方式）。
  -->
  <AppDialog
    v-model="visible"
    class="settings-dialog"
    title="设置"
    width="920"
    align-center
    body-class="settings-body"
  >
    <div class="settings">
      <!-- 左侧菜单：点哪项右侧就换成哪一屏 -->
      <nav class="settings__nav">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          class="nav-item"
          type="button"
          :class="{ 'is-active': activeTab === tab.value }"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </nav>

      <!-- 内容区只是过道；每个 pane 自己滚，切屏时各留各的位置 -->
      <div class="settings__body">
        <AppearancePane v-show="activeTab === 'appearance'" :open="visible" :active="activeTab === 'appearance'" />
        <MenuPane v-show="activeTab === 'menu'" />
        <GeneralPane v-show="activeTab === 'general'" :open="visible" />
        <AboutPane v-show="activeTab === 'about'" :open="visible" :active="activeTab === 'about'" />
      </div>
    </div>
  </AppDialog>
</template>

<style scoped>
/**
 * 两栏骨架：左侧菜单定宽、不滚动，右侧内容自己滚。
 * 正文是 flex 容器（见 global.css 的 .el-dialog__body.settings-body），这里撑满它，
 * 两栏就都拿到了确定的高度 —— 右侧内容区能滚、左侧菜单也不会漏出弹窗。
 */
.settings {
  display: flex;
  flex: 1;
  min-width: 0;
  /*
   * 弹窗里所有 small 控件统一 28px 高。global.css 把 small 按钮定成 28px，而 EP 的输入框 /
   * 数字框 / 取色器走自己的 --el-component-size-small（24px），不改就会同列一个高一个矮
   * （间距那一行：数字框 24 挨着别的按钮 28，一眼看出错位）。只影响输入类控件，开关与单选不受影响。
   */
  --el-component-size-small: 28px;
}

.settings__nav {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 148px;
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  border-right: 1px solid var(--border);
}

/**
 * 菜单项：一块能点中的文字，选中时落一层灰底（界面主体灰度，彩色只留给运行状态）。
 * button 只继承到 font-family，字号得自己给，否则会退回浏览器默认的 13.33px。
 */
.nav-item {
  padding: 7px 10px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-body);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

.nav-item.is-active {
  background: var(--bg-selected);
  color: var(--ink);
  font-weight: 600;
}

/* 内容区只是个过道：自己不留内边距、也不滚，两件事都下放给每一屏（见 .pane） */
.settings__body {
  display: flex;
  flex: 1;
  min-width: 0;
}

/**
 * 每一屏自己滚。
 *
 * 不能两屏共用一个滚动容器：那样滚动条长度与位置都是共享的 —— 在外观滚到底再切到通用，
 * 通用会停在它自己的底部；切回外观时位置也回不到原处（浏览器把越界的值截到新内容的上限后就不动了）。
 * 各滚各的之后，每一屏有自己的滚动区间与位置，互不干扰。
 *
 * 这条画在 pane 组件的根元素上：子组件的根会带上本组件的 scope，scoped 样式够得着；
 * pane 内部的元素则够不着，四屏共用的行 / 块骨架因此在下面用 :deep 下穿。
 */
.pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow-y: auto;
  /* 两屏各自成列，间距与原来「每个块之间 20px」保持一致 */
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

/* ---------- 四屏共用的骨架：块与行 ---------- */
/* 这些类只在四个 pane 里出现，样式仍归本壳管，经 :deep 进到子组件里去 */

.settings :deep(.block + .block) {
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
}

.settings :deep(.block__title) {
  margin-bottom: var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.settings :deep(.row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
}

.settings :deep(.row + .row) {
  margin-top: var(--sp-3);
}

.settings :deep(.row--stack) {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}

.settings :deep(.row__text) {
  min-width: 0;
}

.settings :deep(.row__label) {
  display: block;
  font-size: var(--fs-body);
  color: var(--ink);
}

.settings :deep(.row__hint) {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--ink-3);
}
</style>
