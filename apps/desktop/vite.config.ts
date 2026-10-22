import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'
import { pdfjsAssets } from './scripts/sync-pdfjs-assets.mjs'
import { vditorAssets } from './scripts/sync-vditor-assets.mjs'

/**
 * 渲染层的唯一构建入口。
 *
 * 开发态给 `tauri dev` 当 devUrl（端口与 src-tauri/tauri.conf.json 的 devUrl 必须一致），
 * 构建态产出 out/renderer，由 Tauri 在编译期内嵌进可执行文件。
 * 浏览器里单独看布局仍走 vite.preview.config.ts（产物落在 .preview/，不参与打包）。
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: {
    // 域包（@workbench/*）不配别名：走 workspace 软链与各包 exports 的包名解析
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
    },
  },
  // vditorAssets 把 Vditor 的图标 / 语言包 / 内容主题等复制到 public/（见 scripts/sync-vditor-assets.mjs）；
  // pdfjsAssets 同理，带的是 pdf.js 运行时按需取的 cmaps / 标准字体 / wasm（见 scripts/sync-pdfjs-assets.mjs）
  plugins: [
    vue(),
    /**
     * Element Plus 按需引入：模板里的 `<el-*>`（含 `el-table-column` 这类连字符名）与 `v-loading`
     * 里的组件部分，在这一层被换成 `element-plus/es` 的单组件 import，连同该组件自己的 css
     * （`importStyle: 'css'`，与原来引整包 css 同一种产物，不需要 sass）。
     *
     * 两个开关都刻意置空：
     *  - `dirs: []`：本地组件仍由各文件显式 import（与改造前一致），别让插件顺手接管；
     *  - `dts: false`：不生成 `components.d.ts`。EP 的组件类型本来就没进过这份工程
     *    （没引 `element-plus/global`），开了等于给模板新上一套 props 校验 —— 那是另一件事。
     *
     * 插件管不到的三样（ElMessage / ElMessageBox / v-loading 的样式）在
     * `src/renderer/src/element-plus-styles.ts`，指令本身由 `main.ts` 的 `app.use(ElLoading)` 注册。
     */
    Components({
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dirs: [],
      dts: false,
    }),
    vditorAssets(),
    pdfjsAssets(),
  ],
  // Tauri 用自定义协议从根路径提供静态资源；相对路径在 http:// 与 tauri:// 下都不会出错
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      /**
       * 四个入口：主界面、截图遮罩、钉图、悬浮球。
       *
       * 后三个是**独立的窗口、各自的 JS 上下文**（Rust 侧用 WebviewUrl::App 分别加载
       * capture.html / pin.html / ball.html），所以必须是 HTML 入口而不是路由 —— 它们不该、
       * 也不能去装主界面那套 store（那会与主窗口抢着写同一批 JSON，见
       * docs/modules/screenshot.md 与 docs/modules/float-ball.md）。
       */
      input: {
        main: resolve(import.meta.dirname, 'src/renderer/index.html'),
        capture: resolve(import.meta.dirname, 'src/renderer/capture.html'),
        pin: resolve(import.meta.dirname, 'src/renderer/pin.html'),
        ball: resolve(import.meta.dirname, 'src/renderer/ball.html'),
      },
    },
  },
  server: {
    port: 5274,
    strictPort: true,
  },
})
