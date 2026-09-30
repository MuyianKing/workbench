import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 与 vite.config.ts 保持一致：适配层的模块用的是同一套别名，
  // 少了这一段，src/renderer 下的用例连 import 都解析不了。
  // 域包（@workbench/*）不配别名：走 workspace 软链与各包 exports 的包名解析
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    // 只跑渲染层：适配层与组件相关纯逻辑。
    // 域包（packages/*）各自的用例由各包自己的 runner 跑（pnpm -r test 聚合）；
    // Rust 侧（src-tauri）的单测走 `cargo test`，不在这个 runner 里
    include: ['src/renderer/**/*.test.ts'],
    reporters: ['default']
  }
})
