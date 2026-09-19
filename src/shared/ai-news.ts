/**
 * AI 行业每日热点（首页「AI 热点」卡片）：数据类型、多源解析、每源缓存策略与合并的纯逻辑。
 *
 * **多源设计**：热点来自一份**内置源清单**（见 Rust 侧 `ai_news.rs` 的 `SOURCES`，由
 * `ai_news_sources` 命令交给这里）。每个源各自持有 `etag / nextFetchAt / failCount / items`：
 * 一个源被限流或挂掉，不影响别的源，也不会把已经拿到的内容清掉。
 * 界面看到的是**合并视图**（`mergedItems`）：只并启用源的内容、按链接去重、按时间从新到旧排。
 *
 * **为什么源清单在 Rust 侧**：它是一份「允许访问哪些地址」的白名单。放在宿主侧，
 * 渲染层就只能报 id、不能自己拼任意 URL —— 联网边界因此收得住（见 AGENTS.md 第 1 节）。
 *
 * **缓存策略**（每个源独立）：
 *   - 成功 → `nextFetchAt = now + 该源的刷新间隔`（间隔见 Rust 侧 `SOURCES` 里每个源自己的 ttl）
 *   - 条件请求（`If-None-Match`）拿到 304 → 内容没变，只续期，不重新解析
 *   - 429 / 网络失败 → 指数退避（5 分钟起、2 小时封顶），失败次数成功后清零
 *
 * **落点分工**：Rust 只负责「按源白名单拉原始文本（带 ETag 条件请求）+ 把这份 JSON 安全读写到磁盘」；
 * 解析、收敛、退避、去重、排序都在这里，于是这些规则能被单测直接覆盖。
 *
 * 缓存文件在数据目录（`ai-news.json`），与工作日志一样**只在本机**：不进同步仓库。
 */

/**
 * 文件口径版本。
 *
 * v1 是单源时代的顶层结构（`items / etag / nextFetchAt` 都在顶层），那个源已经撤掉，
 * 所以读到 v1 就当成空缓存：里面的内容本来也没有地方能显示了，下次按清单重拉一遍即可。
 */
export const AI_NEWS_VERSION = 2

/** 单个源最多保留的条数（解析完先截断再落盘） */
export const AI_NEWS_MAX_ITEMS_PER_SOURCE = 20
/** 合并视图最多显示的条数：卡片空间有限，几个源叠起来会很长 */
export const AI_NEWS_MERGED_MAX = 40

/** 失败退避：起步 5 分钟，每多一次连续失败翻倍，2 小时封顶 */
export const AI_NEWS_BACKOFF_BASE_MS = 5 * 60 * 1000
export const AI_NEWS_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000

/**
 * 一个热点源的载荷格式，决定用哪个解析器。
 *
 * 这是**源清单的扩展点**：加一个源时，Rust 侧在 `SOURCES` 里声明它的 format，
 * 适配层按这里分发、不用改。当前清单里的源（量子位）是 `rss` ——
 * `atom` 与 `json-hf-papers` 两个分支是给「将来加非 RSS 源」留下的能力
 * （它们原本服务 Hugging Face 每日论文与 arXiv，那两个英文源已按要求撤掉）。
 */
export type AiNewsSourceFormat = 'rss' | 'atom' | 'json-hf-papers'

/**
 * 源清单里的一项（Rust 侧的源白名单经 `ai_news_sources` 命令送过来）。
 *
 * **不带地址**：地址留在宿主侧的白名单里就够用了（拉取时那边自己查表），
 * 渲染层拿到的只有 id、格式与刷新间隔 —— 它连一个能出网的字符串都拼不出来。
 */
export interface AiNewsSourceInfo {
  id: string
  name: string
  format: AiNewsSourceFormat
  /** 建议的刷新间隔（毫秒）：成功拉取后隔这么久再拉下一次 */
  ttlMs: number
}

/** 一条热点新闻（解析 / 收敛后落盘的样子） */
export interface AiNewsItem {
  /** 服务端给的稳定 id（RSS 的 guid / Atom 的 id）；缺失时回落 link */
  guid: string
  title: string
  link: string
  /** 发布时间（毫秒，Unix 纪元）；解析不出就是 0 */
  pubDate: number
  /** 纯文本摘要；空着就由界面截断标题 */
  summary: string
  /** 来源名（RSS 的 <source>，或源清单里的名字） */
  source: string
}

