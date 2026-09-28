/**
 * 知识库（kb）：用户在别处维护的一个独立项目 —— `data/raw/` 放原始资料，`kb/` 放整理好的
 * 条目（frontmatter 的 source 指回原始文件），`index/index.json` 由仓库自己的脚本生成。
 *
 * 应用对知识库**只读**：这里没有写入，也没有「生成」——整理是用户在 ZCode 等 Agent 里做的
 * 事，应用负责的是把「哪些还没入库、哪些原始资料又更新了」算清楚（这些口径都是纯函数，
 * 在这里、有单测），再用一段指令把整理这件事交还给 Agent。Rust 侧（kb.rs）只带事实：
 * 平铺清单（任意后缀、带 mtime）与文件文本。
 *
 * 「有没有更新」的判据是**文件修改时间**：条目的 source 归一化后与原始文件配对 ——
 * 没有条目指向 = 未入库；原始文件比指向它的条目里最新的那份还新 = 有更新。
 * 它是个启发式：git 操作（checkout / pull）会重写 mtime，但换状态文件、记同步位标
 * 都比它更脆 —— 它不依赖任何额外状态，重启就对得上。口径要换时只改这里。
 *
 * 仓库布局（`data/raw`、`kb`、索引位置）在这里定成常量：它们与知识库仓库自己的
 * `scripts/build_index.py` 是一套约定，改哪边都要一起改。
 */
import type { NoteRepoState, NoteSyncInput, NoteSyncSummary } from './note'

/** 同步与仓库探测复用笔记那两条通道（本来就是「对任意文件夹、认它自己的 origin」的），形状照搬 */
export type KbSyncInput = NoteSyncInput
export type KbSyncSummary = NoteSyncSummary
export type KbRepoState = NoteRepoState

/** 原始资料投放区（相对知识库根） */
export const KB_RAW_DIR = 'data/raw'
/** 条目区（相对知识库根） */
export const KB_DIR = 'kb'
/** 机器可读索引（相对知识库根；由仓库的 build_index.py 生成） */
export const KB_INDEX_REL = 'index/index.json'
/** 全库目录：脚本生成、Agent 的导航入口，条目清单里不算它 */
export const KB_CATALOG_NAME = '_catalog.md'

/** 同层按名字排的口径与笔记树一致（数字按值、中文按拼音） */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 扫描回来的一条（Rust 的平铺清单，只带事实） */
export interface KbScanEntry {
  /** 相对知识库根的路径，`/` 分隔 */
  rel: string
  name: string
  isDir: boolean
  mtimeMs: number
}

/** 原始数据的入库状态 */
export type KbRawStatus = 'pending' | 'stale' | 'synced'

/** 一个条目的元数据（frontmatter + 扫描信息） */
export interface KbEntryMeta {
  /** 相对知识库根（`kb/…`） */
  rel: string
  title: string
  tags: string[]
  /** 仓库自己的口径（draft / reviewed…），应用不解释它 */
  status: string
  created: string
  updated: string
  summary: string
  /** frontmatter 的 source，归一化后（统一 `/` 分隔）；没写是空串 */
  source: string
  mtimeMs: number
}

/** 一个原始数据文件与它的入库状态 */
export interface KbRawItem {
  /** 相对知识库根（`data/raw/…`） */
  rel: string
  name: string
  /** 小写后缀（不带点）；没有后缀（含点开头的名字）是空串 */
  ext: string
  mtimeMs: number
  status: KbRawStatus
  /** 指向它的条目（kb 相对路径），按修改时间新的在前 */
  entryRels: string[]
}

/** index.json 里应用关心的两样 */
export interface KbIndexInfo {
  /** 生成日期（YYYY-MM-DD，脚本写下的） */
  generatedAt: string
  /** 脚本数出来的条目数（与实际条目数对不上 = 索引待重建） */
  count: number
}

// ---------- frontmatter ----------

/** 从条目 frontmatter 提取的七样；没写的是空值 */
export interface KbFrontmatter {
  title: string
  tags: string[]
  status: string
  created: string
  updated: string
  summary: string
  source: string
}

/**
 * 解析条目的 frontmatter，提取七样元数据。
 *
 * 与 skills.ts 的 parseSkillFrontmatter 同一条路数：只认「首行 `---` 围栏、每行一个
 * `键: 值`」的最小集合，tags 额外认 `[a, b]` 列表写法（这就是仓库自己的脚本认的那种）。
 * 多行块标量不带内容，如实丢掉；解析失败（没有 frontmatter）回全空 —— **不是错误**：
 * 没有元数据的条目照样列出来，标题回落文件名。
 */
