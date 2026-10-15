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

/** 详情里的历史变更明细（`actions[].history[]`）：哪个字段从什么变成什么 */
export interface ZentaoBugHistory {
  field: string
  old: string
  new: string
}

/** 一条操作记录（`actions[]`）：谁、做了什么、什么时候、备注与字段变更 */
export interface ZentaoBugAction {
  id: number
  actor: string
  action: string
  date: string
  comment: string
  /** 已渲染好的操作说明（服务端的 desc，纯文本） */
  desc: string
  history: ZentaoBugHistory[]
}

/** Bug 详情：列表字段的超集，另带正文与历史 */
export interface ZentaoBugDetail {
  id: number
  title: string
  productId: number
  productName: string
  /** 所属项目编号：解决时按它取版本号清单 */
  projectId: number
  status: string
  severity: number | null
  pri: number | null
  type: string
  openedBy: string
  openedDate: string
  assignedTo: string
  assignedDate: string
  resolvedBy: string
  resolvedDate: string
  resolution: string
  closedBy: string
  closedDate: string
  /** 正文的纯文本形态（富文本已压平，绝不交给 v-html） */
  steps: string
  /** 正文的块序列：文字与图片分开，图片由宿主带会话取回后内联 */
  stepBlocks: ZentaoStepBlock[]
  actions: ZentaoBugAction[]
}

/** 指派候选人（只保留账号与真实姓名） */
export interface ZentaoUser {
  account: string
  realname: string
}

/** 一个构建号（解决 Bug 时要选） */
export interface ZentaoBuild {
  id: number
  name: string
}

/** 解决 Bug 时可选的构建号清单（某产品下的） */
export interface ZentaoBuildOption {
  id: number
  name: string
}

/** 指派入参（渲染层校验后再递后端） */
export interface ZentaoAssignInput {
  bugId: number
  assignedTo: string
  comment: string
}

/** 解决入参；`resolution=fixed` 时必须给 resolvedBuild，`duplicate` 时必须给 duplicateBug */
export interface ZentaoResolveInput {
  bugId: number
  resolution: string
  resolvedBuild: string
  duplicateBug: string
  comment: string
}

/** 列表筛选口径：指派给我的 / 未解决（=active）/ 未关闭（含已解决） */
export type ZentaoBrowse = 'assigntome' | 'unresolved' | 'unclosed'

export const ZENTAO_BROWSE_OPTIONS: ReadonlyArray<{ value: ZentaoBrowse, label: string }> = [
  { value: 'assigntome', label: '指派给我的' },
  { value: 'unresolved', label: '未解决' },
  { value: 'unclosed', label: '未关闭' },
]

/**
 * 解决方案选项：取自禅道 22.2 于 `module/bug/lang/zh-cn.php` 的 `resolutionList`
 * （与这是同一份固定标签）。`tostory`（转为需求）不在这里 —— 它要额外的需求字段，
 * 而 v1 的 resolve 入口没有那条路。
 */
export const ZENTAO_RESOLUTIONS: ReadonlyArray<{ value: string, label: string }> = [
  { value: 'fixed', label: '已解决' },
  { value: 'bydesign', label: '设计如此' },
  { value: 'duplicate', label: '重复 Bug' },
  { value: 'external', label: '外部原因' },
  { value: 'notrepro', label: '无法重现' },
  { value: 'postponed', label: '延期处理' },
  { value: 'willnotfix', label: '不予解决' },
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

/** 可选的文本字段：缺失 / 非字符串一律给空串（详情里有不少字段可能为 null）。 */
function optionalText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function historyOf(value: unknown): ZentaoBugHistory[] {
  if (!Array.isArray(value))
    return []
  const out: ZentaoBugHistory[] = []
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      continue
    const entry = row as Record<string, unknown>
    const field = optionalText(entry.field)
    if (!field)
      continue
    out.push({ field, old: optionalText(entry.old), new: optionalText(entry.new) })
  }
  return out
}

function actionsOf(value: unknown): ZentaoBugAction[] {
  if (!Array.isArray(value))
    return []
  const out: ZentaoBugAction[] = []
  let fallbackId = 0
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      continue
    const entry = row as Record<string, unknown>
    const action = optionalText(entry.action)
    if (!action)
      continue
    // id 缺失（少见）时给个负的自增号，仅用于列表 key，不参与排序
    const rawId = entry.id
    const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0
      ? rawId
      : (typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : --fallbackId)
    out.push({
      id,
      actor: optionalText(entry.actor),
      action,
      date: optionalText(entry.date),
      comment: optionalText(entry.comment),
      desc: stripLeadingDate(zentaoRichText(entry.desc)),
      history: historyOf(entry.history),
    })
  }
  return out
}

