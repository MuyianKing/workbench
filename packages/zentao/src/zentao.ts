/**
 * 禅道的类型、链接与分页聚合；本包不联网、不保存密码、不持有后端会话。
 * readPage(null, page) 读取产品，readPage(productId, page) 读取该产品的 assigntome Bug。
 * 回包必须是原始 JSON 投影的数组；不猜测对象映射，也不接受 Result 包装。
 */
export interface ZentaoSession {
  id: string
  baseUrl: string
  account: string
}

/** title / productName 是纯文本，调用方必须用文本插值，不能交给 v-html。 */
export interface ZentaoBug {
  id: number
  title: string
  productId: number
  productName: string
  status: string
  severity: number | null
  pri: number | null
  openedDate: string
  /** 当前指派人（真实姓名优先，退回账号；未指派为空串） */
  assignedTo: string
  /** 创建者（真实姓名优先，退回账号） */
  openedBy: string
}

export interface ZentaoBugList {
  bugs: ZentaoBug[]
  productCount: number
  checkedAt: string
}

/** 列表筛选口径：指派给我的 / 未解决（=active）/ 未关闭（含已解决） */
export type ZentaoBrowse = 'assigntome' | 'unresolved' | 'unclosed'

export const ZENTAO_BROWSE_OPTIONS: ReadonlyArray<{ value: ZentaoBrowse, label: string }> = [
  { value: 'assigntome', label: '指派给我的' },
  { value: 'unresolved', label: '未解决' },
  { value: 'unclosed', label: '未关闭' },
]

/** 状态的固定文案；未识别的给「未知状态」，不把接口字段当对象键或 HTML。 */
export function zentaoStatusLabel(status: string): string {
  switch (status) {
    case 'active': return '激活'
    case 'resolved': return '已解决'
    case 'closed': return '已关闭'
    default: return '未知状态'
  }
}

export interface ZentaoBugDiff {
  ids: number[]
  added: ZentaoBug[]
}

export const ZENTAO_DEFAULT_URL = 'http://115.159.41.157:81/zentao/'
export const ZENTAO_POLL_MINUTES_DEFAULT = 30

const MAX_PAGES = 1000
const MAX_TOTAL = 1000000

/** 轮询周期（分钟）：非法值回默认，四舍五入后 0 = 关闭，其余夹进 1..1440。 */
export function sanitizeZentaoPollMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return ZENTAO_POLL_MINUTES_DEFAULT
  const minutes = Math.round(value)
  if (minutes === 0)
    return 0
  return Math.min(1440, Math.max(1, minutes))
}

/**
 * 比较完整 ID 集合，按当前顺序去重并保留首次记录；null 只建立基线，不返回新增。
 * ids 替换上一轮基线，因此消失后再次出现也算新增；请求失败时上层不调用，保留原基线。
 */
export function diffZentaoBugs(previous: readonly number[] | null, bugs: readonly ZentaoBug[]): ZentaoBugDiff {
  const previousIds = new Set(previous)
  const currentIds = new Set<number>()
  const added: ZentaoBug[] = []
  for (const bug of bugs) {
    if (currentIds.has(bug.id))
      continue
    currentIds.add(bug.id)
    if (previous !== null && !previousIds.has(bug.id))
      added.push(bug)
  }
  return { ids: [...currentIds], added }
}

