import { describe, expect, it } from 'vitest'
import { buildExportHtml } from './export-html'

const MIN_CSS = '.vditor-reset h1 { color: red; }'

describe('buildExportHtml', () => {
  const base = {
    body: '<p>正文</p>',
    title: '周报',
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
