import type { NoteRepoState, NoteSyncInput, NoteSyncSummary } from '@workbench/notes'
/**
 * 知识库（kb）：仓库里物理分两层的独立项目 —— `raw/` 放**原始数据**、`data/` 放**清洗后的
 * 条目与生成物**（条目 frontmatter 的 source 指回 raw 里的文件、`data/index.json` 由应用
 * 重建，见 Rust 侧 kb.rs 的 index_build）。**仓库是纯数据**：没有脚本、没有 Agent 说明文件，
 * 清洗由应用全程编排（指令在 kb-clean.ts，编排与收尾在 stores/kb.ts）。
 *
 * **列表数据来自远程仓库**：知识库清单住仓库里的 `raw/kb.json`（见 KbManifestEntry），
 * pull 下来解析它就得到列表 —— 应用在添加 / 删除知识库时维护这份清单并随仓库同步。
 * 一个「知识库」= `raw/` 下一个子目录；本机哪台设备给某个知识库关联了源头文件夹
 * （见 KbSourceLink）只有那台机器知道：关联只落本机设置、不随仓库走，没有关联的设备
 * 直接用仓库里的 raw 副本（只读）。
 *
 * **清洗的硬前置是把原始文件上传远程仓库**（编排见 stores/kb.ts）—— raw 层进了仓库，
 * 条目的 source 因此写**仓库内的逻辑路径** `raw/<知识库名>/<内层>`，不再有「库外来源 +
 * 绝对路径」那套映射。读文件 / 算指纹只认仓库内的 `raw/` 与 `data/`；扫描 additionally
 * 顺路对**本机关联的源头文件夹**算指纹（状态判定「本地为准」用，见 matchKbRawStatus）。
 *
 * 「有没有更新」的判据是**内容指纹**：条目 frontmatter 的 `source_hash`（SHA-256）与当前
 * 文件比对 —— 没有条目指向 = 未入库；哈希不同 = 有更新；旧条目没有 `source_hash` 时回落
 * mtime（原始文件比指向它的最新条目还新 = 有更新）。git 操作会重写 mtime，指纹才是跨设备
 * 的准确判据；口径要换时只改这里。
 */
import { dayKey } from '@workbench/core'
import { sanitizeNoteRoot } from '@workbench/notes'

/** 同步与仓库探测复用笔记那两条通道的形状（本来就是「对任意文件夹、认它自己的 origin」的） */
export type KbSyncInput = NoteSyncInput
export type KbSyncSummary = NoteSyncSummary
export type KbRepoState = NoteRepoState

/** 原始数据层（相对知识库根）：物理目录，进同步 */
export const KB_RAW_DIR = 'raw'
/** 清洗数据层（相对知识库根）：条目 + 生成物 */
export const KB_DATA_DIR = 'data'
/** 清单配置文件（相对知识库根）：知识库列表的数据源，应用维护 */
export const KB_MANIFEST_REL = 'raw/kb.json'
/** 机器可读索引（相对知识库根；由应用重建，见 kb.rs 的 index_build） */
export const KB_INDEX_REL = 'data/index.json'
/** 全库目录：应用重建的生成物，条目清单里不算它 */
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
  /**
   * 这个条目实际在磁盘上的绝对路径。raw / data 都在仓库里，它就是「根 + rel」；
   * 统一由 Rust 带回来，渲染层不自己拼路径规则（打开文件、清洗清单里给 Pi 读的地址都用它）。
   * 认不出来时是空串（测试里造清单时也常常不填）。
   */
  abs?: string
}

/** 原始数据的入库状态 */
export type KbRawStatus = 'pending' | 'stale' | 'synced'

/** 一个条目的元数据（frontmatter + 扫描信息） */
export interface KbEntryMeta {
  /** 相对知识库根（`data/…`） */
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
  /**
   * frontmatter 的 source_hash：上一次清洗时原始文件的内容指纹（SHA-256 十六进制）；
   * 没写（旧条目）是空串 —— 状态判定到时回落 mtime。
   */
  sourceHash: string
  mtimeMs: number
}

