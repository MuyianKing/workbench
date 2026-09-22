import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DESIGN_FILE_NAME, designMarkdown, designPrompt } from './design-export'
import { sanitizeDesignStyles, type DesignStyle } from './design-styles'

const styles: DesignStyle[] = sanitizeDesignStyles(
  JSON.parse(readFileSync(resolve(__dirname, '../renderer/public/design-styles.json'), 'utf-8'))
)

describe('DESIGN.md 导出（74 套真实数据）', () => {
  it('每一套都导得出来：标题、基础表、颜色与字体段都在', () => {
    for (const style of styles) {
      const md = designMarkdown(style)
      expect(md.startsWith(`# ${style.title} 设计规范`), style.brand).toBe(true)
      expect(md).toContain('## 基础')
      expect(md).toContain('## 使用说明')
      expect(md.endsWith('\n'), style.brand).toBe(true)
      // 描述是中文评述，带上来才有「这套设计是什么」的上下文
      if (style.description) expect(md, style.brand).toContain(style.description)
      if (Object.keys(style.colors).length) expect(md, style.brand).toContain('## 颜色')
      if (Object.keys(style.typography).length) expect(md, style.brand).toContain('## 字体')
    }
  })

  it('文档里不残留未展开的引用，组件规格给的是真值', () => {
    for (const style of styles) {
      const md = designMarkdown(style)
      expect(md.includes('{colors.'), style.brand).toBe(false)
      expect(md.includes('{spacing.'), style.brand).toBe(false)
      expect(md.includes('{rounded.'), style.brand).toBe(false)
    }
    const airbnb = styles.find((s) => s.brand === 'airbnb')!
    const md = designMarkdown(airbnb)
    // 主按钮的底色在数据里写的是 {colors.primary}
    expect(md).toContain('`#ff385c`')
  })

  it('颜色与字体的条目数对得上（表格没漏行）', () => {
    for (const style of styles) {
      const md = designMarkdown(style)
      const colors = Object.keys(style.colors).length
      const types = Object.keys(style.typography).length
      // 颜色段的分组小标题 + 每组一张表，用总行数反推不现实；这里只数「含义」列里出现的色值反引号数量下界
      expect((md.match(/^\| `/gm) ?? []).length, style.brand).toBeGreaterThanOrEqual(colors)
      if (types) expect(md, style.brand).toContain(`## 字体（${types} 档）`)
    }
  })

  it('行高列只给倍数，不会导出「64」这种会被当成 64 倍的值', () => {
    for (const style of styles) {
      const md = designMarkdown(style)
      const section = md.split('## 字体')[1]?.split('## ')[0] ?? ''
      for (const line of section.split('\n')) {
        if (!line.startsWith('|')) continue
        const cells = line.split('|').map((cell) => cell.trim())
        // 表头与分隔行跳过；行高在第 7 列（前后各一个空串）
        if (cells.length < 9 || cells[1] === '变量名' || cells[1].startsWith('---')) continue
        const lineHeight = cells[7]
        if (lineHeight === '—' || !lineHeight.startsWith('`')) continue
        const value = Number(lineHeight.replace(/`/g, ''))
        expect(Number.isFinite(value) ? value <= 2 : true, `${style.brand} 的 ${cells[1]}`).toBe(true)
      }
    }
  })

  it('上游没给组件规格的三套不写组件段，也不留白板', () => {
    for (const brand of ['lamborghini', 'runwayml', 'tesla']) {
      const style = styles.find((s) => s.brand === brand)!
      const md = designMarkdown(style)
      expect(md.includes('## 组件'), brand).toBe(false)
      // 但基础段与颜色段照旧
      expect(md).toContain('## 基础')
      expect(md).toContain('## 颜色')
    }
  })
})

describe('提示词', () => {
  it('带上品牌、分类、主色与规范文件名，并给出可照做的条目', () => {
    const airbnb = styles.find((s) => s.brand === 'airbnb')!
    const prompt = designPrompt(airbnb)
    expect(prompt).toContain(DESIGN_FILE_NAME)
    expect(prompt).toContain('Airbnb')
    expect(prompt).toContain('电商与零售')
    expect(prompt).toContain('#ff385c')
    expect(prompt).toContain('不要为这套样式引入新的 UI 库')
    expect(prompt.split('\n').filter((line) => /^\d\./.test(line))).toHaveLength(6)
  })

  it('深浅两种基调各说自己那句', () => {
    const dark = styles.find((s) => s.theme === 'dark')!
    const light = styles.find((s) => s.theme === 'light')!
    expect(designPrompt(dark)).toContain('这是深色设计')
    expect(designPrompt(light)).toContain('这是浅色设计')
  })

  it('每一套的提示词都不为空且带得出主色', () => {
    for (const style of styles) {
      const prompt = designPrompt(style)
      expect(prompt.length, style.brand).toBeGreaterThan(200)
      expect(prompt.includes('#'), style.brand).toBe(true)
    }
  })
})
