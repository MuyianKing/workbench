/**
 * 把 Vditor 渲染出的正文 HTML 包成一份**自包含**的 HTML 文档（笔记导出用）。
 *
 * 自包含指的是这一份文件拷到任何机器、用任何浏览器打开都能看到一样的排版：
 * 样式直接内联进 `<style>`，图片本来就是笔记正文里的外链。不引用应用里的相对路径
 * （导出的文件不在应用目录里，那些路径一个都解析不了），也不引用随包的 Vditor 资源
 * （换个环境就没有了）。代码块的高亮由 Vditor 渲染时写好的 class 决定，这里只带配色表。
 */

/** 只对文档标题用：标题是纯文本，别让它里面的 `<` `&` 破坏结构 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export interface ExportHtmlInput {
  /** 已经渲染好的正文 HTML（Vditor 的 getHTML()） */
  body: string
  /** 文档标题（笔记名，纯文本） */
  title: string
  /** 随包内容主题 CSS（Vditor 的 content-theme/<light|dark>.css 原文） */
  contentThemeCss: string
  /** 代码块高亮配色 CSS（github / github-dark 的原文） */
  highlightCss: string
  /** 深色档（影响页面底色与文字色） */
  dark: boolean
}

/**
 * 生成一份完整的 HTML 文档字符串。
 *
 * 样式只取正文那部分：`.vditor-reset` 是 Vditor 给预览内容的外壳类，内容与主题 CSS
 * 都挂在它下面；页面本身只补一档居中的容器与底色，不把编辑器那一整套控件带进来。
 */
export function buildExportHtml(input: ExportHtmlInput): string {
  const pageBg = input.dark ? '#1e1e1e' : '#ffffff'
  const pageInk = input.dark ? '#d4d4d4' : '#24292f'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
html, body { margin: 0; padding: 0; background: ${pageBg}; color: ${pageInk}; }
body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.export-page { max-width: 860px; margin: 0 auto; padding: 40px 32px 80px; }
${input.highlightCss}
${input.contentThemeCss}
@media print { html, body { background: #fff; color: #000; } .export-page { max-width: none; padding: 0; } }
</style>
</head>
<body>
<div class="export-page vditor-reset">${input.body}</div>
</body>
</html>`
}
