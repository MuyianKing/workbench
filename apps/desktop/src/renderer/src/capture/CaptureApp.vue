<script setup lang="ts">
import type { ScrollMatchResult, StitchFrame } from '@workbench/capture'
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
 * 那一帧的字节**从 Rust 走二进制 IPC 拿到、自己包成 Blob**（见 `capture_frame` 的说明）：
 * 走 asset 协议会把画布污染掉，`getImageData` 与 `toBlob` 都会抛 —— 放大镜取色、
 * 马赛克、复制 / 保存 / 钉图整条链都靠这两个调用。二进制字节包成 Blob 与页面同源，
 * 又不经过 base64 那一趟 33% 的体积与两次转换。
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
import type { Annotation, AnnotationStylePatch, AnnotationTool, CaptureContext, OcrLine, Point, Rect } from '@/types'
import {
  analyzeScrollOffset,
  ANNOTATION_COLOR_DEFAULT,
  ANNOTATION_TOLERANCE,
  annotationBounds,
  annotationHandles,
  autoToolbarPosition,
  bytesEqual,
  canvasToViewport,
  clampRect,
  clampToolbarPosition,
  defaultCaptureName,
  defaultToolStyles,
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
  hitAnnotationHandle,
  hitHandle,
  hitTestAnnotation,
  hitTestAnnotations,
  initialPinSize,
  layoutOcrSpans,
  MAGNIFIER_SIDE,
  MAGNIFIER_ZOOM,
  MAX_STITCH_HEIGHT,
  MIN_SCROLL_REGION_HEIGHT,
  MIN_SELECTION,
  MOSAIC_BLOCK_DEFAULT,
  moveAnnotation,
  planBand,
  planNotches,
  planTickDelay,
  readableInkOn,
  rectContains,
  rectIsEmpty,
  rectSizeText,
  resizeAnnotation,
  resizeByHandle,
  restyleAnnotation,
  rgbToHex,
  splitPath,
  STROKE_WIDTH_DEFAULT,
  TEXT_SIZE_DEFAULT,
  viewportToCanvas,
} from '@workbench/capture'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { drawAnnotation, drawAnnotations, measureTextSize, TEXT_LINE_HEIGHT } from './annotation-render'
import CaptureMagnifier from './CaptureMagnifier.vue'
import CaptureOcrBar from './CaptureOcrBar.vue'
import CaptureScrollBar from './CaptureScrollBar.vue'
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
const textInput = ref<HTMLTextAreaElement | null>(null)
const bitmap = shallowRef<ImageBitmap | null>(null)
/** 干净副本，只给像素读数取样（见文件头） */
let sampler: HTMLCanvasElement | null = null

const selection = ref<Rect | null>(null)
const annotations = ref<Annotation[]>([])
const history = shallowRef(historyInit<Annotation[]>([]))
const activeTool = ref<AnnotationTool | null>(null)
const pickedAnnotation = ref<number | null>(null)
/**
 * **刚画完、还没定稿的那一条**（松手 / 文字落下时设上；起下一笔、动别的标注、重选选区、
 * 撤销重做、删掉它时清掉）。
 *
 * 这是「松手不算定稿，去画下一个才算」那条口径的状态：它在的期间，**按在它身上是动它**
 * （有工具也一样，不是起一笔新的）、工具条参数那一排跟着它、改它不压撤销栈
 * （撤销一下整条连着刚才的微调一起退）。见 docs/modules/screenshot.md。
 */
const freshId = ref<string | null>(null)
const color = ref(ANNOTATION_COLOR_DEFAULT)
const strokeWidth = ref(STROKE_WIDTH_DEFAULT)
const block = ref(MOSAIC_BLOCK_DEFAULT)
const textSize = ref(TEXT_SIZE_DEFAULT)
/**
 * 每个工具自己的一份参数档位（见 @workbench/capture 的 tool-style）。参数一变就按工具条上
 * 正摆着的那个工具写回（`optionTool`，含选中 / 当前那条标注的工具），切工具时读回新工具那份。
 */
const toolStyles = defaultToolStyles()

const cursor = ref<Point>({ x: 0, y: 0 })
const hovering = ref(false)
const pixelHex = ref('#000000')
const pixelInk = ref('#ffffff')
const pointerCursor = ref('crosshair')

const draft = shallowRef<Annotation | null>(null)
const textEditing = ref<{ at: Point, text: string } | null>(null)
const busy = ref(false)
const failure = ref('')

// ---------- 取字（见 docs/modules/screenshot.md 的「取字」） ----------
//
// 认出来的行。**遮罩不收**：取完字还要回到遮罩里拖选、复制 —— 它是一个盖在画布上的
// 「模式」，Esc / 右键退出回到标注那套，不是一次动作。
const ocrLines = ref<OcrLine[] | null>(null)
/** 取字用的那块选区（取整后的画布像素）：文字层按它换算摆位 */
const ocrRect = ref<Rect | null>(null)
/** 文字层本体（全选要圈它的范围） */
const ocrLayer = ref<HTMLElement | null>(null)
/** 短暂失败提示的收尾（取字那几条都是「换一块再试」的事，不该一直挂着） */
let failureTimer: number | undefined

// ---------- 滚动截图（见 docs/modules/screenshot.md 的「滚动截图」） ----------
//
// 与取字一样是一个「模式」：遮罩不收，Esc / 右键退出回到标注那套。两个阶段：
// 点「滚动」直接开滚 —— run（遮罩对鼠标穿透，「发滚轮 → 等稳 → 抓帧 → 拼接」的循环
// 在这边跑，停止靠再按一次截图热键）→ result（控制条上复制 / 保存，选区里挂着长图预览）。
type ScrollPhase = 'run' | 'result'
interface ScrollState {
  phase: ScrollPhase
  /** 选区（取整后的画布像素）：循环里每次抓的就是这一块 */
  rect: { x: number, y: number, width: number, height: number }
  /** 已拼到的高度（画布像素）：进度读数与上限判定用 */
  stitched: number
  /** 跑了多少步：进度读数 */
  steps: number
  /** 拼不上的原因（result 相挂在尺寸前面），空 = 没有话要说 */
  note: string
}
const scrollState = ref<ScrollState | null>(null)
/** 拼好的长图（非响应式，进了 result 相才有）：复制 / 保存从它出 */
let scrollCanvas: HTMLCanvasElement | null = null
/** 热键停止（Rust 推 `capture:scroll-stop`）置上，循环每一轮检查 */
let scrollStopRequested = false
/** `capture:scroll-stop` 的订阅收尾（窗口真被关掉时才用得上） */
let stopScrollEvent: (() => void) | null = null

type DragMode = 'none' | 'create' | 'move-selection' | 'resize-selection' | 'draw' | 'move-annotation' | 'resize-annotation'
let mode: DragMode = 'none'
let dragOrigin: Point = { x: 0, y: 0 }
let dragSelection: Rect | null = null
let dragHandle: ReturnType<typeof hitHandle> = null
let dragAnnotation: Annotation | null = null
/** 拖的是选中标注身上的哪个把手（见 annotationHandles） */
let dragAnnotationHandle: ReturnType<typeof hitAnnotationHandle> = null
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

/**
 * 参数那一排照哪个工具摆（见 CaptureToolbar 的 optionTool）：**还在「当前」（freshId）期间
 * 就跟着那一条** —— 刚画完还没来得及挪 / 改大小时，改颜色 / 线宽 / 字号改的必须是它，
 * 不然参数排摆的是工具上一条留下的档位、看着像改了没生效；没在「当前」期间时：
 * 选着工具就是它自己，否则摆选中那条的工具。
 */
const optionTool = computed<AnnotationTool | null>(() => {
  if (freshId.value !== null) {
    const fresh = freshOf()
    if (fresh)
      return fresh.tool
  }
  if (activeTool.value)
    return activeTool.value
  return pickedOf()?.tool ?? null
})

/** 参数变了：写回工具条上正摆着的那个工具（那排没显示时 optionTool 为 null，不用记） */
function rememberStyle(): void {
  const tool = optionTool.value
  if (!tool)
    return
  toolStyles[tool] = {
    color: color.value,
    strokeWidth: strokeWidth.value,
    block: block.value,
    textSize: textSize.value,
  }
}

/** 切到这个工具：把它自己那一份档位读回来（在清掉选中之后调，免得顺带改到上一条标注） */
function recallStyle(tool: AnnotationTool): void {
  const style = toolStyles[tool]
  color.value = style.color
  strokeWidth.value = style.strokeWidth
  block.value = style.block
  textSize.value = style.textSize
}

