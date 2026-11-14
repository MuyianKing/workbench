import { describe, expect, it } from 'vitest'
import { autoToolbarPosition, clampToolbarPosition } from './toolbar'

describe('autoToolbarPosition', () => {
  const toolbar = { width: 200, height: 60 }

  it('默认贴选区下方、横向贴右缘', () => {
    const canvas = { width: 1920, height: 1080 }
    const rect = { x: 100, y: 100, width: 400, height: 300 }
    // top = 100 + 300 + 10；right = 100 + 400 - 200
    expect(autoToolbarPosition(rect, toolbar, canvas, 10)).toEqual({ x: 300, y: 410 })
  })

  it('下面放不下翻到上面', () => {
    const canvas = { width: 1920, height: 1080 }
    const rect = { x: 100, y: 900, width: 400, height: 170 }
    // 900 + 170 + 10 + 60 > 1080 → 翻上去：900 - 60 - 10
    expect(autoToolbarPosition(rect, toolbar, canvas, 10)).toEqual({ x: 300, y: 830 })
  })

  it('上下都放不下压进选区底部', () => {
    const canvas = { width: 800, height: 120 }
    const rect = { x: 50, y: 20, width: 600, height: 80 }
    // 翻上去 20 - 60 - 10 < 0 → 压进底部 min(20 + 80 - 60 - 10, 120 - 60 - 10) = 30
    expect(autoToolbarPosition(rect, toolbar, canvas, 10)).toEqual({ x: 450, y: 30 })
  })

  it('压也压不进时贴到 gap 那条线，不倒挂', () => {
    const canvas = { width: 500, height: 500 }
    const rect = { x: 0, y: 30, width: 400, height: 100 }
    const tall = { width: 200, height: 450 }
    // 翻上去 30 - 450 - 10 < 0 → min(30 + 100 - 450 - 10, 500 - 450 - 10) = -330 → 夹回 gap
    expect(autoToolbarPosition(rect, tall, canvas, 10).y).toBe(10)
  })

  it('贴右缘出画布时夹回来', () => {
    const canvas = { width: 1000, height: 800 }
    // 选区贴着画布右缘：右缘 1000 > 1000 - 10，right = 1000 - 200 超出上限
    const rect = { x: 910, y: 100, width: 90, height: 100 }
    expect(autoToolbarPosition(rect, toolbar, canvas, 10)).toEqual({ x: 790, y: 210 })
  })

  it('选区比工具条窄时贴到左缘的 gap', () => {
    const canvas = { width: 1000, height: 800 }
    const rect = { x: 0, y: 0, width: 100, height: 100 }
    expect(autoToolbarPosition(rect, toolbar, canvas, 10)).toEqual({ x: 10, y: 110 })
  })
})

describe('clampToolbarPosition', () => {
  const size = { width: 200, height: 60 }

  it('出右 / 下边夹回来', () => {
    expect(clampToolbarPosition({ x: 1800, y: 1050 }, size, { width: 1920, height: 1080 }, 2))
      .toEqual({ x: 1718, y: 1018 })
  })

  it('出左 / 上边夹到 margin', () => {
    expect(clampToolbarPosition({ x: -50, y: -50 }, size, { width: 1920, height: 1080 }, 2))
      .toEqual({ x: 2, y: 2 })
  })

  it('边界比工具条还小时退到 margin 那一点，不倒挂', () => {
    expect(clampToolbarPosition({ x: 40, y: 20 }, size, { width: 100, height: 50 }, 2))
      .toEqual({ x: 2, y: 2 })
  })
})
