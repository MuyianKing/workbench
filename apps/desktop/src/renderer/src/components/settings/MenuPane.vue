<script setup lang="ts">
import type { HomeCardId, ViewId } from '@workbench/appearance'

import { HOME_CARD_IDS, HOME_CARD_LABELS, VIEW_IDS } from '@workbench/appearance'

import { moveToPosition } from '@workbench/core'
/**
 * 设置 · 菜单：应用自己的入口留哪几个、按什么先后（与「这一页长什么样」无关，所以单独一屏）。
 *
 * 首页那一页自带九块卡片（卡片只属于首页），它的开关下面挂一层子项；
 * 除首页以外的页可以按住拖动换位（顺序落盘在 viewOrder，见 shared/views.ts）。
 * 首页不参与这一组：它是默认页、也是布局编辑的落点，钉在导航栏最上面。
 */
import { computed, ref } from 'vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()

/**
 * 「只剩它一个了」：这颗开关不给关。
 *
 * 收敛那一层也会拦（导航栏至少留一页、首页至少留一块，见 shared/views.ts 与 shared/theme.ts），
 * 但在这里先拦一道，用户看到的是「点了没反应但按钮是灰的」，而不是「关掉之后它自己又开了」。
 */
function isOnlyVisible(all: readonly string[], hidden: readonly string[], id: string): boolean {
  return !hidden.includes(id) && all.every(item => item === id || hidden.includes(item))
}

const hiddenViews = computed(() => settings.settings.hiddenViews)

function setViewVisible(id: ViewId, visible: boolean): void {
  void settings.setViewVisible(id, visible)
}

const hiddenCards = computed(() =>
  HOME_CARD_IDS.filter(id => settings.themeConfig.cards[id].hidden),
)

function setCardVisible(id: HomeCardId, visible: boolean): void {
  void settings.setCardVisible(id, visible)
}

// ---------- 导航栏拖动排序 ----------

/**
 * 菜单那一屏的导航项可以按住拖动换位。
 *
 * 拖动是「跟手重排、收手落盘」：过程中只改本地那份 dragOrder 让清单实时换位，
 * 松手才送 store，Esc（或没动过）就地丢弃 —— 与首页卡片拖动、栏宽拖动同一套做法。
 */
const dragOrder = ref<ViewId[] | null>(null)
const draggingView = ref<ViewId | null>(null)

/** 清单按什么顺序画：拖动期间用本地那份，平时跟设置走 */
const sortableViews = computed<ViewId[]>(() => {
  const visible = settings.settings.viewOrder.filter(id => id !== 'home')
  return dragOrder.value ?? visible
})

const picksEl = ref<HTMLElement | null>(null)

/**
 * 拖动开始时算出的那几个**槽位**（网格里每一格的位置与大小），下标与 dragOrder 一一对应。
 *
 * 落点必须按槽位算，不能按「指针底下现在是哪一项」算：换位动画期间元素是滑过去的，
 * 指针下面那一刻可能还压着旧的那一项，于是刚换过去又换回来，清单会来回横跳。
 *
 * 槽位由容器位置 + 布局尺寸推出来，而不是量每一项的 getBoundingClientRect ——
 * 后者在动画期间拿到的是「飞在半路」的位置。容器自己的 rect 与 offsetWidth / Height
 * 都是布局值，不受 transform 影响，所以量一次、整次拖动都准。
 */
let slotRects: Array<{ left: number, top: number, width: number, height: number }> = []

function measureSlots(count: number): void {
  const el = picksEl.value
  const first = el?.querySelector<HTMLElement>('.pick--sortable')
  if (!el || !first) {
    slotRects = []
    return
  }

  const style = getComputedStyle(el)
  const columnGap = Number.parseFloat(style.columnGap) || 0
  const rowGap = Number.parseFloat(style.rowGap) || 0
  const box = el.getBoundingClientRect()
  const width = first.offsetWidth
  const height = first.offsetHeight
  // 一格占多宽由网格列数决定（现在是单列），不写死：容器宽度里塞得下几列就算几列
  const columns = Math.max(1, Math.round((box.width + columnGap) / (width + columnGap)))

  slotRects = Array.from({ length: count }, (_, index) => ({
    left: box.left + (index % columns) * (width + columnGap),
    top: box.top + Math.floor(index / columns) * (height + rowGap),
    width,
    height,
  }))
}

/** 指针落在第几个槽位：落在格子里就是它，落在格子之间的缝里取中心最近的那个 */
function slotAt(x: number, y: number): number {
  let nearest = 0
  let nearestDistance = Infinity

  slotRects.forEach((rect, index) => {
    const inside
      = x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
    const dx = x - (rect.left + rect.width / 2)
    const dy = y - (rect.top + rect.height / 2)
    const distance = inside ? 0 : dx * dx + dy * dy
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = index
    }
  })

  return nearest
}