export function parseKbFrontmatter(text: string): KbFrontmatter {
  const empty: KbFrontmatter = {
    title: '',
    tags: [],
    status: '',
    created: '',
    updated: '',
    summary: '',
    source: ''
  }
  if (typeof text !== 'string') return empty

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  // 围栏前允许空行；第一行非空行必须是 `---`
  let index = 0
  while (index < lines.length && !lines[index].trim()) index += 1
  if (lines[index]?.trim() !== '---') return empty
  index += 1

  const result: KbFrontmatter = { ...empty, tags: [] }
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '---' || line === '...') break

    const match = /^(title|tags|status|created|updated|summary|source)\s*:\s*(.*)$/.exec(line)
    if (!match) continue

    const value = match[2].trim()
    // 多行块标量的开头（`|` / `>` 及其变体）：内容在后面几行的缩进里，这里不认
    if (/^[|>][+-]?$/.test(value)) continue

    switch (match[1]) {
      case 'title':
        result.title = unquoteScalar(value)
        break
      case 'tags':
        result.tags = parseTagList(value)
        break
      case 'status':
        result.status = unquoteScalar(value)
        break
      case 'created':
        result.created = unquoteScalar(value)
        break
      case 'updated':
        result.updated = unquoteScalar(value)
        break
      case 'summary':
        result.summary = unquoteScalar(value)
        break
      case 'source':
        result.source = unquoteScalar(value)
        break
    }
  }
  return result
}

/** tags 的两种写法都认：`[a, b]` 列表，或单个裸标量（一个标签时容易那么写） */
function parseTagList(value: string): string[] {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => unquoteScalar(part.trim()))
      .filter(Boolean)
  }
  const single = unquoteScalar(value)
  return single ? [single] : []
}

/** 去掉一层成对的引号（YAML 单引号 / 双引号） */
function unquoteScalar(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

// ---------- 清单拆分 ----------

/**
 * 归一化 frontmatter 的 source，让它能与扫描清单配对：统一 `/` 分隔、去掉 `./` 与
 * 首尾空白。它**不判断**这个值是不是一条仓库路径 —— source 本来也允许是链接、书名
 * （见仓库的条目格式规范），配不上的条目自然不会参与状态判定。
 */
export function normalizeKbSource(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
}

/** 扫描清单里的条目文件：`kb/` 下的 `.md`，`_catalog.md` 不算（它是脚本生成的目录） */
export function kbEntryFiles(entries: KbScanEntry[]): KbScanEntry[] {
  return entries.filter(
    (entry) =>
      !entry.isDir &&
      entry.rel.startsWith(`${KB_DIR}/`) &&
      entry.name.toLowerCase().endsWith('.md') &&
      entry.name !== KB_CATALOG_NAME
  )
}

/** 扫描清单里的原始数据：`data/raw/` 下的文件，任意后缀（资料可能是 pdf / docx 任何东西） */
export function kbRawFiles(entries: KbScanEntry[]): KbScanEntry[] {
  return entries.filter((entry) => !entry.isDir && entry.rel.startsWith(`${KB_RAW_DIR}/`))
}

/** 按相对路径排（条目清单与原始数据清单都是它）：目录自然聚在一起，同层按名字 */
export function compareKbRel(a: { rel: string }, b: { rel: string }): number {
  return collator.compare(a.rel, b.rel)
}

/** 后缀：小写、不带点；没有后缀（含 `.gitignore` 这种点开头的名字）是空串 */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// ---------- 状态判定 ----------

/**
 * 给原始数据配上入库状态。
 *
 * 配对键认两种 source 写法：带 `data/raw/` 前缀的完整相对路径（仓库自己的条目这么写），
 * 或直接相对 `data/raw` 的路径；大小写不敏感（Windows 的文件系统本来就分不清）。
 * 「有更新」比较的是原始文件与指向它的条目里**最新**那份的修改时间 —— 一拆多的条目
 * 总会一起重写，最新的那份都旧于原始文件才算真的落后了。
 */
export function matchKbRawStatus(rawFiles: KbScanEntry[], kbEntries: KbEntryMeta[]): KbRawItem[] {
  const byFull = new Map<string, KbEntryMeta[]>()
  const byInner = new Map<string, KbEntryMeta[]>()
  for (const entry of kbEntries) {
    const source = normalizeKbSource(entry.source).toLowerCase()
    if (!source) continue
    pushEntry(byFull, source, entry)
    // 不带前缀的 source（直接相对 data/raw 的写法）进的就是内层键本尊
    const inner = source.startsWith(`${KB_RAW_DIR}/`) ? source.slice(KB_RAW_DIR.length + 1) : source
    pushEntry(byInner, inner, entry)
  }

  return rawFiles.map((file) => {
    const key = file.rel.toLowerCase()
    const linked =
      byFull.get(key) ?? byInner.get(key.slice(KB_RAW_DIR.length + 1)) ?? []
    const newest = linked.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0)
    const status: KbRawStatus =
      linked.length === 0 ? 'pending' : newest < file.mtimeMs ? 'stale' : 'synced'
    return {
      rel: file.rel,
      name: file.name,
      ext: extOf(file.name),
      mtimeMs: file.mtimeMs,
      status,
      entryRels: [...linked].sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.rel)
    }
  })
}

