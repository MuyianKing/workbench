/**
 * 笔记的适配层实现：**用户自己挑的那个文件夹** ↔ 磁盘上的 markdown 文件。
 *
 * 与工作日志、Token 快照都不同，这里没有数据文件、也没有内存副本：
 * 每一次调用都把 root（笔记文件夹）带下去，读一次、改一次就回来。
 * 于是「外面用别的编辑器改了那些文件」这种事在下次刷新时自然就看到了 ——
 * 笔记本来就该是「我的文件夹 + 我的文件」，而不是应用里的一份投影。
 *
 * 这一层只做两件渲染层不该操心的事：
 *   1. 把 Rust 扫出来的**平铺清单**组回一棵排好序的树（纯函数在 shared/note.ts，那边有单测）；
 *   2. 结构改完之后**重新扫一遍**再回给上层。不在这里推算改动结果：真实原因是
 *      「磁盘上现在是什么样」只有一个来源，算出来的那份迟早会与它对不上（外部改名、大小写）。
 *
 * 路径一律是相对笔记根的相对路径，越界与非法名字由 Rust 侧挡住（见 src-tauri/src/notes.rs）。
 */
import {
  buildNoteTree,
  joinRel,
  normalizeRel,
  noteFileName,
  noteNameProblem,
  sanitizeNoteName,
  sanitizeNoteRepo,
  type NoteChange,
  type NoteCreateInput,
  type NoteEntry,
  type NoteNode,
  type NoteSyncInput,
  type NoteSyncSummary
} from '@shared/note'
import {
  NOTE_IMAGE_DIR,
  imageRawUrl,
  imageScopeDir,
  sanitizeImageRepo,
  type NoteImage,
  type NoteImageDeleteInput,
  type NoteImageDeleted,
  type NoteImageList,
  type NoteImageListInput,
  type NoteImageUploaded,
  type NoteImageUploadInput,
  type NoteTextScan
} from '@shared/note-image'
import { fail, ok } from '@shared/result'
import type { Result } from '@shared/types'
import { guard, invoke } from './bridge'
import { localDevice } from './token'

/** root 从调用方带进来（设置里的那个值），这里不缓存：用户换了文件夹，来源就换了 */
function rootArg(root: string): string {
  return root.trim()
}

/** 读一个文件夹的目录树（文件夹 + markdown 文件），已按「文件夹在前、同层按名字」排好 */
export async function listNotes(root: string): Promise<Result<NoteNode[]>> {
  const result = await guard(
    invoke<NoteEntry[]>('note_scan', { root: rootArg(root) }),
    '读取笔记文件夹失败'
  )
  if (!result.ok) return fail(result.error ?? '读取笔记文件夹失败')

  const entries = Array.isArray(result.data) ? result.data : []
  return ok(buildNoteTree(entries))
}

/** 读一篇的正文 */
export async function readNote(root: string, rel: string): Promise<Result<string>> {
  return guard(invoke<string>('note_read', { root: rootArg(root), rel }), '读取笔记失败')
}

/**
 * 保存正文。
 *
 * 只回成功与否：结构没变、树也不该重建 —— 正文是边打字边落盘的东西，
 * 每敲一段就把整棵树重新扫一遍（还可能把展开态冲掉）纯属白费。
 */
export async function writeNote(
  root: string,
  rel: string,
  content: string
): Promise<Result<null>> {
  return guard(invoke<null>('note_write', { root: rootArg(root), rel, content }), '保存笔记失败')
}

/**
 * 改完结构之后重新扫一遍，连同「被改动的东西现在在哪」一起交回去。
 * 上层靠 rel 把「当前打开的那一篇」接着认下去（改名 / 拖动之后它的路径变了）。
 */
async function afterChange(root: string, rel: string): Promise<Result<NoteChange>> {
  const listed = await listNotes(root)
  if (!listed.ok) return fail(listed.error ?? '读取笔记文件夹失败')
  return ok({ nodes: listed.data ?? [], rel: normalizeRel(rel) })
}

/**
 * 新建一个文件夹或笔记。
 *
 * 名字在这里再收敛一次（弹窗已经校验过，但命令是可以被别处调的）：
 * 非法名字直接失败并给出原因，不悄悄改成一个用户没打过的名字 ——
 * 那会让人对着一个「自己没起过的名字」发愣。
 */
export async function createNote(
  root: string,
  input: NoteCreateInput
): Promise<Result<NoteChange>> {
  const problem = noteNameProblem(input.name)
  if (problem) return fail(problem)

  const parent = normalizeRel(input.parentRel ?? '')
  const name = sanitizeNoteName(input.name)
  const rel = joinRel(parent, input.kind === 'folder' ? name : noteFileName(name))

  const created = await guard(
    invoke<null>('note_create', { root: rootArg(root), rel, isDir: input.kind === 'folder' }),
    '新建失败'
  )
  if (!created.ok) return fail(created.error ?? '新建失败')

  return afterChange(root, rel)
}

