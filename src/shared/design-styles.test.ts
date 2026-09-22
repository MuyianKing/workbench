import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COLOR_FAMILIES,
  COLOR_GROUPS,
  categoryCounts,
  colorFamily,
  colorGroup,
  colorLabel,
  componentGroup,
  componentLabel,
  componentSamples,
  componentStyle,
  designStyleHaystack,
  expandTokenRefs,
  familyCounts,
  filterDesignStyles,
  groupComponents,
  hueOf,
  inkOn,
  isColorValue,
  lineHeightCss,
  mixHex,
  numericScale,
  parseHex,
  resolveTokenRef,
  roundedLabel,
  safeCssValue,
  sanitizeDesignStyles,
  sortDesignStyles,
  spacingLabel,
  tokenLabel,
  typeLabel,
  typographyRef,
  typographyScale,
  type ColorFamily,
  type DesignStyle
} from './design-styles'

// ---------------------------------------------------------------- 夹具

function makeStyle(patch: Partial<DesignStyle> = {}): DesignStyle {
  return {
    brand: 'demo',
    title: 'Demo',
    category: '开发工具与 IDE',
    theme: 'light',
    accent: '#ff0000',
    canvas: '#ffffff',
    font: 'Demo Sans',
    strip: ['#ff0000', '#00ff00'],
    description: '一套演示用的设计语言。',
    colors: { primary: '#ff0000', 'on-primary': '#ffffff', 'surface-dark': '#181715' },
    typography: {
      'display-lg': { fontFamily: 'Demo Sans', fontSize: '48px', fontWeight: '400' },
      'body-md': { fontFamily: 'Demo Sans', fontSize: '16px', fontWeight: '400' }
    },
    rounded: { sm: '6px', pill: '9999px' },
    spacing: { sm: '12px', lg: '24px', section: '96px' },
    components: {
      'button-primary': {
        backgroundColor: '{colors.primary}',
        textColor: '{colors.on-primary}',
        rounded: '{rounded.sm}',
        padding: '12px 20px'
      },
      'text-input': { backgroundColor: '{colors.canvas}', textColor: '{colors.primary}' },
      'feature-card': { backgroundColor: '{colors.surface-dark}' }
    },
    ...patch
  }
}

// ---------------------------------------------------------------- 颜色

describe('颜色解析与计算', () => {
  it('认六位与三位 hex，带不带 # 都行；认不出来回 null 而不是抛错', () => {
    expect(parseHex('#cc785c')).toEqual({ r: 204, g: 120, b: 92 })
    expect(parseHex('cc785c')).toEqual({ r: 204, g: 120, b: 92 })
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(parseHex('rgb(1,2,3)')).toBeNull()
    expect(parseHex(undefined)).toBeNull()
    expect(parseHex(123)).toBeNull()
  })

  it('只放行能写进样式表的颜色写法', () => {
    expect(isColorValue('#fff')).toBe(true)
    expect(isColorValue('rgba(0,0,0,0.5)')).toBe(true)
    expect(isColorValue('transparent')).toBe(true)
    expect(isColorValue('红色')).toBe(false)
    expect(isColorValue('url(x)')).toBe(false)
  })

  it('深底配白字、浅底配黑字', () => {
    expect(inkOn('#000000')).toBe('#ffffff')
    expect(inkOn('#181715')).toBe('#ffffff')
    expect(inkOn('#ffffff')).toBe('#11151b')
    expect(inkOn('#faf9f5')).toBe('#11151b')
  })

  it('色相：灰阶无解，回 -1', () => {
    expect(hueOf('#ff0000')).toBeCloseTo(0, 0)
    expect(hueOf('#00ff00')).toBeCloseTo(120, 0)
    expect(hueOf('#0000ff')).toBeCloseTo(240, 0)
    expect(hueOf('#808080')).toBe(-1)
  })

  it('色系按色相切档，近黑近白与低饱和一律归中性', () => {
    expect(colorFamily('#ff385c')).toBe('红')
    expect(colorFamily('#ff4f00')).toBe('橙')
    expect(colorFamily('#f5c400')).toBe('黄')
    expect(colorFamily('#3ecf8e')).toBe('绿')
    expect(colorFamily('#00b3b0')).toBe('青')
    expect(colorFamily('#0052ff')).toBe('蓝')
    expect(colorFamily('#6a5fc1')).toBe('紫')
    expect(colorFamily('#ffd1da')).toBe('粉')
    expect(colorFamily('#181715')).toBe('中性')
    expect(colorFamily('#ffffff')).toBe('中性')
    expect(colorFamily('#8e8b82')).toBe('中性')
    expect(new Set(COLOR_FAMILIES).size).toBe(COLOR_FAMILIES.length)
  })
})

