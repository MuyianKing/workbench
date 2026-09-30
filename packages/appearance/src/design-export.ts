/**
 * 设计规范导出：把一套设计语言写成一份 DESIGN.md，外加一段给 AI 编码助手的提示词。
 *
 * 用途是「把这套设计搬进某个项目」：DESIGN.md 落到项目根目录当规范文件，提示词进剪贴板，
 * 粘给 Claude Code / Cursor 这类助手，它照着规范实现界面。
 *
 * 数据里没有 DESIGN.md 原文（随包那份 json 只有解析后的 token），这份文档是按 token 现生成的。
 * 好处是值都经过收敛与展开：组件规格里的 `{colors.primary}` 换成真实色值、行高换算成倍数，
 * 拿到手就是能直接用的数字。表格的标签与详情弹窗「规格」档同源（同一批 `*Label` 函数），
 * 所以界面上看到的中文与文档里的一致。
 */
import {
  COLOR_GROUPS,
  THEME_LABELS,
  colorGroup,
  colorLabel,
  componentLabel,
  componentSamples,
  componentStyle,
  designStyleFamily,
  isColorValue,
  lineHeightCss,
  numericScale,
  roundedLabel,
  spacingLabel,
  typeLabel,
  typographyScale,
  type DesignComponentToken,
  type DesignStyle
} from './design-styles'
import { demoPalette } from './design-demo'

/** 落到项目根目录的文件名 */
export const DESIGN_FILE_NAME = 'DESIGN.md'

/** 表格单元格里的值：套反引号，没有的给一个短横 */
function cell(value: string | undefined): string {
  return value ? `\`${value}\`` : '—'
}

/** 一行表格 */
function row(cells: Array<string | undefined>): string {
  return `| ${cells.map((value) => value ?? '—').join(' | ')} |`
}

/** 一条组件规格里的字段（有值才写一行） */
function componentFacts(token: DesignComponentToken, style: DesignStyle): string[] {
  const spec = componentStyle(token, style)
  const facts: Array<[string, string | undefined]> = [
    ['底色', spec.background],
    ['文字', spec.color],
    ['描边', spec.border],
    ['圆角', spec.borderRadius],
    ['内边距', spec.padding],
    ['尺寸', spec.height ?? spec.width],
    ['阴影', spec.boxShadow]
  ]
  const out = facts.filter(([, value]) => value).map(([label, value]) => `- ${label}：\`${value}\``)
  const font = spec.font
  if (font) {
    const parts: string[] = []
    if (font.fontFamily) parts.push(font.fontFamily)
    if (font.fontSize) parts.push(font.fontSize)
    if (font.fontWeight) parts.push(`字重 ${font.fontWeight}`)
    const lineHeight = lineHeightCss(font.lineHeight, font.fontSize)
    if (lineHeight) parts.push(`行高 ${lineHeight}`)
    if (font.letterSpacing) parts.push(`字距 ${font.letterSpacing}`)
    if (parts.length) out.push(`- 字体：${parts.join('，')}`)
  }
  return out
}

