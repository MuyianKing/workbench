import type { NoteRepoState, NoteSyncInput, NoteSyncSummary } from '@workbench/notes'
/**
 * 知识库（kb）：用户在别处维护的一个独立项目 —— 原始资料在 `data/raw/`、整理好的条目在
 * `kb/`（frontmatter 的 source 指回原始文件）、`index/index.json` 由应用重建（Rust 侧
 * kb.rs 的 index_build）。**仓库是纯数据**：没有脚本、没有 Agent 说明文件，清洗由应用
 * 全程编排（指令在 kb-clean.ts，编排与收尾在 stores/kb.ts）。
 *
 * 应用对条目内容**只读**，写的只有生成物（重建索引）。应用负责的是把「哪些还没入库、
 * 哪些原始资料又更新了」算清楚（这些口径都是纯函数，在这里、有单测），清洗就按这份清单
 * 交给内置的 Agent。Rust 侧（kb.rs）只带事实：平铺清单（任意后缀、带 mtime 与绝对路径）
 * 与文件文本。
 *
 * **原始数据的最外层是「来源」**：`data/raw/<来源名>` 这一格对到本机的一个文件夹
 * （见 KbRawSource）—— 为了让外面的资料可见而把它 copy 进库里，那条路不再需要了。
 * 逻辑路径始终是 `data/raw/<来源名>/<内层>`，**不随来源实际在哪儿变** —— 条目 frontmatter
 * 的 source、正文里指向原始资料的相对链接、状态配对全都按逻辑路径走，来源换一个位置
 * 不用改任何条目。没有配过的来源照旧读库里那份（兼容层，见 kbVisibleRawEntries）。
 *
 * 「有没有更新」的判据是**文件修改时间**：条目的 source 归一化后与原始文件配对 ——
 * 没有条目指向 = 未入库；原始文件比指向它的条目里最新的那份还新 = 有更新。
 * 它是个启发式：git 操作（checkout / pull）会重写 mtime，但换状态文件、记同步位标
 * 都比它更脆 —— 它不依赖任何额外状态，重启就对得上。口径要换时只改这里。
 */
import { dayKey } from '@workbench/core'
import { sanitizeNoteRoot } from '@workbench/notes'

/** 同步与仓库探测复用笔记那两条通道（本来就是「对任意文件夹、认它自己的 origin」的），形状照搬 */
export type KbSyncInput = NoteSyncInput
export type KbSyncSummary = NoteSyncSummary
export type KbRepoState = NoteRepoState

/** 原始资料投放区（相对知识库根） */
export const KB_RAW_DIR = 'data/raw'
/** 条目区（相对知识库根） */
export const KB_DIR = 'kb'
/** 机器可读索引（相对知识库根；由应用重建，见 kb.rs 的 index_build） */
export const KB_INDEX_REL = 'index/index.json'
/** 全库目录：应用重建的生成物、阅读的导航入口，条目清单里不算它 */
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
   * 这个条目**实际在磁盘上的绝对路径**。库里的东西就是「根 + rel」；来源里的东西在
   * 用户指定的那个文件夹下，随便怎么算都可能算错 —— 交给 Rust 一起带回来，渲染层
   * 不再自己拼一条路径规则（打开文件、清洗清单里给 Pi 读的地址都用它）。
   * 认不出来时是空串（测试里造清单时也常常不填）。
   */
  abs?: string
  /**
   * 这条事实的出处：`repo` = 知识库文件夹里那一份，`source` = 某个来源文件夹里那一份。
   *
   * **必须分开**：一个来源名配了外部文件夹时，库里那份副本（`repo`）要整棵让位，
   * 而外部那份（`source`）正是要用的那份 —— 光看 rel 两者一模一样，分不出来。
   * 缺省按 `repo` 算（测试里造清单常常不填，那正是「库里那份」的意思）。
   */
  origin?: 'repo' | 'source'
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
  /**
   * 正文里的**站内链接目标**（原始 href，外部地址与锚点已滤掉）：扫描时逐条读出来存下，
   * 之后不用再读一遍正文 —— 巡检的孤儿 / 断链与界面的站内跳转都按它算
   * （认法与解析规则见 [kb-lint.ts](kb-lint.ts) 的 kbEntryLinks / resolveKbLink）。
   */
  links: string[]
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
  /** 这个文件的真实绝对路径（库里的那份就是根下，来源里的在用户指定的文件夹下） */
  abs: string
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
    source: '',
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

    const match = /^(title|tags|status|created|updated|summary|source)\s*:\s*(.*)$/.exec(line)
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

