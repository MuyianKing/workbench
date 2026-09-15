import { describe, expect, it } from 'vitest'
import {
  PROJECT_COLOR_PRESETS,
  backfillProjectColors,
  isProjectColor,
  isProjectColorPreset,
  nextProjectColor,
  projectColorVar,
  sanitizeProjectColor
} from './project-color'

describe('sanitizeProjectColor', () => {
  it('预设名原样返回', () => {
    expect(sanitizeProjectColor('success')).toBe('success')
  })

  it('自定义色统一成小写六位：三位简写展开', () => {
    expect(sanitizeProjectColor('#4C8BF5')).toBe('#4c8bf5')
    expect(sanitizeProjectColor('#abc')).toBe('#aabbcc')
  })

  it('认不出来的一律当没设 —— 不会把颜色名或 rgba() 拼进样式表', () => {
    expect(sanitizeProjectColor('#ff0000ff')).toBeUndefined()
    expect(sanitizeProjectColor('#12345')).toBeUndefined()
    expect(sanitizeProjectColor('rgb(1,2,3)')).toBeUndefined()
    expect(sanitizeProjectColor('红色')).toBeUndefined()
    expect(sanitizeProjectColor(null)).toBeUndefined()
    expect(isProjectColor('warning')).toBe(true)
    expect(isProjectColor('#abc')).toBe(true)
    expect(isProjectColor('WARNING')).toBe(false)
  })

  it('预设取主题变量，自定义色就是它自己', () => {
    expect(projectColorVar('danger')).toBe('var(--el-color-danger)')
    expect(projectColorVar('#4c8bf5')).toBe('#4c8bf5')
  })

  it('预设与自定义色分得开', () => {
    expect(isProjectColorPreset('info')).toBe(true)
    expect(isProjectColorPreset('#4c8bf5')).toBe(false)
  })
})

describe('nextProjectColor', () => {
  it('没项目时给第一个', () => {
    expect(nextProjectColor([])).toBe(PROJECT_COLOR_PRESETS[0])
  })

  it('前五个项目各拿一个不同颜色', () => {
    const used: Array<(typeof PROJECT_COLOR_PRESETS)[number] | undefined> = []
    for (let i = 0; i < PROJECT_COLOR_PRESETS.length; i += 1) {
      const color = nextProjectColor(used)
      expect(used).not.toContain(color)
      used.push(color)
    }
    expect(new Set(used).size).toBe(PROJECT_COLOR_PRESETS.length)
  })

  it('颜色用满之后循环复用（取用得最少的那个）', () => {
    const used = [...PROJECT_COLOR_PRESETS]
    expect(nextProjectColor(used)).toBe(PROJECT_COLOR_PRESETS[0])
    // 第一个多用一个之后，就该轮到第二个
    expect(nextProjectColor([...PROJECT_COLOR_PRESETS, PROJECT_COLOR_PRESETS[0]])).toBe(
      PROJECT_COLOR_PRESETS[1]
    )
  })

  it('没设颜色的项目不占名额', () => {
    expect(nextProjectColor([undefined, undefined])).toBe(PROJECT_COLOR_PRESETS[0])
  })

  it('自定义色不占预设的名额：自动分配照旧从主题色开始', () => {
    expect(nextProjectColor(['#4c8bf5', '#123456'])).toBe(PROJECT_COLOR_PRESETS[0])
    expect(nextProjectColor(['#4c8bf5', 'success'])).toBe(PROJECT_COLOR_PRESETS[0])
  })
})

describe('backfillProjectColors', () => {
  it('给缺颜色的项目补上，已有的不动', () => {
    const patch = backfillProjectColors([
      { id: 'a', color: 'danger' },
      { id: 'b' },
      { id: 'c' }
    ])
    expect(patch).toEqual({ b: 'primary', c: 'success' })
  })

  it('自定义色也算「已有颜色」，不会被自动分配覆盖', () => {
    expect(backfillProjectColors([{ id: 'a', color: '#4c8bf5' }])).toEqual({})
  })

  it('全都已有颜色时给空表（不产生任何写入）', () => {
    expect(backfillProjectColors([{ id: 'a', color: 'info' }])).toEqual({})
    expect(backfillProjectColors([])).toEqual({})
  })

  it('手改坏的色值按没设处理，顺手纠正成合法值', () => {
    expect(backfillProjectColors([{ id: 'a', color: '红色' as never }])).toEqual({ a: 'primary' })
  })

  it('补出来的颜色彼此不同（各自都不与已用的重复）', () => {
    const patch = backfillProjectColors([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(new Set(Object.values(patch)).size).toBe(3)
  })
})
