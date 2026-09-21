/**
 * 技能（skill）：**技能库是它自己的一个目录**，里面是一批可安装的技能。
 *
 * 技能与笔记是同一类东西（几份 markdown 加随带的小文件），但**两者互不相干**：
 * 技能库是用户在技能页挑的那个目录（设置里的 `skillDir`），可能是任意一处 ——
 * 正好是某个笔记本文件夹、某个仓库里的一层，或者一个专门的技能仓库，都可能。
 * 每次增删改都在它所在的仓库里提交一次 —— **版本管理就是 git 提交历史**，
 * 恢复到某个版本就是 `git checkout <hash> -- <目录>`；推上去用技能页那颗同步按钮
 * （Rust 侧 `skills::sync`：只提交技能库那一层，再拉、再推它所在的那个仓库）。
 *
 * 「它在哪个仓库里」**不由这里猜、也不用配**：从技能库目录开始看有没有 `.git`，没有就往上找
 * （Rust 侧 `skills::state`）。`SkillLibraryState` 就是那件事的形状，各条技能通道拿的正是它给的
 * 「仓库根 + 库在里面的相对路径」这两样 —— **库自己就是仓库根**时那个相对路径是空串。
 *
 * 一个技能 = 技能库下的一个子目录，里面有一份 `SKILL.md`（frontmatter 的 name / description
 * 就是它的名字与描述 —— **自动提取**，不用另外登记）。安装到项目 = 把整个目录复制到
 * `<项目>/.agents/skills/<目录名>/`。
 *
 * 这里全是纯函数：文件系统与 git 在 `src-tauri/src/skills.rs`，编排与解析结果的使用在
 * 渲染层（workbench/skill.ts + stores/skills.ts）。放 shared 是为了让「frontmatter 怎么认、
 * 路径怎么拼」有单测、改起来不用重编 Rust。
 */
import {
  joinRel,
  normalizeRel,
  sanitizeNoteName,
  type NoteNode,
  type NoteSyncSummary
} from './note'

/** 技能的清单文件：frontmatter 里带 name / description，正文是给 agent 看的用法说明 */
export const SKILL_FILE = 'SKILL.md'

/** 安装到项目时落在项目下的这个目录（各 agent 通用的项目级技能目录约定） */
export const SKILL_INSTALL_DIR = '.agents/skills'

/** 技能库路径的上限：它只是仓库里的一条相对路径，长得离谱的值按认不出处理 */
const SKILL_DIR_MAX = 120

/**
 * 技能库与它的仓库：**从技能库目录开始看有没有 `.git`，没有就往上找最近的**（Rust 侧探好带过来）。
 *
 * `repo` 是那个仓库根（一路上去都没有就是技能库目录自己），`libraryRel` 是技能库相对它的路径
 * （技能库就是仓库根时是空串）—— 两者一起交给各条技能通道：文件操作在 `<repo>/<libraryRel>` 下，
 * git 在 `repo` 里跑。
 */
export interface SkillLibraryState {
  /** 仓库根（绝对路径）；没有仓库时就是技能库目录自己 */
  repo: string
  /** 技能库相对 `repo` 的路径；技能库就是仓库根时是空串 */
  libraryRel: string
  /** 那个仓库有没有 `.git` —— 有没有它决定「改完记不记版本」 */
  hasGit: boolean
  /** 那个仓库的 origin；没连远端时是空串（能记版本、推不出去） */
  origin: string
}

/** 技能页同步一次的摘要：与笔记同步是同一个机制，形状也一样 */
export type SkillSyncSummary = NoteSyncSummary

/**
 * 收敛「技能库在仓库里的相对路径」：统一分隔符、逐段按文件名规矩清洗、挡住 `..`，认不出的回空串。
 *
 * 它守的是**从磁盘上找出来的那个仓库根**：`rel` 由真实路径一段段拼出来，但接下来要去拼文件路径
 * 与 git pathspec，所以过一遍闸。**空串是合法的**：技能库自己就是仓库根（专门的技能仓库），
 * 那时它就是这个空串。
 */
export function sanitizeSkillSyncDir(raw: unknown): string {
  const rel = normalizeRel(raw)
  if (!rel) return ''

  const parts = rel.split('/').map((part) => sanitizeNoteName(part))
  // 有哪一段清洗后为空（纯点、纯符号）就整条作废：拼出来的路径已经不是磁盘上那个了
  if (parts.some((part) => !part)) return ''

  const cleaned = parts.join('/')
  return cleaned.length <= SKILL_DIR_MAX ? cleaned : ''
}

