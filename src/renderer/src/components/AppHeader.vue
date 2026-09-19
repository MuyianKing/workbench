<script setup lang="ts">
/**
 * 顶栏：欢迎语 + 右上三颗工具按钮。
 *
 * 这一行的位置原来归全局搜索（输入框 + 结果面板）；搜索移除后由首页的欢迎语顶上，
 * 见 HomeGreeting。布局编辑态下整行换成操作条（LayoutEditBar）：同样是固定高度的一行，
 * 进出编辑态画布不会上下跳，而那颗「编辑布局」按钮本来就在这一行的右端。
 */
import { computed, ref } from 'vue'
import { Grid, Moon, Setting, Sunny, User } from '@element-plus/icons-vue'
import { accountLabel } from '@shared/auth'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import SettingsDialog from '@/components/SettingsDialog.vue'
import AccountDialog from '@/components/AccountDialog.vue'
import LayoutEditBar from '@/components/LayoutEditBar.vue'
import HomeGreeting from '@/components/HomeGreeting.vue'

const store = useProjectsStore()
const settings = useSettingsStore()
const auth = useAuthStore()
const settingsVisible = ref(false)
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
</script>

<template>
  <header class="header">
    <LayoutEditBar v-if="store.layoutEditing" />

    <HomeGreeting v-else />

    <div class="actions">
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

    <SettingsDialog v-model="settingsVisible" />
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
