import { describe, expect, it } from 'vitest'
import {
  DELETED_PROJECT_ID,
  WORK_PAGE_DAYS,
  completedEntriesOn,
  createWorkLogEntry,
  dayMeta,
  emptyWorkLog,
  groupByProject,
  paginate,
  parseWorkLog,
  patchWorkLogEntry,
  rangeBounds,
  sanitizeWorkLogStatus,
  timelineOf,
  toggleWorkLogStatus,
  type WorkLogEntry,
  type WorkLogStatus
} from './work-log'

/** 2026-09-15 是周二，本周 = 09-14（周一）~ 09-20（周日） */
const NOW = new Date(2026, 8, 15, 10, 30).getTime()

let counter = 0
const uuid = (): string => `id-${(counter += 1)}`

function entry(
  date: string,
  createdAt: number,
  content = '内容',
  projectId?: string,
  status: WorkLogStatus = 'done'
): WorkLogEntry {
  return {
    id: `e-${date}-${createdAt}`,
    date,
    content,
    status,
    createdAt,
    updatedAt: createdAt,
    ...(projectId ? { projectId } : {})
  }
}

describe('parseWorkLog', () => {
  it('空文件退化成空日志', () => {
    expect(parseWorkLog(null, uuid, NOW)).toEqual(emptyWorkLog())
    expect(parseWorkLog({ entries: 'nope' }, uuid, NOW).entries).toEqual([])
  })

  it('内容为空的条目丢掉，必填项不会落成空记录', () => {
    const file = parseWorkLog({ entries: [{ date: '2026-09-15', content: '   ' }] }, uuid, NOW)
    expect(file.entries).toEqual([])
  })

  it('缺 id 的条目补一个，重复 id 只留第一条', () => {
    const file = parseWorkLog(
      {
        entries: [
          { date: '2026-09-15', content: '甲' },
          { id: 'same', date: '2026-09-15', content: '乙' },
          { id: 'same', date: '2026-09-15', content: '丙' }
        ]
      },
      uuid,
      NOW
    )
    expect(file.entries.map((item) => [item.id, item.content])).toEqual([
      ['id-1', '甲'],
      ['same', '乙']
    ])
  })

  it('日期写坏时回落到创建时间那一天，而不是丢掉整条', () => {
    const createdAt = new Date(2026, 8, 10, 9, 0).getTime()
    const file = parseWorkLog({ entries: [{ content: '甲', createdAt, date: '昨天' }] }, uuid, NOW)
    expect(file.entries[0].date).toBe('2026-09-10')
  })

  it('时间戳缺失时按当前时间收敛，必填字段补全', () => {
    const file = parseWorkLog({ entries: [{ date: '2026-09-15', content: ' 甲 ' }] }, uuid, NOW)
    expect(file.entries[0]).toMatchObject({
      content: '甲',
      createdAt: NOW,
      updatedAt: NOW,
      date: '2026-09-15'
    })
  })

  it('项目 id 为空串时不留下这个字段', () => {
    const file = parseWorkLog(
      { entries: [{ date: '2026-09-15', content: '甲', projectId: '  ' }] },
      uuid,
      NOW
    )
    expect('projectId' in file.entries[0]).toBe(false)
  })
})