/** 列表里的一项：名字与描述从 SKILL.md 的 frontmatter 提取（自动，不用登记） */
export interface SkillEntry {
  /** 目录名（相对技能库的一段，也是安装到项目时用的目录名） */
  id: string
  /** frontmatter 的 name；没写回落目录名 */
  name: string
  /** frontmatter 的 description；没写是空串 */
  description: string
  /**
   * frontmatter 的 version（归一化写法，去掉了可选的 v 前缀）；没写或不合法是空串。
   * 保存时它是必填的（见 skillVersionProblem），历史数据 / 导入进来的可能没有。
   */
  version: string
  /** 有没有 SKILL.md（没有它就还不是技能，装不到项目里） */
  hasSkillMd: boolean
  /** 目录里的文件数（递归全部，不含目录本身） */
  fileCount: number
}

/** 新建技能时提交给适配层的数据 */
export interface SkillCreateInput {
  /** 目录名（同时是 id） */
  id: string
  /** 写进 frontmatter 的 name */
  name: string
  /** 写进 frontmatter 的 description */
  description: string
}

/** 版本历史里的一行（一次提交） */
export interface SkillCommit {
  /** 提交号（恢复到这个版本时传回去） */
  hash: string
  /** 提交时间（毫秒，Unix 纪元） */
  time: number
  /** 提交说明（`skill: <id> 动作` 这类，应用自己提交的都带这个前缀） */
  subject: string
}

/** 一份文本文件副本：rel 相对技能目录，content 为 null 表示二进制（读不出文本，比不了） */
export interface SkillFileCopy {
  rel: string
  content: string | null
}

/** 一个项目里这份技能的副本（整棵文件的清单） */
export interface SkillProjectCopy {
  /** 项目根目录（原样回传，渲染层按它对应到项目） */
  project: string
  /** 项目副本里的全部文本文件；没装这个技能时是空数组 */
  files: SkillFileCopy[]
}

/** 一次副本扫描：库中的文件 + 各项目里的副本 */
export interface SkillInstalledScan {
  library: SkillFileCopy[]
  projects: SkillProjectCopy[]
}

/** 技能目录里的一个文件（SKILL.md 与附属文件都在内） */
export interface SkillFileInfo {
  /** 相对技能目录的路径（`/` 分隔，普通段） */
  rel: string
  /** 字节数 */
  size: number
}

/**
 * 对比弹窗里的一个文件：比对基准（现在库里的那份）与要采纳的那份。
 *
 * 两侧的 null 都是「读不出文本」—— 项目里没有这个文件，或者是个二进制文件（比不了的不当差异）。
 * 历史版本那条用的是同一副形状：`base` = 现在库里的内容、`incoming` = 那一版的内容。
 */
export interface SkillCompareFile {
  rel: string
  base: string
  incoming: string | null
}

/**
 * 把「现在库里的那份」与「某个历史版本」两组文件副本合成对比弹窗的清单。
 *
 * 两件事最容易做错，所以放在这里配单测：
 *  1. **清单取并集**：那一版里有、现在删掉了的文件同样是差异（恢复会把它们带回来），
 *     只按现在这一侧拼，界面上会显示成「什么都没变」；
 *  2. **方向**：`base` 永远是现在库里的内容（会被换掉的那份），`incoming` 永远是所选版本
 *     （要采纳的那份）—— 反了的话红绿两栏的含义整个颠倒，而它底下就是恢复按钮。
 *
 * 结果按 rel 的**码点顺序**排（不是 localeCompare）：另一条对比路径的清单是 Rust 排好递回来的
 * （`str::cmp` 就是码点序），同一个技能换一个入口看，文件条的顺序不该跟着变。
 * 读不出文本的（二进制）如实留空串 / null。
 */
export function mergeVersionCopies(
  current: readonly SkillFileCopy[],
  version: readonly SkillFileCopy[]
): SkillCompareFile[] {
  const byRel = new Map<string, SkillCompareFile>()
  for (const file of version) {
    byRel.set(file.rel, { rel: file.rel, base: '', incoming: file.content })
  }
  for (const file of current) {
    const existing = byRel.get(file.rel)
    if (existing) existing.base = file.content ?? ''
    else byRel.set(file.rel, { rel: file.rel, base: file.content ?? '', incoming: null })
  }

  return [...byRel.values()].sort((left, right) =>
    left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0
  )
}

// ---------- 路径 ----------

