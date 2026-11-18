import type { NoteChange, NoteCreateInput, NoteEntry, NoteImage, NoteImageDeleted, NoteImageDeleteInput, NoteImageList, NoteImageListInput, NoteImageMigrated, NoteImageUploaded, NoteImageUploadInput, NoteNode, NoteRead, NoteRepoState, NoteSyncInput, NoteSyncSummary, NoteTextScan } from '@workbench/notes'

import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
/**
 * 笔记的适配层实现：**用户自己挑的那个文件夹** ↔ 磁盘上的 markdown 文件。
 *
 * 与工作日志、Token 快照都不同，这里没有数据文件、也没有内存副本：
 * 每一次调用都把 root（笔记文件夹）带下去，读一次、改一次就回来。
 * 于是「外面用别的编辑器改了那些文件」这种事在下次刷新时自然就看到了 ——
 * 笔记本来就该是「我的文件夹 + 我的文件」，而不是应用里的一份投影。
 *
 * 这一层只做两件渲染层不该操心的事：
 *   1. 把 Rust 扫出来的**平铺清单**组回一棵排好序的树（纯函数在 packages/notes/src/note.ts，那边有单测）；
 *   2. 结构改完之后**重新扫一遍**再回给上层。不在这里推算改动结果：真实原因是
 *      「磁盘上现在是什么样」只有一个来源，算出来的那份迟早会与它对不上（外部改名、大小写）。
 *
 * 路径一律是相对笔记根的相对路径，越界与非法名字由 Rust 侧挡住（见 src-tauri/src/notes.rs）。
 */
import { buildNoteTree, imageOriginScopeDir, imageRawUrl, imageScopeDir, joinRel, normalizeRel, NOTE_IMAGE_DIR, noteFileName, noteNameProblem, sanitizeImageRepo, sanitizeNoteName } from '@workbench/notes'
import { recordActivity } from './activity'
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
    '读取笔记文件夹失败',
  )
  if (!result.ok)
    return fail(result.error ?? '读取笔记文件夹失败')

  const entries = Array.isArray(result.data) ? result.data : []
  return ok(buildNoteTree(entries))
}

/** 读一篇的正文；连它此刻的 mtime 一起回（写盘时当基准） */
export async function readNote(root: string, rel: string): Promise<Result<NoteRead>> {
  return guard(invoke<NoteRead>('note_read', { root: rootArg(root), rel }), '读取笔记失败')
}

/**
 * 保存正文。
 *
 * 回来的是写完之后文件自己的 mtime：结构没变、树也不该重建 —— 正文是边打字边落盘的东西，
 * 每敲一段就把整棵树重新扫一遍（还可能把展开态冲掉）纯属白费。
 *
 * `expectedMtimeMs` 是这份正文基于磁盘上哪个版本改的；带上它，别处在这期间改过的
 * 那一篇就不会被这一笔盖掉（Rust 侧写前核一遍，不一致直接拒绝）。
 */
