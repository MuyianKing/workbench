<script setup lang="ts">
import { CaretBottom, Close } from '@element-plus/icons-vue'
/**
 * 「左栏底部那一行」：目录是哪个 + 最近打开的那几个 + 右侧的工具按钮（插槽）。
 *
 * 笔记页与视频页是同一副布局（原先两页各抄一份），收在这里。三件职责：
 *  - **钉在卡片底部**：树上边吃掉剩余高度，这一段多长都不会被挤走；
 *    上面那道分隔线把它与树分开 —— 两者说的是不同的事（这一页的内容 / 这是哪个目录）。
 *  - **目录名是一颗按钮**，点开「最近打开」那份**往上弹的浮层**（它就在面板最底下），
 *    旁边那颗小箭头是提示，展开时翻过来。没有历史记录时名字只是一行字，点了没东西可弹。
 *    浮层不做成常显的一行：左栏本来就窄，这几个目录几天也不换一次，常显要吃掉大半屏的高度。
 *  - **浮层与这一行等宽、左缘对齐**：现量这一行自己的 `clientWidth`，而不是按左栏宽度
 *    减内边距算 —— 内边距是设计令牌（`--sp-4`），在 JS 里再抄一遍就等于多了一处会过期的事实。
 *    左栏宽度可以拖、目录也可能刚选上（这一行这时才渲染出来），所以量宽跟着这两件事重新走。
 *
 * 「打开某一条」与「删掉某一条」都报给调用方（换目录 / 删记录归 store，这里不碰数据）；
 * 点的是当前目录时这里就拦下了（按钮本来也是禁用的）。右侧按钮各自带 tooltip，
 * 走 #tools 插槽进来的内容按同一副小按钮的尺寸画。
 */
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  /** 当前打开的目录（绝对路径；浮层里用它认「哪条是当前的」） */
  root: string
  /** 目录名（只取末段的那一口径归调用方，两个页面各自有 shared 函数） */
  rootName: string
  /** 篇数 / 个数那一小段（如「12 篇笔记」），悬停看全文 */
  countText: string
  /** 最近打开的目录（最近在最前，最多 6 条） */
  roots: string[]
  /** 左栏宽度：拖动它时这一行的实际宽度跟着变，浮层宽度要重新量 */
  treeWidth: number
  /** 目录路径 → 显示名（笔记页 noteRootName / 视频页 videoRootName） */
  nameOf: (dir: string) => string
}>()

const emit = defineEmits<{
  /** 点了「最近打开」里的某一条（当前目录不会发：按钮已禁用） */
  open: [dir: string]
  /** 点了删记录的叉：只删这一条历史，不影响当前打开的目录 */
  forget: [dir: string]
}>()

/** 那份浮层开着没有（挂在目录名那颗按钮上） */
const historyOpen = ref(false)

/** 浮层的宽度：见文件头。量的是这一行自己的 clientWidth —— 它铺满菜单区，自己不带内边距 */
const metaRef = ref<HTMLElement | null>(null)
const historyWidth = ref(200)

function measureHistoryWidth(): void {
  const width = metaRef.value?.clientWidth ?? 0
  if (width > 0)
    historyWidth.value = Math.round(width)
}

onMounted(() => void nextTick(measureHistoryWidth))

watch(
  [() => props.root, () => props.treeWidth],
  () => void nextTick(measureHistoryWidth),
)

/** 换一个目录；点的是当前这个就什么都不做。换完把浮层收起来：这一下的事已经做完了 */
function openRecent(dir: string): void {
  historyOpen.value = false
  if (dir === props.root)
    return
  emit('open', dir)
}

/** 删记录的叉不关浮层：那是个可能连着点几次的动作 */
function forgetRecent(dir: string): void {
  emit('forget', dir)
}
</script>

