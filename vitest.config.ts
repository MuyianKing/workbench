import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 与 vite.config.ts 保持一致：适配层的模块用的是同一套别名，
  // 少了这一段，src/renderer 下的用例连 import 都解析不了
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  test: {
    // 被测模块都是共享层的纯逻辑，不需要 DOM
    environment: 'node',
    // 只跑 shared 与 renderer：这两处是纯逻辑与适配层。
    // Rust 侧（src-tauri）的单测走 `cargo test`，不在这个 runner 里
    include: ['src/shared/**/*.test.ts', 'src/renderer/**/*.test.ts'],
    reporters: ['default']
  }
})