/** 安全地把一个字段读成正整数 ID：缺失 / 非法一律回退到 fallback（详情里 project/product 可能是空串）。 */
function idOr(value: unknown, fallback: number): number {
  try {
    return idOf(value)
  }
  catch {
    return fallback
  }
}

/**
 * Bug 详情：字段一律白名单拷贝，正文（steps）当纯文本 —— 它是服务端的富文本 HTML，
 * 交给界面插值（不解析、不注入）。历史按接口给的顺序原样保留（新的在后）。
 */
export function parseZentaoBugDetail(value: unknown, baseUrl?: string): ZentaoBugDetail {
  const bug = recordOf(value)
  return {
    id: idOf(bug.id),
    title: textOf(bug.title, 'bug.title'),
    productId: idOr(bug.product, 0),
    productName: optionalText(bug.productName),
    projectId: idOr(bug.project, 0),
    status: optionalText(bug.status) || 'active',
    severity: nullableNumber(bug.severity),
    pri: nullableNumber(bug.pri),
    type: optionalText(bug.type),
    openedBy: userText(bug.openedBy),
    openedDate: zentaoDateTime(bug.openedDate),
    assignedTo: userText(bug.assignedTo),
    assignedDate: zentaoDateTime(bug.assignedDate),
    resolvedBy: userText(bug.resolvedBy),
    resolvedDate: zentaoDateTime(bug.resolvedDate),
    resolution: optionalText(bug.resolution),
    closedBy: userText(bug.closedBy),
    closedDate: zentaoDateTime(bug.closedDate),
    steps: zentaoRichText(bug.steps),
    stepBlocks: zentaoStepBlocks(bug.steps, baseUrl),
    actions: actionsOf(bug.actions),
  }
}

/** 指派候选人清单（`GET /v1/users` 的 users 数组，只保留账号与真实姓名）。 */
export function parseZentaoUsers(value: unknown): ZentaoUser[] {
  if (!Array.isArray(value))
    throw new Error('禅道用户清单必须是数组')
  const out: ZentaoUser[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      continue
    const entry = row as Record<string, unknown>
    const account = optionalText(entry.account).trim()
    if (!account || seen.has(account))
      continue
    seen.add(account)
    out.push({ account, realname: optionalText(entry.realname).trim() || account })
  }
  return out
}

/** 构建号清单（`GET /v1/builds` 的 builds 数组，只保留 id 与名称）。 */
export function parseZentaoBuilds(value: unknown): ZentaoBuild[] {
  if (!Array.isArray(value))
    throw new Error('禅道版本清单必须是数组')
  const out: ZentaoBuild[] = []
  const seen = new Set<number>()
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      continue
    const entry = row as Record<string, unknown>
    const id = idOr(entry.id, 0)
    if (!id || seen.has(id))
      continue
    seen.add(id)
    out.push({ id, name: optionalText(entry.name).trim() || `#${id}` })
  }
  return out
}

/**
 * 禅道富文本 / 动作说明 → 可读纯文本。
 *
 * Bug 正文（`steps`）与历史里的 `desc` 在禅道那边是**富文本 HTML**，动作说明还夹着 markdown 加粗
 * （`**<strong>某某</strong>**`）—— 直接当文本显示就是一堆标签。这里按块级标签断行、去掉所有标签、
 * 解常见实体、收敛空白。图片在这个函数里只留 `[图片]` 占位；**正文要真显示图片走 `zentaoStepBlocks`**
 * （把正文切成「文字块 + 图片块」，图片由宿主带会话取回来再内联成 data URL）。
 */
export function zentaoRichText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    return ''
  let text = value
  text = text.replace(/<\s*(?:br|hr)\s*\/?>/gi, '\n')
  text = text.replace(/<\/\s*(?:p|div|li|tr|h[1-6]|table|ul|ol)\s*>/gi, '\n')
  text = text.replace(/<img\b[^>]*>/gi, '[图片]')
  text = text.replace(/<[^>]*>/g, '')
  // 动作说明里的 markdown 加粗 / 斜体标记
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, '\'')
    .replace(/&amp;/gi, '&')
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const RESOLUTION_VALUES = new Set(ZENTAO_RESOLUTIONS.map(item => item.value))

/** 动作说明以「日期, 」开头，而界面上已经单独显示了时间 —— 去掉这段重复。 */
function stripLeadingDate(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?[,，]\s*/, '')
}

/** 正文切成块：文字与图片分开（图片由宿主带会话取回、内联成 data URL）。 */
export type ZentaoStepBlock
  = | { kind: 'text', text: string }
    | { kind: 'image', src: string, alt: string }

function attrOf(tag: string, name: string): string | null {
  const matched = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!matched)
    return null
  return matched[2] ?? matched[3] ?? matched[4] ?? ''
}

