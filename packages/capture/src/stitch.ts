/**
 * 滚动截图的拼接纯逻辑（带单测）。
 *
 * 滚动截图每一步都在问同一件事：上一帧（选区那么大）与新帧之间，内容向下滚了多少
 * 像素（Δ）。滚了 Δ 就意味着新帧顶部 `h−Δ` 行与上一帧 `Δ..h` 行是**同一段内容**，
 * 真正新的只有新帧底部 Δ 行 —— 把它接到长图末尾就是拼接。
 *
 * 找 Δ 的思路（**按行打分**，不按条带 —— 条带方案在两类真实页面上挂过）：
 *
 * - **只拿「有内容」的行打分**：一行里 RGB 各通道自己的极差 ≤ 门槛算「平行」（大片留白）。
 *   留白行在任何 Δ 下都长得一样，拿它们打分只会稀释信号 —— GitHub 首页那一类
 *   「整页几乎全白、只有零星几块字」的页面，按条带匹配时两条条带全落在留白里，
 *   直接被平坦保护判成「匹配无意义」。留白行不参与打分，这类页面照拼；
 * - **中位数聚合**：每个候选 Δ 给每一行算一个绝对差，取**中位数**当这一档的分数。
 *   会动的行（彩虹渐变带、视频、加载占位）与粘头 / 粘底的行都是个别离群值 ——
 *   平均值会被它们拖高，中位数只要「有内容且静止」的行超过一半就稳稳胜出；
 * - **两段式**：初筛按粗采样的行 / 列算平均差、留下最像的 8 个候选（全量行的中位数
 *   每个候选都算一遍太贵），复核用全部有内容的行逐个算中位数。静止内容的真解
 *   中位差是 0，门槛可以收得很紧；
 * - **静态行剔除**：两帧在**同一屏幕位置**一模一样的行是「粘住画面」的行（粘头 /
 *   粘底 / 悬浮件 —— 内容滚它们不滚，轻则制造并列、重则把中位数拉去错的档），
 *   从匹配行集里剔掉。页面没滚时全体行都「粘」，那由 Δ=0 快速通道先接住，走不到
 *   这里；剔完好内容行不足最少行数时宁可不剔（判定本身可疑）；
 * - **Δ=0 快速通道**：全体有内容行的中位差 ≤ 门槛 = 页面没滚（到底、滚轮没生效、
 *   大面积静止），直接报 0 —— 与全量扫里 Δ=0 胜出的旧口径完全一致，只是不用把
 *   其余候选也扫一遍；
 * - **预测窗口**：滚轮是调用方自己发的，这一步的 Δ ≈ 上一步实测 × 本步齿数，
 *   先在预测值 ±48px 的小窗口里找，命中直接用 —— 稳态候选从「选区高」个掉到
 *   百来个，滚动截图每步不再卡顿靠的就是这个；不中（布局位移、预测失灵）才
 *   回退全量扫；
 * - **并列破平局**：与最优分差 ≤1 的候选视为并列，取离预测值最近的那个 ——
 *   重复纹理（列表行 / 代码行）天然给出多个「完美」Δ，不破平局就会锁到过小的
 *   Δ 把内容拼重。
 *
 * 贴条带的计划在 `planBand`：只贴新露出的那条带，且起点向上越过粘底栏多贴一段
 * （照 eSearch 的 makePatch）—— 条带起点的**绝对位置**只跟粘底栏厚度有关，
 * 每一步都恰好盖住上一帧留下的粘底副本，粘底栏最终只在最后一帧的位置出现一次；
 * Δ 估错时污染也只落在条带里，不会抹过整个重叠区。
 *
 * 这里只认数字（与 ocr.ts 同一口径）：怎么抓帧、怎么画长图由渲染层做 —— 那一步要问
 * DOM 与 IPC，纯逻辑这边不掺和。
 */

