<script setup lang="ts">
/**
 * 截图遮罩：一块铺满屏幕的「冻结画面」，在上面选一块、画几笔、然后复制 / 保存 / 钉图。
 *
 * ## 画布怎么分
 *
 * - **stage**（可见的那块）：冻结的那一帧 + 选区之外的暗层 + 标注 + 选区与把手 + 十字线。
 *   每次变化整块重画。重画是「一次 drawImage 加几十条路径」，即使 4K 也是毫秒级；
 *   换来的是马赛克能就地读像素（它读的就是这块画布，与导出那张图完全同源）。
 * - **sampler**（不进 DOM）：只有那帧原图的干净副本，专门给放大镜旁边的像素读数取样
 *   —— 从 stage 上取会取到暗层，颜色就不准了。**现用现做**（第一次取色时才画），
 *   它是「鼠标动起来之后」才用得上的东西，不该挡在开场那一下上。
 *
 * 那一帧的字节**从 Rust 走 base64 拿到、自己解成 Blob**（见 `capture_frame` 的说明）：
 * 走 asset 协议会把画布污染掉，`getImageData` 与 `toBlob` 都会抛 —— 放大镜取色、
 * 马赛克、复制 / 保存 / 钉图整条链都靠这两个调用。base64 交给浏览器自己解
 * （`fetch` 一个 data: URL），几兆的图走 atob 再逐字节搬家是几十毫秒的 JS 循环。
 *
 * ## 开场
 *
 * **这一屏的 JS 一场只跑一次**：遮罩窗口是 Rust 预建、跨场复用的（见 docs/modules/screenshot.md），
 * 每开一场由 `capture:sync` 叫醒（`beginSession`），上一场的选区 / 标注 / 撤销栈在 `reset` 里丢掉。
 * 换场不重建窗口，是因为建一块 WebView2 比按热键的整个预算还贵。
 *
 * ## 坐标
 *
 * 画布像素 = 这块屏的物理像素（见 coords.ts 的文件头）：画布的 backing store 就是它，
 * CSS 尺寸交给 `width: 100%` 按屏的缩放算。**鼠标事件一律经 `viewportToCanvas` 换算**，
 * 不自己乘 devicePixelRatio —— 那个值跨屏时会变。
 *
 * ## 显示与导出同一条路
 *
 * 标注一律按**这一帧的绝对坐标**存与画，而且**两侧都在整帧尺寸的画布上画**：显示侧是那块 stage
 * （只把标注 clip 到选区），导出侧先在同样大的画布上画完、最后才把选区抠出来。两边共用同一个
 * `drawAnnotations`、画布尺寸也一致，所以看到什么就存下来什么 —— 抗锯齿与马赛克的块色都逐像素一致。
 * **别改回「只在选区那么大的画布上平移到选区坐标系再画」**：画布尺寸与原点的小数部分一变，
 * 马赛克的块色会差几个点、普通标注的抗锯齿也会差一点（两样都踩过）。
 */
import type { Annotation, AnnotationTool, CaptureContext, Point, Rect } from '@/types'
import {
  ANNOTATION_COLOR_DEFAULT,
  ANNOTATION_TOLERANCE,
  annotationBounds,
  canvasToViewport,
  clampRect,
  defaultCaptureName,
  fromDrag,
  growRect,
  HANDLE_TOLERANCE,
  handleCursor,
  handlePoint,
  historyCanRedo,
  historyCanUndo,
  historyInit,
  historyPush,
  historyRedo,
  historyUndo,
  hitHandle,
  hitTestAnnotations,
  initialPinSize,
  MAGNIFIER_SIDE,
  MAGNIFIER_ZOOM,
  MIN_SELECTION,
  MOSAIC_BLOCK_DEFAULT,
  moveAnnotation,
  readableInkOn,
  rectContains,
  rectIsEmpty,
  rectSizeText,
  resizeByHandle,
  rgbToHex,
  splitPath,
  STROKE_WIDTH_DEFAULT,
  TEXT_SIZE_DEFAULT,
  viewportToCanvas,
} from '@workbench/capture'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { drawAnnotation, drawAnnotations, measureTextBlock } from './annotation-render'
import CaptureMagnifier from './CaptureMagnifier.vue'
import CaptureToolbar from './CaptureToolbar.vue'

const context = ref<CaptureContext | null>(null)
const monitor = computed(() => context.value?.monitor ?? null)
const options = computed(() => context.value?.options ?? null)
const canvasSize = computed(() => ({
  width: monitor.value?.width ?? 0,
  height: monitor.value?.height ?? 0,
}))
/** 这块屏的缩放：把「看上去该多大」的尺寸（把手、容差、字号）换成物理像素 */
const scale = computed(() => monitor.value?.scale ?? 1)

const stage = ref<HTMLCanvasElement | null>(null)
const textInput = ref<HTMLInputElement | null>(null)
const bitmap = shallowRef<ImageBitmap | null>(null)
/** 干净副本，只给像素读数取样（见文件头） */
let sampler: HTMLCanvasElement | null = null

