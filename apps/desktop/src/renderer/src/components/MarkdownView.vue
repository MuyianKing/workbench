<script setup lang="ts">
/**
 * 工作日志的 markdown 展示。
 *
 * 解析交给 markdown-it（配置与安全口径见 shared/markdown.ts：`html: false`，
 * 原文里的标签早就被转义过，所以这里的 v-html 拿到的是安全的 HTML 片段）。
 *
 * 链接的点击在这里接管：应用是个 WebView，点 `<a>` 默认会把界面自己导航走。
 * 走的是项目里那条既有出口 —— `openExternal`（ShellExecute）交给系统默认浏览器。
 *
 * `internalLinks` 置真时，非外部地址的链接不再被吞掉、改经 `internal` 事件交给父层
 * （地址原样交出去，怎么解析归父层：知识库条目阅读按它做站内跳转，见 shared/kb-lint.ts
 * 的 resolveKbLink）。默认关 —— 工作日志、AI 对话那几处照旧只放行外部地址。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { renderMarkdown } from '@workbench/core'

const props = defineProps<{
  source: string
  /** 站内链接（相对路径）要不要交给父层：真 = emit `internal`，假 = 拦下不处理 */
  internalLinks?: boolean
}>()

const emit = defineEmits<{ internal: [href: string] }>()

const html = computed(() => renderMarkdown(props.source))

/** 只有带协议的 http(s) / mailto 才值得交给系统；其余地址拦下，站内的看父层要不要 */
const OPENABLE = /^(https?:|mailto:)/i

async function onClick(event: MouseEvent): Promise<void> {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return

  // 无论打不打开，都不能让 webview 自己导航
  event.preventDefault()

  const href = anchor.getAttribute('href') ?? ''
  if (OPENABLE.test(href)) {
    const result = await window.workbench.openExternal(href)
    if (!result.ok) ElMessage.warning(result.error ?? '打开链接失败')
    return
  }
  // 纯锚点（`#某一节`）不是跳文件：不往上交（父层也解析不出它）
  if (props.internalLinks && href && !href.startsWith('#')) emit('internal', href)
}
</script>

<template>
  <div class="md" v-html="html" @click="onClick" />
</template>

<style scoped>
.md {
  font-size: var(--fs-body);
  line-height: 1.75;
  color: var(--ink);
  /* 长英文串 / 长地址不该把卡片撑破 */
  word-break: break-word;
  overflow-wrap: anywhere;
}

.md :deep(p) {
  margin: 0 0 6px;
}

.md :deep(p:last-child) {
  margin-bottom: 0;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 10px 0 6px;
  font-size: var(--fs-body);
  font-weight: 600;
  line-height: 1.5;
}

.md :deep(h1:first-child),
.md :deep(h2:first-child),
.md :deep(h3:first-child) {
  margin-top: 0;
}

.md :deep(h1),
.md :deep(h2) {
  font-size: var(--fs-title);
}

/**
 * 列表标记要写回来：global.css 的 reset 把 ul / ol 的 list-style 清成了 none，
 * 那条规则是为界面自己的布局列表定的，markdown 正文里的列表得有自己的圆点与序号。
 */
.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 6px;
  padding-left: 22px;
}

.md :deep(ul) {
  list-style: disc;
}

.md :deep(ol) {
  list-style: decimal;
}

.md :deep(li) {
  margin: 2px 0;
}

.md :deep(code) {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
}

.md :deep(pre) {
  margin: 0 0 6px;
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-inset);
  overflow-x: auto;
}

.md :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: var(--fs-meta);
  line-height: 1.6;
}

.md :deep(blockquote) {
  margin: 0 0 6px;
  padding: 2px 0 2px var(--sp-3);
  border-left: 2px solid var(--border-strong);
  color: var(--ink-2);
}

/**
 * 表格：**一圈描边 + 内部网格线 + 表头压一档底色**，外面的 `.md-table` 是渲染时包上的
 * 那层滚动容器（见 shared/markdown.ts）—— 列多的表在它里面横向滚，不会把卡片撑破。
 *
 * **框要贴着表格**：容器是个 block，不给宽度就占满整张卡片，表格缩在左边、右边空出一大条
 * 只有框没有内容的区域。所以 `width: fit-content`（有多宽占多宽）+ `max-width: 100%`
 * （宽过卡片时由 `overflow-x` 兜住）。
 *
 * 外框与圆角归外面那一层，格子只画内部的线（首行 / 末行 / 首列 / 末列那四条去掉），
 * 不然外框与格子的线贴在一起会变成一条两像素粗的边。
 * 线一律取 `--border`（界面上所有描边都是它）。
 */
.md :deep(.md-table) {
  width: fit-content;
  max-width: 100%;
  margin: 0 0 6px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}

.md :deep(.md-table table) {
  /* 单元格各自画线、合并成一条：不然相邻两格会画出双线 */
  border-collapse: collapse;
  font-size: var(--fs-meta);
}

.md :deep(.md-table th),
.md :deep(.md-table td) {
  padding: 5px var(--sp-3);
  border: 1px solid var(--border);
}

.md :deep(.md-table tr > :first-child) {
  border-left: 0;
}

.md :deep(.md-table tr > :last-child) {
  border-right: 0;
}

.md :deep(.md-table thead tr:first-child > *) {
  border-top: 0;
}

.md :deep(.md-table tr:last-child > *) {
  border-bottom: 0;
}

.md :deep(.md-table th) {
  background: var(--bg-inset);
  font-weight: 600;
  /* 表头不换行（它是这一列的名字）；原文没写对齐时浏览器默认把 th 居中，
     与单元格的左对齐对不上 —— 原文写了 `:---:` 那种时 markdown-it 会给行内 style，
     优先级比这条高，照旧生效 */
  white-space: nowrap;
  text-align: left;
}

.md :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.md :deep(a:hover) {
  text-decoration: underline;
}

.md :deep(hr) {
  margin: var(--sp-3) 0;
  border: 0;
  border-top: 1px solid var(--border);
}

/* markdown-it 的删除线出的是 <s>，别的实现是 <del>，两个都盖住 */
.md :deep(del),
.md :deep(s) {
  color: var(--ink-3);
}

.md :deep(strong) {
  font-weight: 600;
}
</style>