watch([color, strokeWidth, block, textSize], rememberStyle)

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
  freshId.value = null
  draft.value = null
  textEditing.value = null
  busy.value = false
  failure.value = ''
  ocrLines.value = null
  ocrRect.value = null
  scrollState.value = null
  scrollCanvas = null
  scrollStopRequested = false
  window.clearTimeout(failureTimer)
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
  // 手动位置只记这一场：下一场回「贴选区右下角」的默认摆位（拖到一半换场就先收手）
  endToolbarDrag?.()
  toolbarManual.value = null
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
  // 滚动运行中按了截图热键：Rust 已把遮罩恢复成交互态，这里只标记「该停了」，
  // 循环每一轮自己查（不能就地动 scrollState —— 那是循环线程的活）
  stopScrollEvent = window.workbench.onScrollStop(() => {
    scrollStopRequested = true
  })

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
  // 拖到一半窗口被收走：window 上的拖动监听要收干净（composable 返回的就是收尾函数）
  endToolbarDrag?.()
  stopSync?.()
  stopScrollEvent?.()
  window.clearTimeout(copyNoteTimer)
  window.clearTimeout(failureTimer)
  bitmap.value?.close()
})

async function loadFrame(): Promise<void> {
  const result = await window.workbench.captureFrame()
  if (!result.ok || !result.data)
    throw new Error(result.error ?? '这一帧读不出来')

  // 帧走二进制 IPC 过来：直接包成 Blob 交给浏览器原生解 PNG（不再 base64 → data: URL）。
  // Blob 与页面同源，drawImage 进画布不会污染它 —— 走 asset 协议才会（见 capture_frame 的说明）。
  // 抓屏出来的 PNG 本来就没带色彩配置、按 sRGB 理解即可，跳过色彩空间转换这一趟
  bitmap.value = await createImageBitmap(new Blob([result.data], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
  })
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

/**
 * 画的时候那份清单：**把正被拖的那一条摘掉**。
 *
 * 拖动期间数组里还是它的**旧几何**（只有松手才写回，见 onPointerUp），而 `draft` 才是它现在的样子
 * —— 两份一起画，旧边就一直留在屏幕上（挪位置更明显：两个位置各一份）。
 * 显示与导出两条路都按这一份画、都补上 draft，看到什么就存下来什么（见文件头）。
 * 正在新画的那一笔不在数组里，`draft.id` 找不到，原样返回。
 */
function settledAnnotations(): Annotation[] {
  const dragged = draft.value?.id
  return dragged ? annotations.value.filter(item => item.id !== dragged) : annotations.value
}

function redraw(): void {
  const element = stage.value
  const frame = bitmap.value
  const ctx = stageContext()
  if (!element || !ctx)
    return

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, element.width, element.height)

  // 滚动模式换一副画法：不画冻结帧（要透出**实时**的内容，滚轮滚的是底下的真窗口）。
  // 选区**外**压一层暗（与标注模式同一口径的 evenodd 暗层）：一眼看出要滚的是哪块，
  // 选区内保持原亮度。洞的边缘落在整数像素上 —— 像素中心要么在洞里要么在洞外，
  // 抓帧抓不到半透明的过渡行。描边画在暗层**之后**（不被压灰），仍然画在矩形**外面**
  // （外扩 3.5px、线宽 3，离矩形边至少 2px）：抓帧抓的是矩形内部，画进里面就会把线
  // 拼进长图。
  if (scrollState.value) {
    const scroll = scrollState.value
    const rect = scroll.rect
    // 结果相把拼好的长图按比例画进选区 —— 「复制前先看一眼」是这类功能的基本预期
    // （run 相不画：那块要透出实时内容）。等比缩到选区以内、居中，长图整幅一眼可见
    if (scroll.phase === 'result' && scrollCanvas) {
      const image = scrollCanvas
      const scale = Math.min(rect.width / image.width, rect.height / image.height, 1)
      const width = image.width * scale
      const height = image.height * scale
      const x = rect.x + (rect.width - width) / 2
      const y = rect.y + (rect.height - height) / 2
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, x, y, width, height)
      ctx.imageSmoothingEnabled = false
      // 一圈细边让长图从实时内容里浮出来，边界一眼可见
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1)
    }

    // 选区外置灰：整块屏减去选区那块（evenodd），暗层压在实时内容上、选区内不碰
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.beginPath()
    ctx.rect(0, 0, element.width, element.height)
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.fill('evenodd')

    ctx.strokeStyle = '#409eff'
    ctx.lineWidth = 3
    ctx.strokeRect(rect.x - 3.5, rect.y - 3.5, rect.width + 7, rect.height + 7)
    return
  }

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
    drawAnnotations(ctx, settledAnnotations(), { x: 0, y: 0 })
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

    // 取字模式不画选区与标注的选中框：文字层盖在上面，那些框只会添乱
    if (!ocrLines.value) {
      drawSelectionChrome(ctx, rect)
      drawSizeLabel(ctx, rect)

      // 选中那条的样子：拖把手改大小时画的是**正被你拖的那一份**（draft），
      // 不然把手会留在旧的位置上、看着像没跟上
      const index = pickedAnnotation.value
      const picked = index === null ? null : annotations.value[index]
      const chrome = draft.value && picked && draft.value.id === picked.id ? draft.value : picked
      if (chrome)
        drawPickedChrome(ctx, chrome)
    }
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

/** 被选中那条标注的样子：虚线框 + 它自己的几个把手（见 annotationHandles） */
function drawPickedChrome(ctx: CanvasRenderingContext2D, annotation: Annotation): void {
  ctx.save()
  ctx.setLineDash([4 * scale.value, 4 * scale.value])
  ctx.strokeStyle = 'rgba(64, 158, 255, 0.9)'
  ctx.lineWidth = 1
  const box = growRect(annotationBounds(annotation), 3 * scale.value)
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height)
  ctx.setLineDash([])

  // 把手画法与选区那八个一致（白底 + 蓝框），白底要显眼，压在任意像素上都看得见
  const radius = Math.max(3, 4 * scale.value)
  for (const handle of annotationHandles(annotation)) {
    ctx.beginPath()
    ctx.rect(handle.point.x - radius, handle.point.y - radius, radius * 2, radius * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#409eff'
    ctx.stroke()
  }
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
  // 滚动模式整个画面只听控制条的：选区 / 标注那一套指针交互全部让开
  if (scrollState.value)
    return
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
  // 上一刻选中的那条先记下来：把手要在「清掉选中」之前判（压在把手上是改大小，不是重选）
  const picked = pickedAnnotation.value === null ? null : annotations.value[pickedAnnotation.value]
  pickedAnnotation.value = null

  // **把手优先于别的动作**（选区的把手、选中标注的把手都一样）：按在一个把手上就是改尺寸，
  // 不是起笔、也不是重选。选区的八个把手排在前面 —— 它们在最外圈，两者一般不会重叠。
  if (live && rect) {
    const handle = hitHandle(rect, point, HANDLE_TOLERANCE * scale.value)
    if (handle) {
      settleFresh()
      mode = 'resize-selection'
      dragHandle = handle
      return
    }
  }

  if (live && picked) {
    const handle = hitAnnotationHandle(picked, point, HANDLE_TOLERANCE * scale.value)
    if (handle) {
      pickedAnnotation.value = annotations.value.indexOf(picked)
      dragAnnotation = picked
      dragAnnotationHandle = handle
      mode = 'resize-annotation'
      return
    }
  }

  // **还在「当前」的那条：按在身上就是动它** —— 有工具也一样，它不是起一笔新的
  // （要它让位就去别处按一下、或者直接开始画下一个，见 freshId）。把手在上面已经判过了。
  if (live) {
    const fresh = freshOf()
    if (fresh && hitTestAnnotation(fresh, point, ANNOTATION_TOLERANCE * scale.value)) {
      pickedAnnotation.value = annotations.value.indexOf(fresh)
      dragAnnotation = fresh
      mode = 'move-annotation'
      return
    }
  }

  // 文字：点一下就在那儿开一个输入框（不拖着画）
  if (live && activeTool.value === 'text') {
    settleFresh()
    textEditing.value = { at: point, text: '' }
    textBoxSize.value = null
    void nextTick(() => {
      textInput.value?.focus()
      measureTextInput()
    })
    return
  }

  if (live && activeTool.value) {
    // **起下一笔 = 上一条定稿**（这就是「松手不定稿」的那一半：定稿的时刻在这儿）
    settleFresh()
    mode = 'draw'
    draftPoints = [point]
    draft.value = null
    return
  }

  if (live && rect) {
    const index = hitTestAnnotations(annotations.value, point, ANNOTATION_TOLERANCE * scale.value)
    if (index !== null) {
      // 点到的是别的一条：当前那条就此定稿，换到这一条上
      if (annotations.value[index].id !== freshId.value)
        settleFresh()
      pickedAnnotation.value = index
      dragAnnotation = annotations.value[index]
      mode = 'move-annotation'
      // 选中就把它自己的参数摆到工具条上：接着改颜色 / 线宽 / 字号改的是它（见 applyToPicked）
      adoptPickedStyle(annotations.value[index])
      return
    }

    if (rectContains(rect, point)) {
      settleFresh()
      mode = 'move-selection'
      return
    }
  }

  // 没选区、或者点到了选区外面：从这里重新拖一块
  // （这一拖期间不收工具条，松手才出现，见 toolbarVisible）
  settleFresh()
  mode = 'create'
  creating.value = true
  selection.value = { x: point.x, y: point.y, width: 0, height: 0 }
}

