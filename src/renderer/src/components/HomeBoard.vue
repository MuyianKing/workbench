<script setup lang="ts">
/**
 * 首页布局画布：左中右三栏，卡片在栏内从上往下排、宽度铺满整栏。
 *
 * 左右两栏宽度可拖、中间那栏 flex:1 吃掉剩余宽度；卡片高度分固定 / 自适应两种模式，
 * 栏内顺序、卡片属于哪一栏都落在 theme.json 里。空栏平时不渲染（不占地方），
 * 编辑时才把三栏都摆出来，好把卡片拖进去。
 *
 * 拖拽用指针事件，而且拖的就是卡片本身：超过阈值后卡片转为 position: fixed 跟着指针走，
 * 原位置不留下任何残影，落点处只留一段与卡片等高的空隙（不画框）。
 */
import { computed, ref } from 'vue'
import type { Component, CSSProperties } from 'vue'
import {
  COLUMN_IDS,
  cardIdsInColumn,
  cardPlaceholderHeight,
  clampColumnWidth,
  type CardGrab,
  type ColumnId,
  type HomeCardId,
  type SideColumnId
} from '@shared/theme'
import { useProjectsStore } from '@/stores/projects'
import BoardCard from '@/components/BoardCard.vue'
import ActivityGraph from '@/components/ActivityGraph.vue'
import TokenPanel from '@/components/TokenPanel.vue'
import SystemPanel from '@/components/SystemPanel.vue'
import RecentPanel from '@/components/RecentPanel.vue'
import ActionsPanel from '@/components/ActionsPanel.vue'
import QuickLaunch from '@/components/QuickLaunch.vue'
import CommandPanel from '@/components/CommandPanel.vue'
import TodayWorkPanel from '@/components/TodayWorkPanel.vue'

const store = useProjectsStore()

/** 八块卡片的固定清单：id 对应 theme.json，title 用于编辑态的标签 */
const CARDS: Record<HomeCardId, { title: string; component: Component }> = {
  activity: { title: '活跃度', component: ActivityGraph },
  token: { title: 'Token 用量', component: TokenPanel },
  system: { title: '系统状态', component: SystemPanel },
  recent: { title: '最近使用', component: RecentPanel },
  actions: { title: '快捷操作', component: ActionsPanel },
  quick: { title: '快捷启动', component: QuickLaunch },
  commands: { title: '命令', component: CommandPanel },
  work: { title: '今日完成', component: TodayWorkPanel }
}

const editing = computed(() => store.layoutEditing)

// ---------- 栏与卡片 ----------

function cardsIn(column: ColumnId): HomeCardId[] {
  return cardIdsInColumn(store.themeConfig.cards, column)
}

/** 平时空栏不渲染；编辑时三栏都在，好把卡片拖进去 */
const visibleColumns = computed<ColumnId[]>(() =>
  editing.value ? [...COLUMN_IDS] : COLUMN_IDS.filter((column) => cardsIn(column).length > 0)
)

const columnsStyle = computed(() => {
  const parts = visibleColumns.value.map((column) =>
    column === 'center'
      ? 'minmax(0, 1fr)'
      : `${column === 'left' ? store.themeConfig.leftWidth : store.themeConfig.rightWidth}px`
  )
  return {
    gridTemplateColumns: parts.join(' '),
    '--left-w': `${store.themeConfig.leftWidth}px`,
    '--right-w': `${store.themeConfig.rightWidth}px`
  }
})

const columnLabel: Record<ColumnId, string> = {
  left: '左栏',
  center: '中栏',
  right: '右栏'
}

// ---------- 指针拖拽换栏 / 换位 ----------

/** 位移超过这个距离才算拖动，避免点一下没动也触发一次落盘 */
const DRAG_THRESHOLD = 4

interface DragState {
  id: HomeCardId
  /** 指针按下时的位置，用来判断有没有真的拖动 */
  startX: number
  startY: number
  /** 指针当前位置 */
  pointerX: number
  pointerY: number
  /** 抓取时指针相对卡片左上角的偏移，跟手时保持不变 */
  offsetX: number
  offsetY: number
  width: number
  height: number
  /** 是否已经超过阈值（超过之前卡片还排在原位，不算拖动） */
  moved: boolean
}

const drag = ref<DragState | null>(null)
const dropTarget = ref<{ column: ColumnId; index: number } | null>(null)