/** 一个原始数据文件与它的入库状态 */
export interface KbRawItem {
  /** 相对知识库根（`raw/…`） */
  rel: string
  name: string
  /** 小写后缀（不带点）；没有后缀（含点开头的名字）是空串 */
  ext: string
  mtimeMs: number
  /**
   * 这个文件的真实绝对路径：**有关联且本地有这份时是本机源头那份**（查看、外部打开、
   * 清洗清单都落它上），否则是仓库里那份（根下）
   */
  abs: string
  status: KbRawStatus
  /** 指向它的条目（data 相对路径），按修改时间新的在前 */
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

/** 从条目 frontmatter 提取的八样；没写的是空值 */
export interface KbFrontmatter {
  title: string
  tags: string[]
  status: string
  created: string
  updated: string
  summary: string
  source: string
  sourceHash: string
}

/**
 * 解析条目的 frontmatter，提取八样元数据。
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
    source: '',
    sourceHash: '',
  }
  if (typeof text !== 'string')
    return empty

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  // 围栏前允许空行；第一行非空行必须是 `---`
  let index = 0
  while (index < lines.length && !lines[index].trim()) index += 1
  if (lines[index]?.trim() !== '---')
    return empty
  index += 1

  const result: KbFrontmatter = { ...empty, tags: [] }
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '---' || line === '...')
      break

    const match = /^(title|tags|status|created|updated|summary|source|source_hash)\s*:\s*(.*)$/.exec(line)
    if (!match)
      continue

    const value = match[2].trim()
    // 多行块标量的开头（`|` / `>` 及其变体）：内容在后面几行的缩进里，这里不认
    if (/^[|>][+-]?$/.test(value))
      continue

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
      case 'source_hash':
        result.sourceHash = unquoteScalar(value)
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
      .map(part => unquoteScalar(part.trim()))
      .filter(Boolean)
  }
  const single = unquoteScalar(value)
  return single ? [single] : []
}

/** 去掉一层成对的引号（YAML 单引号 / 双引号） */
function unquoteScalar(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))
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
  if (typeof raw !== 'string')
    return ''
  return raw
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
}

/**
 * 扫描清单里的条目文件：`data/` 下的 `.md`，`_catalog.md` 不算（它是应用生成的目录）。
 * 遗留的 `data/raw/`（旧结构的库内原始副本）也不算条目 —— 那一层是历史遗留，迁移前
 * 就完全忽略（见 kb.md）。
 */
export function kbEntryFiles(entries: KbScanEntry[]): KbScanEntry[] {
  const legacy = `${KB_DATA_DIR}/${KB_RAW_DIR}/`
  return entries.filter(
    (entry) => {
      if (entry.isDir || !entry.rel.startsWith(`${KB_DATA_DIR}/`))
        return false
      if (entry.rel.toLowerCase().startsWith(legacy))
        return false
      return entry.name.toLowerCase().endsWith('.md') && entry.name !== KB_CATALOG_NAME
    },
  )
}

/**
 * 扫描清单里的原始数据：`raw/` 下的文件，任意后缀（资料可能是 pdf / docx 任何东西）。
 * 清单文件 `raw/kb.json` 不算 —— 它是列表的数据源（应用自己维护的配置），
 * 不属于任何知识库，进了清单就成了一条永远「未入库」的幽灵行。
 */
export function kbRawFiles(entries: KbScanEntry[]): KbScanEntry[] {
  return entries.filter(
    entry =>
      !entry.isDir
      && entry.rel.startsWith(`${KB_RAW_DIR}/`)
      && entry.rel.toLowerCase() !== KB_MANIFEST_REL,
  )
}

/** 按相对路径排（条目清单与原始数据清单都是它）：目录自然聚在一起，同层按名字 */
export function compareKbRel(a: { rel: string }, b: { rel: string }): number {
  return collator.compare(a.rel, b.rel)
}

/**
 * 树里所有目录节点的 id：筛选时整棵树默认摊开用（folder 才有展开态）。
 * 知识库树（kb 行 + 目录 + 文件）一种节点形状吃（只看 id、kind 与 children）
 */
export function kbTreeFolderIds<T extends { id: string, kind: 'folder' | 'file', children: T[] }>(
  nodes: T[],
): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    if (node.kind === 'folder') {
      ids.push(node.id)
      ids.push(...kbTreeFolderIds(node.children))
    }
  }
  return ids
}

// ---------- 清单（raw/kb.json：知识库列表的数据源） ----------

/** 清单里的一条知识库：名字即 `raw/` 下的目录名 */
export interface KbManifestEntry {
  name: string
  /** 添加日期（YYYY-MM-DD，应用写下的） */
  created: string
}

/**
 * 解析清单文件（`raw/kb.json`）的文本。
 *
 * 认不出的形状（文件不在 / 不是 JSON / kbs 不是数组）返回 null —— **不是错误**：
 * 界面按「还没有清单」处理（老仓库迁移前就是这个样子）。条目逐条收敛：没有名字的丢掉、
 * 同名去重（Windows 的目录名分不清大小写，忽略大小写也算同名）、按出现顺序保留。
 */
