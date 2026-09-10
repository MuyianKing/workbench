import { describe, expect, it } from 'vitest'
import { matchesSession, reapOrphanSessions } from './orphan'

describe('matchesSession', () => {
  it('命令行里出现项目目录即认定为同一条会话', () => {
    // 命令原文已经变了（npm 把真实命令转给了子进程），但工作目录还在命令行里
    expect(
      matchesSession(
        { command: 'vite --port 5173', cwd: 'D:\\proj\\admin-web' },
        '"C:\\WINDOWS\\system32\\cmd.exe" /d /s /c "npm run dev" --prefix D:\\proj\\admin-web'
      )
    ).toBe(true)
  })

  it('斜杠方向与大小写不影响判断', () => {
    expect(
      matchesSession(
        { command: 'pnpm run serve', cwd: 'D:\\Proj\\Mall' },
        'cmd.exe /c "node" "d:/proj/mall/node_modules/vite/bin/vite.js"'
      )
    ).toBe(true)
  })

  it('记录的命令原文本身也能作为依据', () => {
    expect(
      matchesSession({ command: 'vite build --mode test', cwd: '' }, 'cmd /c vite build --mode test')
    ).toBe(true)
  })

  it('命令行对不上时拒绝（PID 被复用的情况）', () => {
    expect(
      matchesSession(
        { command: 'npm run dev', cwd: 'D:\\proj\\admin-web' },
        '"C:\\Program Files\\Other\\thing.exe"'
      )
    ).toBe(false)
  })

  it('拿不到命令行时一律不认', () => {
    expect(matchesSession({ command: 'npm run dev', cwd: 'D:\\p' }, '')).toBe(false)
    expect(matchesSession({ command: 'npm run dev', cwd: 'D:\\p' }, null)).toBe(false)
    expect(matchesSession({ command: 'npm run dev', cwd: 'D:\\p' }, undefined)).toBe(false)
  })

  it('过短的命令原文不作为依据，避免误命中', () => {
    expect(matchesSession({ command: 'up', cwd: '' }, 'something up here')).toBe(false)
  })
})

describe('reapOrphanSessions', () => {
  it('没有记录时什么都不做', async () => {
    const result = await reapOrphanSessions([])
    expect(result).toEqual({ killed: 0, kept: [], notes: [] })
  })

  it('记录为脏数据时不抛错', async () => {
    const result = await reapOrphanSessions([null as never, undefined as never])
    expect(result.killed).toBe(0)
  })
})
