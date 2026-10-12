import type { Annotation } from './annotation'
import { describe, expect, it } from 'vitest'
import { annotationBounds, distanceToPath, distanceToSegment, hitTestAnnotation, hitTestAnnotations, moveAnnotation } from './annotation'

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