/** 长图的高度上限：Chromium 画布超过 16384 一档在 GPU 纹理上不可靠，这里留出余量 */
export const MAX_STITCH_HEIGHT = 16000

/**
 * 能做匹配的最小选区高度：匹配要有内容行，更要留得出最小重叠 —— 一齿滚轮
 * 普遍 ~100px，选区比「两倍最小重叠」高不了多少时，一步就把重叠吃光了。
 */
export const MIN_SCROLL_REGION_HEIGHT = 192

/**
 * 参与匹配的一帧：RGBA，`data` 长度 = width × height × 4（就是 ImageData.data）。
 * `ArrayBuffer` 背书的那一种 TypedArray：抓回来的原始字节就长这样，
 * `new ImageData(...)` 的签名也只要这一种。
 */
export interface StitchFrame {
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}

/** 列采样步距（复核用）：800px 宽的选区每行只比 200 个点 */
const COLUMN_STRIDE = 4

/** 列采样步距（初筛用，更粗一档） */
const SHORTLIST_COLUMN_STRIDE = 8

/** 搜索上限给重叠留出的最小行数：Δ 最大到「选区高 − 它」，再大就没有重叠可比了 */
const MIN_OVERLAP = 48

/** 至少要有这么多「有内容」的行才谈得上匹配（整页纯色就放弃） */
const MIN_USABLE_ROWS = 10

/** 初筛最多评估多少行（从有内容的行里均匀抽） */
const SHORTLIST_ROWS = 48

/** 初筛保留多少个候选进入复核 */
const SHORTLIST_KEEP = 8

/** 复核的中位差门槛：静止内容的真解是 0，门槛收紧 */
const MATCH_SCORE_MAX = 3

/** 一行里 RGB 各通道自己的极差 ≤ 它算「平行」（没有内容） */
const FLAT_EPS = 2

/** 预测窗口的半径：先在预测位移 ± 这个值里找，命中就不用全量扫 */
const WINDOW_TOLERANCE = 48

/** 与最优分差 ≤ 它的候选视为并列：重复纹理天然给出多个「完美」Δ，取离预测最近的 */
const SCORE_TIE_EPS = 1

/** 同一屏幕位置两帧行差 ≤ 它算「粘住画面」的行（静止内容行差是 0，留一档余量） */
const STICKY_EPS = 1

/** 条带起点越过「新内容线」再向上多贴的行数：容忍 Δ 的个别像素误差 */
const BAND_PAD = 8

/** 一步最多发几个滚轮齿 */
const MAX_NOTCHES = 3

/** 等稳 tick 的上下限（毫秒）：发出滚轮后先等这么久再开始抓帧，按实测自适应 */
export const TICK_MIN = 40
export const TICK_MAX = 150

/** tick 每步调整的幅度（毫秒） */
const TICK_STEP = 40

/** `analyzeScrollOffset` 的选项 */
export interface ScrollMatchOptions {
  /** 预测位移（上一步实测 × 本步实发齿数）：先在这个值附近的小窗口里找，命中就不全量扫 */
  hintDelta?: number
}

/** 一次匹配的完整产出：Δ 之外还带回帧缘的粘住行数，贴条带（`planBand`）要用 */
export interface ScrollMatchResult {
  /** 0 = 没滚动（到底了、或滚轮没起作用，调用方据此收尾）；null = 对不上 / 匹配无意义 */
  delta: number | null
  /** 帧顶部连续粘住行的行数（条带起点不越过它 —— 粘头只在第 0 帧出现一次） */
  stickyTop: number
  /** 帧底部连续粘住行的行数（条带起点要向上越过它，盖掉上一帧贴下来的粘底副本） */
  stickyBottom: number
}

/**
 * 在上一帧里找新帧的纵向位移（内容向下滚了多少 px），连同行缘的粘住行数一起给。
 * 匹配的工序见文件头：Δ=0 快速通道 → 静态行剔除 → 预测窗口（不中回退全量扫）→ 并列破平局。
 */
