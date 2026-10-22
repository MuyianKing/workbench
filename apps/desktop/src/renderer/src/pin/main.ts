import { createApp } from 'vue'

import { installTauriWorkbench } from '@/workbench'
import PinApp from './PinApp.vue'

// Element Plus 按需引入（见 vite.config.ts 的 Components 插件）：这一屏只用到 el-icon，
// 不再 app.use(ElementPlus)、也不引整包 CSS；消息条样式与遮罩窗口同一个理由要带。
import '@/element-plus-styles'
// Element Plus 的暗色变量表必须在 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/tokens.css'
import '@/capture/overlay.css'

/**
 * 钉图窗口的入口。
 *
 * 与遮罩窗口同一条口径：只装后端适配层，不装 store、不 initState
 * （两个 JS 上下文都去落盘同一份数据文件会互相覆盖，见 docs/modules/screenshot.md）。
 */
installTauriWorkbench()
createApp(PinApp).mount('#pin')
