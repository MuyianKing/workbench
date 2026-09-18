<script setup lang="ts">
/**
 * 首页布局画布：若干栏并排，每栏里若干行上下摞，行里的卡片横向平分这一栏的宽度。
 *
 * 栏数与行数都是自己定的（编辑态里 ＋ 在右边拆一栏、✕ 收掉本栏；行则靠拖动分出来，
 * 见 shared/theme.ts 的 HomeColumn / HomeRow）：每栏宽度要么是一个像素值，要么是「自适应」
 * （与其余自适应栏平分剩余宽度），行高同样是固定像素 / 自适应两种。
 * 卡片落在哪一行、行内第几位都落在 theme.json 里。
 * 空栏平时不渲染（不占地方），编辑时才把所有栏都摆出来，好把卡片拖进去。
 *
 * 拖拽用指针事件，而且拖的就是卡片本身：超过阈值后卡片转为 position: fixed 跟着指针走，
 * 原位置不留下任何残影，落点处只留一段与卡片等大的空隙（不画框）。
 * 落点判两维：落在某张卡片的**上 / 下缘**＝在那一行旁边另起一行，落在**中间**＝并进这一行、
 * 按左右换位 —— 于是「中栏上面一张宽卡、下面三张并排」拖得出来，不必再设「拆行」按钮。
 */
import { computed, ref } from 'vue'
import type { Component, CSSProperties } from 'vue'
import {
  COLUMN_COUNT_MAX,
  COLUMN_COUNT_MIN,
  COLUMN_WIDTH_DEFAULT,
  HOME_CARD_LABELS,
  columnHasVisibleCards,
  columnOfRow,
  resizeColumnPair,
  rowBoxHeight,
  rowHeightMin,
  rowOf,
  visibleCardIdsInRow,
  type CardGrab,
  type ColumnId,
  type HomeCardId,
  type HomeColumn,
  type HomeRow,
  type RowId,
  type RowTarget
} from '@shared/theme'
import { useProjectsStore } from '@/stores/projects'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useSettingsStore } from '@/stores/settings'
import BoardCard from '@/components/BoardCard.vue'
import BoardRow from '@/components/BoardRow.vue'
import ActivityGraph from '@/components/ActivityGraph.vue'
import TokenPanel from '@/components/TokenPanel.vue'
import SystemPanel from '@/components/SystemPanel.vue'
import RecentPanel from '@/components/RecentPanel.vue'
import ActionsPanel from '@/components/ActionsPanel.vue'
import QuickLaunch from '@/components/QuickLaunch.vue'
import CommandPanel from '@/components/CommandPanel.vue'
import TodayWorkPanel from '@/components/TodayWorkPanel.vue'
import NewsPanel from '@/components/NewsPanel.vue'

const store = useProjectsStore()
const settings = useSettingsStore()

/** 九块卡片各自画什么；名字取自 shared 的 HOME_CARD_LABELS（设置里的卡片清单也用它） */
const CARDS: Record<HomeCardId, Component> = {
  activity: ActivityGraph,
  token: TokenPanel,
  system: SystemPanel,
  recent: RecentPanel,
  actions: ActionsPanel,
  quick: QuickLaunch,
  commands: CommandPanel,
  work: TodayWorkPanel,
  news: NewsPanel
}

const editing = computed(() => store.layoutEditing)

// ---------- 栏 / 行 / 卡片 ----------

const columns = computed<HomeColumn[]>(() => settings.themeConfig.columns)
const cards = computed(() => settings.themeConfig.cards)

/**
 * 一栏里要画的行：**连它在栏里的下标一起**给出来 —— 落点、占位都按那个下标算，
 * 而卡片全被关掉的行不画（位置留着，再打开时回到原处），两者的序号因此对不齐。
 */
function renderRows(column: HomeColumn): Array<{ row: HomeRow; index: number }> {
  return column.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => visibleCardIdsInRow(cards.value, row.id).length > 0)
}

/** 平时空栏不渲染；编辑时所有栏都在，好把卡片拖进去、也好拆拆收收 */
const visibleColumns = computed<HomeColumn[]>(() =>
  editing.value
    ? columns.value
    : columns.value.filter((column) => columnHasVisibleCards(cards.value, column))
)

