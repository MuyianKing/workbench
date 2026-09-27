<script setup lang="ts">
/**
 * 视频目录树（左栏）。
 *
 * 与笔记树同一副骨架（el-tree），但**没有**那两套复杂交互：这一页只看不改，
 * 文件夹与视频都是只读的 —— 没有右键菜单、没有拖动、没有「新建」。
 * 点文件夹是撑开 / 收起那一层（`expand-on-click-node`），点视频是选中并立刻播放。
 *
 * 展开态不在组件里留副本：这里是 `expanded` 进、`update:expanded` 出，
 * 上层要拿它落盘（设置里的 `videoTreeExpanded`，上次摊开的那几层下次进来还是摊开的）。
 * `:auto-expand-parent="false"` 的原因见 NoteTree 的同名注释 —— 不关它，
 * 「展开一个子孙」会顺手把祖先顶开，选中项那一支怎么点都收不起来。
 */
import { Folder, VideoPlay } from '@element-plus/icons-vue'
import PanelLoading from '@/components/PanelLoading.vue'
import { formatVideoTime, type VideoNode } from '@shared/video'

const props = defineProps<{
  /** 视频文件夹里的顶层条目（文件夹在前、同层按名字，顺序由后端 + shared 定下） */
  nodes: VideoNode[]
  /** 当前选中项的路径（可能是文件夹，也可能是视频） */
  activeRel: string
  /** 至少成功扫过一次：空态提示据此决定要不要说「这里还没有视频」 */
  loaded: boolean
  /** 展开着的节点 id（就是各自的 `rel`）；数组而不是 Set —— el-tree 要的就是数组 */
  expanded: string[]
}>()

const emit = defineEmits<{
  select: [rel: string]
  'update:expanded': [value: string[]]
}>()

/** el-tree 认的字段名：数据里叫 name / children */
const TREE_PROPS = { label: 'name', children: 'children' } as const

function expand(ids: string[]): void {
  emit('update:expanded', [...new Set([...props.expanded, ...ids])])
}

function collapse(id: string): void {
  emit(
    'update:expanded',
    props.expanded.filter((item) => item !== id)
  )
}

/**
 * 树行上的时长徽章：一集多长一眼可读，挑哪一集看时它比名字更管用。
 * **只有视频行有**，而且始终显示 —— 读不出时长摆「--:--」（空着或 0:00 都是坏信息，
 * 占位符只说「未知」）；文件夹不摆这一格，名字吃满整行。
 */
function durationOf(node: VideoNode): string {
  if (node.kind !== 'video') return ''
  const duration = node.duration ?? 0
  return duration > 0 ? formatVideoTime(duration) : '--:--'
}
</script>

<template>
  <div class="tree">
    <el-tree
      v-show="nodes.length"
      class="tree__body scrollbar"
      :data="nodes"
      :props="TREE_PROPS"
      node-key="id"
      :indent="14"
      :default-expanded-keys="expanded"
      :auto-expand-parent="false"
      :expand-on-click-node="true"
      :highlight-current="false"
      @node-click="(data: VideoNode) => emit('select', data.rel)"
      @node-expand="(data: VideoNode) => expand([data.id])"
      @node-collapse="(data: VideoNode) => collapse(data.id)"
    >
      <template #default="{ data }">
        <span class="node" :class="{ 'is-active': data.rel === activeRel }" :title="data.name">
          <el-icon class="node__icon">
            <Folder v-if="data.kind === 'folder'" />
            <VideoPlay v-else />
          </el-icon>
          <span class="node__name">{{ data.name }}</span>
          <span v-if="data.kind === 'video'" class="node__duration">{{ durationOf(data) }}</span>
        </span>
      </template>
    </el-tree>

    <!-- 首次扫盘还没回来：左栏先说一声，别让人对着半屏空白猜在干什么 -->
    <PanelLoading v-if="!loaded && !nodes.length" text="正在读取视频…" />

    <!-- 一个视频都没有：说清「这里会是什么」，别让人对着空白猜坏了 -->
    <div v-if="loaded && !nodes.length" class="tree__empty">
      <p class="tree__empty-title">这个文件夹里还没有 MP4 视频</p>
      <p class="tree__empty-hint">
        把视频放进来（或在别处放好），点左栏底部那颗刷新就能看到。字幕、封面这些别的文件不会出现在树里。
      </p>
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  border-radius: var(--r-md);
}

/**
 * 滚动条贴到卡片右缘（与 NoteTree 的 .tree__body 同一条口径）：
 * 负右 margin 把滚动容器出血到卡片边缘，等宽的右 padding 把树的位置兜回来。
 */
.tree__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin-right: calc(-1 * var(--sp-4));
  padding: 0 var(--sp-4) 0 0;
  background: transparent;
}

/* el-tree 的节点行默认吃满整宽，悬停与选中才有整行感 */
.tree__body :deep(.el-tree-node__content) {
  height: 28px;
  border-radius: var(--r-sm);
}

.tree__body :deep(.el-tree-node__content:hover) {
  background: var(--bg-inset);
}

/* 选中的那一行整行铺底色（自己画，不开 el-tree 的 highlight-current，理由见 NoteTree） */
.tree__body :deep(.el-tree-node__content:has(.node.is-active)) {
  background: var(--bg-selected);
}

/**
 * 节点行要撑满整行，徽章才有地方靠右：时长是一**列**（右侧定宽、右对齐），
 * 名字用 flex: 1 吃掉剩余宽度把它顶到最右 —— 名字不吃的话，短名字的徽章缩在中间、
 * 跟着名字的长短横七竖八（用户看到的「没对齐」就是这个）。定宽 + 右对齐 + 等宽数字，
 * 视频行的右缘掐齐；文件夹行没有徽章，名字一直铺到右缘。
 */
.node {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding-right: 6px;
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.node__icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.node__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.node__duration {
  flex-shrink: 0;
  width: 54px;
  text-align: right;
  white-space: nowrap;
  font-size: var(--fs-micro);
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}

/* 选中态自己画：它比悬停明确高一档，且与「右边正在播的是哪一个」严格对应 */
.node.is-active {
  color: var(--ink);
  font-weight: 600;
}

.node.is-active .node__icon {
  color: var(--ink);
}

.tree__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-1);
}

.tree__empty-title {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.tree__empty-hint {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
}
</style>
