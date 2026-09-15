import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vditorAssets } from './scripts/sync-vditor-assets.mjs'

/** PREVIEW-ONLY：只起 renderer，方便在浏览器里截图看布局，与构建无关 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  // 与 vite.config.ts 同源：笔记页要用 Vditor，浏览器预览里也得有它那份静态资源
  plugins: [vue(), vditorAssets()],
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '.preview/dist'),
    emptyOutDir: true
  },
  server: {
    port: 5274,
    strictPort: true
  }
})