/** 每栏占多宽：有像素宽度的按像素，自适应的与其余自适应栏平分剩下的宽度 */
const columnsStyle = computed(() => ({
  gridTemplateColumns: visibleColumns.value
    .map((column) => (column.width === null ? 'minmax(0, 1fr)' : `${column.width}px`))
    .join(' ')
}))

/** 画布本身：找某一栏的盒子、量它多宽都从这儿问 */
const boardEl = ref<HTMLElement | null>(null)

/**
 * 某一栏在页面上的盒子。
 *
 * 自适应栏没有存像素宽度，拖动时得现量它此刻有多宽 —— 而两种把手（栏里的、最后一栏那颗
 * 挂在画布上的）都得按 id 找回这一栏：挂在画布上的那颗，光看它自己的位置推不出栏宽。
 */
function columnTrack(id: ColumnId): HTMLElement | null {
  const wraps = boardEl.value?.querySelectorAll<HTMLElement>('.colwrap') ?? []
  return [...wraps].find((element) => element.dataset.column === id) ?? null
}

/**
 * 每条缝（两栏之间那条线）有没有手柄，按栏的索引对齐 —— `true` 表示第 i 栏的右边界可以拖。
 *
 * 手柄**属于缝，不属于某一栏**：一条缝就一颗，挂在它左边那一栏的右边界上。
 * 这样不会有「一栏左右各一颗」的歧义，也不会有哪一栏轮不到手柄 —— 每一条边界都能拖，
 * 每一栏因此都调得了（最后一栏靠它左边那条缝：往左拖，它变宽）。
 *
 * 两边都是自适应的缝没有手柄：那条缝怎么拖都改不了谁（两栏都是「剩下的部分」）。
 */
const seamHandles = computed<boolean[]>(() => {
  const list = visibleColumns.value
  return list.map(
    (column, index) => index < list.length - 1 && (column.width !== null || list[index + 1].width !== null)
  )
})

/** 手柄提示里说清这一下会改哪几栏（两边都固定时两栏一起变） */
function seamTitle(index: number): string {
  const list = visibleColumns.value
  const left = list[index]
  const right = list[index + 1]
  if (!left || !right) return '拖动调整栏宽'
  if (left.width !== null && right.width !== null) {
    return `拖动调整第 ${index + 1} 与第 ${index + 2} 栏的宽度（两栏一起变）`
  }
  return left.width !== null
    ? `拖动调整第 ${index + 1} 栏的宽度`
    : `拖动调整第 ${index + 2} 栏的宽度`
}

// ---------- 指针拖拽：换行 / 换栏 / 换位 ----------

/** 位移超过这个距离才算拖动，避免点一下没动也触发一次落盘 */
const DRAG_THRESHOLD = 4

/**
 * 上下缘那一带占一行高度的比例（最多 EDGE_MAX_PX）：落在这一带＝另起一行，
 * 落在中间＝并进这一行。行矮的时候按比例收，高的时候封顶，免得一行里只剩中间一小条能并排。
 */
const EDGE_RATIO = 0.3
const EDGE_MAX_PX = 40

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
const dropTarget = ref<RowTarget | null>(null)
/** 正在拖宽度的那几栏（拖动期间高亮它们，改的是哪几栏一眼看得出来） */
const resizingColumns = ref<ColumnId[]>([])

function beginDrag(id: HomeCardId, grab: CardGrab): void {
  if (!editing.value) return

  const placement = cards.value[id]
  const column = columnOfRow(columns.value, placement.row)
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
  dropTarget.value = column
    ? {
        column: column.id,
        rowIndex: column.rows.findIndex((row) => row.id === placement.row),
        newRow: false,
        index: visibleCardIdsInRow(cards.value, placement.row).indexOf(id)
      }
    : null

  // 起点用卡片上按下时记下的坐标（BoardCard 已经量过位置，这里只借它当原点）
  startPointerDrag({
    start: { x: grab.x, y: grab.y },
    onMove: onDragMove,
    onEnd: endDrag
  })
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

  // 指针下面是哪一栏哪一行（浮层已经 pointer-events: none，不会挡住判定）
  const target = targetAt(event.clientX, event.clientY)
  if (target) dropTarget.value = target
}