function onPointerMove(event: PointerEvent): void {
  if (!context.value || scrollState.value)
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
    case 'resize-annotation':
      if (dragAnnotation && dragAnnotationHandle)
        draft.value = resizeAnnotation(dragAnnotation, dragAnnotationHandle, delta)
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
  dragAnnotationHandle = null

  if (finished === 'create' && rect && rectIsEmpty(rect, MIN_SELECTION)) {
    // 误点一下（没真拖）不该留一个 1×1 的选区
    selection.value = null
  }

  if (finished === 'draw' && draft.value) {
    const drawn = draft.value
    draft.value = null
    draftPoints = []
    // **松手不等于定稿**：把它摆上去、记一步撤销，同时把它设成「当前」的那条 —— 选中、
    // 把手、参数排跟着它，按在身上还能接着挪 / 改大小 / 改参数，直到你去画下一条（见 freshId）
    commit([...annotations.value, drawn])
    pickedAnnotation.value = annotations.value.length - 1
    freshId.value = drawn.id
  }

  // 挪位置与改大小收工走同一条：把它换成 draft 里那条、记一步撤销，然后保持选中
  // （改完还想接着改 —— 工具条上的参数改的就是它）
  if ((finished === 'move-annotation' || finished === 'resize-annotation') && draft.value) {
    const changed = draft.value
    draft.value = null
    const index = annotations.value.findIndex(item => item.id === changed.id)
    if (index >= 0) {
      const next = [...annotations.value]
      next[index] = changed
      commitEdit(next, changed.id)
      pickedAnnotation.value = index
    }
  }

  redraw()
}

/**
 * 右键：**一次就取消整场截图**（与提示条上那句「右键取消」一致）。
 * 只清选区用 Esc —— 它才是逐层退的那一条。
 * 取字模式里右键先退那层（文字层自己接住了 contextmenu，这里兜的是没盖到的缝）。
 */
