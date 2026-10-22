/**
 * Element Plus 按需引入之后，**模板组件之外**还要自己带的那几样样式。
 *
 * 模板里的 `<el-*>` 由 `vite.config.ts` 的 `Components` 插件在编译期换成单组件 import，
 * 连同该组件自己的 css 一起（`ElementPlusResolver({ importStyle: 'css' })`）。插件管不到的只有三处：
 *
 *  - `ElMessage` / `ElMessageBox`：代码里是**显式 import** 的（`notify.ts` 与若干组件），
 *    不是模板标签；
 *  - `v-loading`：指令不是组件，这一版的 `unplugin-vue-components` 不处理
 *    （`ElementPlusResolver` 的 `directives` 选项没有调用方），指令本身在 `main.ts` 里
 *    `app.use(ElLoading)` 注册，样式在这里；
 *  - 上面几样的依赖（base / overlay / input / button…）由各自的 `style/css` 入口带进来。
 *
 * 四个入口里凡是会用到 EP 的都 import 这一份（`capture` / `pin` 也会 —— `installTauriWorkbench`
 * 在快捷键注册失败时会 `notifyWarning`）。位置要排在 `tokens.css` 与 `global.css` **之前**，
 * 与原先整包 `element-plus/dist/index.css` 的位置一致。
 */
import 'element-plus/es/components/loading/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
