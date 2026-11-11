import { createApp } from 'vue'

import { installTauriWorkbench } from '@/workbench'
import VideoWindowApp from './VideoWindowApp.vue'

// Element Plus 按需引入（见 vite.config.ts 的 Components 插件）：这一屏用到
// el-dropdown / el-tooltip / el-button，模板里的那几个由插件接管；
// 消息条样式与遮罩 / 钉图同一个理由要带（installTauriWorkbench 也会说话）。
import '@/element-plus-styles'
// Element Plus 的暗色变量表必须在 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/tokens.css'

/**
 * 独立视频窗口的入口。
 *
 * 与遮罩 / 钉图 / 悬浮球同一条口径：只装后端适配层，不装 Pinia store、不 initState
 * （两个 JS 上下文都去落盘同一份数据文件会互相覆盖，见 docs/modules/video.md）。
 * 播放状态由主窗口经 Rust 交过来，窗口只持有一份本地播放状态。
 */
installTauriWorkbench()
createApp(VideoWindowApp).mount('#video-window')