// ---------------------------------------------------------------- token 引用

describe('token 引用展开', () => {
  const style = makeStyle()

  it('花括号引用按块取值', () => {
    expect(resolveTokenRef('{colors.primary}', style)).toBe('#ff0000')
    expect(resolveTokenRef('{rounded.sm}', style)).toBe('6px')
    expect(resolveTokenRef('{spacing.section}', style)).toBe('96px')
  })

  it('引用不存在时回 undefined —— 宁可少画一个值，也不能把 `{colors.x}` 原样写进样式', () => {
    expect(resolveTokenRef('{colors.nope}', style)).toBeUndefined()
    expect(resolveTokenRef('{whatever.x}', style)).toBeUndefined()
    expect(resolveTokenRef('', style)).toBeUndefined()
    expect(resolveTokenRef(undefined, style)).toBeUndefined()
  })

  it('不是引用的原样返回', () => {
    expect(resolveTokenRef('12px 20px', style)).toBe('12px 20px')
  })

  it('字阶引用另外取整条，它不是单个值', () => {
    expect(typographyRef('{typography.body-md}', style)?.fontSize).toBe('16px')
    expect(typographyRef('{colors.primary}', style)).toBeUndefined()
    expect(resolveTokenRef('{typography.body-md}', style)).toBeUndefined()
  })

  it('挡掉会改变样式表结构的值', () => {
    expect(safeCssValue('12px 20px')).toBe('12px 20px')
    expect(safeCssValue('rgba(0,0,0,0.4)')).toBe('rgba(0,0,0,0.4)')
    expect(safeCssValue('url(https://example.com/x.png)')).toBeUndefined()
    expect(safeCssValue('red;background:black')).toBeUndefined()
    expect(safeCssValue('</style>')).toBeUndefined()
    expect(safeCssValue('')).toBeUndefined()
    expect(safeCssValue('x'.repeat(200))).toBeUndefined()
    expect(safeCssValue(42)).toBeUndefined()
  })

  it('组件规格展开成可绑的样式，缺字色时按底色自动定黑白', () => {
    const button = componentStyle(style.components['button-primary'], style)
    expect(button.background).toBe('#ff0000')
    expect(button.color).toBe('#ffffff')
    expect(button.borderRadius).toBe('6px')
    expect(button.padding).toBe('12px 20px')

    // 没写 textColor：深色底自动配白字
    const card = componentStyle(style.components['feature-card'], style)
    expect(card.background).toBe('#181715')
    expect(card.color).toBe('#ffffff')

    // 底色写的是引用但引用不存在：不猜颜色
    const broken = componentStyle({ backgroundColor: '{colors.nope}' }, style)
    expect(broken.background).toBeUndefined()
    expect(broken.color).toBeUndefined()
  })

  it('整条 border 与夹在值里的引用都展开得出来', () => {
    const styleWithBorder = componentStyle({ border: '2px solid {colors.primary}' }, style)
    expect(styleWithBorder.border).toBe('2px solid #ff0000')

    const padded = componentStyle({ padding: '{spacing.sm} {spacing.lg}' }, style)
    expect(padded.padding).toBe('12px 24px')

    // 有一条展不开就整串不画，不留半截值
    const partial = componentStyle({ padding: '{spacing.sm} {spacing.nope}' }, style)
    expect(partial.padding).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 引用展开与混色

describe('内嵌引用展开', () => {
  const style = makeStyle()

  it('展开夹在值中间的引用', () => {
    expect(expandTokenRefs('{spacing.sm} {spacing.lg}', style)).toBe('12px 24px')
    expect(expandTokenRefs('2px solid {colors.primary}', style)).toBe('2px solid #ff0000')
    expect(expandTokenRefs('{rounded.pill}', style)).toBe('9999px')
  })

  it('不含引用的值原样回，字阶引用（不是单值）展不开', () => {
    expect(expandTokenRefs('12px 20px', style)).toBe('12px 20px')
    expect(expandTokenRefs('{typography.body-md}', style)).toBeUndefined()
    expect(expandTokenRefs('{colors.nope}', style)).toBeUndefined()
    expect(expandTokenRefs(undefined, style)).toBeUndefined()
    expect(expandTokenRefs('  ', style)).toBeUndefined()
  })
})

describe('混色', () => {
  it('两个 hex 之间线性插值，比例夹在 0–1', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff')
  })

  it('认不出 hex 时原样回第一个值', () => {
    expect(mixHex('rgba(0,0,0,0.5)', '#ffffff', 0.5)).toBe('rgba(0,0,0,0.5)')
  })
})

describe('行高归一化', () => {
  it('不带单位的像素行高按字号换算成倍数', () => {
    expect(lineHeightCss('64', '64px')).toBe('1')
    expect(lineHeightCss('48', '40px')).toBe('1.2')
    expect(lineHeightCss('36', '24px')).toBe('1.5')
    expect(lineHeightCss('28.8', '24px')).toBe('1.2')
  })

  it('本来就是倍数的原样放行，倍数过大过小都收到 0.8–2', () => {
    expect(lineHeightCss('1.2', '24px')).toBe('1.2')
    expect(lineHeightCss('2.41', '14px')).toBe('2.41')
    expect(lineHeightCss('0.8', '107px')).toBe('0.8')
    expect(lineHeightCss('96', '12px')).toBe('2')
    expect(lineHeightCss('6', '24px')).toBe('0.8')
  })

  it('带单位的像素行高同样换算（字号收敛之后，绝对行高会让比例失真）', () => {
    expect(lineHeightCss('36px', '24px')).toBe('1.5')
    expect(lineHeightCss('64px', '16px')).toBe('2')
    expect(lineHeightCss('20px', '16px')).toBe('1.25')
  })

  it('关键字与其它单位原样回，算不出来的不画', () => {
    expect(lineHeightCss('normal', '16px')).toBe('normal')
    expect(lineHeightCss('1.2em', '16px')).toBe('1.2em')
    expect(lineHeightCss(undefined, '16px')).toBeUndefined()
    // 像素写法但缺字号：换算不出倍数，宁可不画
    expect(lineHeightCss('64', undefined)).toBeUndefined()
    expect(lineHeightCss('url(evil)', '16px')).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 中文标签

describe('键名的中文标签', () => {
  it('on- 前缀读作「……上的文字」', () => {
    expect(tokenLabel('on-primary')).toBe('主色上的文字')
    expect(tokenLabel('on-dark-soft')).toBe('深色·柔和上的文字')
  })

  it('中缀 on 读作「（……上）」', () => {
    expect(tokenLabel('link-on-light')).toBe('链接（浅色上）')
    expect(tokenLabel('button-secondary-on-dark')).toBe('次按钮（深色上）')
  })

  it('按词段逐段翻译并保留词序（主体在前）', () => {
    expect(tokenLabel('surface-dark-elevated')).toBe('表面·深色·抬升')
    expect(tokenLabel('primary-active')).toBe('主色·激活')
    expect(tokenLabel('canvas-night-soft')).toBe('画布·夜间·柔和')
  })

  it('高频键有整键覆盖，规则拼不通的那些以它为准', () => {
    expect(tokenLabel('button-primary')).toBe('主按钮')
    expect(tokenLabel('text-input-focused')).toBe('输入框（聚焦）')
    expect(tokenLabel('ex-cart-drawer')).toBe('示例·购物车抽屉')
  })

  it('手写标签优先于规则', () => {
    expect(tokenLabel('Hero Display', { 'Hero Display': '首屏展示字' })).toBe('首屏展示字')
    // 没有手写表时，不带连字符的散文式键名整块查不到词段，于是原样保留
    expect(tokenLabel('Hero Display')).toBe('Hero Display')
  })

  it('认不出来的词段原样保留 —— 专有名词不能被硬翻', () => {
    expect(tokenLabel('accent-rausch')).toBe('强调色·rausch')
    expect(tokenLabel('funds-safu-ribbon')).toBe('资金·safu·缎带')
  })

  it('三种标签入口分别取各自块的手写表', () => {
    const style = makeStyle({ labels: { colors: { primary: '品牌主色' } } })
    expect(colorLabel(style, 'primary')).toBe('品牌主色')
    expect(colorLabel(style, 'surface-dark')).toBe('表面·深色')
  })
})

// ---------------------------------------------------------------- 分组与阶梯

describe('配色与组件的分组', () => {
  it('配色分五组，规则顺序固定', () => {
    expect(colorGroup('primary')).toBe('品牌与强调')
    expect(colorGroup('canvas')).toBe('表面与画布')
    expect(colorGroup('hairline-soft')).toBe('文字与线条')
    expect(colorGroup('semantic-error')).toBe('语义状态')
    expect(colorGroup('luxe')).toBe('其它')
    expect(COLOR_GROUPS[0]).toBe('品牌与强调')
  })

  it('组件分四组，每个键只进一组', () => {
    expect(componentGroup('button-primary')).toBe('按钮')
    expect(componentGroup('text-input')).toBe('表单')
    expect(componentGroup('feature-card')).toBe('卡片')
    expect(componentGroup('hero-band')).toBe('版式')

    const grouped = groupComponents(makeStyle())
    const flat = [...grouped['按钮'], ...grouped['卡片'], ...grouped['表单'], ...grouped['版式']]
    expect(flat.sort()).toEqual(['button-primary', 'feature-card', 'text-input'])
  })

  it('字阶按字号从大到小；认不出字号的排最后', () => {
    const style = makeStyle({
      typography: {
        'body-md': { fontSize: '16px' },
        'display-lg': { fontSize: '48px' },
        weird: {}
      }
    })
    expect(typographyScale(style).map(([key]) => key)).toEqual(['display-lg', 'body-md', 'weird'])
  })

  it('间距按数值从小到大 —— 它是阶梯，按阶梯顺序看才有意义', () => {
    expect(numericScale(makeStyle().spacing).map(([key]) => key)).toEqual(['sm', 'lg', 'section'])
    expect(numericScale({ a: '8px', b: '4px' }).map(([, raw]) => raw)).toEqual(['4px', '8px'])
  })

  it('组件样张按组分好并截断，三个上游没给组件的品牌自然回空', () => {
    const samples = componentSamples(makeStyle())
    expect(samples.map((entry) => entry.group)).toEqual(['按钮', '卡片', '表单'])
    expect(samples.every((entry) => entry.rest === 0)).toBe(true)
    expect(componentSamples(makeStyle({ components: {} }))).toEqual([])
  })
})

// ---------------------------------------------------------------- 筛选与排序

describe('筛选与排序', () => {
  const styles = [
    makeStyle({ brand: 'a', title: 'Alpha', accent: '#ff0000', theme: 'light' }),
    makeStyle({
      brand: 'b',
      title: 'Beta',
      accent: '#0052ff',
      theme: 'dark',
      category: 'AI 与大模型',
      description: '深色画布与冷蓝主色。'
    }),
    makeStyle({ brand: 'c', title: 'Gamma', accent: '#3ecf8e', theme: 'dark' })
  ]

  it('关键词命中品牌名、分类、中文描述与色值', () => {
    expect(filterDesignStyles(styles, { query: 'beta' }).map((s) => s.brand)).toEqual(['b'])
    expect(filterDesignStyles(styles, { query: 'AI 与大模型' }).map((s) => s.brand)).toEqual(['b'])
    expect(filterDesignStyles(styles, { query: '冷蓝' }).map((s) => s.brand)).toEqual(['b'])
    expect(filterDesignStyles(styles, { query: '#0052ff' }).map((s) => s.brand)).toEqual(['b'])
  })

  it('关键词也能搜颜色的中文标签', () => {
    // 三套都有 primary 这个键，它的标签都是「主色」
    expect(filterDesignStyles(styles, { query: '主色' })).toHaveLength(3)
  })

  it('明暗、色系、分类是「与」的关系', () => {
    expect(filterDesignStyles(styles, { theme: 'dark' }).map((s) => s.brand)).toEqual(['b', 'c'])
    expect(filterDesignStyles(styles, { family: '蓝' }).map((s) => s.brand)).toEqual(['b'])
    expect(
      filterDesignStyles(styles, { theme: 'dark', family: '绿' }).map((s) => s.brand)
    ).toEqual(['c'])
    expect(filterDesignStyles(styles, { theme: 'dark', category: '开发工具与 IDE' })).toHaveLength(1)
  })

  it('三种排序：名称、色相、深色优先', () => {
    expect(sortDesignStyles(styles, 'az').map((s) => s.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(sortDesignStyles(styles, 'dark').map((s) => s.brand)).toEqual(['b', 'c', 'a'])
    // 红 → 绿 → 蓝 在色系表里的先后是 红、绿、蓝
    expect(sortDesignStyles(styles, 'hue').map((s) => s.brand)).toEqual(['a', 'c', 'b'])
  })

  it('排序不改原数组', () => {
    const before = styles.map((s) => s.brand)
    sortDesignStyles(styles, 'hue')
    expect(styles.map((s) => s.brand)).toEqual(before)
  })

  it('索引里带上了颜色键名与色值', () => {
    const haystack = designStyleHaystack(makeStyle())
    expect(haystack).toContain('#ff0000')
    expect(haystack).toContain('主色')
    expect(haystack).toContain('演示用的设计语言')
  })

  it('筛选项由数据统计出来，不铺空档', () => {
    expect(familyCounts(styles).map((entry) => entry.family)).toEqual(['红', '绿', '蓝'])
    expect(categoryCounts(styles)[0]).toEqual({ category: '开发工具与 IDE', count: 2 })
  })
})

// ---------------------------------------------------------------- 收敛

describe('外部数据收敛', () => {
  it('坏条目直接丢掉，不能让整页白屏', () => {
    const cleaned = sanitizeDesignStyles({
      styles: [
        { brand: 'ok', title: 'Ok', accent: '#ff0000' },
        { brand: '', title: 'No', accent: '#ff0000' },
        { brand: 'no-title', accent: '#ff0000' },
        { brand: 'bad-color', title: 'Bad', accent: '红色' },
        null,
        'x'
      ]
    })
    expect(cleaned.map((s) => s.brand)).toEqual(['ok'])
    expect(cleaned[0].theme).toBe('light')
    expect(cleaned[0].colors).toEqual({})
  })

  it('字段类型不对时按缺省处理，不抛错', () => {
    const cleaned = sanitizeDesignStyles([
      {
        brand: 'x',
        title: 'X',
        accent: '#fff',
        theme: 'dark',
        strip: ['#fff', 'nope', 42],
        typography: { a: { fontSize: 16, fontWeight: '700' }, b: 'no' },
        components: { c: { padding: '4px', height: 40 } }
      }
    ])
    expect(cleaned[0].theme).toBe('dark')
    expect(cleaned[0].strip).toEqual(['#fff'])
    expect(cleaned[0].typography.a).toEqual({ fontSize: '16', fontWeight: '700' })
    expect(cleaned[0].components.c).toEqual({ padding: '4px', height: '40' })
  })

  it('认不出形状时回空数组而不是抛错', () => {
    expect(sanitizeDesignStyles(null)).toEqual([])
    expect(sanitizeDesignStyles('nope')).toEqual([])
    expect(sanitizeDesignStyles({})).toEqual([])
  })
})

// ---------------------------------------------------------------- 真实数据守卫

describe('随包的那份数据', () => {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../renderer/public/design-styles.json'), 'utf-8')
  )
  const styles = sanitizeDesignStyles(raw)

  it('74 套全部收敛下来，没被丢掉任何一套', () => {
    expect(styles).toHaveLength(74)
    expect(new Set(styles.map((s) => s.brand)).size).toBe(74)
  })

  it('每套都有中文描述、分类、主色与画布色，且描述里不残留英文花括号引用', () => {
    for (const style of styles) {
      expect(style.description.length, style.brand).toBeGreaterThan(30)
      expect(/[\u4e00-\u9fa5]/.test(style.description), style.brand).toBe(true)
      expect(style.description.includes('{'), style.brand).toBe(false)
      expect(style.category, style.brand).toBeTruthy()
      expect(parseHex(style.accent), style.brand).not.toBeNull()
      expect(parseHex(style.canvas), style.brand).not.toBeNull()
      expect(style.strip.length, style.brand).toBeGreaterThan(0)
    }
  })

  it('色系判定能覆盖到全部九档（分类器本身没坏）', () => {
    const hit = new Set<ColorFamily>()
    for (const style of styles) {
      hit.add(colorFamily(style.accent))
      for (const value of Object.values(style.colors)) {
        if (isColorValue(value)) hit.add(colorFamily(value))
      }
    }
    for (const family of COLOR_FAMILIES) expect(hit.has(family), family).toBe(true)
  })

  it('色系与分类的筛选项由数据统计而来，每一项都点得出结果', () => {
    const families = familyCounts(styles)
    expect(families.length).toBeGreaterThanOrEqual(5)
    for (const { family, count } of families) {
      expect(count, family).toBeGreaterThan(0)
      expect(filterDesignStyles(styles, { family }), family).toHaveLength(count)
    }

    const categories = categoryCounts(styles)
    expect(categories.reduce((sum, entry) => sum + entry.count, 0)).toBe(74)
    for (const { category, count } of categories) {
      expect(filterDesignStyles(styles, { category }), category).toHaveLength(count)
    }
  })

  it('键名的中文标签覆盖得住：5490 个键里残留拉丁字母的不超过 5%', () => {
    const blocks = [
      ['colors', colorLabel],
      ['typography', typeLabel],
      ['components', componentLabel],
      ['rounded', roundedLabel],
      ['spacing', spacingLabel]
    ] as const
    let total = 0
    let latin = 0
    for (const style of styles) {
      for (const [block, labelOf] of blocks) {
        for (const key of Object.keys(style[block])) {
          total += 1
          if (/[A-Za-z]/.test(labelOf(style, key))) latin += 1
        }
      }
    }
    expect(total).toBeGreaterThan(4000)
    // 剩下的应该是专有名词（rausch、terraform 这类），而不是漏配的词段
    expect(latin / total).toBeLessThan(0.05)
  })

  it('三个上游没给组件的品牌确实拿到空组件，且组件样张不炸', () => {
    for (const brand of ['lamborghini', 'runwayml', 'tesla']) {
      const style = styles.find((s) => s.brand === brand)
      expect(style, brand).toBeTruthy()
      expect(Object.keys(style!.components), brand).toHaveLength(0)
      expect(componentSamples(style!)).toEqual([])
    }
    expect(componentSamples(styles[0]).length).toBeGreaterThan(0)
  })
})