describe('rangeBounds', () => {
  it('今天 / 昨天各自只有一天', () => {
    expect(rangeBounds('today', NOW)).toEqual({ from: '2026-09-15', to: '2026-09-15' })
    expect(rangeBounds('yesterday', NOW)).toEqual({ from: '2026-09-14', to: '2026-09-14' })
  })

  it('本周从周一起算、到周日止', () => {
    expect(rangeBounds('week', NOW)).toEqual({ from: '2026-09-14', to: '2026-09-20' })
  })

  it('周日属于本周的第一天之后 —— 上一周的周一才是本周起点', () => {
    const sunday = new Date(2026, 2, 1, 12, 0).getTime()
    expect(rangeBounds('week', sunday)).toEqual({ from: '2026-02-23', to: '2026-03-01' })
  })

  it('本月按自然月给满，闰年二月是 29 天', () => {
    expect(rangeBounds('month', NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    const leap = new Date(2024, 1, 10, 12, 0).getTime()
    expect(rangeBounds('month', leap)).toEqual({ from: '2024-02-01', to: '2024-02-29' })
  })
})

describe('timelineOf', () => {
  const entries = [
    entry('2026-09-15', NOW - 60_000, '今天的后一条'),
    entry('2026-09-15', NOW - 120_000, '今天的前一条'),
    entry('2026-09-14', NOW - 86_400_000, '昨天'),
    entry('2026-08-31', NOW - 1_000_000_000, '上个月')
  ]

  it('只留范围内的记录，按天分组', () => {
    const days = timelineOf(entries, 'week', NOW)
    expect(days.map((group) => group.day)).toEqual(['2026-09-15', '2026-09-14'])
    expect(days[0].entries.map((item) => item.content)).toEqual(['今天的后一条', '今天的前一条'])
  })

  it('范围外的一天整体不出现（没有记录的日子也不占一栏）', () => {
    expect(timelineOf(entries, 'today', NOW).map((group) => group.day)).toEqual(['2026-09-15'])
    expect(timelineOf(entries, 'month', NOW).map((group) => group.day)).toEqual([
      '2026-09-15',
      '2026-09-14'
    ])
  })

  it('没有记录时是空时间轴', () => {
    expect(timelineOf([], 'month', NOW)).toEqual([])
  })
})

describe('completedEntriesOn', () => {
  const entries = [
    entry('2026-09-15', NOW - 60_000, '今天后一条'),
    entry('2026-09-15', NOW - 120_000, '今天前一条'),
    entry('2026-09-15', NOW - 180_000, '今天还欠着的', undefined, 'todo'),
    entry('2026-09-14', NOW - 86_400_000, '昨天做完的')
  ]

  it('只留那一天里已完成的记录，新的在前', () => {
    expect(completedEntriesOn(entries, '2026-09-15').map((item) => item.content)).toEqual([
      '今天后一条',
      '今天前一条'
    ])
  })

  it('待办不算做完，别的日子也不算', () => {
    expect(completedEntriesOn(entries, '2026-09-13')).toEqual([])
    expect(completedEntriesOn([], '2026-09-15')).toEqual([])
  })

  it('不改动传入的数组', () => {
    completedEntriesOn(entries, '2026-09-15')
    expect(entries.map((item) => item.content)).toEqual([
      '今天后一条',
      '今天前一条',
      '今天还欠着的',
      '昨天做完的'
    ])
  })
})

describe('groupByProject', () => {
  // 名字用 ASCII：栏序是「名字序」，而跨语言的名字怎么排是运行时的排序规则说了算
  // （Node 与 WebView 可能不同），测试只钉住规则本身，不钉某个语言环境对汉字与拉丁字母的偏好
  const projects = [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
    { id: 'p3', name: 'Gamma' }
  ]
  const entries = [
    entry('2026-09-15', NOW - 60_000, '今天的后一条', 'p2'),
    entry('2026-09-15', NOW - 120_000, '今天的前一条', 'p1'),
    entry('2026-09-14', NOW - 86_400_000, '昨天的', 'p2'),
    entry('2026-09-13', NOW - 200_000_000, '没关联的'),
    entry('2026-09-12', NOW - 300_000_000, '项目没了的', 'gone'),
    entry('2026-08-31', NOW - 1_000_000_000, '上个月', 'p1')
  ]

  it('一个项目一栏，栏内从新到旧', () => {
    const groups = groupByProject(entries, 'month', NOW, projects)
    expect(groups[0].projectId).toBe('p1')
    expect(groups[0].entries.map((item) => item.content)).toEqual(['今天的前一条'])
    expect(groups[1].projectId).toBe('p2')
    expect(groups[1].entries.map((item) => item.content)).toEqual(['今天的后一条', '昨天的'])
  })

  it('范围外的记录不出现', () => {
    const groups = groupByProject(entries, 'today', NOW, projects)
    expect(groups.map((group) => group.projectId)).toEqual(['p1', 'p2'])
    expect(groups.flatMap((group) => group.entries)).toHaveLength(2)

    // 本周（09-14 起）里没有 09-13 之后那两条，所以只有两个项目栏
    expect(groupByProject(entries, 'week', NOW, projects).map((group) => group.projectId)).toEqual([
      'p1',
      'p2'
    ])
  })

  it('已删除的项目合并成一栏，未关联单独一栏，都排在已知项目之后', () => {
    const groups = groupByProject(entries, 'month', NOW, projects)
    expect(groups.map((group) => group.projectId)).toEqual([
      'p1',
      'p2',
      null,
      DELETED_PROJECT_ID
    ])
    expect(groups[2].entries[0].content).toBe('没关联的')
    expect(groups[3].entries[0].content).toBe('项目没了的')
  })

  it('项目栏按名字排，与传入顺序无关', () => {
    const shuffled = [projects[2], projects[0], projects[1]]
    expect(
      groupByProject(entries, 'month', NOW, shuffled).map((group) => group.projectId)
    ).toEqual(['p1', 'p2', null, DELETED_PROJECT_ID])
  })

  it('没有记录时是空列表', () => {
    expect(groupByProject([], 'month', NOW, projects)).toEqual([])
  })
})

describe('paginate', () => {
  const days = Array.from({ length: 10 }, (_item, index) => index + 1)

  it('按页大小切分', () => {
    expect(paginate(days, 2, WORK_PAGE_DAYS)).toEqual({
      items: [8, 9, 10],
      page: 2,
      pages: 2
    })
  })

  it('页码越界时夹回有效范围（换了范围之后页数会变少）', () => {
    expect(paginate(days, 9, 4).page).toBe(3)
    expect(paginate(days, 0, 4).page).toBe(1)
  })

  it('空列表是「第 1 页，共 1 页」', () => {
    expect(paginate([], 3, 5)).toEqual({ items: [], page: 1, pages: 1 })
  })
})

describe('createWorkLogEntry', () => {
  it('内容必填，空白内容建不出来', () => {
    expect(createWorkLogEntry({ date: '2026-09-15', content: '  ' }, uuid, NOW)).toBeNull()
  })

  it('日期非法时按今天落，项目为空则不带该字段', () => {
    const created = createWorkLogEntry({ date: '不是日期', content: '甲', projectId: '' }, uuid, NOW)
    expect(created).toMatchObject({ date: '2026-09-15', content: '甲', createdAt: NOW })
    expect(created && 'projectId' in created).toBe(false)
  })

  it('不传状态就是「已完成」，显式传待办则尊重它', () => {
    expect(createWorkLogEntry({ date: '2026-09-15', content: '甲' }, uuid, NOW)?.status).toBe('done')
    expect(
      createWorkLogEntry({ date: '2026-09-15', content: '甲', status: 'todo' }, uuid, NOW)?.status
    ).toBe('todo')
  })

  it('状态传了认不出来的值也按已完成落盘', () => {
    const created = createWorkLogEntry(
      { date: '2026-09-15', content: '甲', status: 'doing' as never },
      uuid,
      NOW
    )
    expect(created?.status).toBe('done')
  })
})

describe('状态', () => {
  it('两档之间来回切', () => {
    expect(toggleWorkLogStatus('done')).toBe('todo')
    expect(toggleWorkLogStatus('todo')).toBe('done')
  })

  it('认不出来的取值按「已完成」处理', () => {
    expect(sanitizeWorkLogStatus('doing')).toBe('done')
    expect(sanitizeWorkLogStatus(undefined)).toBe('done')
    expect(sanitizeWorkLogStatus('todo')).toBe('todo')
  })

  it('老数据文件里没有这个字段时，读出来是「已完成」', () => {
    const file = parseWorkLog({ entries: [{ date: '2026-09-15', content: '甲' }] }, uuid, NOW)
    expect(file.entries[0].status).toBe('done')
  })

  it('切状态算一次真实改动：刷新 updatedAt', () => {
    const base = entry('2026-09-15', NOW - 1000, '甲', undefined, 'done')
    const next = patchWorkLogEntry(base, { status: 'todo' }, NOW)
    expect(next.status).toBe('todo')
    expect(next.updatedAt).toBe(NOW)

    // 状态没变、别的也没变，不算改动
    expect(patchWorkLogEntry(base, { status: 'done' }, NOW)).toBe(base)
  })
})

describe('patchWorkLogEntry', () => {
  const base = entry('2026-09-15', NOW - 1000, '原内容')

  it('内容真的变了才刷新 updatedAt', () => {
    const same = patchWorkLogEntry(base, { content: '原内容' }, NOW)
    expect(same).toBe(base)

    const changed = patchWorkLogEntry(base, { content: '新内容' }, NOW)
    expect(changed.updatedAt).toBe(NOW)
    expect(changed.createdAt).toBe(base.createdAt)
  })

  it('显式传 null 表示清掉所属项目', () => {
    const withProject = { ...base, projectId: 'p1' }
    expect('projectId' in patchWorkLogEntry(withProject, { projectId: null }, NOW)).toBe(false)
  })

  it('内容被清空时保持原值，不写一条空记录', () => {
    expect(patchWorkLogEntry(base, { content: '   ' }, NOW)).toBe(base)
  })

  it('日期非法时保持原日期', () => {
    expect(patchWorkLogEntry(base, { date: '后天' }, NOW).date).toBe('2026-09-15')
  })
})

describe('dayMeta', () => {
  it('给出日期、星期与相对今天的说法', () => {
    expect(dayMeta('2026-09-15', NOW)).toEqual({ title: '9月15日', weekday: '周二', relative: '今天' })
    expect(dayMeta('2026-09-14', NOW).relative).toBe('昨天')
    expect(dayMeta('2026-09-13', NOW).relative).toBe('前天')
    expect(dayMeta('2026-09-01', NOW).relative).toBe('')
  })
})
