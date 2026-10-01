<script setup lang="ts">
/**
 * 预览栏的 HTML 画法：**沙箱 iframe** —— sandbox 什么都不给（脚本不跑、无同源、
 * 表单与弹窗全禁）。AI 写的 HTML 里如果有脚本，绝不能在带宿主能力（window.workbench /
 * __TAURI_INTERNALS__）的 webview 里执行，这一层是硬边界；正文里的相对图片已由 AiView
 * 授权，这里按替换表改写成 asset URL，外链图片照旧加载（与笔记里的外链图片同一口径），
 * 链接点击也出不去（顶层导航被 sandbox 挡住）。
 */
import { computed } from 'vue'
import { rewriteHtmlImages } from '@workbench/ai'

const props = defineProps<{
  source: string
  /** 相对图片的替换表（原文里的 src → 已授权的 asset URL） */
  imageSrcs: Record<string, string>
}>()

const framed = computed(() => rewriteHtmlImages(props.source, props.imageSrcs))
</script>

<template>
  <!-- sandbox 绑定空串：属性存在但值为空 = 全限制（脚本、同源、表单、弹窗全禁） -->
  <iframe class="html-frame" :sandbox="''" :srcdoc="framed" title="HTML 预览" />
</template>

<style scoped>
/* 沙箱里是别人的文档：铺白底（一般 HTML 都是浅色的），高度撑满预览栏自己滚 */
.html-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
