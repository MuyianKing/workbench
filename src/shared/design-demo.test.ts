import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDesignDemo, CARD_TYPE, clampFontSize, clampPadding, demoCopy, demoPalette, typeCss } from './design-demo'
import {
  isColorValue,
  relativeLuminance,
  sanitizeDesignStyles,
  type DesignStyle
} from './design-styles'

// ---------------------------------------------------------------- 夹具

/** 键名规整的一套（kebab-case，74 套里的大多数长这样） */
function makeTidy(patch: Partial<DesignStyle> = {}): DesignStyle {
  return {
    brand: 'tidy',
    title: 'Tidy',
    category: '开发工具与 IDE',
    theme: 'light',
    accent: '#ff0000',
    canvas: '#ffffff',
    font: 'Tidy Sans',
    strip: ['#ff0000', '#00ff00', '#0000ff'],
    description: '一套演示用的设计语言。',
    colors: {
      primary: '#ff0000',
      'on-primary': '#ffffff',
      ink: '#1a1a1a',
      muted: '#6b6b6b',
      hairline: '#e4e4e4',
      'surface-card': '#f7f7f7'
    },
    typography: {
      'display-lg': { fontFamily: 'Tidy Sans', fontSize: '48px', fontWeight: '400' },
      'body-md': { fontFamily: 'Tidy Sans', fontSize: '16px', fontWeight: '400' },
      'button-md': { fontFamily: 'Tidy Sans', fontSize: '14px', fontWeight: '600' }
    },
    rounded: { sm: '6px', md: '12px', full: '9999px' },
    spacing: { sm: '8px', md: '16px', lg: '24px', section: '96px' },
    components: {
      'button-primary': {
        backgroundColor: '{colors.primary}',
        textColor: '{colors.on-primary}',
        typography: '{typography.button-md}',
        rounded: '{rounded.sm}',
        padding: '{spacing.sm} {spacing.md}'
      },
      'button-secondary': {
        textColor: '{colors.ink}',
        border: '1px solid {colors.hairline}',
        rounded: '{rounded.sm}'
      },
      'text-input': { backgroundColor: '{colors.surface-card}', textColor: '{colors.ink}' }
    },
    ...patch
  }
}

/** 散文格式的一套（键名是人写的英文，靠中文标签兜） */
function makeProse(): DesignStyle {
  return {
    brand: 'prose',
    title: 'Prose',
    category: '媒体与消费科技',
    theme: 'dark',
    accent: '#1ed760',
    canvas: '#121212',
    font: 'Prose Sans',
    strip: ['#1ed760', '#121212'],
    description: '一套散文格式的设计语言。',
    colors: {
      'Prose Green': '#1ed760',
      'Near Black': '#121212',
      'Dark Card': '#181818',
      Silver: '#b3b3b3',
      'Border Gray': '#dedee5'
    },
    typography: {
      'Hero Display': { fontFamily: 'Prose Sans', fontSize: '56px', fontWeight: '700' },
      Body: { fontFamily: 'Prose Sans', fontSize: '15px', fontWeight: '400' }
    },
    rounded: { Small: '8px' },
    spacing: { Small: '8px', Large: '32px' },
    components: {},
    labels: {
      colors: {
        'Prose Green': 'Prose 绿',
        'Near Black': '近黑',
        'Dark Card': '深色卡片',
        Silver: '银',
        'Border Gray': '描边灰'
      }
    }
  }
}

const styles: DesignStyle[] = sanitizeDesignStyles(
  JSON.parse(readFileSync(resolve(__dirname, '../renderer/public/design-styles.json'), 'utf-8'))
)

// ---------------------------------------------------------------- 真实数据