const selection = ref<Rect | null>(null)
const annotations = ref<Annotation[]>([])
const history = shallowRef(historyInit<Annotation[]>([]))
const activeTool = ref<AnnotationTool | null>(null)
const pickedAnnotation = ref<number | null>(null)
const color = ref(ANNOTATION_COLOR_DEFAULT)
const strokeWidth = ref(STROKE_WIDTH_DEFAULT)
const block = ref(MOSAIC_BLOCK_DEFAULT)
const textSize = ref(TEXT_SIZE_DEFAULT)

const cursor = ref<Point>({ x: 0, y: 0 })
const hovering = ref(false)
const pixelHex = ref('#000000')
const pixelInk = ref('#ffffff')
const pointerCursor = ref('crosshair')

const draft = shallowRef<Annotation | null>(null)
const textEditing = ref<{ at: Point, text: string } | null>(null)
const busy = ref(false)
const failure = ref('')

type DragMode = 'none' | 'create' | 'move-selection' | 'resize-selection' | 'draw' | 'move-annotation'
let mode: DragMode = 'none'
let dragOrigin: Point = { x: 0, y: 0 }
let dragSelection: Rect | null = null
let dragHandle: ReturnType<typeof hitHandle> = null
let dragAnnotation: Annotation | null = null
let draftPoints: Point[] = []
/** 上一次取样的像素：同一个格子不重复读（getImageData 要等 GPU 回读） */
let sampled: Point = { x: -1, y: -1 }

const hasSelection = computed(() => {
  const rect = selection.value
  return rect !== null && !rectIsEmpty(rect, MIN_SELECTION)
})

/** 正在拖出一块新选区（`mode === 'create'`）。见 `toolbarVisible` 的说明，它得是个响应式的 */
const creating = ref(false)

/**
 * 有选区就一直显示 —— **输入文字的时候也不收**：输入的位置就在选区里，收掉它等于连
 * 颜色 / 字号那一排一起藏了，想换个颜色得先把字打完。
 *
 * 例外：**拖出一块新选区的那一会儿不收**，松手才出现 —— 拖的时候它只会贴着右下角一路跳，
 * 看着比没有还乱（Snipaste 也是松手才出）。挪选区 / 拖把手不算：那时候它本来就在，
 * 收掉反而一闪。
 */
const toolbarVisible = computed(() => hasSelection.value && !creating.value)

// ---------- 启动 ----------

/** 这一屏跑了几场。连着两场挨得近时，靠它别让前一场那半截 await 覆盖掉后一场 */
let sessionSeq = 0
/** 取消 `capture:sync` 的订阅（窗口真被关掉时才用得上） */
let stopSync: (() => void) | null = null

/** 把上一场留下的东西全部丢掉 —— 窗口是复用的，下一场必须从干净状态开始 */
function reset(): void {
  bitmap.value?.close()
  bitmap.value = null
  sampler = null
  context.value = null
  selection.value = null
  annotations.value = []
  history.value = historyInit<Annotation[]>([])
  activeTool.value = null
  pickedAnnotation.value = null
  draft.value = null
  textEditing.value = null
  busy.value = false
  failure.value = ''
  mode = 'none'
  creating.value = false
  dragHandle = null
  dragAnnotation = null
  draftPoints = []
  sampled = { x: -1, y: -1 }
  hovering.value = false
  pixelHex.value = '#000000'
  pixelInk.value = '#ffffff'
  pointerCursor.value = 'crosshair'
  redraw()
}

/**
 * 跟当前这场会话对一次：取这一屏的上下文与那一帧、画到画布上，再让 Rust 把遮罩亮出来。
 *
 * 遮罩窗口是 Rust **预建好、跨场复用**的，所以这一屏的 JS 只在应用启动时跑一次；
 * 之后每开一场由 Rust 推一条 `capture:sync` 叫醒这里（见本文件开头与 screenshot.md）。
 * **`opening` 为假 = 收工那一条**：只把上一场的帧、选区与标注丢掉，不显示任何东西。
 *
 * **最后那一下 `showCapture` 是必需的**：Rust 等到「每一块屏都画好了」才显示遮罩，
 * 抢在帧前面显示就是先闪一块黑再出画面。编号用**上下文里带回来的那个** ——
 * 那是它真正画出来的那一场（起手补问那一次没有收到过 `capture:sync`）。
 */
async function beginSession(opening: boolean): Promise<void> {
  const token = (sessionSeq += 1)
  reset()

  if (!opening)
    return

  // 问不到会话 = 这一场在推事件与这次查询之间就结束了（连按两次热键那种）：什么都不显示
  const result = await window.workbench.captureContext()
  if (token !== sessionSeq || !result.ok || !result.data)
    return

  const id = result.data.session
  context.value = result.data
  try {
    await loadFrame()
    if (token !== sessionSeq)
      return
    await nextTick()
    redraw()
  }
  catch {
    // 读不出这一帧也要把遮罩亮出来：报错信息摆在用户眼前，好过按一下什么都没发生
    if (token === sessionSeq)
      failure.value = '这一帧读不出来'
  }
  if (token !== sessionSeq)
    return

  void window.workbench.showCapture(id)
}

