import { ref } from 'vue'
/**
 * 图表悬停：手写图表(柱状 / 折线)共用的「悬停落在第几格」交互骨架。
 *
 * 约定所有图表的数据点都按**等宽格**排布(格宽 = 容器宽 / 点数,点位在格中心,
 * `EtfFlowPanel` 的柱与 `EtfScalePanel` 的折线都是这个口径)——于是同一套换算:
 * `offsetX / width * count` 取整、夹回范围。竖直参考线与浮卡都从 `hoverIndex` 推。
 *
 * 事件由调用方挂在图表容器上(`@mousemove="onPlotMove"`),宽度从 `currentTarget`
 * 现量,不依赖外部传入的尺寸。
 */

/** 悬停落在第几格:取整后夹回范围;点数为零、宽度为零或坐标在容器左界之外给 `null` */
export function nearestPlotSlot(offsetX: number, width: number, count: number): number | null {
  if (count <= 0 || width <= 0 || offsetX < 0)
    return null
  return Math.min(Math.floor(offsetX / width * count), count - 1)
}

/** 一个图表的悬停状态:`count` 是点数的 getter(数据会变,别传值) */
export function usePlotHover(count: () => number) {
  const hoverIndex = ref<number | null>(null)
  /** 指针相对容器的横向位置(px),浮卡用它跟随 */
  const pointerX = ref(0)
  /** 容器宽度(px):浮卡夹边界要用,悬停期间随量随新 */
  const containerWidth = ref(0)

  function onPlotMove(event: MouseEvent): void {
    const box = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
    if (!box || box.width <= 0) {
      hoverIndex.value = null
      return
    }
    containerWidth.value = box.width
    pointerX.value = event.clientX - box.left
    hoverIndex.value = nearestPlotSlot(pointerX.value, box.width, count())
  }

  function onPlotLeave(): void {
    hoverIndex.value = null
  }

  return { hoverIndex, pointerX, containerWidth, onPlotMove, onPlotLeave }
}
