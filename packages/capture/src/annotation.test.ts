import type { Annotation } from './annotation'
import { describe, expect, it } from 'vitest'
import { annotationBounds, annotationHandles, ARROW_SPREAD, arrowHeadLength, arrowOutline, distanceToPath, distanceToSegment, hitAnnotationHandle, hitTestAnnotation, hitTestAnnotations, moveAnnotation, resizeAnnotation, restyleAnnotation } from './annotation'

const rect: Annotation = { id: 'r', tool: 'rect', start: { x: 10, y: 10 }, end: { x: 110, y: 60 }, color: '#f00', width: 4 }
const arrow: Annotation = { id: 'a', tool: 'arrow', start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, color: '#f00', width: 2 }
const pen: Annotation = { id: 'p', tool: 'pen', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], color: '#f00', width: 4 }
const text: Annotation = { id: 't', tool: 'text', at: { x: 20, y: 30 }, text: '你好', color: '#f00', size: 24, box: { width: 48, height: 30 } }
const mosaic: Annotation = { id: 'm', tool: 'mosaic', start: { x: 0, y: 0 }, end: { x: 40, y: 40 }, block: 8 }

describe('distanceToSegment', () => {
  it('垂足落在线段内时取垂距', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3)
  })

  it('垂足在线段外时取最近端点的距离', () => {
    expect(distanceToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
    expect(distanceToSegment({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
  })

  it('退化成一点时不除零', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5)
  })
})