export function parseKbManifest(text: string): KbManifestEntry[] | null {
  if (typeof text !== 'string' || !text.trim())
    return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null
  const list = (raw as { kbs?: unknown }).kbs
  if (!Array.isArray(list))
    return null

  const out: KbManifestEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      continue
    const name = sanitizeKbName((item as { name?: unknown }).name)
    if (!name)
      continue
    const key = name.toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    const created = (item as { created?: unknown }).created
    out.push({ name, created: typeof created === 'string' ? created : '' })
  }
  return out
}

/** 清单 → 文件文本（应用维护：添加 / 删除知识库时整体重写，见 kb.rs 的 config_write） */
export function serializeKbManifest(entries: KbManifestEntry[]): string {
  const kbs: KbManifestEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const name = sanitizeKbName(entry.name)
    if (!name)
      continue
    const key = name.toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    kbs.push({ name, created: typeof entry.created === 'string' ? entry.created : '' })
  }
  return `${JSON.stringify({ version: 1, kbs }, null, 2)}\n`
}

// ---------- 知识库（列表最外层） ----------

/**
 * 一条「知识库 ↔ 本机源头文件夹」的关联（住在设置里，只对本机成立）。
 *
 * 关联是**添加知识库**时定下的：本机那个文件夹是源头，应用把它的内容复制进
 * `raw/<名字>/` 并上传。没有关联的设备（别的机器添加的知识库）直接用仓库里的 raw
 * 副本 —— 只读，删除 / 清洗文件的入口不出。路径只对本机成立，所以它住在数据文件里、
 * 不进 theme.json、不参与外观同步。
 */
export interface KbSourceLink {
  /** 这条关联属于哪个知识库根（用户挑的那个目录）：知识库名在不同知识库里可以重名 */
  root: string
  /** 知识库名：`raw/<名字>` 的那一段，也是条目 frontmatter 的 source 引用的那一截 */
  name: string
  /** 源头文件夹在本机的绝对路径；空串 = 还没配（配置残留，照「没关联」处理） */
  dir: string
}

/** 知识库名的长度上限：够放下常见的文件夹名，又不至于把列表撑破 */
export const KB_NAME_MAX = 60

/**
 * 收敛知识库名。它是 `raw/` 下**真实目录名**的一段，所以挡分隔符与 `.` / `..`
 * （前者会让路径跑到别处，后者会指到仓库外面）；其余（中文、空格、点开头的名字）
 * 原样留着。名字定了不给改名（它是条目 source 与目录的契约，换名走「删除 + 重新添加」）。
 */
export function sanitizeKbName(raw: unknown): string {
  if (typeof raw !== 'string')
    return ''
  // 控制字符（目录名里本来就不该有）先摘掉，再判分隔符
  const clean = raw.replace(/[\u0000-\u001F]/g, '').trim()
  if (!clean || clean === '.' || clean === '..' || /[\\/]/.test(clean))
    return ''
  return clean.slice(0, KB_NAME_MAX)
}

/** 路径归一成「判等用」的形状：统一斜杠、去尾斜杠、小写（Windows 的文件系统分不清大小写） */
function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** dir 是不是就在这个知识库文件夹里（等于它、或在它下面）：那样复制就是自己拷自己 */
export function isInsideKbRoot(dir: string, root: string): boolean {
  const base = pathKey(root)
  const target = pathKey(dir)
  if (!base || !target)
    return false
  return target === base || target.startsWith(`${base}/`)
}

/**
 * 收敛设置里的关联清单（磁盘上的可能是旧版本写的或手工改坏的）：
 * root 与 name 缺一不可，路径按笔记文件夹同一套收敛；同一个知识库里**知识库名不重复**
 * （**精确比较**：`Mu-UI` 与 `mu-ui` 是两个知识库）、**同一个文件夹不挂两个名字**
 * （重复的那条保留名字、按「没关联」处理）；路径指到知识库文件夹自己或它里面的一律不认
 * （复制会自己拷自己）。
 */
export function sanitizeKbSourceLinks(raw: unknown): KbSourceLink[] {
  if (!Array.isArray(raw))
    return []

  const out: KbSourceLink[] = []
  const names = new Set<string>()
  const dirs = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      continue
    const record = item as Record<string, unknown>
    const root = sanitizeNoteRoot(record.root)
    const name = sanitizeKbName(record.name)
    if (!root || !name)
      continue

    const nameKey = `${pathKey(root)}\u0000${name}`
    if (names.has(nameKey))
      continue
    names.add(nameKey)

    let dir = sanitizeNoteRoot(record.dir)
    if (dir && isInsideKbRoot(dir, root))
      dir = ''
    if (dir) {
      const dirKey = `${pathKey(root)}\u0000${pathKey(dir)}`
      if (dirs.has(dirKey))
        dir = ''
      else dirs.add(dirKey)
    }
    out.push({ root, name, dir })
  }
  return out
}

