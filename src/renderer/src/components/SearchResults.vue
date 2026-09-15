<script setup lang="ts">
/**
 * 聚合搜索的结果面板。
 *
 * 只负责画：分组、条目、当前行高亮、底部一行键盘提示。选中哪一条、按了什么键都由
 * AppHeader 决定 —— 面板自己不持有"当前选中项"，那样两处状态就会打架。
 *
 * 分组标题只在有两个以上来源时才画：今天只有「项目」一个来源，一个标题带着一堆结果
 * 看着像没做完；等命令 / 快捷启动接进来，标题自然出现，这里不用改。
 *
 * 条目上的 mousedown 要 prevent：不拦的话输入框先失焦、面板当场关掉，
 * 这一下 click 就落在空气上了（搜索结果因此永远点不动）。
 */
import type { Component } from 'vue'
import { Document, FolderOpened } from '@element-plus/icons-vue'
import { SEARCH_SOURCE_PROJECT, highlightSegments, type SearchGroup } from '@shared/search'

const props = defineProps<{
  groups: SearchGroup[]
  /** 关键词，用来把命中的那一段标出来 */
  keyword: string
  /** 键盘上下键停在的条目（跨分组的扁平序号），-1 表示没有 */
  activeIndex: number
}>()

const emit = defineEmits<{ select: [id: string] }>()

/** 每个来源一个图标：以后接进命令 / 快捷启动时在这里补，找不到就用通用文档图标 */
const ICONS: Record<string, Component> = {
  [SEARCH_SOURCE_PROJECT]: FolderOpened
}

function iconOf(source: string): Component {
  return ICONS[source] ?? Document
}

/** 扁平序号 → 该条在面板里的位置，用来判断这一条是不是当前行 */
function flatIndexOf(groupIndex: number, hitIndex: number): number {
  let before = 0
  for (let i = 0; i < groupIndex; i += 1) before += props.groups[i].hits.length
  return before + hitIndex
}

function segments(text: string) {
  return highlightSegments(text, props.keyword)
}
</script>

<template>
  <div class="results" role="listbox" @mousedown.prevent>
    <template v-for="(group, groupIndex) in groups" :key="group.source">
      <div v-if="groups.length > 1" class="results__group">{{ group.label }}</div>

      <button
        v-for="(hit, hitIndex) in group.hits"
        :key="hit.id"
        class="hit"
        :class="{ 'is-active': flatIndexOf(groupIndex, hitIndex) === activeIndex }"
        type="button"
        role="option"
        :aria-selected="flatIndexOf(groupIndex, hitIndex) === activeIndex"
        @click="emit('select', hit.id)"
      >
        <el-icon class="hit__icon"><component :is="iconOf(hit.source)" /></el-icon>
        <span class="hit__name">
          <span v-for="(seg, i) in segments(hit.title)" :key="i" :class="{ 'is-hit': seg.hit }">
            {{ seg.text }}
          </span>
        </span>
        <span class="hit__path mono">
          <span v-for="(seg, i) in segments(hit.subtitle)" :key="i" :class="{ 'is-hit': seg.hit }">
            {{ seg.text }}
          </span>
        </span>
        <span v-if="hit.detail" class="hit__kind">{{ hit.detail }}</span>
      </button>
    </template>

    <p v-if="!groups.length" class="results__empty">没有匹配的项目</p>

    <div v-else class="results__foot">
      <span v-if="groups.length === 1 && groups[0].total > groups[0].hits.length">
        查看全部 <b>{{ groups[0].total }}</b> 条结果
      </span>
      <span v-else />
      <span class="results__keys">
        <kbd>↑</kbd> <kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭
      </span>
    </div>
  </div>
</template>

<style scoped>
.results {
  position: absolute;
  left: var(--sp-5);
  /* 挂在搜索框正下方：顶栏就是定位参照（AppHeader 的 .header 上有 position: relative） */
  top: calc(100% - 6px);
  z-index: 30;
  /* 比输入框宽：一行要放得下名称与路径两段 */
  width: 520px;
  padding: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-pop);
}

.results__group {
  padding: 6px 8px 4px;
  font: 500 var(--fs-micro) / 1 var(--font-mono);
  letter-spacing: 0.09em;
  color: var(--ink-3);
}

.hit {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 36px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

/* 当前行（键盘停在它上面、或指针悬停） */
.hit.is-active {
  background: var(--bg-inset);
}

.hit__icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--ink-3);
}

.hit__name {
  flex-shrink: 0;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--ink);
}

.hit__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 命中的那一段：中性灰底，不占状态色（彩色在这套界面里只表达运行状态） */
.is-hit {
  background: var(--el-color-primary-light-9);
  border-radius: 3px;
  color: var(--ink);
}

.hit__kind {
  flex-shrink: 0;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--r-pill);
  background: var(--st-idle-soft);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 18px;
}

.results__empty {
  padding: 12px 10px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.results__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin: 6px 2px 0;
  padding: 8px 8px 2px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.results__keys {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ink-3);
}

.results__keys kbd {
  font: var(--fs-micro) / 1 var(--font-mono);
  color: var(--ink-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px;
}
</style>