describe('distanceToPath', () => {
  it('取折线里最近的那一段', () => {
    expect(distanceToPath({ x: 25, y: 2 }, pen.points)).toBe(2)
    expect(distanceToPath({ x: 52, y: 25 }, pen.points)).toBe(2)
  })

  it('空折线是无穷远，单点折线退化成点距', () => {
    expect(distanceToPath({ x: 0, y: 0 }, [])).toBe(Number.POSITIVE_INFINITY)
    expect(distanceToPath({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5)
  })
})

describe('annotationBounds', () => {
  it('拖出来的形状取两端点之间的矩形，不论方向', () => {
    expect(annotationBounds(rect)).toEqual({ x: 10, y: 10, width: 100, height: 50 })
    expect(annotationBounds({ ...rect, start: { x: 110, y: 60 }, end: { x: 10, y: 10 } }))
      .toEqual({ x: 10, y: 10, width: 100, height: 50 })
  })

  it('笔画算上半个线宽，免得线被选中框切掉一半', () => {
    expect(annotationBounds(pen)).toEqual({ x: -2, y: -2, width: 54, height: 54 })
  })

  it('文字用建的时候量好的尺寸', () => {
    expect(annotationBounds(text)).toEqual({ x: 20, y: 30, width: 48, height: 30 })
  })

  it('没有点的笔画退化成空矩形，不给无穷大', () => {
    expect(annotationBounds({ ...pen, points: [] })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('箭头算上那个头：头角比杆宽得多，只按两端点给框会把它切掉', () => {
    // 线宽 8、长 147：头长 26、半宽 26 × tan(21°) ≈ 9.98，杆才 ±4
    const long = annotationBounds({ id: 'a', tool: 'arrow', start: { x: 0, y: 0 }, end: { x: 147, y: 0 }, color: '#f00', width: 8 })
    expect(long.x).toBe(0)
    expect(long.width).toBe(147)
    expect(long.y).toBeCloseTo(-26 * Math.tan(ARROW_SPREAD), 6)
    expect(long.height).toBeCloseTo(2 * 26 * Math.tan(ARROW_SPREAD), 6)
  })
})

describe('箭头的样子（杆收尖 + 实心三角头）', () => {
  /** 一支线宽 8、长 147 的横向箭头（比例就是照参考样式量的那一支） */
  const long = { start: { x: 0, y: 0 }, end: { x: 147, y: 0 }, width: 8 }

  it('七个点的闭合轮廓：尖落在 end 上，尾巴收成一个尖', () => {
    const outline = arrowOutline(long)
    expect(outline).toHaveLength(7)
    expect(outline[3]).toEqual({ x: 147, y: 0 })
    // 尾巴那头只有 0.18 倍线宽（8 → 1.44，半个就是 0.72）
    expect(outline[0]).toEqual({ x: 0, y: 0.72 })
    expect(outline[6]).toEqual({ x: 0, y: -0.72 })
  })

  it('杆是收尖的锥形：接头处半个线宽，头角是头长 × tan(半角)', () => {
    const outline = arrowOutline(long)
    expect(outline[1].y).toBe(4)
    expect(outline[1].x).toBeCloseTo(147 - 26, 6)
    expect(outline[2].y).toBeCloseTo(26 * Math.tan(ARROW_SPREAD), 6)
    expect(outline[2].y).toBeGreaterThan(outline[1].y)
    expect(outline[4].y).toBeCloseTo(-outline[2].y, 6)
  })

  it('头随线宽等比放大：细箭头有个头的下限，粗的一半按比例', () => {
    expect(arrowHeadLength(long.start, long.end, 8)).toBe(26)
    expect(arrowHeadLength(long.start, long.end, 16)).toBe(52)
    // 线宽 2 按比例只有 6.5，太细了看不见，兜到下限 10
    expect(arrowHeadLength(long.start, long.end, 2)).toBe(10)
  })

  it('很短的箭头不让头吃掉整条：头最多占七成', () => {
    expect(arrowHeadLength({ x: 0, y: 0 }, { x: 20, y: 0 }, 8)).toBe(14)
    const outline = arrowOutline({ start: { x: 0, y: 0 }, end: { x: 20, y: 0 }, width: 8 })
    expect(outline[1].x).toBeCloseTo(6, 6)
  })

  it('两端点重合（点一下没拖）给空轮廓，不除零', () => {
    expect(arrowOutline({ start: { x: 5, y: 5 }, end: { x: 5, y: 5 }, width: 4 })).toEqual([])
  })
})

describe('hitTestAnnotation', () => {
  it('矩形按面判（含容差）', () => {
    expect(hitTestAnnotation(rect, { x: 50, y: 30 }, 0)).toBe(true)
    expect(hitTestAnnotation(rect, { x: 5, y: 30 }, 3)).toBe(true)
    expect(hitTestAnnotation(rect, { x: 5, y: 30 }, 1)).toBe(false)
  })

  it('箭头按线判：包围盒正中间的空白抓不到', () => {
    // (90, 10) 在包围盒里，但离对角线很远
    expect(hitTestAnnotation(arrow, { x: 90, y: 10 }, 2)).toBe(false)
    expect(hitTestAnnotation(arrow, { x: 50, y: 50 }, 2)).toBe(true)
  })

  it('鼠标在马赛克与文字上按面判', () => {
    expect(hitTestAnnotation(mosaic, { x: 20, y: 20 }, 0)).toBe(true)
    expect(hitTestAnnotation(text, { x: 30, y: 40 }, 0)).toBe(true)
    expect(hitTestAnnotation(text, { x: 80, y: 40 }, 0)).toBe(false)
  })
})

describe('hitTestAnnotations', () => {
  it('从后往前找：压在上面的那条先被选中', () => {
    const bottom: Annotation = { ...rect, id: 'bottom' }
    const top: Annotation = { ...rect, id: 'top' }
    expect(hitTestAnnotations([bottom, top], { x: 50, y: 30 }, 0)).toBe(1)
  })

  it('一条都没命中时 null', () => {
    expect(hitTestAnnotations([rect], { x: 500, y: 500 }, 0)).toBeNull()
    expect(hitTestAnnotations([], { x: 0, y: 0 }, 0)).toBeNull()
  })
})

describe('moveAnnotation', () => {
  const delta = { x: 5, y: -5 }

  it('形状平移两个端点', () => {
    expect(moveAnnotation(rect, delta)).toMatchObject({ start: { x: 15, y: 5 }, end: { x: 115, y: 55 } })
  })

  it('笔画平移所有点', () => {
    expect(moveAnnotation(pen, delta)).toMatchObject({ points: [{ x: 5, y: -5 }, { x: 55, y: -5 }, { x: 55, y: 45 }] })
  })

  it('文字平移锚点', () => {
    expect(moveAnnotation(text, delta)).toMatchObject({ at: { x: 25, y: 25 } })
  })

  it('原对象不被改（纯函数）', () => {
    const before = JSON.stringify(rect)
    moveAnnotation(rect, delta)
    expect(JSON.stringify(rect)).toBe(before)
  })
})

describe('选中之后的把手（改大小）', () => {
  it('矩形 / 椭圆 / 马赛克摆八个把手，位置就是包围盒那八个', () => {
    const handles = annotationHandles(rect)
    expect(handles.map(handle => handle.id)).toEqual(['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'])
    expect(handles.find(handle => handle.id === 'nw')?.point).toEqual({ x: 10, y: 10 })
    expect(handles.find(handle => handle.id === 'e')?.point).toEqual({ x: 110, y: 35 })
    expect(annotationHandles(mosaic)).toHaveLength(8)
  })

  it('箭头只摆两端，id 按斜向取（光标形状才对）', () => {
    // 从左上到右下：start 是左上角那端
    const down = annotationHandles(arrow)
    expect(down.map(handle => handle.id)).toEqual(['nw', 'se'])
    expect(down[0].point).toEqual(arrow.start)
    expect(down[1].point).toEqual(arrow.end)

    // 从左下到右上（反方向）：两端各换一个角
    const up: Annotation = { ...arrow, start: { x: 0, y: 100 }, end: { x: 100, y: 0 } }
    expect(annotationHandles(up).map(handle => handle.id)).toEqual(['ne', 'sw'])
  })

  it('文字与笔画不摆把手（没有「框」这层几何）', () => {
    expect(annotationHandles(text)).toEqual([])
    expect(annotationHandles(pen)).toEqual([])
  })

  it('命中取容差内最近的那个，没把手的不认', () => {
    expect(hitAnnotationHandle(rect, { x: 108, y: 62 }, 5)).toBe('se')
    expect(hitAnnotationHandle(rect, { x: 50, y: 30 }, 5)).toBeNull()
    expect(hitAnnotationHandle(text, { x: 20, y: 30 }, 10)).toBeNull()

    // 箭头两端：按在起点那一端命中起点的把手
    expect(hitAnnotationHandle(arrow, { x: 3, y: 3 }, 6)).toBe('nw')
    expect(hitAnnotationHandle(arrow, { x: 98, y: 98 }, 6)).toBe('se')
  })

  it('拖矩形 / 马赛克的把手：只动那一侧，拖过对边会翻转', () => {
    expect(resizeAnnotation(rect, 'e', { x: 20, y: 0 }))
      .toMatchObject({ start: { x: 10, y: 10 }, end: { x: 130, y: 60 } })
    // 左边界被拖到右边去 → 翻转：新块在原右边界的左边（normalizeRect 的口径，与选区一致）
    const flipped = resizeAnnotation(rect, 'w', { x: 120, y: 0 })
    expect(annotationBounds(flipped)).toEqual({ x: 110, y: 10, width: 20, height: 50 })

    expect(resizeAnnotation(mosaic, 'se', { x: 10, y: 10 })).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 50, y: 50 } })
  })

  it('拖箭头的把手：只动被拖的那一端，另一头不动', () => {
    expect(resizeAnnotation(arrow, 'nw', { x: 10, y: -10 })).toMatchObject({ start: { x: 10, y: -10 }, end: { x: 100, y: 100 } })
    expect(resizeAnnotation(arrow, 'se', { x: 5, y: 5 })).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 105, y: 105 } })
  })

  it('原对象不被改（纯函数）', () => {
    const before = JSON.stringify(rect)
    resizeAnnotation(rect, 'se', { x: 5, y: 5 })
    expect(JSON.stringify(rect)).toBe(before)
  })
})

