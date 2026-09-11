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

// 创建应用之前先把明暗与主题色落到 <html>：窗口在首帧之后就显示了，
// 等异步设置回来再改会让用户看见一次「默认外观 → 自己的外观」（见 bootstrap.ts）
applyBootstrapTheme()

createApp(App).use(createPinia()).use(ElementPlus, { locale: zhCn }).mount('#app')
