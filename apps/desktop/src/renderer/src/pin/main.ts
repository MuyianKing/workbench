import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { createApp } from 'vue'

import { installTauriWorkbench } from '@/workbench'
import PinApp from './PinApp.vue'

// Element Plus 的暗色变量表必须在 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/dist/index.css'
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
createApp(PinApp).use(ElementPlus, { locale: zhCn }).mount('#pin')
