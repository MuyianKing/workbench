/**
 * 技能的适配层：把「文件动作 + 版本提交」编排成一条条通道。
 *
 * 技能就是笔记文件夹里的普通文件（见 shared/skills.ts 的文件头），所以读写删除直接走
 * 笔记的那几条通道（note_create / note_write / note_delete）—— 越界与非法名字的把关
 * 由 Rust 侧同一套逻辑承担。这一层补上的只有两件事：
 *
 *   1. **每次改动之后提交一次版本**（skill_commit）：新建、保存、删除、导入各记一笔，
 *      提交信息统一 `skill: <id> 动作`。提交失败**不拦主流程**（文件已经落盘了，
 *      版本这次没记上，下一次任何提交会把它带上）—— 只有 Rust 侧确认过的「没产生版本」
 *      （还不是仓库、内容没变）才是什么都不用做的正常情况；
 *   2. **frontmatter 的解析**（名字与描述的提取，shared/skills.ts 里的纯函数）：
 *      Rust 只回 SKILL.md 原文，那是数据；「它的名字是什么」是语义，留在这边。
 */
import { noteNameProblem, sanitizeNoteName } from '@shared/note'
import {
  SKILL_FILE,
  SKILL_VERSION_DEFAULT,
  mergeVersionCopies,
  sanitizeSkillSyncDir,
  skillFileRel,
  skillMdTemplate,
  skillRel,
  skillVersionOf,
  skillVersionProblem,
  toSkillEntry,
  type SkillCommit,
  type SkillCompareFile,
  type SkillCreateInput,
  type SkillEntry,
  type SkillFileCopy,
  type SkillFileInfo,
  type SkillInstalledScan,
  type SkillLibraryState,
  type SkillSyncSummary
} from '@shared/skills'
import { fail, ok } from '@shared/result'
import type { Result } from '@shared/types'
import { guard, invoke } from './bridge'

/**
 * 技能库在仓库里的相对路径：调用方带来的是从磁盘上找出来的那个（`skillState` 给的），
 * 这里只按同一条口径再收一次 —— 它接下来要拼文件路径与 git pathspec。
 *
 * **空串照原样传下去**：技能库自己就是仓库根（专门的技能仓库）时就是这个空串。
 */
function dirArg(dir: string): string {
  return sanitizeSkillSyncDir(dir)
}

/** 技能 id 的收敛：它就是个目录名，与笔记名字同一条规矩 */
function idArg(id: string): Result<string> {
  const cleaned = sanitizeNoteName(id)
  const problem = noteNameProblem(cleaned)
  if (problem) return fail(problem)
  return ok(cleaned)
}

/** 改动之后提交一次版本；失败只记一笔（文件已经落盘，主流程不为它回头） */
async function commitSkill(root: string, dir: string, message: string): Promise<void> {
  const result = await guard(
    invoke<unknown>('skill_commit', { root: root.trim(), dir: dirArg(dir), message }),
    '提交技能版本失败'
  )
  if (!result.ok) console.warn('[workbench] 技能版本提交失败:', result.error)
}

/** 列出技能库：Rust 回原文，名字与描述在这里解析成摘要 */
export async function listSkills(root: string, dir: string): Promise<Result<SkillEntry[]>> {
  const result = await guard(
    invoke<Array<{ id?: unknown; fileCount?: unknown; skillMd?: unknown }>>('skill_list', {
      root: root.trim(),
      dir: dirArg(dir)
    }),
    '读取技能失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取技能失败')

  const entries = (Array.isArray(result.data) ? result.data : [])
    .map((raw) => toSkillEntry(raw))
    .filter((entry): entry is SkillEntry => entry !== null)
  return ok(entries)
}

/**
 * 技能库与它的仓库（从技能库目录往上找最近的 `.git`）。
 *
 * 回的 `repo` / `libraryRel` 是后面每条通道要用的那两个值（`<repo>/<libraryRel>` 才是库本身）。
 * 目录不在时如实失败：界面据此提示「重新选一个技能文件夹」，而不是把整页打成空技能库。
 */
