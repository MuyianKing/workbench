<script setup lang="ts">
/**
 * 工作日志的 markdown 展示。
 *
 * 解析交给 markdown-it（配置与安全口径见 shared/markdown.ts：`html: false`，
 * 原文里的标签早就被转义过，所以这里的 v-html 拿到的是安全的 HTML 片段）。
 *
 * 链接的点击在这里接管：应用是个 WebView，点 `<a>` 默认会把界面自己导航走。
 * 走的是项目里那条既有出口 —— `openExternal`（ShellExecute）交给系统默认浏览器。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { renderMarkdown } from '@shared/markdown'

const props = defineProps<{ source: string }>()

const html = computed(() => renderMarkdown(props.source))

/** 只有带协议的 http(s) / mailto 才值得交给系统；其余地址拦下但不打开 */
const OPENABLE = /^(https?:|mailto:)/i

async function onClick(event: MouseEvent): Promise<void> {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return

  // 无论打不打开，都不能让 webview 自己导航
  event.preventDefault()

  const href = anchor.getAttribute('href') ?? ''
  if (!OPENABLE.test(href)) return

  const result = await window.workbench.openExternal(href)
  if (!result.ok) ElMessage.warning(result.error ?? '打开链接失败')
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
