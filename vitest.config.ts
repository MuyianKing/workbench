import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 被测模块都是主进程 / 共享层的纯逻辑，不需要 DOM
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default']
  }
})
