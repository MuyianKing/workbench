<script setup lang="ts">
import type { ParsedAttachment } from '@workbench/mail'
import { Download } from '@element-plus/icons-vue'
import { attachmentKind, attachmentText } from '@workbench/mail'
/**
 * 邮件附件的预览弹层：md / docx / pptx 在应用里直接看（图片走 EP 的查看器，见 MailView）。
 *
 * 三件画法都是借现成的，不新写一份：md → MarkdownView（markdown-it，`html: false`，
 * 原文里的标签早被转义过，v-html 拿到的是安全片段；正文里外链图片跟着信里写的地址
 * 加载，与 HTML 正文那条口子同一个口径）；docx → AiPreviewDoc（docx-preview）；
 * pptx → AiPreviewSlides（@aiden0z/pptx-renderer，pdfjs 兜底在那里面显式关着）。
 * 三件都只吃 base64、都在浏览器里画、都不出网。
 *
 * 高度与滚动：弹窗定高、正文不滚，滚的是中间那块画面（样式在 global.css 的
 * `.mail-preview-dialog` 那一组，与技能详情弹窗同一条口径）。
 * 父层在 @closed 之后才把 file 清掉，所以这里的 file 允许是 null。
 */
import { computed } from 'vue'
import AiPreviewDoc from '@/components/AiPreviewDoc.vue'
import AiPreviewSlides from '@/components/AiPreviewSlides.vue'
import AppDialog from '@/components/AppDialog.vue'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{ file: ParsedAttachment | null }>()
/** closed 是 EP 那一声：父层等它（关掉动画走完）才把 file 清掉，这里显式转出去 */
const emit = defineEmits<{ save: [], closed: [] }>()
const visible = defineModel<boolean>({ required: true })
const kind = computed(() => (props.file ? attachmentKind(props.file) : 'file'))
/** markdown 的正文（只有这一类要在这儿解码；docx / pptx 直接把 base64 交给画的那个） */
const text = computed(() => (props.file && kind.value === 'markdown' ? attachmentText(props.file) : ''))
</script>

<template>
  <AppDialog
    v-model="visible"
    :title="file?.name ?? ''"
    class="mail-preview-dialog"
    body-class="mail-preview-dialog__body"
    width="920px"
    @closed="emit('closed')"
  >
    <div class="preview">
      <MarkdownView v-if="file && kind === 'markdown'" :source="text" />
      <AiPreviewDoc v-else-if="file && kind === 'docx'" :binary="file.base64" />
      <AiPreviewSlides v-else-if="file && kind === 'pptx'" :binary="file.base64" />
    </div>

    <!-- 弹层挡着附件片，另存得在这儿留一个口子（片子上那颗图标按钮是同一条链路） -->
    <template #footer>
      <el-button @click="visible = false">
        关闭
      </el-button>
      <el-button :icon="Download" @click="emit('save')">
        另存为
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
/**
 * 画面自己滚（弹窗定高、正文不滚）；定位与 flex 那几条在 global.css。
 * 内边距只留一小圈 —— 弹窗宽度就是照着 docx 一页（A4 794px / Letter 816px）定的，
 * 页外不该再堆出一大片白。**横向也要能滚**：横排的文稿比弹窗宽，裁掉就没法看了。
 */
.preview {
  flex: 1;
  min-height: 0;
  padding: var(--sp-3);
  overflow: auto;
}
</style>