/** 当前知识库根配的那些关联：知识库名在不同知识库里可以重名，所以按根过滤 */
export function kbSourceLinksFor(links: KbSourceLink[], root: string): KbSourceLink[] {
  const key = pathKey(root)
  if (!key)
    return []
  return links.filter(link => pathKey(link.root) === key)
}

/** 两个知识库根是不是同一个（分隔符与大小写不敏感）：改 / 删关联时按它认自己那几条 */
export function sameKbRoot(a: string, b: string): boolean {
  const left = pathKey(a)
  return !!left && left === pathKey(b)
}

// ---------- 名称核对（添加知识库时实时比对） ----------

/** 编辑距离（Levenshtein）：知识库名很短，逐字算的成本可以忽略 */
function kbNameDistance(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  if (!left.length)
    return right.length
  if (!right.length)
    return left.length

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

/** 名称核对的结果（添加知识库时实时比对，见 KbAddDialog） */
export type KbSourceNameHintKind = 'empty' | 'exact' | 'case' | 'close' | 'new'

export interface KbSourceNameHint {
  kind: KbSourceNameHintKind
  /** case / close 时给出清单里的那个精确写法（可以一键采用） */
  suggestion: string
  /** close 时的编辑距离（其余是 0） */
  distance: number
}

/**
 * 添加知识库时的名称核对：依据是**远程清单里已有的名字**（跨设备唯一看得见的参照）。
 * 四条口径：
 *  - 完全一致：清单里已有这个名字 —— 名字即目录，同名就是同一个知识库，添加时拦住；
 *  - 忽略大小写相等但不精确相等：警告，并给出清单里的精确写法；
 *  - 编辑距离 ≤ 2（大小写不敏感比较）：警告可能是笔误，给出最接近的名字；
 *  - 其他：当新知识库，不提示。
 * 清单还没有任何名字时 referenced 为空，输入什么都是 new。
 */
export function kbSourceNameHint(raw: string, referenced: string[]): KbSourceNameHint {
  const name = sanitizeKbName(raw)
  if (!name)
    return { kind: 'empty', suggestion: '', distance: 0 }
  if (referenced.includes(name))
    return { kind: 'exact', suggestion: name, distance: 0 }

  const lower = name.toLowerCase()
  const sameIgnoreCase = referenced.find(item => item.toLowerCase() === lower)
  if (sameIgnoreCase)
    return { kind: 'case', suggestion: sameIgnoreCase, distance: 0 }

  let best = ''
  let bestDistance = Number.POSITIVE_INFINITY
  for (const item of referenced) {
    const distance = kbNameDistance(lower, item.toLowerCase())
    if (distance < bestDistance) {
      best = item
      bestDistance = distance
    }
  }
  if (best && bestDistance <= 2)
    return { kind: 'close', suggestion: best, distance: bestDistance }
  return { kind: 'new', suggestion: '', distance: bestDistance }
}

// ---------- 配对（条目 source ↔ raw 文件） ----------

/** 逻辑路径里 `raw/` 那一段之后的部分（前缀按文件系统习惯不敏感）；不在原始数据区时回空串 */
function rawInnerOf(rel: string): string {
  const prefix = `${KB_RAW_DIR}/`
  if (rel.length <= prefix.length || rel.slice(0, prefix.length).toLowerCase() !== prefix)
    return ''
  return rel.slice(prefix.length)
}

/**
 * 一个逻辑路径拆成「知识库名 + 库内路径」：`raw/mu-ui/a/b.md` 与简写的
 * `mu-ui/a/b.md` 都认（条目 source 可以不带前缀）。知识库名那一段**精确**（大小写敏感）；
 * 内层是文件系统路径，比较时按 Windows 口径不敏感。不是这个形状（直接在 raw 下、
 * 条目、索引、链接书名）回 null。
 */
export interface KbSourceRef {
  name: string
  inner: string
}

export function kbSourceRef(value: string): KbSourceRef | null {
  const rel = normalizeKbSource(value)
  // 网址 / mailto 这类出处不是仓库路径（source 允许写书名、链接）
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel))
    return null
  const inner = rawInnerOf(rel) || rel
  const cut = inner.indexOf('/')
  if (cut <= 0 || cut === inner.length - 1)
    return null
  return { name: inner.slice(0, cut), inner: inner.slice(cut + 1) }
}

