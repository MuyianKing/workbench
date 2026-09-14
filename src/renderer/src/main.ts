import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import 'element-plus/dist/index.css'
// Element Plus 的暗色变量表必须在我们的 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/tokens.css'
import './styles/global.css'

import App from './App.vue'
import { applyBootstrapTheme } from './bootstrap'
import { initState, installTauriWorkbench, reapOrphansOnStart } from './workbench'

// 先装后端适配层，再取首屏快照：getBootstrap 是同步读 window 上的注入值，
// 顺序反了会读到 undefined，第一帧就会闪一次默认外观
installTauriWorkbench()
applyBootstrapTheme()

const app = createApp(App).use(createPinia()).use(ElementPlus, { locale: zhCn })

// 磁盘数据是异步的，等它就绪再 mount。放进 finally 是为了让读取失败也能出界面
// （届时 store 各自退回默认值，界面是空的但能用，而不是一片白）。
// Electron 版是主进程先 loadData 再建窗口，这里等价地等一次。
void initState().finally(() => {
  app.mount('#app')
  // 挂载之后再清理残留进程：它要挨个问进程的创建时间，别挡首屏
  void reapOrphansOnStart()
})
