/**
 * 文本差异的行模型：把两份文本算成 GitHub split 视图那种「左右对齐的一行行」。
 *
 * 算法交给 `diff`（jsdiff —— 纯算法库，无 UI；行级 `diffLines` 算块、词级
 * `diffWordsWithSpace` 给修改行做行内高亮），**渲染在组件、配对在这里**：
 * 这里产出的只是数据（每行左右两侧各是什么、哪段变了），组件拿它画表格。
 * 放 shared 是为了让「配对与行号」这些口径有单测，改起来不必重编 Rust。
 *
 * split 视图的对齐规则与 GitHub 相同：连续的删除块与新增块按顺序**一一配对**成
 * 「修改行」（左边旧的一行红、右边新的一行绿，行内变化段高亮），配对剩下的
 * 就是纯删除行（右侧空）与纯新增行（左侧空）。内容没变的行左右同文，无高亮。
 */
import { diffLines, diffWordsWithSpace } from 'diff'

/** diff 库的行块：added / removed 互斥，都为 false 是内容未变的块 */
interface LinePart {
  value: string
  added?: boolean
  removed?: boolean
  count?: number
}

/** 行内的一段文本：changed 为真时渲染成高亮（这一段是被改动的） */
export interface DiffSegment {
  text: string
  changed: boolean
}

/** 一行的一侧：行号 + 拆好的段 */
export interface DiffSide {
  /** 在旧文本（left）或新文本（right）里的行号，从 1 起 */
  no: number
  segments: DiffSegment[]
}

export type DiffRowType = 'equal' | 'change' | 'del' | 'add'

export interface DiffRow {
  type: DiffRowType
  /** 旧文本的那一行；add 行没有 */
  left: DiffSide | null
  /** 新文本的那一行；del 行没有 */
  right: DiffSide | null
}

/** 把一份文本拆成一行一行（先做换行归一；末尾的换行符不产生空的最后一行） */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized) return []
  return normalized.replace(/\n$/, '').split('\n')
}

/** 词级差异转成一侧的段：只保留这一侧真正存在的文本，被换掉的那段标记 changed */
function segmentsOfSide(line: string, parts: LinePart[], side: 'old' | 'new'): DiffSegment[] {
  const segments: DiffSegment[] = []
  for (const part of parts) {
    const keep = side === 'old' ? part.removed || !part.added : part.added || !part.removed
    if (!keep) continue
    segments.push({ text: part.value, changed: side === 'old' ? part.removed === true : part.added === true })
  }
  // 不变式兜底：段拼接必须还原这一行本身。对不上（分词边界与整行不一致的极端情况）
  // 就放弃词级高亮，整行交给底色 —— 高亮是锦上添花，错一分都不能
  const joined = segments.map((segment) => segment.text).join('')
  if (joined !== line) return [{ text: line, changed: false }]
  return segments
}

/** 一对「旧行 / 新行」：词级算出变化段，行内高亮用 */
function changeRow(oldNo: number, newNo: number, oldLine: string, newLine: string): DiffRow {
  const parts = diffWordsWithSpace(oldLine, newLine)
  return {
    type: 'change',
    left: { no: oldNo, segments: segmentsOfSide(oldLine, parts, 'old') },
    right: { no: newNo, segments: segmentsOfSide(newLine, parts, 'new') }
  }
}

/**
 * 两份文本 → split 视图的行清单。
 *
 * 两份文本都先做换行归一（项目里的文件可能带 CRLF，换行写法不该算成差异）；
 * 完全相同的文本产出的是清一色的 equal 行。
 */
export function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const normalized = (text: string): string => text.replace(/\r\n/g, '\n')
  const parts = diffLines(normalized(oldText), normalized(newText))

  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0

  /** 攒下的连续删除块与新增块：遇到未变内容（或结尾）时配对清空 */
  let removed: string[] = []
  let added: string[] = []

  const flush = (): void => {
    const paired = Math.min(removed.length, added.length)
    for (let index = 0; index < paired; index += 1) {
      rows.push(changeRow(oldNo + 1 + index, newNo + 1 + index, removed[index], added[index]))
    }
    for (let index = paired; index < removed.length; index += 1) {
      rows.push({ type: 'del', left: { no: oldNo + 1 + index, segments: [{ text: removed[index], changed: false }] }, right: null })
    }
    for (let index = paired; index < added.length; index += 1) {
      rows.push({ type: 'add', left: null, right: { no: newNo + 1 + index, segments: [{ text: added[index], changed: false }] } })
    }
    oldNo += removed.length
    newNo += added.length
    removed = []
    added = []
  }

  for (const part of parts) {
    if (part.removed) {
      removed.push(...splitLines(part.value))
    } else if (part.added) {
      added.push(...splitLines(part.value))
    } else {
      flush()
      for (const line of splitLines(part.value)) {
        oldNo += 1
        newNo += 1
        const segments = [{ text: line, changed: false }]
        rows.push({ type: 'equal', left: { no: oldNo, segments }, right: { no: newNo, segments } })
      }
    }
  }
  flush()

  return rows
}
