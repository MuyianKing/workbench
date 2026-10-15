import type { ZentaoBug, ZentaoBugDiff, ZentaoBugList, ZentaoSession } from './index'
import { describe, expect, it, vi } from 'vitest'
import {
  diffZentaoBugs,
  fetchZentaoBugs,
  normalizeAssignInput,
  normalizeResolveInput,
  parseZentaoBugDetail,
  parseZentaoBuilds,
  parseZentaoUsers,
  sanitizeZentaoPollMinutes,
  ZENTAO_DEFAULT_URL,
  ZENTAO_POLL_MINUTES_DEFAULT,
  zentaoBugUrl,
  zentaoDateTime,
  zentaoPriorityColor,
  zentaoResolutionLabel,
  zentaoRichText,
  zentaoSeverityColor,
  zentaoStationImagePath,
  zentaoStatusLabel,
  zentaoStepBlocks,
} from './index'

function product(id: unknown, name = `产品 ${id}`) {
  return { id, name }
}

function bug(id: unknown, overrides: Record<string, unknown> = {}) {
  return { id, title: `Bug ${id}`, status: 'active', severity: '2', pri: null, openedDate: '2026-10-15 08:30:00', ...overrides }
}

function products(rows: unknown[] = [product(1)], page = 1, total = rows.length, limit = 10) {
  return { page, total, limit, products: rows }
}

function bugs(rows: unknown[] = [bug(1)], page = 1, total = rows.length, limit = 10) {
  return { page, total, limit, bugs: rows }
}

function readWithBug(raw: unknown) {
  return (productId: number | null) => Promise.resolve(productId === null ? products() : raw)
}

describe('禅道类型契约', () => {
  it('后端会话只含管理句柄、地址和账号，列表字段可从桶导出', () => {
    const session: ZentaoSession = { id: 'managed-id', baseUrl: ZENTAO_DEFAULT_URL, account: 'user' }
    const item: ZentaoBug = { id: 1, title: '标题', productId: 2, productName: '产品', status: 'active', severity: null, pri: null, openedDate: '', assignedTo: 'me', openedBy: 'someone' }
    const list: ZentaoBugList = { bugs: [item], productCount: 1, checkedAt: '' }
    expect(session).not.toHaveProperty('password')
    expect(list.bugs[0].productId).toBe(2)
  })
})

function bugItem(id: number, title = `Bug ${id}`): ZentaoBug {
  return { id, title, productId: 1, productName: '产品', status: 'active', severity: null, pri: null, openedDate: '', assignedTo: 'me', openedBy: 'someone' }
}