/**
 * 一个**原始数据文件**（`raw/…`）逻辑路径属于哪个知识库；不是这个形状回空串。
 * 与 kbSourceRef 的区别：这里不认「不带前缀」的简写 —— 文件清单永远是完整逻辑路径。
 */
export function kbRawSourceNameOf(rel: string): string {
  const inner = rawInnerOf(normalizeKbSource(rel))
  const cut = inner.indexOf('/')
  return cut > 0 ? inner.slice(0, cut) : ''
}

/** 配对键：知识库名精确 + 内层路径按 Windows 口径小写 */
function sourceFileKey(name: string, inner: string): string {
  return `${name}\u0000${inner.replace(/\\/g, '/').toLowerCase()}`
}

/**
 * 逻辑路径（`raw/<知识库名>/…` 或简写的 `<知识库名>/…`）→ 配对键。
 * 知识库名精确、内层路径不敏感；不是仓库路径（没有知识库名那一段）回空串。
 * 条目 source 与 raw 文件 rel 都用它算，两边相等即配对。
 */
export function kbSourceLinkKey(value: string): string {
  const ref = kbSourceRef(value)
  return ref ? sourceFileKey(ref.name, ref.inner) : ''
}

// ---------- 扫描结果与列表行 ----------

/**
 * 本机源头文件夹里扫出来的一条（**有关联的知识库才有**）：内容指纹拿去和条目的
 * `source_hash` 比 —— 「本机改了没洗」靠它而不是 mtime（git 会重写 mtime）。
 * `name` 是知识库名（`raw/<名字>` 的那一段），`rel` 是源头文件夹内的相对路径，
 * `abs` 是本机绝对路径；指纹读不出是空串（按「没有本地数据」处理）。
 */
export interface KbLocalFile {
  name: string
  rel: string
  mtimeMs: number
  hash: string
  abs: string
}

/** kb_scan 回来的一整份：平铺清单 + 清单文件的原文（没有就是空串）+ 源头文件夹指纹 */
export interface KbScanResult {
  entries: KbScanEntry[]
  manifest: string
  local: KbLocalFile[]
}

/** 左栏列表最外层的一行：一个知识库（清单里的一条） */
export interface KbLibraryRow {
  name: string
  /** 本机关联的源头文件夹绝对路径；空串 = 没有关联（别的设备添加的，只读仓库里的副本） */
  dir: string
  files: number
  pending: number
  stale: number
  /**
   * 失联的原始文件数（该知识库下）：每次重扫的**派生值**，不落盘、不进状态机。
   * 0 之外才有清理入口。
   */
  deleted: number
}

/** 清单 + 本机关联 → 列表行：把 items 按知识库名归到行上数出「未入库 / 有更新」，失联数出「已删除」 */
export function kbLibraryRows(
  manifest: KbManifestEntry[],
  links: KbSourceLink[],
  items: KbRawItem[],
  dangling: KbDanglingGroup[] = [],
): KbLibraryRow[] {
  const dirOf = new Map(links.filter(link => link.dir).map(link => [link.name, link.dir]))
  const rows: KbLibraryRow[] = manifest.map(entry => ({
    name: entry.name,
    dir: dirOf.get(entry.name) ?? '',
    files: 0,
    pending: 0,
    stale: 0,
    deleted: 0,
  }))

  const byName = new Map(rows.map(row => [row.name.toLowerCase(), row]))
  for (const item of items) {
    const row = byName.get(kbRawSourceNameOf(item.rel).toLowerCase())
    if (!row)
      continue
    row.files += 1
    if (item.status === 'pending')
      row.pending += 1
    else if (item.status === 'stale')
      row.stale += 1
  }

  for (const group of dangling) {
    const row = byName.get(group.source.toLowerCase())
    if (row)
      row.deleted += 1
  }

  return rows
}

/**
 * 失联的一组：一个 raw 文件（按逻辑路径）与指向它的那些条目。
 *
 * 判定条件（两条同时成立）：条目的 `source` 解析到**清单里已有的知识库**、
 * 扫描清单里确实找不到这个文件。raw 就在仓库里，不存在「盘不在 / 文件夹被删」那种
 * 分不清的情形 —— 扫描成功而文件不在，就是真的不在（多半是别的设备删了，pull 下来后
 * 条目还在）。
 */