onMounted(async () => {
  // 订阅**先**挂上，而且等它真的挂上：挂上之前可能已经开了一场，而那一场只推这一次
  stopSync = await window.workbench.onCaptureSync(id => void beginSession(id !== null))

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)

  // 再补问一次：订阅生效之前开的那一场由这里接住（没会话就问不到，安静收场）
  const current = await window.workbench.captureContext()
  if (current.ok && current.data)
    await beginSession(true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  stopSync?.()
  window.clearTimeout(copyNoteTimer)
  bitmap.value?.close()
})

async function loadFrame(): Promise<void> {
  const result = await window.workbench.captureFrame()
  if (!result.ok || !result.data)
    throw new Error(result.error ?? '这一帧读不出来')

  // base64 交给浏览器自己解：几兆的图走 atob 再逐字节搬进 Uint8Array 是几十毫秒的 JS 循环，
  // 而 data: URL 是原生解码（CSP 是 null，这条不被拦）。它同源，画布不会被污染 ——
  // 走 asset 协议才会（见 capture_frame 的说明）
  const response = await fetch(`data:image/png;base64,${result.data}`)
  bitmap.value = await createImageBitmap(await response.blob())
}

/**
 * 取样用的那张干净副本（放大镜取色与马赛克都从它读，见文件头）。
 *
 * **现用现做，不在 loadFrame 里做**：那一趟是把整帧再画一遍（4K 下十几毫秒），
 * 而「按下热键到看见画面」的预算很紧 —— 它属于「鼠标动起来之后才用得上」的东西，
 * 不该挡在开场那一下上。
 */
function samplerOf(): HTMLCanvasElement | null {
  if (sampler)
    return sampler
  const frame = bitmap.value
  if (!frame)
    return null

  const copy = document.createElement('canvas')
  copy.width = frame.width
  copy.height = frame.height
  copy.getContext('2d')?.drawImage(frame, 0, 0)
  sampler = copy
  return sampler
}

// ---------- 绘制 ----------

function stageContext(): CanvasRenderingContext2D | null {
  return stage.value?.getContext('2d') ?? null
}

function redraw(): void {
  const element = stage.value
  const frame = bitmap.value
  const ctx = stageContext()
  if (!element || !ctx)
    return

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, element.width, element.height)
  if (!frame)
    return

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(frame, 0, 0)

  const rect = selection.value
  const live = rect !== null && !rectIsEmpty(rect, MIN_SELECTION)

  // 选区之外压一层暗：选中的那块保持原亮度，一眼看出「要截这一块」
  if (live) {
    // 标注：裁到选区，但**按这一帧的绝对坐标画** —— stage 上 (0, 0) 就是帧的左上角。
    // **不能在这里平移到选区坐标系**：只有导出那条路的 canvas 原点才是裁剪原点，
    // 显示侧再平移一次就多减了一个选区原点，笔迹整体偏向左上、被裁掉大半甚至完全看不见。
    // 传给 drawAnnotations 的 origin 只给马赛克用（把原图坐标换成设备坐标读像素）：
    // 显示侧画布与绝对坐标一一对应，所以是 (0, 0)。
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    drawAnnotations(ctx, annotations.value, { x: 0, y: 0 })
    if (draft.value)
      drawAnnotation(ctx, draft.value, { x: 0, y: 0 })
    ctx.restore()

    // 暗层**画在标注之后**：标注本来就裁在选区里，先后次序看不出来，但马赛克是从这块画布
    // 读像素取平均的 —— 暗层先画进去，贴着选区边打码的那几格就会把暗色平均进来（导出侧没有暗层，
    // 于是两边对不上）。放在后面，它读到的就是干净的一帧。
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.beginPath()
    ctx.rect(0, 0, element.width, element.height)
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.fill('evenodd')

    drawSelectionChrome(ctx, rect)
    drawSizeLabel(ctx, rect)

    const picked = pickedAnnotation.value === null ? null : annotations.value[pickedAnnotation.value]
    if (picked)
      drawPickedBox(ctx, annotationBounds(picked))
  }
  else if (!draft.value) {
    drawCrosshair(ctx)
  }
}