describe('sanitizeZentaoPollMinutes', () => {
  it('默认周期为 30 分钟', () => {
    expect(ZENTAO_POLL_MINUTES_DEFAULT).toBe(30)
  })

  it.each([
    [0, 0],
    [0.4, 0],
    [0.5, 1],
    [1, 1],
    [2.4, 2],
    [2.5, 3],
    [30, 30],
    [-10, 1],
    [1440, 1440],
    [1940, 1440],
    [Number.MAX_VALUE, 1440],
  ])('周期 %s 收敛为 %s', (value, expected) => {
    expect(sanitizeZentaoPollMinutes(value)).toBe(expected)
  })

  it.each([undefined, null, '0', '60', '', true, false, {}, [], Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('非法值 %j 回默认周期', (value) => {
    expect(sanitizeZentaoPollMinutes(value)).toBe(ZENTAO_POLL_MINUTES_DEFAULT)
  })
})

describe('diffZentaoBugs', () => {
  it('首次只建立当前去重基线，不通知', () => {
    const result: ZentaoBugDiff = diffZentaoBugs(null, [bugItem(9), bugItem(2), bugItem(9)])
    expect(result).toEqual({ ids: [9, 2], added: [] })
    expect(diffZentaoBugs(null, [])).toEqual({ ids: [], added: [] })
  })

  it('已建立的空基线会通知全部当前 Bug，重复 ID 只保留首次记录', () => {
    const first = bugItem(2, '首次记录')
    const other = bugItem(9)
    const result = diffZentaoBugs([], [first, other, bugItem(2, '重复记录')])
    expect(result).toEqual({ ids: [2, 9], added: [first, other] })
    expect(result.added[0]).toBe(first)
  })

  it('比较完整集合，最大 ID 和条数不变时也识别旧编号重新指派', () => {
    const reassigned = bugItem(2)
    expect(diffZentaoBugs([9, 7], [bugItem(9), reassigned])).toEqual({ ids: [9, 2], added: [reassigned] })
  })

  it('只改顺序或字段不算新增，上一轮重复 ID 不影响比较', () => {
    expect(diffZentaoBugs([9, 2, 9], [bugItem(2, '修改标题'), bugItem(9), bugItem(2)])).toEqual({ ids: [2, 9], added: [] })
  })

  it('每轮基线只含当前 ID，消失后再次出现算新增', () => {
    const initial = diffZentaoBugs(null, [bugItem(9), bugItem(2)])
    const disappeared = diffZentaoBugs(initial.ids, [bugItem(9)])
    expect(disappeared).toEqual({ ids: [9], added: [] })
    const returned = bugItem(2)
    expect(diffZentaoBugs(disappeared.ids, [bugItem(9), returned])).toEqual({ ids: [9, 2], added: [returned] })
    const empty = diffZentaoBugs(initial.ids, [])
    expect(empty).toEqual({ ids: [], added: [] })
    expect(diffZentaoBugs(empty.ids, [returned])).toEqual({ ids: [2], added: [returned] })
  })

  it('不修改只读输入，返回的新基线由调用方决定是否采用', () => {
    const previous = Object.freeze([9, 7])
    const current = Object.freeze([Object.freeze(bugItem(9)), Object.freeze(bugItem(2))])
    const result = diffZentaoBugs(previous, current)
    expect(previous).toEqual([9, 7])
    expect(current.map(item => item.id)).toEqual([9, 2])
    expect(result.ids).not.toBe(previous)
    expect(diffZentaoBugs(previous, current)).toEqual(result)
  })
})

describe('fetchZentaoBugs', () => {
  it('读取多产品多页，顺序取完产品再取 Bug，保留所有 assigntome 状态', async () => {
    const read = vi.fn(async (productId: number | null, page: number) => {
      if (productId === null)
        return page === 1 ? products([product('2'), product(1)], 1, 3, 2) : products([product(3)], 2, 3, 2)
      if (productId === 2)
        return page === 1 ? bugs([bug(3), bug('7', { status: 'resolved' })], 1, 3, 2) : bugs([bug(5, { status: 'closed' })], 2, 3, 2)
      return bugs(productId === 1 ? [bug(2)] : [])
    })
    const result = await fetchZentaoBugs(read, () => Promise.resolve('产品'))
    expect(read.mock.calls).toEqual([[null, 1, 'assigntome'], [null, 2, 'assigntome'], [2, 1, 'assigntome'], [2, 2, 'assigntome'], [1, 1, 'assigntome'], [3, 1, 'assigntome']])
    expect(result.productCount).toBe(3)
    expect(result.bugs.map(row => row.id)).toEqual([7, 5, 3, 2])
    expect(result.bugs[0]).toEqual({ id: 7, title: 'Bug 7', productId: 2, productName: '产品 2', status: 'resolved', severity: 2, pri: null, openedDate: '2026-10-15 08:30:00', assignedTo: '', openedBy: '' })
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt)
  })

  it('空产品与空 Bug 只有合法的零总量才返回空态', async () => {
    const read = vi.fn(async () => products([]))
    expect(await fetchZentaoBugs(read, () => Promise.resolve('产品'))).toMatchObject({ bugs: [], productCount: 0 })
    expect(read).toHaveBeenCalledTimes(1)
    expect(await fetchZentaoBugs(readWithBug(bugs([])), () => Promise.resolve('产品'))).toMatchObject({ bugs: [], productCount: 1 })
  })

  it('按 total 结束，恰好整页也不额外请求空页', async () => {
    const read = vi.fn(readWithBug(bugs([bug(1), bug(2)], 1, 2, 2)))
    expect((await fetchZentaoBugs(read, () => Promise.resolve('产品'))).bugs).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('跨页产品 ID、跨产品 Bug ID 去重，数字字符串与数字是同一个 ID，首次记录胜出', async () => {
    const read = vi.fn(async (productId: number | null, page: number) => {
      if (productId === null)
        return page === 1 ? products([product('01', '首个产品')], 1, 3, 1) : products([product(page === 2 ? 1 : 2, '后续产品')], page, 3, 1)
      if (productId === 1)
        return bugs([bug('09', { title: '首次' }), bug(9, { title: '同页重复' })])
      return bugs([bug(9, { title: '跨产品重复' }), bug(10)])
    })
    const result = await fetchZentaoBugs(read, () => Promise.resolve('产品'))
    expect(result.productCount).toBe(2)
    expect(result.bugs.map(row => row.id)).toEqual([10, 9])
    expect(result.bugs[1]).toMatchObject({ title: '首次', productId: 1, productName: '首个产品' })
    expect(read.mock.calls.filter(([id]) => id === 1)).toHaveLength(1)
  })

  it.each(['产品首页', '产品后页', 'Bug 首页', 'Bug 后页', '后续产品'])('%s 失败时抛错，不返回部分空态', async (stage) => {
    const failure = new Error('模拟读取失败')
    const read = async (productId: number | null, page: number) => {
      if ((stage === '产品首页' && productId === null && page === 1)
        || (stage === '产品后页' && productId === null && page === 2)
        || (stage === 'Bug 首页' && productId === 1 && page === 1)
        || (stage === 'Bug 后页' && productId === 1 && page === 2)
        || (stage === '后续产品' && productId === 2)) {
        throw failure
      }
      if (productId === null)
        return products([product(page)], page, 2, 1)
      return bugs([bug(page)], page, 2, 1)
    }
    await expect(fetchZentaoBugs(read)).rejects.toBe(failure)
  })

  it.each(['page', 'total', 'limit'] as const)('严格校验 %s 为数字整数', async (field) => {
    for (const value of [undefined, null, '1', true, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(fetchZentaoBugs(async () => ({ ...products(), [field]: value }))).rejects.toThrow()
      await expect(fetchZentaoBugs(readWithBug({ ...bugs(), [field]: value }))).rejects.toThrow()
    }
  })

  it.each(['page', 'limit'] as const)('%s=0 立即失败', async (field) => {
    const read = vi.fn(async () => ({ ...products(), [field]: 0 }))
    await expect(fetchZentaoBugs(read)).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([
    { page: 2 },
    { total: 0 },
    { total: 2, limit: 2 },
    { total: 1001, limit: 1 },
    { total: 1000001, limit: 1000001 },
    { products: {} },
    { products: { 1: product(1) } },
    { products: null },
    { products: [product(1), product(2)] },
  ])('产品异常分页或列表失败：%j', async (overrides) => {
    await expect(fetchZentaoBugs(async () => ({ ...products([product(1)], 1, 1, 1), ...overrides }))).rejects.toThrow()
  })

  it.each([
    { page: 2 },
    { page: 0 },
    { limit: 0 },
    { total: 0 },
    { total: 2, limit: 2 },
    { total: 1001, limit: 1 },
    { total: 1000001, limit: 1000001 },
    { bugs: {} },
    { bugs: { 1: bug(1) } },
    { bugs: null },
    { bugs: [bug(1), bug(2)] },
  ])('bug 异常分页或列表失败：%j', async (overrides) => {
    await expect(fetchZentaoBugs(readWithBug({ ...bugs([bug(1)], 1, 1, 1), ...overrides }))).rejects.toThrow()
  })

  it.each([null, [], '登录页 HTML', { error: '会话失效' }, { ok: true, data: products() }])('拒绝异常响应 %j', async (raw) => {
    await expect(fetchZentaoBugs(async () => raw)).rejects.toThrow()
    await expect(fetchZentaoBugs(readWithBug(raw))).rejects.toThrow()
  })

  it.each([
    { page: 1 },
    { total: 3 },
    { total: 1 },
    { limit: 2 },
    { products: [] },
  ])('产品后页重复页号、元数据变化或短页均失败：%j', async (overrides) => {
    await expect(fetchZentaoBugs(async (_, page) => ({ ...products([product(page)], page, 2, 1), ...(page === 2 ? overrides : {}) }))).rejects.toThrow()
  })

  it.each([{ page: 1 }, { total: 3 }, { total: 1 }, { limit: 2 }, { bugs: [] }])('bug 后页异常也不能返回部分列表：%j', async (overrides) => {
    await expect(fetchZentaoBugs(async (id, page) => id === null ? products() : { ...bugs([bug(page)], page, 2, 1), ...(page === 2 ? overrides : {}) })).rejects.toThrow()
  })

  it('允许恰好 1000 页，重复 ID 不会引起多取或无限循环', async () => {
    const read = vi.fn(async (id: number | null, page: number) => id === null ? products() : bugs([bug(1)], page, 1000, 1))
    expect((await fetchZentaoBugs(read, () => Promise.resolve('产品'))).bugs).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(1001)
  })

  it('全部产品的累计 Bug 行超过 1000000 也失败', async () => {
    const rows = Array.from({ length: 1000000 }, () => bug(1))
    await expect(fetchZentaoBugs(async id => id === null ? products([product(1), product(2)]) : bugs(id === 1 ? rows : [bug(2)], 1, id === 1 ? rows.length : 1, 1000000))).rejects.toThrow('累计总量超过上限')
  })

  it.each([0, -1, 1.5, '', '0', '-1', '1.5', '1e2', ' 1 ', true, null, undefined, {}, Number.MAX_SAFE_INTEGER + 1])('无效 ID %j 不会被跳过成空列表', async (id) => {
    await expect(fetchZentaoBugs(async () => products([product(id)]))).rejects.toThrow()
    await expect(fetchZentaoBugs(readWithBug(bugs([bug(id)])))).rejects.toThrow()
  })

  it.each([null, 123, {}, [], '', '   '])('title / status 必须是非空字符串：%j', async (value) => {
    for (const field of ['title', 'status'])
      await expect(fetchZentaoBugs(readWithBug(bugs([bug(1, { [field]: value })])))).rejects.toThrow()
  })

  it('不执行字段对象的转换函数，拒绝非字符串标题及恶意状态', async () => {
    const toString = vi.fn(() => 'active')
    await expect(fetchZentaoBugs(readWithBug(bugs([bug(1, { title: { toString } })])))).rejects.toThrow()
    expect(toString).not.toHaveBeenCalled()
    await expect(fetchZentaoBugs(readWithBug(bugs([bug(1, { status: '<img onerror=alert(1)>' })])))).rejects.toThrow()
    const title = '<img src=x onerror=alert(1)>'
    expect((await fetchZentaoBugs(readWithBug(bugs([bug(1, { title })])))).bugs[0].title).toBe(title)
  })

  it.each([null, undefined, '', 'NULL', 'null', {}, true, -1, 'bad', 1.5, Number.NaN])('可选数字 %j 默认 null', async (value) => {
    const result = await fetchZentaoBugs(readWithBug(bugs([bug(1, { severity: value, pri: value })])))
    expect(result.bugs[0]).toMatchObject({ severity: null, pri: null })
  })

  it('接受可选数字字符串与零，缺少日期返回空字符串，未知合法状态保留', async () => {
    const result = await fetchZentaoBugs(readWithBug(bugs([bug(1, { severity: 0, pri: '3', openedDate: null, status: 'custom_status' })])))
    expect(result.bugs[0]).toMatchObject({ severity: 0, pri: 3, openedDate: '', status: 'custom_status' })
  })

  it.each([null, [], { id: 1, name: '' }, { id: 1, name: {} }])('产品字段不合规时失败：%j', async (row) => {
    await expect(fetchZentaoBugs(async () => products([row]))).rejects.toThrow()
  })
})

describe('zentaoBugUrl', () => {
  it('保留站点子路径并补分隔符，清除查询与片段', () => {
    expect(ZENTAO_DEFAULT_URL).toBe('http://115.159.41.157:81/zentao/')
    expect(zentaoBugUrl(ZENTAO_DEFAULT_URL, 42)).toBe(`${ZENTAO_DEFAULT_URL}bug-view-42.html`)
    expect(zentaoBugUrl('https://example.invalid/team/zentao?x=1#frag', 42)).toBe('https://example.invalid/team/zentao/bug-view-42.html')
    expect(zentaoBugUrl('https://example.invalid/', 1)).toBe('https://example.invalid/bug-view-1.html')
  })

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'ftp://example.invalid', '/zentao/', '//example.invalid', '', 'http://user:secret@example.invalid/zentao/', 'https://user@example.invalid', 'https://:secret@example.invalid'])('拒绝协议、相对地址或内嵌凭据：%s', (url) => {
    expect(() => zentaoBugUrl(url, 1)).toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('拒绝无效 Bug ID %j', (id) => {
    expect(() => zentaoBugUrl(ZENTAO_DEFAULT_URL, id)).toThrow()
  })
})

describe('zentaoStatusLabel', () => {
  it.each([['active', '激活'], ['resolved', '已解决'], ['closed', '已关闭'], ['', '未知状态'], ['custom_status', '未知状态'], ['__proto__', '未知状态'], ['constructor', '未知状态'], ['<script>', '未知状态']])('%s → %s', (status, label) => {
    expect(zentaoStatusLabel(status)).toBe(label)
  })
})

describe('parseZentaoBugDetail', () => {
  const raw = {
    id: '278',
    title: '医生工作量统计问题',
    product: '1',
    productName: '手麻系统',
    project: '9',
    status: 'resolved',
    severity: '2',
    pri: 3,
    type: 'others',
    openedBy: 'zhudl',
    openedDate: '2026-10-12 13:34:57',
    assignedTo: 'yangfeng',
    assignedDate: '2026-10-14 09:51:48',
    resolvedBy: 'wangqx',
    resolvedDate: '2026-10-15 10:00:00',
    resolution: 'fixed',
    closedBy: '',
    closedDate: '',
    steps: '<p>[步骤]</p>',
    actions: [
      {
        id: '10',
        actor: '张三',
        action: 'assigned',
        date: '2026-10-14 09:51:48',
        comment: '麻烦看下',
        desc: '2026-10-14 由 张三 指派',
        history: [{ field: 'assignedTo', old: '', new: 'yangfeng' }, { field: 'bad' }],
      },
      { action: '', id: '11' },
      'not-an-object',
    ],
  }

  it('白名单拷贝字段，正文与历史按纯文本保留', () => {
    const d = parseZentaoBugDetail(raw)
    expect(d.id).toBe(278)
    expect(d.productId).toBe(1)
    expect(d.projectId).toBe(9)
    expect(d.status).toBe('resolved')
    expect(d.severity).toBe(2)
    expect(d.pri).toBe(3)
    expect(d.assignedTo).toBe('yangfeng')
    expect(d.resolution).toBe('fixed')
    expect(d.steps).toBe('[步骤]')
    expect(d.actions).toHaveLength(1)
    expect(d.actions[0].actor).toBe('张三')
    // 有 field 就算一条变更（old/new 缺失给空串）；没 field 的丢掉
    expect(d.actions[0].history).toEqual([{ field: 'assignedTo', old: '', new: 'yangfeng' }, { field: 'bad', old: '', new: '' }])
  })

  it('缺字段给安全默认，id 无效直接抛错', () => {
    const d = parseZentaoBugDetail({ id: '5', title: 't' })
    expect(d.productId).toBe(0)
    expect(d.projectId).toBe(0)
    expect(d.status).toBe('active')
    expect(d.severity).toBeNull()
    expect(d.actions).toEqual([])
    expect(() => parseZentaoBugDetail({ title: 't' })).toThrow()
    expect(() => parseZentaoBugDetail(null)).toThrow()
  })
})

describe('parseZentaoUsers / parseZentaoBuilds', () => {
  it('按账号去重、缺真实姓名回落到账号', () => {
    const users = parseZentaoUsers([{ account: 'a', realname: '甲' }, { account: 'a', realname: '甲二' }, { account: '' }, 'x', { account: 'b' }])
    expect(users).toEqual([{ account: 'a', realname: '甲' }, { account: 'b', realname: 'b' }])
    expect(() => parseZentaoUsers('nope')).toThrow()
  })

  it('构建号按 id 去重、缺名字回落到 #id', () => {
    const builds = parseZentaoBuilds([{ id: '8', name: 'v1.0' }, { id: 8, name: 'dup' }, { id: '9' }, { id: 'bad' }])
    expect(builds).toEqual([{ id: 8, name: 'v1.0' }, { id: 9, name: '#9' }])
    expect(() => parseZentaoBuilds({})).toThrow()
  })
})

describe('指派 / 解决的入参校验', () => {
  it('指派要求有效 bugId 与非空账号', () => {
    expect(normalizeAssignInput({ bugId: 5, assignedTo: ' alice ', comment: '看下' })).toEqual({ bugId: 5, assignedTo: 'alice', comment: '看下' })
    expect(() => normalizeAssignInput({ bugId: 5, assignedTo: '  ', comment: '' })).toThrow()
    expect(() => normalizeAssignInput({ bugId: 0, assignedTo: 'a', comment: '' })).toThrow()
  })

  it('解决要求合法 resolution，fixed/duplicate 各有必填项', () => {
    expect(normalizeResolveInput({ bugId: 5, resolution: 'fixed', resolvedBuild: '8', duplicateBug: '', comment: 'ok' })).toEqual({ bugId: 5, resolution: 'fixed', resolvedBuild: '8', duplicateBug: '', comment: 'ok' })
    expect(() => normalizeResolveInput({ bugId: 5, resolution: 'fixed', resolvedBuild: '', duplicateBug: '', comment: '' })).toThrow()
    expect(() => normalizeResolveInput({ bugId: 5, resolution: 'duplicate', resolvedBuild: '', duplicateBug: '', comment: '' })).toThrow()
    expect(normalizeResolveInput({ bugId: 5, resolution: 'bydesign', resolvedBuild: '', duplicateBug: '', comment: '' }).resolution).toBe('bydesign')
    expect(() => normalizeResolveInput({ bugId: 5, resolution: 'nope', resolvedBuild: '', duplicateBug: '', comment: '' })).toThrow()
  })

  it('解决方案文案表覆盖常用取值', () => {
    expect(zentaoResolutionLabel('fixed')).toBe('已解决')
    expect(zentaoResolutionLabel('willnotfix')).toBe('不予解决')
    expect(zentaoResolutionLabel('unknown-x')).toBe('unknown-x')
  })
})

describe('产品清单来自账号资料（/v1/products 为空时的正路）', () => {
  it('产品页只给 id 时，产品名按需补取且只取一次', async () => {
    const nameCalls: number[] = []
    const read = vi.fn(async (productId: number | null, page: number) => {
      if (productId === null)
        return { page, total: 1, limit: 100, products: [{ id: 7 }] }
      return { page, total: 1, limit: 100, bugs: [bug(9)] }
    })
    const result = await fetchZentaoBugs(read, async (id) => {
      nameCalls.push(id)
      return '巩留县人民医院重症系统'
    }, 'assigntome')
    expect(result.bugs[0].productName).toBe('巩留县人民医院重症系统')
    expect(nameCalls).toEqual([7])
  })

  it('一条 Bug 都没有的产品不补名字（省掉无谓请求）', async () => {
    const nameCalls: number[] = []
    const read = vi.fn(async (productId: number | null, page: number) => {
      if (productId === null)
        return { page, total: 2, limit: 100, products: [{ id: 7 }, { id: 8 }] }
      return productId === 8
        ? { page, total: 1, limit: 100, bugs: [bug(5)] }
        : { page, total: 0, limit: 100, bugs: [] }
    })
    const result = await fetchZentaoBugs(read, async (id) => {
      nameCalls.push(id)
      return `产品${id}`
    }, 'assigntome')
    expect(nameCalls).toEqual([8])
    expect(result.bugs).toHaveLength(1)
    expect(result.productCount).toBe(2)
  })

  it('assignedTo 是用户对象时压成一句可显示文本（真实姓名优先）', async () => {
    const read = vi.fn(async (productId: number | null, page: number) => {
      if (productId === null)
        return { page, total: 1, limit: 100, products: [{ id: 7, name: '产品甲' }] }
      return {
        page,
        total: 1,
        limit: 100,
        bugs: [{ ...bug(3), assignedTo: { account: 'yangfeng', realname: '杨峰' } }],
      }
    })
    const result = await fetchZentaoBugs(read)
    expect(result.bugs[0].assignedTo).toBe('杨峰')
  })
})

describe('等级色阶（与禅道页面一套）', () => {
  it('严重程度 / 优先级各有自己的色阶，未登记等级回 null', () => {
    expect(zentaoSeverityColor(1)).toBe('#c62828')
    expect(zentaoSeverityColor(3)).toBe('#fdd835')
    expect(zentaoSeverityColor(5)).toBe('#8bc34a')
    expect(zentaoPriorityColor(1)).toBe('#d50000')
    expect(zentaoPriorityColor(3)).toBe('#2098ee')
    expect(zentaoPriorityColor(0)).toBe('#c0c0c0')
    // 同一等级两边颜色不同（禅道里就是这样：优先级 1 是深红、严重程度 1 是砖红）
    expect(zentaoSeverityColor(1)).not.toBe(zentaoPriorityColor(1))
  })

  it.each([null, undefined, 9, -1, 1.5])('没有对应等级的 %j 回 null', (level) => {
    expect(zentaoSeverityColor(level)).toBeNull()
    expect(zentaoPriorityColor(level)).toBeNull()
  })
})

describe('富文本 → 纯文本（正文与历史说明）', () => {
  it('去标签、按块级断行、图片给占位', () => {
    const html = '<p>[步骤]</p><p></p><p>[结果]</p><img onload="x()" src="/zentao/index.php?m=file&f=read" alt="f.png" />'
    const text = zentaoRichText(html)
    expect(text).not.toContain('<')
    expect(text).not.toContain('onload')
    expect(text).toContain('[步骤]')
    expect(text).toContain('[结果]')
    expect(text).toContain('[图片]')
    // 连续空行收敛成一行
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('去掉动作说明里的 markdown 加粗，实体解码', () => {
    expect(zentaoRichText('由 **<strong>刘家辉</strong>** 创建')).toBe('由 刘家辉 创建')
    expect(zentaoRichText('指派给 <strong>王勤学</strong>。')).toBe('指派给 王勤学。')
    expect(zentaoRichText('a &amp; b &lt;x&gt; &nbsp;c')).toBe('a & b <x> c')
    // 标签内容不会被当成 HTML 执行，只是文本
    expect(zentaoRichText('<script>alert(1)</script>文本')).toContain('文本')
  })

  it.each([null, undefined, '', '   ', 42, {}])('空值与非法值给空串：%j', (value) => {
    expect(zentaoRichText(value)).toBe('')
  })

  it('详情解析时就把 steps 与历史说明压平', () => {
    const detail = parseZentaoBugDetail({
      id: '1',
      title: 't',
      steps: '<p>第一段</p><p>第二段</p>',
      actions: [{ id: '2', action: 'assigned', desc: '由 **<strong>甲</strong>** 指派' }],
    })
    expect(detail.steps).toBe('第一段\n第二段')
    expect(detail.actions[0].desc).toBe('由 甲 指派')
  })
})

describe('正文分块与图片地址闸门', () => {
  it('把文字与图片切成块，图片只留站内路径', () => {
    const html = '<p>[步骤]</p><p><img src="/zentao/index.php?m=file&amp;f=read&amp;fileID=370&amp;t=png" alt="f.png" /></p><p>[结果]</p>'
    const blocks = zentaoStepBlocks(html, 'http://115.159.41.157:81/zentao/')
    expect(blocks.map(b => b.kind)).toEqual(['text', 'image', 'text'])
    expect(blocks[0]).toEqual({ kind: 'text', text: '[步骤]' })
    expect(blocks[1]).toEqual({ kind: 'image', src: '/zentao/index.php?m=file&f=read&fileID=370&t=png', alt: 'f.png' })
    expect(blocks[2]).toEqual({ kind: 'text', text: '[结果]' })
  })

  it('站外图片一律丢掉（服务端内容不能把请求带去别的主机）', () => {
    expect(zentaoStationImagePath('http://evil.example/x.png', 'https://zt.example/zentao')).toBeNull()
    expect(zentaoStationImagePath('//evil.example/x.png', 'https://zt.example')).toBeNull()
    expect(zentaoStationImagePath('data:image/png;base64,AAAA')).toBeNull()
    expect(zentaoStationImagePath('javascript:alert(1)')).toBeNull()
    expect(zentaoStationImagePath('/x.png')).toBe('/x.png')
    // 同源绝对地址收成站内路径；不同源丢掉
    expect(zentaoStationImagePath('https://zt.example/zentao/file.php?id=1', 'https://zt.example/zentao')).toBe('/zentao/file.php?id=1')
    expect(zentaoStationImagePath('https://other.example/file.php?id=1', 'https://zt.example/zentao')).toBeNull()
    // 没有 baseUrl 时只认相对路径
    expect(zentaoStationImagePath('https://zt.example/x.png')).toBeNull()
  })

  it('详情解析时给出 stepBlocks，图片地址同样过闸门', () => {
    const detail = parseZentaoBugDetail({
      id: '1',
      title: 't',
      steps: '<p>看图</p><img src="/zentao/f.php?id=9"><img src="http://evil.example/x.png">',
    })
    expect(detail.stepBlocks.map(b => b.kind)).toEqual(['text', 'image'])
    expect(detail.stepBlocks[1]).toMatchObject({ kind: 'image', src: '/zentao/f.php?id=9' })
  })
})

describe('时间统一成本地可读格式', () => {
  it('iSO（UTC）转成本地；已经是本地写法的原样返回', () => {
    const iso = '2026-10-13T12:09:05Z'
    const text = zentaoDateTime(iso)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 同一个时刻，只是换了写法
    expect(new Date(text.replace(' ', 'T')).getTime()).toBe(new Date(iso).getTime())
    expect(zentaoDateTime('2026-10-13 20:09:06')).toBe('2026-10-13 20:09:06')
  })

  it.each([null, undefined, '', '   ', '不是时间', 42])('认不出就原样/空：%j', (value) => {
    expect(zentaoDateTime(value)).toBe(typeof value === 'string' ? value.trim() : '')
  })
})

describe('历史说明：日期只出现一次', () => {
  it('说明开头的日期被去掉（界面上已单独显示时间）', () => {
    const detail = parseZentaoBugDetail({
      id: '1',
      title: 't',
      actions: [
        { id: '1', action: 'opened', date: '2026-10-13 20:09:06', desc: '2026-10-13 20:09:06, 由 <strong>刘家辉</strong> 创建。' },
        { id: '2', action: 'assigned', date: '2026-10-13 20:09:06', desc: '2026-10-13 20:09:06, 由 <strong>刘家辉</strong> 指派给 <strong>王勤学</strong>。' },
      ],
    })
    expect(detail.actions[0].desc).toBe('由 刘家辉 创建。')
    expect(detail.actions[1].desc).toBe('由 刘家辉 指派给 王勤学。')
  })

  it('说明里不带头日期时原样保留', () => {
    const detail = parseZentaoBugDetail({
      id: '1',
      title: 't',
      actions: [{ id: '1', action: 'commented', date: 'd', desc: '补充一句说明。' }],
    })
    expect(detail.actions[0].desc).toBe('补充一句说明。')
  })
})