describe('选中之后改参数（工具条上点的那几项）', () => {
  it('形状与笔画改颜色 / 线宽', () => {
    expect(restyleAnnotation(rect, { color: '#00f', width: 8 })).toMatchObject({ color: '#00f', width: 8 })
    expect(restyleAnnotation(pen, { width: 2 })).toMatchObject({ width: 2, color: '#f00' })
    expect(restyleAnnotation(arrow, { color: '#000' })).toMatchObject({ color: '#000', width: 2 })
  })

  it('马赛克只认格子边长（别的项对它是无意义的）', () => {
    expect(restyleAnnotation(mosaic, { block: 24 })).toMatchObject({ block: 24 })
    expect(restyleAnnotation(mosaic, { color: '#00f', width: 8 })).toEqual(mosaic)
  })

  it('文字改颜色，字号与量好的框成对改', () => {
    expect(restyleAnnotation(text, { color: '#00f' })).toMatchObject({ color: '#00f', size: 24, box: { width: 48, height: 30 } })
    expect(restyleAnnotation(text, { size: 32, box: { width: 64, height: 42 } }))
      .toMatchObject({ size: 32, box: { width: 64, height: 42 } })
    // 只给字号不给框：不认（框是量出来的，留一个对不上的尺寸在那儿更糟）
    expect(restyleAnnotation(text, { size: 32 })).toEqual(text)
  })

  it('原对象不被改（纯函数）', () => {
    const before = JSON.stringify(text)
    restyleAnnotation(text, { color: '#00f', size: 32, box: { width: 64, height: 42 } })
    expect(JSON.stringify(text)).toBe(before)
  })
})
