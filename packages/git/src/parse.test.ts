import { describe, expect, it } from 'vitest'
import {
  isCommitHash,
  parseCommitDetail,
  parseCommitPage,
  parseCompare,
  parseGitPatch,
  parseRepoInfo,
  parseTreePage,
  shortHash,
  statusLabel,
} from './parse'

const HASH = '0123456789abcdef0123456789abcdef01234567'
const OTHER = '89abcdef0123456789abcdef0123456789abcdef'

describe('isCommitHash / shortHash', () => {
  it('只认 7~64 位十六进制', () => {
    expect(isCommitHash('0123456')).toBe(true)
    expect(isCommitHash(HASH)).toBe(true)
    expect(isCommitHash('012345')).toBe(false)
    expect(isCommitHash('--all')).toBe(false)
    expect(isCommitHash('xyz1234')).toBe(false)
    expect(isCommitHash(null)).toBe(false)
  })

  it('短号取前 7 位', () => {
    expect(shortHash(HASH)).toBe('0123456')
    expect(shortHash(HASH, 10)).toBe('0123456789')
  })
})

describe('parseRepoInfo', () => {
  it('缺 root 视为打不开', () => {
    expect(parseRepoInfo({})).toBeNull()
    expect(parseRepoInfo(null)).toBeNull()
  })

  it('名字缺失时用根目录末段', () => {
    const info = parseRepoInfo({ root: 'E:/work/demo', head: HASH.toUpperCase() })
    expect(info).toEqual({
      root: 'E:/work/demo',
      name: 'demo',
      head: HASH,
      shortHead: '',
      branch: '',
      detached: false,
      empty: false,
    })
  })
})

describe('parseCommitPage', () => {
  it('丢掉没有哈希或时间不合法的条目', () => {
    const page = parseCommitPage({
      hasMore: true,
      commits: [
        { hash: HASH, time: 1700000000000, author: 'muyian', subject: '第一条' },
        { hash: 'not-a-hash', time: 1700000000000, subject: '坏的' },
        { hash: OTHER, time: 0, subject: '没有时间' },
      ],
    })

    expect(page.hasMore).toBe(true)
    expect(page.commits).toHaveLength(1)
    expect(page.commits[0].hash).toBe(HASH)
    expect(page.commits[0].author).toBe('muyian')
  })

  it('父提交只留合法哈希，标题为空也保留（空提交说明是合法的）', () => {
    const page = parseCommitPage({
      commits: [
        { hash: HASH, time: 1, parents: [OTHER, 'bad'], subject: '' },
      ],
    })
    expect(page.commits).toHaveLength(1)
    expect(page.commits[0].parents).toEqual([OTHER])
    expect(page.commits[0].subject).toBe('')
  })
})

describe('parseTreePage', () => {
  it('未知类型按文件处理，路径缺失的条目丢掉', () => {
    const page = parseTreePage({
      truncated: true,
      entries: [
        { name: 'src', path: 'src', type: 'dir', size: 0 },
        { name: 'a.txt', path: 'src/a.txt', type: 'weird', size: 12 },
        { name: 'no-path', type: 'file' },
      ],
    })

    expect(page.truncated).toBe(true)
    expect(page.entries).toEqual([
      { name: 'src', path: 'src', type: 'dir', size: 0 },
      { name: 'a.txt', path: 'src/a.txt', type: 'file', size: 12 },
    ])
  })

  it('文件路径不裁首尾空格（Windows 允许以空格开头的文件名）', () => {
    const page = parseTreePage({
      entries: [{ name: ' spaced.txt', path: 'dir/ spaced.txt', type: 'file', size: 1 }],
    })
    expect(page.entries[0].path).toBe('dir/ spaced.txt')
    expect(page.entries[0].name).toBe(' spaced.txt')
  })
})

describe('parseCommitDetail', () => {
  it('根提交 base 为空、没有父提交', () => {
    const detail = parseCommitDetail({
      hash: HASH,
      time: 1,
      body: '第一行\n\n正文',
      files: [{ path: 'a.txt', status: 'a', added: 2, deleted: 0 }],
    })

    expect(detail?.isRoot).toBe(true)
    expect(detail?.base).toBe('')
    expect(detail?.subject).toBe('第一行')
    expect(detail?.files[0]).toMatchObject({ path: 'a.txt', status: 'A', added: 2 })
  })

  it('合并提交按第一父提交对比', () => {
    const detail = parseCommitDetail({
      hash: HASH,
      time: 1,
      parents: [OTHER, '89abcdef0123456789abcdef0123456789abcdee'],
      files: [],
    })
    expect(detail?.isMerge).toBe(true)
    expect(detail?.base).toBe(OTHER)
  })
})

describe('parseCompare / parseGitPatch / statusLabel', () => {
  it('对比两侧必须是合法提交号', () => {
    expect(parseCompare({ base: HASH, target: OTHER, files: [] })).not.toBeNull()
    expect(parseCompare({ base: '--all', target: OTHER, files: [] })).toBeNull()
  })

  it('补丁字段收敛成布尔值', () => {
    expect(parseGitPatch({ patch: 'x', binary: true, lossy: 1 })).toEqual({
      patch: 'x',
      binary: true,
      tooLarge: false,
      lossy: false,
      truncated: false,
    })
  })

  it('状态字母转中文', () => {
    expect(statusLabel('A')).toBe('新增')
    expect(statusLabel('M')).toBe('修改')
    expect(statusLabel('D')).toBe('删除')
    expect(statusLabel('?')).toBe('修改')
  })
})