export async function skillState(dir: string): Promise<Result<SkillLibraryState>> {
  const target = dir.trim()
  if (!target) return fail('还没有选择技能库目录')

  const result = await guard(
    invoke<Partial<SkillLibraryState>>('skill_state', { dir: target }),
    '读取技能库失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取技能库失败')

  return ok({
    repo: typeof result.data.repo === 'string' ? result.data.repo : '',
    libraryRel: sanitizeSkillSyncDir(result.data.libraryRel ?? ''),
    hasGit: result.data.hasGit === true,
    origin: typeof result.data.origin === 'string' ? result.data.origin : ''
  })
}

/**
 * 同步技能库所在的仓库：先提交技能库那一层，再拉、再推。
 *
 * 与笔记同步那条的区别只在提交范围（那边是整个笔记本），其余一模一样：
 * 冲突**不替用户挑边**（Rust 会中止这次 rebase、把冲突的文件名带回来），
 * 不是仓库、没连远端都是一句能看懂的话。
 */
export async function skillSync(root: string, dir: string): Promise<Result<SkillSyncSummary>> {
  const current = root.trim()
  if (!current) return fail('技能库还不在 git 仓库里')

  const result = await guard(
    invoke<Partial<SkillSyncSummary>>('skill_sync', { root: current, dir: dirArg(dir) }),
    '同步技能失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '同步技能失败')

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

/** 新建技能：建目录 → 写 SKILL.md 骨架 → 提交第一版 */
export async function createSkill(
  root: string,
  dir: string,
  input: SkillCreateInput
): Promise<Result<null>> {
  const id = idArg(input.id)
  if (!id.ok || !id.data) return fail(id.error ?? '技能名不合法')

  const base = dirArg(dir)
  const created = await guard(
    invoke<null>('note_create', {
      root: root.trim(),
      rel: skillRel(base, id.data),
      isDir: true
    }),
    '新建技能失败'
  )
  if (!created.ok) return fail(created.error ?? '新建技能失败')

  const written = await guard(
    invoke<null>('note_write', {
      root: root.trim(),
      rel: skillFileRel(base, id.data),
      content: skillMdTemplate(sanitizeNoteName(input.name) || id.data, input.description ?? '')
    }),
    '写入 SKILL.md 失败'
  )
  if (!written.ok) return fail(written.error ?? '写入 SKILL.md 失败')

  await commitSkill(root, base, `skill: ${id.data} 新建 ${SKILL_VERSION_DEFAULT}`)
  return ok(null)
}

/** 技能内文件的相对路径（rel 是清单回来的那种「相对技能目录」的写法） */
function fileRel(dir: string, id: string, rel: string): string {
  const base = skillRel(dirArg(dir), id)
  const clean = rel.trim().replace(/\\/g, '/')
  return base ? `${base}/${clean}` : clean
}

/**
 * 保存技能里的一个文件。
 *
 * **保存 SKILL.md（清单）时有必经的 version 门槛**：frontmatter 里必须有一个语义化版本
 * 的 version 字段（三段数字，如 1.0.0），没有就整个不落盘 —— 写了盘却记不上版本，
 * 比拒绝保存更糟（用户会以为改动已经安全了）。通过之后内容真的变了才产生提交，
 * 提交信息带着这个版本号：「这个改动是哪个版本」在 git 日志里直接可查。
 * 附属文件没有 version 一说，提交信息带文件路径。
 */
export async function saveSkillFile(
  root: string,
  dir: string,
  id: string,
  rel: string,
  content: string
): Promise<Result<null>> {
  const cleaned = idArg(id)
  if (!cleaned.ok || !cleaned.data) return fail(cleaned.error ?? '技能名不合法')

  const isMainFile = rel.trim() === SKILL_FILE
  let message: string
  if (isMainFile) {
    const versionProblem = skillVersionProblem(content)
    if (versionProblem) return fail(versionProblem)
    message = `skill: ${cleaned.data} 保存 ${skillVersionOf(content)}`
  } else {
    const relProblem = noteNameProblem(rel.trim().split('/').pop() ?? '')
    if (relProblem) return fail(relProblem)
    message = `skill: ${cleaned.data} 保存 ${rel.trim()}`
  }

  const written = await guard(
    invoke<null>('note_write', {
      root: root.trim(),
      rel: fileRel(dir, cleaned.data, rel),
      content
    }),
    '保存技能失败'
  )
  if (!written.ok) return fail(written.error ?? '保存技能失败')

  await commitSkill(root, dir, message)
  return ok(null)
}

/** 读技能里的一个文件（任意文本文件；二进制读不出文本时如实失败） */
export async function readSkillFile(
  root: string,
  dir: string,
  id: string,
  rel: string
): Promise<Result<string>> {
  return guard(
    invoke<string>('note_read', { root: root.trim(), rel: fileRel(dir, id.trim(), rel) }),
    '读取文件失败'
  )
}

/** 技能目录里的全部文件（相对路径 + 字节数），认不出的条目丢掉 */
export async function listSkillFiles(
  root: string,
  dir: string,
  id: string
): Promise<Result<SkillFileInfo[]>> {
  const result = await guard(
    invoke<Array<{ rel?: unknown; size?: unknown }>>('skill_files', {
      root: root.trim(),
      dir: dirArg(dir),
      id: id.trim()
    }),
    '读取技能文件清单失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取技能文件清单失败')

  const files: SkillFileInfo[] = []
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const rel = typeof item?.rel === 'string' ? item.rel.trim() : ''
    if (!rel) continue
    files.push({
      rel,
      size: typeof item?.size === 'number' && Number.isFinite(item.size) ? item.size : 0
    })
  }
  return ok(files)
}

/** 删除技能（整棵目录），并把这次删除提交进历史 */
export async function removeSkill(root: string, dir: string, id: string): Promise<Result<null>> {
  const cleaned = idArg(id)
  if (!cleaned.ok || !cleaned.data) return fail(cleaned.error ?? '技能名不合法')

  const removed = await guard(
    invoke<null>('note_delete', { root: root.trim(), rel: skillRel(dirArg(dir), cleaned.data) }),
    '删除技能失败'
  )
  if (!removed.ok) return fail(removed.error ?? '删除技能失败')

  await commitSkill(root, dir, `skill: ${cleaned.data} 删除`)
  return ok(null)
}

/** 从本机一个文件夹导入技能（整棵复制，`.git` 之类的隐藏目录不带） */
export async function importSkill(
  root: string,
  dir: string,
  source: string,
  id: string
): Promise<Result<null>> {
  const cleaned = idArg(id)
  if (!cleaned.ok || !cleaned.data) return fail(cleaned.error ?? '技能名不合法')

  const imported = await guard(
    invoke<unknown>('skill_import', {
      root: root.trim(),
      dir: dirArg(dir),
      source: source.trim(),
      id: cleaned.data
    }),
    '导入技能失败'
  )
  if (!imported.ok) return fail(imported.error ?? '导入技能失败')

  await commitSkill(root, dir, `skill: ${cleaned.data} 导入`)
  return ok(null)
}

/** 版本历史：Rust 回来的原始行收成确定的形状，认不出的丢掉 */
export async function skillHistory(
  root: string,
  dir: string,
  id: string,
  limit?: number
): Promise<Result<SkillCommit[]>> {
  const result = await guard(
    invoke<Array<{ hash?: unknown; time?: unknown; subject?: unknown }>>('skill_history', {
      root: root.trim(),
      dir: dirArg(dir),
      id: id.trim(),
      limit
    }),
    '读取版本历史失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取版本历史失败')

  const commits: SkillCommit[] = []
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const hash = typeof item?.hash === 'string' ? item.hash : ''
    const subject = typeof item?.subject === 'string' ? item.subject : ''
    if (!hash) continue
    commits.push({
      hash,
      time: typeof item?.time === 'number' && Number.isFinite(item.time) ? item.time : 0,
      subject
    })
  }
  return ok(commits)
}

