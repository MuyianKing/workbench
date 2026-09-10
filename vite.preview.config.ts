import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/** PREVIEW-ONLY：只起 renderer，方便在浏览器里截图看布局，与构建无关 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [vue()],
  base: './',
  build: {
    outDir: resolve(__dirname, '.preview/dist'),
    emptyOutDir: true
  },
  server: {
    port: 5274,
    strictPort: true
  }
})
