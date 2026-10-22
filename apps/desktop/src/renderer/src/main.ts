import { ElLoading, provideGlobalConfig } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { applyBootstrapTheme } from './bootstrap'
import { initState, installTauriWorkbench, reapOrphansOnStart } from './workbench'
// Element Plus 按需引入：模板里的 <el-*> 由 vite.config.ts 的 Components 插件在编译期逐个换成
// 单组件 import（连同该组件的 css），整包的 dist/index.css 不再引。剩下插件管不到的那几样
// （命令式 API 与 v-loading 的样式）集中在 element-plus-styles.ts。
import './element-plus-styles'

// Element Plus 的暗色变量表必须在我们的 tokens 之前，:root[data-theme='dark'] 才能盖住它
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/tokens.css'
import './styles/global.css'

// 先装后端适配层，再取首屏快照：getBootstrap 是同步读 window 上的注入值，
// 顺序反了会读到 undefined，第一帧就会闪一次默认外观
installTauriWorkbench()
applyBootstrapTheme()

const app = createApp(App).use(createPinia())
// 与原先 `app.use(ElementPlus, { locale: zhCn })` 等价的那一半：第三个参数是「全局」，
// 少了它 ElMessage / ElMessageBox 这类在组件树外创建的实例读不到 locale（按钮会变英文）。
provideGlobalConfig({ locale: zhCn }, app, true)
// v-loading：指令不是组件，这一版的组件插件不处理，得当作插件显式装上
// （它同时注册 $loading 服务，本应用不用）。
app.use(ElLoading)

// 磁盘数据是异步的，等它就绪再 mount。放进 finally 是为了让读取失败也能出界面
// （届时 store 各自退回默认值，界面是空的但能用，而不是一片白）。
// Electron 版是主进程先 loadData 再建窗口，这里等价地等一次。
void initState().finally(() => {
  app.mount('#app')
  // 挂载之后再清理残留进程：它要挨个问进程的创建时间，别挡首屏
  void reapOrphansOnStart()
})