/** 恢复到指定版本（Rust 侧检出旧版并提交恢复记录；这里没有别的要补） */
export async function restoreSkill(
  root: string,
  dir: string,
  id: string,
  hash: string
): Promise<Result<null>> {
  return guard(
    invoke<null>('skill_restore', {
      root: root.trim(),
      dir: dirArg(dir),
      id: id.trim(),
      hash: hash.trim()
    }),
    '恢复版本失败'
  )
}

/** Rust 回来的那种「一份文件副本」：rel 相对技能目录，content 为 null 表示读不出文本 */
function fileCopiesOf(raw: unknown): SkillFileCopy[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const rel = typeof (item as { rel?: unknown })?.rel === 'string' ? (item as { rel: string }).rel.trim() : ''
    if (!rel) return []
    const content = (item as { content?: unknown })?.content
    return [{ rel, content: typeof content === 'string' ? content : null }]
  })
}

/**
 * 某一版与现在这一份的逐文件对比（版本历史里点「对比」，恢复之前先看清差异）。
 *
 * 两侧都由 Rust 一次取回（分两条通道去问，中间可能插进别的提交），这里只把原始条目收成
 * 确定的形状、再按一条口径合并 —— 「谁是要采纳的那一份」「清单取并集」都在
 * shared/skills.ts 的 `mergeVersionCopies` 里，那边有单测。
 */
