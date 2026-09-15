import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
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
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  // vditorAssets 把 Vditor 的图标 / 语言包 / 内容主题等复制到 public/（见 scripts/sync-vditor-assets.mjs）
  plugins: [vue(), vditorAssets()],
  // Tauri 用自定义协议从根路径提供静态资源；相对路径在 http:// 与 tauri:// 下都不会出错
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true
  },
  server: {
    port: 5274,
    strictPort: true
  }
})
