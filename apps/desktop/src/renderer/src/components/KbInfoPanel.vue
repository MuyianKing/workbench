<script setup lang="ts">
import type { KbIndexInfo, KbIssue, KbStats } from '@workbench/kb'
import { KB_ISSUE_LABELS, kbIssueCounts } from '@workbench/kb'
/**
 * 知识库概览（右栏的默认内容）：统计、标签分布、索引状态、仓库归属与**巡检**。
 *
 * 全是父层算好的数字与清单（props 只读），这里负责把它们说成人话 —— 特别是三件要提醒的
 * 事：索引与实际条目数对不上（该重建索引了）、仓库没连远端（同步按钮不会出现的原因）、
 * 巡检在库里挑出的毛病（孤儿 / 断链 / 元数据 / 出处 / 主题目录，口径在 shared/kb-lint.ts）。
 * 巡检只报不改：每一条都能点开对应的条目，改哪儿由人定。
 */
import { computed } from 'vue'

const props = defineProps<{
  stats: KbStats
  tagCounts: Array<{ tag: string, count: number }>
  /** index.json 解出来的两样；null = 索引还没生成（或认不出） */
  indexInfo: KbIndexInfo | null
  /** 知识库文件夹在不在 git 仓库里 */
  isRepo: boolean
  /** origin 地址；空串 = 没连远端 */
  repoOrigin: string
  /** 巡检出来的问题（只读检查）：空数组 = 这一遍什么问题都没有 */
  issues: KbIssue[]
}>()

const emit = defineEmits<{ 'open-entry': [rel: string] }>()

/** 概览只放前几个标签，再多就是另一页的事了 */
const TAG_LIMIT = 8
const topTags = computed(() => props.tagCounts.slice(0, TAG_LIMIT))

/** 索引与实际条目数对不上：该重建了（null 不算对不上，那是「还没生成」的另一句话） */
const indexMismatch = computed(
  () => props.indexInfo !== null && props.indexInfo.count !== props.stats.entries,
)

/** 巡检的汇总行：「孤儿 3 · 断链 1」（只有非零的那几类，顺序固定） */
const issueSummary = computed(() =>
  kbIssueCounts(props.issues)
    .map(item => `${item.label} ${item.count}`)
    .join(' · '),
)

/** 问题多起来先列前几条：剩下的给一句计数，别把这张卡片铺成一整页 */
const ISSUE_LIMIT = 20
const shownIssues = computed(() => props.issues.slice(0, ISSUE_LIMIT))
const restIssues = computed(() => Math.max(0, props.issues.length - ISSUE_LIMIT))

const repoText = computed(() => {
  if (!props.isRepo)
    return '不在 git 仓库里：没有版本记录，也没法在这里同步'
  if (!props.repoOrigin)
    return '在 git 仓库里，但还没连远端：版本只留本机'
  return `已连远端：${props.repoOrigin}`
})
</script>

<template>
  <div class="kb-info">
    <div class="kb-info__scroll">
      <section class="kb-info__block">
        <h3 class="kb-info__title">
          概览
        </h3>
        <dl class="kb-info__facts">
          <div class="kb-info__fact">
            <dt>条目</dt>
            <dd>
              {{ stats.entries }}<template v-if="stats.drafts > 0">
                （草稿 {{ stats.drafts }}）
              </template>
            </dd>
          </div>
          <div class="kb-info__fact">
            <dt>原始数据</dt>
            <dd>
              {{ stats.raws }}<template v-if="stats.pending + stats.stale > 0">
                （未入库 {{ stats.pending }} · 有更新 {{ stats.stale }}）
              </template>
            </dd>
          </div>
        </dl>
      </section>

      <section v-if="topTags.length" class="kb-info__block">
        <h3 class="kb-info__title">
          标签
        </h3>
        <div class="kb-info__tags">
          <span v-for="item in topTags" :key="item.tag" class="kb-info__tag">
            {{ item.tag }}<span class="kb-info__tag-count">{{ item.count }}</span>
          </span>
        </div>
      </section>

      <section class="kb-info__block">
        <h3 class="kb-info__title">
          索引
        </h3>
        <p v-if="!indexInfo" class="kb-info__note">
          还没有生成索引：点工具条上的「重建索引」，由应用按 kb/ 下的条目算出目录与机器索引。
        </p>
        <template v-else>
          <p class="kb-info__note">
            生成于 {{ indexInfo.generatedAt }}，收录 {{ indexInfo.count }} 条。
          </p>
          <p v-if="indexMismatch" class="kb-info__warn">
            实际扫到 {{ stats.entries }} 条，与索引对不上 —— 点工具条上的「重建索引」。
          </p>
        </template>
      </section>

      <section class="kb-info__block">
        <h3 class="kb-info__title">
          仓库
        </h3>
        <p class="kb-info__note" :class="{ 'kb-info__warn': !isRepo || !repoOrigin }">
          {{ repoText }}
        </p>
      </section>

      <!-- 巡检：只读检查，出问题就点开那一条去看（改哪儿由人定） -->
      <section class="kb-info__block">
        <h3 class="kb-info__title">
          巡检
        </h3>
        <p v-if="!issues.length" class="kb-info__note">
          没有发现问题：孤儿、断链、元数据、出处、主题目录都过了一遍。
        </p>
        <template v-else>
          <p class="kb-info__note">
            共 {{ issues.length }} 处：{{ issueSummary }}
          </p>
          <ul class="kb-info__issues">
            <li v-for="(issue, index) in shownIssues" :key="index">
              <button type="button" class="kb-info__issue" @click="emit('open-entry', issue.rel)">
                <span class="kb-info__issue-kind">{{ KB_ISSUE_LABELS[issue.kind] }}</span>
                <span class="kb-info__issue-text">
                  <span class="mono">{{ issue.rel }}</span> —— {{ issue.text }}
                </span>
              </button>
            </li>
          </ul>
          <p v-if="restIssues" class="kb-info__note">
            还有 {{ restIssues }} 处没有列出。
          </p>
        </template>
        <p class="kb-info__hint">
          只读检查，不改任何文件；生成物与主题总览（README）的链接不算引用。
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

/* 巡检的问题清单：一条一行，点一下打开对应的条目 */
.kb-info__issues {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin: var(--sp-2) 0 0;
  padding: 0;
  list-style: none;
}

.kb-info__issue {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  width: 100%;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font: inherit;
  font-size: var(--fs-meta);
  line-height: 1.7;
  text-align: left;
  word-break: break-word;
  cursor: pointer;
}

.kb-info__issue:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

/* 类别那一格：定宽，清单才像一张表（名字都两个字，对齐得住） */
.kb-info__issue-kind {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kb-info__issue:hover .kb-info__issue-kind {
  color: var(--ink-2);
}

.kb-info__issue-text {
  min-width: 0;
}

/* 巡检的口径：比正文再轻一档，一句话说完 */
.kb-info__hint {
  margin: var(--sp-2) 0 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}
</style>