export async function compareSkillVersion(
  root: string,
  dir: string,
  id: string,
  hash: string
): Promise<Result<SkillCompareFile[]>> {
  const result = await guard(
    invoke<{ current?: unknown; version?: unknown }>('skill_version_compare', {
      root: root.trim(),
      dir: dirArg(dir),
      id: id.trim(),
      hash: hash.trim()
    }),
    '读取版本内容失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取版本内容失败')

  return ok(
    mergeVersionCopies(fileCopiesOf(result.data.current), fileCopiesOf(result.data.version))
  )
}

/** 安装到项目；「已安装」由 Rust 报错带回，覆盖与否由界面确认后带 overwrite 重调 */
export async function installSkill(
  root: string,
  dir: string,
  id: string,
  projectDir: string,
  overwrite: boolean
): Promise<Result<null>> {
  return guard(
    invoke<null>('skill_install', {
      root: root.trim(),
      dir: dirArg(dir),
      id: id.trim(),
      projectDir: projectDir.trim(),
      overwrite
    }),
    '安装技能失败'
  )
}

/**
 * 库与各项目副本的全文件扫描（只读）：形状收成确定的清单，认不出的条目丢掉。
 * 「有没有更新」的口径（SKILL.md 比 version、附属文件比内容）在渲染层。
 */
export async function scanSkillCopies(
  root: string,
  dir: string,
  id: string,
  projectDirs: string[]
): Promise<Result<SkillInstalledScan>> {
  const result = await guard(
    invoke<{ library?: unknown; projects?: unknown }>('skill_installed_versions', {
      root: root.trim(),
      dir: dirArg(dir),
      id: id.trim(),
      projectDirs: projectDirs.map((path) => path.trim()).filter(Boolean)
    }),
    '读取项目里的技能副本失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取项目里的技能副本失败')

  const fileOf = (item: unknown): { rel: string; content: string | null } | null => {
    const rel = typeof (item as { rel?: unknown })?.rel === 'string' ? (item as { rel: string }).rel.trim() : ''
    if (!rel) return null
    const content = (item as { content?: unknown })?.content
    return { rel, content: typeof content === 'string' ? content : null }
  }

  const library = Array.isArray(result.data.library)
    ? result.data.library.map(fileOf).filter((file): file is NonNullable<typeof file> => file !== null)
    : []

  const projects = Array.isArray(result.data.projects)
    ? (result.data.projects as Array<{ project?: unknown; files?: unknown }>).flatMap((copy) => {
        const project = typeof copy?.project === 'string' ? copy.project.trim() : ''
        if (!project) return []
        const files = Array.isArray(copy.files)
          ? copy.files.map(fileOf).filter((file): file is NonNullable<typeof file> => file !== null)
          : []
        return [{ project, files }]
      })
    : []

  return ok({ library, projects })
}