export interface KbDanglingGroup {
  /** 知识库名（精确） */
  source: string
  /** 那个 raw 文件的完整逻辑路径（`raw/<知识库名>/…`） */
  rel: string
  /** 指向它的条目（data 相对路径） */
  entryRels: string[]
}

/**
 * 找出失联的条目并按 raw 文件分组（一个 raw 文件一组）。
 *
 * `source` 写成书名 / 网址 / 非仓库路径的条目，以及没有 source 的条目不进清理逻辑；
 * 指向的知识库名不在清单里（清单没它）也不进 —— 那种条目按「出处写得不对」处理，
 * 不给删除入口。大小写：知识库名精确，内层路径不敏感。
 */
export function kbDanglingGroups(
  entries: KbEntryMeta[],
  items: KbRawItem[],
  libraryNames: string[],
): KbDanglingGroup[] {
  const known = new Set(libraryNames)
  const present = new Set(items.map(item => kbSourceLinkKey(item.rel)))
  const groups = new Map<string, KbDanglingGroup>()

  for (const entry of entries) {
    const ref = kbSourceRef(entry.source)
    if (!ref || !known.has(ref.name))
      continue
    const key = sourceFileKey(ref.name, ref.inner)
    if (present.has(key))
      continue

    const rel = `${KB_RAW_DIR}/${ref.name}/${ref.inner}`
    const group = groups.get(rel) ?? {
      source: ref.name,
      rel,
      entryRels: [],
    }
    if (!group.entryRels.includes(entry.rel))
      group.entryRels.push(entry.rel)
    groups.set(rel, group)
  }

  return [...groups.values()].sort((a, b) => collator.compare(a.rel, b.rel))
}

// ---------- 知识库树 ----------

/** 知识库树的一个节点：知识库行 / 目录 / 文件（左栏那棵树的数据形状） */
export interface KbRawTreeNode {
  /**
   * el-tree 的 node-key，全树唯一：知识库行是名字，目录是相对 `raw` 的目录路径
   * （`mu-ui/子目录`），文件是完整 rel（`raw/mu-ui/button.md`）—— 前缀不同，撞不上。
   */
  id: string
  /** 行上显示的名字：知识库行与目录是名字，文件是文件名（带后缀） */
  name: string
  kind: 'folder' | 'file'
  children: KbRawTreeNode[]
  /** 文件节点带上的原始数据（目录节点没有）：状态、指向它的条目、修改时间都在里面 */
  item?: KbRawItem
  /** **知识库行**（最外层那些才有）：它关联到哪儿、有几个数 */
  library?: KbLibraryRow
}

/**
 * 把原始数据清单按 `raw/` 下的目录结构收成树，最外层是**知识库**（清单里的一条）：
 * rel 就是它在仓库里的位置，树照着它长，目录在前、同层按名字排；搜索 / 状态筛选
 * 在过滤后的清单上再调一次，就得到「只含筛出项」的树。清单里没有的知识库不占行，
 * raw 里有文件但清单没登记的也摆不出来（列表数据来自清单，见模块注释）。空清单回空树。
 */
export function kbRawTree(items: KbRawItem[], libraries: KbLibraryRow[] = []): KbRawTreeNode[] {
  const root: KbRawTreeNode = { id: '', name: '', kind: 'folder', children: [] }

  for (const library of libraries) {
    root.children.push({
      id: library.name,
      name: library.name,
      kind: 'folder',
      children: [],
      library,
    })
  }

  for (const item of items) {
    const inner = item.rel.startsWith(`${KB_RAW_DIR}/`)
      ? item.rel.slice(KB_RAW_DIR.length + 1)
      : item.rel
    const segments = inner.split('/')
    const name = segments.pop()
    if (!name)
      continue

    let parent = root
    for (const segment of segments) {
      let folder = parent.children.find(node => node.kind === 'folder' && node.name === segment)
      if (!folder) {
        folder = {
          id: parent.id ? `${parent.id}/${segment}` : segment,
          name: segment,
          kind: 'folder',
          children: [],
        }
        parent.children.push(folder)
      }
      parent = folder
    }
    parent.children.push({ id: item.rel, name: item.name, kind: 'file', children: [], item })
  }

  sortKbTree(root.children)
  return root.children
}

/**
 * 目录在前、同层按名字（数字按值、中文按拼音，与笔记树同一把 collator），逐层递归。
 */
interface KbTreeBranch {
  name: string
  kind: 'folder' | 'file'
  children: KbTreeBranch[]
}