function onContextMenu(): void {
  // 滚动模式右键先退那层（与取字同一套逐层退），不是取消整场
  if (scrollState.value) {
    exitScroll()
    return
  }
  if (ocrLines.value) {
    exitOcr()
    return
  }
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

/** 悬停时的指针形状：把手上是缩放（选区与选中标注的把手都算）、选区内是移动、其余是十字 */
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

  // 选中那条的把手（改大小）：形状与选区一致，也是「按在把手上就是缩放」
  const picked = pickedOf()
  const pickedHandle = picked ? hitAnnotationHandle(picked, point, HANDLE_TOLERANCE * scale.value) : null
  if (pickedHandle) {
    pointerCursor.value = handleCursor(pickedHandle)
    return
  }

  // 当前那条身上（把手已经在上面判过了）：按下去是移动它，指针就给「移动」—— 有工具也一样
  const fresh = freshOf()
  if (fresh && hitTestAnnotation(fresh, point, ANNOTATION_TOLERANCE * scale.value)) {
    pointerCursor.value = 'move'
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

/**
 * 落一次改动：**改的是「当前」那条（还没定稿）就不压撤销栈** —— 它连同刚才那点微调算同一步，
 * 撤销一下整条一起退（这就是「松手不定稿」的另一半，见 freshId）；改的是早就定稿的那条就照旧记一步。
 */
function commitEdit(next: Annotation[], id: string): void {
  if (id !== freshId.value) {
    commit(next)
    return
  }
  // 只改 present：栈顶仍是「画它之前」那一份。future 一并清掉 —— 这也是一条新分支
  history.value = { ...history.value, present: next, future: [] }
  annotations.value = next
}

/** 当前那条（刚画完还没定稿的）；不在 / 已经被删掉时 null */
function freshOf(): Annotation | null {
  const id = freshId.value
  return id === null ? null : annotations.value.find(item => item.id === id) ?? null
}

/**
 * 定稿：当前那条就此交给撤销栈，按在身上不再算「动它」。
 * **每一个「去干别的」的分支都要叫一次**（起下一笔、开新输入框、动别的标注、重选选区…），
 * 它只清这个标记：选中 / 把手照旧留着，那条已经落地了，要动它得点选。
 */
function settleFresh(): void {
  freshId.value = null
}

/**
 * 换工具 = 上一条标注就此定稿、并且取消选中（**只在切到某个工具时**，切回 null 不算）。
 * 不然刚画完那条的虚线框与把手会一直留着，按在它身上会被判成「移动它」—— 选着文字工具时
 * 点在矩形里只想打字，却被拖走了（pointerdown 里 fresh 那条分支排在工具前面）。
 * 参数那一排这时也已经换成工具的档位，留着选中还会把改色错落到旧的那条上（见 applyToPicked）。
 * 「画完还能马上挪 / 改大小 / 改参数」不受影响：画完时 activeTool 没翻，fresh 照旧留着。
 * 选中清掉之后再把这个工具自己那一份档位读回来（见 recallStyle）。
 */
watch(activeTool, (next) => {
  if (next === null)
    return
  settleFresh()
  if (pickedAnnotation.value !== null) {
    pickedAnnotation.value = null
    redraw()
  }
  recallStyle(next)
})

function undo(): void {
  if (!historyCanUndo(history.value))
    return
  history.value = historyUndo(history.value)
  annotations.value = history.value.present
  pickedAnnotation.value = null
  freshId.value = null
  redraw()
}

function redo(): void {
  if (!historyCanRedo(history.value))
    return
  history.value = historyRedo(history.value)
  annotations.value = history.value.present
  pickedAnnotation.value = null
  freshId.value = null
  redraw()
}

function deleteSelected(): void {
  const index = pickedAnnotation.value
  if (index === null)
    return
  pickedAnnotation.value = null
  freshId.value = null
  commit(annotations.value.filter((_, position) => position !== index))
  redraw()
}

// ---------- 选中那条的参数（工具条上改的就是它） ----------

/** 当前选中的那条标注（没选中 / 下标过期时 null） */
function pickedOf(): Annotation | null {
  const index = pickedAnnotation.value
  return index === null ? null : annotations.value[index] ?? null
}

/**
 * 选中那一刻把它自己的参数摆到工具条上 —— 接着点颜色 / 线宽 / 字号，改的就是这一条
 * （不摆的话工具条显示的是「上一条画完时留下的档位」，看着像改了没生效）。
 */
function adoptPickedStyle(annotation: Annotation): void {
  if (annotation.tool === 'mosaic') {
    block.value = annotation.block
    return
  }
  color.value = annotation.color
  if (annotation.tool === 'text')
    textSize.value = annotation.size
  else
    strokeWidth.value = annotation.width
}

/** 工具条上的参数落到选中的那条上（没选中时什么都不做：那只是给下一条备着；记不记撤销见 commitEdit） */
function applyToPicked(patch: AnnotationStylePatch): void {
  const index = pickedAnnotation.value
  const annotation = pickedOf()
  if (index === null || !annotation)
    return
  const next = [...annotations.value]
  next[index] = restyleAnnotation(annotation, patch)
  commitEdit(next, annotation.id)
  redraw()
}

// 四个档位各跟一次：**只在真的变了时才落**（选中那一刻已经把值摆上去了，
// 不比对就会白记一步撤销，而且撤销栈里会多出一堆没改动的步）
watch(color, (next) => {
  const picked = pickedOf()
  if (picked && picked.tool !== 'mosaic' && picked.color !== next)
    applyToPicked({ color: next })
})
watch(strokeWidth, (next) => {
  const picked = pickedOf()
  if (picked && picked.tool !== 'mosaic' && picked.tool !== 'text' && picked.width !== next)
    applyToPicked({ width: next })
})
watch(block, (next) => {
  const picked = pickedOf()
  if (picked?.tool === 'mosaic' && picked.block !== next)
    applyToPicked({ block: next })
})
watch(textSize, (next) => {
  const picked = pickedOf()
  // 文字改字号要连那个量出来的框一起换（命中判定与选中框都靠它，见 restyleAnnotation）
  if (picked?.tool === 'text' && picked.size !== next)
    applyToPicked({ size: next, box: measureTextSize(picked.text, next) })
})

// ---------- 键盘 ----------

function onKeyDown(event: KeyboardEvent): void {
  // 拖工具条把手期间键盘不参与：window 上的 keydown 监听有两个，本函数先注册先触发，
  // 不挡的话 Esc 会同时走下面的「逐层退」把选区清掉 —— 放弃拖动是 startPointerDrag 自己的 Esc
  if (toolbarDragging.value)
    return
  if (textEditing.value)
    return

  const ctrl = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()

  // 滚动模式先于选区 / 标注那套：result 相遮罩拿着焦点（Esc / Enter 收得到），
  // run 相焦点在目标窗口、这边什么都收不到（Esc 会进目标窗口 —— 已知边界）。
  // 只接少数几个键，其余一概不落到下面去（Ctrl+Z 会动底下的标注、Enter 会把图复制走）。
  if (scrollState.value) {
    const phase = scrollState.value.phase
    if (event.key === 'Escape') {
      event.preventDefault()
      exitScroll()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (phase === 'result')
        void finishWith(finishScrollCopy)
      return
    }
    if (ctrl && key === 'c' && phase === 'result') {
      event.preventDefault()
      void finishWith(finishScrollCopy)
      return
    }
    if (ctrl && key === 's' && phase === 'result') {
      event.preventDefault()
      void finishWith(finishScrollSave)
      return
    }
    return
  }

  // 取字模式先于选区 / 标注那套：这层里拖选、挪光标都交给浏览器原生行为，
  // 我们只接四个键，其余一概不落到下面去（Ctrl+Z 会动底下的标注、Enter 会把图复制走）。
  // Ctrl+C / Enter 与「复制」按钮同一个动作：复制所选（没选就全部）并收工。
  if (ocrLines.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      exitOcr()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void copyOcr()
      return
    }
    if (ctrl && key === 'c') {
      event.preventDefault()
      void copyOcr()
      return
    }
    if (ctrl && key === 'a') {
      event.preventDefault()
      selectAllOcr()
      return
    }
    return
  }

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
    freshId.value = null
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

/**
 * 输入框自己量出来的内容尺寸（CSS 像素）；null = 还没量过，那一瞬间按画布的 measureText 兜底。
 *
 * 为什么不让画布量：两边在字体回退与亚像素网格上会差一点点，差出的那一点会让输入框
 * **内部横向滚动** —— 一滚，开头那几个字就被推到框的左边看不见了（用户报的就是这个）。
 * 让浏览器自己报「这段字要多宽」最准：先把盒子压到 0，这时 scrollWidth / scrollHeight
 * 报的就是内容的真实尺寸（盒子不为 0 时量到的是盒子本身，不是内容）。
 */
const textBoxSize = ref<{ width: number, height: number } | null>(null)

/** 量一次输入框的内容尺寸，顺手把它的内部滚动钉回原点（浏览器给光标让路时会自己滚） */
function measureTextInput(): void {
  const element = textInput.value
  if (!element)
    return
  const width = element.style.width
  const height = element.style.height
  element.style.width = '0px'
  element.style.height = '0px'
  textBoxSize.value = { width: element.scrollWidth, height: element.scrollHeight }
  element.style.width = width
  element.style.height = height
  pinTextInputScroll()
}

/**
 * 把输入框的内部滚动钉回原点：宽高永远贴着内容，它本来没有要滚的东西 —— 一旦滚起来
 * （浏览器给光标 / 输入法的合成区让路时会自己滚，横竖都滚），开头那几个字就被推出框外
 * 看不见了，整块字还会跟着上下挪一点（合成一结束盒子长够了、滚动回到 0，看着就是
 * 「输入结束后整体向下移动一点」）。**滚动是浏览器主动做的、不经过我们**，所以按 scroll
 * 事件兜住它 —— 谁、什么时候把它滚起来的都一样。这里不会来回打架：钉回去之后
 * 盒子装得下内容，浏览器没有理由再滚一次。
 */
function pinTextInputScroll(): void {
  const element = textInput.value
  if (!element)
    return
  element.scrollLeft = 0
  element.scrollTop = 0
}

/**
 * 字一变就重新量。**两处都要挂**：
 *
 * - 原生 input（模板上的 `@input`）—— 量的是 DOM 里真实的那一段。**输入法合成的拼音也走它**：
 *   v-model 在合成期间一个字都不更新（Vue 收到 compositionstart 就把后面的 input 全丢了，
 *   等 compositionend 再补一条），而拼音是照常写进 textarea 的 —— 只跟着 v-model 量的话，
 *   「你好」那一段的宽高会一直挂着，合成出来的拼音比它宽，框却不长，于是上面那条滚动就来了。
 * - 模型变化（这里）—— 兜住不经输入事件的那几种（换了一段新输入、程序改字）。
 *   flush: 'post' —— 先让新字落进 DOM，量到的才是它。
 */
watch(
  () => textEditing.value?.text,
  () => measureTextInput(),
  { flush: 'post' },
)

const textInputStyle = computed(() => {
  const editing = textEditing.value
  if (!editing)
    return {}
  const at = canvasToViewport(editing.at, viewportBox(), canvasSize.value)
  const pixels = scale.value || 1
  // 输入框跟着内容长：宽高优先取**它自己量出来的那一份**（见 measureTextInput）。
  // 还没量到时退回画布量出来的那一套：空的时候留半个字的宽度，不然框是零宽、光标看不见；
  // 末尾多给两个画布像素，免得两边量法差一点、最后一列被软换成第二行。
  const dom = textBoxSize.value
  const box = measureTextSize(editing.text, textSize.value)
  const width = dom
    ? `${Math.max(dom.width, textSize.value / (2 * pixels)) + 1}px`
    : `${(Math.max(box.width, textSize.value / 2) + 2) / pixels}px`
  // 高也要兜底：空的时候这个框量出来是 0，直接用它框就是零高（光标都不见了）；
  // 留一行的高度，与画布上量出来的那一块（ceil(字号 × 1.3)）同一个值
  const lineHeight = Math.ceil(textSize.value * TEXT_LINE_HEIGHT) / pixels
  const height = dom ? `${Math.max(dom.height, lineHeight)}px` : `${box.height / pixels}px`
  return {
    left: `${at.x}px`,
    top: `${at.y}px`,
    width,
    height,
    fontSize: `${textSize.value / pixels}px`,
    // 与画布上的行进步长同一个值（见 TEXT_LINE_HEIGHT），多行才不会在提交那一刻跳
    lineHeight: `${TEXT_LINE_HEIGHT}`,
    color: color.value,
  }
})

function commitText(): void {
  const editing = textEditing.value
  textEditing.value = null
  if (!editing || !editing.text.trim())
    return

  // 尺寸量在画布像素上（与字号同一套），命中判定与选中框都靠它
  const annotation: Annotation = {
    id: `t-${Date.now()}`,
    tool: 'text',
    at: editing.at,
    text: editing.text,
    color: color.value,
    size: textSize.value,
    box: measureTextSize(editing.text, textSize.value),
  }
  commit([...annotations.value, annotation])
  // 落下的这段字也照「松手不定稿」那一条：它是**当前**那条（能马上挪位置 / 改字号）。
  // **顺手把文字工具取消**：不取消的话，紧接着那一下点别处就直接开新的输入框了，
  // 根本没有机会动它 —— 要接着打下一段，再点一下文字工具就是。
  pickedAnnotation.value = annotations.value.length - 1
  freshId.value = annotation.id
  if (activeTool.value === 'text')
    activeTool.value = null
  redraw()
}

// ---------- 取字 ----------

/** 文字层的摆位：layoutOcrSpans 给的是选区内的物理像素，这里换成遮罩上的 CSS 像素 */
const ocrSpans = computed(() => {
  const rect = ocrRect.value
  const lines = ocrLines.value
  if (!rect || !lines)
    return null

  const box = viewportBox()
  const canvas = canvasSize.value
  const scaleX = box.width > 0 ? canvas.width / box.width : 1
  const scaleY = box.height > 0 ? canvas.height / box.height : 1
  // 选区左上角（画布像素）→ 视口，词坐标再除同一套比例加过去（与 canvasToViewport 严格同源）
  const origin = canvasToViewport({ x: rect.x, y: rect.y }, box, canvas)
  return layoutOcrSpans(lines).map(line =>
    line.map(span => ({
      text: span.text,
      left: origin.x + span.x / scaleX,
      top: origin.y + span.y / scaleY,
      width: span.w / scaleX,
      height: span.h / scaleY,
    })))
})

/** 短暂的失败提示（两秒后自己收）：取字的失败都是「换一块再试」的事，不该一直挂在画面上 */
function failTransient(message: string): void {
  failure.value = message
  window.clearTimeout(failureTimer)
  failureTimer = window.setTimeout(() => {
    failure.value = ''
  }, 2000)
}

/** 选区取整夹好（取字 / 复制文字 / 滚动截图同一个口径：画布像素，Rust 那边再夹一次到帧内） */
function roundedSelection(): { x: number, y: number, width: number, height: number } | null {
  const rect = selection.value
  if (!rect || !hasSelection.value)
    return null
  const crop = clampRect({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }, fullRect())
  return {
    x: Math.round(crop.x),
    y: Math.round(crop.y),
    width: Math.max(1, Math.round(crop.width)),
    height: Math.max(1, Math.round(crop.height)),
  }
}

async function startOcr(): Promise<void> {
  const region = roundedSelection()
  if (!region)
    return

  const token = sessionSeq
  settleFresh()
  const result = await window.workbench.ocrRegion(region)
  if (token !== sessionSeq)
    return
  if (!result.ok || !result.data?.length) {
    failTransient(result.ok ? '这一块里没认出文字' : result.error ?? '取字失败')
    return
  }
  ocrRect.value = region
  ocrLines.value = result.data
  redraw()
}

/**
 * 工具条上「复制文字」：识别选区里的字，**整段直接进剪贴板并收工** —— 不进文字层。
 * 大多数时候「要哪段字」在框选那一刻就定了；串文本与文字层同一套规则
 * （空格只补在字母数字词身边、行与行之间换行）。
 */
async function ocrCopy(): Promise<void> {
  const region = roundedSelection()
  if (!region)
    return

  const token = sessionSeq
  const result = await window.workbench.ocrRegion(region)
  if (token !== sessionSeq)
    return
  if (!result.ok || !result.data?.length) {
    failTransient(result.ok ? '这一块里没认出文字' : result.error ?? '取字失败')
    return
  }

  const text = layoutOcrSpans(result.data)
    .map(line => line.map(span => span.text).join(''))
    .join('\n')
  if (!text.trim())
    return
  try {
    await navigator.clipboard.writeText(text)
  }
  catch {
    failTransient('复制失败')
    return
  }
  await abort()
}

/** 退出取字：回到标注那套（选区原样留着） */
function exitOcr(): void {
  ocrLines.value = null
  ocrRect.value = null
  window.getSelection()?.removeAllRanges()
  redraw()
}

/**
 * 取字里的复制：有所选就复制所选，没选就全部，**复制完就收工** ——
 * Ctrl+C / Enter / 工具条那颗「复制」都走它，与遮罩其余地方「按下去就完事」的肌肉记忆一致
 * （复制但不收工的话，界面上没有任何反馈，看着就像没复制）。
 */
async function copyOcr(): Promise<void> {
  const picked = window.getSelection()?.toString() ?? ''
  const all = ocrSpans.value?.map(line => line.map(span => span.text).join('')).join('\n') ?? ''
  const text = picked.trim() ? picked : all
  if (!text.trim())
    return
  try {
    await navigator.clipboard.writeText(text)
  }
  catch {
    failTransient('复制失败')
    return
  }
  await abort()
}

/** 全选文字层里的字位（没摆出来就什么都不做） */
function selectAllOcr(): void {
  const element = ocrLayer.value
  const domSelection = window.getSelection()
  if (element && domSelection)
    domSelection.selectAllChildren(element)
}

// ---------- 滚动截图（见 docs/modules/screenshot.md 的「滚动截图」） ----------

/** 首步等稳的 tick（毫秒）：一格滚轮的滚动动画约 150~300ms，等它跑完大半。
 *  之后按上一步实测的轮询数自适应（planTickDelay，40~150ms）—— 瞬时跳滚的应用
 *  会一路降到 40，平滑滚动的应用升回这个上限 */
const SCROLL_TICK_DELAY = 150

/** 等稳轮询的间隔（毫秒）：两次抓帧字节一致才算停稳 */
const SCROLL_SETTLE_POLL = 80

/** 等稳最多轮询几次（画面一直在动 —— 视频 / 加载占位 —— 就抓最后一帧硬拼，交给匹配判） */
const SCROLL_SETTLE_POLLS = 8

/** 连续这么多次 Δ=0 才认定到底：防「这一齿还没生效就抓了一帧」的假到底 */
const SCROLL_ZERO_CONFIRM = 2

/** 连续这么多次匹配对不上才收场：第一次可能是动画没停稳 / 布局正在动，放慢再试一次 */
const SCROLL_NULL_LIMIT = 2

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

/** 工具条上「滚动截图」：直接开滚（没有「开始」确认步 —— 停止靠再按一次截图热键）。
 *  选区太矮匹配不出重叠，先说清楚 */
function startScroll(): void {
  if (scrollState.value)
    return
  const rect = roundedSelection()
  if (!rect)
    return
  if (rect.height < MIN_SCROLL_REGION_HEIGHT) {
    failTransient(`选区太矮（至少 ${MIN_SCROLL_REGION_HEIGHT}px）才拼得出长图`)
    return
  }
  settleFresh()
  scrollState.value = { phase: 'run', rect, stitched: rect.height, steps: 0, note: '' }
  redraw()
  void finishWith(runScroll)
}

/** 退出滚动模式：回到标注那套（选区原样留着）。接的是 result 相的取消 / Esc，以及
 *  开场那一瞬的 Esc —— 循环靠「活着」守卫自己收尾（穿透由 finally 里的 scrollStop 解掉） */
function exitScroll(): void {
  scrollState.value = null
  scrollCanvas = null
  scrollStopRequested = false
  redraw()
}

/** 抓一次选区的实时像素（滚动中）：字节是等稳判定的凭据 */
async function grabScrollBytes(rect: ScrollState['rect']): Promise<ArrayBuffer | null> {
  const result = await window.workbench.scrollGrab(rect)
  if (!result.ok || !result.data)
    return null
  return result.data
}

/** 抓回来的原始 RGBA 字节 → 匹配与拼接共用的像素帧（长度不对就当抓失败） */
function frameFromBytes(bytes: ArrayBuffer, rect: ScrollState['rect']): StitchFrame | null {
  const data = new Uint8ClampedArray(bytes)
  if (data.length !== rect.width * rect.height * 4)
    return null
  return { width: rect.width, height: rect.height, data }
}

/**
 * 滚动拼接的主循环。编排在这边（业务语义归渲染层，Rust 只出「发滚轮」「抓矩形」两件
 * 原生件）：发一轮滚轮 → 等画面停稳（连续两帧字节一致）→ 抓帧 → 算重叠 → 接到长图末尾。
 * 到底（Δ=0）、拼不上（匹配 null，放慢重试一次后仍不行）、热键停止、到高度上限，都是出口。
 *
 * **为什么必须等停稳再抓**：拼进长图的就是抓到的像素，滚动动画中途抓到的帧是合成器
 * 过滤出来的过渡态（内容差着不到一个像素），拼进去就是一条条模糊带 —— 所以
 * 「滚 → 停稳 → 抓」的节奏是这类工具的固有形态（Snipaste / PixPin 同款），能做的是把
 * 一步的量压小（planNotches 贴着选区高度 25% 走）、把等稳的轮询收紧。
 *
 * **卡顿与接缝这两件事的解法**：匹配挪进 worker（`scroll-match.worker.ts`，预测位移
 * 一起带过去，稳态只在预测窗口里找几个候选），主线程不背几十万次像素比较；贴画布只贴
 * `planBand` 算出的**新露出条带**（起点向上越过粘底栏多要一段）—— Δ 估错时污染只在
 * 条带里，粘底栏的旧副本被后续条带盖掉、最终只在最后一帧的位置出现一次。
 */
async function runScroll(): Promise<void> {
  const state = scrollState.value
  if (!state || state.phase !== 'run')
    return
  const rect = state.rect
  const token = sessionSeq
  scrollStopRequested = false

  const begin = await window.workbench.scrollBegin(rect)
  if (token !== sessionSeq)
    return
  if (!begin.ok) {
    // 开场失败（穿透设不上之类）：没有确认步可回，退出滚动模式回到标注，把原因说清楚
    exitScroll()
    failTransient(begin.error ?? '开始滚动截图失败')
    return
  }

  // 这一轮里「还活着」= 会话没换、模式没被退。每个 await 之后都查一遍 ——
  // 循环跑着的时候 abort / 新一场随时可能来（与 beginSession 的 token 守卫同一条口径）
  const alive = () => token === sessionSeq && scrollState.value === state
  let note = ''
  let top = 0
  let steps = 0
  let notches = 1
  let canvas: HTMLCanvasElement | null = null

  // 匹配挪进 worker（无状态，每场一个，收尾时 terminate）：像素比较是几十万到上千万次
  // 的同步运算，主线程上跑每步要冻结遮罩几十到几百毫秒（首步与回退全量扫最重）。
  // 建不起来 / 中途出错就回退同步直调 —— 结果一致，只是那一步会卡
  let matchWorker: Worker | null = null
  let matchWorkerBroken = false
  try {
    matchWorker = new Worker(new URL('./scroll-match.worker.ts', import.meta.url), { type: 'module' })
  }
  catch {
    matchWorker = null
  }
  const matchScroll = async (
    prevFrame: StitchFrame,
    nextFrame: StitchFrame,
    hintDelta: number | undefined,
  ): Promise<ScrollMatchResult> => {
    const worker = matchWorkerBroken ? null : matchWorker
    if (worker) {
      try {
        return await new Promise<ScrollMatchResult>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<ScrollMatchResult>) => resolve(event.data)
          worker.onerror = () => {
            matchWorkerBroken = true
            reject(new Error('匹配 worker 出错'))
          }
          worker.postMessage({
            prev: prevFrame.data.buffer,
            next: nextFrame.data.buffer,
            width: prevFrame.width,
            height: prevFrame.height,
            hintDelta,
          })
        })
      }
      catch {
        // worker 这条路断了，落到下面的同步调用
      }
    }
    return analyzeScrollOffset(prevFrame, nextFrame, { hintDelta })
  }

  try {
    // 长图画布：高度从两屏起步，不够就翻倍着扩（夹在 MAX_STITCH_HEIGHT 上），
    // 每次扩容把已拼内容搬过去 —— 搬家次数是对数级的，几兆的搬运摊不到每一步上。
    // 返回画布自己的 ctx（可能刚扩容换过）——ctx 每次都从这里拿，不存旧的
    const ensureCanvas = (heightNeeded: number): CanvasRenderingContext2D | null => {
      if (canvas === null) {
        canvas = document.createElement('canvas')
        canvas.width = rect.width
        canvas.height = Math.min(MAX_STITCH_HEIGHT, Math.max(rect.height * 2, heightNeeded))
      }
      else if (canvas.height < heightNeeded) {
        const grown = document.createElement('canvas')
        grown.width = rect.width
        grown.height = Math.min(MAX_STITCH_HEIGHT, Math.max(canvas.height * 2, heightNeeded))
        const next = grown.getContext('2d', { willReadFrequently: true })
        if (!next)
          return null
        next.drawImage(canvas, 0, 0)
        canvas = grown
      }
      return canvas.getContext('2d', { willReadFrequently: true })
    }

    // 第 0 帧：滚之前的样子，就是长图的第一屏
    const first = await grabScrollBytes(rect)
    if (!alive())
      return
    const firstFrame = first ? frameFromBytes(first, rect) : null
    const ctx = firstFrame ? ensureCanvas(rect.height) : null

    if (!first) {
      note = '抓不到选区的画面'
    }
    else if (!firstFrame) {
      note = '抓回来的帧尺寸不对'
    }
    else if (!ctx) {
      note = '长图画布建不出来'
    }
    else {
      ctx.putImageData(new ImageData(firstFrame.data, rect.width, rect.height), 0, 0)
      let prev: StitchFrame = firstFrame
      steps = 1
      state.stitched = rect.height
      // 连续 Δ=0 的计数：到底要连着两次没动才算（第一下可能是这一齿还没生效）
      let zeroRun = 0
      // 连续对不上的计数：第一次可能是动画没停稳 / 布局正在动，放慢（1 齿 + 等稳翻倍）
      // 再试，连着两次才认输
      let nullRun = 0
      // 上一步实测位移：滚轮是自己发的，本步的位移 ≈ 它 × 本步实发齿数，
      // 匹配先在预测窗口里找（见 stitch.ts 的「预测窗口」）
      let lastDelta = 0
      // 等稳轮询数：对不上的那一步翻倍（滚动动画更慢就多等一会）
      let settlePolls = SCROLL_SETTLE_POLLS
      // 首等 tick：发完滚轮先等多久再开始抓帧（按上一步的实测轮询数自适应，
      // 见 stitch.ts 的 planTickDelay）
      let tick = SCROLL_TICK_DELAY

      // 循环：滚 → 等稳 → 抓 → 算重叠 → 只贴新露出的条带
      for (;;) {
        if (scrollStopRequested)
          break
        if (top + rect.height >= MAX_STITCH_HEIGHT) {
          note = `已拼到上限 ${MAX_STITCH_HEIGHT}px`
          break
        }
        const rolled = await window.workbench.scrollWheel(notches)
        if (!alive())
          return
        if (!rolled.ok) {
          note = rolled.error ?? '发滚轮失败'
          break
        }

        // 等稳：先等 tick（滚动动画跑完大半；瞬时跳滚的应用 tick 会降到 40），再轮询
        // 到「连续两帧字节一致」（抓屏是确定的，静止内容必同字节）。一直在动就抓
        // 最后一帧硬拼 —— 交给匹配判
        await delay(tick)
        if (!alive())
          return
        let current = await grabScrollBytes(rect)
        if (!alive())
          return
        let settled: ArrayBuffer | null = null
        let attempts = 0
        for (; attempts < settlePolls && !settled && current; attempts += 1) {
          await delay(SCROLL_SETTLE_POLL)
          if (!alive())
            return
          // 停止请求：不再等停稳，拿当前帧尽力拼完这一步再收（重复的帧自然 Δ=0）
          if (scrollStopRequested)
            break
          const grabbed = await grabScrollBytes(rect)
          if (!alive())
            return
          if (grabbed && bytesEqual(current, grabbed))
            settled = grabbed
          else if (grabbed)
            current = grabbed
        }
        if (!current) {
          note = '抓不到选区的画面'
          break
        }
        const candidate = settled ?? current

        const frame = frameFromBytes(candidate, rect)
        if (!alive())
          return
        if (!frame) {
          note = '抓回来的帧尺寸不对'
          break
        }
        const hintDelta = lastDelta > 0 ? lastDelta * notches : undefined
        const result = await matchScroll(prev, frame, hintDelta)
        if (!alive())
          return
        const delta = result.delta
        if (delta === null) {
          // 已经按了停止：这一帧多半是动画中间态，不值得再放慢重试，直接收
          if (scrollStopRequested)
            break
          // 放慢再试：一步只滚一齿、等稳轮询翻倍；连着两次对不上才收
          nullRun += 1
          if (nullRun >= SCROLL_NULL_LIMIT) {
            note = '画面变化太快，这里拼不上'
            break
          }
          notches = 1
          settlePolls = SCROLL_SETTLE_POLLS * 2
          continue
        }
        if (delta === 0) {
          // 到底了、或这一齿没起作用 —— 再滚一齿确认一次，连着两次没动才收
          zeroRun += 1
          if (zeroRun >= SCROLL_ZERO_CONFIRM)
            break
          continue
        }
        zeroRun = 0
        nullRun = 0

        // 只贴新露出的条带（起点从新内容线向上越过粘底栏再多要一段，见 planBand）：
        // Δ 估错时污染只在条带里，粘底栏的旧副本被后续条带盖掉，不会每步留一份
        const bandTop = planBand(delta, rect.height, result.stickyTop, result.stickyBottom)
        top += delta
        const target = ensureCanvas(top + rect.height)
        if (!target) {
          note = '长图画布扩不动了'
          break
        }
        target.putImageData(
          new ImageData(frame.data.subarray(bandTop * rect.width * 4), rect.width, rect.height - bandTop),
          0,
          top + bandTop,
        )
        prev = frame
        steps += 1
        state.stitched = top + rect.height
        state.steps = steps
        lastDelta = delta
        // 这一步的等稳表现 → 下一步的首等（瞬时跳滚的应用 tick 降到 40，少白等）
        if (settled)
          tick = planTickDelay(tick, attempts)
        // 下一步发几个齿按这一步的实际位移自适应（步长贴着选区高度 25% 走）
        notches = planNotches(delta, rect.height)
        settlePolls = SCROLL_SETTLE_POLLS
        // 停止请求：这一步已经拼进去（滚出去的内容不丢），下一轮开头收工
        if (scrollStopRequested)
          break
      }
    }
  }
  finally {
    // 不管从哪条路出来：穿透都要解掉。热键停止那条路 Rust 已经收过尾，
    // 这条命令会报「没有在滚动」—— 当幂等失败忽略
    await window.workbench.scrollStop()
    matchWorker?.terminate()
    matchWorker = null
    if (alive()) {
      // 正常收尾：进结果相（note 为空 = 到底了，干干净净）
      state.note = note
      state.steps = steps
      state.phase = 'result'
      scrollCanvas = canvas
      redraw()
    }
    else {
      // 模式被退 / 换场了：长图跟模式一起丢
      scrollCanvas = null
    }
  }
}

