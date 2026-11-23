<script setup lang="ts">
import { Expand, Fold, Grid, List, Moon, Setting, Sunny, User } from '@element-plus/icons-vue'
import { accountLabel } from '@workbench/auth'
/**
 * 顶栏：欢迎语 + 右上几颗工具按钮。
 *
 * 这一行的位置原来归全局搜索（输入框 + 结果面板）；搜索移除后由首页的欢迎语顶上，
 * 见 HomeGreeting。布局编辑态下整行换成操作条（LayoutEditBar）：同样是固定高度的一行，
 * 进出编辑态画布不会上下跳，而那颗「编辑布局」按钮本来就在这一行的右端。
 *
 * 最左边那颗是「隐藏 / 显示菜单」（折叠左侧导航栏），禅道那颗紧跟在它右边：
 * 禅道在应用里没有页签，那颗图标用系统浏览器打开禅道站点，入口就放在这一排里（见 docs/modules/zentao.md）。
 */
import { computed, ref } from 'vue'
import AccountDialog from '@/components/AccountDialog.vue'
import HomeGreeting from '@/components/HomeGreeting.vue'
import LayoutEditBar from '@/components/LayoutEditBar.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import UnreadBadge from '@/components/UnreadBadge.vue'
import { notifyError } from '@/notify'
import { useAuthStore } from '@/stores/auth'
import { useNavStore } from '@/stores/nav'
import { useSettingsStore } from '@/stores/settings'
import { useZentaoStore } from '@/stores/zentao'

const store = useNavStore()
const settings = useSettingsStore()
const auth = useAuthStore()
const zentao = useZentaoStore()
const settingsVisible = computed({
  get: () => settings.settingsDialogVisible,
  set: (value: boolean) => {
    if (value)
      settings.openSettingsDialog()
    else settings.closeSettingsDialog()
  },
})
const accountVisible = ref(false)

/** 已登录时顶栏显示头像，未登录显示一个通用的账号图标 */
const account = computed(() => auth.status?.account ?? null)

/** 「编辑布局」只对首页画布有意义 */
const showLayoutButton = computed(() => store.activeView === 'home' && !store.layoutEditing)

/** 直接进首页布局编辑态 */
function enterLayoutEdit(): void {
  store.setLayoutEditing(true)
}

/** 当前是不是暗色：图标画的是「点下去会切到哪一边」，所以亮色时显示月亮 */
const isDark = computed(() => settings.effectiveTheme === 'dark')

/** 传点击坐标，明暗过渡就从这颗图标扩散开（与设置里的主题按钮同一套动效） */
function toggleTheme(event: MouseEvent): void {
  void settings.toggleTheme({ x: event.clientX, y: event.clientY })
}

/** 左侧导航栏收起了吗：图标画的是「点下去会切到哪一边」，展开时画收起的那支 */
const navHidden = computed(() => settings.settings.navHidden)

/** 收起 / 展开左侧导航栏：状态落在外观设置里（theme.json），重启后保持 */
function toggleNav(): void {
  void settings.setNavVisible(navHidden.value)
}

/**
 * 用系统浏览器打开禅道：地址由 Rust 从内嵌配置读取，这里只管叫一声，
 * 失败了给一句提示。这条路是禅道唯一的入口 —— 应用里没有禅道页签。
 */
const zentaoOpening = ref(false)
async function openZentao(): Promise<void> {
  if (zentaoOpening.value)
    return
  zentaoOpening.value = true
  try {
    const message = await zentao.open()
    if (message)
      notifyError(message)
  }
  finally {
    // 打开失败不该把按钮永远留在禁用态（open() 走的是 Result，不会 reject，这是兜底）
    zentaoOpening.value = false
  }
}

/** 角标很小，悬停提示里说清它是什么（未读数是「后台发现、还没点开禅道」的那批） */
const zentaoTitle = computed(() =>
  zentao.unread > 0 ? `打开禅道 · ${zentao.unread} 个未读` : '打开禅道',
)
</script>

<template>
  <header class="header">
    <LayoutEditBar v-if="store.layoutEditing" />

    <HomeGreeting v-else />

    <div class="actions">
      <el-button
        class="icon-btn"
        :icon="navHidden ? Expand : Fold"
        :title="navHidden ? '显示菜单' : '隐藏菜单'"
        :aria-label="navHidden ? '显示菜单' : '隐藏菜单'"
        @click="toggleNav"
      />

      <!-- 禅道：交给系统浏览器打开，见 docs/modules/zentao.md —— 与上面那颗折叠按钮同一排。
           内嵌凭据没配齐时整颗都不出现（打开必然失败）；角标是「后台发现、还没点开禅道」的 Bug 数（点开即清零） -->
      <span v-if="zentao.configured" class="badge-host">
        <el-button
          class="icon-btn"
          :icon="List"
          :title="zentaoTitle"
          :aria-label="zentaoTitle"
          :disabled="zentaoOpening"
          @click="openZentao"
        />
        <UnreadBadge :count="zentao.unread" />
      </span>

      <el-button
        v-if="showLayoutButton"
        class="icon-btn"
        :icon="Grid"
        title="编辑布局"
        aria-label="编辑布局"
        @click="enterLayoutEdit"
      />

      <el-button
        class="icon-btn"
        :icon="isDark ? Sunny : Moon"
        :title="isDark ? '切换到亮色' : '切换到暗色'"
        :aria-label="isDark ? '切换到亮色' : '切换到暗色'"
        @click="toggleTheme"
      />

      <el-button
        class="icon-btn"
        :icon="Setting"
        title="系统配置"
        aria-label="系统配置"
        @click="settingsVisible = true"
      />

      <el-button
        v-if="!account"
        class="icon-btn"
        :icon="User"
        title="账号"
        aria-label="账号"
        @click="accountVisible = true"
      />

      <!-- 已登录：把头像本身当按钮，比图标更能说明「现在是谁」 -->
      <button
        v-else
        type="button"
        class="avatar-btn"
        :title="`账号 · ${accountLabel(account)}`"
        :aria-label="`账号 · ${accountLabel(account)}`"
        @click="accountVisible = true"
      >
        <el-avatar :size="24" :src="account.avatar ?? undefined" class="avatar-btn__img">
          <el-icon><User /></el-icon>
        </el-avatar>
      </button>
    </div>

    <SettingsDialog />
    <AccountDialog v-model="accountVisible" />
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  /* 这一行的内容（欢迎语 / 布局编辑那条提示语）都可能不换行地很长：不限住的话窗口一窄
     它就撑宽整条顶栏，把右侧那几颗按钮推出窗外 —— 这一行自己能被压窄，压窄后由内容去省略 */
  min-width: 0;
  padding: 0 var(--sp-5);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}

/* ---------- 右侧操作 ---------- */
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: auto;
  flex-shrink: 0;
}

.icon-btn {
  width: 32px;
  padding: 0;
}

/* 顶栏那些带角标的按钮：角标以这一层为定位基准 */
.badge-host {
  position: relative;
  display: inline-flex;
}

/* 头像按钮：高度与 .icon-btn 对齐，宽度由头像自己撑开 */
.avatar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--r-pill);
}

.avatar-btn__img {
  background: var(--bg-subtle);
  color: var(--ink-3);
}

.avatar-btn:focus-visible {
  outline: 2px solid var(--st-run);
  outline-offset: 1px;
}
</style>
