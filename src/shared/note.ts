/**
 * 笔记：**用户自己挑的那个文件夹**，以及它里面的 markdown 文件。
 *
 * 它不再是应用维护的一棵 JSON 树 —— 笔记就是磁盘上的 `.md` 文件，笔记本就是那个目录：
 * 换台机器拿 Typora / VSCode 接着写也成立，应用里看到的目录树就是文件夹本来的结构。
 * 因此这里**没有「数据版本」「落盘收敛」那一套**，只有三件事：
 *   1. 文件名 / 相对路径的规矩（收敛、去重、拼装）；
 *   2. 把后端扫出来的平铺清单组回一棵树（文件夹排在文件前面、同层按名字排）；
 *   3. 拖动能不能落在某个节点上这类判断。
 *
 * 全是纯函数：文件系统那一半在 `src-tauri/src/notes.rs`（它只认相对路径、并挡住越界），
 * 适配层把两端接起来（见 workbench/note.ts）。放这里是为了能被单测直接覆盖 ——
 * 「点开头的目录不理」「非 markdown 的文件不进树」这些口径改起来也不必重编 Rust。
 *
 * **只在本机**：笔记本是用户自己的目录，应用既不复制它、也不把它写进任何数据文件；
 * 记下来的只有两样：当前打开的那个目录（设置里的 `noteDir`）与打开过的那几个
 * （`noteDirs`，笔记页左栏底部的「最近打开」）。两个都只对本机成立、不参与同步。
 *
 * 这里说的「同步」是把**那个文件夹本身当成一个 git 工作区**（提交 / 拉取 / 推送都在它里面跑，
 * 见 `src-tauri/src/sync.rs` 的 `sync_notes`）：所以在不在别的机器上，只取决于用户填的那个
 * 仓库地址（设置里的 `noteSyncRepo`，空串 = 不同步）。这一份里只有地址的收敛规则与结果形状。
 */

/** 算作笔记的后缀。编辑器写出来的是 `.md`，`.markdown` 是照顾别处写下的文件 */
const NOTE_EXTENSIONS = ['.md', '.markdown'] as const

export const NOTE_KINDS = ['folder', 'note'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

/** 名字最长多少个字；超了直接截断，免得一层目录被一个名字撑爆 */
export const NOTE_NAME_MAX = 60

/** 后端扫出来的一个条目（原始的平铺清单，树由 `buildNoteTree` 组） */
export interface NoteEntry {
  /** 相对笔记根的路径，用 `/` 分隔 */
  rel: string
  /** 条目自己的名字（含后缀） */
  name: string
  isDir: boolean
  /** 最后修改时间（毫秒）；问不到就是 0 */
  mtimeMs?: number
}

/** 树上的一个节点：文件夹或一篇笔记 */
export interface NoteNode {
  /** `el-tree` 的 node-key：就是 `rel`（同一个文件夹里不会有两条同路径的条目） */
  id: string
  /** 相对笔记根的路径 */
  rel: string
  /** 显示名。笔记不含 `.md` 后缀 —— 后缀是「它是什么」的表达，由图标与编辑器承担 */
  name: string
  kind: NoteKind
  /** 子项；只有文件夹有 */
  children?: NoteNode[]
  /** 最后修改时间（毫秒）；文件夹没有这一项 */
  mtimeMs?: number
}

/**
 * 结构变化后的返回：改动之后的整棵树 + 被改动节点的新路径。
 *
 * 只回树是不够的：改名与拖动会让**当前打开的那一篇**换一个路径，
 * 而上层只有拿到新路径才能把它接着认下去（删除时是空串）。
 * 一次调用把两件事都定下来，也就不会有「树更新了、打开的那一篇还指着老路径」的中间态。
 */
export interface NoteChange {
  nodes: NoteNode[]
  rel: string
}

/** 正在编辑的那一篇：路径 + 原文。编辑器只认它，不关心它从哪来 */
export interface NoteDocument {
  rel: string
  name: string
  content: string
  mtimeMs: number
}

/** 新建一个节点的入参 */
export interface NoteCreateInput {
  /** 放进哪个文件夹（相对路径）；空串 / 不传表示根目录 */
  parentRel?: string
  kind: NoteKind
  name: string
}

/** 新建时的默认名字；重名时由 `uniqueNoteName` 往后编号 */
export const NOTE_DEFAULT_NAMES: Record<NoteKind, string> = {
  folder: '新建文件夹',
  note: '新建笔记'
}

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value)
}