/** 技能目录的相对路径（相对笔记根）：`<技能库>/<id>` */
export function skillRel(dir: string, id: string): string {
  return joinRel(dir, id)
}

/** 技能清单文件的相对路径：`<技能库>/<id>/SKILL.md` */
export function skillFileRel(dir: string, id: string): string {
  return joinRel(skillRel(dir, id), SKILL_FILE)
}

// ---------- frontmatter ----------

/** 从 SKILL.md 提取出来的三样东西；没写的是空串 */
export interface SkillFrontmatter {
  name: string
  description: string
  version: string
}

/**
 * 解析 SKILL.md 的 frontmatter，提取 name、description 与 version。
 *
 * 只认「首行 `---` 围栏、每行一个 `键: 值`」的最小集合 —— 这正是所有技能都会写的那部分。
 * 多行块标量（`description: >-` 那种）不带内容，如实丢掉，不猜缩进；围栏外与不认识的键不碰。
 * 解析失败（没有 frontmatter）返回三个空串，**不是错误**：没有 frontmatter 的技能照样列出来，
 * 名字回落目录名；version 的必填校验在保存那一侧（见 skillVersionProblem）。
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const empty: SkillFrontmatter = { name: '', description: '', version: '' }
  if (typeof text !== 'string') return empty

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  // 围栏前允许空行；第一行非空行必须是 `---`
  let index = 0
  while (index < lines.length && !lines[index].trim()) index += 1
  if (lines[index]?.trim() !== '---') return empty
  index += 1

  const result: SkillFrontmatter = { name: '', description: '', version: '' }
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '---' || line === '...') break

    const match = /^(name|description|version)\s*:\s*(.*)$/.exec(line)
    if (!match) continue

    const value = match[2].trim()
    // 多行块标量的开头（`|` / `>` 及其变体）：内容在后面几行的缩进里，这里不认
    if (/^[|>][+-]?$/.test(value)) continue
    const unquoted = unquoteScalar(value)
    if (match[1] === 'name') result.name = unquoted
    else if (match[1] === 'description') result.description = unquoted
    else result.version = unquoted
  }
  return result
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

// ---------- 版本 ----------

/**
 * 语义化版本的形态：**三段纯数字**（主.次.修订），容忍一个可选的 `v` 前缀（v1.2.0 也认，
 * 归一化时去掉）。prerelease / build 元数据那一套对技能版本没有意义，不收 ——
 * 「必须满足语义」就按最严的那条走，两位数的 `0.1` 这类写法会被挡回来。
 */
export const SKILL_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/

/** 新建技能时写进 frontmatter 的默认版本 */
export const SKILL_VERSION_DEFAULT = '0.1.0'

/** 有没有 frontmatter（首行非空行是 `---` 就算，内容里写了什么不归它管） */
export function hasSkillFrontmatter(text: string): boolean {
  if (typeof text !== 'string') return false
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let index = 0
  while (index < lines.length && !lines[index].trim()) index += 1
  return lines[index]?.trim() === '---'
}

/**
 * frontmatter 里的 version，归一化写法（去了可选的 v 前缀）；没写或不合法是空串。
 * 只在 skillVersionProblem 通过之后用它才是可靠的。
 */
export function skillVersionOf(text: string): string {
  const match = SKILL_VERSION_PATTERN.exec(parseSkillFrontmatter(text).version.trim())
  return match ? `${match[1]}.${match[2]}.${match[3]}` : ''
}

/**
 * 比较两个归一化后的语义化版本：-1（a 更小）/ 0（相等）/ 1（a 更大）。
 *
 * **按数字逐段比，不是按字符串比** —— `1.10.0` 大于 `1.9.0`，字符串比会给出相反的答案。
 * 任一侧解析失败（空串 / 不合语义）按 `0.0.0` 兜底：库里还没有 version 时（老数据），
 * 项目里任何合法版本都算「更高」，不会把更新这条路堵死。
 */
