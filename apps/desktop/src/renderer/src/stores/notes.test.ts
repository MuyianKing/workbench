/**
 * 笔记 store：正文落盘的「版本基准」与别处改动的探测。
 *
 * 这一层最容易出的事是**静默盖掉别处刚写的内容**：编辑器每 600ms 整篇写一次，
 * 不带基准就是后写者覆盖。这里的四条用例把口径钉死：
 *   - 打开后写盘带的是读盘时拿到的 mtime，写完换成新文件的 mtime；
 *   - 被拒绝的那一笔不动本地正文（否则界面上就"保存成功"了）；
 *   - 重读只在内容真变了时换正文，并顺手把基准跟上；
 *   - 探测只回答「变没变」，不改任何状态。
 *
 * 跑在 node 环境里：`window.workbench` 用 Proxy 兜底（与 kb.test.ts 同一套），
 * `@/notify` 换成假的（底下是 Element Plus）。
 */
import type { NoteNode } from '@workbench/notes'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/notify', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
}))

interface FakeFile {
  text: string
  mtimeMs: number
}

const files = new Map<string, FakeFile>()
let writeCalls: Array<{ rel: string, content: string, expected?: number }> = []
let failWrite: string | null = null
let nextMtime = 1000

function node(rel: string, mtimeMs: number): NoteNode {
  return { id: rel, rel, name: rel.split('/').pop() ?? rel, kind: 'note', children: [], mtimeMs }
}

function fakeWorkbench(): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'getBootstrap')
        return () => null
      if (key === 'listNotes')
        return async () => ({ ok: true, data: [...files.keys()].map(rel => node(rel, files.get(rel)?.mtimeMs ?? 0)) })
      if (key === 'readNote') {
        return async (_root: string, rel: string) => {
          const file = files.get(rel)
          return file
            ? { ok: true, data: { text: file.text, mtimeMs: file.mtimeMs } }
            : { ok: false, error: '读取失败' }
        }
      }
      if (key === 'writeNote') {
        return async (_root: string, rel: string, content: string, expectedMtimeMs?: number) => {
          writeCalls.push({ rel, content, expected: expectedMtimeMs })
          if (failWrite)
            return { ok: false, error: failWrite }
          const mtimeMs = (nextMtime += 1)
          files.set(rel, { text: content, mtimeMs })
          return { ok: true, data: mtimeMs }
        }
      }
      if (key === 'noteRepoState')
        return async () => ({ ok: true, data: { isRepo: false, origin: '', branch: '' } })
      return () => Promise.resolve({ ok: true, data: {} })
    },
  })
}

beforeEach(() => {
  files.clear()
  writeCalls = []
  failWrite = null
  nextMtime = 1000
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false }),
    workbench: fakeWorkbench(),
  }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: {
      dataset: {},
      classList: { toggle: () => {} },
      style: { setProperty: () => {}, removeProperty: () => {} },
    },
  }
  setActivePinia(createPinia())
})

// 桩必须在 import 之前就位，所以这里用动态导入
const { useNotesStore } = await import('./notes')
const { useSettingsStore } = await import('./settings')

/** 打开 / 探测都是 async 的，等一轮宏任务让假通道落地 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

async function openNote(text: string, mtimeMs: number) {
  files.set('周报.md', { text, mtimeMs })
  const settings = useSettingsStore()
  settings.settings.noteDir = 'F:/notes'
  const store = useNotesStore()
  await store.init()
  store.select('周报.md')
  await settle()
  return store
}

describe('笔记正文的写盘基准', () => {
  it('写盘带上读盘时的 mtime，写完把基准换成新文件的 mtime', async () => {
    const store = await openNote('# 一稿', 111)
    expect(store.active?.content).toBe('# 一稿')

    await store.saveContent('周报.md', '# 二稿')

    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]?.expected).toBe(111)
    expect(store.saveError).toBe('')
    expect(store.active?.content).toBe('# 二稿')
    // savedAt 与 active.mtimeMs 用的是文件自己的 mtime，不是本地时钟
    expect(store.active?.mtimeMs).toBe(1001)
    expect(store.savedAt).toBe(1001)

    // 第二笔带的是新基准：不会拿打开时那份旧的去比
    await store.saveContent('周报.md', '# 三稿')
    expect(writeCalls[1]?.expected).toBe(1001)
  })

  it('被拒绝时不改本地正文，也不改基准', async () => {
    const store = await openNote('# 一稿', 111)
    failWrite = '这一篇在别处被改过了，这次没有保存'

    await store.saveContent('周报.md', '# 我这边')

    expect(store.saveError).toContain('别处被改过')
    expect(store.active?.content).toBe('# 一稿')
    expect(store.active?.mtimeMs).toBe(111)

    // 下一笔照样带旧基准：在用户处理之前，不会悄悄放行覆盖
    failWrite = null
    await store.saveContent('周报.md', '# 我这边')
    expect(writeCalls[1]?.expected).toBe(111)
  })

  it('重读：内容变了才换正文，内容一样时只把基准跟上', async () => {
    const store = await openNote('# 一稿', 111)

    files.set('周报.md', { text: '# 别处改的', mtimeMs: 222 })
    expect(await store.rereadActive()).toBe(true)
    expect(store.active?.content).toBe('# 别处改的')
    expect(store.active?.mtimeMs).toBe(222)

    // 同一份内容再读一次：不动 active（免得白用掉编辑器的撤销栈）
    expect(await store.rereadActive()).toBe(false)
  })

  it('探测只回答变没变，不改状态', async () => {
    const store = await openNote('# 一稿', 111)

    files.set('周报.md', { text: '# 别处改的', mtimeMs: 222 })
    expect(await store.activeChangedOnDisk()).toBe(true)
    // 状态还是原来的：界面据此决定要不要问用户
    expect(store.active?.content).toBe('# 一稿')
    expect(store.active?.mtimeMs).toBe(111)

    files.set('周报.md', { text: '# 一稿', mtimeMs: 333 })
    expect(await store.activeChangedOnDisk()).toBe(false)
  })
})