/** 选区边框 + 八个把手 */
function drawSelectionChrome(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.save()
  ctx.strokeStyle = '#409eff'
  ctx.lineWidth = 1
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1)

  const radius = Math.max(3, 4 * scale.value)
  ctx.fillStyle = '#ffffff'
  for (const id of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
    const point = handlePoint(rect, id)
    ctx.beginPath()
    ctx.rect(point.x - radius, point.y - radius, radius * 2, radius * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

/** 选区角上那颗「宽 × 高」读数 */
function drawSizeLabel(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const text = rectSizeText(rect)
  const size = 12 * scale.value
  const padding = 4 * scale.value

  ctx.save()
  ctx.font = `${size}px 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif`
  const width = ctx.measureText(text).width + padding * 2
  const height = size + padding * 2
  // 上方摆不下就摆到选区里面，别跑出屏幕
  const top = rect.y - height - 4 >= 0 ? rect.y - height - 4 : rect.y + 4
  const left = Math.min(rect.x, ctx.canvas.width - width)

  ctx.fillStyle = 'rgba(28, 30, 34, 0.92)'
  ctx.fillRect(left, top, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'top'
  ctx.fillText(text, left + padding, top + padding)
  ctx.restore()
}

/** 被选中那条标注的虚线框（好知道 Delete 会删掉哪一条） */
function drawPickedBox(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.save()
  ctx.setLineDash([4 * scale.value, 4 * scale.value])
  ctx.strokeStyle = 'rgba(64, 158, 255, 0.9)'
  ctx.lineWidth = 1
  const box = growRect(rect, 3 * scale.value)
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height)
  ctx.restore()
}

/** 还没选区时的十字线 */
function drawCrosshair(ctx: CanvasRenderingContext2D): void {
  if (!hovering.value)
    return
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(Math.round(cursor.value.x) + 0.5, 0)
  ctx.lineTo(Math.round(cursor.value.x) + 0.5, ctx.canvas.height)
  ctx.moveTo(0, Math.round(cursor.value.y) + 0.5)
  ctx.lineTo(ctx.canvas.width, Math.round(cursor.value.y) + 0.5)
  ctx.stroke()
  ctx.restore()
}

// ---------- 坐标 ----------

function viewportBox(): { left: number, top: number, width: number, height: number } {
  const box = stage.value?.getBoundingClientRect()
  return box
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : { left: 0, top: 0, width: canvasSize.value.width, height: canvasSize.value.height }
}

function toCanvas(event: PointerEvent | MouseEvent): Point {
  return viewportToCanvas({ x: event.clientX, y: event.clientY }, viewportBox(), canvasSize.value)
}

function fullRect(): Rect {
  return { x: 0, y: 0, width: canvasSize.value.width, height: canvasSize.value.height }
}

// ---------- 鼠标 ----------

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || busy.value)
    return
  event.preventDefault()

  // 先把上一段还没提交的文字落下来：点别处时输入框会失焦，而 `blur` 里再来提交时，
  // 这个 ref 可能已经被下面那段「文字工具点一下开新输入框」换成了空的一段
  // （踩过：打完字点一下别处，那几个字直接没了）
  commitText()

  const point = toCanvas(event)
  const rect = selection.value
  const live = rect !== null && !rectIsEmpty(rect, MIN_SELECTION)

  dragOrigin = point
  dragSelection = rect ? { ...rect } : null
  pickedAnnotation.value = null

  // **把手优先于「画」**：选着工具时按在选区四边 / 八个角上仍然是改尺寸，不是起笔
  // （鼠标形状本来就是这么给的，见 updateHoverCursor —— 不然想挪一下框得先把工具取消）
  if (live && rect) {
    const handle = hitHandle(rect, point, HANDLE_TOLERANCE * scale.value)
    if (handle) {
      mode = 'resize-selection'
      dragHandle = handle
      return
    }
  }

  // 文字：点一下就在那儿开一个输入框（不拖着画）
  if (live && activeTool.value === 'text') {
    textEditing.value = { at: point, text: '' }
    void nextTick(() => textInput.value?.focus())
    return
  }

  if (live && activeTool.value) {
    mode = 'draw'
    draftPoints = [point]
    draft.value = null
    return
  }

  if (live && rect) {
    const index = hitTestAnnotations(annotations.value, point, ANNOTATION_TOLERANCE * scale.value)
    if (index !== null) {
      pickedAnnotation.value = index
      dragAnnotation = annotations.value[index]
      mode = 'move-annotation'
      return
    }

    if (rectContains(rect, point)) {
      mode = 'move-selection'
      return
    }
  }

  // 没选区、或者点到了选区外面：从这里重新拖一块
  // （这一拖期间不收工具条，松手才出现，见 toolbarVisible）
  mode = 'create'
  creating.value = true
  selection.value = { x: point.x, y: point.y, width: 0, height: 0 }
}

function onPointerMove(event: PointerEvent): void {
  if (!context.value)
    return

  const point = toCanvas(event)
  cursor.value = point
  hovering.value = true
  updatePixelReadout()

  const delta = { x: point.x - dragOrigin.x, y: point.y - dragOrigin.y }

  switch (mode) {
    case 'create':
      selection.value = clampRect(fromDrag(dragOrigin, point), fullRect())
      break
    case 'move-selection':
      if (dragSelection) {
        selection.value = clampRect({
          ...dragSelection,
          x: dragSelection.x + delta.x,
          y: dragSelection.y + delta.y,
        }, fullRect())
      }
      break
    case 'resize-selection':
      if (dragSelection && dragHandle)
        selection.value = clampRect(resizeByHandle(dragSelection, dragHandle, delta), fullRect())
      break
    case 'draw':
      draft.value = buildDraft(point)
      break
    case 'move-annotation':
      if (dragAnnotation)
        draft.value = moveAnnotation(dragAnnotation, delta)
      break
    default:
      updateHoverCursor(point)
  }

  redraw()
}