export function compareSkillVersions(a: string, b: string): number {
  const segmentsOf = (version: string): [number, number, number] => {
    const match = SKILL_VERSION_PATTERN.exec(version.trim())
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : [0, 0, 0]
  }

  const left = segmentsOf(a)
  const right = segmentsOf(b)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/**
 * 保存前的版本校验：通过返回空串，否则返回一句能直接照着改的提示。
 *
 * 三种失败分开说 —— 「没有 frontmatter」「frontmatter 里没写 version」「写了但不合语义」，
 * 因为用户要补的东西不一样。这是**保存的必经门槛**：没有 version 的改动不记版本，
 * 否则提交日志里的版本号就断了线。
 */
export function skillVersionProblem(text: string): string {
  const version = parseSkillFrontmatter(text).version.trim()
  if (!version) {
    return hasSkillFrontmatter(text)
      ? 'frontmatter 里还没有 version，补一行 version: 1.0.0 再保存'
      : 'SKILL.md 开头要有 frontmatter（--- 包住的那段），version 写在那里（如 version: 1.0.0）'
  }
  if (!SKILL_VERSION_PATTERN.test(version)) {
    return `version「${version}」不是语义化版本，要三段数字（主.次.修订），如 1.0.0`
  }
  return ''
}

/**
 * 把一个值写成 frontmatter 里的单行标量：含冒号、引号、`#` 这些 YAML 特殊字符时加双引号。
 *
 * 中文与普通英文不加引号（frontmatter 多数时候是给人看的，裸文本最好读）；
 * 要加引号时把内部的双引号与反斜杠转义掉。
 */
export function yamlScalar(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (!clean) return "''"
  if (!/[:#"']/.test(clean) && !/^[-?&*!|>%@`{}[\],]/.test(clean)) return clean
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 新技能的 SKILL.md 骨架：frontmatter 三行（name / description / version）+ 一段待写的正文 */
export function skillMdTemplate(
  name: string,
  description: string,
  version: string = SKILL_VERSION_DEFAULT
): string {
  return [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    `version: ${yamlScalar(version)}`,
    '---',
    '',
    `# ${yamlScalar(name)}`,
    '',
    '<!-- 在这里写这个技能的用法：什么时候用、按什么步骤做。改动后记得升 version（如 1.0.0 → 1.1.0）。 -->',
    ''
  ].join('\n')
}

// ---------- 列表 ----------

/** Rust 回来的一条原始记录（id + 文件数 + SKILL.md 原文）→ 界面用的摘要 */
export function toSkillEntry(raw: {
  id?: unknown
  fileCount?: unknown
  skillMd?: unknown
}): SkillEntry | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null

  const meta = parseSkillFrontmatter(typeof raw.skillMd === 'string' ? raw.skillMd : '')
  return {
    id,
    name: meta.name || id,
    description: meta.description,
    // 归一化（去 v 前缀）；没写或写了不合语义的如实空串 —— 保存那一关会把它拦下
    version: skillVersionOf(typeof raw.skillMd === 'string' ? raw.skillMd : ''),
    hasSkillMd: typeof raw.skillMd === 'string',
    fileCount: typeof raw.fileCount === 'number' && Number.isFinite(raw.fileCount) ? raw.fileCount : 0
  }
}

/**
 * 笔记页的目录树要把技能库这一层藏起来：技能有自己的页面，树里再挂一份只会让人
 * 以为它也是笔记（在那里改名 / 删除不会留下技能的版本提交）。只藏**顶层**的那一层，
 * 且只在它正好是技能目录时 —— 同名文件夹藏在更深处不归这里管。
 */
export function withoutSkillDir(nodes: readonly NoteNode[], dir: string): NoteNode[] {
  const rel = normalizeRel(dir)
  if (!rel || rel.includes('/')) return [...nodes]
  return nodes.filter((node) => node.rel !== rel)
}

/**
 * 技能库落在**笔记本里**的相对路径；不在笔记本里时返回空串（`withoutSkillDir` 收它）。
 *
 * 技能库与笔记本是各自挑的目录、互不相干，所以这里只能按路径比：逐段比
 * （不按字符串前缀 —— 否则 `C:\a\b` 会把 `C:\a\bc` 也算进去），大小写不敏感
 * （Windows 上同一个目录），返回的是**库那一段的原样写法**。
 * 两边相同、或笔记本比库还深时是空串：那时什么都不藏（藏了就是把整个笔记本藏了）。
 */
export function libraryInNotebook(libraryDir: unknown, notebookDir: unknown): string {
  const library = splitRoot(libraryDir)
  const notebook = splitRoot(notebookDir)
  if (!library.length || !notebook.length || notebook.length >= library.length) return ''

  for (let index = 0; index < notebook.length; index += 1) {
    if (notebook[index].toLowerCase() !== library[index].toLowerCase()) return ''
  }
  return library.slice(notebook.length).join('/')
}

/** 把一条绝对路径切成有内容的段（两种分隔符都认） */
function splitRoot(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(/[\\/]+/).filter((part) => part && part !== '.')
}