/** 单个源的缓存与调度状态 */
export interface AiNewsSourceState {
  /** 这个源的内容最后更新时间（毫秒）；还没拉到过就是 0 */
  updatedAt: number
  /** 服务端 ETag：条件请求靠它判断内容有没有变 */
  etag: string
  /** 这个时刻之前不再拉这个源；0 表示立即可拉 */
  nextFetchAt: number
  /** 连续失败次数：指数退避的底数，成功后清零 */
  failCount: number
  /** 上一次失败的说明（界面如实显示，成功时清空） */
  lastError: string
  items: AiNewsItem[]
}

/** 落盘的缓存结构：**按源分开**，合并视图是读的时候现算的 */
export interface AiNewsCache {
  version: number
  sources: Record<string, AiNewsSourceState>
}

/** 界面要的那一份：合并好的条目 + 最近一次成功更新的时间 */
export interface AiNewsView {
  items: AiNewsItem[]
  /** 最近一次成功更新的时间；还没拉到过就是 0 */
  updatedAt: number
}

/** 一次「刷新」的结果 */
export interface AiNewsRefreshResult {
  view: AiNewsView
  /**
   * true = 至少有一个源真的发了请求；false = 都还没到期，
   * 界面据此提示「还没到下次刷新时间」，而不是假装刷成功。
   */
  refreshed: boolean
  /** 这次刷新中值得说一句的事（某个源失败 / 被限流），逐条给界面 */
  notes: string[]
}

/** 站内阅读：从原文页 HTML 里提出来的一篇正文 */
export interface AiNewsArticle {
  /** 段落（已去标签、解实体、压空白），按原文顺序 */
  paragraphs: string[]
  /** 太长被截断了（界面要如实说一句，免得以为文章就这么短） */
  truncated: boolean
}

export function emptyAiNewsCache(): AiNewsCache {
  return { version: AI_NEWS_VERSION, sources: {} }
}

export function emptySourceState(): AiNewsSourceState {
  return { updatedAt: 0, etag: '', nextFetchAt: 0, failCount: 0, lastError: '', items: [] }
}

// ---------- 解析：RSS / Atom / JSON ----------

/**
 * 按源声明的格式解析载荷。解析不出任何条目时返回空数组 ——
 * 「解析失败」与「服务端确实没内容」是两回事，由调用方决定怎么提示。
 */
export function parseSourcePayload(format: AiNewsSourceFormat, body: string): AiNewsItem[] {
  if (format === 'json-hf-papers') return parseHfDailyPapers(body)
  if (format === 'atom') return parseAtom(body)
  return parseRss(body)
}

/** 解析 RSS 2.0（`<item>`） */
export function parseRss(xml: string): AiNewsItem[] {
  return finish(blocksOf(xml, 'item').map(parseRssItem).filter(isItem))
}

/** 解析 Atom 1.0（`<entry>`）——arXiv 的 API 走这个 */
export function parseAtom(xml: string): AiNewsItem[] {
  return finish(blocksOf(xml, 'entry').map(parseAtomEntry).filter(isItem))
}

/**
 * 解析 Hugging Face 的 Daily Papers（JSON 数组）。
 *
 * 形状（实测）：数组元素里 `paper` 是论文本体，外层也镜像了 title / summary / publishedAt。
 * 取的时候两边都认，优先外层（那是它给展示用的）。
 */
export function parseHfDailyPapers(body: string): AiNewsItem[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const items: AiNewsItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const outer = entry as Record<string, unknown>
    const paper = (outer.paper ?? {}) as Record<string, unknown>

    const id = text(paper.id) || text(outer.id)
    const title = text(outer.title) || text(paper.title)
    if (!title) continue

    const link = id ? `https://huggingface.co/papers/${id}` : text(outer.url)
    const published = text(outer.publishedAt) || text(paper.publishedAt)
    const summary = text(outer.summary) || text(paper.summary)

    items.push({
      guid: link || title,
      title: title.slice(0, 200),
      link: link.slice(0, 1000),
      pubDate: Number.isFinite(Date.parse(published)) ? Date.parse(published) : 0,
      summary: stripHtml(summary).slice(0, 500),
      // 源名留空：由适配层统一盖上源清单里的名字（这样改名不用重刷数据）
      source: ''
    })
  }
  return finish(items)
}

