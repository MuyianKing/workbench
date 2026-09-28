<script setup lang="ts">
/**
 * 知识库条目清单（左栏「条目」签）：搜索 + 列表，点开一条进右栏阅读。
 *
 * 只负责展示与「点开它」：清单是父层扫出来传进来的（props 只读），这里留的只有
 * 搜索框这一个界面状态 —— 换文件夹、重扫都由父层与 store 管。
 */
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import type { KbEntryMeta } from '@shared/kb'

const props = defineProps<{
  entries: KbEntryMeta[]
  /** 当前打开的条目（kb 相对路径）；空串 = 还没打开（右栏是概览） */
  activeRel: string
}>()

const emit = defineEmits<{ select: [rel: string] }>()

const searchText = ref('')

/** 标题 / 标签 / 摘要 / 路径，哪儿沾边算哪儿（大小写不敏感） */
const filtered = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return props.entries
  return props.entries.filter((entry) =>
    [entry.title, entry.summary, entry.rel, entry.tags.join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(keyword)
  )
})

/** 仓库自己的口径：draft / reviewed 有中文名，别的值照原样显示 */
function statusText(status: string): string {
  if (status === 'draft') return '草稿'
  if (status === 'reviewed') return '已核对'
  return status
}

/** 副标题那一行：摘要有就摘，没有给路径 */
function subtitleOf(entry: KbEntryMeta): string {
  return entry.summary || entry.rel
}
</script>

<template>
  <div class="kb-entries">
    <el-input
      v-model="searchText"
      :prefix-icon="Search"
      placeholder="搜标题、标签、摘要"
      clearable
      size="small"
    />

    <!-- 两种空态分开说：库里还没有条目，和搜出来的没有 -->
    <div v-if="!entries.length" class="kb-entries__empty">
      <p>kb 里还没有条目。把原始资料整理进 kb 后，这里就是全库目录。</p>
    </div>
    <div v-else-if="!filtered.length" class="kb-entries__empty">
      <p>没有匹配「{{ searchText }}」的条目。</p>
    </div>

    <ul v-else class="kb-entries__list">
      <li v-for="entry in filtered" :key="entry.rel">
        <button
          type="button"
          class="kb-entries__item"
          :class="{ 'is-active': entry.rel === activeRel }"
          :title="entry.rel"
          @click="emit('select', entry.rel)"
        >
          <span class="kb-entries__head">
            <span class="kb-entries__title">{{ entry.title }}</span>
            <span v-if="entry.status" class="kb-entries__status">{{ statusText(entry.status) }}</span>
          </span>
          <span class="kb-entries__sub">{{ subtitleOf(entry) }}</span>
          <span v-if="entry.tags.length" class="kb-entries__tags">
            <span v-for="tag in entry.tags" :key="tag" class="kb-entries__tag">{{ tag }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.kb-entries {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
}

.kb-entries__empty {
  padding: var(--sp-4) var(--sp-2);
  text-align: center;
}

.kb-entries__empty p {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.kb-entries__list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.kb-entries__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.kb-entries__item:hover {
  background: var(--bg-inset);
}

.kb-entries__item.is-active {
  background: var(--bg-inset);
  box-shadow: inset 2px 0 0 var(--ink);
}

.kb-entries__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.kb-entries__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
}

.kb-entries__status {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kb-entries__sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.kb-entries__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.kb-entries__tag {
  padding: 0 6px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 18px;
}
</style>
