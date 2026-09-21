<script setup lang="ts">
/**
 * 样式页：74 套设计语言（DESIGN.md 的解析结果）的一页浏览。
 *
 * 三件东西决定这一页的形状：
 *
 * 1. **数据是随包静态资源**，不是通道也不是用户数据（见 stores/styles.ts）。页面第一次打开时读一次，
 *    之前不占启动时间、之后也不再读。
 * 2. **不用截图缩略图**：上游那套预览页本身是英文的，与「界面全中文」冲突。卡片与详情全部用它自己的
 *    token 现画 —— 这也是「原版 / 生成」那套预览来源筛选自然消失的原因：只有一种画法了。
 * 3. **筛选分两层**：明暗是三档互斥的刻度，用分段控件摆在工具带上；分类与色系是并列的多档，
 *    用带计数的标签铺在下面一行。两条都由数据现算，所以不会有点了没结果的空档。
 */
import { computed, onMounted, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import {
  SORT_LABELS,
  THEME_LABELS,
  type DesignStyle,
  type DesignStyleSort,
  type FamilyFilter,
  type ThemeFilter
} from '@shared/design-styles'
import StyleCard from '@/components/StyleCard.vue'
import StyleDetailDialog from '@/components/StyleDetailDialog.vue'
import { useStylesStore } from '@/stores/styles'

const store = useStylesStore()

/** 弹窗里那一套；点卡片时赋值，弹窗自己按 open 显隐 */
const detail = ref<DesignStyle | null>(null)
const detailOpen = ref(false)

onMounted(() => {
  void store.init()
})

const themeOptions = [
  { label: '全部', value: 'all' as const },
  { label: THEME_LABELS.light, value: 'light' as const },
  { label: THEME_LABELS.dark, value: 'dark' as const }
]

/** 分段控件的双向绑定走 setter，筛选条件本身存在 store 里 */
const themeValue = computed<ThemeFilter>({
  get: () => store.theme,
  set: (value) => store.setTheme(value)
})

const sortOptions = Object.entries(SORT_LABELS) as Array<[DesignStyleSort, string]>

/** 分类与色系的候选都来自数据，第一项是「全部」 */
const categoryChips = computed(() => [
  { key: 'all', label: '全部', count: store.styles.length },
  ...store.categories.map((entry) => ({ key: entry.category, label: entry.category, count: entry.count }))
])

const familyChips = computed<Array<{ key: FamilyFilter; label: string; count: number }>>(() => [
  { key: 'all', label: '全部', count: store.styles.length },
  ...store.families.map((entry) => ({ key: entry.family, label: entry.family, count: entry.count }))
])

function applySort(command: unknown): void {
  if (command === 'az' || command === 'hue' || command === 'dark') store.setSort(command)
}

function openDetail(style: DesignStyle): void {
  detail.value = style
  detailOpen.value = true
}

/** 读不出来（理论上不会）：面板自己说一句并给一次重试，不弹 toast */
const failed = computed(() => !store.loaded && !store.loading && Boolean(store.loadError))
</script>

<template>
  <main class="styles-view">
    <!-- 工具带：与项目页 / 技能页那条同款（底色由 global.css 按顶部样式给） -->
    <div class="filter">
      <div class="filter__head">
        <div class="head">
          <h2 class="head__title">样式</h2>
          <span class="head__count mono">{{ store.summary }}</span>
        </div>
      </div>
      <div class="filter__tools">
        <el-segmented v-model="themeValue" :options="themeOptions" aria-label="明暗基调" />
        <el-dropdown trigger="click" @command="applySort">
          <button class="sort" type="button">
            <span class="sort__label">排序</span>
            <span class="sort__value">{{ SORT_LABELS[store.sort] }}</span>
            <span class="sort__caret">▾</span>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="[value, label] in sortOptions" :key="value" :command="value">
                {{ label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-input
          v-model="store.query"
          class="styles__search"
          size="small"
          clearable
          spellcheck="false"
          placeholder="搜索品牌、色值、字体或描述"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
    </div>

    <!-- 分类与色系：并列的多档，各自带计数。一条横向可滚，窄窗口下不挤成一团 -->
    <div class="chipbar">
      <span class="eyebrow">分类</span>
      <button
        v-for="chip in categoryChips"
        :key="chip.key"
        class="chip"
        :class="{ 'is-active': store.category === chip.key }"
        type="button"
        @click="store.setCategory(chip.key)"
      >
        {{ chip.label }}<span class="chip__count mono">{{ chip.count }}</span>
      </button>

      <span class="eyebrow chipbar__gap">色系</span>
      <button
        v-for="chip in familyChips"
        :key="chip.key"
        class="chip"
        :class="{ 'is-active': store.family === chip.key }"
        type="button"
        @click="store.setFamily(chip.key)"
      >
        {{ chip.label }}<span class="chip__count mono">{{ chip.count }}</span>
      </button>
    </div>

    <div class="styles-view__scroll">
      <div v-if="store.loading && !store.loaded" class="empty">
        <p>正在读取样式清单…</p>
      </div>

      <div v-else-if="failed" class="empty">
        <p>读不出样式清单</p>
        <p class="empty__hint">这份清单随包带着（public/design-styles.json），正常情况下不会读不到。</p>
        <el-button size="small" @click="store.init()">重试</el-button>
      </div>

      <div v-else-if="!store.visible.length" class="empty">
        <p>{{ store.filtering ? '没有匹配的样式' : '还没有样式数据' }}</p>
        <p v-if="store.filtering" class="empty__hint">换个关键词，或者把筛选条件清掉。</p>
        <el-button v-if="store.filtering" size="small" @click="store.resetFilters()">清除筛选条件</el-button>
      </div>

      <div v-else class="grid">
        <StyleCard v-for="style in store.visible" :key="style.brand" :design="style" @open="openDetail(style)" />
      </div>
    </div>

    <StyleDetailDialog v-model:open="detailOpen" :design="detail" />
  </main>
</template>

<style scoped>
.styles-view {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--card-gap, 10px);
}

.head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  min-width: 0;
}

.head__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.head__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 搜索框与密码页那颗同一口径（28px 高、--r-sm、surface 底） */
.styles__search {
  width: 240px;
}

.styles__search :deep(.el-input__wrapper) {
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--bg-surface);
  box-shadow: inset 0 0 0 1px var(--border);
}

.styles__search :deep(.el-input__wrapper:hover) {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.styles__search :deep(.el-input__inner) {
  font-size: var(--fs-meta);
}

/*
 * 分类与色系那一行。横向可滚：两组合起来最多二十来个标签，
 * 窄窗口下宁可让它滚，也不要折成两行把下面的卡片挤走。
 */
.chipbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-5);
  overflow-x: auto;
  scrollbar-width: thin;
}

.chipbar > * {
  flex-shrink: 0;
}

/* 第二组与第一组之间留一段，比标签之间的间距大一档 */
.chipbar__gap {
  margin-left: var(--sp-4);
}

.styles-view__scroll {
  min-height: 0;
  overflow-y: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  gap: var(--card-gap, 14px);
  align-content: start;
}
</style>