/** 取出 `<tag ...>...</tag>` 的每一块（轻量扫描；RSS / Atom 的结构是固定的） */
function blocksOf(xml: string, tag: string): string[] {
  const blocks: string[] = []
  const open = `<${tag}`
  const close = `</${tag}>`
  let pos = 0
  for (;;) {
    const start = xml.indexOf(open, pos)
    if (start === -1) break
    const end = xml.indexOf(close, start)
    if (end === -1) break
    blocks.push(xml.slice(start, end))
    pos = end + close.length
  }
  return blocks
}

function isItem(value: AiNewsItem | null): value is AiNewsItem {
  return value !== null
}

/** 按时序从新到旧排，并截断到单源上限 */
function finish(items: AiNewsItem[]): AiNewsItem[] {
  return items
    .slice()
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, AI_NEWS_MAX_ITEMS_PER_SOURCE)
}

function parseRssItem(block: string): AiNewsItem | null {
  const title = cleanText(tagText(block, 'title'))
  if (!title) return null

  const link = cleanText(tagText(block, 'link')).trim()
  const guid = cleanText(tagText(block, 'guid')).trim() || link
  const source = cleanText(tagText(block, 'source')).trim()
  // description 是带 CDATA 的摘要（可能混着零散 HTML 标签），去标记后当摘要
  const summary = stripHtml(cleanText(tagText(block, 'description'))).trim()
  const pubDate = parseDate(cleanText(tagText(block, 'pubDate')))

  return {
    guid: guid || `${title}-${pubDate}`,
    title: title.slice(0, 200),
    link: link.slice(0, 1000),
    pubDate,
    summary: summary.slice(0, 500),
    source: source.slice(0, 50)
  }
}

/**
 * 解析一条 Atom entry。
 *
 * Atom 的 `<link>` 是属性元素（`<link href="…"/>`），取不到文本，所以**用 `<id>` 当链接** ——
 * arXiv 的 `<id>` 本身就是摘要页地址（`http://arxiv.org/abs/…`），正合用。
 */
function parseAtomEntry(block: string): AiNewsItem | null {
  const title = cleanText(tagText(block, 'title'))
  if (!title) return null

  const id = cleanText(tagText(block, 'id')).trim()
  const link = id || atomHref(block)
  const summary = stripHtml(cleanText(tagText(block, 'summary'))).trim()
  const pubDate = parseDate(cleanText(tagText(block, 'published')) || cleanText(tagText(block, 'updated')))

  return {
    guid: id || link || title,
    title: title.slice(0, 200),
    link: link.slice(0, 1000),
    pubDate,
    summary: summary.slice(0, 500),
    source: ''
  }
}

/** 兜底：从 `<link href="…">` 里抠地址（`<id>` 缺失时用） */
function atomHref(block: string): string {
  const match = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block)
  return match ? match[1] : ''
}

/**
 * 取某标签在块里的第一次出现的内容。
 *
 * CDATA 有两种写法：字面 CDATA 与**实体转义过的 CDATA**（`<description>&lt;![CDATA[…]]&gt;</description>`，
 * 真实 feed 里两种都见过），所以顺序是：先剥字面 CDATA，再解实体（让转义过的 CDATA 标记现形），再剥一次。
 * 三种形态（字面 CDATA / 转义 CDATA / 纯文本）都走同一遍。
 */
function tagText(block: string, tag: string): string {
  const start = block.indexOf(`<${tag}`)
  if (start === -1) return ''
  const contentStart = block.indexOf('>', start)
  if (contentStart === -1) return ''
  const end = block.indexOf(`</${tag}>`, contentStart)
  if (end === -1) return ''
  const inner = block.slice(contentStart + 1, end)

  const once = unwrapCdata(inner)
  const decoded = decodeEntities(once)
  return unwrapCdata(decoded)
}

/** 剥掉 CDATA 的包裹标记（没有就当普通文本原样返回） */
function unwrapCdata(text: string): string {
  const start = text.indexOf('<![CDATA[')
  if (start === -1) return text
  const end = text.indexOf(']]>', start)
  if (end === -1) return text
  return text.slice(start + '<![CDATA['.length, end)
}

