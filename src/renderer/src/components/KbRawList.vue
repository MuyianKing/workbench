<script setup lang="ts">
/**
 * 原始数据清单（左栏「原始数据」签）：data/raw 下的文件与各自的入库状态。
 *
 * 状态的口径在 shared/kb.ts（source 配对 + mtime 比较），这里只把结果摆出来：
 * 按状态筛（带计数）、一眼看出哪些等着整理。待处理不为零时底部给一条通往
 * 「复制整理指令」的近路 —— 整理本身仍是 Agent 的事，应用只递话。
 */
import { computed, ref } from 'vue'
import { Tickets } from '@element-plus/icons-vue'
import { formatTimestamp } from '@/format'
import type { KbRawItem, KbRawStatus } from '@shared/kb'

const props = defineProps<{
  items: KbRawItem[]
}>()

const emit = defineEmits<{ 'copy-instruction': [] }>()

type Filter = 'all' | KbRawStatus

const FILTER_LABELS: Record<Filter, string> = {
  all: '全部',
  pending: '未入库',
  stale: '有更新',
  synced: '已入库'
}

const filter = ref<Filter>('all')

const counts = computed<Record<Filter, number>>(() => ({
  all: props.items.length,
  pending: props.items.filter((item) => item.status === 'pending').length,
  stale: props.items.filter((item) => item.status === 'stale').length,
  synced: props.items.filter((item) => item.status === 'synced').length
}))

const filtered = computed(() =>
  filter.value === 'all' ? props.items : props.items.filter((item) => item.status === filter.value)
)

/** 待处理（未入库 + 有更新）：底部那条近路只在有活儿时出现 */
const actionable = computed(() => counts.value.pending + counts.value.stale)

/** 状态词：未入库 / 有更新要催，已入库灰下去 */
const STATUS_TEXT: Record<KbRawStatus, string> = {
  pending: '未入库',
  stale: '有更新',
  synced: '已入库'
}
</script>

<template>
  <div class="kb-raw">
    <div class="kb-raw__filters">
      <button
        v-for="(label, key) in FILTER_LABELS"
        :key="key"
        type="button"
        class="chip"
        :class="{ 'is-active': filter === key }"
        @click="filter = key"
      >
        {{ label }}
        <span class="chip__count">{{ counts[key] }}</span>
      </button>
    </div>

    <div v-if="!items.length" class="kb-raw__empty">
      <p>data/raw 里还没有原始资料。把要整理的文件放进去，点一次刷新就能看到。</p>
    </div>
    <div v-else-if="!filtered.length" class="kb-raw__empty">
      <p>没有「{{ FILTER_LABELS[filter] }}」的原始数据。</p>
    </div>

    <ul v-else class="kb-raw__list">
      <li v-for="item in filtered" :key="item.rel" class="kb-raw__item" :title="item.rel">
        <span class="kb-raw__head">
          <span class="kb-raw__name">{{ item.name }}</span>
          <span v-if="item.ext" class="kb-raw__ext">{{ item.ext }}</span>
        </span>
        <span class="kb-raw__meta">
          <span class="kb-raw__status" :class="`is-${item.status}`">{{ STATUS_TEXT[item.status] }}</span>
          <span v-if="item.entryRels.length" class="kb-raw__entries" :title="item.entryRels.join('\n')">
            {{ item.entryRels.length }} 个条目
          </span>
          <span class="kb-raw__time">{{ formatTimestamp(item.mtimeMs) }}</span>
        </span>
      </li>
    </ul>

    <!-- 待处理的近路：递话给 Agent，不替它干活 -->
    <div v-if="actionable > 0" class="kb-raw__todo">
      <span>有 {{ actionable }} 个文件等着整理</span>
      <el-button size="small" :icon="Tickets" @click="emit('copy-instruction')">复制整理指令</el-button>
    </div>
  </div>
</template>

<style scoped>
.kb-raw {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
}

.kb-raw__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.kb-raw__empty {
  padding: var(--sp-4) var(--sp-2);
  text-align: center;
}

.kb-raw__empty p {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.kb-raw__list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.kb-raw__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
}

.kb-raw__item:hover {
  background: var(--bg-inset);
}

.kb-raw__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.kb-raw__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-body);
}

.kb-raw__ext {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
}

.kb-raw__meta {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

/* 彩色在这个界面只表达运行状态，所以入库状态用灰度说话：要催的浓、已完成的淡 */
.kb-raw__status {
  flex-shrink: 0;
  color: var(--ink);
  font-size: var(--fs-micro);
}

.kb-raw__status.is-synced {
  color: var(--ink-3);
}

.kb-raw__entries {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kb-raw__time {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
}

.kb-raw__todo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}
</style>