/** 只生成 HTTP(S) 的站内 Bug 链接；清除基址查询与片段，不允许 URL 内嵌凭据。 */
export function zentaoBugUrl(baseUrl: string, id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error('禅道 Bug ID 必须为正整数')

  let url: URL
  try {
    url = new URL(baseUrl)
  }
  catch {
    throw new Error('禅道地址无效')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('禅道地址只允许不含凭据的 HTTP(S) URL')

  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/bug-view-${id}.html`
  return url.href
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('禅道响应必须是 JSON 对象')
  return value as Record<string, unknown>
}

function integerOf(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error(`禅道 ${field} 必须是大于等于 ${min} 的安全整数`)
  return value
}

/** ID 只额外接受十进制数字字符串，不做对象 / 布尔 / 科学计数法的隐式转换。 */
function idOf(value: unknown): number {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return integerOf(id, 'ID', 1)
}

function textOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`禅道 ${field} 必须为非空字符串`)
  return value
}

/** PHP 的 NULL / 空字符串与未设置值按 null；异常的可选数字也不让列表失败。 */
function nullableNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}

/**
 * 每个列表的 total / limit 必须跨页一致，页号从 1 开始；页长必须与 total 推算的剩余量一致。
 * 上限在首个回包就检查，空列表也必须返回合法的 page=1、total=0、limit>0、空数组。
 */
async function readAllPages(
  readPage: (page: number) => Promise<unknown>,
  field: 'products' | 'bugs',
  consume: (rows: unknown[]) => void,
): Promise<void> {
  let total = 0
  let limit = 0
  let pageCount = 1
  for (let page = 1; page <= pageCount; page++) {
    const raw = recordOf(await readPage(page))
    const actualPage = integerOf(raw.page, 'page', 1)
    const actualTotal = integerOf(raw.total, 'total', 0)
    const actualLimit = integerOf(raw.limit, 'limit', 1)
    if (actualPage !== page)
      throw new Error('禅道分页页号与请求不一致')
    if (actualTotal > MAX_TOTAL)
      throw new Error('禅道列表总量超过上限 1000000')
    if (page === 1) {
      total = actualTotal
      limit = actualLimit
      pageCount = Math.max(1, Math.ceil(total / limit))
      if (pageCount > MAX_PAGES)
        throw new Error('禅道列表页数超过上限 1000')
    }
    else if (actualTotal !== total || actualLimit !== limit) {
      throw new Error('禅道分页 total / limit 发生变化，请重试')
    }
    const rows: unknown = raw[field]
    if (!Array.isArray(rows))
      throw new Error(`禅道 ${field} 必须为数组`)
    const expected = Math.min(limit, total - (page - 1) * limit)
    if (rows.length !== expected)
      throw new Error('禅道分页长度与 total / limit 不一致（短页或多余数据）')
    consume(rows)
  }
}

/**
 * 串行读齐所有产品后逐产品读齐 Bug，并发数为 1；不按 active 过滤，不轮询。
 * 产品与 Bug 各按规范化后的 ID 去重，重复项保留首次记录，Bug 最终按 ID 降序。
 * 任一请求或校验失败直接抛错，由调用方 guard 转 Result，不返回部分列表。
 * 总量上限也作用于全部产品累计返回的 Bug 行（含重复项）；checkedAt 只在全部成功后生成。
 *
 * `readPage(null, page, browse)` 读的是「可见产品」那一页 —— 后端给的是**产品 id**
 * （名称可能缺省）：禅道的 `/v1/products` 在部分部署下返回空（产品挂在项目 / 项目集下），
 * 所以产品的可见范围由后端从账号资料里取、这里只管用。**产品名按需取**：只对真的有
 * Bug 的产品调一次 `readProductName`，省掉大量无谓请求。
 */
export async function fetchZentaoBugs(
  readPage: (productId: number | null, page: number, browse: ZentaoBrowse) => Promise<unknown>,
  readProductName: (productId: number) => Promise<string> = () => Promise.resolve(''),
  browse: ZentaoBrowse = 'assigntome',
): Promise<ZentaoBugList> {
  /** 产品 id → 名称；null 表示「还没取过」 */
  const products = new Map<number, string | null>()
  await readAllPages(page => readPage(null, page, browse), 'products', (rows) => {
    for (const row of rows) {
      const product = recordOf(row)
      const id = idOf(product.id)
      const raw = product.name
      const name = typeof raw === 'string' && raw.trim() ? raw : null
      if (!products.has(id))
        products.set(id, name)
    }
  })

  const bugs = new Map<number, ZentaoBug>()
  let bugRows = 0
  for (const [productId, cachedName] of products) {
    const rawRows: unknown[] = []
    await readAllPages(page => readPage(productId, page, browse), 'bugs', (rows) => {
      bugRows += rows.length
      if (bugRows > MAX_TOTAL)
        throw new Error('禅道 Bug 累计总量超过上限 1000000')
      // 逐条压栈：`push(...rows)` 在百万行的极端用例上会炸调用栈
      for (const row of rows)
        rawRows.push(row)
    })
    // 这个产品一条 Bug 都没有：连名字都不用取
    if (!rawRows.length)
      continue
    let productName = cachedName
    if (productName === null) {
      productName = await readProductName(productId)
      products.set(productId, productName)
    }
    for (const row of rawRows) {
      const bug = recordOf(row)
      const id = idOf(bug.id)
      const title = textOf(bug.title, 'bug.title')
      const status = textOf(bug.status, 'bug.status')
      if (!/^[a-z][\w-]*$/i.test(status))
        throw new Error('禅道 bug.status 格式无效')
      if (!bugs.has(id)) {
        bugs.set(id, {
          id,
          title,
          productId,
          productName,
          status,
          severity: nullableNumber(bug.severity),
          pri: nullableNumber(bug.pri),
          openedDate: typeof bug.openedDate === 'string' ? bug.openedDate : '',
          assignedTo: userText(bug.assignedTo),
          openedBy: userText(bug.openedBy),
        })
      }
    }
  }
  return {
    bugs: [...bugs.values()].sort((a, b) => b.id - a.id),
    productCount: products.size,
    checkedAt: new Date().toISOString(),
  }
}

/**
 * 「用户类」字段：v1 会把 `assignedTo` / `openedBy` 这些格式化成**对象**
 * （`format($bug, 'assignedTo:user')`），也可能直接是账号字符串。统一压成一句可显示的文本：
 * 真实姓名优先，退回账号；两者都没有给空串。绝不把对象丢给界面。
 */
function userText(value: unknown): string {
  if (typeof value === 'string')
    return value.trim()
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>
    for (const key of ['realname', 'account', 'name']) {
      const text = entry[key]
      if (typeof text === 'string' && text.trim())
        return text.trim()
    }
  }
  return ''
}

/**
 * 严重程度 / 优先级的色阶：取自禅道 22.2 `config->bug->colorList`（同一固定标签），
 * 与禅道页面上那套一致 —— 界面上要按等级分色，口径只在这一个文件里定义。
 * 只服务这两列的状态着色，不许扩散到别处（见 AGENTS.md 第 4 节那条例外）。
 */
const SEVERITY_COLORS: Record<number, string> = {
  1: '#c62828',
  2: '#ff8f00',
  3: '#fdd835',
  4: '#cddc39',
  5: '#8bc34a',
  6: '#b6b4b4',
  7: '#bdbebd',
}

const PRIORITY_COLORS: Record<number, string> = {
  0: '#c0c0c0',
  1: '#d50000',
  2: '#ff9800',
  3: '#2098ee',
  4: '#009688',
  5: '#919090',
  6: '#b6b4b4',
  7: '#bdbebd',
}

/** 等级 → 颜色；没有等级（null / 未登记）回 null，界面退回纯文本。 */
export function zentaoSeverityColor(level: number | null | undefined): string | null {
  return typeof level === 'number' ? SEVERITY_COLORS[level] ?? null : null
}

export function zentaoPriorityColor(level: number | null | undefined): string | null {
  return typeof level === 'number' ? PRIORITY_COLORS[level] ?? null : null
}
