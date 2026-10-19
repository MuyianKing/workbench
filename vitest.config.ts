import { defineConfig } from 'vitest/config'

/**
 * 全量测试的入口：一条 `vitest run` 把 18 个项目收进同一个进程（根 package.json 的 `test`）。
 *
 * 为什么不用 `pnpm -r test`：那会给**每个包各起一个 vitest 进程**，18 次进程与配置启动实测约 16s，
 * 而单包真正跑用例只要 0.77s（`core` 实测 1.7s）—— 这条链上最后一块大头就是它。
 *
 * 各包自己的 `vitest.config.ts` 仍是唯一的配置来源（`include` / `environment` / `@` 别名都在那儿），
 * 这里只负责把它们收进同一个进程，不在根上重写一遍。所以：
 *
 * - 全量：`pnpm test`
 * - 只跑受影响的那个包（改到一半时用）：`pnpm -F @workbench/<包> test` —— 走它自己的配置与 cwd
 *
 * 明细与实测见 docs/dev-notes/build-performance.md 的「验证链的耗时」。
 */
export default defineConfig({
  test: {
    // 每个目录下各有一份 vitest.config.ts（域包 17 份 + 应用 1 份，渲染层用例在 apps/desktop）
    projects: ['packages/*', 'apps/desktop'],
  },
})