export async function writeNote(
  root: string,
  rel: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<Result<number>> {
  return guard(
    invoke<number>('note_write', { root: rootArg(root), rel, content, expectedMtimeMs }),
    '保存笔记失败',
  )
}

/**
 * 改完结构之后重新扫一遍，连同「被改动的东西现在在哪」一起交回去。
 * 上层靠 rel 把「当前打开的那一篇」接着认下去（改名 / 拖动之后它的路径变了）。
 */
async function afterChange(root: string, rel: string): Promise<Result<NoteChange>> {
  const listed = await listNotes(root)
  if (!listed.ok)
    return fail(listed.error ?? '读取笔记文件夹失败')
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
  input: NoteCreateInput,
): Promise<Result<NoteChange>> {
  const problem = noteNameProblem(input.name)
  if (problem)
    return fail(problem)

  const parent = normalizeRel(input.parentRel ?? '')
  const name = sanitizeNoteName(input.name)
  const rel = joinRel(parent, input.kind === 'folder' ? name : noteFileName(name))

  const created = await guard(
    invoke<null>('note_create', { root: rootArg(root), rel, isDir: input.kind === 'folder' }),
    '新建失败',
  )
  if (!created.ok)
    return fail(created.error ?? '新建失败')

  // 活跃度只认「写了一篇新笔记」，**建文件夹不算**（那是整理，不是产出）。
  // 也不按保存次数算：编辑器是防抖自动保存的，一个下午能写几百次盘（见 NoteEditor.vue）
  if (input.kind !== 'folder')
    recordActivity('note')

  return afterChange(root, rel)
}

/** 改名（名字不带后缀，后缀由 Rust 补）；回来的是新树 + 改完之后的路径 */
export async function renameNote(
  root: string,
  rel: string,
  name: string,
): Promise<Result<NoteChange>> {
  const problem = noteNameProblem(name)
  if (problem)
    return fail(problem)

  const renamed = await guard(
    invoke<string>('note_rename', { root: rootArg(root), rel, name: sanitizeNoteName(name) }),
    '重命名失败',
  )
  if (!renamed.ok)
    return fail(renamed.error ?? '重命名失败')

  return afterChange(root, typeof renamed.data === 'string' ? renamed.data : rel)
}

/** 删除；文件夹连整棵子树一起走（确认框在界面层负责说清楚这一点） */
export async function removeNote(root: string, rel: string): Promise<Result<NoteChange>> {
  const removed = await guard(
    invoke<null>('note_delete', { root: rootArg(root), rel }),
    '删除失败',
  )
  if (!removed.ok)
    return fail(removed.error ?? '删除失败')

  // 删掉的东西已经没有了，所以新路径是空串
  return afterChange(root, '')
}

/** 把一篇移进某个文件夹（拖动）；`targetDir` 为空串表示移到笔记根 */
export async function moveNote(
  root: string,
  rel: string,
  targetDir: string,
): Promise<Result<NoteChange>> {
  const moved = await guard(
    invoke<string>('note_move', {
      root: rootArg(root),
      rel,
      targetDir: normalizeRel(targetDir),
    }),
    '移动失败',
  )
  if (!moved.ok)
    return fail(moved.error ?? '移动失败')

  return afterChange(root, typeof moved.data === 'string' ? moved.data : rel)
}

// ---------- 粘贴的图片 ----------

/**
 * 这次调用落在仓库的哪一层（口径与算法都在 packages/notes/src/note-image.ts）：
 *
 * - 有 origin → `<images>/<origin-key>`：同一个仓库跨设备、跨盘符是同一本笔记本，图进同一层共享；
 * - 没有 origin → `<images>/<设备>/<笔记本>`：本机笔记按设备 + 本机路径分。
 *
 * origin 与设备都不缓存（origin 现探现带、设备问一次即可；换笔记本 / 换机器来源就变了）。
 * 缺该有的那一层时**不退回仓库根**：那会让所有笔记本的图混进一个目录，素材管理的「未引用」变假数字。
 */
async function imageScope(input: { root: string, origin?: string }): Promise<Result<string>> {
  const root = rootArg(input.root)
  if (!root)
    return fail('还没有打开笔记文件夹')

  const origin = (input.origin ?? '').trim()
  if (origin) {
    const shared = imageOriginScopeDir(NOTE_IMAGE_DIR, origin)
    if (shared)
      return ok(shared)
    // origin 填了却解析不出来（本地路径等）：按失败如实报，不悄悄退回本机层
    return fail('笔记本连着的 origin 认不出来，暂时按共享素材管理不了图片')
  }

  const device = await localDevice()
  if (!device.id)
    return fail('拿不到本机设备标识，暂时管理不了图片')

  const dir = imageScopeDir(NOTE_IMAGE_DIR, device.id, root)
  if (!dir)
    return fail('拼不出这个笔记本在图片仓库里的目录')

  return ok(dir)
}

/** 旧层（设备 + 本机路径）目录：并集清单与迁移用，无论当前有没有 origin 都能算出来 */
async function legacyImageScope(root: string): Promise<Result<string>> {
  const clean = rootArg(root)
  if (!clean)
    return fail('还没有打开笔记文件夹')
  const device = await localDevice()
  if (!device.id)
    return fail('拿不到本机设备标识，暂时管理不了图片')
  const dir = imageScopeDir(NOTE_IMAGE_DIR, device.id, clean)
  if (!dir)
    return fail('拼不出这个笔记本旧的图片目录')
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
  input: NoteImageUploadInput,
): Promise<Result<NoteImageUploaded>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo)
    return fail('还没有配置图片仓库（设置 → 笔记图片）')
  if (!input.data)
    return fail('图片是空的')

  const scope = await imageScope(input)
  if (!scope.ok || !scope.data)
    return fail(scope.error ?? '拼不出这个笔记本在图片仓库里的目录')

  const result = await guard(
    invoke<{ path: string, branch: string }>('note_image_upload', {
      repo,
      dir: scope.data,
      name: input.name,
      data: input.data,
    }),
    '上传图片失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '上传图片失败')

  const path = typeof result.data.path === 'string' ? result.data.path : ''
  const branch = typeof result.data.branch === 'string' ? result.data.branch : ''
  return ok({
    path,
    branch,
    url: imageRawUrl({ repo, branch, path }),
  })
}