function beginDrag(id: HomeCardId, grab: CardGrab): void {
  if (!editing.value) return

  const column = store.themeConfig.cards[id].column
  drag.value = {
    id,
    startX: grab.x,
    startY: grab.y,
    pointerX: grab.x,
    pointerY: grab.y,
    offsetX: grab.x - grab.left,
    offsetY: grab.y - grab.top,
    width: grab.width,
    height: grab.height,
    moved: false
  }
  dropTarget.value = { column, index: cardsIn(column).indexOf(id) }

  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
}

function onDragMove(event: PointerEvent): void {
  const state = drag.value
  if (!state) return

  state.pointerX = event.clientX
  state.pointerY = event.clientY

  if (!state.moved) {
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) {
      return
    }
    state.moved = true
  }

  // 指针下面是哪一栏（浮层已经 pointer-events: none，不会挡住判定）
  const under = document.elementFromPoint(event.clientX, event.clientY)
  const columnEl = under?.closest<HTMLElement>('.col')
  const column = columnEl?.dataset.column as ColumnId | undefined
  if (!columnEl || !column) return

  dropTarget.value = { column, index: indexAt(columnEl, event.clientY) }
}

/**
 * 落点位置：按指针落在该栏哪张卡片的上半 / 下半决定插到它前面还是后面。
 * 被拖的那张要排掉（它已经脱离文档流），占位空隙推开的位移也要减掉，
 * 否则指针停在分界线上时会出现「空隙推走卡片 → 落点回退」的抖动。
 */
function indexAt(container: HTMLElement, clientY: number): number {
  const id = drag.value?.id
  const cards = [...container.querySelectorAll<HTMLElement>('[data-card-id]')].filter(
    (el) => el.dataset.cardId !== id
  )

  const gap = container.querySelector<HTMLElement>('.col__gap')
  const gapIndex = gap ? Number(gap.dataset.gapIndex) : -1
  // 空隙高度 + 它与相邻卡片之间的 flex 间距，都要从卡片位置上减掉（间距与 .col 的 gap 同源）
  const shift = gap ? gap.getBoundingClientRect().height + store.cardGap : 0

  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect()
    const top = shift && i >= gapIndex ? rect.top - shift : rect.top
    if (clientY < top + rect.height / 2) return i
  }
  return cards.length
}

function endDrag(): void {
  const state = drag.value
  const target = dropTarget.value

  drag.value = null
  dropTarget.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)

  if (state?.moved && target) void store.moveCard(state.id, target.column, target.index)
}

/** 拖起来的那张卡片：脱离文档流，跟着指针走 */
const floatingStyle = computed<CSSProperties | null>(() => {
  const state = drag.value
  if (!state?.moved) return null

  return {
    position: 'fixed',
    left: `${state.pointerX - state.offsetX}px`,
    top: `${state.pointerY - state.offsetY}px`,
    width: `${state.width}px`,
    height: `${state.height}px`
  }
})

/** 落点空隙插在这一栏的第几张卡片之前（等于末尾时插在最后） */
function gapRenderIndex(column: ColumnId): number | null {
  const state = drag.value
  if (!state?.moved || !dropTarget.value) return null
  if (dropTarget.value.column !== column) return null

  // 落点序号是按「不含被拖卡片」的列表算的，映射回渲染序时要把它自己那一格让开
  const own = cardsIn(column).indexOf(state.id)
  return dropTarget.value.index + (own !== -1 && dropTarget.value.index >= own ? 1 : 0)
}

const gapHeight = computed(() => {
  const id = drag.value?.id
  return id ? cardPlaceholderHeight(id, store.themeConfig.cards[id]) : 0
})

// ---------- 栏宽拖动 ----------

