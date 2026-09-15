/**
 * 工作日志里的 markdown 渲染。
 *
 * 解析交给 markdown-it（用户明确要求用它，不再自己写解析器）。配置里有三件事是刻意的：
 *
 *  - `html: false`：原文里的标签按文字显示，不会变成真标签 —— 日志内容是自己写的，
 *    但它同样要经过一层「不进标签」的口径，v-html 才敢直接用（见 MarkdownView）；
 *  - `linkify: true`：裸地址自动成链，markdown-it 自带这条，不必再引 `shared/linkify.ts`
 *    那套（那是给终端日志切片段用的，两处的诉求不一样）；
 *  - `breaks: true`：单个换行就是 `<br>`。日志是一行一行写的，不这样的话
 *    「第一行\n第二行」会被并成一段，写的人看到的和渲染出来的对不上。
 *
 * 另外把链接统一改成新窗口打开，并交出 `target` / `rel`：应用是个 WebView，
 * 点一个 `<a>` 默认会把应用自己导航走（界面直接没了）。
 */
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  // 排版替换（引号、破折号）会把用户写的原文改掉，日志不需要这个
  typographer: false
})

/** 默认的 token 渲染；link_open 用的是它，所以这里取同一份实现 */
const renderToken = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noreferrer noopener')
  return renderToken(tokens, idx, options, env, self)
}

/**
 * markdown 原文 → 可以直接插入页面的 HTML 片段（空内容返回空串，不留一个空段落）。
 *
 * 安全性由 markdown-it 保证：`html: false` 转义原文里的标签，它自带的 `validateLink`
 * 也挡掉了 `javascript:` / `data:` 这类地址。
 */
export function renderMarkdown(source: string): string {
  if (typeof source !== 'string' || !source.trim()) return ''
  return md.render(source)
}

/**
 * 去掉标记后的纯文本，列表 / 确认框里当摘要用。
 *
 * 走的是同一份 token 流（不另写一套正则去剥标记，那样迟早和渲染结果对不上）：
 * 只取行内 token 里的文字，代码块整段不要 —— 摘要里出现半截代码没有意义。
 */
export function markdownToPlainText(source: string): string {
  if (typeof source !== 'string' || !source.trim()) return ''

  const parts: string[] = []
  for (const token of md.parse(source, {})) {
    for (const child of token.children ?? []) {
      if (child.type === 'text' || child.type === 'code_inline') parts.push(child.content)
      else if (child.type === 'softbreak' || child.type === 'hardbreak') parts.push(' ')
    }
    // 纯文本的行内内容（标题、段落）都带着 children，上面已经取过；这里只补空行分隔
    if (token.children?.length) parts.push(' ')
  }

  return parts.join('').replace(/\s+/g, ' ').trim()
}
