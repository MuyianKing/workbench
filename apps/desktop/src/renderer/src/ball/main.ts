import { createApp } from 'vue'

import { installTauriWorkbench } from '@/workbench'
import BallApp from './BallApp.vue'

import '@/styles/tokens.css'

// 与 pin / capture 两个入口一致：只装适配层，不装 Pinia、不 initState。
// 这个窗口里没有 Element Plus 的组件（收起态是自绘的贴片、展开态是 SVG 表盘），
// 所以连它的样式都不引 —— 窗口只有 76px 见方，少一层全量 CSS 就少一层开销。
installTauriWorkbench()
createApp(BallApp).mount('#ball')
