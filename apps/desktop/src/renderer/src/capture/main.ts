import { createApp } from 'vue'

import { installTauriWorkbench } from '@/workbench'
import CaptureApp from './CaptureApp.vue'

// Element Plus 按需引入（见 vite.config.ts 的 Components 插件）：这一屏只用到 el-icon / el-tooltip，
// 所以不再 `app.use(ElementPlus)`、也不引整包 CSS —— 模板标签由插件在编译期换掉即可。
// 消息条那一套样式仍要带：installTauriWorkbench 在快捷键注册失败时会 notifyWarning。
import '@/element-plus-styles'
// Element Plus 的暗色变量表必须在 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/tokens.css'
import './overlay.css'

/**
 * 遮罩窗口的入口。
 *
 * **只装后端适配层，不装 store、不 initState**：遮罩与主窗口是两个 JS 上下文，
 * 两边都去载入 / 落盘同一份 `workbench-data.json` 会互相覆盖（见 docs/modules/screenshot.md）。
 * 这一屏要的那几项设置由 Rust 随 capture_context 一起给（见 capture.rs 的 CaptureOptions）。
 */
installTauriWorkbench()
createApp(CaptureApp).mount('#capture')
