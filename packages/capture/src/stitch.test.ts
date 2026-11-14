import type { StitchFrame } from './stitch'
import { describe, expect, it } from 'vitest'
import { analyzeScrollOffset, bytesEqual, planBand, planNotches, planTickDelay, scrollOffset, TICK_MAX } from './stitch'

/** 一条「页面内容」的确定性花纹：像素值跟 y 有关，行与行都能区分 */
function pagePixel(x: number, y: number): [number, number, number] {
  return [
    (x * 7 + y * 13) % 251,
    (x * 11 + y * 5 + ((x + y) % 7)) % 241,
    (x * 3 + y * 17 + ((x * y) % 29)) % 233,
  ]
}

/**
 * 稀疏页面（GitHub 首页那一类）：整页几乎全白，每 200 行里只有 40 行有内容。
 * 按条带匹配的旧方案在它身上挂过 —— 条带全落在留白里，被平坦保护误判成「无意义」。
 */
function sparsePixel(x: number, y: number): [number, number, number] {
  return y % 200 < 40 ? pagePixel(x, y) : [255, 255, 255]
}

function makeFrame(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): StitchFrame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

/**
 * 把 painter 表示的页面向下滚 delta 像素后的那一帧：顶部 h−Δ 行是原内容平移，
 * 底部 Δ 行是「新露出的内容」。stickyTop 给了的话，顶部 stickyTop 行保持原样
 * （粘性头部每一帧都停在同一个屏幕位置）。
 */
function makeShifted(
  width: number,
  height: number,
  painter: (x: number, y: number) => [number, number, number],
  delta: number,
  stickyTop = 0,
): StitchFrame {
  return makeFrame(width, height, (x, y) => {
    if (y < stickyTop)
      return painter(x, y)
    if (y < height - delta)
      return painter(x, y + delta)
    return pagePixel(x + 131, y + height * 7) // 新露出的内容：换一段没出现过的花纹
  })
}

describe('scrollOffset', () => {
  const W = 320
  const H = 600

  it('精确位移：内容下滚 137px 就报 137', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeShifted(W, H, pagePixel, 137)
    expect(scrollOffset(prev, next)).toBe(137)
  })

  it('没有滚动（变化只是零星几行，比如光标在闪）报 0', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeShifted(W, H, pagePixel, 0)
    // 顶部两行抹花：帧字节变了，但绝大多数有内容的行没动，中位数不受影响
    for (let x = 0; x < W; x += 1) {
      next.data[x * 4] = 255
      next.data[W * 4 + x * 4] = 255
    }
    expect(scrollOffset(prev, next)).toBe(0)
  })

  it('粘性头部每帧都在同一位置，位移照样找得到', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeShifted(W, H, pagePixel, 200, 60)
    expect(scrollOffset(prev, next)).toBe(200)
  })

  it('稀疏页面（大片留白 + 零星几块字）也能精确匹配 —— 留白行不参与打分', () => {
    const prev = makeFrame(W, H, sparsePixel)
    const next = makeShifted(W, H, sparsePixel, 120)
    expect(scrollOffset(prev, next)).toBe(120)
  })

  it('会动的行（动画 / 彩带）是离群值，中位数把它们吸收掉', () => {
    // 在稀疏页面的一条内容带里塞进一段逐帧变化的花纹：它在两帧里对不上，
    // 但只占少数行 —— 真解的中位差仍是 0
    const animated = (x: number, y: number, salt: number): [number, number, number] => pagePixel(x + salt, y + salt)
    const painter = (salt: number) => (x: number, y: number): [number, number, number] =>
      y >= 208 && y < 232 ? animated(x, y, salt) : sparsePixel(x, y)
    const prev = makeFrame(W, H, painter(0))
    const next = makeShifted(W, H, painter(400), 120)
    expect(scrollOffset(prev, next)).toBe(120)
  })

  it('两帧内容对不上（整屏换成了别的花纹）返回 null', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeFrame(W, H, (x, y) => pagePixel(x + 131, y + 503))
    expect(scrollOffset(prev, next)).toBeNull()
  })

  it('整页纯色（一个有内容的行都没有）匹配无意义，返回 null', () => {
    const prev = makeFrame(W, H, () => [240, 240, 240])
    const next = makeFrame(W, H, () => [240, 240, 240])
    expect(scrollOffset(prev, next)).toBeNull()
  })

  it('尺寸对不上直接 null（选区是固定死的，这不该发生）', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeFrame(W, H - 10, pagePixel)
    expect(scrollOffset(prev, next)).toBeNull()
  })

  it('小选区（192px 高）也能精确匹配', () => {
    const prev = makeFrame(W, 192, pagePixel)
    const next = makeShifted(W, 192, pagePixel, 40)
    expect(scrollOffset(prev, next)).toBe(40)
  })
})

