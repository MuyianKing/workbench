import { describe, expect, it } from 'vitest'
import { buildExportHtml } from './export-html'

const MIN_CSS = '.vditor-reset h1 { color: red; }'
/** 基础结构 CSS 的最小代表：决定表格是否合并边框（差距就出在这条上） */
const MIN_BASE_CSS = '.vditor-reset table { border-collapse: collapse; border-spacing: 0; }'

describe('buildExportHtml', () => {
  const base = {
    body: '<p>正文</p>',
    title: '周报',
    baseCss: MIN_BASE_CSS,
    contentThemeCss: MIN_CSS,
    highlightCss: '',
    dark: false,
  }

  it('把标题、正文与样式都收进同一份文档', () => {
    const html = buildExportHtml(base)
    expect(html).toContain('<title>周报</title>')
    expect(html).toContain('<p>正文</p>')
    expect(html).toContain(MIN_CSS)
    expect(html).toContain('class="export-page vditor-reset"')
  })

  it('带上基础结构 CSS：表格合并边框，不会出现单元格白缝', () => {
    const html = buildExportHtml(base)
    expect(html).toContain(MIN_BASE_CSS)
    // 基础结构必须在主题之前：主题只换配色，骨架由基础决定
    expect(html.indexOf(MIN_BASE_CSS)).toBeLessThan(html.indexOf(MIN_CSS))
  })

  it('标题里的尖括号与 & 被转义，不会破坏结构', () => {
    const html = buildExportHtml({ ...base, title: '<周报> & 计划' })
    expect(html).toContain('<title>&lt;周报&gt; &amp; 计划</title>')
    expect(html).not.toContain('<title><周报>')
  })

  it('深浅两档的页面底色不同', () => {
    expect(buildExportHtml({ ...base, dark: false })).toContain('background: #ffffff')
    expect(buildExportHtml({ ...base, dark: true })).toContain('background: #1e1e1e')
    // 打印时一律白底黑字
    expect(buildExportHtml(base)).toContain('background: #fff; color: #000')
  })
})