function beginViewDrag(event: PointerEvent, id: ViewId): void {
  // 开关自己要点按：从它上面起手不算拖动
  if ((event.target as HTMLElement).closest('.el-switch'))
    return

  const original = [...sortableViews.value]
  measureSlots(original.length)
  draggingView.value = id
  dragOrder.value = original

  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-sorting-views',
    onMove(moveEvent) {
      const order = dragOrder.value
      if (!order || slotRects.length !== order.length)
        return

      // 挪到指针所在槽位「现在」装的那一项的位置上；那已经是自己时就什么都不做（不横跳）
      const target = order[slotAt(moveEvent.clientX, moveEvent.clientY)]
      if (!target)
        return
      dragOrder.value = moveToPosition(order, id, target) ?? order
    },
    onEnd(_last, cancelled) {
      const final = dragOrder.value
      draggingView.value = null
      slotRects = []
      if (cancelled || !final || final.join(',') === original.join(',')) {
        dragOrder.value = null
        return
      }
      // 本地顺序先留着，等设置回推再撒手：落盘走一趟 IPC，先清掉的话清单会闪回旧顺序一瞬
      void settings.setViewOrder(['home', ...final]).then(() => {
        if (dragOrder.value === final)
          dragOrder.value = null
      })
    },
  })
}
</script>

<template>
  <section class="pane">
    <div class="block">
      <h3 class="block__title">
        左侧导航栏
      </h3>
      <p class="row__hint menu-hint">
        按住一项拖动可调整它在导航栏上的先后；首页固定在最上面。
      </p>

      <!--
        首页那一页自带九块卡片（卡片只属于首页），所以它的开关下面挂一层子项：
        父子关系一眼看得出来 —— 上面那一页关掉，卡片跟着一起从首页上消失。
        两块清单都至少留一项：最后一个开关是禁用的（页面留首页，卡片留第一块）。
      -->
      <div class="pick">
        <span class="pick__name">首页</span>
        <el-switch
          :model-value="!hiddenViews.includes('home')"
          size="small"
          :disabled="isOnlyVisible(VIEW_IDS, hiddenViews, 'home')"
          @update:model-value="(value: unknown) => setViewVisible('home', Boolean(value))"
        />
      </div>

      <div class="picks picks--nested">
        <div v-for="id in HOME_CARD_IDS" :key="id" class="pick">
          <span class="pick__name">{{ HOME_CARD_LABELS[id] }}</span>
          <el-switch
            :model-value="!settings.themeConfig.cards[id].hidden"
            size="small"
            :disabled="isOnlyVisible(HOME_CARD_IDS, hiddenCards, id)"
            @update:model-value="(value: unknown) => setCardVisible(id, Boolean(value))"
          />
        </div>
      </div>

      <!--
        除首页以外的页：这一组可以按住拖动换位（落点按槽位算，见 beginViewDrag）。
        TransitionGroup 不加 tag：它只负责在重排时给移动的那几项挂 -move 类（见样式），
        网格容器仍是外面那个 .picks。
      -->
      <div ref="picksEl" class="picks">
        <TransitionGroup name="pick">
          <div
            v-for="id in sortableViews"
            :key="id"
            class="pick pick--sortable"
            :class="{ 'is-dragging': draggingView === id }"
            @pointerdown="beginViewDrag($event, id)"
          >
            <span class="pick__name">{{ settings.viewLabelOf(id) }}</span>
            <el-switch
              :model-value="!hiddenViews.includes(id)"
              size="small"
              :disabled="isOnlyVisible(VIEW_IDS, hiddenViews, id)"
              @update:model-value="(value: unknown) => setViewVisible(id, Boolean(value))"
            />
          </div>
        </TransitionGroup>
      </div>
    </div>
  </section>
</template>

<style scoped>
/**
 * 开关清单（导航栏那几页，以及首页下面挂的九块卡片）：树形，一行一项 ——
 * 首页的九块卡片缩进挂它下面，其余页与首页同层平铺。
 * 每项是一小块浅底，名字在左、开关贴右，与上面那些 row 的行内控件同一个右边缘。
 */
.picks {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.pick {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-width: 0;
  padding: 4px var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
}

.pick__name {
  font-size: var(--fs-meta);
  color: var(--ink);
}

/* 提示行：标题与清单之间的那道间距由标题自己的下边距给，这里不再叠一层 */
.menu-hint {
  margin: 0 0 var(--sp-2);
}

/**
 * 可拖的导航项：抓手光标说明「这一块能按住拖」；
 * 拖动中的那块浮起来（描边加重 + 卡片投影），跟手重排时好认出它落在哪。
 */
.pick--sortable {
  cursor: grab;
}

.pick--sortable.is-dragging {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}

/**
 * 换位时「滑过去」而不是「跳过去」：TransitionGroup 重排时会给移动的那几项挂上
 * .pick-move，Vue 自己算好位移差（FLIP），这里只给一条 transform 过渡。
 * 拖动中会连着换好几次位，时长压到 140ms —— 再长会跟不上手。
 */
.pick-move {
  transition: transform 0.14s var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  .pick-move {
    transition: none;
  }
}

/**
 * 首页那一页下面的那层卡片：子项缩进 + 一条竖线，父子关系不用读文字就看得出；
 * 一行一项，整段树形与上面的清单同一个宽度。
 */
.picks--nested {
  margin-top: var(--sp-2);
  margin-left: var(--sp-4);
  padding-left: var(--sp-3);
  border-left: 2px solid var(--border);
}
</style>