/** 扫描清单里的条目文件：`kb/` 下的 `.md`，`_catalog.md` 不算（它是脚本生成的目录） */
export function kbEntryFiles(entries: KbScanEntry[]): KbScanEntry[] {
  return entries.filter(
    entry =>
      !entry.isDir
      && entry.rel.startsWith(`${KB_DIR}/`)
      && entry.name.toLowerCase().endsWith('.md')
      && entry.name !== KB_CATALOG_NAME,
  )
}

/** 扫描清单里的原始数据：`data/raw/` 下的文件，任意后缀（资料可能是 pdf / docx 任何东西） */
export function kbRawFiles(entries: KbScanEntry[]): KbScanEntry[] {
  return entries.filter(entry => !entry.isDir && entry.rel.startsWith(`${KB_RAW_DIR}/`))
}

/** 按相对路径排（条目清单与原始数据清单都是它）：目录自然聚在一起，同层按名字 */
export function compareKbRel(a: { rel: string }, b: { rel: string }): number {
  return collator.compare(a.rel, b.rel)
}

// ---------- 条目树 ----------

/** 条目树的一个节点：目录或条目（左栏「条目」签那棵树的数据形状） */
export interface KbTreeNode {
  /**
   * el-tree 的 node-key，全树唯一：目录是相对 `kb/` 的目录路径（`01-mu-ui组件库`），
   * 条目是 kb 相对路径（`kb/01-mu-ui组件库/add-button.md`）—— 前缀不同，撞不上。
   * 展开态记的也是它。
   */
  id: string
  /** 行上显示的名字：目录是目录名，条目是 frontmatter 的 title（没有回落文件名） */
  name: string
  kind: 'folder' | 'entry'
  children: KbTreeNode[]
  /** 条目节点带上的 frontmatter status（目录节点没有）；界面拿它标「草稿 / 已核对」 */
  status?: string
}

/**
 * 把条目清单按 `kb/` 下的目录结构收成树。
 *
 * 条目的 rel 就是它在仓库里的位置（`kb/NN-主题名/xxx.md`），树直接照着它长：
 * 目录一层层往下、条目挂在所在目录上。目录排在条目前面、同层按名字排
 * （与笔记树同一副口径）；只在搜索过滤后的清单上再调一次，就能得到「只含匹配项」的树。
 * 输入是空数组就回空树 —— 「库里还没有条目」与「没搜到」由界面各自说话。
 */
export function kbEntryTree(entries: KbEntryMeta[]): KbTreeNode[] {
  const root: KbTreeNode = { id: '', name: '', kind: 'folder', children: [] }

  for (const entryMeta of entries) {
    const inner = entryMeta.rel.startsWith(`${KB_DIR}/`)
      ? entryMeta.rel.slice(KB_DIR.length + 1)
      : entryMeta.rel
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
    parent.children.push({
      id: entryMeta.rel,
      name: entryMeta.title,
      kind: 'entry',
      children: [],
      status: entryMeta.status,
    })
  }

  sortKbTree(root.children)
  return root.children
}

/**
 * 目录在前、同层按名字（数字按值、中文按拼音，与笔记树同一把 collator），逐层递归。
 * 条目树（entry）与原始数据树（file）两种节点的公共骨架，收成一把排
 */
