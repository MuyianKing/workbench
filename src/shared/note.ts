/**
 * 笔记（本地 `note-data.json`）：类型、默认值、收敛，以及笔记树要用的纯逻辑。
 *
 * **这份数据只在本机**：它不进同步仓库，也不在 `workbench-data.json` 里（与工作日志同一条口径，
 * 见 AGENTS.md 第 5 节的出口约定）—— 笔记是最贴近个人记录的东西，默认不往外发；
 * 文件与数据目录同进同出（迁移数据目录时会一起搬），但不会跟着 Token 同步被推上去。
 *
 * 一份文件装下整棵树：文件夹与笔记是同一种节点（`kind` 区分），正文是 markdown 原文。
 * 之所以不像别的数据那样拍平成一个数组：树就是这个数据的本来形状，增删改都发生在某一层里，
 * 嵌套结构让「删掉文件夹连带子树」这件事直接由结构本身表达，不必再维护一套 parentId 的完整性。
 *
 * 落点分工与其它数据一致：Rust 只把 JSON 安全读写到磁盘，收敛与树操作都在这里，
 * 于是这些规则能被单测直接覆盖，也不需要为了改一版显示口径去重编 Rust。
 */

/** 文件口径版本。只在本机流转，不参与跨设备合并，所以版本只用来标记格式 */
export const NOTE_DATA_VERSION = 1

export const NOTE_KINDS = ['folder', 'note'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

/** 节点名最长多少个字；超了直接截断，免得一行树被一个名字撑爆 */
export const NOTE_NAME_MAX = 60

/**
 * 嵌套最深几层。
 *
 * 收敛时按它截断：数据文件是可以被手工编辑的，一份上万层嵌套的 JSON 会让递归解析直接爆栈，
 * 表现成「启动就白屏」，很难往数据文件上想。
 */
export const NOTE_MAX_DEPTH = 8

export interface NoteNode {
  id: string
  /** 节点名。笔记名不带 `.md` 后缀 —— 后缀是「它是什么」的表达，由 icon 与编辑器承担 */
  name: string
  kind: NoteKind
  /** 正文（markdown 原文）。笔记必有；文件夹没有这一项 */
  content?: string
  /** 子项。文件夹必有（空文件夹是 `[]`）；笔记没有这一项 */
  children?: NoteNode[]
  createdAt: number
  updatedAt: number
}

export interface NoteFile {
  version: number
  nodes: NoteNode[]
}

/**
 * 新建的返回：整棵树 + 新节点的 id。
 *
 * 只回树是不够的 —— 界面要立刻选中刚建出来的那一篇、并把它的父文件夹展开，
 * 而「哪一个是新的」这件事只有真正执行插入的那一侧知道（在界面侧对比前后两棵树去找太脆）。
 */
export interface NoteCreated {
  nodes: NoteNode[]
  id: string
}

/** 新增一个节点时提交的数据 */
export interface NoteInput {
  /** 放进哪个文件夹；null / 不传表示根目录 */
  parentId?: string | null
  kind: NoteKind
  name: string
  /** 笔记正文，不传按空笔记算 */
  content?: string
}

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value)
}

/** 新建时的默认名字；重名时由 `uniqueNoteName` 往后编号 */
export const NOTE_DEFAULT_NAMES: Record<NoteKind, string> = {
  folder: '新建文件夹',
  note: '新建笔记'
}

export function emptyNoteFile(): NoteFile {
  return { version: NOTE_DATA_VERSION, nodes: [] }
}

// ---------- 名称 ----------

/**
 * 收敛一个名字：去掉首尾空白、压掉换行与其它控制字符，再按上限截断。
 *
 * 名字不是文件路径（笔记不落成 .md 文件），所以不按 Windows 的非法字符拦 ——
 * 拦了只会让「为什么这个名字不行」变成一句没法解释的话。
 */
export function sanitizeNoteName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_NAME_MAX)
}

/** 空名字是唯一的非法取值：它是树的显示主体，没名字就什么也点不了 */
export function isValidNoteName(name: string): boolean {
  return sanitizeNoteName(name).length > 0
}

/**
 * 在**同一层**里取一个不撞的名字：`新建笔记` 被占了就是 `新建笔记 2`、`新建笔记 3`。
 *
 * 只比同层：不同文件夹里各有一个「周报」是很正常的事，跨层去重只会让名字莫名其妙地涨号。
 */