function onPointerUp(): void {
  const finished = mode
  const rect = selection.value
  mode = 'none'
  creating.value = false
  dragHandle = null
  dragAnnotation = null

  if (finished === 'create' && rect && rectIsEmpty(rect, MIN_SELECTION)) {
    // 误点一下（没真拖）不该留一个 1×1 的选区
    selection.value = null
  }

  if (finished === 'draw' && draft.value) {
    const drawn = draft.value
    draft.value = null
    draftPoints = []
    commit([...annotations.value, drawn])
  }

  if (finished === 'move-annotation' && draft.value) {
    const moved = draft.value
    draft.value = null
    const index = annotations.value.findIndex(item => item.id === moved.id)
    if (index >= 0) {
      const next = [...annotations.value]
      next[index] = moved
      commit(next)
      pickedAnnotation.value = index
    }
  }

  redraw()
}

/**
 * 右键：**一次就取消整场截图**（与提示条上那句「右键取消」一致）。
 * 只清选区用 Esc —— 它才是逐层退的那一条。
 */
function onContextMenu(): void {
  cancel()
}

/** 双击：整屏（Snipaste 里最常用的那一下） */
function onDoubleClick(): void {
  if (mode !== 'none')
    return
  selection.value = fullRect()
  redraw()
}

/** 拖出来的那一笔（按当前工具成形） */
function buildDraft(point: Point): Annotation {
  const tool = activeTool.value ?? 'rect'
  const id = `a-${Date.now()}-${Math.round(point.x)}-${Math.round(point.y)}`

  if (tool === 'pen' || tool === 'highlight') {
    draftPoints = [...draftPoints, point]
    return { id, tool, points: draftPoints, color: color.value, width: strokeWidth.value }
  }

  if (tool === 'mosaic')
    return { id, tool, start: dragOrigin, end: point, block: block.value }

  // 文字不会走到这儿（它是点一下开输入框）；真走到了也按矩形收场
  const shape: 'rect' | 'ellipse' | 'arrow' = tool === 'ellipse' ? 'ellipse' : tool === 'arrow' ? 'arrow' : 'rect'
  return { id, tool: shape, start: dragOrigin, end: point, color: color.value, width: strokeWidth.value }
}

function updatePixelReadout(): void {
  const source = samplerOf()
  if (!source)
    return
  const x = Math.floor(cursor.value.x)
  const y = Math.floor(cursor.value.y)
  if (x === sampled.x && y === sampled.y)
    return
  sampled = { x, y }
  if (x < 0 || y < 0 || x >= source.width || y >= source.height)
    return

  try {
    const data = source.getContext('2d')?.getImageData(x, y, 1, 1).data
    if (!data)
      return
    const rgb = { r: data[0], g: data[1], b: data[2] }
    pixelHex.value = rgbToHex(rgb)
    pixelInk.value = readableInkOn(rgb)
  }
  catch {
    // 取样失败（画布被污染之类的意外）就把读数留着不动。
    // **这里绝不能往外抛**：它跑在 onPointerMove 的最前面，一抛整个拖拽就断了
    // （踩过一次：asset 协议的图污染画布，getImageData 抛 SecurityError，
    // 症状是「选区怎么拖都出不来」，而不是「读数不对」）
  }
}

/** 悬停时的指针形状：把手上是缩放、选区内是移动、其余是十字 */
function updateHoverCursor(point: Point): void {
  const rect = selection.value
  if (!rect || rectIsEmpty(rect, MIN_SELECTION)) {
    pointerCursor.value = activeTool.value === 'text' ? 'text' : 'crosshair'
    return
  }

  const handle = hitHandle(rect, point, HANDLE_TOLERANCE * scale.value)
  if (handle) {
    pointerCursor.value = handleCursor(handle)
    return
  }

  pointerCursor.value = activeTool.value
    ? 'crosshair'
    : rectContains(rect, point) ? 'move' : 'crosshair'
}

// ---------- 撤销栈 ----------

function commit(next: Annotation[]): void {
  history.value = historyPush(history.value, next)
  annotations.value = next
}

function undo(): void {
  if (!historyCanUndo(history.value))
    return
  history.value = historyUndo(history.value)
  annotations.value = history.value.present
  pickedAnnotation.value = null
  redraw()
}

function redo(): void {
  if (!historyCanRedo(history.value))
    return
  history.value = historyRedo(history.value)
  annotations.value = history.value.present
  pickedAnnotation.value = null
  redraw()
}

function deleteSelected(): void {
  const index = pickedAnnotation.value
  if (index === null)
    return
  pickedAnnotation.value = null
  commit(annotations.value.filter((_, position) => position !== index))
  redraw()
}