function pushEntry(map: Map<string, KbEntryMeta[]>, key: string, entry: KbEntryMeta): void {
  const list = map.get(key)
  if (list) list.push(entry)
  else map.set(key, [entry])
}

// ---------- 统计与指令 ----------

/** 概览上的几个数：条目总数、草稿数，原始数据总数与其中未入库 / 有更新的两个数 */
export interface KbStats {
  entries: number
  drafts: number
  raws: number
  pending: number
  stale: number
}

export function kbStats(entries: KbEntryMeta[], rawItems: KbRawItem[]): KbStats {
  return {
    entries: entries.length,
    drafts: entries.filter((entry) => entry.status === 'draft').length,
    raws: rawItems.length,
    pending: rawItems.filter((item) => item.status === 'pending').length,
    stale: rawItems.filter((item) => item.status === 'stale').length
  }
}

/** 标签分布：按数量降序、同数按名字，界面取前几名展示 */
export function kbTagCounts(entries: KbEntryMeta[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag))
}

/**
 * 整理指令：复制给知识库仓库里的 Agent 用的一段话。
 *
 * 整理成什么样是那个仓库自己的规范说了算，这里只交代三件事 —— 去哪儿拿原始数据、
 * 待处理的有多少（一个都没有时也明说，省得 Agent 白跑）、整理完要重建索引。
 * 索引脚本的名字写全：这是仓库自己的约定，Agent 进了仓库照着跑就行。
 */
export function kbOrganizeInstruction(pending: number, stale: number): string {
  const counts = [pending > 0 ? `${pending} 个未入库` : '', stale > 0 ? `${stale} 个有更新` : '']
    .filter(Boolean)
    .join('、')
  return [
    '请整理本知识库 data/raw 下的原始资料：按 kb/00-使用规范/条目格式规范.md 的格式拆分入库到 kb/，',
    '条目 frontmatter 的 source 填原始文件的相对路径（如 data/raw/xxx.md）。',
    counts ? `当前待处理：${counts}。` : '当前没有待处理的原始数据。',
    '完成后运行 py scripts/build_index.py 重建目录与索引。'
  ].join('\n')
}

// ---------- 索引 ----------

/**
 * index.json 的解析：只取应用关心的两样（生成日期、条目数）。
 *
 * 认不出的形状（文件不在 / 不是这份脚本写的 / 写坏了）返回 null —— **不是错误**：
 * 界面降级成「索引还没生成」，条目清单照常工作（它是扫出来的，不依赖索引）。
 */
export function parseKbIndex(text: string): KbIndexInfo | null {
  try {
    const raw = JSON.parse(text) as { generated_at?: unknown; count?: unknown } | null
    if (!raw || typeof raw !== 'object') return null
    const generatedAt = typeof raw.generated_at === 'string' ? raw.generated_at : ''
    const count = typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : -1
    if (!generatedAt || count < 0) return null
    return { generatedAt, count }
  } catch {
    return null
  }
}

/**
 * 本机时区的今天（`YYYY-MM-DD`）：重建索引时写进 `generated_at` 的就是它。
 *
 * 口径与仓库脚本的 `date.today()` 一致（本机时区，不是 UTC）—— 所以由渲染层算好交给
 * Rust，而不是让 Rust 自己从时间戳推（那边要么引一个日期库，要么就得自己处理时区）。
 */
export function todayIsoDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
