/**
 * 会话这一侧「停止到底停了哪一条」的判定。
 *
 * 一个项目可以同时挂着几条会话（dev server 在跑、又点了一次打包），而卡片上只有一颗「停止」。
 * 早先的实现取「在跑的任意一条」，命中的总是最先起的那条 —— 症状是写着「打包中」按停止，
 * 被停掉的是旁边的 dev server，打包照旧在跑。
 *
 * 跑在 node 环境里，没有 window，所以导入前先补一个最小的 Tauri 桥（写法同 state.test.ts）：
 * 这几条用例只需要 spawn_session 回一个 PID，其余通道一律 null。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { terminalKey } from '@shared/terminal-key'
import type { Project } from '@shared/types'

const calls: Array<{ command: string; args?: Record<string, unknown> }> = []

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        calls.push({ command, args })
        if (command === 'spawn_session') return Promise.resolve(4321)
        return Promise.resolve(null)
      }
    }
  }
})

// 桥必须在 import 之前就位，所以这里用动态导入
const session = await import('./session')

function makeProject(id: string): Project {
  return {
    id,
    name: 'blog',
    path: 'F:/projects/blog',
    packageManager: 'pnpm',
    detectedPackageManager: 'pnpm',
    framework: '',
    version: '',
    scripts: { serve: 'dev', build: ['build'], defaultBuild: 'build' },
    autoOpenExplorer: false,
    order: 0,
    createdAt: 0
  }
}

/** 起一条 dev server 与一次打包，返回它们各自的终端键 */
async function runTwo(id: string): Promise<void> {
  const project = makeProject(id)
  expect((await session.startProject(project)).ok).toBe(true)
  expect((await session.buildProject(project, 'build')).ok).toBe(true)
}

describe('停止命中哪一条会话', () => {
  it('写着打包中就停打包：按 kind 命中打包那条', async () => {
    const id = 'p-build'
    await runTwo(id)
    calls.length = 0

    expect((await session.stopOwner(id, 'build')).ok).toBe(true)

    const stopped = calls.find((item) => item.command === 'stop_session')
    expect(stopped?.args?.sessionId).toBe(terminalKey(id, 'build'))
  })

  it('写着运行中就停 dev server', async () => {
    const id = 'p-start'
    await runTwo(id)
    calls.length = 0

    expect((await session.stopOwner(id, 'start')).ok).toBe(true)

    const stopped = calls.find((item) => item.command === 'stop_session')
    expect(stopped?.args?.sessionId).toBe(terminalKey(id, 'start'))
  })

  /** 界面比实际慢一拍、kind 对不上时不能报错，退回「在跑的任意一条」 */
  it('kind 没给或对不上时退回最先起的那条', async () => {
    const id = 'p-fallback'
    await runTwo(id)
    calls.length = 0

    expect((await session.stopOwner(id, 'install')).ok).toBe(true)

    const stopped = calls.find((item) => item.command === 'stop_session')
    expect(stopped?.args?.sessionId).toBe(terminalKey(id, 'start'))
  })

  it('一条都没跑时给的是那句提示，不去调后端', async () => {
    calls.length = 0

    const result = await session.stopOwner('p-none', 'build')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('该项目当前没有在运行的命令')
    expect(calls.some((item) => item.command === 'stop_session')).toBe(false)
  })
})