/** 指针落在哪儿：先认栏，再在该栏画出来的那些行里认「哪一行、落的哪儿」 */
function targetAt(x: number, y: number): RowTarget | null {
  const under = document.elementFromPoint(x, y)
  const columnEl = under?.closest<HTMLElement>('.col')
  const columnId = columnEl?.dataset.column as ColumnId | undefined
  if (!columnEl || !columnId) return null

  const column = columns.value.find((item) => item.id === columnId)
  if (!column) return null

  const dragged = drag.value?.id
  // 按 data-row 认行（行的类名是 .board-row，那是它自己的样式；这里要的是「哪一行」这个身份）
  const rows = [...columnEl.querySelectorAll<HTMLElement>('[data-row]')]

  // 这一栏一行都没画（卡片被关光了）：落点就是往这一栏末尾加一行
  if (!rows.length) return { column: columnId, rowIndex: column.rows.length, newRow: true, index: 0 }

  for (const rowEl of rows) {
    const rect = rowEl.getBoundingClientRect()
    const rowIndex = Number(rowEl.dataset.rowIndex)

    // 落在这一行上面（含行与行之间那条缝）：在它前面另起一行
    if (y < rect.top) return { column: columnId, rowIndex, newRow: true, index: 0 }
    if (y > rect.bottom) continue

    const edge = Math.min(rect.height * EDGE_RATIO, EDGE_MAX_PX)
    if (y < rect.top + edge) return { column: columnId, rowIndex, newRow: true, index: 0 }
    if (y > rect.bottom - edge) {
      return { column: columnId, rowIndex: rowIndex + 1, newRow: true, index: 0 }
    }
    return { column: columnId, rowIndex, newRow: false, index: indexInRow(rowEl, x, dragged) }
  }

  // 落在所有行下面（这一栏还没占满高度）：并到最后一行的末尾，与老版拖到栏底一样
  const last = rows[rows.length - 1]
  return {
    column: columnId,
    rowIndex: Number(last.dataset.rowIndex),
    newRow: false,
    index: indexInRow(last, x, dragged)
  }
}

/**
 * 行内插入位次：按指针落在该行哪张卡片的左半 / 右半。
 * 被拖的那张要排掉（它已经脱离文档流），占位空隙推开的位移也要减掉，
 * 否则指针停在分界线上时会出现「空隙推走卡片 → 落点回退」的抖动。
 */
function indexInRow(container: HTMLElement, x: number, dragged: HomeCardId | undefined): number {
  const rowCards = [...container.querySelectorAll<HTMLElement>('[data-card-id]')].filter(
    (el) => el.dataset.cardId !== dragged
  )

  const gap = container.querySelector<HTMLElement>('.row__gap')
  const gapIndex = gap ? Number(gap.dataset.gapIndex) : -1
  // 空隙宽度 + 它与相邻卡片之间的间距，都要从卡片位置上减掉（间距与 .row 的 gap 同源）
  const shift = gap ? gap.getBoundingClientRect().width + settings.cardGap : 0

  for (let i = 0; i < rowCards.length; i += 1) {
    const rect = rowCards[i].getBoundingClientRect()
    const left = shift && i >= gapIndex ? rect.left - shift : rect.left
    if (x < left + rect.width / 2) return i
  }
  return rowCards.length
}