<template>
  <footer class="recent-roots">
    <!-- ref 只为一件事：量出这一行有多宽，好让浮层与它等宽、左缘对齐 -->
    <div ref="metaRef" class="recent-roots__meta">
      <el-popover
        v-if="roots.length"
        v-model:visible="historyOpen"
        trigger="click"
        placement="top-start"
        :width="historyWidth"
        :offset="8"
      >
        <template #reference>
          <button class="recent-roots__root-btn" type="button" :title="root">
            <span class="recent-roots__root truncate">{{ rootName }}</span>
            <el-icon class="recent-roots__caret" :class="{ 'is-open': historyOpen }">
              <CaretBottom />
            </el-icon>
          </button>
        </template>

        <div class="recent-roots__history">
          <p class="recent-roots__history-title">
            最近打开
          </p>
          <ul class="recent-roots__history-list scrollbar">
            <li
              v-for="dir in roots"
              :key="dir"
              class="recent-roots__history-item"
              :class="{ 'is-current': dir === root }"
            >
              <button
                class="recent-roots__history-open"
                type="button"
                :title="dir"
                :disabled="dir === root"
                @click="openRecent(dir)"
              >
                <span class="truncate">{{ nameOf(dir) }}</span>
              </button>
              <el-tooltip content="从历史记录里删掉" placement="top">
                <button
                  class="recent-roots__history-remove"
                  type="button"
                  aria-label="从历史记录里删掉"
                  @click="forgetRecent(dir)"
                >
                  <el-icon><Close /></el-icon>
                </button>
              </el-tooltip>
            </li>
          </ul>
        </div>
      </el-popover>

      <!-- 一个历史记录都没有：名字只是一行字，点了也没东西可弹 -->
      <span v-else class="recent-roots__root is-plain truncate" :title="root">
        {{ rootName }}
      </span>

      <span class="recent-roots__count" :title="countText">{{ countText }}</span>

      <!-- 右侧的工具按钮归调用方（两个页面各有一组），尺寸按这一行的小按钮画 -->
      <span class="recent-roots__tools">
        <slot name="tools" />
      </span>
    </div>
  </footer>
</template>

<style scoped>
/**
 * 钉在卡片底部：树上边吃掉剩余高度，这一段多长都不会被挤走。
 * 上面那道分隔线把它与树分开 —— 两者说的是不同的事（这一页的内容 / 这是哪个目录）。
 */
.recent-roots {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.recent-roots__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 目录名：点开「最近打开」那颗按钮（没有历史记录时是一行字，不带按钮外观） */
.recent-roots__root-btn {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  /* 不带横向内边距：按钮的左缘就是菜单区的左缘 —— 名字与树的缩进对齐，
     浮层（挂在它上面、placement=top-start）的左缘也因此与菜单对齐 */
  padding: 2px 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.recent-roots__root-btn:hover,
.recent-roots__root-btn[aria-expanded='true'] {
  background: var(--bg-subtle);
}

.recent-roots__root {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-2);
}

/* 「点这儿还有一份清单」的提示：展开时翻过来 */
.recent-roots__caret {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
  transition: color 0.15s ease, transform 0.15s ease;
}

.recent-roots__root-btn:hover .recent-roots__caret {
  color: var(--ink-2);
}

.recent-roots__caret.is-open {
  color: var(--ink-2);
  transform: rotate(180deg);
}

/**
 * 这一行的宽度是抢出来的：目录名最要紧，篇数其次，工具按钮各自有固定宽度。
 * 所以篇数允许被挤掉（截断 + 悬停看全），名字不跟着一起缩 ——
 * 两边都按默认的 flex-shrink: 1 分，名字会被挤成「N…」，那这一行就白留了。
 */
.recent-roots__count {
  flex: 0 100 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.recent-roots__tools {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

/* 几颗图标按钮：挨在一起（EP 的 text 按钮自带左外边距），内边距也收窄 ——
   这一行本来就窄，按钮占的每一像素都是从目录名那里拿走的 */
.recent-roots__tools :deep(.el-button + .el-button) {
  margin-left: 0;
}

.recent-roots__tools :deep(.el-button) {
  height: 22px;
  padding: 0 4px;
}

/**
 * 「最近打开」是一份**往上弹的浮层**（挂在目录名那颗按钮上）。
 * 浮层内容被 Teleport 到 body，不受卡片裁剪的影响。
 */
.recent-roots__history {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-height: 0;
}

.recent-roots__history-title {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 历史记录最多 6 条，正常不会滚；给个上限免得这里把树挤没 */
.recent-roots__history-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 132px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recent-roots__history-item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  border-radius: var(--r-sm);
}

.recent-roots__history-item:hover {
  background: var(--bg-inset);
}

.recent-roots__history-open {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px var(--sp-2);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
}

.recent-roots__history-open:hover {
  color: var(--ink);
}

/* 当前打开的那个不给点（点它等于什么都不做），但要看得见是哪一条 */
.recent-roots__history-item.is-current .recent-roots__history-open {
  color: var(--ink);
  font-weight: 600;
  cursor: default;
}

.recent-roots__history-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 2px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  color: var(--ink-3);
  cursor: pointer;
  /* 平时不显眼，指到这一行才露出来：它是次要动作，不该与「打开」抢注意力 */
  opacity: 0;
}

.recent-roots__history-item:hover .recent-roots__history-remove {
  opacity: 1;
}

.recent-roots__history-remove:hover {
  color: var(--ink);
  background: var(--bg-subtle);
}
</style>