/** 一套设计的 DESIGN.md 全文 */
export function designMarkdown(style: DesignStyle): string {
  const palette = demoPalette(style)
  const out: string[] = []

  out.push(`# ${style.title} 设计规范`, '')
  out.push(
    `> 由 Workbench 样式参考库导出 ｜ 分类：${style.category} ｜ ${THEME_LABELS[style.theme]} ｜ 主色${designStyleFamily(style)}`,
    ''
  )
  if (style.description) out.push(style.description, '')

  // ---- 基础角色
  out.push('## 基础', '', '| 项目 | 值 |', '| --- | --- |')
  out.push(row(['画布色', cell(palette.canvas)]))
  out.push(row(['主色', cell(palette.accent)]))
  out.push(row(['主色上的文字', cell(palette.onAccent)]))
  out.push(row(['主文字', cell(palette.ink)]))
  out.push(row(['次文字', cell(palette.muted)]))
  out.push(row(['卡片底色', cell(palette.surface)]))
  out.push(row(['分隔线', cell(palette.hairline)]))
  if (style.font) out.push(row(['展示字体', cell(style.font)]))
  out.push('')

  // ---- 颜色（按角色分组，与详情弹窗同一套分组）
  const colors = Object.entries(style.colors).filter(([, value]) => isColorValue(value))
  if (colors.length) {
    out.push(`## 颜色（${colors.length} 个）`, '')
    for (const group of COLOR_GROUPS) {
      const list = colors.filter(([key]) => colorGroup(key) === group)
      if (!list.length) continue
      out.push(`### ${group}`, '', '| 变量名 | 含义 | 色值 |', '| --- | --- | --- |')
      for (const [key, value] of list) out.push(row([cell(key), colorLabel(style, key), cell(value)]))
      out.push('')
    }
  }

  // ---- 字体
  const types = typographyScale(style)
  if (types.length) {
    out.push(
      `## 字体（${types.length} 档）`,
      '',
      '| 变量名 | 含义 | 字体 | 字号 | 字重 | 行高 | 字距 |',
      '| --- | --- | --- | --- | --- | --- | --- |'
    )
    for (const [key, token] of types) {
      out.push(
        row([
          cell(key),
          typeLabel(style, key),
          cell(token.fontFamily),
          cell(token.fontSize),
          cell(token.fontWeight),
          cell(lineHeightCss(token.lineHeight, token.fontSize)),
          cell(token.letterSpacing)
        ])
      )
    }
    out.push('', '> 行高按倍数给出：上游有的把像素行高写成不带单位的数字（`64`），直接当 CSS 用会被读成「字号的 64 倍」。', '')
  }

  // ---- 圆角
  const rounded = numericScale(style.rounded)
  if (rounded.length) {
    out.push(`## 圆角（${rounded.length} 档）`, '', '| 变量名 | 含义 | 值 |', '| --- | --- | --- |')
    for (const [key, raw] of rounded) out.push(row([cell(key), roundedLabel(style, key), cell(raw)]))
    out.push('')
  }

  // ---- 间距
  const spacing = numericScale(style.spacing)
  if (spacing.length) {
    out.push(`## 间距（${spacing.length} 档）`, '', '| 变量名 | 含义 | 值 |', '| --- | --- | --- |')
    for (const [key, raw] of spacing) out.push(row([cell(key), spacingLabel(style, key), cell(raw)]))
    out.push('')
  }

  // ---- 组件
  const samples = componentSamples(style)
  if (samples.length) {
    out.push('## 组件', '')
    for (const entry of samples) {
      out.push(`### ${entry.group}`, '')
      for (const key of entry.keys) {
        const token = style.components[key]
        if (!token) continue
        out.push(`**${componentLabel(style, key)}** \`${key}\``, '')
        const facts = componentFacts(token, style)
        out.push(...(facts.length ? facts : ['- 该条只声明了角色，没有具体规格']), '')
      }
      if (entry.rest) out.push(`另有 ${entry.rest} 个同类组件未展开。`, '')
    }
  }

  // ---- 使用说明
  out.push(
    '## 使用说明',
    '',
    '- 颜色、字号、字重、字距、行高、圆角、间距一律取本文档的值，不要另拍一套；需要中间值时，取相邻的一档。',
    '- 界面以「画布色」打底、「主文字」为正文色，主色只用于强调与主要动作。',
    '- 字体按上文声明的字体族与字重来；字体文件可能没装，回落到系统字体没问题，但字号、字重、字距的比例要保留。',
    '- 按钮、输入框、卡片等按「组件」一节给出的底色、描边、圆角、内边距实现。',
    '- 不要为这套样式引入新的 UI 库、字体 CDN 或其它外部资源。'
  )

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** 一段提示词：连同 DESIGN.md 一起交给 AI 助手，说明该怎么用它 */
export function designPrompt(style: DesignStyle): string {
  const palette = demoPalette(style)
  const dark = style.theme === 'dark'
  return [
    `请先读项目根目录的 ${DESIGN_FILE_NAME} —— 那是我为这个项目选定的设计规范（${style.title}：${style.category}，${THEME_LABELS[style.theme]}，主色 ${palette.accent}）。`,
    '',
    '实现界面时按下面几条来：',
    '1. 颜色、字号、字重、字距、行高、圆角、间距都取规范里的值，不要自己另拍一套；需要中间值时，在它现有的阶梯里挑相邻的一档。',
    `2. 以规范的「画布色」${palette.canvas} 打底、主文字色 ${palette.ink} 作正文，主色 ${palette.accent} 只用于强调与主要动作。`,
    dark
      ? '3. 这是深色设计：底色接近黑，注意文字与控件的对比度，别把深色文字压在深色底上。'
      : '3. 这是浅色设计：注意文字与控件的对比度，别把浅色文字压在浅色底上。',
    '4. 字体按规范里的字体族与字重声明；字体文件可能没装，回落到系统字体没问题，但字号、字重、字距的比例要保留。',
    '5. 按钮、输入框、卡片这些组件按规范里的组件规格实现（底色、描边、圆角、内边距）。',
    '6. 不要为这套样式引入新的 UI 库、字体 CDN 或其它外部资源。',
    '',
    '读完规范再动手；做完之后逐条对照上面的要求自查一遍。'
  ].join('\n')
}