// ---------- 路径 ----------

/**
 * 收敛一个相对路径：分隔符统一成 `/`、去掉空段与 `.` 段。
 *
 * 只做这些 —— `..` **不在这里拦**（那会让「路径不合法」变成一个静默的变形）。
 * 真正的边界判断在 Rust 侧：那边逐段只接受普通名字，越界一律报错。
 */
export function normalizeRel(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.')
    .join('/')
}

/** 拼一个相对路径：`joinRel('工作', '周报.md')` → `工作/周报.md` */
export function joinRel(dir: string, name: string): string {
  const base = normalizeRel(dir)
  const leaf = normalizeRel(name)
  if (!base) return leaf
  return leaf ? `${base}/${leaf}` : base
}

/** 所在文件夹的相对路径；根下的条目是空串 */
export function parentRel(rel: string): string {
  const parts = normalizeRel(rel).split('/')
  parts.pop()
  return parts.join('/')
}

/** 路径的最后一段（文件名 / 文件夹名） */
export function relName(rel: string): string {
  const parts = normalizeRel(rel).split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * 收敛笔记文件夹：去掉首尾空白与末尾的分隔符。
 *
 * 盘根那个特例要留住：`C:\` 去掉分隔符就成了 `C:`，那在 Windows 上是「当前目录」，
 * 意思完全变了，所以只留一个盘符时补回分隔符。
 */
export function sanitizeNoteRoot(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const cut = trimmed.replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:$/.test(cut) ? `${cut}\\` : cut
}

/** 笔记本在界面上显示的名字：路径的最后一段；问不出来就原样显示整条路径 */
export function noteRootName(root: string): string {
  const clean = sanitizeNoteRoot(root)
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : clean
}

/** 笔记仓库地址上限，与 Token 同步仓库 / 图片仓库同一个口径 */
const NOTE_REPO_MAX_LENGTH = 300

/**
 * 收敛笔记仓库地址：去掉首尾空白，**空串表示不同步**（设置里它就是这个开关）。
 *
 * 与 Token 同步仓库（`sanitizeSyncRepo`）逐字同一条口径，理由也一样：
 * 这个值最终会被当成 git 的命令行参数 —— 含空白的地址会被 Windows 的 shell 词法拆成两个，
 * 以 `-` 开头的会被 git 当成选项。认不出来的一律按没填处理（等于关掉同步），
 * 而不是留一个每次都失败的值在那儿。
 */
export function sanitizeNoteRepo(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (!value || value.length > NOTE_REPO_MAX_LENGTH) return ''
  if (/\s/.test(value) || value.startsWith('-')) return ''
  return value
}

/** 同步一次要带的东西：地址由调用方从设置里给（适配层不缓存设置） */
export interface NoteSyncInput {
  repo: string
  /**
   * 要同步的笔记本：**就是磁盘上那个文件夹本身**，应用在它里面跑 git
   * （还没有仓库时就地 `git init` 并接上 `repo`）。空串 = 还没选文件夹。
   */
  dir: string
  /** 是否用已登录账号的 token 授权（私有仓库用；关掉就走系统 git 凭据） */
  useAccount?: boolean
}

/** 一次同步的结果 */
export interface NoteSyncSummary {
  /** 同步用的分支 */
  branch: string
  /** 这次提交了几个文件（0 = 本机没有改动） */
  files: number
  /** 远端有没有带回来新东西 */
  received: boolean
  /** git 自己的输出，排查时看它 */
  log: string
}

// ---------- 名字 ----------

/** Windows 上文件名里不能出现的字符：名字最终就是一个文件名，这些必须拦住 */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/
/** Windows 的保留设备名：叫这些名字的文件建不出来 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 收敛一个名字：去掉首尾空白、压掉换行与其它控制字符、剔掉文件名里的非法字符，再按上限截断。
 *
 * 命令是可以被直接调的，所以这里收敛过的名字在 Rust 侧还会再判一遍
 * （见 notes.rs 的 `validate_name`）—— 落盘的名字不能只靠上游自觉。
 */
export function sanitizeNoteName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, NOTE_NAME_MAX)
}

/**
 * 这个名字有什么问题；没问题返回空串。
 *
 * 界面拿它写提示（不是「能不能保存」的开关）：名字最终落到文件名上，
 * 有一类名字（带 `/`、系统保留名）不是「换一个号码就能过」的，说清原因比只报「非法」有用。
 */
export function noteNameProblem(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '名字不能为空'
  const name = raw.trim()
  if (ILLEGAL_NAME_CHARS.test(name)) return '名字里不能包含 \\ / : * ? " < > | 这些字符'
  if (name.startsWith('.')) return '名字不能以点开头'
  if (RESERVED_NAMES.test(name)) return '这是系统的保留名字，换一个'
  if (!sanitizeNoteName(name)) return '名字不能为空'
  return ''
}

export function isValidNoteName(raw: unknown): boolean {
  return noteNameProblem(raw) === ''
}

/** 显示名 → 文件名：笔记一律写成 `.md`（改名时后缀由 Rust 补，这里给新建用） */
export function noteFileName(name: string): string {
  return `${sanitizeNoteName(name)}.md`
}

/** 是不是一篇笔记（按后缀判） */
export function isNoteFile(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** 文件名 → 显示名（去掉后缀） */
export function noteDisplayName(fileName: string): string {
  return fileName.replace(/\.(md|markdown)$/i, '')
}

/**
 * 在**同一层**里取一个不撞的名字：`新建笔记` 被占了就是 `新建笔记 2`、`新建笔记 3`。
 *
 * 只比同层：不同文件夹里各有一个「周报」是很正常的事，跨层去重只会让名字莫名其妙地涨号。
 * 撞名的对象既包括笔记也包括文件夹 —— 两者在磁盘上是同级条目，同名是建不出来的。
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

// ---------- 组树 ----------

/**
 * 同层排序：**文件夹在前、文件在后**，各自按名字排。
 *
 * 用带 `numeric` 的排序规则：`笔记 10` 排在 `笔记 9` 后面，而不是按字符串逐位比。
 * 名字完全相同时按原始字符串兜底，保证同一份输入每次都得到同一个顺序。
 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function compareNodes(left: NoteNode, right: NoteNode): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
  return collator.compare(left.name, right.name) || collator.compare(left.rel, right.rel)
}

/** 逐层排序（返回新对象，不改入参） */
export function sortNoteNodes(nodes: readonly NoteNode[]): NoteNode[] {
  return [...nodes]
    .sort(compareNodes)
    .map((node) => (node.children ? { ...node, children: sortNoteNodes(node.children) } : node))
}

/**
 * 平铺清单 → 树。
 *
 * 两份过滤在这里定下：只收文件夹与 markdown 文件（图片、附件这些不进树，
 * 它们在编辑器的链接里照样能用）；点开头的条目、以及 `node_modules` / `dist` 那批
 * 依赖与构建产物的目录由后端扫的时候就跳过了（见 src-tauri/src/notes.rs 的 `IGNORED_DIRS`）。
 *
 * 父目录没出现在清单里时（扫描期间被删掉、或网络盘上那一段读不到），
 * 把节点挂到根上：树里位置不准，但总比整篇笔记看不见强。
 */
export function buildNoteTree(entries: readonly NoteEntry[]): NoteNode[] {
  const table = new Map<string, NoteNode>()

  for (const entry of entries) {
    const rel = normalizeRel(entry.rel)
    if (!rel || table.has(rel)) continue

    const fileName = entry.name ? normalizeRel(entry.name) : relName(rel)
    if (entry.isDir) {
      table.set(rel, { id: rel, rel, name: fileName, kind: 'folder', children: [] })
      continue
    }
    if (!isNoteFile(fileName)) continue
    table.set(rel, {
      id: rel,
      rel,
      name: noteDisplayName(fileName),
      kind: 'note',
      mtimeMs: entry.mtimeMs ?? 0
    })
  }

  const roots: NoteNode[] = []
  for (const node of table.values()) {
    const parent = parentRel(node.rel)
    const owner = parent ? table.get(parent) : undefined
    if (owner) owner.children?.push(node)
    else roots.push(node)
  }

  return sortNoteNodes(roots)
}

// ---------- 打开过的笔记本 ----------

/**
 * 「最近打开」最多留几条。
 *
 * 再多也只是一份往回找的清单，界面上那一段放不下 —— 而且真正的目的只有一个：
 * 换回上次那个笔记本不用再翻一遍目录树。
 */
export const NOTE_HISTORY_MAX = 6

/**
 * 收敛一份「打开过的笔记本」清单。
 *
 * 逐条按目录的规矩收敛（去首尾空白与末尾分隔符），去掉空的与重复的 ——
 * 同一个目录在 Windows 上不分大小写，所以比对用小写；
 * 超过上限的部分整段丢掉，留下的是最近打开的那几个。
 */
export function sanitizeNoteHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const list: string[] = []
  for (const item of raw) {
    const dir = sanitizeNoteRoot(item)
    if (!dir) continue

    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    list.push(dir)
    if (list.length >= NOTE_HISTORY_MAX) break
  }
  return list
}

/** 打开（或换到）一个目录：它排到最前面，已在那儿的不会出现两次 */
export function pushNoteHistory(history: unknown, dir: unknown): string[] {
  const target = sanitizeNoteRoot(dir)
  if (!target) return sanitizeNoteHistory(history)
  return sanitizeNoteHistory([target, ...sanitizeNoteHistory(history)])
}

/** 删掉清单里的一条（历史记录可以删）；本来就不在里面时原样返回 */
export function removeFromNoteHistory(history: unknown, dir: unknown): string[] {
  const target = sanitizeNoteRoot(dir).toLowerCase()
  return sanitizeNoteHistory(history).filter((item) => item.toLowerCase() !== target)
}

// ---------- 读 ----------

/** 深度优先找到某个路径上的节点；找不到返回 null */
export function findNoteNode(nodes: readonly NoteNode[], rel: string): NoteNode | null {
  const target = normalizeRel(rel)
  if (!target) return null

  for (const node of nodes) {
    if (node.rel === target) return node
    if (node.children) {
      const found = findNoteNode(node.children, target)
      if (found) return found
    }
  }
  return null
}

/**
 * 从最外层到该节点的完整链（含自身）；找不到返回空数组。
 * 界面用它写面包屑，也用它决定「要把哪几层展开」。
 */
export function noteChain(nodes: readonly NoteNode[], rel: string): NoteNode[] {
  const target = normalizeRel(rel)
  if (!target) return []

  for (const node of nodes) {
    if (node.rel === target) return [node]
    // 只往「可能是它祖先」的那一支里走：rel 是带层级的前缀路径
    if (node.children && target.startsWith(`${node.rel}/`)) {
      const deeper = noteChain(node.children, target)
      if (deeper.length) return [node, ...deeper]
    }
  }
  return []
}

/** 整棵树里的笔记篇数（文件夹不算） */
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

// ---------- 拖动 ----------

/**
 * 拖动能不能落在某个节点上。
 *
 * 三条口径：
 *   - **只有文件能拖**。文件夹也能拖的话，「把它拖进自己的下级」就是个能把整棵子树
 *     从树里搬掉的动作 —— 后端挡住了（见 notes.rs），但那已经不是界面该允许的交互；
 *   - **只能落在文件夹上**（`el-tree` 的 inner）。落在文件上意味着「插到它前面 / 后面」，
 *     而这里的顺序是按名字算出来的，插出来的位置下一秒就没了。树下面的**空白区**也是落点：
 *     拿 `{ rel: '', kind: 'folder' }` 问同一个函数，「移到最外层」与「拖进某个文件夹」
 *     于是共用一条口径（原来靠最上面那一行根目录行兜着，根行去掉之后由空白区接手）；
 *   - **拖回原处不算**：已经在那个文件夹里的文件拖上去，后端会返回一次空操作，
 *     但界面上给个「能放」的提示再什么都不发生，会让人以为拖动坏了。
 */
export function noteDropAllowed(
  drag: { rel: string; kind: NoteKind },
  target: { rel: string; kind: NoteKind }
): boolean {
  if (drag.kind !== 'note') return false
  if (target.kind !== 'folder') return false
  return parentRel(drag.rel) !== normalizeRel(target.rel)
}
