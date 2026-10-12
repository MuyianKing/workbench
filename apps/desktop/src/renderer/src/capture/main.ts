import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { createApp } from 'vue'

import { installTauriWorkbench } from '@/workbench'
import CaptureApp from './CaptureApp.vue'

// Element Plus 的暗色变量表必须在 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/dist/index.css'
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
createApp(CaptureApp).use(ElementPlus, { locale: zhCn }).mount('#capture')