function onColumnResizeDown(side: SideColumnId, event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  const startClientX = event.clientX
  const startWidth =
    side === 'left' ? store.themeConfig.leftWidth : store.themeConfig.rightWidth
  // 左栏往右拖变宽；右栏在另一侧，往左拖（dx 为负）才是变宽
  const direction = side === 'left' ? 1 : -1

  const onMove = (moveEvent: PointerEvent): void => {
    const wanted = startWidth + direction * (moveEvent.clientX - startClientX)
    store.setColumnWidth(side, clampColumnWidth(wanted, startWidth))
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    void store.commitColumns()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  // 没有 pointercancel 时，系统取消指针（触控、手势接管）会让监听器留在 window 上，
  // 之后每次移动都在改栏宽
  window.addEventListener('pointercancel', onUp)
}

function onToggleMode(id: HomeCardId): void {
  void store.toggleCardMode(id)
}
</script>

<template>
  <div class="board" :class="{ 'is-editing': editing, 'is-dragging': drag?.moved }">
    <div class="board__columns" :style="columnsStyle">
      <section
        v-for="column in visibleColumns"
        :key="column"
        class="col"
        :class="{ 'is-empty': !cardsIn(column).length }"
        :data-column="column"
      >
        <template v-for="(id, index) in cardsIn(column)" :key="id">
          <div
            v-if="gapRenderIndex(column) === index"
            class="col__gap"
            :data-gap-index="dropTarget?.index ?? 0"
            :style="{ height: `${gapHeight}px` }"
          />

          <BoardCard
            :id="id"
            :title="CARDS[id].title"
            :mode="store.themeConfig.cards[id].mode"
            :height="store.themeConfig.cards[id].height"
            :step="store.gridStep"
            :editing="editing"
            :floating-style="drag?.id === id ? floatingStyle : null"
            @grab="beginDrag"
            @toggle-mode="onToggleMode"
            @resize="store.setCardHeight"
            @commit="() => void store.commitCards()"
          >
            <component :is="CARDS[id].component" />
          </BoardCard>
        </template>

        <div
          v-if="gapRenderIndex(column) === cardsIn(column).length"
          class="col__gap"
          :data-gap-index="dropTarget?.index ?? 0"
          :style="{ height: `${gapHeight}px` }"
        />

        <!-- 编辑态的空栏也要看得见，否则卡片没地方拖 -->
        <div v-if="editing && !cardsIn(column).length" class="col__empty">
          {{ columnLabel[column] }}为空<br />把卡片拖到这里
        </div>
      </section>

      <!-- 栏宽把手：夹在左 / 中、中 / 右之间 -->
      <span
        v-if="editing"
        class="col__resizer is-left"
        title="拖动调整左栏宽度"
        @pointerdown="onColumnResizeDown('left', $event)"
      />
      <span
        v-if="editing"
        class="col__resizer is-right"
        title="拖动调整右栏宽度"
        @pointerdown="onColumnResizeDown('right', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

/* 拖拽过程中别选中文字、别显示文本光标 */
.board.is-editing {
  user-select: none;
}

.board.is-dragging {
  cursor: grabbing;
}

/* ---------- 三栏 ---------- */

/*
 * 栏本身撑满可用高度，栏内再自己排：固定高度的卡片按像素、自适应卡片吃掉剩余高度。
 * 内容超出时由栏自己滚，这样 flex 卡片才有「剩余高度」可分。
 */
.board__columns {
  position: relative;
  display: grid;
  align-items: stretch;
  gap: var(--card-gap, 14px);
  flex: 1 1 auto;
  min-height: 0;
}

.col {
  display: flex;
  flex-direction: column;
  gap: var(--card-gap, 14px);
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

/* 空栏只是一个虚线投放区 */
.col.is-empty {
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.col__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 120px;
  padding: var(--sp-4);
  text-align: center;
  font-size: var(--fs-meta);
  line-height: 1.8;
  color: var(--ink-3);
}

/*
 * 落点空隙：不画任何东西，只把位置空出来（等于卡片会被放下的地方）。
 * 拖动中的卡片本身就跟着指针，所以这里再画一个框就是重复表达了。
 */
.col__gap {
  flex-shrink: 0;
}

/* ---------- 栏宽把手 ---------- */
/*
 * 热区是栏间空隙里一条通高的窄条（缝线任意位置都能拖），看得见的只有正中间那个小竖条：
 * 卡片下沿的高度把手（34×8）旋转 90°，常显，不用 hover 才把边界画出来。
 * 竖条宽 8px，窄于栏间空隙，两端都落在缝线里，不会压到两侧卡片。
 */
.col__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
  width: 10px;
  cursor: ew-resize;
}

.col__resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 8px;
  height: 34px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--ink);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  transition: background 0.15s ease;
}

/* 指针落到缝线上就把小竖条填实，提示这条缝可以拖 */
.col__resizer:hover::after {
  background: var(--ink);
}

/* 边界线落在栏间空隙的中线上：热区宽 10px，从「栏宽 + 间距/2」再往回让半个热区 */
.col__resizer.is-left {
  left: calc(var(--left-w) + var(--card-gap, 14px) / 2 - 5px);
}

.col__resizer.is-right {
  right: calc(var(--right-w) + var(--card-gap, 14px) / 2 - 5px);
}
</style>