describe('示例页面（74 套真实数据）', () => {
  it('每一套都能组装出示例页面，七个颜色角色都有值', () => {
    for (const style of styles) {
      const demo = buildDesignDemo(style)
      for (const [role, value] of Object.entries(demo.palette)) {
        expect(isColorValue(value), `${style.brand} 的 ${role}`).toBe(true)
      }
    }
  })

  it('主文字与画布色有可读的明暗差 —— 浅色设计给深字、深色设计给亮字', () => {
    for (const style of styles) {
      const palette = demoPalette(style)
      const diff = Math.abs(relativeLuminance(palette.ink) - relativeLuminance(palette.canvas))
      expect(diff, `${style.brand} 的 ink/canvas 对比`).toBeGreaterThan(0.15)
    }
  })

  it('按钮与输入框都画得出来：挑到规格的用它的颜色，没规格的按主色现画', () => {
    for (const style of styles) {
      const demo = buildDesignDemo(style)
      expect(demo.primary.label, style.brand).toBe(demo.copy.primary)
      expect(demo.secondary.label, style.brand).toBe(demo.copy.secondary)
      // 按钮得看得见：要么有底色，要么有描边
      for (const button of [demo.primary, demo.secondary]) {
        expect(Boolean(button.style.background || button.style.border), style.brand).toBe(true)
      }
      expect(Boolean(demo.input.background || demo.input.border), style.brand).toBe(true)
    }
  })

  it('三个上游没给组件规格的品牌走现画，按钮底色就是主色', () => {
    for (const brand of ['lamborghini', 'runwayml', 'tesla']) {
      const style = styles.find((s) => s.brand === brand)
      expect(style, brand).toBeTruthy()
      const demo = buildDesignDemo(style!)
      expect(demo.primary.style.background, brand).toBe(demo.palette.accent)
      expect(demo.secondary.style.border, brand).toContain(demo.palette.hairline)
    }
  })

  it('内边距与字号都收敛过，不会把样张撑爆', () => {
    const px = (raw: string | undefined): number[] =>
      [...(raw ?? '').matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]))
    for (const style of styles) {
      const demo = buildDesignDemo(style)
      for (const value of [demo.primary.style.padding, demo.secondary.style.padding, demo.input.padding]) {
        for (const size of px(value)) expect(size, `${style.brand} 的 padding`).toBeLessThanOrEqual(32)
      }
      expect(demo.metrics.section, style.brand).toBeGreaterThanOrEqual(32)
      expect(demo.metrics.section, style.brand).toBeLessThanOrEqual(56)
      expect(demo.metrics.gap, style.brand).toBeGreaterThanOrEqual(8)
      expect(demo.metrics.gap, style.brand).toBeLessThanOrEqual(16)
      expect(demo.metrics.cardRadius, style.brand).toMatch(/^\d+px$/)
    }
  })

  it('文案按分类取：十类各有各的故事，都带得出三张卡与三条数据', () => {
    for (const style of styles) {
      const copy = demoCopy(style)
      expect(copy.title.length, style.brand).toBeGreaterThan(4)
      expect(copy.cards, style.brand).toHaveLength(3)
      expect(copy.stats, style.brand).toHaveLength(3)
      for (const card of copy.cards) {
        expect(card.title.length, style.brand).toBeGreaterThan(1)
        expect(card.text.length, style.brand).toBeGreaterThan(6)
      }
      expect(/[\u4e00-\u9fa5]/.test(copy.subtitle), style.brand).toBe(true)
    }
    const ai = styles.find((s) => s.category === 'AI 与大模型')!
    expect(demoCopy(ai).title).toBe('让模型替你把活干完')
    const car = styles.find((s) => s.category === '汽车')!
    expect(demoCopy(car).title).toBe('为驾驭而生的每一处细节')
  })

  it('分类认不出时退回通用文案，不是空文案', () => {
    const copy = demoCopy(makeTidy({ category: '不存在的分类' }))
    expect(copy.title).toBe('为下一次发布做好准备')
    expect(copy.cards).toHaveLength(3)
  })

  it('字阶的行高都归一化过 —— 卡片与页面不会被「字号的 N 倍」撑到上千像素', () => {
    for (const style of styles) {
      const demo = buildDesignDemo(style)
      for (const token of [demo.hero, demo.body, demo.small]) {
        const css = typeCss(token, CARD_TYPE.title)
        if (!css.lineHeight) continue
        // 归一化之后只可能是倍数（带单位的写法在数据里不存在）
        expect(Number(css.lineHeight), `${style.brand} 的 ${token?.fontSize}`).toBeLessThanOrEqual(2)
      }
    }
  })
})

// ---------------------------------------------------------------- 角色解析