interface KbTreeBranch {
  name: string
  kind: 'folder' | 'entry' | 'file'
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

/**
 * 树里所有目录节点的 id：搜索 / 筛选时整棵树默认摊开用（folder 才有展开态）。
 * 条目树与原始数据树两份节点形状都吃（只看 id、kind 与 children）
 */
export function kbTreeFolderIds<T extends { id: string, kind: 'folder' | 'entry' | 'file', children: T[] }>(
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

/**
 * 一个条目所在的目录链（从最外层排下来，不含条目自己）：选中项换条目时
 * 把它所在的那几层展开用。条目在 `kb/` 最外层时回空数组（没有上一级可展开）。
 */
export function kbFolderChain(rel: string): string[] {
  const inner = rel.startsWith(`${KB_DIR}/`) ? rel.slice(KB_DIR.length + 1) : rel
  const segments = inner.split('/')
  segments.pop()

  const chain: string[] = []
  let acc = ''
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment
    chain.push(acc)
  }
  return chain
}

// ---------- 来源（原始数据最外层对到本机的一个文件夹） ----------

/**
 * 一条来源映射：`data/raw/<名字>` 这最外层的一格，对到本机的一个文件夹。
 *
 * 配置**只是一层映射**：应用不搬运、不复制、不删除任何文件，改的只有「去哪儿读」。
 * 路径只对本机成立（换台机器就不成立），所以它住在数据文件里、不进 theme.json、
 * 不参与外观同步。没有配过的来源照旧读库里的 `data/raw/<名字>`（兼容层）。
 */
export interface KbRawSource {
  /** 这条映射属于哪个知识库（用户挑的那个目录）：来源名在不同知识库里可以重名 */
  root: string
  /** 来源名：逻辑路径 `data/raw/<名字>` 的那一段，也是条目 frontmatter 的 source 引用的那一截 */
  name: string
  /** 来源文件夹在本机的绝对路径；空串 = 还没配（树里照样占一行，可以再指定） */
  dir: string
}

/** 来源名的长度上限：够放下常见的文件夹名，又不至于把树撑破 */
export const KB_RAW_NAME_MAX = 60

/**
 * 收敛来源名。它是**逻辑路径**的一段、不是真实路径的一段，所以只挡分隔符与
 * `.` / `..`（前者会让逻辑路径跑到别处，后者会指到来源根外面）；其余（中文、空格、
 * 点开头的名字）原样留着 —— 库里已经在用的目录名不该因为这里多一条规矩而配不上。
 */
export function sanitizeKbSourceName(raw: unknown): string {
  if (typeof raw !== 'string')
    return ''
  // 控制字符（文件名里本来就不该有）先摘掉，再判分隔符
  const clean = raw.replace(/[\u0000-\u001F]/g, '').trim()
  if (!clean || clean === '.' || clean === '..' || /[\\/]/.test(clean))
    return ''
  return clean.slice(0, KB_RAW_NAME_MAX)
}

/** 路径归一成「判等用」的形状：统一斜杠、去尾斜杠、小写（Windows 的文件系统分不清大小写） */
function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** dir 是不是就在这个知识库文件夹里（等于它、或在它下面）：那读的其实还是库里的 data/raw */
export function isInsideKbRoot(dir: string, root: string): boolean {
  const base = pathKey(root)
  const target = pathKey(dir)
  if (!base || !target)
    return false
  return target === base || target.startsWith(`${base}/`)
}

/**
 * 收敛设置里的来源清单（磁盘上的可能是旧版本写的或手工改坏的）：
 * root 与 name 缺一不可，路径按笔记文件夹同一套收敛；同一个知识库里**来源名不重复**、
 * **同一个文件夹不挂两个名字**（重复的那条保留名字、按「还没配」处理 —— 名字是条目
 * source 的契约，不能悄悄丢掉，用户得在界面上看见它还需要指定）；路径指到知识库
 * 文件夹自己或它里面的一律不认（那是库里的 `data/raw`，不是外部来源）。
 */
export function sanitizeKbRawSources(raw: unknown): KbRawSource[] {
  if (!Array.isArray(raw))
    return []

  const out: KbRawSource[] = []
  const names = new Set<string>()
  const dirs = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      continue
    const record = item as Record<string, unknown>
    const root = sanitizeNoteRoot(record.root)
    const name = sanitizeKbSourceName(record.name)
    if (!root || !name)
      continue

    const nameKey = `${pathKey(root)}\u0000${name.toLowerCase()}`
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

/** 当前知识库配的那些来源：来源名在不同知识库里可以重名，所以按根过滤 */
export function kbRawSourcesFor(sources: KbRawSource[], root: string): KbRawSource[] {
  const key = pathKey(root)
  if (!key)
    return []
  return sources.filter(source => pathKey(source.root) === key)
}

/** 两个知识库根是不是同一个（分隔符与大小写不敏感）：改 / 删来源时按它认自己那几条 */
export function sameKbRoot(a: string, b: string): boolean {
  const left = pathKey(a)
  return !!left && left === pathKey(b)
}

/** 逻辑路径里 `data/raw/` 那一段之后的部分；不在原始资料区时回空串 */
function rawInnerOf(rel: string): string {
  const prefix = `${KB_RAW_DIR}/`
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : ''
}

/**
 * 一个**文件**的逻辑路径属于哪个来源（`data/raw/mu-ui/a/b.md` → `mu-ui`）。
 * 直接躺在 `data/raw` 下的文件（`data/raw/随手记.md`）没有来源，回空串。
 */
export function kbRawSourceNameOf(rel: string): string {
  const inner = rawInnerOf(rel)
  const cut = inner.indexOf('/')
  return cut > 0 ? inner.slice(0, cut) : ''
}

/** 这个条目是不是**库里那份**、且落在某个来源名下（含最外层那个目录自己：它是一条 isDir 的清单项） */
function insideRawSource(entry: KbScanEntry, name: string): boolean {
  // 来源文件夹里扫回来的那一份正是要用的：它的 rel 与库里副本长得一模一样，靠 origin 分
  if (entry.origin === 'source')
    return false
  const inner = rawInnerOf(entry.rel).toLowerCase()
  if (!inner)
    return false
  const target = name.toLowerCase()
  if (inner.startsWith(`${target}/`))
    return true
  return entry.isDir && inner === target
}

/**
 * 把**被映射顶掉的库里副本**从清单里摘掉。
 *
 * 一个来源名配了外部文件夹时，库里 `data/raw/<名字>` 那一棵整棵不看：以映射为准。
 * 不摘的话同一个名字下会同时列出两批文件（甚至同一份资料的两个版本），状态、计数
 * 与清洗清单都会说不清。**来源文件夹扫回来的那些不动**（靠 `origin` 分，见 KbScanEntry）；
 * 库里那份没删就走开这件事，由来源行上的「库里还留着一份」说明（KbRawSourceRow 的
 * shadowed）——**应用不替用户删任何东西**。
 */
export function kbVisibleRawEntries(entries: KbScanEntry[], sources: KbRawSource[]): KbScanEntry[] {
  const names = sources.map(source => source.name).filter(Boolean)
  if (!names.length)
    return entries
  return entries.filter(entry => !names.some(name => insideRawSource(entry, name)))
}

/** 一个配置好的来源这一轮扫成了什么样（Rust 带回来的事实） */
export interface KbRawSourceScan {
  name: string
  /** 空串 = 读到了；非空 = 这个来源没读成（路径打不开），内容是给用户看的原因 */
  error: string
}

/** kb_scan 回来的一整份：平铺清单（来源里的文件带逻辑 rel）+ 每条来源这一轮的结果 */
export interface KbScanResult {
  entries: KbScanEntry[]
  sources: KbRawSourceScan[]
}

/**
 * 左栏「原始数据」签最外层的一行：配置里的来源与库里 `data/raw` 的顶层目录合起来看。
 * 树的最外层就是这份清单（见 kbRawTree）—— 没配路径、路径打不开的来源照样占一行，
 * 点它就能重新指定；库里那份还留着而映射指向别处时，shadowed 让界面把话说清楚。
 */
export interface KbRawSourceRow {
  name: string
  /**
   * mapped：配置指向本机一个外部文件夹（路径在 dir）；
   * inRepo：没配过，读的是库里的 `data/raw/<名字>`（兼容层）；
   * unconfigured：配过、但路径还没定下来（还没指定；或指定的路径不合法被收敛掉了）
   */
  kind: 'mapped' | 'inRepo' | 'unconfigured'
  /** 实际读的那个文件夹的绝对路径；unconfigured 时是空串（没有可打开的落点） */
  dir: string
  /** 读不到的原因（盘不在 / 被改名 / 被删）；空串 = 没问题 */
  error: string
  /** 库里还留着一份 `data/raw/<名字>`，而映射指向了别处：以映射为准 */
  shadowed: boolean
  files: number
  pending: number
  stale: number
}

/**
 * 来源行：配置（sources）与库里顶层目录（entries 里 isDir 的 `data/raw/<名字>`）合起来，
 * 再把 items 按来源归到行上数出「未入库 / 有更新」。配置里的来源排在前面（配过的优先级高），
 * 其余按名字 —— 与树、与文件行同一副口径。
 *
 * entries 传**扫描回来的全量清单**（不是摘掉库里副本之后的那份）：「库里还留着一份」
 * 这件事正要看它，见 shadowed。
 */
export function kbRawSourceRows(
  sources: KbRawSource[],
  scans: KbRawSourceScan[],
  entries: KbScanEntry[],
  items: KbRawItem[],
): KbRawSourceRow[] {
  const inRepo = new Map<string, { name: string, abs: string }>()
  for (const entry of entries) {
    // 「库里还留着一份吗」问的只能是库里那些（来源文件夹里扫回来的同名目录不算，见 KbScanEntry.origin）
    if (!entry.isDir || entry.origin === 'source')
      continue
    const inner = rawInnerOf(entry.rel)
    if (!inner || inner.includes('/'))
      continue
    inRepo.set(inner.toLowerCase(), { name: inner, abs: entry.abs ?? '' })
  }

  const rows: KbRawSourceRow[] = []
  const byName = new Map<string, KbRawSourceRow>()
  /**
   * 一行一个来源。**状态按「读得到什么」定，不按配置里有没有这条记录定**：库里还留着
   * 那一份时它就是 inRepo（那份确实读得到，说成「还没配路径」反而看不出来），配了外部
   * 路径才叫 mapped。两者都有（配了路径、库里那份还没删）是 shadowed。
   */
  const add = (name: string, configuredDir: string): void => {
    const key = name.toLowerCase()
    if (byName.has(key))
      return
    const repoCopy = inRepo.get(key)
    const error = configuredDir
      ? scans.find(item => item.name.toLowerCase() === key)?.error ?? ''
      : ''
    // 配的路径打不开、库里又没留一份：这一行没有任何可读的落点，如实说「还没配好」
    const readable = configuredDir && !error
    const row: KbRawSourceRow = {
      name: repoCopy?.name ?? name,
      kind: readable ? 'mapped' : repoCopy ? 'inRepo' : 'unconfigured',
      dir: readable ? configuredDir : repoCopy?.abs ?? '',
      error,
      shadowed: !!configuredDir && !!repoCopy,
      files: 0,
      pending: 0,
      stale: 0,
    }
    byName.set(key, row)
    rows.push(row)
  }

  for (const source of sources) add(source.name, source.dir)
  for (const { name } of inRepo.values()) add(name, '')

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

  return rows
}

// ---------- 原始数据树 ----------

/** 原始数据树的一个节点：目录或文件（左栏「原始数据」签那棵树的数据形状） */
export interface KbRawTreeNode {
  /**
   * el-tree 的 node-key，全树唯一：目录是相对 `data/raw` 的目录路径（`mu-ui`），
   * 文件是完整 rel（`data/raw/mu-ui/button.md`）—— 前缀不同，撞不上。
   */
  id: string
  /** 行上显示的名字：目录是目录名，文件是文件名（带后缀） */
  name: string
  kind: 'folder' | 'file'
  children: KbRawTreeNode[]
  /** 文件节点带上的原始数据（目录节点没有）：状态、指向它的条目、修改时间都在里面 */
  item?: KbRawItem
  /** **来源行**（最外层那些目录才有）：它配到哪儿、读没读成、库里还留没留着一份 */
  source?: KbRawSourceRow
}

/**
 * 把原始数据清单按 `data/raw/` 下的目录结构收成树 —— 与条目树（kbEntryTree）同一条路数：
 * rel 就是它在仓库里的位置，树照着它长，目录在前、同层按名字排；搜索 / 状态筛选
 * 在过滤后的清单上再调一次，就得到「只含筛出项」的树。空清单回空树，不是错误。
 *
 * 最外层那几格是**来源**（sources，见 kbRawSourceRows）：配了外部文件夹的、没配的、
 * 路径打不开的都在树上占一行（没配的自然没有子文件）—— 不然「这个来源需要指定路径」
 * 这件事在界面上没有落点。不传 sources 就是老样子：树完全照着 items 长。
 */
export function kbRawTree(items: KbRawItem[], sources: KbRawSourceRow[] = []): KbRawTreeNode[] {
  const root: KbRawTreeNode = { id: '', name: '', kind: 'folder', children: [] }

  for (const source of sources) {
    root.children.push({
      id: source.name,
      name: source.name,
      kind: 'folder',
      children: [],
      source,
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
    if (!source)
      continue
    pushEntry(byFull, source, entry)
    // 不带前缀的 source（直接相对 data/raw 的写法）进的就是内层键本尊
    const inner = source.startsWith(`${KB_RAW_DIR}/`) ? source.slice(KB_RAW_DIR.length + 1) : source
    pushEntry(byInner, inner, entry)
  }

  return rawFiles.map((file) => {
    const key = file.rel.toLowerCase()
    const linked
      = byFull.get(key) ?? byInner.get(key.slice(KB_RAW_DIR.length + 1)) ?? []
    const newest = linked.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0)
    const status: KbRawStatus
      = linked.length === 0 ? 'pending' : newest < file.mtimeMs ? 'stale' : 'synced'
    return {
      rel: file.rel,
      name: file.name,
      ext: extOf(file.name),
      mtimeMs: file.mtimeMs,
      abs: file.abs ?? '',
      status,
      entryRels: [...linked].sort((a, b) => b.mtimeMs - a.mtimeMs).map(entry => entry.rel),
    }
  })
}

function pushEntry(map: Map<string, KbEntryMeta[]>, key: string, entry: KbEntryMeta): void {
  const list = map.get(key)
  if (list)
    list.push(entry)
  else map.set(key, [entry])
}

// ---------- 统计 ----------

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
    drafts: entries.filter(entry => entry.status === 'draft').length,
    raws: rawItems.length,
    pending: rawItems.filter(item => item.status === 'pending').length,
    stale: rawItems.filter(item => item.status === 'stale').length,
  }
}

/** 标签分布：按数量降序、同数按名字，界面取前几名展示 */
export function kbTagCounts(entries: KbEntryMeta[]): Array<{ tag: string, count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag))
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
