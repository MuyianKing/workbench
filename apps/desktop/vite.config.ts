import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
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
  plugins: [vue(), vditorAssets(), pdfjsAssets()],
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
