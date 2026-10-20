import type { AccentVariableName, AccentVariables } from './accent-color'
import { describe, expect, it } from 'vitest'
import { ACCENT_COLOR_DEFAULT, ACCENT_INK_DEFAULT, ACCENT_PRESETS, ACCENT_VARIABLE_NAMES, accentVariables, contrastRatio, inkOnAccent, mixHex, relativeLuminance, sanitizeAccentColor, sanitizeAccentInkMode } from './accent-color'

/** 取一个派生变量；缺失就是用例失败，省得每处都写非空断言 */
function varOf(vars: AccentVariables, name: AccentVariableName): string {
  const value = vars[name]
  expect(value, `缺少 ${name}`).toBeTruthy()
  return value ?? ''
}

describe('sanitizeAccentColor', () => {
  it('六位色值统一成小写', () => {
    expect(sanitizeAccentColor('#2F6BD8')).toBe('#2f6bd8')
    expect(sanitizeAccentColor('  #2f6bd8  ')).toBe('#2f6bd8')
  })

  it('三位简写补齐成六位', () => {
    expect(sanitizeAccentColor('#abc')).toBe('#aabbcc')
  })

  it('认不出来的写法一律当「没配」', () => {
    expect(sanitizeAccentColor('#12345')).toBe(ACCENT_COLOR_DEFAULT)
    expect(sanitizeAccentColor('2f6bd8')).toBe(ACCENT_COLOR_DEFAULT)
    expect(sanitizeAccentColor('rgb(47, 107, 216)')).toBe(ACCENT_COLOR_DEFAULT)
    expect(sanitizeAccentColor('')).toBe(ACCENT_COLOR_DEFAULT)
    expect(sanitizeAccentColor(undefined)).toBe(ACCENT_COLOR_DEFAULT)
    expect(sanitizeAccentColor(null)).toBe(ACCENT_COLOR_DEFAULT)
    expect(sanitizeAccentColor(0x2F6BD8)).toBe(ACCENT_COLOR_DEFAULT)
  })
})

describe('mixHex', () => {
  it('按比例混色，ratio 是被混入那一边的占比', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('比例越界会被夹到 0~1', () => {
    expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 5)).toBe('#ffffff')
  })
})

describe('对比度', () => {
  it('黑白对比度是 21，同色是 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#2f6bd8', '#2f6bd8')).toBeCloseTo(1, 5)
  })

  it('亮度随颜色变浅单调上升', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#2f6bd8')).toBeGreaterThan(relativeLuminance('#1b212a'))
  })
})

describe('sanitizeAccentInkMode', () => {
  it('认得的三种取值原样返回', () => {
    expect(sanitizeAccentInkMode('auto')).toBe('auto')
    expect(sanitizeAccentInkMode('white')).toBe('white')
    expect(sanitizeAccentInkMode('dark')).toBe('dark')
  })

  it('认不出来的一律回到「自动」', () => {
    expect(sanitizeAccentInkMode(undefined)).toBe(ACCENT_INK_DEFAULT)
    expect(sanitizeAccentInkMode(null)).toBe(ACCENT_INK_DEFAULT)
    expect(sanitizeAccentInkMode('')).toBe(ACCENT_INK_DEFAULT)
    expect(sanitizeAccentInkMode('black')).toBe(ACCENT_INK_DEFAULT)
    expect(sanitizeAccentInkMode(1)).toBe(ACCENT_INK_DEFAULT)
  })
})

describe('inkOnAccent', () => {
  it('饱和的主色上一律给白字（实心块上的惯例）', () => {
    expect(inkOnAccent('#2f6bd8')).toBe('#ffffff')
    expect(inkOnAccent('#11151b')).toBe('#ffffff')
    // 中等明度的红：近黑字算下来略高一点，但白字才是主按钮一贯的样子
    expect(inkOnAccent('#db4c4c')).toBe('#ffffff')
  })

  it('主色浅到白字读不清时才换成近黑字', () => {
    expect(inkOnAccent('#fde68a')).toBe('#11151b')
    expect(inkOnAccent('#93c5fd')).toBe('#11151b')
    expect(inkOnAccent('#ffffff')).toBe('#11151b')
  })

  it('手动指定时不做判断，浅底上要白字也给白字', () => {
    expect(inkOnAccent('#fde68a', 'white')).toBe('#ffffff')
    expect(inkOnAccent('#11151b', 'white')).toBe('#ffffff')
    expect(inkOnAccent('#2f6bd8', 'dark')).toBe('#11151b')
    expect(inkOnAccent('#ffffff', 'dark')).toBe('#11151b')
  })

  it('不传 mode 时按自动处理', () => {
    expect(inkOnAccent('#db4c4c')).toBe(inkOnAccent('#db4c4c', ACCENT_INK_DEFAULT))
  })
})

