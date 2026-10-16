<script setup lang="ts">
import type { ParsedAttachment } from '@workbench/mail'
import { Download } from '@element-plus/icons-vue'
import { attachmentHtml, attachmentKind, attachmentText } from '@workbench/mail'
/**
 * 邮件附件的预览弹层：md / html / docx / pptx / pdf 在应用里直接看（图片走 EP 的查看器，见 MailView）。
 *
 * 五件画法都是借现成的，不新写一份：md → MarkdownView（markdown-it，`html: false`，
 * 原文里的标签早被转义过，v-html 拿到的是安全片段；正文里外链图片跟着信里写的地址
 * 加载，与 HTML 正文那条口子同一个口径）；html → **sandbox 的 iframe**（别人的文档，
 * 与邮件正文、AI 预览栏同一道硬边界：外链图片照常、链接经顶层导航转交系统浏览器）；
 * docx → AiPreviewDoc（docx-preview）；pptx → AiPreviewSlides（@aiden0z/pptx-renderer，
 * pdfjs 兜底在那里面显式关着）；pdf → PdfPreview（pdf.js，一页一页画到画布上）。
 * 五件都只吃 base64、都在浏览器里画、都不出网。
 *
 * **HTML 附件是唯一放行脚本的一档**（脚本不跑，一整页附件就只剩死版面）：它进的是
 * **不透明源**的沙箱 —— 给 `allow-scripts`、**绝不给 `allow-same-origin`**，摸不到父窗口
 * 那一层宿主能力（`window.workbench` / IPC），外链脚本也一个都不放行（文档自己的 CSP
 * 见 @workbench/mail 的 `ATTACHMENT_CSP`）。这条边界连同它的代价写在 docs/modules/mail.md。
 * 其余四档照旧：md 走 markdown-it（`html: false`）、docx / pptx / pdf 各自画，
 * 邮件**正文**那一档也照旧一行脚本都不跑。
 *
 * 高度与滚动：弹窗定高、正文不滚，滚的是中间那块画面（样式在 global.css 的
 * `.mail-preview-dialog` 那一组，与技能详情弹窗同一条口径）；HTML 那一档按窗口给足
 * 地方、整页铺满（`--wide`），其余四档照旧按文稿一页定宽。
 * 父层在 @closed 之后才把 file 清掉，所以这里的 file 允许是 null。
 */
import { computed } from 'vue'
import AiPreviewDoc from '@/components/AiPreviewDoc.vue'
import AiPreviewSlides from '@/components/AiPreviewSlides.vue'
import AppDialog from '@/components/AppDialog.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import PdfPreview from '@/components/PdfPreview.vue'

const props = defineProps<{ file: ParsedAttachment | null }>()
/** closed 是 EP 那一声：父层等它（关掉动画走完）才把 file 清掉，这里显式转出去 */
const emit = defineEmits<{ save: [], closed: [] }>()
const visible = defineModel<boolean>({ required: true })
const kind = computed(() => (props.file ? attachmentKind(props.file) : 'file'))
/** markdown 的正文（只有这一类要在这儿解码；docx / pptx 直接把 base64 交给画的那个） */
const text = computed(() => (props.file && kind.value === 'markdown' ? attachmentText(props.file) : ''))
/** HTML 附件的沙箱文档（CSP 与 no-referrer 已注入，见 @workbench/mail 的 attachmentHtml） */
const html = computed(() => (props.file && kind.value === 'html' ? attachmentHtml(props.file) : ''))
/**
 * HTML 附件的弹窗按窗口给足地方：那是一整页别人的东西，920px 的文稿宽度装不下
 * （页面排版会跟着弹窗缩成一团）。**只有 html 这一档放宽** —— md / docx / pptx / pdf
 * 的宽度是照文稿一页定的，不动。高度走 class（宽度由 EP 的行内样式给，改不动）。
 */
const wide = computed(() => kind.value === 'html')
</script>

<template>
  <AppDialog
    v-model="visible"
    :title="file?.name ?? ''"
    class="mail-preview-dialog" :class="[{ 'mail-preview-dialog--wide': wide }]"
    body-class="mail-preview-dialog__body"
    :width="wide ? 'min(1680px, calc(100vw - 32px))' : '920px'"
    @closed="emit('closed')"
  >
    <div class="preview" :class="{ 'preview--frame': wide }">
      <MarkdownView v-if="file && kind === 'markdown'" :source="text" />
      <!-- 沙箱里是别人的文档：**给脚本、不给同源**。allow-scripts 让它自己带的脚本跑；
           allow-same-origin 一定不能加 —— 加了就与宿主同源，能直接摸到 window.workbench
           那一层。现在它是不透明源：摸不到父窗口，表单 / 弹窗 / 下载全禁，顶层导航只有
           用户点得动（链接已由 attachmentHtml 统一改成 target="_top"，那次导航被 main.rs
           的 on_navigation 拦下转交系统浏览器）；外链图片照常加载、请求不带 Referer -->
      <iframe
        v-else-if="file && kind === 'html'"
        class="html-frame"
        sandbox="allow-scripts allow-top-navigation-by-user-activation"
        referrerpolicy="no-referrer"
        :srcdoc="html"
        title="HTML 附件"
      />
      <AiPreviewDoc v-else-if="file && kind === 'docx'" :binary="file.base64" />
      <AiPreviewSlides v-else-if="file && kind === 'pptx'" :binary="file.base64" />
      <PdfPreview v-else-if="file && kind === 'pdf'" :binary="file.base64" />
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

/** HTML 附件那一档整页铺满（不留圈白），里头自己滚 */
.preview--frame {
  padding: 0;
  overflow: hidden;
}

/**
 * HTML 附件：撑满那块画面（里头自己滚），铺白底 —— 沙箱里是别人的文档，一般网页都是浅色的
 * （与 MailView 的正文 iframe 同一口径）。
 */
.html-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: var(--r-sm);
  background: #fff;
}
</style>
