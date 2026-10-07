import { describe, expect, it } from 'vitest'
import { decodeBase64ToBuffer, htmlImageSrcs, resolveAiPreview, rewriteHtmlImages } from './ai-preview'

const DIR = 'F:\\work\\proj'

describe('resolveAiPreview', () => {
  it('相对地址对到会话工作目录（`../` 出去是本意）', () => {
    expect(resolveAiPreview('../test.md', DIR)).toEqual({
      ok: true,
      path: 'F:\\work\\test.md',
      kind: 'markdown',
    })
    expect(resolveAiPreview('./docs/计划.md', DIR)).toEqual({
      ok: true,
      path: 'F:\\work\\proj\\docs\\计划.md',
      kind: 'markdown',
    })
    expect(resolveAiPreview('notes/todo.txt', DIR)).toEqual({
      ok: true,
      path: 'F:\\work\\proj\\notes\\todo.txt',
      kind: 'text',
    })
  })

  it('markdown-it 转过的百分号地址先解回来', () => {
    expect(resolveAiPreview('../%E6%B5%8B%E8%AF%95.md', DIR)).toEqual({
      ok: true,
      path: 'F:\\work\\测试.md',
      kind: 'markdown',
    })
  })

  it('连续的 . 与 .. 收敛干净，弹出目录就真出去了', () => {
    expect(resolveAiPreview('./a/./b/../../outside.txt', DIR)).toEqual({
      ok: true,
      path: 'F:\\work\\proj\\outside.txt',
      kind: 'text',
    })
    expect(resolveAiPreview('./a/b/../../../outside.txt', DIR)).toEqual({
      ok: true,
      path: 'F:\\work\\outside.txt',
      kind: 'text',
    })
  })

  it('绝对路径原样收下（正斜杠统一成反斜杠），UNC 也认', () => {
    expect(resolveAiPreview('F:/a/b/报告.md', DIR)).toEqual({
      ok: true,
      path: 'F:\\a\\b\\报告.md',
      kind: 'markdown',
    })
    expect(resolveAiPreview('\\\\srv\\share\\readme.txt', DIR)).toEqual({
      ok: true,
      path: '\\\\srv\\share\\readme.txt',
      kind: 'text',
    })
  })

  it('`..` 弹到盘符根就停在根上，不再往上弹', () => {
    expect(resolveAiPreview('../../../../x.txt', 'F:\\proj')).toEqual({
      ok: true,
      path: 'F:\\x.txt',
      kind: 'text',
    })
  })

  it('画法按扩展名定：markdown / 图片 / html / docx / pptx / 其余文本', () => {
    expect(resolveAiPreview('a.MD', DIR)).toMatchObject({ kind: 'markdown' })
    expect(resolveAiPreview('shots/界面.PNG', DIR)).toMatchObject({ kind: 'image' })
    expect(resolveAiPreview('页面.html', DIR)).toMatchObject({ kind: 'html' })
    expect(resolveAiPreview('页面.htm', DIR)).toMatchObject({ kind: 'html' })
    expect(resolveAiPreview('报告.docx', DIR)).toMatchObject({ kind: 'docx' })
    expect(resolveAiPreview('汇报.pptx', DIR)).toMatchObject({ kind: 'pptx' })
    expect(resolveAiPreview('package.json', DIR)).toMatchObject({ kind: 'text' })
    expect(resolveAiPreview('README', DIR)).toMatchObject({ kind: 'text' })
  })

  it('解不了的格式明确说不：Excel 与老二进制格式，不掉进文本通道读乱码', () => {
    expect(resolveAiPreview('数据.xlsx', DIR)).toMatchObject({ ok: false })
    expect(resolveAiPreview('数据.xls', DIR)).toMatchObject({ ok: false })
    expect(resolveAiPreview('旧文档.doc', DIR)).toMatchObject({ ok: false })
    expect(resolveAiPreview('旧演示.ppt', DIR)).toMatchObject({ ok: false })
  })

  it('带协议头的地址、锚点与空串都解不出，理由给人看', () => {
    expect(resolveAiPreview('https://example.com/a.md', DIR)).toMatchObject({ ok: false })
    expect(resolveAiPreview('javascript:alert(1)', DIR)).toMatchObject({ ok: false })
    expect(resolveAiPreview('#某一节', DIR)).toMatchObject({ ok: false })
    expect(resolveAiPreview('   ', DIR)).toMatchObject({ ok: false })
  })

  it('盘符不像协议头：单字母 + 冒号是路径，不是 scheme', () => {
    expect(resolveAiPreview('C:\\x\\a.md', DIR)).toEqual({
      ok: true,
      path: 'C:\\x\\a.md',
      kind: 'markdown',
    })
  })

  it('相对地址遇上没有工作目录的对话，如实说', () => {
    expect(resolveAiPreview('../test.md', '')).toMatchObject({ ok: false })
  })
})

describe('decodeBase64ToBuffer', () => {
  it('解回原字节，坏串给 null', () => {
    // 'Workbench' 的 UTF-8 字节 → base64
    const encoded = btoa('Workbench')
    const buffer = decodeBase64ToBuffer(encoded)
    expect(buffer).not.toBeNull()
    expect(new TextDecoder().decode(buffer!)).toBe('Workbench')
    expect(decodeBase64ToBuffer('不是 base64')).toBeNull()
  })
})

describe('htmlImageSrcs / rewriteHtmlImages', () => {
  const html = '<p><img src=" shots/a.png " alt="外"></p><img src=\'http://x/b.png\'><img src="data:image/png;base64,AA">'

  it('收 <img> 的 src（单双引号都认），外链与 data URL 原样给出、由解析那步筛', () => {
    expect(htmlImageSrcs(html)).toEqual([' shots/a.png ', 'http://x/b.png', 'data:image/png;base64,AA'])
    expect(htmlImageSrcs('')).toEqual([])
  })

  it('按替换表改写 src，表里没有的原样保留', () => {
    const rewritten = rewriteHtmlImages(html, { ' shots/a.png ': 'asset://已授权' })
    expect(rewritten).toContain('<img src="asset://已授权" alt="外">')
    expect(rewritten).toContain('src=\'http://x/b.png\'')
    expect(rewriteHtmlImages(html, {})).toBe(html)
  })
})