function endDrag(last: PointerEvent | null): void {
  const state = drag.value
  const target = dropTarget.value

  drag.value = null
  dropTarget.value = null

  // last 为 null 表示被取消了（Esc / 系统接管）：不落盘
  if (state?.moved && last && target) void settings.moveCard(state.id, target)
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

// ---------- 落点占位 ----------

/** 画布上的一格：一行，或者「拖动要新开的那一行」占位 */
type Slot =
  | { kind: 'row'; key: string; row: HomeRow; index: number; cards: HomeCardId[]; gapIndex: number | null }
  | { kind: 'newRow'; key: string; height: number }

/**
 * 新开一行的占位有多高：那一行跟着被拖的卡片走（它原来多高，新行就多高），
 * 所以占位块与松手后的结果一般大，不会跳一下。
 */
const newRowHeight = computed(() => {
  const id = drag.value?.id
  if (!id) return 0
  const row = rowOf(columns.value, cards.value[id].row)
  if (!row) return 0
  return rowBoxHeight(row, rowHeightMin(cards.value, row.id))
})

/**
 * 一栏在画布上要画的东西：它画得出来的那些行，外加（要新开一行时）那一行的占位。
 * 占位插在「第一个下标不小于落点下标」的那一行前面 —— 落点算的是栏里的行下标，
 * 而卡片被关光的那种行不画，两边对不齐时以落点为准。
 */
function slotsOf(column: HomeColumn): Slot[] {
  const target = dropTarget.value
  const asNew = drag.value?.moved === true && target?.newRow === true && target.column === column.id
  const slots: Slot[] = []
  let placed = false

  for (const { row, index } of renderRows(column)) {
    if (asNew && !placed && target && target.rowIndex <= index) {
      slots.push({ kind: 'newRow', key: `new-${column.id}`, height: newRowHeight.value })
      placed = true
    }
    const ids = visibleCardIdsInRow(cards.value, row.id)
    slots.push({
      kind: 'row',
      key: row.id,
      row,
      index,
      cards: ids,
      gapIndex: gapRenderIndex(index, ids)
    })
  }

  if (asNew && !placed) slots.push({ kind: 'newRow', key: `new-${column.id}`, height: newRowHeight.value })
  return slots
}

/** 落点空隙插在这一行的第几张卡片之前（等于末尾时插在最后）；不在这一行就是 null */
function gapRenderIndex(index: number, ids: HomeCardId[]): number | null {
  const target = dropTarget.value
  const dragged = drag.value?.id
  if (drag.value?.moved !== true || !target || target.newRow || target.rowIndex !== index) return null

  // 落点序号是按「不含被拖卡片」的列表算的，映射回渲染序时要把它自己那一格让开
  const own = dragged ? ids.indexOf(dragged) : -1
  return target.index + (own !== -1 && target.index >= own ? 1 : 0)
}

// ---------- 栏宽拖动 ----------

/**
 * 拖两栏之间那条缝：往右拖 = 这条边界往右移。
 *
 * 两边都是固定宽度时**两栏一起改**（左栏 +dx、右栏 -dx，之和不变）—— 边界跟着指针走，
 * 别的栏一动都不动；只有一边固定时改那一栏（自适应那栏是「剩下的部分」，自己会让位）。
 * 最后一栏也是在这儿调：往左拖，它变宽、左边那栏变窄。
 */
function onSeamResizeDown(index: number, event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()

  const list = visibleColumns.value
  const left = list[index]
  const right = list[index + 1]
  if (!left || !right) return

  // 起点宽度在按下时就定死：拖动过程中本地一直在变，闭包里那两个对象才是这一手的起点
  const leftStart = left.width
  const rightStart = right.width
  let moved = false

  // 拖这条缝会改的栏一起高亮（见模板的 is-resizing）：改的是哪几栏，全程看得见
  resizingColumns.value = [left.id, right.id]

  // 跟手与收手的解绑交给 composable（含 pointercancel 与 Esc 取消）
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    onMove: (moveEvent, start) => {
      const dx = moveEvent.clientX - start.x
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return
      moved = true
      settings.setColumnWidths(seamWidths(left.id, leftStart, right.id, rightStart, dx))
    },
    onCleanup: () => {
      resizingColumns.value = []
    },
    onEnd: () => {
      if (moved) void settings.commitColumns()
    }
  })
}

/** 这一下拖动要把这条缝的两栏改成多宽（自适应那一侧不列进来，它自己会让位） */
function seamWidths(
  leftId: ColumnId,
  leftWidth: number | null,
  rightId: ColumnId,
  rightWidth: number | null,
  dx: number
): Record<ColumnId, number> {
  if (leftWidth !== null && rightWidth !== null) {
    const [left, right] = resizeColumnPair(leftWidth, rightWidth, dx)
    return { [leftId]: left, [rightId]: right }
  }
  if (leftWidth !== null) return { [leftId]: leftWidth + dx }
  return { [rightId]: (rightWidth ?? COLUMN_WIDTH_DEFAULT) - dx }
}

