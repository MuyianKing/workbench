import { describe, expect, it } from 'vitest'
import {
  DIAL_BOX,
  litCount,
  TICK_COUNT,
  TICK_LENGTH,
  TICK_RADIUS,
  tickMarks,
} from './dial'

const CENTER = DIAL_BOX / 2

/** 一格刻度的内端相对圆心的角度（0° 在 3 点钟、顺时针为正） */
function innerAngle(mark: { x1: number, y1: number }): number {
  return (Math.atan2(mark.y1 - CENTER, mark.x1 - CENTER) * 180) / Math.PI
}

describe('tickMarks', () => {
  it('永远是一整圈 48 格', () => {
    expect(tickMarks(0.5, 0.5)).toHaveLength(TICK_COUNT)
    expect(tickMarks(null, 0.5)).toHaveLength(TICK_COUNT)
    expect(tickMarks(2, 0.5)).toHaveLength(TICK_COUNT)
  })

  it('第 0 格在 12 点，顺时针每格 7.5°', () => {
    const marks = tickMarks(1, 1)
    expect(innerAngle(marks[0])).toBeCloseTo(-90, 0)
    expect(innerAngle(marks[1])).toBeCloseTo(-82.5, 0)
    expect(innerAngle(marks[24])).toBeCloseTo(90, 0)
    expect(innerAngle(marks[47])).toBeCloseTo(-97.5, 0)
  })

  it('刻度落在内端与外端两个半径上', () => {
    for (const mark of tickMarks(1, 0.5)) {
      expect(Math.hypot(mark.x1 - CENTER, mark.y1 - CENTER)).toBeCloseTo(TICK_RADIUS, 1)
      expect(Math.hypot(mark.x2 - CENTER, mark.y2 - CENTER)).toBeCloseTo(TICK_RADIUS + TICK_LENGTH, 1)
    }
  })

  it('没流量时一格都不亮', () => {
    expect(litCount(tickMarks(0, 0.5))).toBe(0)
  })

  it('跑满时整圈都亮', () => {
    expect(litCount(tickMarks(1, 0.5))).toBe(TICK_COUNT)
    // 超过 1 也夹在整圈
    expect(litCount(tickMarks(9, 0.5))).toBe(TICK_COUNT)
  })

  it('点亮多少格按比例取整', () => {
    expect(litCount(tickMarks(0.5, 0.5))).toBe(24)
    expect(litCount(tickMarks(0.25, 0.5))).toBe(12)
    // 凑不满半格就是 0：宁可看着没动静，也不虚报一格
    expect(litCount(tickMarks(0.005, 0.5))).toBe(0)
  })

  it('点亮的那一段里，前面是下行、后面是上行', () => {
    const marks = tickMarks(0.5, 0.75)
    expect(litCount(marks)).toBe(24)
    const down = marks.filter(mark => mark.state === 'down').length
    const up = marks.filter(mark => mark.state === 'up').length
    expect(down).toBe(18)
    expect(up).toBe(6)
    // 下行那段一定排在前面（从 12 点顺时针数）
    expect(marks[0].state).toBe('down')
    expect(marks[17].state).toBe('down')
    expect(marks[18].state).toBe('up')
    expect(marks[23].state).toBe('up')
    expect(marks[24].state).toBe('off')
  })

  it('全是下行时没有橙格，全是上行时没有绿格', () => {
    const allDown = tickMarks(0.5, 1)
    expect(allDown.filter(m => m.state === 'up')).toHaveLength(0)
    expect(allDown.filter(m => m.state === 'down')).toHaveLength(24)

    const allUp = tickMarks(0.5, 0)
    expect(allUp.filter(m => m.state === 'down')).toHaveLength(0)
    expect(allUp.filter(m => m.state === 'up')).toHaveLength(24)
  })

  it('取不到链路带宽时整圈都不亮（留一条暗轨道）', () => {
    expect(litCount(tickMarks(null, 0.5))).toBe(0)
  })

  it('比例与份数越界都被夹住', () => {
    expect(litCount(tickMarks(-1, 0.5))).toBe(0)
    // 份数越界夹到 0 或 1：负的当成「全算上行」，亮的格数不受影响
    expect(litCount(tickMarks(0.5, -1))).toBe(24)
    expect(tickMarks(0.5, -1).filter(m => m.state === 'up')).toHaveLength(24)
    expect(litCount(tickMarks(0.5, 5))).toBe(24)
    expect(tickMarks(0.5, 5).filter(m => m.state === 'down')).toHaveLength(24)
  })

  it('坐标都是有限数（画得出来）', () => {
    for (const mark of tickMarks(0.5, 0.5)) {
      for (const value of [mark.x1, mark.y1, mark.x2, mark.y2])
        expect(Number.isFinite(value)).toBe(true)
    }
  })
})