// ---------- 键盘 ----------

function onKeyDown(event: KeyboardEvent): void {
  if (textEditing.value)
    return

  const ctrl = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()

  // Shift：把当前像素的颜色写进剪贴板。**只在放大镜露着的时候认** —— 有选区时它让开了，
  // 那会儿的 Shift+方向键是「步进十格」，不该顺手往剪贴板里塞东西
  if (event.key === 'Shift') {
    if (magnifierVisible.value)
      void copyPixel()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    onEscape()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void finishWith(copy)
    return
  }
  if (ctrl && key === 'c') {
    event.preventDefault()
    void finishWith(copy)
    return
  }
  if (ctrl && key === 's') {
    event.preventDefault()
    void finishWith(save)
    return
  }
  if (ctrl && key === 'd') {
    event.preventDefault()
    void finishWith(pin)
    return
  }
  if (ctrl && key === 'z') {
    event.preventDefault()
    if (event.shiftKey)
      redo()
    else
      undo()
    return
  }
  if (ctrl && key === 'a') {
    event.preventDefault()
    selection.value = fullRect()
    redraw()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelected()
    return
  }
  if (event.key.startsWith('Arrow')) {
    event.preventDefault()
    nudge(event)
  }
}

/** Esc 逐层退：先收输入框，再收工具，再清选区，最后才是取消整场截图 */
function onEscape(): void {
  if (textEditing.value) {
    textEditing.value = null
    return
  }
  if (activeTool.value) {
    activeTool.value = null
    return
  }
  if (hasSelection.value) {
    selection.value = null
    pickedAnnotation.value = null
    redraw()
    return
  }
  cancel()
}

/** 方向键微调选区（按住 Shift 走十格） */
function nudge(event: KeyboardEvent): void {
  const rect = selection.value
  if (!rect || !hasSelection.value)
    return
  const step = event.shiftKey ? 10 : 1
  const delta = {
    x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
    y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
  }
  selection.value = clampRect({ ...rect, x: rect.x + delta.x, y: rect.y + delta.y }, fullRect())
  redraw()
}

// ---------- 文字输入 ----------

const textInputStyle = computed(() => {
  const editing = textEditing.value
  if (!editing)
    return {}
  const at = canvasToViewport(editing.at, viewportBox(), canvasSize.value)
  return {
    left: `${at.x}px`,
    top: `${at.y}px`,
    fontSize: `${textSize.value / scale.value}px`,
    color: color.value,
  }
})

function commitText(): void {
  const editing = textEditing.value
  textEditing.value = null
  if (!editing || !editing.text.trim())
    return

  const ctx = stageContext()
  if (!ctx)
    return

  // 尺寸量在画布像素上（与字号同一套），命中判定与选中框都靠它
  commit([...annotations.value, {
    id: `t-${Date.now()}`,
    tool: 'text',
    at: editing.at,
    text: editing.text,
    color: color.value,
    size: textSize.value,
    box: measureTextBlock(ctx, editing.text, textSize.value),
  }])
  redraw()
}

// ---------- 导出与动作 ----------

