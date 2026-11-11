import { createApp } from 'vue'

import { applyBootstrapTheme } from '@/bootstrap'
import { installTauriWorkbench } from '@/workbench'
import MarkdownWindowApp from './MarkdownWindowApp.vue'

// Element Plus 按需引入（见 vite.config.ts 的 Components 插件）：这一屏用到 el-icon /
// el-tooltip / el-button，模板里的那几个由插件接管；消息条与确认框的样式要带
// （保存失败要说一句、关闭前可能问一句）。
import '@/element-plus-styles'
// Element Plus 的暗色变量表必须在 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/tokens.css'

/**
 * 独立 Markdown 编辑窗口的入口。
 *
 * 与遮罩 / 钉图 / 悬浮球 / 视频窗口同一条口径：只装后端适配层，不装 Pinia store、
 * 不 initState（两个 JS 上下文都去落盘同一份数据文件会互相覆盖，见 docs/modules/notes.md）。
 * 打开的是哪个文件由 Rust 会话持有，这扇窗只拿到文件名、正文与 mtime。
 */
installTauriWorkbench()
applyBootstrapTheme()
createApp(MarkdownWindowApp).mount('#markdown-window')
