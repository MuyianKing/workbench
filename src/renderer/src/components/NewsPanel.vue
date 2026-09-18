<script setup lang="ts">
/**
 * 首页「AI 热点」卡片：多个热点源的合并列表，一条一行（标题 + 时间），点击跳原文。
 *
 * **这一行只放「每行都不一样」的东西**：标题与发布时间。
 * 来源名只在**同一屏里真的混着多个源**时才出现 —— 只开量子位时它十行都是同一句话，
 * 既占掉本来就不够的标题宽度，还会被挤成「量…」（第一版就是这么难看的）。
 * 页脚同理：只有一个源时不再写「1 个源」。
 *
 * **数据流**：先读本地缓存（`getAiNews`，不联网）把上次的内容摆出来，再按各源自己的
 * 节奏后台刷新（`refreshAiNews`：只有已勾选、且到了各自刷新间隔的源才真发请求）。
 * 某个源失败时**只影响它自己** —— 别的源的内容照旧显示，失败原因落在列表下面那行小字里。
 *
 * **联网边界**：这里不拼任何地址，只报源 id；源清单与地址都在 Rust 侧的 `SOURCES` 里。
 * 卡片自己不弹表单，勾选源与填 token 都在设置里（见空态引导）。
 */
import { computed, nextTick, onMounted, onActivated, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { formatListTime, formatTimestamp } from '@/format'
import NewsArticleDialog from '@/components/NewsArticleDialog.vue'
import type { AiNewsItem, AiNewsView } from '@/types'

const view = ref<AiNewsView | null>(null)
/** 首屏读盘完成前不说「还没有热点」：读盘失败与真的没内容是两回事 */
const readOnce = ref(false)
/** 手动刷新时的一句话提示（没到时间 / 部分源失败） */
const hint = ref('')
const refreshing = ref(false)

/**
 * 「现在」这个基准只用来判「这条是不是今天的」，所以每次读盘 / 刷新时取一次就够 ——
 * 不必挂定时器（与活跃度图绕开每秒时钟是同一个考虑）。
 */
const now = ref(Date.now())

async function readCache(): Promise<void> {
  const result = await window.workbench.getAiNews()
  if (result.ok && result.data) {
    view.value = result.data
    now.value = Date.now()
  }
  readOnce.value = true
}

async function refresh(manual: boolean): Promise<void> {
  refreshing.value = true
  hint.value = ''
  try {
    const result = await window.workbench.refreshAiNews()
    if (result.ok && result.data) {
      view.value = result.data.view
      now.value = Date.now()
      // 逐源的失败说明照实摆出来（哪个源挂了、为什么），不吞掉
      if (result.data.notes.length) hint.value = result.data.notes.join('；')
      else if (manual && !result.data.refreshed) hint.value = '还没到下次刷新时间'
    } else {
      hint.value = result.error ?? '刷新 AI 热点失败'
    }
  } catch (err) {
    hint.value = err instanceof Error ? err.message : '刷新 AI 热点失败'
  } finally {
    refreshing.value = false
  }
}

/**
 * 点一条 = 在应用内打开阅读层（正文由弹层自己去抓）。
 * 不再直接跳系统浏览器：读一条新闻要切出去再切回来，太麻烦了 ——
 * 浏览器留给「要看原排版 / 图片」的情况，入口在弹层里。
 */
function openArticle(row: Row): void {
  if (!row.raw.link) return
  selected.value = row.raw
  articleOpen.value = true
}

onMounted(async () => {
  await readCache()
  // 后台刷新不打扰用户：失败只在行内留一句，不弹窗
  void refresh(false)
})

/**
 * 切回首页时按策略再试一次（KeepAlive 下卡片不会重新挂载）：跨了刷新间隔、
 * 上次失败退避到期、刚在设置里勾了新源或配好 token，都可能让这次「该拉了」。
 * 首次挂载那次由 onMounted 承担，免得启动时连拉两遍。
 */
let activatedOnce = false
onActivated(() => {
  if (activatedOnce) void refresh(false)
  else activatedOnce = true
})

// ---------- 要渲染的行 ----------

interface Row {
  id: string
  title: string
  link: string
  /** 空串表示这条没有可用的发布时间（解析不出来） */
  time: string
  source: string
  /** 悬停时的全文：有摘要给摘要，没有就给标题 */
  hint: string
  /** 原始条目：站内阅读弹层要拿它显示来源 / 时间 / 导语 */
  raw: AiNewsItem
}

/**
 * 行内容在这里一次算完（含时间文案），模板里不再逐帧调函数。
 *
 * 来源名共不共用一份判据：**当前这一屏的条目是否真的来自多个源**。
 * 只按「启用了几源」判不行 —— 开了两个源但另一个这次没拉到东西时，
 * 满屏来源仍会是同一个词，又变回那种十行重复的噪音。
 */
const rows = computed<Row[]>(() =>
  (view.value?.items ?? []).map((item) => ({
    id: item.guid || item.link || item.title,
    title: item.title,
    link: item.link,
    time: formatListTime(item.pubDate, now.value),
    source: item.source,
    hint: item.summary || item.title,
    raw: item
  }))
)

/** 站内阅读：当前打开的那一条（null = 弹层关着） */
const selected = ref<AiNewsItem | null>(null)
const articleOpen = ref(false)

/** 这一屏混着几个源；≤1 就不必逐行标来源 */
const showSource = computed(() => new Set(rows.value.map((row) => row.source).filter(Boolean)).size > 1)

// ---------- 列表底部的「还有内容」渐隐 ----------

/**
 * 列表滚不到底时，末行从底部渐隐，而不是被硬切一刀（与 WorkLogCard 收起态同一种表达）。
 *
 * 为什么要判断而不是常驻一层渐隐：滚到底之后那一层会把最后一行也压暗，
 * 看着像内容被截断。所以只在「下面确实还有」时挂上。
 * 三条触发路径都要接住 —— 内容变了（拉取回来）、盒子变了（用户拖卡片高度）、滚动。
 */
const listEl = ref<HTMLElement | null>(null)
const moreBelow = ref(false)

function syncOverflow(): void {
  const el = listEl.value
  if (!el) return
  moreBelow.value = el.scrollHeight - el.scrollTop - el.clientHeight > 2
}

watch(rows, () => void nextTick(syncOverflow))

// 卡片高度是用户拖出来的：盒子尺寸一变就要重算，光靠滚动事件接不住这种情况
watch(listEl, (el, _previous, onCleanup) => {
  if (!el) return
  const observer = new ResizeObserver(() => syncOverflow())
  observer.observe(el)
  onCleanup(() => observer.disconnect())
  syncOverflow()
})

/** 页脚：只说「这批内容什么时候拿回来的」。只有一源时不再重复「1 个源」那句废话 */
const footer = computed(() => {
  const updatedAt = view.value?.updatedAt ?? 0
  return updatedAt ? `更新于 ${formatTimestamp(updatedAt)}` : '还没有更新过'
})

/**
 * 空态文案：把「为什么没有内容」说清楚 —— 一个源都没勾 / 勾了但缺 token / 正在拉。
 * 三种情况用户要做的事完全不同，混成一句「暂无数据」等于什么都没说。
 */
const emptyHint = computed(() => {
  const data = view.value
  if (!data) return '正在读取…'

  const enabled = data.sources.filter((source) => source.enabled)
  if (!enabled.length) {
    return '还没有启用任何热点源\n在设置 → 通用 → AI 热点里勾一个'
  }

  const missingToken = enabled.filter((source) => source.needsToken && !source.hasToken)
  if (missingToken.length === enabled.length) {
    return `${missingToken.map((source) => source.name).join('、')} 需要 token\n在设置 → 通用 → AI 热点里填一次`
  }

  return '正在获取热点…'
})
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">AI 热点</span>
      <span class="panel__count mono">{{ rows.length }}</span>
      <button
        class="head__refresh"
        type="button"
        title="刷新（每个源有各自的刷新间隔）"
        aria-label="刷新热点"
        :disabled="refreshing"
        @click="refresh(true)"
      >
        <el-icon :size="13"><Refresh /></el-icon>
      </button>
    </header>

    <template v-if="rows.length">
      <ul ref="listEl" class="rows panel__scroll" :class="{ 'is-more': moreBelow }" @scroll="syncOverflow">
        <li v-for="row in rows" :key="row.id">
          <button class="row" type="button" :title="row.hint" @click="openArticle(row)">
            <span class="row__text truncate">{{ row.title }}</span>
            <span class="row__meta">
              <span v-if="showSource && row.source" class="row__src truncate">{{ row.source }}</span>
              <span v-if="row.time" class="row__time mono">{{ row.time }}</span>
            </span>
          </button>
        </li>
      </ul>

      <!-- 逐源失败 / 未到时间：一行小字，不挡住已有内容，排在页脚之上 -->
      <p v-if="hint" class="panel__note truncate" :title="hint">{{ hint }}</p>

      <footer class="panel__foot">
        <span class="mono">{{ footer }}</span>
      </footer>
    </template>

    <p v-else-if="readOnce" class="panel__empty">{{ emptyHint }}</p>

    <!-- 站内阅读：点一行打开它，正文由它自己抓（见 NewsArticleDialog） -->
    <NewsArticleDialog v-model="articleOpen" :item="selected" />
  </article>
</template>

<style scoped>
/*
 * 卡片高度由外层给定，面板要跟着填满并允许收缩到内容以下，
 * 列表的内部滚动条才会出现（否则超出卡片的部分被直接裁掉）。
 */
.panel {
  flex: 1 1 auto;
  min-height: 0;
}

/* 标题行：eyebrow 吃掉剩余空间，把计数与刷新按钮一起推到最右（与 Token 用量那张同一套） */
.eyebrow {
  margin-right: auto;
}

.head__refresh {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.head__refresh:hover:not(:disabled) {
  color: var(--ink);
}

.head__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

/* ---------- 列表 ---------- */

.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 下面还有内容：末行从底部渐隐（滚到底时这个类会摘掉，最后一行就完整了） */
.rows.is-more {
  mask-image: linear-gradient(180deg, #000 calc(100% - 16px), transparent);
}

/* 一行：标题吃满剩余宽度，右侧的时间 / 来源固定不缩（与「最近使用」同一套行盒） */
.row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  width: 100%;
  min-width: 0;
  padding: 3px 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  text-align: left;
  /* 比正文默认行高紧一点：这是名单卡，一屏多放一条比多一点呼吸更值 */
  line-height: 1.45;
  cursor: pointer;
}

.row:hover {
  background: var(--bg-subtle);
}

.row__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--ink);
}

/*
 * 右侧那一列**永不收缩**：早先给了 flex-shrink:1，标题一长就把它挤成「量…」——
 * 同一屏里有的行完整、有的行截断，看着像坏了。宽窄由它自己定，标题才是让位的那一方。
 */
.row__meta {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 来源名用正文字体（中文在等宽字形里不协调），并限宽：它只是注解，不该顶掉标题 */
.row__src {
  max-width: 64px;
}

.row__time {
  /* 时间是对齐的窄列：等宽数字让上下几位数排成一条竖线 */
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ---------- 页脚与失败说明 ---------- */

/* 失败说明排在页脚之上，用最浅的一档：它不该和内容抢注意力 */
.panel__note {
  flex-shrink: 0;
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.panel__foot {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}
</style>