function sortKbTree(nodes: KbTreeBranch[]): void {
  nodes.sort(
    (a, b) =>
      (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || collator.compare(a.name, b.name),
  )
  for (const node of nodes) {
    if (node.children.length)
      sortKbTree(node.children)
  }
}

// ---------- 原始数据查看 ----------

/** 原始数据在应用里怎么「看」：markdown 渲染成正文 / 纯文本预览 / 交给系统默认程序 */
export type KbRawViewKind = 'markdown' | 'text' | 'external'

/** 应用里能就地按纯文本预览的后缀（markdown 单独算一类，不在这里） */
const KB_RAW_TEXT_EXTS = new Set(['txt', 'json', 'csv', 'log', 'xml', 'html', 'htm', 'yaml', 'yml', 'toml'])

/**
 * 按文件名给原始数据挑看法：md / markdown 渲染成正文，认得出的文本后缀按纯文本预览，
 * 剩下的（pdf / docx / 图片…）应用里不预览 —— 就地说明、交给系统默认程序打开。
 * 没有后缀（含点开头的名字）按交出去算：它多半不是文本。
 */
export function kbRawViewKind(name: string): KbRawViewKind {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown')
    return 'markdown'
  if (KB_RAW_TEXT_EXTS.has(ext))
    return 'text'
  return 'external'
}

/** 原始数据状态的界面用词：未入库 / 有更新要催，已入库照实说（清单与查看共用这一份） */
export function kbRawStatusText(status: KbRawStatus): string {
  if (status === 'pending')
    return '未入库'
  if (status === 'stale')
    return '有更新'
  return '已入库'
}

/**
 * 原始文件路径的**界面显示**口径：剥掉 `raw/` 这层仓库内部前缀，显示 `<知识库名>/<内层>`
 * —— `raw/…` 是实现细节（与 data 层的对应关系、上传机制），用户眼里文件就长在知识库
 * 下面。本机路径（abs）另有它自己的显示位，不走这里。不是 raw 形状的原样返回。
 */
export function kbRawDisplayPath(rel: string): string {
  const clean = normalizeKbSource(rel)
  const inner = rawInnerOf(clean)
  return inner || clean
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
 * 配对键认两种 source 写法：带 `raw/` 前缀的完整相对路径（条目这么写），
 * 或不带前缀的 `知识库名/内层`。**知识库名精确**（大小写敏感，跨设备身份键），内层路径
 * 按 Windows 口径不敏感。
 *
 * 「有更新」先比**内容指纹**：原始文件当前的 SHA-256 与指向它的条目里**最新**那份的
 * `source_hash` 是否相同（相同 = 已入库、不同 = 有更新）。旧条目没有 `source_hash`、
 * 或这一轮没算出哈希（读不到）时，回落 mtime —— 原始文件比最新那份条目还新才算落后。
 * 一拆多的条目共享同一个指纹，以最新那份的值为准。
 *
 * hashes 的口径：**只对有条目指向的文件**算（见 kbRawReferencedRels），未入库的文件
 * 不参与哈希比较，也就不会有指纹成本。
 *
 * localFiles 是**本机关联的源头文件夹**里扫出来的指纹（kb_scan 顺路算的）：本地这份
 * 存在就**以本地为准** —— 本地内容与指向它的最新条目的 `source_hash` 不同 = 有更新
 * （本机改了没洗，正是要催的那件事），相同 = 已入库；本地没有这份（没关联、文件夹里
 * 删了、或这轮没算出指纹）时照旧拿仓库里那份（hashes）比。路径与修改时间同样跟着本地
 * 走（abs / mtimeMs 落在本机那份上）。两个代价是既定的：有关联的知识库每次重扫对
 * 源头文件夹整份算 SHA-256；新增的本地文件要等清洗前的源头同步把它带进 raw，
 * 才会在清单上出现。
 */
export function matchKbRawStatus(
  rawFiles: KbScanEntry[],
  kbEntries: KbEntryMeta[],
  hashes: Record<string, string> = {},
  localFiles: KbLocalFile[] = [],
): KbRawItem[] {
  const linked = new Map<string, KbEntryMeta[]>()
  for (const entry of kbEntries) {
    const key = kbSourceLinkKey(entry.source)
    if (!key)
      continue
    pushEntry(linked, key, entry)
  }

  // 本地指纹按配对键收（与 raw 文件同一把尺：知识库名精确 + 内层路径不敏感）；
  // abs 一起带上 —— 有关联时路径要落在本机那份上
  const localHashes = new Map<string, { hash: string, mtimeMs: number, abs: string }>()
  for (const file of localFiles) {
    if (!file.hash)
      continue
    localHashes.set(
      `${file.name}\u0000${file.rel.replace(/\\/g, '/').toLowerCase()}`,
      { hash: file.hash.toLowerCase(), mtimeMs: file.mtimeMs, abs: file.abs },
    )
  }

  return rawFiles.map((file) => {
    const key = kbSourceLinkKey(file.rel)
    const linkedEntries = (key ? linked.get(key) : undefined) ?? []
    const newest = linkedEntries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0)
    const newestEntry = linkedEntries.find(entry => entry.mtimeMs === newest)
    const local = key ? localHashes.get(key) : undefined
    const currentHash = (local?.hash ?? hashes[file.rel] ?? '').toLowerCase()
    const currentMtime = local?.mtimeMs ?? file.mtimeMs
    let status: KbRawStatus
    if (!linkedEntries.length) {
      status = 'pending'
    }
    else if (newestEntry?.sourceHash && currentHash) {
      status = newestEntry.sourceHash.toLowerCase() === currentHash ? 'synced' : 'stale'
    }
    else {
      status = newest < currentMtime ? 'stale' : 'synced'
    }
    return {
      rel: file.rel,
      name: file.name,
      ext: extOf(file.name),
      // 有关联且本地有这份：路径与修改时间都落在**本机那份**上 —— 查看、外部打开、
      // 清洗清单给 Pi 的地址都是它（本机是事实源，仓库副本只是同步的载体）
      mtimeMs: local?.mtimeMs ?? file.mtimeMs,
      abs: local?.abs || file.abs || '',
      status,
      entryRels: [...linkedEntries].sort((a, b) => b.mtimeMs - a.mtimeMs).map(entry => entry.rel),
    }
  })
}

/**
 * 这一轮需要算内容指纹的原始文件：**有条目指向的那些**（未入库的不算）。
 * 入参是扫描清单里的文件与刚读出来的条目元数据；配对口径与 matchKbRawStatus 同一条。
 */
export function kbRawReferencedRels(rawFiles: KbScanEntry[], kbEntries: KbEntryMeta[]): string[] {
  const keys = new Set<string>()
  for (const entry of kbEntries) {
    const key = kbSourceLinkKey(entry.source)
    if (key)
      keys.add(key)
  }
  const rels: string[] = []
  for (const file of rawFiles) {
    const key = kbSourceLinkKey(file.rel)
    if (key && keys.has(key))
      rels.push(file.rel)
  }
  return rels
}

function pushEntry(map: Map<string, KbEntryMeta[]>, key: string, entry: KbEntryMeta): void {
  const list = map.get(key)
  if (list)
    list.push(entry)
  else map.set(key, [entry])
}

// ---------- 统计 ----------

/** 概览上的几个数：条目总数，原始数据总数与其中未入库 / 有更新的两个数 */
export interface KbStats {
  entries: number
  raws: number
  pending: number
  stale: number
}

export function kbStats(entries: KbEntryMeta[], rawItems: KbRawItem[]): KbStats {
  return {
    entries: entries.length,
    raws: rawItems.length,
    pending: rawItems.filter(item => item.status === 'pending').length,
    stale: rawItems.filter(item => item.status === 'stale').length,
  }
}

// ---------- 索引 ----------

/**
 * index.json 的解析：只取应用关心的两样（生成日期、条目数）。
 *
 * 认不出的形状（文件不在 / 不是应用生成的 / 写坏了）返回 null —— **不是错误**：
 * 界面降级成「索引还没生成」，条目清单照常工作（它是扫出来的，不依赖索引）。
 */
export function parseKbIndex(text: string): KbIndexInfo | null {
  try {
    const raw = JSON.parse(text) as { generated_at?: unknown, count?: unknown } | null
    if (!raw || typeof raw !== 'object')
      return null
    const generatedAt = typeof raw.generated_at === 'string' ? raw.generated_at : ''
    const count = typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : -1
    if (!generatedAt || count < 0)
      return null
    return { generatedAt, count }
  }
  catch {
    return null
  }
}

/**
 * 本机时区的今天（`YYYY-MM-DD`）：重建索引时写进 `generated_at`、清洗时写进提示词的都是它。
 *
 * 本机时区，不是 UTC —— 由渲染层算好交给 Rust，而不是让 Rust 自己从时间戳推
 * （那边要么引一个日期库，要么就得自己处理时区）。
 * 实现走 core 的 `dayKey`（活跃度、用量、工作日志的日期键同一条口径），名字留给 kb 自己的语义。
 */
export function todayIsoDate(now: Date = new Date()): string {
  return dayKey(now)
}