export function analyzeScrollOffset(
  prev: StitchFrame,
  next: StitchFrame,
  options: ScrollMatchOptions = {},
): ScrollMatchResult {
  const empty = (delta: number | null): ScrollMatchResult => ({ delta, stickyTop: 0, stickyBottom: 0 })
  if (prev.width !== next.width || prev.height !== next.height)
    return empty(null) // 选区是固定死的，这不该发生
  const { width, height } = next
  if (width <= 0 || height <= MIN_OVERLAP)
    return empty(null)

  // 有内容的行（整帧判定）。留白行在任何 Δ 下都一样，不参与打分
  const usable = usableRows(next)
  if (usable.length < MIN_USABLE_ROWS)
    return empty(null)

  const maxDelta = height - MIN_OVERLAP
  const hint = options.hintDelta !== undefined && options.hintDelta > 0
    ? Math.min(Math.round(options.hintDelta), maxDelta)
    : undefined

  // 粘住画面的行：内容滚了它们不滚，同一屏幕位置两帧一模一样。Δ=0 处判定没有
  // 越界问题，帧底的粘底栏也探得到
  const sticky = stickyRowSet(prev, next, usable)
  const stickyTop = contiguousSticky(sticky, 0, 1, height)
  const stickyBottom = contiguousSticky(sticky, height - 1, -1, height)

  // Δ=0 快速通道：绝大多数有内容的行在两帧同一位置一样 = 页面没滚（到底、滚轮
  // 没生效、大面积静止）。与全量扫里 Δ=0 按初筛序胜出的旧口径一致，只是省掉
  // 其余候选
  if (medianScore(prev, next, usable, 0, COLUMN_STRIDE) <= MATCH_SCORE_MAX)
    return { delta: 0, stickyTop, stickyBottom }

  // 静态行剔除：它们在任何 Δ 下都对得上，留在行集里只会制造并列。剔完好内容行
  // 不足最少行数时宁可不剔（页面大面积静止、判定可疑，退回旧口径全量打分）
  const filtered = usable.filter(y => !sticky.has(y))
  const useFiltered = filtered.length >= MIN_USABLE_ROWS && filtered.length < usable.length
  const matched = useFiltered ? filtered : usable

  // 预测窗口先行：命中门槛直接用，不中再全量扫（稳态永远走不到这一步）
  if (hint !== undefined) {
    const windowBest = findBestDelta(prev, next, matched, windowDeltas(hint, maxDelta), hint)
    if (windowBest !== null && windowBest.score <= MATCH_SCORE_MAX)
      return { delta: windowBest.delta, stickyTop, stickyBottom }
  }
  let best = findBestDelta(prev, next, matched, fullDeltas(maxDelta), hint)
  // 剔行集对不上就退回整集再扫一次：剔除只该帮忙（去掉制造并列的粘行），不该把
  // 行数削到连复核的最少行数都凑不齐（底部行在 Δ 大时本就超出重叠范围不参与打分）
  if ((best === null || best.score > MATCH_SCORE_MAX) && useFiltered)
    best = findBestDelta(prev, next, usable, fullDeltas(maxDelta), hint)
  return { delta: best !== null && best.score <= MATCH_SCORE_MAX ? best.delta : null, stickyTop, stickyBottom }
}

/**
 * 在上一帧里找新帧的纵向位移（内容向下滚了多少 px）。
 *
 * 返回 0 = 没滚动（到底了、或滚轮没起作用，调用方据此收尾）；返回 null = 整页没有
 * 足够的有内容行（匹配无意义）或复核的中位差高过门槛（对不上）。两帧尺寸必须一致
 * —— 选区是固定死的。带预测位移与粘住行数的完整版在 `analyzeScrollOffset`。
 */