/** 滚动结果整图编成 base64（照 pngBase64 的分块：几兆整串会爆调用栈） */
async function scrollPngBase64(): Promise<string | null> {
  const canvas = scrollCanvas
  if (!canvas)
    return null
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  return blob ? blobToBase64(blob) : null
}

/** 结果相的复制：长图进剪贴板。capture_copy 一进来就收场（遮罩不会停在屏幕上等） */
async function finishScrollCopy(): Promise<void> {
  const state = scrollState.value
  if (!state || state.phase !== 'result')
    return
  const png = await scrollPngBase64()
  if (!png) {
    failTransient('长图编不出来')
    return
  }
  const result = await window.workbench.copyImage(png)
  if (!result.ok)
    failure.value = result.error ?? '复制到剪贴板失败'
}

/** 结果相的保存：设过自动保存目录直接落进去，没设过弹一次「另存为」——与 save() 同一条路 */
async function finishScrollSave(): Promise<void> {
  const state = scrollState.value
  if (!state || state.phase !== 'result')
    return
  const png = await scrollPngBase64()
  if (!png) {
    failTransient('长图编不出来')
    return
  }

  const name = defaultCaptureName(new Date())
  const dir = options.value?.saveDir ?? ''
  if (dir) {
    const result = await window.workbench.saveImage(png, dir, name, true)
    if (!result.ok) {
      failTransient(result.error ?? '保存失败')
      return
    }
    await abort()
    return
  }

  const picked = await window.workbench.pickSavePath({
    title: '滚动截图另存为',
    defaultPath: name,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  })
  if (!picked)
    return
  const parts = splitPath(picked)
  const result = await window.workbench.saveImage(png, parts.dir, parts.name, false)
  if (!result.ok) {
    failTransient(result.error ?? '保存失败')
    return
  }
  await abort()
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
  // 与显示侧同一个规矩：正被拖的那条摘掉、补上 draft 那一份（拖到一半按 Enter / Ctrl+C
  // 导出的就是屏幕上此刻的样子，而不是它的旧几何，见 settledAnnotations）
  drawAnnotations(painter, settledAnnotations(), { x: 0, y: 0 })
  if (draft.value)
    drawAnnotation(painter, draft.value, { x: 0, y: 0 })

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

/** Blob → base64。一次转换的字节数有上限：几兆的图整串塞进 fromCharCode 会爆调用栈，分块来 */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

async function pngBase64(): Promise<string | null> {
  const blob = await compose()
  return blob ? blobToBase64(blob) : null
}

async function copy(): Promise<void> {
  const rect = selection.value
  if (!rect || !hasSelection.value) {
    failure.value = '还没选好要截的区域'
    return
  }

  // **没画标注就别把图搬来搬去**：Rust 手里有这一场的原始帧，由它裁出选区直接写剪贴板
  // （见 docs/modules/screenshot.md 的「复制这条路的快路径」）
  const token = sessionSeq
  if (annotations.value.length === 0 && !draft.value && !textEditing.value) {
    const crop = clampRect({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }, fullRect())
    const result = await window.workbench.copyFrame({
      x: Math.round(crop.x),
      y: Math.round(crop.y),
      width: Math.max(1, Math.round(crop.width)),
      height: Math.max(1, Math.round(crop.height)),
    })
    // 收工由 Rust 在命令一开始做（遮罩不会停在屏幕上等剪贴板）；失败它另推 capture:failed
    if (!result.ok && token === sessionSeq)
      failure.value = result.error ?? '复制到剪贴板失败'
    return
  }

  const png = await pngBase64()
  if (!png) {
    failure.value = '还没选好要截的区域'
    return
  }
  const result = await window.workbench.copyImage(png)
  // 同上：遮罩在 Rust 那边已经收掉了，这里只兜住「命令压根没送出去」那种失败
  if (!result.ok && token === sessionSeq)
    failure.value = result.error ?? '复制到剪贴板失败'
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

/**
 * 拖把手拖出来的手动位置（视口 CSS 像素）。非空时它说了算、不再跟着选区跳 ——
 * 工具条挡住要标注的部分时把它拖走。只记当前这一场：`reset` 里清掉，下一场回自动摆位。
 */
const toolbarManual = ref<Point | null>(null)
const toolbarDragging = ref(false)

const toolbarStyle = computed(() => {
  const manual = toolbarManual.value
  if (manual)
    return { left: `${manual.x}px`, top: `${manual.y}px` }

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
  const at = canvasToViewport(
    autoToolbarPosition(rect, size, canvas, 10 * scale.value),
    viewportBox(),
    canvas,
  )
  return { left: `${at.x}px`, top: `${at.y}px` }
})

/** 拖动落点离视口每条边的最小距离 */
const TOOLBAR_DRAG_MARGIN = 2

/** 这一手拖动开始前的手动位置：Esc / 系统接管指针放弃时回这里（null = 自动贴选区） */
let toolbarManualBeforeDrag: Point | null = null
let endToolbarDrag: (() => void) | null = null

/**
 * 按住左侧把手拖工具条：跟手摆、夹回视口内，松手定格在本场内。
 * 指针监听由 startPointerDrag 挂到 window 上（把手外松手也收得到），Esc 放弃这一手。
 */
function onToolbarGripDown(event: PointerEvent): void {
  if (event.button !== 0)
    return
  const element = toolbarRef.value
  if (!element)
    return

  // 按住点相对工具条左上角的偏移：拖动中保持它，工具条不会在指针底下跳一下
  const grabOffset = { x: event.clientX - element.offsetLeft, y: event.clientY - element.offsetTop }
  toolbarManualBeforeDrag = toolbarManual.value
  toolbarDragging.value = true

  endToolbarDrag = startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    onMove: (moveEvent) => {
      toolbarManual.value = clampToolbarPosition(
        { x: moveEvent.clientX - grabOffset.x, y: moveEvent.clientY - grabOffset.y },
        toolbarSize.value,
        viewportBox(),
        TOOLBAR_DRAG_MARGIN,
      )
    },
    onEnd: (_last, cancelled) => {
      // 放弃这一手（Esc / 系统接管）就当没拖过：回拖动前的位置
      if (cancelled)
        toolbarManual.value = toolbarManualBeforeDrag
      toolbarDragging.value = false
      endToolbarDrag = null
    },
  })
}