// ---------- 素材管理 ----------

/**
 * 这个笔记本（这台机器）传过哪些图（顺手把本地克隆拉到最新，所以这一下会走一次网络）。
 *
 * 只列 `<images>/<设备>/<笔记本>` 那一层（见 imageScope）：别的笔记本、别的机器传上来的图
 * **不在清单里** —— 它们的「引用次数」拿当前这个笔记本的正文根本数不出来。
 * 只把 Rust 回来的清单收成确定的形状：仓库没配 / 拉不下来都是失败（界面据此提示去哪儿配），
 * 而「被引用了几次」由调用方拿笔记正文另算（见 packages/notes/src/note-image.ts 的 buildImageAssets）。
 */
export async function listNoteImages(input: NoteImageListInput): Promise<Result<NoteImageList>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo)
    return fail('还没有配置图片仓库（设置 → 笔记图片）')

  const scope = input.scope === 'legacy'
    ? await legacyImageScope(input.root)
    : await imageScope(input)
  if (!scope.ok || !scope.data)
    return fail(scope.error ?? '拼不出这个笔记本在图片仓库里的目录')

  const result = await guard(
    invoke<{ branch?: unknown, dir?: unknown, files?: unknown }>('note_images_list', {
      repo,
      dir: scope.data,
    }),
    '读取图片仓库失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '读取图片仓库失败')

  return ok({
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    dir: typeof result.data.dir === 'string' ? result.data.dir : scope.data,
    files: normalizeImages(result.data.files),
  })
}