describe('analyzeScrollOffset', () => {
  const W = 320
  const H = 600

  it('预测命中：hint 附近的小窗口直接找回真位移', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeShifted(W, H, pagePixel, 137)
    const result = analyzeScrollOffset(prev, next, { hintDelta: 137 })
    expect(result.delta).toBe(137)
    expect(result.stickyTop).toBe(0)
    expect(result.stickyBottom).toBe(0)
  })

  it('预测失灵（页面布局位移）时回退全量扫，照样找回真位移', () => {
    const prev = makeFrame(W, H, pagePixel)
    const next = makeShifted(W, H, pagePixel, 400)
    expect(analyzeScrollOffset(prev, next, { hintDelta: 40 }).delta).toBe(400)
  })

  it('重复纹理并列时取离预测最近的 Δ（破平局），没预测保持最小档', () => {
    // 行花纹以 40px 为周期：Δ ≡ 137 (mod 40) 的每一档中位差都是 0
    const periodic = (x: number, y: number): [number, number, number] => pagePixel(x, y % 40)
    const prev = makeFrame(W, H, periodic)
    const next = makeFrame(W, H, (x, y) => periodic(x, y + 137))
    // 有预测：137 在并列集里，取离它最近的
    expect(analyzeScrollOffset(prev, next, { hintDelta: 137 }).delta).toBe(137)
    // 没预测：并列集 {17, 57, …, 537} 按初筛序取最小，与旧口径一致
    expect(scrollOffset(prev, next)).toBe(17)
  })

  it('粘底栏：行被剔除、位移照样精确，stickyBottom 如实报数', () => {
    // 帧底 60 行是粘底栏（两帧在同一屏幕位置一模一样），其余内容下滚 137
    const withFooter = (scroll: number) => (x: number, y: number): [number, number, number] =>
      y >= H - 60 ? pagePixel(x + 999, y) : pagePixel(x, y + scroll)
    const prev = makeFrame(W, H, withFooter(0))
    const next = makeFrame(W, H, withFooter(137))
    const result = analyzeScrollOffset(prev, next)
    expect(result.delta).toBe(137)
    expect(result.stickyBottom).toBe(60)
    expect(result.stickyTop).toBe(0)
    expect(analyzeScrollOffset(prev, next, { hintDelta: 137 }).delta).toBe(137)
  })

  it('剔完好内容行不足最少行数时退回整集打分，不误报 null', () => {
    // 192 高的帧：花纹行每 20px 一条（随滚动挪行），另有两行粘住的悬浮条。剔掉
    // 2 行粘行后行集在复核阶段会被重叠截断削短（Δ 大时底部行不参与打分），凑不齐
    // 最少行数 —— 剔行集对不上要退回整集（12 行）再扫：粘行在真解处也是 0，
    // 中位数照样把真解顶出来。没有这道兜底就是 null
    const H2 = 192
    const overlayRows = new Set([0, 20])
    const painter = (salt: number) => (x: number, y: number): [number, number, number] => {
      if (overlayRows.has(y))
        return pagePixel(x + 777, y)
      return (y + salt) % 20 === 0 ? pagePixel(x, y + salt) : [255, 255, 255]
    }
    const prev = makeFrame(W, H2, painter(0))
    const next = makeFrame(W, H2, painter(30))
    expect(analyzeScrollOffset(prev, next).delta).toBe(30)
  })
})

describe('planBand', () => {
  const H = 600

  it('基本式：新内容线向上多贴 pad 行', () => {
    expect(planBand(150, H, 0, 0)).toBe(H - 150 - 8)
  })

  it('粘底栏占位时再向上多让一段（盖掉上一帧留下的副本）', () => {
    expect(planBand(150, H, 0, 60)).toBe(H - 150 - 60 - 8)
  })

  it('条带起点不进粘头', () => {
    // 巨大 Δ 把起点压到粘头之上，夹回 stickyTop
    expect(planBand(560, H, 80, 0)).toBe(80)
  })

  it('δ=0 没有可贴的条带', () => {
    expect(planBand(0, H, 0, 0)).toBe(H)
  })
})

describe('planTickDelay', () => {
  it('第一步就稳了（瞬时跳滚）：tick 降一档', () => {
    expect(planTickDelay(TICK_MAX, 1)).toBe(TICK_MAX - 40)
  })

  it('首等之后画面还在动：tick 升一档', () => {
    expect(planTickDelay(70, 2)).toBe(110)
    expect(planTickDelay(70, 5)).toBe(110)
  })

  it('夹在上下限里：降不到 40 以下、升不过 150', () => {
    expect(planTickDelay(40, 1)).toBe(40)
    expect(planTickDelay(TICK_MAX, 2)).toBe(TICK_MAX)
  })

  it('没量到（首步 / 抓帧失败）按上限来', () => {
    expect(planTickDelay(70, 0)).toBe(TICK_MAX)
  })
})