/** 改名（名字不带后缀，后缀由 Rust 补）；回来的是新树 + 改完之后的路径 */
export async function renameNote(
  root: string,
  rel: string,
  name: string
): Promise<Result<NoteChange>> {
  const problem = noteNameProblem(name)
  if (problem) return fail(problem)

  const renamed = await guard(
    invoke<string>('note_rename', { root: rootArg(root), rel, name: sanitizeNoteName(name) }),
    '重命名失败'
  )
  if (!renamed.ok) return fail(renamed.error ?? '重命名失败')

  return afterChange(root, typeof renamed.data === 'string' ? renamed.data : rel)
}

/** 删除；文件夹连整棵子树一起走（确认框在界面层负责说清楚这一点） */
export async function removeNote(root: string, rel: string): Promise<Result<NoteChange>> {
  const removed = await guard(
    invoke<null>('note_delete', { root: rootArg(root), rel }),
    '删除失败'
  )
  if (!removed.ok) return fail(removed.error ?? '删除失败')

  // 删掉的东西已经没有了，所以新路径是空串
  return afterChange(root, '')
}

/** 把一篇移进某个文件夹（拖动）；`targetDir` 为空串表示移到笔记根 */
export async function moveNote(
  root: string,
  rel: string,
  targetDir: string
): Promise<Result<NoteChange>> {
  const moved = await guard(
    invoke<string>('note_move', {
      root: rootArg(root),
      rel,
      targetDir: normalizeRel(targetDir)
    }),
    '移动失败'
  )
  if (!moved.ok) return fail(moved.error ?? '移动失败')

  return afterChange(root, typeof moved.data === 'string' ? moved.data : rel)
}

// ---------- 粘贴的图片 ----------

/**
 * 这次调用落在仓库的哪一层：`<images>/<设备>/<笔记本>`（口径与算法都在 shared/note-image.ts）。
 *
 * 设备标识问一次就缓存（`localDevice`，与 Token 分片用的是同一个 id），笔记本每次都由调用方带进来 ——
 * 这两样都不在适配层缓存：用户换了笔记本、换了机器，来源就换了。
 *
 * 缺哪一样都**不退回上一层**：退回等于让所有笔记本、所有机器的图混进同一个目录，
 * 素材管理里那列「未引用」立刻变成一份会删错东西的假数字。
 */
async function imageScope(input: { root: string }): Promise<Result<string>> {
  const root = rootArg(input.root)
  if (!root) return fail('还没有打开笔记文件夹')

  const device = await localDevice()
  if (!device.id) return fail('拿不到本机设备标识，暂时管理不了图片')

  const dir = imageScopeDir(NOTE_IMAGE_DIR, device.id, root)
  if (!dir) return fail('拼不出这个笔记本在图片仓库里的目录')

  return ok(dir)
}

/**
 * 把一张图片推给图片仓库，回来的是它在仓库里的**相对路径 + 可直接用的访问地址**。
 *
 * 地址不是从仓库里读回来的，而是照仓库地址算出来的（`imageRawUrl`，纯计算在 shared 里）：
 * 图片进仓库只需要「路径 + 分支」两件事，托管方的 raw 地址规则与它无关，
 * 分开之后这段拼接有单测，也就不用为了改一版口径重编 Rust。
 *
 * 推不出地址时**不算失败**：图片已经进了仓库，只是这个仓库不在三家公开托管上（`url` 是空串）。
 */
export async function uploadNoteImage(
  input: NoteImageUploadInput
): Promise<Result<NoteImageUploaded>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo) return fail('还没有配置图片仓库（设置 → 笔记图片）')
  if (!input.data) return fail('图片是空的')

  const scope = await imageScope(input)
  if (!scope.ok || !scope.data) return fail(scope.error ?? '拼不出这个笔记本在图片仓库里的目录')

  const result = await guard(
    invoke<{ path: string; branch: string }>('note_image_upload', {
      repo,
      dir: scope.data,
      name: input.name,
      data: input.data,
      useAccount: input.useAccount === true
    }),
    '上传图片失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '上传图片失败')

  const path = typeof result.data.path === 'string' ? result.data.path : ''
  const branch = typeof result.data.branch === 'string' ? result.data.branch : ''
  return ok({
    path,
    branch,
    url: imageRawUrl({ repo, branch, path })
  })
}

// ---------- 素材管理 ----------

/**
 * 这个笔记本（这台机器）传过哪些图（顺手把本地克隆拉到最新，所以这一下会走一次网络）。
 *
 * 只列 `<images>/<设备>/<笔记本>` 那一层（见 imageScope）：别的笔记本、别的机器传上来的图
 * **不在清单里** —— 它们的「引用次数」拿当前这个笔记本的正文根本数不出来。
 * 只把 Rust 回来的清单收成确定的形状：仓库没配 / 拉不下来都是失败（界面据此提示去哪儿配），
 * 而「被引用了几次」由调用方拿笔记正文另算（见 shared/note-image.ts 的 buildImageAssets）。
 */