/** 工具条一渲染出来就量真实尺寸，摆位与翻面才判得准（第二排参数会改高度） */
function measureToolbar(): void {
  const element = toolbarRef.value
  if (!element)
    return
  toolbarSize.value = { width: element.offsetWidth, height: element.offsetHeight }
  // 参数排出现 / 消失会改高度：手动位置重夹一次，别把下半截戳出视口
  if (toolbarManual.value) {
    toolbarManual.value = clampToolbarPosition(
      toolbarManual.value,
      toolbarSize.value,
      viewportBox(),
      TOOLBAR_DRAG_MARGIN,
    )
  }
}

// freshId 也在名单里：它一翻，参数那一排跟着换（见 optionTool），高度可能跟着变；
// 取字 / 滚动那一层进出时工具条整个换了一副，也要重量一次
watch([toolbarVisible, activeTool, freshId, ocrLines, scrollState, () => annotations.value.length], () => {
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
  <div class="capture" :style="{ cursor: toolbarDragging ? 'grabbing' : pointerCursor }">
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
      文字工具：点一下就在那儿开一个输入框，输入法、光标这些交给原生的 textarea。
      **多行、不限长度**：回车就是换行（输入法用回车选词那一下由输入法自己吃掉，
      不会插进正文），宽高跟着内容长，长句不折行也不截断。
      宽高**按原生 input 量**（合成中的拼音也在里面，v-model 那段是跟不上合成期的，见
      `measureTextInput`）；内部滚动一律钉回原点（见 `pinTextInputScroll`）。
      结束靠点别处（blur 里提交，见 commitText）；Esc 丢掉这段字。
    -->
    <textarea
      v-if="textEditing"
      ref="textInput"
      v-model="textEditing.text"
      class="capture-text-input"
      :style="textInputStyle"
      wrap="off"
      @input="measureTextInput"
      @scroll="pinTextInputScroll"
      @keydown.esc.stop.prevent="textEditing = null"
      @blur="commitText"
    />

    <!--
      取字的文字层：盖住整块画布，按 OCR 的字框逐字摆**透明**的 span ——
      选中高亮贴着原字走（::selection 半透明主题蓝、字保持透明），Ctrl+C / Enter
      复制的是文字而不是图。词间空隙与行末的换行位让串出来的文本有分词、有行界。
      这层盖住画布后，选区 / 标注那套指针交互自然进不来（退出走 Esc / 右键 / 工具条）。
      **必须排在工具条前面（z-index 也压它一头）**：它 inset: 0 盖满全屏，排在后面的话
      三颗按钮的点击全被这层接走 —— 看着在、就是点不动（踩过）。
    -->
    <div
      v-if="ocrSpans"
      ref="ocrLayer"
      class="capture-ocr"
      @contextmenu.prevent="exitOcr"
    >
      <span
        v-for="(span, index) in ocrSpans.flat()"
        :key="index"
        :style="{
          left: `${span.left}px`,
          top: `${span.top}px`,
          width: `${span.width}px`,
          height: `${span.height}px`,
          fontSize: `${span.height}px`,
        }"
      >{{ span.text }}</span>
    </div>

    <div
      v-if="toolbarVisible"
      ref="toolbarRef"
      class="capture__toolbar"
      :class="{ 'is-dragging': toolbarDragging }"
      :style="toolbarStyle"
    >
      <!-- 左侧把手：挡住要标注的部分时按住它把整条拖走（取字 / 滚动那一副同样吃这套摆位） -->
      <div class="capture__toolbar-grip" @pointerdown="onToolbarGripDown" />
      <!-- 滚动模式下工具条换成滚动控制条：run / result 两相各一副脸（动作都在这边，bar 只摆样子） -->
      <CaptureScrollBar
        v-if="scrollState"
        :phase="scrollState.phase"
        :size="`${scrollState.rect.width} × ${scrollState.stitched}`"
        :note="scrollState.note"
        @cancel="exitScroll"
        @copy="finishWith(finishScrollCopy)"
        @save="finishWith(finishScrollSave)"
      />
      <!-- 取字模式下工具条换成那一副：全选 / 复制 / 退出（动作都在这边，bar 只摆样子） -->
      <CaptureOcrBar
        v-else-if="ocrLines"
        @select-all="selectAllOcr"
        @copy="copyOcr"
        @exit="exitOcr"
      />
      <CaptureToolbar
        v-else
        v-model:tool="activeTool"
        v-model:color="color"
        v-model:stroke-width="strokeWidth"
        v-model:block="block"
        v-model:text-size="textSize"
        :option-tool="optionTool"
        :can-undo="undoAble"
        :can-redo="redoAble"
        :busy="busy"
        @undo="undo"
        @redo="redo"
        @cancel="cancel"
        @copy="finishWith(copy)"
        @save="finishWith(save)"
        @pin="finishWith(pin)"
        @ocr="finishWith(startOcr)"
        @ocr-copy="finishWith(ocrCopy)"
        @scroll="startScroll"
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

    <!--
      这一屏没有别的说明渠道，还没选区时留一条，选上之后自动让开。
      **必须跟着会话走（context 非空才算开了场）**：遮罩窗口预建复用，开场之前与收工之后
      页面都停在「无会话」状态，而藏着的窗口不往合成器交新帧 —— 显示出来的头一帧还是
      上一份旧表面。提示条不按会话显隐的话，这份表面就带着一块深色底：启动后第一场截图，
      遮罩亮起的一瞬它先闪出来（用户报过「第一次截图闪一个色块」）。
      会话外整页全透明，旧表面露出的才是桌面本身。
    -->
    <div v-if="context && !hasSelection && !failure" class="capture__hint">
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
 * 输入框长得**和落下去的字一模一样**：字号、颜色与行高由行内 style 给（跟着当前档位走），
 * 这里把边框、底色、内边距全部去掉，只留一个光标。**不要给它加框或底色** ——
 * 那样提交的时候会看见一个框「收起」成纯色字，而这门功能要的就是所见即所得。
 * 宽高由 textInputStyle 按量出来的文字块给死，所以关掉换行与滚动条、也不许用户拖尺寸。
 * 字体栈与 line-height 要和 annotation-render.ts 里量基线那套一致（那边量「一行字的基线离块顶
 * 多远」，拿的就是这里的排法），改这里就得连着那边一起改。
 */
.capture-text-input {
  position: absolute;
  display: block;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  /* 长句不折行：与画布一样一行到底（宽已经量够了，这里只是挡浏览器差那一个像素） */
  white-space: pre;
  overflow: hidden;
  resize: none;
  caret-color: #409eff;
  outline: none;
}

.capture__toolbar {
  position: absolute;
  /* 取字的文字层（inset: 0）盖满全屏，工具条必须压在它上面 —— 排序之外再给一道 z-index
     双保险：排在它后面的话三颗按钮看着在、点不到 */
  z-index: 2;
  /* 把手在左、内容在右：一行 flex 让两者并排（absolute 容器本来就 shrink-to-fit） */
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}

/*
 * 左侧拖动把手：工具条挡住要标注的部分时按住它拖走。底子与 .overlay-bar 同一套
 * 深色半透明卡片（压在任意像素上都看得清），握把纹是一列小点。
 */
.capture__toolbar-grip {
  flex: none;
  align-self: stretch;
  width: 12px;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 8px;
  background-color: rgb(28 30 34 / 96%);
  background-image: radial-gradient(rgb(255 255 255 / 45%) 1px, transparent 1.6px);
  background-size: 5px 5px;
  background-position: center;
  box-shadow: 0 6px 24px rgb(0 0 0 / 45%);
  cursor: grab;
  touch-action: none;
}

.capture__toolbar-grip:hover {
  background-image: radial-gradient(rgb(255 255 255 / 75%) 1px, transparent 1.6px);
}

.capture__toolbar.is-dragging .capture__toolbar-grip {
  cursor: grabbing;
}

/*
 * 取字的文字层。遮罩整页被 capture.html 禁了选中，**这层是唯一要选中的地方**，
 * user-select 得显式开回 text。span 一律绝对定位：摆位由 OCR 的字框换算而来
 * （ocrSpans），字号贴着框高走 —— 字本身透明，只借它的盒子接选区。
 */
.capture-ocr {
  position: absolute;
  inset: 0;
  /* 压在工具条下面（按钮要能点），其余绝对定位的兄弟都在它后面、自然盖住它 */
  z-index: 1;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.capture-ocr span {
  position: absolute;
  display: inline-block;
  line-height: 1;
  white-space: pre;
  overflow: hidden;
  text-align: center;
  color: transparent;
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
}

/* 选中高亮：一层半透明的主题蓝盖在原字上，字保持透明 —— 原图上的字透出来，高亮贴着它走 */
.capture-ocr span::selection {
  background: rgb(64 158 255 / 45%);
  color: transparent;
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
  pointer-events: none;
}
</style>