describe('planNotches', () => {
  it('上一步 100px、选区 600 高：目标步长 150px，发 2 齿', () => {
    // round(0.25 * 600 / 100) = 2；上限 floor((600-48) / 100) = 5 拦不住它
    expect(planNotches(100, 600)).toBe(2)
  })

  it('一步的量快够不着重叠下限时退回 1 齿', () => {
    // round(150 / 400) = 0 → 至少 1；floor(552 / 400) = 1
    expect(planNotches(400, 600)).toBe(1)
  })

  it('一步太小就顶到齿数上限（3 齿）', () => {
    // round(150 / 30) = 5 → 上限 3
    expect(planNotches(30, 600)).toBe(3)
  })

  it('没量过位移（首步）或参数不合法时发 1 齿', () => {
    expect(planNotches(0, 600)).toBe(1)
    expect(planNotches(100, 0)).toBe(1)
  })
})

describe('bytesEqual', () => {
  it('全等才真：差一个字节、长度不同都算不等，ArrayBuffer 与 TypedArray 混着给也认', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]))).toBe(true)
  })
})

describe('滚动拼接端到端', () => {
  it('按 planNotches 滚一整页，每步的位移都精确找回，拼完总高正好一页', () => {
    const W = 320
    const H = 600
    const PAGE_HEIGHT = 3000
    const NOTCH_PX = 100 // 每齿滚 100px（多数应用一格滚轮的量级）

    let top = 0 // 当前帧对准的页面行
    let stitchedHeight = H
    let notches = 1
    let prev = makeFrame(W, H, (x, y) => pagePixel(x, top + y))

    for (let step = 0; step < 40; step += 1) {
      // 页面滚到底就停在最后一屏（滚动量被页面高度截住）
      const requested = notches * NOTCH_PX
      const actual = Math.min(requested, PAGE_HEIGHT - H - top)
      if (actual <= 0)
        break

      const next = makeFrame(W, H, (x, y) => pagePixel(x, top + actual + y))
      const delta = scrollOffset(prev, next)
      expect(delta).not.toBeNull()
      expect(delta).toBe(actual) // 每一步都找回真实位移

      top += delta!
      stitchedHeight = top + H
      prev = next
      notches = planNotches(delta!, H)
    }

    expect(stitchedHeight).toBe(PAGE_HEIGHT)
  })
})

describe('hint + 条带贴端到端', () => {
  it('按 planNotches 滚整页、每步 hint 窗口找回位移、只贴条带：粘底栏只在最后一段出现一次', () => {
    const W = 320
    const H = 600
    const FOOTER = 40 // 粘底栏高度：每一屏的视口底部都是它
    const CONTENT_H = 2600 // 内容区总高（滚到底时页面行 [0, CONTENT_H) 全部露出过）
    const NOTCH_PX = 100
    const BOTTOM = CONTENT_H - (H - FOOTER) // 滚到底时 top 的最终值

    const footerP = (x: number, y: number): [number, number, number] => pagePixel(x + 999, y)
    // 滚到 top 时的那一帧：视口底部 FOOTER 行是粘底栏，其余是页面行 [top, top + H − FOOTER)
    const frame = (top: number) => makeFrame(W, H, (x, y) =>
      y >= H - FOOTER ? footerP(x, y) : pagePixel(x, top + y))

    // 长图（纯数组模拟渲染层的画布）：第 0 帧整帧贴，之后每步只贴 planBand 的条带
    const longH = CONTENT_H + FOOTER
    const image = new Uint8ClampedArray(W * longH * 4)
    const paste = (frameData: StitchFrame, bandTop: number, at: number) => {
      const w4 = W * 4
      for (let y = bandTop; y < H; y += 1)
        image.set(frameData.data.subarray(y * w4, (y + 1) * w4), (at + y) * w4)
    }

    let top = 0
    let lastDelta = 0
    let notches = 1
    let prev = frame(0)
    paste(prev, 0, 0)

    for (let step = 0; step < 40; step += 1) {
      const actual = Math.min(notches * NOTCH_PX, BOTTOM - top)
      if (actual <= 0)
        break
      const next = frame(top + actual)
      const hintDelta = lastDelta > 0 ? lastDelta * notches : undefined
      const result = analyzeScrollOffset(prev, next, { hintDelta })
      expect(result.delta).toBe(actual)
      expect(result.stickyBottom).toBe(FOOTER)
      const delta = result.delta!
      top += delta
      paste(next, planBand(delta, H, result.stickyTop, result.stickyBottom), top)
      lastDelta = delta
      prev = next
      notches = planNotches(delta, H)
    }

    expect(top).toBe(BOTTOM)
    // 期望长图：内容行 = 页面本身（中途留下的粘底栏副本全被后续条带盖掉），
    // 最后 FOOTER 行 = 最后一帧的粘底栏（只出现这一次）
    const expected = new Uint8ClampedArray(W * longH * 4)
    for (let a = 0; a < longH; a += 1) {
      for (let x = 0; x < W; x += 1) {
        const [r, g, b] = a < CONTENT_H ? pagePixel(x, a) : footerP(x, a - BOTTOM)
        const at = (a * W + x) * 4
        expected[at] = r
        expected[at + 1] = g
        expected[at + 2] = b
        expected[at + 3] = 255
      }
    }
    expect(bytesEqual(image.buffer, expected.buffer)).toBe(true)
  })
})