describe('accentVariables', () => {
  it('没配（或非法）时返回空对象，交给 tokens.css', () => {
    expect(accentVariables('', 'light')).toEqual({})
    expect(accentVariables('tomato', 'dark')).toEqual({})
  })

  it('主色原样带上，派生变量一个不少', () => {
    const vars = accentVariables('#2f6bd8', 'light')
    expect(vars['--el-color-primary']).toBe('#2f6bd8')
    for (const name of ACCENT_VARIABLE_NAMES) {
      expect(varOf(vars, name)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('亮色主题的浅色档越混越白', () => {
    const primary = relativeLuminance(ACCENT_PRESETS[0])
    const vars = accentVariables(ACCENT_PRESETS[0], 'light')

    const light3 = relativeLuminance(varOf(vars, '--el-color-primary-light-3'))
    expect(light3).toBeGreaterThan(primary)
    expect(relativeLuminance(varOf(vars, '--el-color-primary-light-9'))).toBeGreaterThan(light3)
    // dark-2 是悬停用的更深一档
    expect(relativeLuminance(varOf(vars, '--el-color-primary-dark-2'))).toBeLessThan(primary)
  })

  it('选中块底色跟着主色走，且在浅色玻璃上仍看得出那一档', () => {
    const primary = ACCENT_PRESETS[0]
    const light = varOf(accentVariables(primary, 'light'), '--bg-selected')
    const dark = varOf(accentVariables(primary, 'dark'), '--bg-selected')

    // 换个主色就换个底色 —— 这正是「选中块跟着主题色」要看的效果
    expect(light).not.toBe(varOf(accentVariables(ACCENT_PRESETS[1], 'light'), '--bg-selected'))

    // 亮色下比主色浅，但不许滑到近白：卡片是 20% 白底的毛玻璃，浅底上的近白块等于没画
    // （上限 0.75 对应「比纯白面至少深 1.3:1」，是这一档的底线而不是外观偏好）
    for (const preset of ACCENT_PRESETS) {
      const tint = varOf(accentVariables(preset, 'light'), '--bg-selected')
      expect(relativeLuminance(tint), preset).toBeLessThan(0.75)
    }
    expect(relativeLuminance(light)).toBeGreaterThan(relativeLuminance(primary))
    expect(relativeLuminance(dark)).toBeLessThan(relativeLuminance(primary))
  })

  it('选中块里那行标题的字色，在选中底色上一定读得清', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const theme of ['light', 'dark'] as const) {
        const vars = accentVariables(preset, theme)
        expect(
          contrastRatio(varOf(vars, '--ink-accent'), varOf(vars, '--bg-selected')),
          `${preset} / ${theme}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('主色本身就够对比时原样用它（深色主色推一下就发黑）', () => {
    // 深海军蓝 #0a2540 在它自己那层选中底色（一半混白，成了 #8592a0）上有 4.9:1
    expect(varOf(accentVariables('#0a2540', 'light'), '--ink-accent')).toBe('#0a2540')
  })

  it('明度落在中间的主色推深到够对比，但仍是同一个色相', () => {
    // 亮绿 #1fbb70 直接当字色只有 2.1:1
    expect(contrastRatio('#1fbb70', '#d2f1e2')).toBeLessThan(2.5)

    const light = varOf(accentVariables('#1fbb70', 'light'), '--ink-accent')
    expect(contrastRatio(light, '#d2f1e2')).toBeGreaterThanOrEqual(4.5)

    // 推深的那一档还是绿的（绿通道明显压过红蓝），不是被推成黑或灰
    const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(light.slice(at, at + 2), 16))
    expect(g).toBeGreaterThan(r + 20)
    expect(g).toBeGreaterThan(b + 20)
  })

  it('暗色主题反过来：浅色档往画布色里压，dark-2 提亮', () => {
    const primary = relativeLuminance(ACCENT_PRESETS[0])
    const vars = accentVariables(ACCENT_PRESETS[0], 'dark')

    expect(relativeLuminance(varOf(vars, '--el-color-primary-light-9'))).toBeLessThan(primary)
    expect(relativeLuminance(varOf(vars, '--el-color-primary-dark-2'))).toBeGreaterThan(primary)
  })

  it('预置色在亮暗两套主题下都给出可读的文字色', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const theme of ['light', 'dark'] as const) {
        const ink = varOf(accentVariables(preset, theme), '--el-color-white')
        expect(contrastRatio(preset, ink), `${preset} / ${theme}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('文字色按传入的取法走', () => {
    expect(varOf(accentVariables('#fde68a', 'light', 'white'), '--el-color-white')).toBe('#ffffff')
    expect(varOf(accentVariables('#2f6bd8', 'dark', 'dark'), '--el-color-white')).toBe('#11151b')
  })
})