export async function listNoteImages(input: NoteImageListInput): Promise<Result<NoteImageList>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo) return fail('还没有配置图片仓库（设置 → 笔记图片）')

  const scope = await imageScope(input)
  if (!scope.ok || !scope.data) return fail(scope.error ?? '拼不出这个笔记本在图片仓库里的目录')

  const result = await guard(
    invoke<{ branch?: unknown; files?: unknown }>('note_images_list', {
      repo,
      dir: scope.data,
      useAccount: input.useAccount === true
    }),
    '读取图片仓库失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取图片仓库失败')

  return ok({
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    files: normalizeImages(result.data.files)
  })
}

/** 清单里认不出来的条目一律丢掉：宁可少一张，也不要拿 undefined 去算引用次数 */
function normalizeImages(raw: unknown): NoteImage[] {
  if (!Array.isArray(raw)) return []

  const files: NoteImage[] = []
  for (const item of raw) {
    const entry = item as Partial<NoteImage> | null
    const path = typeof entry?.path === 'string' ? entry.path.trim() : ''
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!path || !name) continue

    files.push({
      path,
      name,
      size: typeof entry?.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0
    })
  }
  return files
}

/**
 * 批量删掉**这个笔记本（这台机器）自己那些**没人引用的图片（一次提交、一次推送）。
 *
 * 路径的边界由 Rust 逐条把关（必须落在这次传下去的目录里、必须是图片、逐段是普通名字），
 * 而这次传下去的目录就是上面那个素材目录 —— 于是别处的图**删不到**：
 * 就算把别的路径塞进来，也会被「不在这个目录里」挡回去。
 * 这里只做「有没有东西要删」与形状收敛 —— 越界这种事的判据不该有两份。
 */
export async function deleteNoteImages(
  input: NoteImageDeleteInput
): Promise<Result<NoteImageDeleted>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo) return fail('还没有配置图片仓库（设置 → 笔记图片）')

  const paths = (Array.isArray(input.paths) ? input.paths : []).filter(
    (path): path is string => typeof path === 'string' && Boolean(path.trim())
  )
  if (!paths.length) return fail('没有选中要删除的图片')

  const scope = await imageScope(input)
  if (!scope.ok || !scope.data) return fail(scope.error ?? '拼不出这个笔记本在图片仓库里的目录')

  const result = await guard(
    invoke<Partial<NoteImageDeleted>>('note_images_delete', {
      repo,
      dir: scope.data,
      paths,
      useAccount: input.useAccount === true
    }),
    '删除图片失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '删除图片失败')

  return ok({
    deleted: typeof result.data.deleted === 'number' ? result.data.deleted : 0,
    changed: result.data.changed === true,
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    log: typeof result.data.log === 'string' ? result.data.log : ''
  })
}

/** 笔记本里所有笔记的正文（引用计数用）：只读盘，怎么算引用是渲染层的事 */
export async function scanNoteTexts(root: string): Promise<Result<NoteTextScan>> {
  const result = await guard(
    invoke<{ files?: unknown; failed?: unknown }>('note_scan_texts', { root: rootArg(root) }),
    '读取笔记正文失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取笔记正文失败')

  const raw = Array.isArray(result.data.files) ? result.data.files : []
  const files: NoteTextScan['files'] = []
  for (const item of raw) {
    const entry = item as { rel?: unknown; text?: unknown } | null
    if (typeof entry?.text !== 'string') continue
    files.push({ rel: typeof entry.rel === 'string' ? entry.rel : '', text: entry.text })
  }

  return ok({
    files,
    failed:
      typeof result.data.failed === 'number' && Number.isFinite(result.data.failed)
        ? result.data.failed
        : 0
  })
}

// ---------- 与远端同步 ----------

/**
 * 把当前笔记本与远端对齐一次（提交 → 拉 → 推）。
 *
 * 与粘贴上传那条一样带着仓库地址，但**没有克隆目录**：跑 git 的地方就是 `dir` 这个文件夹本身
 * ——还不是仓库时就地在它里面 `git init` 并接上 `repo`（见 Rust 侧 `sync::sync_notes`）。
 * 所以这里只收敛参数与结果形状：谁先改的、撞上哪几篇，都是 git 说了算。
 *
 * 冲突**不算失败得莫名其妙**：Rust 那边会中止这次 rebase（本地那笔提交留着）并把冲突的文件名
 * 写进错误里，界面照原样显示给用户即可（见 NotesView 的同步按钮）。
 */
export async function syncNotes(input: NoteSyncInput): Promise<Result<NoteSyncSummary>> {
  const repo = sanitizeNoteRepo(input.repo)
  if (!repo) return fail('还没有配置笔记仓库（设置 → 笔记）')

  const dir = rootArg(input.dir)
  if (!dir) return fail('还没有选择笔记文件夹')

  const result = await guard(
    invoke<Partial<NoteSyncSummary>>('note_sync', {
      repo,
      dir,
      useAccount: input.useAccount === true
    }),
    '同步笔记失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '同步笔记失败')

  return ok({
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    files:
      typeof result.data.files === 'number' && Number.isFinite(result.data.files)
        ? result.data.files
        : 0,
    received: result.data.received === true,
    log: typeof result.data.log === 'string' ? result.data.log : ''
  })
}