export function uniqueNoteName(siblings: readonly NoteNode[], base: string): string {
  const wanted = sanitizeNoteName(base) || NOTE_DEFAULT_NAMES.note
  const taken = new Set(siblings.map((node) => node.name))
  if (!taken.has(wanted)) return wanted

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${wanted} ${index}`
    if (!taken.has(candidate)) return candidate
  }
  return wanted
}

// ---------- 收敛 ----------

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/**
 * 把磁盘上的一个节点收敛成合法结构；没名字的节点连同它的子树一起丢掉（返回 null）。
 *
 * `seen` 跨整棵树共用：id 是树的 node-key，重复会让两个节点在界面上一起动，
 * 所以这里只留第一次出现的那个，后面的重新发一个 id。
 */
function sanitizeNoteNode(
  raw: unknown,
  uuid: () => string,
  now: number,
  seen: Set<string>,
  depth: number
): NoteNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const input = raw as Partial<NoteNode>
  const name = sanitizeNoteName(input.name)
  if (!name) return null

  const kind = isNoteKind(input.kind) ? input.kind : 'note'
  const createdAt = stamp(input.createdAt, now)
  let id = text(input.id)
  if (!id || seen.has(id)) id = uuid()
  seen.add(id)

  const base = { id, name, kind, createdAt, updatedAt: stamp(input.updatedAt, createdAt) }

  if (kind === 'note') {
    return { ...base, content: typeof input.content === 'string' ? input.content : '' }
  }

  // 到深度上限就当作空文件夹，不再往下收：子树留着也显示不出来，还会让递归没完没了
  const source = depth >= NOTE_MAX_DEPTH || !Array.isArray(input.children) ? [] : input.children
  const children: NoteNode[] = []
  for (const item of source) {
    const child = sanitizeNoteNode(item, uuid, now, seen, depth + 1)
    if (child) children.push(child)
  }

  return { ...base, children }
}

/**
 * 磁盘 → 内存。文件缺失（首次使用）、损坏、被手工改坏都退化成一份空笔记本，不影响启动。
 */
export function parseNoteData(
  raw: unknown,
  uuid: () => string,
  now: number = Date.now()
): NoteFile {
  const parsed = (raw ?? {}) as Partial<NoteFile>
  const source = Array.isArray(parsed.nodes) ? parsed.nodes : []

  const nodes: NoteNode[] = []
  const seen = new Set<string>()
  for (const item of source) {
    const node = sanitizeNoteNode(item, uuid, now, seen, 0)
    if (node) nodes.push(node)
  }

  return { version: NOTE_DATA_VERSION, nodes }
}

/** 新建一个节点；名字为空（必填项没填）时返回 null，调用方据此给失败提示 */
export function createNoteNode(
  input: NoteInput,
  uuid: () => string,
  now: number = Date.now()
): NoteNode | null {
  const name = sanitizeNoteName(input.name)
  if (!name) return null
  if (!isNoteKind(input.kind)) return null

  const base = { id: uuid(), name, createdAt: now, updatedAt: now }
  return input.kind === 'folder'
    ? { ...base, kind: 'folder', children: [] }
    : { ...base, kind: 'note', content: input.content ?? '' }
}

// ---------- 读 ----------

/** 深度优先找到节点本身；找不到返回 null */
export function findNote(nodes: readonly NoteNode[], id: string): NoteNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children) {
      const found = findNote(node.children, id)
      if (found) return found
    }
  }
  return null
}

/**
 * 从根到该节点的完整链（含自身）；找不到返回空数组。
 * 界面用它显示「它到底在哪一层」，也是「这个文件夹里还有没有别人」的判断依据。
 */
export function notePath(nodes: readonly NoteNode[], id: string): NoteNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node]
    if (node.children) {
      const deeper = notePath(node.children, id)
      if (deeper.length) return [node, ...deeper]
    }
  }
  return []
}

/** 该节点的父文件夹 id（根节点返回 null）；找不到这个节点也返回 null */
export function parentIdOf(nodes: readonly NoteNode[], id: string): string | null {
  const path = notePath(nodes, id)
  return path.length > 1 ? path[path.length - 2].id : null
}

/** 整棵树里的笔记条数（文件夹不算） */
export function countNotes(nodes: readonly NoteNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.kind === 'note') total += 1
    if (node.children) total += countNotes(node.children)
  }
  return total
}

/** 树里的节点总数（文件夹 + 笔记）；删文件夹前的确认框用它报个数 */
export function countNodes(nodes: readonly NoteNode[]): number {
  let total = 0
  for (const node of nodes) {
    total += 1
    if (node.children) total += countNodes(node.children)
  }
  return total
}

// ---------- 写 ----------

/**
 * 把 `transform` 应用到命中的那个节点上，一路返回新树；没命中就原样返回（引用相等）。
 *
 * 树的写操作都是这一套：命中之后每一层都要重建新数组、新对象，否则改动的就是内存里那份
 * 原始数据 —— 渲染层拿着它做乐观更新时，改到一半失败就退不回去了。
 */
function mapNode(
  nodes: NoteNode[],
  id: string,
  transform: (node: NoteNode) => NoteNode
): NoteNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (node.id === id) {
      // 认「对象换没换」而不是「id 命中了吗」：transform 自己会判断这次改动是不是空操作，
      // 命中了却什么都没改（改同一个名字、存同一份内容）时整棵树该保持原引用
      const updated = transform(node)
      if (updated !== node) changed = true
      return updated
    }
    if (node.children) {
      const children = mapNode(node.children, id, transform)
      if (children !== node.children) {
        changed = true
        return { ...node, children }
      }
    }
    return node
  })
  return changed ? next : nodes
}

/** 子项清单；`parentId` 为 null 时就是整棵树的根。找不到父节点返回 null（调用方按失败处理） */
function childrenList(
  nodes: readonly NoteNode[],
  parentId: string | null | undefined
): readonly NoteNode[] | null {
  if (!parentId) return nodes
  const parent = findNote(nodes, parentId)
  if (!parent || parent.kind !== 'folder') return null
  return parent.children ?? []
}

/** 同层现有的名字，供 `uniqueNoteName` 去重 */
export function siblingNames(
  nodes: readonly NoteNode[],
  parentId: string | null | undefined
): readonly NoteNode[] {
  return childrenList(nodes, parentId) ?? nodes
}

/**
 * 把一个新节点挂进去。
 *
 * 父节点不存在或不是文件夹时原样返回（引用相等），调用方据此报「目标文件夹已经不在了」——
 * 界面上的树可能停在几步之前，这个分支是会走到的。
 */
export function addNoteNode(
  nodes: NoteNode[],
  parentId: string | null | undefined,
  node: NoteNode
): NoteNode[] {
  if (!parentId) return [...nodes, node]
  return mapNode(nodes, parentId, (parent) =>
    parent.kind === 'folder'
      ? { ...parent, children: [...(parent.children ?? []), node] }
      : parent
  )
}

/** 改名。名字没变（或收敛后为空）时原样返回，不刷新 `updatedAt`（与主题文件同一条口径） */
export function renameNoteNode(
  nodes: NoteNode[],
  id: string,
  name: string,
  now: number = Date.now()
): NoteNode[] {
  const clean = sanitizeNoteName(name)
  if (!clean) return nodes

  return mapNode(nodes, id, (node) =>
    node.name === clean ? node : { ...node, name: clean, updatedAt: now }
  )
}

/** 改正文。内容没变时不刷新 `updatedAt` —— 编辑器反复保存同一份内容不该算改动 */
export function setNoteContent(
  nodes: NoteNode[],
  id: string,
  content: string,
  now: number = Date.now()
): NoteNode[] {
  return mapNode(nodes, id, (node) =>
    node.kind === 'note' && node.content !== content
      ? { ...node, content, updatedAt: now }
      : node
  )
}

/** 删掉一个节点；是文件夹就整棵子树一起走（树结构本身表达了这个语义，不需要额外处理） */
export function removeNoteNode(nodes: NoteNode[], id: string): NoteNode[] {
  let changed = false
  const next: NoteNode[] = []

  for (const node of nodes) {
    if (node.id === id) {
      changed = true
      continue
    }
    if (node.children) {
      const children = removeNoteNode(node.children, id)
      if (children !== node.children) {
        changed = true
        next.push({ ...node, children })
        continue
      }
    }
    next.push(node)
  }

  return changed ? next : nodes
}

/** 按名字排序后的树（深拷贝）：树的默认摆放顺序是「建的时候什么样就什么样」，要名字序时用它 */
export function sortByName(nodes: readonly NoteNode[]): NoteNode[] {
  return [...nodes]
    .map((node) => (node.children ? { ...node, children: sortByName(node.children) } : node))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
}