/** 清单里认不出来的条目一律丢掉：宁可少一张，也不要拿 undefined 去算引用次数 */
function normalizeImages(raw: unknown): NoteImage[] {
  if (!Array.isArray(raw))
    return []

  const files: NoteImage[] = []
  for (const item of raw) {
    const entry = item as Partial<NoteImage> | null
    const path = typeof entry?.path === 'string' ? entry.path.trim() : ''
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!path || !name)
      continue

    files.push({
      path,
      name,
      size: typeof entry?.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0,
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
  input: NoteImageDeleteInput,
): Promise<Result<NoteImageDeleted>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo)
    return fail('还没有配置图片仓库（设置 → 笔记图片）')

  const paths = (Array.isArray(input.paths) ? input.paths : []).filter(
    (path): path is string => typeof path === 'string' && Boolean(path.trim()),
  )
  if (!paths.length)
    return fail('没有选中要删除的图片')

  const current = await imageScope(input)
  if (!current.ok || !current.data)
    return fail(current.error ?? '拼不出这个笔记本在图片仓库里的目录')
  // 并集清单里的图可能在共享层，也可能是迁移前的旧层：两层都作为允许的删除范围
  const dirs = [current.data]
  if (input.origin) {
    const legacy = await legacyImageScope(input.root)
    if (legacy.ok && legacy.data && legacy.data !== current.data)
      dirs.push(legacy.data)
  }

  const result = await guard(
    invoke<Partial<NoteImageDeleted>>('note_images_delete', {
      repo,
      dirs,
      paths,
    }),
    '删除图片失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '删除图片失败')

  return ok({
    deleted: typeof result.data.deleted === 'number' ? result.data.deleted : 0,
    changed: result.data.changed === true,
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    log: typeof result.data.log === 'string' ? result.data.log : '',
  })
}

/**
 * 把旧层（设备 + 本机路径）的图片搬到 origin 共享层，并改写笔记本正文里的图片 URL。
 *
 * renames / replacements 由渲染层的纯函数算好（哪些图正文还在用、怎么换前缀，见 @workbench/notes），
 * 这里只收紧形状再交给 Rust 执行：Rust 负责在**图片仓库**里 git mv + 一次提交推送，
 * 并在**笔记本文件夹**里逐篇机械替换 + 带 mtime 校验写回（笔记本仓库的提交推送由上层同步负责）。
 * 两个仓库各提交一次，做不到原子 —— 这一点在迁移确认框里如实告诉用户。
 */
export async function migrateNoteImages(input: {
  repo: string
  /** 笔记本文件夹（要改它的 .md 正文） */
  root: string
  /** 旧层目录（仓库相对） */
  oldDir: string
  /** 新层目录（仓库相对，origin 共享层） */
  newDir: string
  /** 待搬的图：旧路径 → 新路径 */
  renames: { from: string, to: string, name: string }[]
  /** 正文里要做的字面替换（含原始与百分号编码两种前缀） */
  replacements: { from: string, to: string }[]
}): Promise<Result<NoteImageMigrated>> {
  const repo = sanitizeImageRepo(input.repo)
  if (!repo)
    return fail('还没有配置图片仓库（设置 → 笔记图片）')
  const root = rootArg(input.root)
  if (!root)
    return fail('还没有打开笔记文件夹')

  const renames = (Array.isArray(input.renames) ? input.renames : [])
    .filter(item => item && typeof item.from === 'string' && typeof item.to === 'string' && typeof item.name === 'string')
    .map(item => ({ from: item.from, to: item.to, name: item.name }))
  if (!renames.length)
    return fail('没有需要迁移的图片')

  const replacements = (Array.isArray(input.replacements) ? input.replacements : [])
    .filter(item => item && typeof item.from === 'string' && typeof item.to === 'string')
    .map(item => ({ from: item.from, to: item.to }))

  const result = await guard(
    invoke<Partial<NoteImageMigrated>>('note_images_migrate', {
      repo,
      root,
      oldDir: input.oldDir,
      newDir: input.newDir,
      renames,
      replacements,
    }),
    '迁移图片失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '迁移图片失败')

  return ok({
    moved: typeof result.data.moved === 'number' ? result.data.moved : 0,
    rewritten: typeof result.data.rewritten === 'number' ? result.data.rewritten : 0,
    failed: typeof result.data.failed === 'number' ? result.data.failed : 0,
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    log: typeof result.data.log === 'string' ? result.data.log : '',
  })
}

/** 笔记本里所有笔记的正文（引用计数用）：只读盘，怎么算引用是渲染层的事 */
export async function scanNoteTexts(root: string): Promise<Result<NoteTextScan>> {
  const result = await guard(
    invoke<{ files?: unknown, failed?: unknown }>('note_scan_texts', { root: rootArg(root) }),
    '读取笔记正文失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '读取笔记正文失败')

  const raw = Array.isArray(result.data.files) ? result.data.files : []
  const files: NoteTextScan['files'] = []
  for (const item of raw) {
    const entry = item as { rel?: unknown, text?: unknown } | null
    if (typeof entry?.text !== 'string')
      continue
    files.push({ rel: typeof entry.rel === 'string' ? entry.rel : '', text: entry.text })
  }

  return ok({
    files,
    failed:
      typeof result.data.failed === 'number' && Number.isFinite(result.data.failed)
        ? result.data.failed
        : 0,
  })
}

// ---------- 与远端同步 ----------

/**
 * 把当前笔记本与**它自己连着的那个仓库**对齐一次（提交 → 拉 → 推）。
 *
 * 地址不从这里下去：同步到哪儿就是 `dir` 自己 `remote origin` 指着的那个地方，
 * 是 git 说了算的（见 packages/notes/src/note.ts 的 NoteRepoState）。所以这里只带目录，
 * 收敛参数与结果形状：谁先改的、撞上哪几篇，都是 git 说了算。
 *
 * 冲突**不算失败得莫名其妙**：Rust 那边会中止这次 rebase（本地那笔提交留着）并把冲突的文件名
 * 写进错误里，界面照原样显示给用户即可（见 NotesView 的同步按钮）。不是仓库、没有远端
 * 同样是一句说清楚的话，不是异常。
 */
export async function syncNotes(input: NoteSyncInput): Promise<Result<NoteSyncSummary>> {
  const dir = rootArg(input.dir)
  if (!dir)
    return fail('还没有选择笔记文件夹')

  const result = await guard(
    invoke<Partial<NoteSyncSummary>>('note_sync', { dir }),
    '同步笔记失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '同步笔记失败')

  return ok({
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    files:
      typeof result.data.files === 'number' && Number.isFinite(result.data.files)
        ? result.data.files
        : 0,
    received: result.data.received === true,
    log: typeof result.data.log === 'string' ? result.data.log : '',
  })
}

/**
 * 笔记仓库**只拉不推**：进笔记页 / 窗口聚焦时后台对齐远端用（远端有新东西落到本地工作树）。
 * 不提交、不推送本机的改动（`--autostash` 保护未提交现场）—— 推送留给 syncNotes 在停笔 / 切页时做。
 * 探不到仓库 / 远端按失败如实报回去，由调用方决定说不说。
 */
export async function pullNotes(dir: string): Promise<Result<{ branch: string, received: boolean }>> {
  const target = rootArg(dir)
  if (!target)
    return fail('还没有选择笔记文件夹')

  const result = await guard(
    invoke<{ branch?: unknown, received?: unknown }>('note_pull', { dir: target }),
    '拉取笔记失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '拉取笔记失败')

  return ok({
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    received: result.data.received === true,
  })
}

/**
 * 探一个文件夹的 git 状态：有没有仓库、origin 是什么、当前站在哪个分支。
 *
 * 只影响界面（给不给同步入口、同步到哪儿），所以**探不到就算探不到**：
 * 目录不存在之类的情形回一个「什么都没有」的默认值，让上层照「本机笔记」处理，
 * 而不是把整页打成错误态 —— 一个还没选过的目录不该让笔记页报错。
 */
export async function noteRepoState(dir: string): Promise<Result<NoteRepoState>> {
  const target = rootArg(dir)
  if (!target)
    return ok({ isRepo: false, origin: '', branch: '' })

  const result = await guard(
    invoke<Partial<NoteRepoState>>('note_repo_state', { dir: target }),
    '探测笔记仓库失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '探测笔记仓库失败')

  return ok({
    isRepo: result.data.isRepo === true,
    origin: typeof result.data.origin === 'string' ? result.data.origin : '',
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
  })
}