export function scrollOffset(prev: StitchFrame, next: StitchFrame): number | null {
  return analyzeScrollOffset(prev, next).delta
}

/** 初筛与复核打完分后的产出：候选 Δ 与它的复核中位差 */
interface DeltaScore {
  delta: number
  score: number
}

/** 预测窗口内的候选 Δ（预测值 ± 半径，夹在有效范围内）；预测失灵靠回退全量扫兜底 */
function windowDeltas(hint: number, maxDelta: number): number[] {
  const lo = Math.max(0, hint - WINDOW_TOLERANCE)
  const hi = Math.min(maxDelta, hint + WINDOW_TOLERANCE)
  const deltas: number[] = []
  for (let delta = lo; delta <= hi; delta += 1)
    deltas.push(delta)
  return deltas
}

/** 全量候选：0 到最大有效位移（选区高 − 最小重叠） */
function fullDeltas(maxDelta: number): number[] {
  const deltas: number[] = []
  for (let delta = 0; delta <= maxDelta; delta += 1)
    deltas.push(delta)
  return deltas
}

/**
 * 对给定候选集跑两段式，返回中位差最小的候选。并列（分差 ≤ SCORE_TIE_EPS）时：
 * 有预测值取离它最近的 Δ —— 重复纹理（列表行 / 代码行）天然给出多个「完美」档，
 * 锁到过小的 Δ 会把内容拼重；没有预测值保持原序（初筛分序），与旧口径一致。
 */
function findBestDelta(
  prev: StitchFrame,
  next: StitchFrame,
  rows: number[],
  deltas: number[],
  hint: number | undefined,
): DeltaScore | null {
  if (deltas.length === 0)
    return null
  // 初筛：粗采样，按平均差留下最像的几个候选
  const stageRows = strideRows(rows, SHORTLIST_ROWS)
  const shortlist: DeltaScore[] = []
  for (const delta of deltas)
    shortlist.push({ delta, score: meanScore(prev, next, stageRows, delta, SHORTLIST_COLUMN_STRIDE) })
  shortlist.sort((a, b) => a.score - b.score)

  // 复核：全部有内容的行逐个算中位差 —— 会动的行 / 粘头行是离群值，
  // 中位数不受它们拖动
  const refined: DeltaScore[] = []
  for (const { delta } of shortlist.slice(0, SHORTLIST_KEEP))
    refined.push({ delta, score: medianScore(prev, next, rows, delta, COLUMN_STRIDE) })
  const best = Math.min(...refined.map(r => r.score))
  let chosen: DeltaScore | null = null
  for (const r of refined) {
    if (r.score > best + SCORE_TIE_EPS)
      continue
    if (chosen === null) {
      chosen = r
    }
    else if (hint === undefined) {
      if (r.score < chosen.score)
        chosen = r
    }
    else if (Math.abs(r.delta - hint) < Math.abs(chosen.delta - hint)) {
      chosen = r
    }
  }
  return chosen
}

/** 同一屏幕位置两帧一模一样的行号集合：粘住画面的行（粘栏 / 悬浮件），内容滚它们不滚 */
function stickyRowSet(prev: StitchFrame, next: StitchFrame, rows: number[]): Set<number> {
  const sticky = new Set<number>()
  for (const y of rows) {
    if (rowScore(prev, next, y, 0, COLUMN_STRIDE) <= STICKY_EPS)
      sticky.add(y)
  }
  return sticky
}

/** 从帧缘起连续粘住行的行数（贴条带要知道粘栏有多厚，中间断开的悬浮件不算数） */
function contiguousSticky(sticky: Set<number>, from: number, step: 1 | -1, height: number): number {
  let count = 0
  for (let y = from; y >= 0 && y < height; y += step) {
    if (!sticky.has(y))
      break
    count += 1
  }
  return count
}

