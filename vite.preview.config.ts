import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/** PREVIEW-ONLY：只起 renderer，方便在浏览器里截图看布局，与构建无关 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  plugins: [vue()],
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