// ---------- 拆栏 / 收栏 / 切宽度模式 ----------

/** 拆分：在这一栏右边拆出一栏，宽度跟着它（自适应拆出自适应，两栏平分剩下的宽度） */
function addColumnAfter(column: HomeColumn): void {
  void settings.addColumn(column.id)
}

/** 收栏：栏里的行整条并到相邻那一栏（只剩一栏时按钮是禁用的） */
function removeColumn(column: HomeColumn): void {
  void settings.removeColumn(column.id)
}

/** 切换宽度模式；固定时取它此刻的显示宽度，切换前后那一栏看起来不动 */
function toggleColumnMode(column: HomeColumn): void {
  const current = columnTrack(column.id)?.getBoundingClientRect().width ?? COLUMN_WIDTH_DEFAULT
  void settings.toggleColumnMode(column.id, current)
}

function onToggleRowMode(id: RowId): void {
  void settings.toggleRowMode(id)
}
</script>

<template>
  <div ref="boardEl" class="board" :class="{ 'is-editing': editing, 'is-dragging': drag?.moved }">
    <div class="board__columns" :style="columnsStyle">
      <section
        v-for="(column, index) in visibleColumns"
        :key="column.id"
        class="colwrap"
        :class="{ 'is-resizing': resizingColumns.includes(column.id) }"
        :data-column="column.id"
      >
        <!-- 栏头只在编辑态出现：拆一栏 / 收一栏 / 切固定与自适应都在这儿 -->
        <div v-if="editing" class="colhead">
          <span class="colhead__name">第 {{ index + 1 }} 栏</span>
          <button
            class="colhead__btn"
            type="button"
            :title="
              column.width === null
                ? '当前自适应宽度，点一下固定成像素宽度'
                : '当前固定宽度，点一下改为自适应'
            "
            @click="toggleColumnMode(column)"
          >
            {{ column.width === null ? '自适应' : `${column.width}px` }}
          </button>
          <button
            class="colhead__btn"
            type="button"
            :disabled="columns.length >= COLUMN_COUNT_MAX"
            :title="`在这一栏右边拆出一栏（最多 ${COLUMN_COUNT_MAX} 栏）`"
            @click="addColumnAfter(column)"
          >
            ＋
          </button>
          <button
            class="colhead__btn"
            type="button"
            :disabled="columns.length <= COLUMN_COUNT_MIN"
            title="收掉这一栏，栏里的行并到相邻那一栏"
            @click="removeColumn(column)"
          >
            ✕
          </button>
        </div>

        <div class="col" :class="{ 'is-empty': !renderRows(column).length }" :data-column="column.id">
          <template v-for="slot in slotsOf(column)" :key="slot.key">
            <!-- 落点要新开一行：占一整行的空位（高度就是那一行将继承的高度） -->
            <div
              v-if="slot.kind === 'newRow'"
              class="col__gap"
              :style="{ height: `${slot.height}px` }"
            />

            <BoardRow
              v-else
              :row="slot.row"
              :index="slot.index"
              :min="rowHeightMin(cards, slot.row.id)"
              :editing="editing"
              @resize="settings.setRowHeight"
              @toggle-mode="onToggleRowMode"
              @commit="() => void settings.commitColumns()"
            >
              <template v-for="(id, cardIndex) in slot.cards" :key="id">
                <span
                  v-if="slot.gapIndex === cardIndex"
                  class="row__gap"
                  :data-gap-index="dropTarget?.index ?? 0"
                />

                <BoardCard
                  :id="id"
                  :title="HOME_CARD_LABELS[id]"
                  :editing="editing"
                  :floating-style="drag?.id === id ? floatingStyle : null"
                  @grab="beginDrag"
                >
                  <component :is="CARDS[id]" />
                </BoardCard>
              </template>

              <span
                v-if="slot.gapIndex === slot.cards.length"
                class="row__gap"
                :data-gap-index="dropTarget?.index ?? 0"
              />
            </BoardRow>
          </template>

          <!-- 编辑态的空栏也要看得见，否则卡片没地方拖 -->
          <div v-if="editing && !renderRows(column).length" class="col__empty">
            第 {{ index + 1 }} 栏为空<br />把卡片拖到这里
          </div>
        </div>

        <!--
          缝线手柄：一条缝一颗，挂在这条缝左边那一栏的右边界上（两栏之间就这一颗，
          不会出现「一栏左右各一颗」）。两边都是自适应的缝没有手柄 —— 拖它谁也改不了。
        -->
        <span
          v-if="editing && seamHandles[index]"
          class="col__resizer"
          :title="seamTitle(index)"
          @pointerdown="onSeamResizeDown(index, $event)"
        />
      </section>
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

