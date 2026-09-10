import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../shared/types'
import { ProcessManager } from './process-manager'

/**
 * 终端划分的集成测试：真的起子进程，验证「一个项目的一类操作一个终端」。
 *
 * 这里跑的是 `npm run <script>`，所以每次 spawn 都要等 npm 起来，用例超时给得比较宽。
 */

const tempDirs: string[] = []
const managers: ProcessManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.shutdown(3000)
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeProject(devLine: string): Project {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-term-'))
  tempDirs.push(dir)

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'demo',
        version: '1.0.0',
        scripts: {
          dev: 'node dev.js',
          build: 'node build.js'
        }
      },
      null,
      2
    )
  )
  writeFileSync(join(dir, 'dev.js'), `console.log(${JSON.stringify(devLine)})\n`)
  writeFileSync(join(dir, 'build.js'), "console.log('built')\n")

  return {
    id: 'project-1',
    name: 'demo',
    path: dir,
    packageManager: 'npm',
    detectedPackageManager: 'npm',
    framework: 'Node',
    version: '1.0.0',
    scripts: { serve: 'dev', build: ['build'], defaultBuild: 'build' },
    outputDir: '',
    autoOpenExplorer: false,
    order: 0,
    createdAt: Date.now()
  } as Project
}

interface Recorded {
  terminalOpens: Array<{ terminal: string; kind: string; label: string }>
  clears: string[]
  logs: Array<{ terminal: string; text: string }>
  statuses: Array<{ terminal: string; status: string; port?: number }>
}

function watch(manager: ProcessManager): Recorded {
  const seen: Recorded = { terminalOpens: [], clears: [], logs: [], statuses: [] }
  manager.on('terminal-open', (e: { terminal: string; kind: string; label: string }) =>
    seen.terminalOpens.push({ terminal: e.terminal, kind: e.kind, label: e.label })
  )
  manager.on('clear', (e: { terminal: string }) => seen.clears.push(e.terminal))
  manager.on('log', (e: { terminal: string; text: string }) =>
    seen.logs.push({ terminal: e.terminal, text: e.text })
  )
  manager.on('status', (e: { terminal: string; status: string; port?: number }) =>
    seen.statuses.push({ terminal: e.terminal, status: e.status, port: e.port })
  )
  return seen
}

function waitFor(predicate: () => boolean, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('等待条件超时'))
        return
      }
      setTimeout(tick, 80)
    }
    tick()
  })
}

describe('ProcessManager 的终端划分', () => {
  it(
    '启动与打包落在两个不同的终端上，日志与清空互不影响',
    async () => {
      const project = makeProject('Local: http://localhost:5199/')
      const manager = new ProcessManager()
      managers.push(manager)
      const seen = watch(manager)

      // 先跑一次打包
      expect(manager.build(project, 'build')).toBeNull()
      await waitFor(() => seen.statuses.some((s) => s.status === 'success'))

      // 再启动
      expect(manager.start(project, 'dev')).toBeNull()
      await waitFor(() => seen.statuses.some((s) => s.status === 'running' && s.port === 5199))

      const startTerminal = `${project.id}::start`
      const buildTerminal = `${project.id}::build`

      expect(seen.terminalOpens.map((e) => e.terminal)).toEqual([buildTerminal, startTerminal])
      expect(seen.terminalOpens.map((e) => e.kind)).toEqual(['build', 'start'])
      expect(seen.terminalOpens.map((e) => e.label)).toEqual(['打包', '启动'])

      // 清空只针对本次要跑的那个终端，不能把另一个终端的输出也抹掉
      expect(seen.clears).toEqual([buildTerminal, startTerminal])

      // 两个终端的日志各自带着自己的键
      expect(seen.logs.some((l) => l.terminal === buildTerminal && l.text.includes('built'))).toBe(
        true
      )
      expect(
        seen.logs.some((l) => l.terminal === startTerminal && l.text.includes('localhost:5199'))
      ).toBe(true)

      // 状态事件必须带终端键，否则渲染层不知道该更新哪个 Tab
      expect(seen.statuses.every((s) => s.terminal === buildTerminal || s.terminal === startTerminal)).toBe(
        true
      )

      manager.stop(project.id)
      await waitFor(() => !manager.isActive(project.id))
    },
    60000
  )

  it(
    '同一条自定义命令每次运行都落在同一个终端上',
    async () => {
      const project = makeProject('hello')
      const manager = new ProcessManager()
      managers.push(manager)
      const seen = watch(manager)

      expect(manager.runCustom(project, 'node dev.js', 2, '类型检查')).toBeNull()
      await waitFor(() => seen.statuses.some((s) => s.status === 'idle'))

      const customTerminal = `${project.id}::custom:2`
      expect(seen.terminalOpens[0]).toEqual({
        terminal: customTerminal,
        kind: 'custom',
        label: '类型检查'
      })
    },
    60000
  )

  it(
    '清空前会先排空待发日志，上一轮的输出不会落到新一轮的终端里',
    async () => {
      const project = makeProject('hello')
      const sequence: string[] = []

      // 模拟 LogBatcher：日志先攒着，直到 flush 才真正发出
      const pending: string[] = []
      const manager = new ProcessManager(() => {
        for (const text of pending.splice(0, pending.length)) sequence.push(`log:${text}`)
      })
      managers.push(manager)

      manager.on('clear', () => sequence.push('clear'))

      // 上一轮的最后几行还没到聚合窗口 —— 这正是「改按帧聚合」引入的时序窗口
      pending.push('上一轮的最后一行')

      expect(manager.build(project, 'build')).toBeNull()

      // 若无条件先 clear，这里会是 ['clear', 'log:上一轮的最后一行']，
      // 那行旧日志就落到了新一轮的终端里
      expect(sequence).toEqual(['log:上一轮的最后一行', 'clear'])

      await waitFor(() => !manager.isActive(project.id))
    },
    60000
  )
})