/**
 * 下一步发几个滚轮齿：按上一步的实际位移自适应，步长贴着选区高度的 25% 走 ——
 * 一步太大滚得「一卡一卡」，太小又白抓好几帧。一步的量还不许超过
 * 「选区高 − 最小重叠」：跨过整个视口就没有重叠可比了。首步（没量过位移）发 1 齿。
 */
export function planNotches(lastDelta: number, regionHeight: number): number {
  if (!(lastDelta > 0) || !(regionHeight > 0))
    return 1
  const wanted = Math.min(MAX_NOTCHES, Math.round((regionHeight * 0.25) / lastDelta))
  const capped = Math.floor((regionHeight - MIN_OVERLAP) / lastDelta)
  return Math.max(1, Math.min(wanted, capped))
}

/**
 * 下一步「发完滚轮先等多久再抓帧」：`tick` 是上一步的等待，`polls` 是那一步等稳
 * 用掉的轮询次数（1 = 第一轮就稳了）。
 *
 * - `polls === 1`：那一滚在 tick 内就停了（瞬时跳滚的应用 —— 终端、记事本），
 *   tick 减一档，别白等；
 * - `polls ≥ 2`：tick 到点时画面还在动，tick 加一档，把这一档的等待让给更长的首等
 *   （动画越长，早抓的帧越是白抓）；
 * - 夹在 `[TICK_MIN, TICK_MAX]`：下限保不被一次抖动带到 0 —— 等稳仍要「连续两帧
 *   字节一致」确认，抓早了只是多一轮轮询，不会被当成停稳；上限就是原来固定的
 *   150ms（滚动动画跑完大半）。
 *
 * 没量到（首步 / 抓帧失败）就按上限来。
 */
export function planTickDelay(tick: number, polls: number): number {
  if (!(polls >= 1))
    return TICK_MAX
  const next = polls === 1 ? tick - TICK_STEP : tick + TICK_STEP
  return Math.max(TICK_MIN, Math.min(TICK_MAX, next))
}

/**
 * 这一步要贴的条带从哪一行开始（条带一路贴到帧底），返回 h = 空条带（调用方只在
 * Δ > 0 时贴）。
 *
 * 向下滚 Δ 意味着新帧只有底部 Δ 行是新的，但条带**不从 h−Δ 起**，还要向上多要一段：
 *
 * - **越过粘底栏**：粘底栏在每帧的帧底都不动，只贴 h−Δ 起的条带会把它的副本每步
 *   留一份在长图里。条带向上多要 stickyBottom + pad 行后，起点的**绝对位置**
 *   （top + h − Δ − stickyBottom − pad = 上一步的 top + h − stickyBottom − pad）
 *   与 Δ 无关 —— 每一步都恰好落在上一份副本上方 8px，旧副本被新内容盖掉，
 *   粘底栏最终只在最后一帧的位置出现一次（照 eSearch 的 makePatch）；
 * - **不进粘头**：起点夹在 stickyTop 之下 —— 粘头在长图里只出现一次（第 0 帧），
 *   条带再往上扩也只是白盖。
 *
 * Δ 估错时的污染也被限制在这条带里（重叠区里的旧像素不再被整帧覆盖），8px 的
 * 上溢顺带校正个位数的 Δ 误差。
 */
export function planBand(
  delta: number,
  height: number,
  stickyTop: number,
  stickyBottom: number,
): number {
  if (!(delta > 0) || !(height > 0))
    return height
  const raw = height - delta - stickyBottom - BAND_PAD
  const lo = Math.min(stickyTop, height - 1)
  return Math.max(lo, Math.min(raw, height - 1))
}

/** 两帧字节是不是完全一样：等稳判定靠它（抓屏是确定的，同内容必同字节） */
export function bytesEqual(a: Uint8Array | ArrayBuffer, b: Uint8Array | ArrayBuffer): boolean {
  const left = a instanceof ArrayBuffer ? new Uint8Array(a) : a
  const right = b instanceof ArrayBuffer ? new Uint8Array(b) : b
  if (left.length !== right.length)
    return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i])
      return false
  }
  return true
}

