import type { GitCommit, GitWorkLogInput } from './git-import'
import type { WorkLogEntry } from './work-log'
import { describe, expect, it } from 'vitest'
import { appendGitContent, buildGitDrafts, mergeGitCommits, parseGitCommitLog } from './git-import'

/** 2026-09-15 是周二，本周 = 09-14（周一）~ 09-20（周日） */
const NOW = new Date(2026, 8, 15, 10, 30).getTime()

function commit(
  hash: string,
  time: number,
  subject: string,
  authorEmail = 'me@test',
): GitCommit {
  return { hash, time, subject, authorEmail }
}

function project(id: string, name = id): GitWorkLogInput['project'] {
  return { id, name, path: `E:\work\${id}` }
}

function log(commits: GitCommit[], userEmail = 'me@test'): GitWorkLogInput['log'] {
  return { isRepo: true, userEmail, commits }
}

function entry(
  date: string,
  id: string,
  projectId: string | undefined,
  options: { content?: string, updatedAt?: number, source?: WorkLogEntry['source'] } = {},
): WorkLogEntry {
  const createdAt = new Date(`${date}T09:00:00`).getTime()
  return {
    id,
    date,
    content: options.content ?? '手写的内容',
    status: 'done',
    createdAt,
    updatedAt: options.updatedAt ?? createdAt,
    ...(projectId ? { projectId } : {}),
    ...(options.source ? { source: options.source } : {}),
  }
}

describe('buildGitDrafts', () => {
  it('一个项目一天一条：组内按时间从早到晚，只列提交标题', () => {
    const drafts = buildGitDrafts(
      [{
        project: project('p1', '项目甲'),
        log: log([
          commit('bbb2222', new Date(2026, 8, 15, 14, 0).getTime(), '下午的改动'),
          commit('aaa1111', new Date(2026, 8, 15, 9, 0).getTime(), '上午的改动'),
        ]),
      }],
      'today',
      NOW,
      [],
    )

    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      projectId: 'p1',
      projectName: '项目甲',
      date: '2026-09-15',
      content: '- 上午的改动\n- 下午的改动',
      commits: ['aaa1111', 'bbb2222'],
    })
    expect(drafts[0].appendTo).toBeUndefined()
  })

  it('范围外的提交不收；不同天分条', () => {
    const drafts = buildGitDrafts(
      [{
        project: project('p1'),
        log: log([
          commit('aaa1111', new Date(2026, 8, 14, 20, 0).getTime(), '昨天'),
          commit('bbb2222', new Date(2026, 8, 15, 9, 0).getTime(), '今天'),
          commit('ccc3333', new Date(2026, 8, 10, 9, 0).getTime(), '上周'),
        ]),
      }],
      'week',
      NOW,
      [],
    )

    expect(drafts.map(draft => [draft.date, draft.content])).toEqual([
      ['2026-09-15', '- 今天'],
      ['2026-09-14', '- 昨天'],
    ])
  })

  it('仓库有 user.email 时只收自己的提交；读不到身份时全收', () => {
    const commits = [
      commit('aaa1111', new Date(2026, 8, 15, 9, 0).getTime(), '我的', 'me@test'),
      commit('bbb2222', new Date(2026, 8, 15, 10, 0).getTime(), '别人的', 'other@test'),
    ]

    const mine = buildGitDrafts(
      [{ project: project('p1'), log: log(commits, 'ME@test') }],
      'today',
      NOW,
      [],
    )
    expect(mine[0].content).toBe('- 我的')

    const all = buildGitDrafts(
      [{ project: project('p1'), log: log(commits, '') }],
      'today',
      NOW,
      [],
    )
    expect(all[0].content).toBe('- 我的\n- 别人的')
  })

  it('已导入过的哈希不再生成；同项目同日的生成记录变成追加目标', () => {
    const existing = entry('2026-09-15', 'e1', 'p1', {
      content: '- 上午的改动',
      updatedAt: 100,
      source: { kind: 'git', commits: ['aaa1111'] },
    })

    const drafts = buildGitDrafts(
      [{
        project: project('p1'),
        log: log([
          commit('aaa1111', new Date(2026, 8, 15, 9, 0).getTime(), '上午的改动'),
          commit('bbb2222', new Date(2026, 8, 15, 14, 0).getTime(), '下午的改动'),
        ]),
      }],
      'today',
      NOW,
      [existing],
    )

    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      content: '- 下午的改动',
      commits: ['bbb2222'],
      appendTo: 'e1',
    })
  })

  it('手写的记录不是追加目标；同项目同日有多条生成记录时认最近改过的那条', () => {
    const handwritten = entry('2026-09-15', 'hand', 'p1', { content: '手写' })
    const older = entry('2026-09-15', 'old', 'p1', {
      updatedAt: 100,
      source: { kind: 'git', commits: ['aaa1111'] },
    })
    const newer = entry('2026-09-15', 'new', 'p1', {
      updatedAt: 200,
      source: { kind: 'git', commits: ['aaa1111'] },
    })

    const drafts = buildGitDrafts(
      [{
        project: project('p1'),
        log: log([commit('bbb2222', new Date(2026, 8, 15, 9, 0).getTime(), '新提交')]),
      }],
      'today',
      NOW,
      [handwritten, older, newer],
    )

    expect(drafts[0].appendTo).toBe('new')
  })

  it('去重按项目分：同一个仓库被两个项目指向时各生成各的', () => {
    const shared = commit('aaa1111', new Date(2026, 8, 15, 9, 0).getTime(), '共用提交')
    const drafts = buildGitDrafts(
      [
        { project: project('p1'), log: log([shared]) },
        { project: project('p2'), log: log([shared]) },
      ],
      'today',
      NOW,
      [],
    )

    expect(drafts.map(draft => draft.projectId)).toEqual(['p1', 'p2'])
  })

  it('不是仓库 / 没有提交时不生成草稿', () => {
    const drafts = buildGitDrafts(
      [
        { project: project('p1'), log: { isRepo: false, userEmail: '', commits: [] } },
        { project: project('p2'), log: log([]) },
      ],
      'today',
      NOW,
      [],
    )
    expect(drafts).toEqual([])
  })
})

