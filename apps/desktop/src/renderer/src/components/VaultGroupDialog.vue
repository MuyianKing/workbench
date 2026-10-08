<script setup lang="ts">
import { moveToPosition } from '@workbench/core'
/**
 * 「分组设置」弹框：一行一个分组，**按住一行拖**换先后、**右边那颗开关**决定它上不上卡片墙。
 *
 * 为什么收进一个弹框（而不是段头上那几颗内联控件）：分组是一份要管理的清单，
 * 而卡片墙是「用」的地方 —— 换先后、藏一组都是偶尔做一次的事，摆到每段头上，
 * 每一段都多出两颗只在悬停时显形的东西，墙上反而看不清有哪些组。
 * 这一屏的形状与「设置 · 菜单」那一屏的清单一致（行 + 开关 + 按住拖动），
 * 拖动那套也是同一个做法（`startPointerDrag` + 槽位 + FLIP）。
 *
 * 开关立刻生效（关掉 = 那一组整段不画、也不进搜索），拖动是「跟手重排、收手落盘」。
 * **未分组不在这里**：它是个兜底的口袋、永远垫底，也不该被藏起来（藏掉它，
 * 新加一条没归类的记录就等于凭空消失）—— 见 stores/vault.ts 的 hideGroup。
 */
import { computed, ref } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useVaultStore } from '@/stores/vault'

const store = useVaultStore()

/** 弹层开关：v-model 一条口径（与 AppDialog / el-dialog 相同） */
const visible = defineModel<boolean>({ required: true })

/** 拖动期间本地的那份顺序：只改它让清单实时换位，松手才落盘 */
const dragOrder = ref<string[] | null>(null)
const draggingGroup = ref('')

/** 清单按什么顺序画：拖动期间用本地那份，平时跟设置走 */
const groups = computed(() => dragOrder.value ?? store.orderedGroups)

const listEl = ref<HTMLElement | null>(null)

/**
 * 拖动开始时算出的那几个**槽位**（每一行的位置与大小），下标与清单一一对应。
 *
 * 落点必须按槽位算，不能按「指针底下现在是哪一行」算：换位动画期间元素是滑过去的，
 * 指针下面那一刻可能还压着旧的那一行，于是刚换过去又换回来，清单会来回横跳。
 * 槽位由容器位置 + 行高推出来，而不是逐行量 getBoundingClientRect ——
 * 后者在动画期间拿到的是「飞在半路」的位置（与设置里那份拖动同一个理由）。
 */
let slotRects: Array<{ left: number, top: number, width: number, height: number }> = []

function measureSlots(count: number): void {
  const el = listEl.value
  const first = el?.querySelector<HTMLElement>('.group-row')
  if (!el || !first) {
    slotRects = []
    return
  }

  const style = getComputedStyle(el)
  const rowGap = Number.parseFloat(style.rowGap) || 0
  const box = el.getBoundingClientRect()
  const width = first.offsetWidth
  const height = first.offsetHeight

  slotRects = Array.from({ length: count }, (_, index) => ({
    left: box.left,
    top: box.top + index * (height + rowGap),
    width,
    height,
  }))
}

/** 指针落在第几个槽位：落在行里就是它，落在行之间的缝里取中心最近的那个 */
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

function beginGroupDrag(event: PointerEvent, name: string): void {
  // 开关自己要点按：从它上面起手不算拖动
  if ((event.target as HTMLElement).closest('.el-switch'))
    return

  const original = [...groups.value]
  measureSlots(original.length)
  draggingGroup.value = name
  dragOrder.value = original

  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-sorting-groups',
    onMove(moveEvent) {
      const order = dragOrder.value
      if (!order || slotRects.length !== order.length)
        return

      // 挪到指针所在槽位「现在」装的那一行的位置上；那已经是自己时就什么都不做（不横跳）
      const target = order[slotAt(moveEvent.clientX, moveEvent.clientY)]
      if (!target)
        return
      dragOrder.value = moveToPosition(order, name, target) ?? order
    },
    onEnd(_last, cancelled) {
      const final = dragOrder.value
      draggingGroup.value = ''
      slotRects = []
      if (cancelled || !final || final.join(',') === original.join(',')) {
        dragOrder.value = null
        return
      }
      // 本地顺序先留着，等设置回推再撒手：落盘走一趟 IPC，先清掉的话清单会闪回旧顺序一瞬
      void store.setGroupOrder(final).then(() => {
        if (dragOrder.value === final)
          dragOrder.value = null
      })
    },
  })
}
</script>

<template>
  <AppDialog v-model="visible" title="分组设置" width="420">
    <!-- 一行一个分组：名字在左、开关贴右（与设置里那些清单同一副样子） -->
    <p class="hint">
      按住一行拖动可调整先后；开关关掉的那一组不在卡片墙上显示。
    </p>

    <div v-if="groups.length" ref="listEl" class="list">
      <TransitionGroup name="group-row">
        <div
          v-for="name in groups"
          :key="name"
          class="group-row"
          :class="{ 'is-dragging': draggingGroup === name }"
          @pointerdown="beginGroupDrag($event, name)"
        >
          <span class="group-row__name">{{ name }}</span>
          <el-switch
            :model-value="!store.hiddenGroups.includes(name)"
            size="small"
            @update:model-value="(value: unknown) => (value ? store.showGroup(name) : store.hideGroup(name))"
          />
        </div>
      </TransitionGroup>
    </div>

    <p v-else class="hint">
      还没有分组。分组是记录上那一栏自由文本，哪条记录填了新名字，这里就多一行。
    </p>
  </AppDialog>
</template>

<style scoped>
/**
 * 清单的形状与「设置 · 菜单」那一屏一致（一行一项、浅底、名字在左、开关贴右），
 * 换个页面不至于要重新认一遍。
 */
.list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--sp-2);
}

.group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-width: 0;
  padding: 4px var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  /* 抓手光标说明「这一行能按住拖」 */
  cursor: grab;
}

.group-row__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 拖动中的那一行浮起来（描边加重 + 卡片投影），跟手重排时好认出它落在哪 */
.group-row.is-dragging {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}

/**
 * 换位时「滑过去」而不是「跳过去」：TransitionGroup 重排时会给移动的那几行挂上
 * .group-row-move，Vue 自己算好位移差（FLIP），这里只给一条 transform 过渡。
 * 拖动中会连着换好几次位，时长压到 140ms —— 再长会跟不上手。
 */
.group-row-move {
  transition: transform 0.14s var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  .group-row-move {
    transition: none;
  }
}

.hint {
  margin: 0 0 var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.6;
}
</style>