/** 行号升序的「有内容」行：一行里 RGB 各通道自己的极差都 ≤ 门槛就是平行行，不参与打分 */
function usableRows(frame: StitchFrame): number[] {
  const { width, height, data } = frame
  const width4 = width * 4
  const rows: number[] = []
  for (let y = 0; y < height; y += 1) {
    const rowAt = y * width4
    let rMin = 255
    let rMax = 0
    let gMin = 255
    let gMax = 0
    let bMin = 255
    let bMax = 0
    for (let x = 0; x < width; x += COLUMN_STRIDE) {
      const at = rowAt + x * 4
      // 只看 RGB：抓屏帧的 alpha 恒 255，算进去会把所有行都误判成「不平」
      const r = data[at]
      const g = data[at + 1]
      const b = data[at + 2]
      if (r < rMin)
        rMin = r
      if (r > rMax)
        rMax = r
      if (g < gMin)
        gMin = g
      if (g > gMax)
        gMax = g
      if (b < bMin)
        bMin = b
      if (b > bMax)
        bMax = b
    }
    // 三个通道**各自**算极差：纯色色块（如 r=30/g=40/b=50）跨通道差得远，但空间上是平的
    if (rMax - rMin > FLAT_EPS || gMax - gMin > FLAT_EPS || bMax - bMin > FLAT_EPS)
      rows.push(y)
  }
  return rows
}

/** 从升序行号里均匀抽出至多 maxRows 行（初筛用：行数太多时按比例抽样） */
function strideRows(rows: number[], maxRows: number): number[] {
  if (rows.length <= maxRows)
    return rows
  const picked: number[] = []
  for (let i = 0; i < maxRows; i += 1)
    picked.push(rows[Math.floor((i * rows.length) / maxRows)])
  return picked
}

/** 一行的平均绝对差（每采样点每 RGB 通道）：next 的第 y 行 vs prev 的第 y+delta 行 */
function rowScore(prev: StitchFrame, next: StitchFrame, y: number, delta: number, colStride: number): number {
  const width4 = next.width * 4
  const nd = next.data
  const pd = prev.data
  const nRow = y * width4
  const pRow = (y + delta) * width4
  let sum = 0
  let count = 0
  for (let x = 0; x < next.width; x += colStride) {
    const nAt = nRow + x * 4
    const pAt = pRow + x * 4
    sum += Math.abs(nd[nAt] - pd[pAt])
      + Math.abs(nd[nAt + 1] - pd[pAt + 1])
      + Math.abs(nd[nAt + 2] - pd[pAt + 2])
    count += 3
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count
}

/** 候选 Δ 的初筛分数：给定行（截掉超出重叠范围的）的平均差 */
function meanScore(
  prev: StitchFrame,
  next: StitchFrame,
  rows: number[],
  delta: number,
  colStride: number,
): number {
  const limit = next.height - delta
  let sum = 0
  let count = 0
  for (const y of rows) {
    if (y >= limit)
      break // 行号升序，后面的全超出重叠范围
    sum += rowScore(prev, next, y, delta, colStride)
    count += 1
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count
}

/** 候选 Δ 的复核分数：全部有内容的行（截掉超出重叠范围的）逐行算差，取**中位数 */
function medianScore(
  prev: StitchFrame,
  next: StitchFrame,
  rows: number[],
  delta: number,
  colStride: number,
): number {
  const limit = next.height - delta
  const scores: number[] = []
  for (const y of rows) {
    if (y >= limit)
      break
    scores.push(rowScore(prev, next, y, delta, colStride))
  }
  if (scores.length < MIN_USABLE_ROWS)
    return Number.POSITIVE_INFINITY
  scores.sort((a, b) => a - b)
  const mid = scores.length >> 1
  return scores.length % 2 === 1 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2
}
