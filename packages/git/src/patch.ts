/**
 * 统一 diff（`git diff -U3`）的行模型。
 *
 * 只做一件事：把补丁原文拆成「可以直接按行渲染」的数组 —— 每个 hunk 头、每个增 / 删 /
 * 上下文行，各自带旧 / 新两侧的行号。渲染在组件里，解析与行号口径在这里（有单测）。
 *
 * 为什么不用 `@workbench/core` 的 `buildDiffRows`：那一份要两侧完整文本（技能对比弹窗
 * 拿的是库里与项目里的两个文件）；Git 这边只从 git 拿补丁，上下文之外的几万行没有理由
 * 也取回来。两者面向的数据源不同，不要硬套。
 *
 * 只认 `-U3` 的普通补丁：`--no-renames` 让一个文件只有一组 `---/+++`，`--no-ext-diff`
 * 与 `--no-textconv` 保证输出就是 git 自己的文本。二进制补丁没有 hunk，由调用方按
 * `GitPatch.binary` 单独提示。
 */

export type PatchRowType = 'hunk' | 'add' | 'del' | 'context' | 'note' | 'meta'

export interface PatchRow {
  type: PatchRowType
  /** 行内容（增删行已经去掉开头的 `+` / `-` / 空格） */
  text: string
  /** 旧文本行号；新增行 / hunk 头 / meta 为 null */
  oldNo: number | null
  /** 新文本行号；删除行 / hunk 头 / meta 为 null */
  newNo: number | null
}

export interface ParsedPatch {
  rows: PatchRow[]
  /** 行数超过上限，只解析了前一部分 */
  truncated: boolean
}

/** 并排视图里的一侧：行号 + 行内容 */
export interface SplitCell {
  no: number
  text: string
}

export type SplitRowType = 'hunk' | 'note' | 'equal' | 'change' | 'del' | 'add'

/** 并排（split）视图的一行：左右各一侧；hunk 头与说明行是跨两栏的整行 */
export interface SplitRow {
  type: SplitRowType
  /** hunk 头 / 「文件末尾没有换行」这类说明行的整行文本 */
  text?: string
  /** 旧文本那一行；add 行没有 */
  left: SplitCell | null
  /** 新文本那一行；del 行没有 */
  right: SplitCell | null
}

/** 默认最多解析多少行：几万行的补丁一次性铺进 DOM，滚动与选中都会变卡 */
export const PATCH_ROW_MAX = 20_000

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function meta(text: string): PatchRow {
  return { type: 'meta', text, oldNo: null, newNo: null }
}

/**
 * 补丁原文 → 行数组。
 *
 * 换行统一按 LF 切（git 输出就是 LF；CRLF 只可能来自手工粘贴的文本）。
 * hunk 之外的 `diff --git` / `index` / `---` / `+++` 之类也保留成 `meta` 行，
 * 由组件决定要不要显示 —— 解析层不替界面做取舍。
 */
export function parsePatch(patch: string, maxRows = PATCH_ROW_MAX): ParsedPatch {
  const rows: PatchRow[] = []
  let truncated = false
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  const push = (row: PatchRow): void => {
    if (rows.length >= maxRows) {
      truncated = true
      return
    }
    rows.push(row)
  }

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    // 末尾换行产生的空串；hunk 里的空上下文行一定带一个前导空格，不会走到这里
    if (!line)
      continue

    // 下一个文件开始了：即使上一行看上去像内容，也先收掉当前 hunk
    if (line.startsWith('diff --git ')) {
      inHunk = false
      push(meta(line))
      continue
    }

    const hunk = HUNK_HEADER.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      push({ type: 'hunk', text: line, oldNo: null, newNo: null })
      continue
    }

    if (!inHunk) {
      push(meta(line))
      continue
    }

    if (line.startsWith('+')) {
      push({ type: 'add', text: line.slice(1), oldNo: null, newNo })
      newNo += 1
      continue
    }
    if (line.startsWith('-')) {
      push({ type: 'del', text: line.slice(1), oldNo, newNo: null })
      oldNo += 1
      continue
    }
    if (line.startsWith(' ')) {
      push({ type: 'context', text: line.slice(1), oldNo, newNo })
      oldNo += 1
      newNo += 1
      continue
    }
    if (line.startsWith('\\')) {
      push({ type: 'note', text: line, oldNo: null, newNo: null })
      continue
    }

    // hunk 里不该出现别的行；真出现了就当成文件头，别把后续内容一直当 hunk
    inHunk = false
    push(meta(line))
  }

  return { rows, truncated }
}

/**
 * 统一 diff 的行模型 → 并排视图的行清单（GitHub split 那种左右对照）。
 *
 * 配对口径与 `@workbench/core` 的 `buildDiffRows` 一致：连续的删除块与新增块按顺序
 * 一一配成 `change` 行（左旧右新），配剩的就是单边 `del` / `add` 行。
 * 上下文行左右同文，hunk 头与说明行保留成整行；`meta` 行不进并排视图
 * （组件本来就不显示它们）。
 */
export function buildSplitRows(rows: readonly PatchRow[]): SplitRow[] {
  const split: SplitRow[] = []
  /** 攒下的连续删除块与新增块：遇到上下文 / 下一个 hunk（或结尾）时配对清空 */
  let removed: PatchRow[] = []
  let added: PatchRow[] = []
  /** 夹在删除与新增之间的说明行（「文件末尾没有换行」）：不打断配对，结块时补在最后 */
  let notes: string[] = []

  const flush = (): void => {
    const paired = Math.min(removed.length, added.length)
    for (let index = 0; index < paired; index += 1) {
      const del = removed[index]
      const add = added[index]
      split.push({
        type: 'change',
        left: { no: del.oldNo ?? 0, text: del.text },
        right: { no: add.newNo ?? 0, text: add.text },
      })
    }
    for (let index = paired; index < removed.length; index += 1) {
      const row = removed[index]
      split.push({ type: 'del', left: { no: row.oldNo ?? 0, text: row.text }, right: null })
    }
    for (let index = paired; index < added.length; index += 1) {
      const row = added[index]
      split.push({ type: 'add', left: null, right: { no: row.newNo ?? 0, text: row.text } })
    }
    for (const text of notes)
      split.push({ type: 'note', text, left: null, right: null })
    removed = []
    added = []
    notes = []
  }

  for (const row of rows) {
    if (row.type === 'del') {
      // 新增块之后又出现删除行：先结掉上一组（正常补丁不会这样，防御一下）
      if (added.length)
        flush()
      removed.push(row)
      continue
    }
    if (row.type === 'add') {
      added.push(row)
      continue
    }
    if (row.type === 'note') {
      if (removed.length || added.length) {
        notes.push(row.text)
        continue
      }
      split.push({ type: 'note', text: row.text, left: null, right: null })
      continue
    }

    flush()
    if (row.type === 'hunk') {
      split.push({ type: 'hunk', text: row.text, left: null, right: null })
      continue
    }
    if (row.type === 'context') {
      split.push({
        type: 'equal',
        left: { no: row.oldNo ?? 0, text: row.text },
        right: { no: row.newNo ?? 0, text: row.text },
      })
    }
    // meta 行不显示
  }
  flush()

  return split
}
