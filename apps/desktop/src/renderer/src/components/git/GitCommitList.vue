<script setup lang="ts">
import type { GitCommit } from '@workbench/git'
import { Document } from '@element-plus/icons-vue'
import { shortHash } from '@workbench/git'
import { computed, nextTick, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import { basenameOf, formatTimestamp } from '@/format'
import { useGitStore } from '@/stores/git'
/**
 * 中间栏：提交列表。它有一个来源开关 ——
 *  - `historyPath` 为空：整个仓库当前分支（HEAD）的历史；
 *  - 选了一个文件：那个文件的提交历史（`git log -- <path>`，不做 rename 跟踪）。
 *
 * 每一行点一下 = 右侧看这个提交的差异；行尾那颗「对比」= 选对比的基准 / 目标：
 * 第一次点选基准，第二次点另一个提交就立刻取两者的差异，再点第三个从头开始。
 *
 * 滚动到底自动续一页（`hasMore` 由宿主按「多取一条」判断），旁边仍留一颗「加载更多」
 * 给不知道可以滚到底的人。
 */
const store = useGitStore()

const scrollRef = ref<HTMLElement | null>(null)

const emptyText = computed(() =>
  store.isFileHistory ? '这个文件还没有提交历史' : '这个仓库还没有提交',
)

/** 换文件历史 / 换仓库时把列表滚回顶部：上一个位置对下一批提交没有意义 */
watch(
  () => `${store.repo?.root ?? ''}|${store.repo?.head ?? ''}|${store.historyPath}`,
  async () => {
    await nextTick()
    if (scrollRef.value)
      scrollRef.value.scrollTop = 0
  },
)

function onScroll(): void {
  const el = scrollRef.value
  if (!el || !store.commitsHasMore || store.commitsLoading)
    return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80)
    void store.loadMore()
}

function isActive(commit: GitCommit): boolean {
  return store.detail?.hash === commit.hash
}

function compareState(commit: GitCommit): '' | 'base' | 'target' {
  if (store.compareBase?.hash === commit.hash)
    return 'base'
  if (store.compareTarget?.hash === commit.hash)
    return 'target'
  return ''
}

function compareLabel(commit: GitCommit): string {
  const state = compareState(commit)
  if (state === 'base')
    return '基准'
  if (state === 'target')
    return '目标'
  return '对比'
}

/** 引用串可能很长（`HEAD -> main, origin/main, tag: v1`），行上只留第一条 */
function refLabel(commit: GitCommit): string {
  return commit.refs.split(',')[0]?.trim() ?? ''
}

function select(commit: GitCommit): void {
  void store.selectCommit(commit)
}

function pick(commit: GitCommit): void {
  void store.pickCompare(commit)
}
</script>