/* ---------- 分栏 ---------- */

/*
 * 一栏两截：栏头（只有编辑态有，拆 / 收 / 切宽度在那儿）+ 栏本身。
 * 栏本身撑满剩下的高度，栏内再自己排：固定高度的行按像素、自适应行吃掉剩余高度。
 * 内容超出时由栏自己滚，这样 flex 行才有「剩余高度」可分。
 */
.board__columns {
  position: relative;
  display: grid;
  align-items: stretch;
  gap: var(--card-gap, 14px);
  flex: 1 1 auto;
  min-height: 0;
  /*
   * 栏数可以自己拆，固定宽度加起来就可能超出窗口。让它横向可滚，而不是把最右边那几栏
   * 裁在窗口外 —— 那样连栏头都够不着，收也收不掉，就成了死局（正常布局下这条不会出现）。
   */
  overflow-x: auto;
}

.colwrap {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  min-height: 0;
}

/*
 * 编辑态：每一栏都画一个底（连栏头一起），边界一眼看得见 —— 拖宽度时尤其是；
 * 平时不画，卡片之间的留白就是全部的层次。
 */
.board.is-editing .colwrap {
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--bg-subtle);
}

/* 正在调的那一栏：边框实心、底色再深一档，一直亮到松手 */
.board.is-editing .colwrap.is-resizing {
  border-style: solid;
  border-color: var(--ink);
  background: var(--bg-inset);
}

.col {
  display: flex;
  flex-direction: column;
  gap: var(--card-gap, 14px);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

/* ---------- 栏头（编辑态） ---------- */

.colhead {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  min-width: 0;
  font-size: var(--fs-micro);
}

.colhead__name {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 与行右上角那颗「固定高度 / 自适应」同一种小药丸 */
.colhead__btn {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 16px;
  cursor: pointer;
}

.colhead__btn:hover:not(:disabled) {
  border-color: var(--ink);
  color: var(--ink);
}

/* 到头了（栏数上限 / 只剩一栏）：按钮留个形，点不动 */
.colhead__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 空栏就是个投放区（编辑态的虚线框由所在的那一栏画，见 .board.is-editing .colwrap） */
.col.is-empty {
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
 * 落点空隙：不画任何东西，只把位置空出来。
 * 拖动中的卡片本身就跟着指针，所以这里再画一个框就是重复表达了。
 *
 * 栏里那条（另起一行）是纵向的一块，行里那条（并进这一行）是横向的一格 ——
 * 后者与卡片平分宽度，所以松手之后卡片占的位置与空隙一般大。
 */
.col__gap {
  flex-shrink: 0;
}

.row__gap {
  flex: 1 1 0;
  min-width: 0;
}

/* ---------- 缝线上的宽度手柄 ---------- */
/*
 * 一条缝一颗（见 seamHandles），挂在这条缝左边那一栏的右边界上。热区是缝线里一条通高的窄条
 * —— 缝线上任意位置都能拖，改的是这条边界（两边都固定时两栏一起变）。
 * 看得见的只有正中间那个小竖条：行下沿的高度把手（34×8）旋转 90°，常显，不用 hover 才画出来。
 * 竖条宽 8px，窄于栏间空隙，两端都落在缝线里，不会压到两侧卡片。
 */
.col__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 落在栏间空隙的中线上：从栏边缘往外让半个空隙，再往回让半个热区 */
  right: calc(-5px - var(--card-gap, 14px) / 2);
  z-index: 10;
  width: 10px;
  cursor: ew-resize;
}

/* 拖卡片时把手让开指针：落点判定要能照到底下的栏（见 onDragMove 的 elementFromPoint） */
.board.is-dragging .col__resizer {
  pointer-events: none;
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
</style>
