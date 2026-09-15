import { describe, expect, it } from 'vitest'
import { markdownToPlainText, renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('空内容渲染成空串', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   \n  ')).toBe('')
  })

  it('原文里的标签不会变成真标签', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>\n'
    )
    expect(renderMarkdown('a & b <c>')).toBe('<p>a &amp; b &lt;c&gt;</p>\n')
  })

  it('段落与软换行（breaks：一个换行就是一个 <br>）', () => {
    expect(renderMarkdown('第一行\n第二行\n\n另一段')).toBe(
      '<p>第一行<br>\n第二行</p>\n<p>另一段</p>\n'
    )
  })

  it('标题按 # 的个数分级', () => {
    expect(renderMarkdown('## 今天的进度')).toBe('<h2>今天的进度</h2>\n')
  })

  it('粗体、斜体与删除线', () => {
    expect(renderMarkdown('**完成** *待办* ~~砍掉~~')).toBe(
      '<p><strong>完成</strong> <em>待办</em> <s>砍掉</s></p>\n'
    )
  })

  it('下划线式强调不啃掉 snake_case', () => {
    expect(renderMarkdown('_强调_ 与 work_log_file 一起')).toBe(
      '<p><em>强调</em> 与 work_log_file 一起</p>\n'
    )
  })

  it('行内代码里的标记原样保留', () => {
    expect(renderMarkdown('用 `a * b` 和 `**x**`')).toBe(
      '<p>用 <code>a * b</code> 和 <code>**x**</code></p>\n'
    )
  })

  it('代码块整段转义，不做行内解析', () => {
    expect(renderMarkdown('```\nconst a = 1 < 2\n**不加粗**\n```')).toBe(
      '<pre><code>const a = 1 &lt; 2\n**不加粗**\n</code></pre>\n'
    )
  })

  it('引用块与列表', () => {
    expect(renderMarkdown('> 记一笔\n> 第二行')).toBe(
      '<blockquote>\n<p>记一笔<br>\n第二行</p>\n</blockquote>\n'
    )
    expect(renderMarkdown('- 甲\n- 乙')).toBe('<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n')
    expect(renderMarkdown('1. 甲\n2. 乙')).toBe('<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>\n')
  })

  it('分割线不与会当成列表的短横线混淆', () => {
    expect(renderMarkdown('---')).toBe('<hr>\n')
    expect(renderMarkdown('- 一条')).toBe('<ul>\n<li>一条</li>\n</ul>\n')
  })

  it('链接一律带 target / rel —— 应用是个 WebView，默认导航会把界面顶掉', () => {
    expect(renderMarkdown('[文档](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">文档</a></p>\n'
    )
  })

  it('非 http(s) 的地址不生成链接', () => {
    expect(renderMarkdown('[点我](javascript:alert(1))')).toBe('<p>[点我](javascript:alert(1))</p>\n')
  })

  it('裸地址自动成链', () => {
    expect(renderMarkdown('见 https://example.com/a?x=1&y=2 的说明')).toBe(
      '<p>见 <a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noreferrer noopener">https://example.com/a?x=1&amp;y=2</a> 的说明</p>\n'
    )
  })

  it('链接标签里的强调照常生效', () => {
    expect(renderMarkdown('[**重点**](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer noopener"><strong>重点</strong></a></p>\n'
    )
  })
})

describe('markdownToPlainText', () => {
  it('去掉标记、压平换行', () => {
    expect(markdownToPlainText('# 标题\n\n- **条目** 与 `code`\n\n> 引用')).toBe('标题 条目 与 code 引用')
  })

  it('代码块整段丢掉，不留半截代码', () => {
    expect(markdownToPlainText('说明\n\n```\nconst a = 1\n```')).toBe('说明')
  })

  it('空内容返回空串', () => {
    expect(markdownToPlainText('  ')).toBe('')
  })
})
