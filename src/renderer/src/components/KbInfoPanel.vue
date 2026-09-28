<script setup lang="ts">
/**
 * 知识库概览（右栏的默认内容）：统计、标签分布、索引状态与仓库归属。
 *
 * 全是父层算好的数字（props 只读），这里负责把它们说成人话 —— 特别是两件要提醒的事：
 * 索引与实际条目数对不上（该重建索引了）、仓库没连远端（同步按钮不会出现的原因）。
 */
import { computed } from 'vue'
import type { KbIndexInfo, KbStats } from '@shared/kb'

const props = defineProps<{
  stats: KbStats
  tagCounts: Array<{ tag: string; count: number }>
  /** index.json 解出来的两样；null = 索引还没生成（或认不出） */
  indexInfo: KbIndexInfo | null
  /** 知识库文件夹在不在 git 仓库里 */
  isRepo: boolean
  /** origin 地址；空串 = 没连远端 */
  repoOrigin: string
}>()

/** 概览只放前几个标签，再多就是另一页的事了 */
const TAG_LIMIT = 8
const topTags = computed(() => props.tagCounts.slice(0, TAG_LIMIT))

/** 索引与实际条目数对不上：该重建了（null 不算对不上，那是「还没生成」的另一句话） */
const indexMismatch = computed(
  () => props.indexInfo !== null && props.indexInfo.count !== props.stats.entries
)

const repoText = computed(() => {
  if (!props.isRepo) return '不在 git 仓库里：没有版本记录，也没法在这里同步'
  if (!props.repoOrigin) return '在 git 仓库里，但还没连远端：版本只留本机'
  return `已连远端：${props.repoOrigin}`
})
</script>

<template>
  <div class="kb-info">
    <div class="kb-info__scroll">
      <section class="kb-info__block">
        <h3 class="kb-info__title">概览</h3>
        <dl class="kb-info__facts">
          <div class="kb-info__fact">
            <dt>条目</dt>
            <dd>
              {{ stats.entries }}<template v-if="stats.drafts > 0">（草稿 {{ stats.drafts }}）</template>
            </dd>
          </div>
          <div class="kb-info__fact">
            <dt>原始数据</dt>
            <dd>
              {{ stats.raws }}<template v-if="stats.pending + stats.stale > 0">
                （未入库 {{ stats.pending }} · 有更新 {{ stats.stale }}）</template>
            </dd>
          </div>
        </dl>
      </section>

      <section v-if="topTags.length" class="kb-info__block">
        <h3 class="kb-info__title">标签</h3>
        <div class="kb-info__tags">
          <span v-for="item in topTags" :key="item.tag" class="kb-info__tag">
            {{ item.tag }}<span class="kb-info__tag-count">{{ item.count }}</span>
          </span>
        </div>
      </section>

      <section class="kb-info__block">
        <h3 class="kb-info__title">索引</h3>
        <p v-if="!indexInfo" class="kb-info__note">
          还没有生成索引：在知识库目录运行 <span class="mono">py scripts/build_index.py</span>
          （目录与机器索引由那个仓库自己的脚本维护）。
        </p>
        <template v-else>
          <p class="kb-info__note">
            生成于 {{ indexInfo.generatedAt }}，收录 {{ indexInfo.count }} 条。
          </p>
          <p v-if="indexMismatch" class="kb-info__warn">
            实际扫到 {{ stats.entries }} 条，与索引对不上 —— 索引待重建：在知识库目录运行
            <span class="mono">py scripts/build_index.py</span>。
          </p>
        </template>
      </section>

      <section class="kb-info__block">
        <h3 class="kb-info__title">仓库</h3>
        <p class="kb-info__note" :class="{ 'kb-info__warn': !isRepo || !repoOrigin }">
          {{ repoText }}
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.kb-info {
  min-height: 0;
  height: 100%;
}

.kb-info__scroll {
  height: 100%;
  overflow-y: auto;
  padding: var(--sp-3);
}

.kb-info__block + .kb-info__block {
  margin-top: var(--sp-4);
}

.kb-info__title {
  margin: 0 0 var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  font-weight: 600;
}

/* 事实清单：与首页那套 .facts 同一种「名 + 值」的读法，但这是本组件私有的摆法 */
.kb-info__facts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0;
}

.kb-info__fact {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

.kb-info__fact dt {
  flex-shrink: 0;
  min-width: 64px;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.kb-info__fact dd {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-body);
}

.kb-info__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.kb-info__tag {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 8px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 22px;
}

.kb-info__tag-count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kb-info__note {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.7;
  word-break: break-all;
}

.kb-info__warn {
  color: var(--ink);
}

.kb-info__warn .mono {
  color: var(--ink-2);
}
</style>