<template>
  <section class="commit-pane">
    <header class="commit-head">
      <div class="commit-head__title">
        <template v-if="store.isFileHistory">
          <span class="commit-head__label">文件历史</span>
          <span class="commit-head__file mono" :title="store.historyPath">
            {{ basenameOf(store.historyPath) }}
          </span>
          <el-button text size="small" @click="store.showRepoHistory()">
            返回仓库历史
          </el-button>
        </template>
        <span v-else class="commit-head__label">提交</span>
      </div>
      <span class="commit-head__count">{{ store.commits.length }} 条</span>
    </header>

    <!-- 对比条：选基准之后一直摆在这里，直到取消或比完再选下一个 -->
    <div v-if="store.compareBase" class="compare-bar">
      <span class="compare-bar__lead">对比</span>
      <span class="mono">{{ shortHash(store.compareBase.hash) }}</span>
      <span class="compare-bar__arrow">→</span>
      <span v-if="store.compareTarget" class="mono">{{ shortHash(store.compareTarget.hash) }}</span>
      <span v-else class="compare-bar__hint">再点一个提交</span>
      <el-button class="compare-bar__clear" text size="small" @click="store.clearCompare()">
        取消
      </el-button>
    </div>

    <div ref="scrollRef" class="commit-scroll" @scroll="onScroll">
      <PanelLoading v-if="store.commitsLoading && !store.commits.length" text="正在读取提交…" />

      <div v-else-if="store.commitsError" class="state state--error">
        <span>{{ store.commitsError }}</span>
        <el-button text size="small" @click="store.reloadHistory()">
          重试
        </el-button>
      </div>

      <EmptyState
        v-else-if="store.commitsLoaded && !store.commits.length"
        compact
        :icon="Document"
        :text="emptyText"
      />

      <template v-else>
        <div
          v-for="commit in store.commits"
          :key="commit.hash"
          class="commit"
          :class="{
            'is-active': isActive(commit),
            'is-base': compareState(commit) === 'base',
            'is-target': compareState(commit) === 'target',
          }"
          role="button"
          tabindex="0"
          @click="select(commit)"
          @keydown.enter.prevent="select(commit)"
          @keydown.space.prevent="select(commit)"
        >
          <div class="commit__main">
            <span class="commit__subject" :title="commit.subject">
              {{ commit.subject || '（无提交说明）' }}
            </span>
            <span class="commit__meta">
              <span class="commit__hash mono">{{ shortHash(commit.hash) }}</span>
              <span class="commit__author">{{ commit.author || commit.authorEmail || '未知作者' }}</span>
              <span>{{ formatTimestamp(commit.time) }}</span>
              <span v-if="commit.parents.length > 1" class="commit__badge">合并</span>
              <span v-if="refLabel(commit)" class="commit__ref" :title="commit.refs">
                {{ refLabel(commit) }}
              </span>
            </span>
          </div>
          <button
            class="commit__compare"
            :class="{ 'is-picked': compareState(commit) !== '' }"
            type="button"
            :aria-pressed="compareState(commit) !== ''"
            @click.stop="pick(commit)"
          >
            {{ compareLabel(commit) }}
          </button>
        </div>

        <div v-if="store.commitsLoading" class="state">
          正在读取…
        </div>
        <div v-else-if="store.commitsHasMore" class="state">
          <el-button text size="small" @click="store.loadMore()">
            加载更多
          </el-button>
        </div>
        <div v-else-if="store.commits.length" class="commit-end">
          没有更多了
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.commit-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: var(--sp-3);
}

.commit-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.commit-head__title {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.commit-head__label {
  flex-shrink: 0;
  color: var(--ink);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.commit-head__file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.commit-head__count {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.compare-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding: 4px var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.compare-bar__lead {
  color: var(--ink-2);
}

.compare-bar__arrow {
  color: var(--ink-3);
}

.compare-bar__hint {
  color: var(--ink-3);
}

.compare-bar__clear {
  margin-left: auto;
}

.commit-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: var(--sp-2);
}

.commit {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-bottom: 1px solid var(--border);
  border-radius: var(--r-sm);
  cursor: pointer;
}

.commit:last-child {
  border-bottom: 0;
}

.commit:hover {
  background: var(--bg-inset);
}

.commit.is-active {
  background: var(--bg-selected);
}

/* 对比的基准 / 目标：左侧一条状态色竖条，与本应用的「运行状态」同一条语义 */
.commit.is-base {
  box-shadow: inset 2px 0 0 var(--st-fail);
}

.commit.is-target {
  box-shadow: inset 2px 0 0 var(--st-ok);
}

.commit__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.commit__subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-meta);
}

.commit__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.commit__hash {
  color: var(--ink-2);
}

.commit__author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 8em;
}

.commit__badge {
  padding: 0 6px;
  border-radius: var(--r-pill);
  background: var(--bg-subtle);
}

/* 引用（分支 / 标签）只留第一条：完整清单在 title 里 */
.commit__ref {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 10em;
  color: var(--ink-3);
}

.commit__compare {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  cursor: pointer;
}

.commit__compare:hover {
  background: var(--bg-inset);
  color: var(--ink-2);
}

/* 已经选成基准 / 目标：留一个实底，和左侧那条状态色一起说明它参与对比 */
.commit__compare.is-picked {
  border-color: var(--border);
  background: var(--bg-subtle);
  color: var(--ink);
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-align: center;
}

.state--error {
  color: var(--st-fail);
}

.commit-end {
  padding: var(--sp-3) 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: center;
}
</style>
