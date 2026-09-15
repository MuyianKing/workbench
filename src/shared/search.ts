/**
 * 聚合搜索的纯逻辑。
 *
 * 顶部搜索框不是「只搜项目」，而是「把各来源的结果汇总到一个面板里」——今天只接进了
 * 「项目」这一个来源（SEARCH_SOURCES 里就一项），但结果按来源分组的结构先立起来：
 * 以后要加「命令」「快捷启动」，只需多出一个 searchXxx 函数 + 往分组里塞一项，
 * 面板本身不用改。
 *
 * 关键词口径与项目页的筛选完全一致（名字或路径包含），所以项目页的 matchesFilter
 * 直接复用这里的 projectMatchesKeyword —— 两处各写一份的话，搜索结果点进去看到的
 * 列表就可能和搜索结果对不上。
 */

/** 搜索结果的来源 id；分组标题按它认 */
export const SEARCH_SOURCE_PROJECT = 'project'

/**
 * 各来源在面板上的分组标题。
 * 只有一个来源时面板不画标题（一个标题带一堆结果看着像半成品），
 * 所以这份表是给「以后接进第二个来源」准备的。
 */
export const SEARCH_SOURCE_LABELS: Record<string, string> = {
  [SEARCH_SOURCE_PROJECT]: '项目'
}

/** 单个来源最多列几条：面板是「看一眼就跳走」的东西，不在这儿做翻页 */
export const PROJECT_HIT_LIMIT = 6

/** 参与匹配的字段：项目名与磁盘路径（够用且与筛选口径一致） */
export interface SearchableProject {
  id: string
  name: string
  path: string
}

/** 结果面板里的一行 */
export interface SearchHit {
  /** 来源 id（见 SEARCH_SOURCE_*） */
  source: string
  /** 来源内部的 id，点击时用它跳转 */
  id: string
  title: string
  subtitle: string
  /** 行尾的一小块说明（项目是运行状态），没有就不画 */
  detail?: string
}

export interface SearchGroup {
  /** 来源 id（见 SEARCH_SOURCE_*） */
  source: string
  /** 分组标题；面板只在有两个以上来源时才画它 */
  label: string
  /** 真正要画出来的（按 limit 截断） */
  hits: SearchHit[]
  /** 命中总数，用来显示「查看全部 N 条」 */
  total: number
}

/** 关键词归一：去首尾空白 + 转小写。空串表示「不搜」 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase()
}

/** 名字或路径包含关键词即命中（与项目页的筛选同一套口径） */
export function projectMatchesKeyword(project: SearchableProject, keyword: string): boolean {
  const kw = normalizeKeyword(keyword)
  if (!kw) return true
  return project.name.toLowerCase().includes(kw) || project.path.toLowerCase().includes(kw)
}

/**
 * 命中的文字分段，用来在界面上把那一段标出来。
 * 一段文字里可能有不止一处命中（路径里常常有两段），所以返回的是一个数组。
 */
export interface HighlightSegment {
  text: string
  hit: boolean
}

export function highlightSegments(text: string, keyword: string): HighlightSegment[] {
  if (!text) return []

  const kw = normalizeKeyword(keyword)
  if (!kw) return [{ text, hit: false }]

  const lower = text.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    const at = lower.indexOf(kw, cursor)
    if (at === -1) break
    if (at > cursor) segments.push({ text: text.slice(cursor, at), hit: false })
    segments.push({ text: text.slice(at, at + kw.length), hit: true })
    cursor = at + kw.length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments
}

/**
 * 在项目清单里搜一遍。
 *
 * `list` 应当是「项目页当前的展示顺序」，这样面板里的先后与跳过去看到的列表一致；
 * `labelOf` 由调用方注入（运行状态属于渲染层的实时数据，不在这里算）。
 */
export function searchProjects<P extends SearchableProject>(
  list: readonly P[],
  keyword: string,
  limit: number,
  labelOf: (project: P) => string | undefined
): SearchGroup {
  const group: SearchGroup = {
    source: SEARCH_SOURCE_PROJECT,
    label: SEARCH_SOURCE_LABELS[SEARCH_SOURCE_PROJECT],
    hits: [],
    total: 0
  }

  const kw = normalizeKeyword(keyword)
  if (!kw) return group

  for (const project of list) {
    if (!projectMatchesKeyword(project, kw)) continue
    group.total += 1
    // 数总数时不能提前 break：面板底部要显示「查看全部 N 条」
    if (group.hits.length >= limit) continue
    group.hits.push({
      source: SEARCH_SOURCE_PROJECT,
      id: project.id,
      title: project.name,
      subtitle: project.path,
      detail: labelOf(project)
    })
  }

  return group
}
