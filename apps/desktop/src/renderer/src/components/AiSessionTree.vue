<script setup lang="ts">
import type { AiSessionGroup } from '@workbench/ai'
import { CaretRight, ChatLineSquare, Delete, FolderOpened, Plus } from '@element-plus/icons-vue'
/**
 * 左栏那棵会话树：**两层** —— 第一层是项目（一个工作目录），第二层是那个目录下的会话。
 *
 * 每个项目行右边有「起一段新的」（悬停才出来）：**在那个目录里**开一段；每个会话行右边
 * 有「删除」（同样悬停才出）：连同盘上那份对话留档一起删（**确认在 stores/ai.ts 里问**，
 * 这里只报一声）。会话行上那颗小圆点是「正在跑」—— 几个会话可以同时在跑，一眼看出来。
 *
 * **「起一段新的」只是把右栏切到起始那一屏**（那一段还没有：挑目录、写第一句都在那一屏，
 * 会话在发出第一句时才建），所以这里那颗 emit 出去的是「用这个目录起一段」而不是一个已建好的
 * 会话 —— 没说过话的会话不该在树上占一行。一个都还没有时这一栏按别处那副空态给一句说明。
 *
 * 手写两层列表而不用 `el-tree`：要的就是「固定两层、行上有悬停按钮、展开态自己说了算」
 * 这几样，`el-tree` 的展开 / 选中 / 拖放那一整套在这里都用不上，反而要绕着它的默认行为走
 * （笔记树用它是为了拖拽与任意深度）。
 *
 * 展开态只活在这一份里（重启回到全展开，新加的项目默认摊开）：项目数是个位数，
 * 没必要像笔记树那样落盘。
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  groups: AiSessionGroup[]
  /** 现在画着的是哪个会话（它那一行铺底色） */
  activeId: string
  /** 正在跑的会话 id（那几行上点一颗小圆点） */
  runningIds: string[]
}>()

const emit = defineEmits<{
  select: [id: string]
  /** 在这个目录里起一段新的（右栏切到起始那一屏，会话等第一句发出去才建） */
  start: [dir: string]
  remove: [id: string]
}>()

/** 收起来的项目（存「收起来的」而不是「展开的」：项目一多，缺省就是摊开的） */
const collapsed = ref(new Set<string>())

function toggle(dir: string): void {
  const next = new Set(collapsed.value)
  if (next.has(dir))
    next.delete(dir)
  else next.add(dir)
  collapsed.value = next
}

/** 会话行上的名字：还没说过话的会话还没有标题（第一条指令进来时才有，见 stores/ai.ts） */
function sessionLabel(title: string): string {
  return title || '新会话'
}

const running = computed(() => new Set(props.runningIds))
</script>

<template>
  <div class="tree scrollbar">
    <!-- 一个会话都还没有：按别处那副空态给一句说明（起一段在那颗「+」与中间那条
         composer 上，这儿只把「项目 → 会话」这层关系说清楚） -->
    <div v-if="!groups.length" class="tree__empty">
      <p class="tree__empty-title">
        还没有会话
      </p>
      <p class="tree__empty-hint">
        点上面的「+」开一段新的：一个目录是一个「项目」，它下面可以有好几段对话。
      </p>
    </div>

    <div v-for="group in groups" :key="group.dir" class="tree__group">
      <!-- 项目那一行：点整行是收起 / 摊开（这一个目录里有哪些会话） -->
      <div class="row is-project" :title="group.dir" @click="toggle(group.dir)">
        <el-icon class="row__caret" :class="{ 'is-open': !collapsed.has(group.dir) }">
          <CaretRight />
        </el-icon>
        <el-icon class="row__icon">
          <FolderOpened />
        </el-icon>
        <span class="row__name">{{ group.name }}</span>
        <el-tooltip content="在这个目录里起一段新的" placement="top">
          <button type="button" class="row__action" @click.stop="emit('start', group.dir)">
            <el-icon><Plus /></el-icon>
          </button>
        </el-tooltip>
      </div>

      <template v-if="!collapsed.has(group.dir)">
        <div
          v-for="session in group.sessions"
          :key="session.id"
          class="row is-session"
          :class="{ 'is-active': session.id === activeId }"
          :title="session.title || group.dir"
          @click="emit('select', session.id)"
        >
          <el-icon class="row__icon">
            <ChatLineSquare />
          </el-icon>
          <span class="row__name">{{ sessionLabel(session.title) }}</span>
          <span v-if="running.has(session.id)" class="row__run" aria-hidden="true" />
          <el-tooltip content="删除这个会话（对话记录一起删掉）" placement="top">
            <button type="button" class="row__action" @click.stop="emit('remove', session.id)">
              <el-icon><Delete /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  /* 滚到底那一条不要贴着字：滚动条挪到卡片内边距外面（与笔记树同一条） */
  margin-right: calc(-1 * var(--sp-4));
  padding: 0 var(--sp-4) 0 0;
}

.tree__group + .tree__group {
  margin-top: var(--sp-1);
}

/**
 * 一行：项目与会话同一副骨架（图标 + 名字 + 悬停才出来的按钮），差在左边那点缩进。
 * 行高 28px 与笔记 / 视频树一致 —— 三页的左栏挨着看是一回事。
 */
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 4px;
  border-radius: var(--r-sm);
  color: var(--ink-2);
  font-size: var(--fs-body);
  cursor: pointer;
}

.row:hover {
  background: var(--bg-inset);
}

/* 会话行缩进一格，落在项目名底下（与展开箭头的宽度对齐） */
.row.is-session {
  padding-left: 22px;
}

.row.is-active {
  background: var(--bg-selected);
  color: var(--ink);
  font-weight: 600;
}

.row.is-active .row__icon {
  color: var(--ink);
}

.row__caret {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
  transition: transform 0.15s var(--ease-out);
}

.row__caret.is-open {
  transform: rotate(90deg);
}

.row__icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.row__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 正在跑的那一颗：彩色只表达运行状态（与首页那些运行态同一套） */
.row__run {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-run);
}

/**
 * 悬停 / 键盘聚焦或选中时才出来的那颗按钮：平时让位给名字（名字要能读全），
 * 鼠标到了才显形（与命令面板、保险库那几处同一套做法）。
 */
.row__action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.row:hover .row__action,
.row:focus-within .row__action,
.row__action:focus-visible {
  opacity: 1;
}

.row__action:hover {
  background: var(--bg-surface);
  color: var(--ink);
}

/* 一个会话都没有时那一块：与笔记树 / 视频树同一副空态（标题一行 + 一句说明，不成块、不描边） */
.tree__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-1);
}

.tree__empty-title {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.tree__empty-hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}
</style>
