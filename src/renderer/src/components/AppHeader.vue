<script setup lang="ts">
/**
 * 顶栏：全局聚合搜索 + 右上三颗工具按钮。
 *
 * 搜索框留在原地，但身份变了：它不再只筛某一页的列表，而是「按来源把结果汇总到一个面板里」
 * （今天只有项目一个来源，见 shared/search.ts）。点一条结果 = 切到项目页 + 筛出这个词
 * + 给那张卡打一圈定位环，所以搜索框的关键词与项目页的筛选是同一个值。
 *
 * 布局编辑态下这一行的搜索位换成操作条（LayoutEditBar）：同样是固定高度的一行，
 * 进出编辑态画布不会上下跳，而那颗「编辑布局」按钮本来就在这一行的右端。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Grid, Moon, Search, Setting, Sunny, User } from '@element-plus/icons-vue'
import { accountLabel } from '@shared/auth'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import SettingsDialog from '@/components/SettingsDialog.vue'
import AccountDialog from '@/components/AccountDialog.vue'
import LayoutEditBar from '@/components/LayoutEditBar.vue'
import SearchResults from '@/components/SearchResults.vue'

const store = useProjectsStore()
const settings = useSettingsStore()
const auth = useAuthStore()
const searchInput = ref<HTMLInputElement | null>(null)
const settingsVisible = ref(false)
const accountVisible = ref(false)
/** 输入框是否有焦点；有焦点且有关键词时结果面板才出现 */
const focused = ref(false)
/** 键盘停在扁平列表的第几条 */
const activeIndex = ref(0)

/** 已登录时顶栏显示头像，未登录显示一个通用的账号图标 */
const account = computed(() => auth.status?.account ?? null)

/** 跨分组的扁平序号：上下键在整份结果里走，不按分组停 */
const flatHits = computed(() => store.searchGroups.flatMap((group) => group.hits))

/** 面板出现的条件：有焦点 + 有关键词。没命中也弹 —— 得让用户看见「没有匹配」 */
const panelOpen = computed(() => focused.value && store.keyword.trim().length > 0)

// 关键词一改，原来选中的那条就不作数了，回到第一条
watch(
  () => store.keyword,
  () => {
    activeIndex.value = 0
  }
)

/** 「编辑布局」只对首页画布有意义 */
const showLayoutButton = computed(() => store.activeView === 'home' && !store.layoutEditing)

/** 直接进首页布局编辑态 */
function enterLayoutEdit(): void {
  store.setLayoutEditing(true)
}

function focusSearch(): void {
  // 编辑态下搜索框不在（那一行被操作条接管了），不去抢焦点
  if (store.layoutEditing) return
  searchInput.value?.focus()
}

function clearKeyword(): void {
  store.keyword = ''
  searchInput.value?.focus()
}

/** 收起面板但不丢关键词：跳走之后项目页的筛选状态就是它 */
function closePanel(): void {
  focused.value = false
  searchInput.value?.blur()
}

function openHit(index: number): void {
  const hit = flatHits.value[index]
  if (!hit) return

  closePanel()
  store.jumpToProject(hit.id)
}

function onKeydown(event: KeyboardEvent): void {
  if (!panelOpen.value) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, flatHits.value.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    openHit(activeIndex.value)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
  }
}

/** 当前是不是暗色：图标画的是「点下去会切到哪一边」，所以亮色时显示月亮 */
const isDark = computed(() => settings.effectiveTheme === 'dark')

/** 传点击坐标，明暗过渡就从这颗图标扩散开（与设置里的主题按钮同一套动效） */
function toggleTheme(event: MouseEvent): void {
  void settings.toggleTheme({ x: event.clientX, y: event.clientY })
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    focusSearch()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <header class="header">
    <LayoutEditBar v-if="store.layoutEditing" />

    <label v-else class="search" :class="{ 'is-focus': focused }">
      <el-icon class="search__icon"><Search /></el-icon>
      <input
        ref="searchInput"
        v-model="store.keyword"
        class="search__field"
        type="text"
        placeholder="搜索项目名或路径"
        spellcheck="false"
        @focus="focused = true"
        @blur="focused = false"
        @keydown="onKeydown"
      />
      <button
        v-if="store.keyword"
        class="search__clear"
        type="button"
        title="清除关键词"
        aria-label="清除关键词"
        @click.prevent="clearKeyword"
      >
        ✕
      </button>
      <kbd v-else class="search__hint mono">Ctrl K</kbd>
    </label>

    <!-- 面板挂在顶栏内部：顶栏是「整块只画一次玻璃」的容器，从外面插进来的浮层会破坏那个整块性 -->
    <SearchResults
      v-if="panelOpen"
      :groups="store.searchGroups"
      :keyword="store.keyword"
      :active-index="activeIndex"
      @select="openHit(flatHits.findIndex((hit) => hit.id === $event))"
    />

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
  /* 结果面板以它为定位参照 */
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  /* 搜索位里是不换行的长内容（布局编辑那行提示语）：不限住的话窗口一窄它就撑宽整条顶栏，
     把右侧那几颗按钮推出窗外 —— 这一行自己能被压窄，压窄后由提示语自己去省略 */
  min-width: 0;
  padding: 0 var(--sp-5);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}

/* ---------- 搜索 ---------- */
.search {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1;
  max-width: 420px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.search:focus-within {
  background: var(--bg-surface);
  border-color: var(--border-strong);
}

.search__icon {
  color: var(--ink-3);
  font-size: 14px;
}

.search__field {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--fs-body);
  color: var(--ink);
}

.search__field::placeholder {
  color: var(--ink-3);
}

.search__hint {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--bg-surface);
}

/* 清除关键词：有关键词时占住 Ctrl K 提示的位置 */
.search__clear {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}

.search__clear:hover {
  background: var(--border-strong);
  color: var(--ink);
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