describe('颜色角色解析', () => {
  it('键名规整的一套：六个角色都按键名挑到', () => {
    const palette = demoPalette(makeTidy())
    expect(palette.ink).toBe('#1a1a1a')
    expect(palette.muted).toBe('#6b6b6b')
    expect(palette.hairline).toBe('#e4e4e4')
    expect(palette.surface).toBe('#f7f7f7')
    expect(palette.onAccent).toBe('#ffffff')
    expect(palette.canvas).toBe('#ffffff')
  })

  it('散文格式的一套：靠中文标签兜住卡片底与描边，文字色按近黑画布现算', () => {
    const palette = demoPalette(makeProse())
    expect(palette.surface).toBe('#181818')
    expect(palette.hairline).toBe('#dedee5')
    // 近黑画布 + 没有说得上名字的文字色 → 用亮字
    expect(relativeLuminance(palette.ink)).toBeGreaterThan(0.7)
  })

  it('什么都挑不到时，兜底色由画布与文字现调，且与画布不同', () => {
    const bare = makeTidy({
      theme: 'dark',
      canvas: '#101010',
      colors: { brand: '#ff0000' },
      labels: undefined
    })
    const palette = demoPalette(bare)
    expect(isColorValue(palette.ink)).toBe(true)
    expect(palette.surface).not.toBe(palette.canvas)
    expect(palette.muted).not.toBe(palette.canvas)
    expect(palette.hairline).not.toBe(palette.canvas)
    // 深色画布上兜底出来的卡片底比画布亮
    expect(relativeLuminance(palette.surface)).toBeGreaterThan(relativeLuminance(palette.canvas))
  })

  it('画布色认不出来（rgba）也不抛错，原样用它', () => {
    const odd = makeTidy({ canvas: 'rgba(0, 0, 0, 0.5)' })
    const demo = buildDesignDemo(odd)
    expect(demo.palette.canvas).toBe('rgba(0, 0, 0, 0.5)')
    expect(isColorValue(demo.palette.hairline)).toBe(true)
  })
})

// ---------------------------------------------------------------- 组件规格

describe('组件规格挑取', () => {
  it('挑到主按钮就整套用它的：底色、字色、圆角、展开后的内边距', () => {
    const demo = buildDesignDemo(makeTidy())
    expect(demo.primary.style.background).toBe('#ff0000')
    expect(demo.primary.style.color).toBe('#ffffff')
    expect(demo.primary.style.borderRadius).toBe('6px')
    expect(demo.primary.style.padding).toBe('8px 16px')
    expect(demo.primary.style.font?.fontSize).toBe('14px')
  })

  it('次按钮的整条 border 写得出来（夹在值里的引用也展开）', () => {
    const demo = buildDesignDemo(makeTidy())
    expect(demo.secondary.style.border).toBe('1px solid #e4e4e4')
    expect(demo.secondary.style.background).toBeUndefined()
  })

  it('没有主按钮规格时按主色现画一枚，字色按对比度定', () => {
    const style = makeTidy({ components: {} })
    const demo = buildDesignDemo(style)
    expect(demo.primary.style.background).toBe('#ff0000')
    expect(demo.primary.style.color).toBe('#ffffff')
    expect(demo.primary.style.borderRadius).toBe(demo.metrics.buttonRadius)
  })
})

// ---------------------------------------------------------------- 收敛工具

describe('尺寸收敛', () => {
  it('内边距按 px 逐个收到 32 以内，非 px 的部分原样留着', () => {
    expect(clampPadding('96px')).toBe('32px')
    expect(clampPadding('12px 96px 4px')).toBe('12px 32px 4px')
    expect(clampPadding('1rem 12px')).toBe('1rem 12px')
    expect(clampPadding(undefined)).toBeUndefined()
    expect(clampPadding('url(evil)')).toBeUndefined()
  })

  it('字号收到上限，非 px 单位不动', () => {
    expect(clampFontSize('96px', 44)).toBe('44px')
    expect(clampFontSize('14px', 44)).toBe('14px')
    expect(clampFontSize('13.4px', 44)).toBe('13px')
    expect(clampFontSize('2rem', 44)).toBe('2rem')
    expect(clampFontSize(undefined, 44)).toBeUndefined()
  })
})