/** 去掉 HTML 标记，把空白压成单个空格 */
export function stripHtml(text: string): string {
  return String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解码 RSS / HTML 里最常见的实体 */
function decodeEntities(text: string): string {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
}

/** 解析字段的统一收尾：实体解码 + 去标记 + 压空白 */
function cleanText(text: string): string {
  return stripHtml(decodeEntities(text))
}

/** 认不出的时间一律给 0（排序时沉底），不编一个「现在」出来 */
function parseDate(text: string): number {
  const value = Date.parse(text)
  return Number.isFinite(value) ? value : 0
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ---------- 站内阅读：正文提取 ----------

/** 单段短于这个字数就不当正文（导航、页脚、标签云、版权行大多很短） */
export const ARTICLE_MIN_PARAGRAPH = 18
/**
 * 小标题的下限放宽得多：`<h2>` 这种本来就短（「小标题二」四个字），
 * 用正文那条阈值会把所有小节标题都滤掉，正文读起来就成了一整片没有分节的文字。
 */
export const ARTICLE_MIN_HEADING = 4
/** 最多保留多少段 / 多少字：再长也只是让人滚不到头，界面会如实说「已截断」 */
export const ARTICLE_MAX_PARAGRAPHS = 120
export const ARTICLE_MAX_CHARS = 12_000

/**
 * 从原文页 HTML 里提出正文段落。
 *
 * **这是启发式，不是通用正文提取器**：没有引 HTML 解析库（项目不新增依赖），
 * 分四步走 ——
 *   1. 删掉一定是干扰的整块（脚本 / 样式 / 注释 / iframe）；
 *   2. **按容器定位正文**：认常见的正文容器类名，把那一棵子树切出来（配平标签，不是找下一个 `</div>`）。
 *      这一步是关键：真实页面上「相关阅读」「热门文章」都在正文容器**之外**，
 *      靠文字分界去切迟早会漏（第一版就漏了，尾部混进了侧栏标题）；
 *   3. 容器之外还在整篇里找一次末尾分界（评论区 / 页脚）兜底；
 *   4. 按段落与小标题取文本，丢掉过短的（导航、按钮）。
 * 认不出容器就退回整篇，提不出东西就返回空数组 —— 由调用方降级成「标题 + 导语 + 打开原文」，
 * 而不是把一堆导航文字当正文摆出来。
 *
 * **产出是纯文本**：远程页面里的标签、脚本一律不进界面 —— 不执行、也不当 HTML 渲染。
 */
export function extractArticle(html: string): AiNewsArticle {
  const cleaned = cutNoise(html)
  // 先在正文容器里找；一个容器都没命中（或命中的提不出东西）才退回整篇 + 末尾分界
  let blocks = sliceMainContent(cleaned)
  if (!blocks.length) blocks = collectBlocks(cutTail(cleaned))

  const paragraphs: string[] = []
  let total = 0
  let truncated = false
  for (const block of blocks) {
    if (paragraphs.length >= ARTICLE_MAX_PARAGRAPHS || total + block.length > ARTICLE_MAX_CHARS) {
      truncated = true
      break
    }
    paragraphs.push(block)
    total += block.length
  }

  return { paragraphs, truncated }
}

/**
 * 正文容器的候选标记，**按具体到宽泛排**（先认专门的类名，最后才退到通用的 `content`）。
 *
 * 一律用词边界匹配，所以 `class="content_right"`、`class="article_info"` 这类
 * 看起来像、其实是别的区块的类名不会被误认（`_` 在正则里算词字符，`\b` 卡得住）。
 */
const CONTENT_MARKERS: RegExp[] = [
  /\bclass=["'][^"']*\b(article-content|article_content|entry-content|entry_content|post-content|post_content|rich_media_content|article__content)\b/i,
  /\bid=["'](js_content|article-content|articleContent)["']/i,
  /<article\b/i,
  /\bclass=["'][^"']*\barticle\b[^"']*["']/i,
  /\bclass=["'][^"']*\bcontent\b[^"']*["']/i
]

/**
 * 按候选标记依次试，返回**第一个真的能提出正文段落**的容器里的段落。
 *
 * 判据是「提不提得出段落」而不是容器多大：早先按「容器内容短于 200 字符就跳过」来筛，
 * 结果一篇正常的短文（`.article` 只有一百多字）会被误跳过、退到外层的 `.content`，
 * 于是那个 wrapper 里的「相关阅读」跟着混进正文。**能提出正文的才算正文容器。**
 */
function sliceMainContent(html: string): string[] {
  for (const marker of CONTENT_MARKERS) {
    const inner = sliceContainer(html, marker)
    if (inner === null) continue
    const blocks = collectBlocks(inner)
    if (blocks.length) return blocks
  }
  return []
}

/**
 * 把某个标记所在的元素那棵子树切出来（找不到或配不平返回 null）。
 *
 * 用**标签配平**而不是「找下一个 `</div>`」：正文里必然嵌着别的 div（图注、引用块），
 * 找第一个闭合标签会把正文拦腰截断。同名标签的嵌套深度扫一遍就好。
 */
function sliceContainer(html: string, marker: RegExp): string | null {
  const found = marker.exec(html)
  if (!found) return null

  const openStart = html.lastIndexOf('<', found.index)
  if (openStart === -1) return null
  const openEnd = html.indexOf('>', found.index)
  if (openEnd === -1) return null

  const tag = /^<([a-z0-9]+)/i.exec(html.slice(openStart, openEnd + 1))?.[1]
  if (!tag) return null

  const walker = new RegExp(`<${tag}\\b|</${tag}>`, 'gi')
  walker.lastIndex = openEnd + 1
  let depth = 1
  let step: RegExpExecArray | null
  while ((step = walker.exec(html)) !== null) {
    depth += step[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(openEnd + 1, step.index)
  }
  return null
}

/** 取段落与小标题；标题用更低的字数下限（见 ARTICLE_MIN_HEADING） */
function collectBlocks(html: string): string[] {
  const blocks: string[] = []
  const pattern = /<(p|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const text = cleanText(match[2])
    const min = match[1].toLowerCase() === 'p' ? ARTICLE_MIN_PARAGRAPH : ARTICLE_MIN_HEADING
    if (text.length >= min) blocks.push(text)
  }
  return blocks
}

/**
 * 删掉一定不是正文的整块。
 *
 * 顺序有讲究：**必须先把 script 与 style 整块删掉** —— 它们的内容里也可能出现
 * 「评论区」「相关阅读」之类的字样，先按字样截断就会在半个脚本中间切断。
 */
function cutNoise(html: string): string {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
}

/**
 * 末尾分界：只认**结构**上的标记（评论区的 id / 类名、页脚、相关阅读与热门的容器类名），
 * 不按「相关阅读」这几个字去切 —— 正文里完全可能正常提到它们。
 */
function cutTail(html: string): string {
  const markers = [
    /id=["']comments["']/i,
    /class=["'][^"']*\bcomments?\b[^"']*["']/i,
    /class=["'][^"']*\b(xiangguan|related|yaowen|hot-?news)\b[^"']*["']/i,
    /<footer\b/i,
    /id=["']footer["']/i,
    /class=["'][^"']*\bsidebar\b[^"']*["']/i
  ]
  let cut = -1
  for (const marker of markers) {
    const index = html.search(marker)
    if (index !== -1 && (cut === -1 || index < cut)) cut = index
  }
  return cut > 0 ? html.slice(0, cut) : html
}

// ---------- 缓存收敛 ----------

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function cleanString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function sanitizeItem(value: unknown): AiNewsItem {
  const input = (value ?? {}) as Partial<AiNewsItem>
  return {
    guid: cleanString(input.guid, ''),
    title: cleanString(input.title, ''),
    link: cleanString(input.link, ''),
    pubDate: finiteNumber(input.pubDate, 0),
    summary: cleanString(input.summary, ''),
    source: cleanString(input.source, '')
  }
}

function sanitizeSourceState(value: unknown): AiNewsSourceState {
  const input = (value ?? {}) as Partial<AiNewsSourceState>
  return {
    updatedAt: Math.max(0, finiteNumber(input.updatedAt, 0)),
    etag: cleanString(input.etag, ''),
    // nextFetchAt 夹到不小于 0，免得手改出的负值把自己锁死
    nextFetchAt: Math.max(0, finiteNumber(input.nextFetchAt, 0)),
    failCount: Math.max(0, Math.floor(finiteNumber(input.failCount, 0))),
    lastError: cleanString(input.lastError, ''),
    items: Array.isArray(input.items)
      ? input.items.map(sanitizeItem).filter((item) => item.title).slice(0, AI_NEWS_MAX_ITEMS_PER_SOURCE)
      : []
  }
}

/**
 * 收敛磁盘上读回的缓存：老文件缺字段补默认，认不出来的值回落，防止手改坏的数据进界面。
 *
 * **v1 那个单源时代的顶层结构（`items / etag` 都在顶层）不再迁移**：它的内容只属于那个
 * 已经撤掉的源，搬进来也没有地方能显示 —— 直接当空缓存，按当前清单重拉一遍就是了。
 */
export function sanitizeAiNewsCache(raw: unknown): AiNewsCache {
  const input = (raw ?? {}) as Partial<AiNewsCache> & Record<string, unknown>

  if (!input.sources || typeof input.sources !== 'object') return emptyAiNewsCache()

  const sources: Record<string, AiNewsSourceState> = {}
  for (const [id, value] of Object.entries(input.sources as Record<string, unknown>)) {
    if (!id.trim()) continue
    sources[id] = sanitizeSourceState(value)
  }
  return { version: AI_NEWS_VERSION, sources }
}

// ---------- 每源的调度策略 ----------

/** 指数退避的下一次可拉时刻：连续失败第 failCount 次（0 起算）后的等待时长 */
export function backoffDelayMs(failCount: number): number {
  return Math.min(AI_NEWS_BACKOFF_BASE_MS * 2 ** failCount, AI_NEWS_BACKOFF_MAX_MS)
}

/** 现在该不该拉这个源：没有状态（从没拉过）或已过 nextFetchAt 就该拉 */
export function shouldFetchSource(state: AiNewsSourceState | undefined, now: number): boolean {
  return !state || now >= state.nextFetchAt
}

/** 拉取成功：更新时间、记 ETag、把下一次推到该源的间隔之后、失败计数与错误清零 */
export function applySourceSuccess(
  state: AiNewsSourceState | undefined,
  items: AiNewsItem[],
  etag: string,
  ttlMs: number,
  now: number
): AiNewsSourceState {
  return {
    updatedAt: now,
    etag: etag || state?.etag || '',
    nextFetchAt: now + ttlMs,
    failCount: 0,
    lastError: '',
    items
  }
}

/** 条件请求拿到 304：内容没变，只续期（ETag 取服务端最新给的那个），已有条目原样留着 */
export function applySourceNotModified(
  state: AiNewsSourceState | undefined,
  etag: string,
  ttlMs: number,
  now: number
): AiNewsSourceState {
  const base = state ?? emptySourceState()
  return {
    ...base,
    etag: etag || base.etag,
    nextFetchAt: now + ttlMs,
    failCount: 0,
    lastError: ''
  }
}

/** 失败（429 / 网络错误 / 解析不出）：指数退避，失败次数 +1，并记下原因 */
export function applySourceFailure(
  state: AiNewsSourceState | undefined,
  now: number,
  error: string
): AiNewsSourceState {
  const base = state ?? emptySourceState()
  return {
    ...base,
    nextFetchAt: now + backoffDelayMs(base.failCount),
    failCount: base.failCount + 1,
    lastError: error
  }
}

// ---------- 合并视图 ----------

/**
 * 把清单里的源的内容并成一份列表：按链接（退到 guid）去重、按时间从新到旧、截断到总上限。
 *
 * `sourceIds` 给的是**清单顺序**（Rust 侧 `SOURCES` 的顺序），去重**先到先得**，
 * 所以源的先后就是同一件事的优先级；清单里没有的 id（撤掉的源留在旧缓存里的那份）不并。
 */
export function mergedItems(
  cache: AiNewsCache,
  sourceIds: string[],
  max: number = AI_NEWS_MERGED_MAX
): AiNewsItem[] {
  const seen = new Set<string>()
  const merged: AiNewsItem[] = []

  for (const id of sourceIds) {
    for (const item of cache.sources[id]?.items ?? []) {
      const key = item.link || item.guid || item.title
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }

  return merged.sort((a, b) => b.pubDate - a.pubDate).slice(0, max)
}

/** 清单里这些源最近一次成功更新的时间（页脚「更新于」用它） */
export function latestUpdatedAt(cache: AiNewsCache, sourceIds: string[]): number {
  let latest = 0
  for (const id of sourceIds) {
    const updatedAt = cache.sources[id]?.updatedAt ?? 0
    if (updatedAt > latest) latest = updatedAt
  }
  return latest
}