describe('parseGitCommitLog', () => {
  it('坏数据退化成空表，好条目留下', () => {
    const parsed = parseGitCommitLog({
      isRepo: true,
      userEmail: ' me@test ',
      commits: [
        { hash: 'AAA1111', time: 1_000, authorEmail: 'me@test', subject: '好' },
        { hash: '', time: 1_000, subject: '没哈希' },
        { hash: 'bbb2222', time: 0, subject: '没时间' },
        { hash: 'ccc3333', time: 1_000, subject: '   ' },
        'nope',
      ],
    })

    expect(parsed).toEqual({
      isRepo: true,
      userEmail: 'me@test',
      commits: [{ hash: 'aaa1111', time: 1_000, authorEmail: 'me@test', subject: '好' }],
    })
  })

  it('isRepo 只认 true，其余一律当「不是仓库」', () => {
    expect(parseGitCommitLog(null).isRepo).toBe(false)
    expect(parseGitCommitLog({ isRepo: 'yes' }).isRepo).toBe(false)
  })
})

describe('appendGitContent / mergeGitCommits', () => {
  it('正文之间空一行，两头不留多余空行', () => {
    expect(appendGitContent('- 上午', '- 下午')).toBe('- 上午\n\n- 下午')
    expect(appendGitContent('- 上午\n\n', '- 下午')).toBe('- 上午\n\n- 下午')
    expect(appendGitContent('', '- 下午')).toBe('- 下午')
    expect(appendGitContent('- 上午', '   ')).toBe('- 上午')
  })

  it('哈希并集去重，老哈希保持在前', () => {
    expect(mergeGitCommits(['aaa1111', 'bbb2222'], ['bbb2222', 'ccc3333']))
      .toEqual(['aaa1111', 'bbb2222', 'ccc3333'])
    expect(mergeGitCommits(undefined, ['aaa1111'])).toEqual(['aaa1111'])
  })
})
