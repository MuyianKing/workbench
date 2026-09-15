/**
 * 笔记（本地 `note-data.json`）的适配层实现。
 *
 * 与工作日志同一个套路：**没有同步**，读写路径就是「读一次文件 → 内存里增删改 → 整份写回」，
 * 没有分片、没有合并、没有跨设备语义（见 shared/note.ts 的文件头）。
 *
 * 文件是懒加载的：首屏不读它，第一次进「笔记」页时才把整份取回来，
 * 之后一直在内存里维护，每次改动整份落盘（防抖在 Rust 侧）。
 *
 * 树的增删改一律调 shared 里的纯函数，这里只负责「读盘 / 写盘 / 返回快照」——
 * 于是「删文件夹带走子树」「同层不撞名」这些规则都留在能被单测覆盖的地方。
 */
import {
  addNoteNode,
  createNoteNode,
  emptyNoteFile,
  findNote,
  parseNoteData,
  removeNoteNode,
  renameNoteNode,
  sanitizeNoteName,
  setNoteContent,
  siblingNames,
  uniqueNoteName,
  type NoteCreated,
  type NoteFile,
  type NoteInput,
  type NoteNode
} from '@shared/note'
import { fail, ok } from '@shared/result'
import type { Result } from '@shared/types'
import { invoke } from './bridge'

let file: NoteFile = emptyNoteFile()
let loaded = false
/** 进行中的加载：并发调用共享同一次读盘，读失败时清掉，下次还能重试 */
let pending: Promise<void> | null = null

async function ensureLoaded(): Promise<void> {
  if (loaded) return

  if (!pending) {
    pending = invoke<unknown>('note_load')
      .then((raw) => {
        file = parseNoteData(raw, () => crypto.randomUUID())
        loaded = true
      })
      .finally(() => {
        pending = null
      })
  }
  await pending
}

/** 变更即写（落盘防抖在 Rust 侧，300ms 合并一次） */
function persist(): void {
  if (loaded) void invoke('note_save', { value: file })
}

/**
 * 交给渲染层的值一律是快照，理由与 work-log.ts 里那段一样：
 * 适配层与渲染层之间原本是进程边界，直接把内部对象递出去，
 * 渲染层的就地修改会绕过这里的落盘逻辑。
 */
function copy<T>(value: T): T {
  return structuredClone(value)
}

function reasonOf(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** 整棵树（顺序就是用户摆放的顺序，这里不排序） */
export async function listNotes(): Promise<Result<NoteNode[]>> {
  try {
    await ensureLoaded()
    return ok(copy(file.nodes))
  } catch (error) {
    return fail(reasonOf(error, '读取笔记失败'))
  }
}

/**
 * 新建一个节点。
 *
 * 名字只做「不能为空」这一条硬校验，撞名则自动往后退一格（`新建笔记 2`）：
 * 从右键菜单新建时大多数人不打算起名，为此弹一句「已存在同名」只会挡路。
 * 重命名则不退让 —— 那是用户自己打的名字，改成什么由他定。
 */
export async function createNote(input: NoteInput): Promise<Result<NoteCreated>> {
  try {
    await ensureLoaded()

    const base = sanitizeNoteName(input.name)
    if (!base) return fail('名字不能为空')

    const node = createNoteNode(
      { ...input, name: uniqueNoteName(siblingNames(file.nodes, input.parentId), base) },
      () => crypto.randomUUID()
    )
    if (!node) return fail('名字不能为空')

    const next = addNoteNode(file.nodes, input.parentId, node)
    // 父文件夹在界面上还在、在数据里已经没了（另一处刚删掉）：如实报错，不静默丢在一个别处
    if (next === file.nodes) return fail('目标文件夹已经不存在了')

    file.nodes = next
    persist()
    return ok({ nodes: copy(file.nodes), id: node.id })
  } catch (error) {
    return fail(reasonOf(error, '新建笔记失败'))
  }
}

export async function renameNote(id: string, name: string): Promise<Result<NoteNode[]>> {
  try {
    await ensureLoaded()
    if (!findNote(file.nodes, id)) return fail('找不到这个笔记')

    const next = renameNoteNode(file.nodes, id, name)
    // 名字没变时纯函数返回原引用：不产生一次只改了 updatedAt 的落盘
    if (next !== file.nodes) {
      file.nodes = next
      persist()
    }
    return ok(copy(file.nodes))
  } catch (error) {
    return fail(reasonOf(error, '重命名失败'))
  }
}

/** 删掉一个节点；是文件夹就整棵子树一起走（确认框在界面层负责说清楚这一点） */
export async function removeNote(id: string): Promise<Result<NoteNode[]>> {
  try {
    await ensureLoaded()

    const next = removeNoteNode(file.nodes, id)
    // 已经不在了（例如连着点了两次）：当作成功，界面上就是它已经没了
    if (next !== file.nodes) {
      file.nodes = next
      persist()
    }
    return ok(copy(file.nodes))
  } catch (error) {
    return fail(reasonOf(error, '删除笔记失败'))
  }
}

/**
 * 改正文。
 *
 * 刻意只回 `Result<null>` 而不是整棵树：正文是编辑器边打字边落盘的东西，
 * 每敲一段就把整棵树（含所有笔记的正文）复制一遍送回渲染层纯属白搬。
 * 树的结构没有变，界面那边把这个节点的正文就地更新一下就够了。
 */
export async function updateNoteContent(id: string, content: string): Promise<Result<null>> {
  try {
    await ensureLoaded()

    const node = findNote(file.nodes, id)
    if (!node || node.kind !== 'note') return fail('找不到这个笔记')

    const next = setNoteContent(file.nodes, id, content)
    if (next !== file.nodes) {
      file.nodes = next
      persist()
    }
    return ok(null)
  } catch (error) {
    return fail(reasonOf(error, '保存笔记失败'))
  }
}

// ---------- 数据目录迁移 ----------

/** 迁移前把内存态同步落盘：否则 Rust 搬走的是上一次写盘时的样子 */
export async function flush(): Promise<void> {
  if (loaded) await invoke('note_save', { value: file })
}

/** 迁移之后丢掉内存里那份 —— 它读的是旧目录的文件 */
export function reset(): void {
  file = emptyNoteFile()
  loaded = false
  pending = null
}