/** 选区那一块 + 标注，编成 PNG。画法与显示侧完全一致（见文件头） */
async function compose(): Promise<Blob | null> {
  const frame = bitmap.value
  const rect = selection.value
  if (!frame || !rect || !hasSelection.value)
    return null

  const crop = clampRect({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }, fullRect())
  const width = Math.max(1, Math.round(crop.width))
  const height = Math.max(1, Math.round(crop.height))

  // **先在整帧尺寸的画布上画**（与 stage 同一套：绝对坐标、不平移），最后才把选区那块抠出来。
  // 不能图省事只在「选区那么大」的画布上平移到选区坐标系再画：那样两边 canvas 尺寸与原点的
  // 小数部分都不一样，抗锯齿、马赛克那类要读像素 / 要缩放的画法会与屏幕上差一点点
  // （马赛克更明显：浏览器的缩放实现跟源画布尺寸有关，块色会差几个点）。
  const stage = document.createElement('canvas')
  stage.width = frame.width
  stage.height = frame.height
  const painter = stage.getContext('2d')
  if (!painter)
    return null
  painter.imageSmoothingEnabled = false
  painter.drawImage(frame, 0, 0)
  drawAnnotations(painter, annotations.value, { x: 0, y: 0 })

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return null
  ctx.drawImage(stage, crop.x, crop.y, width, height, 0, 0, width, height)

  try {
    return await new Promise<Blob | null>(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'))
  }
  catch {
    // 污染的画布上 toBlob 会同步抛 SecurityError（帧走 Blob 之后不该发生，兜住免得白屏）
    return null
  }
}

async function pngBase64(): Promise<string | null> {
  const blob = await compose()
  if (!blob)
    return null

  const bytes = new Uint8Array(await blob.arrayBuffer())
  // 一次转换的字节数有上限：几兆的图整串塞进 fromCharCode 会爆调用栈，分块来
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

async function copy(): Promise<void> {
  const png = await pngBase64()
  if (!png) {
    failure.value = '还没选好要截的区域'
    return
  }
  const result = await window.workbench.copyImage(png)
  if (!result.ok) {
    failure.value = result.error ?? '复制到剪贴板失败'
    return
  }
  await abort()
}

async function save(): Promise<void> {
  const png = await pngBase64()
  if (!png) {
    failure.value = '还没选好要截的区域'
    return
  }

  const name = defaultCaptureName(new Date())
  const dir = options.value?.saveDir ?? ''

  // 设过自动保存目录就直接落进去（同名自动加序号）；没设过才弹一次「另存为」
  if (dir) {
    const result = await window.workbench.saveImage(png, dir, name, true)
    if (!result.ok) {
      failure.value = result.error ?? '保存失败'
      return
    }
    await abort()
    return
  }

  const picked = await window.workbench.pickSavePath({
    title: '截图另存为',
    defaultPath: name,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  })
  if (!picked)
    return

  const parts = splitPath(picked)
  const result = await window.workbench.saveImage(png, parts.dir, parts.name, false)
  if (!result.ok) {
    failure.value = result.error ?? '保存失败'
    return
  }
  await abort()
}

async function pin(): Promise<void> {
  const png = await pngBase64()
  const rect = selection.value
  const frame = monitor.value
  if (!png || !rect || !frame) {
    failure.value = '还没选好要截的区域'
    return
  }

  const size = initialPinSize(
    { width: Math.round(rect.width), height: Math.round(rect.height) },
    { width: frame.width, height: frame.height },
  )
  // 钉图窗口就摆在选区原处：虚拟桌面物理坐标 = 这块屏的原点 + 选区在本屏的位置
  const result = await window.workbench.pinImage(
    png,
    frame.x + Math.round(rect.x),
    frame.y + Math.round(rect.y),
    size.width,
    size.height,
    options.value?.pinOpacity ?? 100,
  )
  if (!result.ok) {
    failure.value = result.error ?? '钉图失败'
    return
  }
  await abort()
}

/** 动作跑完就收工；跑的过程中按钮锁住，免得同一个动作发两次 */
async function finishWith(action: () => Promise<void>): Promise<void> {
  if (busy.value)
    return
  busy.value = true
  try {
    await action()
  }
  finally {
    busy.value = false
  }
}

function abort(): Promise<void> {
  return window.workbench.abortCapture()
}

function cancel(): void {
  void abort()
}

// ---------- 工具条摆位 ----------

const toolbarRef = ref<HTMLElement | null>(null)
const toolbarSize = ref({ width: 420, height: 78 })

const toolbarStyle = computed(() => {
  const rect = selection.value
  if (!rect)
    return {}

  const canvas = canvasSize.value
  // 量到的是 CSS 像素，选区的几何是画布像素（见 coords.ts）——**先换算成同一套**再算，
  // 不然「贴选区右边缘」会差出 (1/缩放 - 1) 个工具条宽度（踩过：右边戳出去一截）
  const size = {
    width: toolbarSize.value.width * scale.value,
    height: toolbarSize.value.height * scale.value,
  }
  const gap = 10 * scale.value

  // 优先贴选区下方；下面放不下翻到上面；上下都放不下就压进选区底部
  let top = rect.y + rect.height + gap
  if (top + size.height > canvas.height)
    top = rect.y - size.height - gap
  if (top < 0)
    top = Math.min(rect.y + rect.height - size.height - gap, canvas.height - size.height - gap)
  top = Math.max(gap, top)

  // 横向贴选区的**右边缘**（工具条摆在右下角，与 Snipaste 一致），再夹回画布内
  const right = rect.x + rect.width - size.width
  const left = Math.min(Math.max(right, gap), Math.max(gap, canvas.width - size.width - gap))
  const at = canvasToViewport({ x: left, y: top }, viewportBox(), canvas)
  return { left: `${at.x}px`, top: `${at.y}px` }
})

/** 工具条一渲染出来就量真实尺寸，摆位与翻面才判得准（第二排参数会改高度） */
function measureToolbar(): void {
  const element = toolbarRef.value
  if (element)
    toolbarSize.value = { width: element.offsetWidth, height: element.offsetHeight }
}

watch([toolbarVisible, activeTool, () => annotations.value.length], () => {
  void nextTick(measureToolbar)
})

// ---------- 放大镜 ----------

/** 复制失败时的一句话反馈（成功就直接收工了，没机会看卡片） */
const copyNote = ref('')
let copyNoteTimer: number | undefined

/**
 * 把放大镜当前的读数（十六进制）写进剪贴板 —— 这就是「取色」的出口：
 * 读数卡是画在遮罩上的文本，遮罩整页 `user-select: none`（防误选），选不中也拿不走。
 * WebView 里的 clipboard 可能被拦（失败还是静默的），所以成不成都在读数卡上说一句。
 */
async function copyPixel(): Promise<void> {
  const hex = pixelHex.value
  try {
    await navigator.clipboard.writeText(hex)
  }
  catch {
    // 失败就留在遮罩里：让人看清这一句、挪一下再按一次
    copyNote.value = '复制失败'
    window.clearTimeout(copyNoteTimer)
    copyNoteTimer = window.setTimeout(() => {
      copyNote.value = ''
    }, 1200)
    return
  }
  // 成功就收工：取色是一次性的动作，取完该回到原来的活儿上（不用再按一次 Esc）
  await abort()
}

const magnifierVisible = computed(() =>
  (options.value?.magnifier ?? true) && !hasSelection.value && hovering.value && failure.value === '',
)

const magnifierStyle = computed(() => {
  const box = viewportBox()
  const at = canvasToViewport(cursor.value, box, canvasSize.value)
  const total = MAGNIFIER_SIDE + 72
  const x = at.x + 24 + total > box.width ? at.x - 24 - total : at.x + 24
  const y = at.y + 24 + MAGNIFIER_SIDE + 46 > box.height ? at.y - 24 - MAGNIFIER_SIDE - 46 : at.y + 24
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` }
})

const magnifierPosition = computed(() => `(${Math.floor(cursor.value.x)}, ${Math.floor(cursor.value.y)})`)

const undoAble = computed(() => historyCanUndo(history.value))
const redoAble = computed(() => historyCanRedo(history.value))
</script>

<template>
  <div class="capture" :style="{ cursor: pointerCursor }">
    <canvas
      ref="stage"
      class="capture__stage"
      :width="canvasSize.width"
      :height="canvasSize.height"
      @pointerdown="onPointerDown"
      @contextmenu.prevent="onContextMenu"
      @dblclick="onDoubleClick"
      @pointerenter="hovering = true"
      @pointerleave="hovering = false"
    />

    <!--
      文字工具：点一下就在那儿开一个输入框，输入法、光标这些交给原生输入框。
      **回车不结输入**：中文输入法要用回车选词，认了就会把字打一半掐掉 ——
      结束靠点别处（blur 里提交，见 commitText）。
    -->
    <input
      v-if="textEditing"
      ref="textInput"
      v-model="textEditing.text"
      class="capture-text-input"
      :style="textInputStyle"
      @keydown.esc.stop.prevent="textEditing = null"
      @blur="commitText"
    >

    <div v-if="toolbarVisible" ref="toolbarRef" class="capture__toolbar" :style="toolbarStyle">
      <CaptureToolbar
        v-model:tool="activeTool"
        v-model:color="color"
        v-model:stroke-width="strokeWidth"
        v-model:block="block"
        v-model:text-size="textSize"
        :can-undo="undoAble"
        :can-redo="redoAble"
        :busy="busy"
        @undo="undo"
        @redo="redo"
        @cancel="cancel"
        @copy="finishWith(copy)"
        @save="finishWith(save)"
        @pin="finishWith(pin)"
      />
    </div>

    <div v-if="magnifierVisible" class="capture__magnifier" :style="magnifierStyle">
      <CaptureMagnifier
        :bitmap="bitmap"
        :cursor="cursor"
        :zoom="MAGNIFIER_ZOOM"
        :side="MAGNIFIER_SIDE"
        :pixel="pixelHex"
        :ink="pixelInk"
        :position="magnifierPosition"
        :note="copyNote"
      />
    </div>

    <!-- 这一屏没有别的说明渠道，还没选区时留一条，选上之后自动让开 -->
    <div v-if="!hasSelection && !failure" class="capture__hint">
      拖动选一块 · 双击整屏 · 右键取消 · Shift 取色
    </div>

    <div v-if="failure" class="capture__failure">
      {{ failure }}
    </div>
  </div>
</template>

<style scoped>
.capture {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.capture__stage {
  display: block;
  width: 100%;
  height: 100%;
  /* 选区与标注全靠它接事件；touch-action 关掉，免得被当成手势 */
  touch-action: none;
}

/*
 * 输入框长得**和落下去的字一模一样**：字号与颜色由行内 style 给（跟着当前档位走），
 * 这里把边框、底色、内边距全部去掉，只留一个光标。**不要给它加框或底色** ——
 * 那样提交的时候会看见一个框「收起」成纯色字，而这门功能要的就是所见即所得。
 */
.capture-text-input {
  position: absolute;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  /* 与画布上 fillText 的 textBaseline='top' 对齐：结束输入时字不跳 */
  line-height: 1;
  caret-color: #409eff;
  outline: none;
}

.capture__toolbar {
  position: absolute;
  cursor: default;
}

.capture__magnifier {
  position: absolute;
  pointer-events: none;
}

.capture__hint {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 6px;
  background: rgb(28 30 34 / 88%);
  color: #e6e8eb;
  font-size: 12px;
  pointer-events: none;
}

.capture__failure {
  position: absolute;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 14px;
  border-radius: 6px;
  background: rgb(160 40 40 / 94%);
  color: #fff;
}
</style>