/**
 * 图片地址只认站内：以 `/` 开头的相对路径，或与部署**同源**的绝对地址；
 * 其余（别的域名、`data:`、`javascript:`、协议相对 `//host`）一律丢掉。
 *
 * 这不是洁癖：正文 HTML 是**服务端给的任意内容**，让它把请求带去别的主机等于开了个任意出口。
 */
export function zentaoStationImagePath(raw: string, baseUrl?: string): string | null {
  const src = raw.trim().replace(/&amp;/gi, '&')
  if (!src || src.startsWith('//'))
    return null
  if (src.startsWith('/'))
    return src
  if (!baseUrl)
    return null
  try {
    const base = new URL(baseUrl)
    const url = new URL(src, base)
    if (url.protocol !== base.protocol || url.host !== base.host)
      return null
    return `${url.pathname}${url.search}`
  }
  catch {
    return null
  }
}

/**
 * 正文 → 块序列。文字块与 `zentaoRichText` 同一套收敛；图片块只带站内地址，
 * 取图与内联由渲染层经 `window.workbench` 走宿主（同一条会话）。
 */
export function zentaoStepBlocks(html: unknown, baseUrl?: string): ZentaoStepBlock[] {
  if (typeof html !== 'string' || !html.trim())
    return []
  const blocks: ZentaoStepBlock[] = []
  const pushText = (raw: string): void => {
    const text = zentaoRichText(raw)
    if (text)
      blocks.push({ kind: 'text', text })
  }
  const imgTag = /<img\b[^>]*>/gi
  let cursor = 0
  let matched: RegExpExecArray | null = imgTag.exec(html)
  while (matched) {
    pushText(html.slice(cursor, matched.index))
    cursor = matched.index + matched[0].length
    const raw = attrOf(matched[0], 'src')
    const path = raw === null ? null : zentaoStationImagePath(raw, baseUrl)
    if (path)
      blocks.push({ kind: 'image', src: path, alt: attrOf(matched[0], 'alt') ?? '' })
    matched = imgTag.exec(html)
  }
  pushText(html.slice(cursor))
  return blocks
}

/**
 * 时间统一成本地可读格式：详情里的时间是 ISO（`2026-10-13T12:09:05Z`，禅道按 UTC 标），
 * 历史里的 `date` 已经是本地的 `YYYY-MM-DD HH:mm:ss` —— 两处混着显示就是「不精致」。
 * 已经是本地写法的原样返回；认不出的也原样返回，不猜。
 */
export function zentaoDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    return ''
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text))
    return text
  const date = new Date(text)
  if (Number.isNaN(date.getTime()))
    return text
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
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

export function zentaoResolutionLabel(value: string): string {
  return ZENTAO_RESOLUTIONS.find(item => item.value === value)?.label ?? value
}

/**
 * 指派的入参校验：账号必填、Bug 编号为正整数。返回收敛后的入参，不合法就抛错
 * （由适配层 guard 转成 Result）。备注按服务端口径保留原文，不 trim。
 */
export function normalizeAssignInput(input: ZentaoAssignInput): ZentaoAssignInput {
  const assignedTo = typeof input.assignedTo === 'string' ? input.assignedTo.trim() : ''
  if (!Number.isSafeInteger(input.bugId) || input.bugId <= 0)
    throw new Error('禅道 Bug 编号无效')
  if (!assignedTo)
    throw new Error('请选择指派对象')
  if (assignedTo.length > 64)
    throw new Error('指派对象过长')
  return { bugId: input.bugId, assignedTo, comment: typeof input.comment === 'string' ? input.comment : '' }
}

/**
 * 解决的入参校验：`resolution` 必须在允许清单里；`fixed` 必须带版本号（禅道服务端同样有
 * 这条硬性要求），`duplicate` 必须带重复 Bug 编号。返回收敛后的入参。
 */
export function normalizeResolveInput(input: ZentaoResolveInput): ZentaoResolveInput {
  if (!Number.isSafeInteger(input.bugId) || input.bugId <= 0)
    throw new Error('禅道 Bug 编号无效')
  const resolution = typeof input.resolution === 'string' ? input.resolution.trim() : ''
  if (!RESOLUTION_VALUES.has(resolution))
    throw new Error('请选择解决方案')
  const resolvedBuild = typeof input.resolvedBuild === 'string' ? input.resolvedBuild.trim() : ''
  const duplicateBug = typeof input.duplicateBug === 'string' ? input.duplicateBug.trim() : ''
  if (resolution === 'fixed' && !resolvedBuild)
    throw new Error('解决方案为「已解决」时必须选择版本号')
  if (resolution === 'duplicate' && !duplicateBug)
    throw new Error('解决方案为「重复 Bug」时必须填写重复的 Bug 编号')
  return {
    bugId: input.bugId,
    resolution,
    resolvedBuild,
    duplicateBug,
    comment: typeof input.comment === 'string' ? input.comment : '',
  }
}
