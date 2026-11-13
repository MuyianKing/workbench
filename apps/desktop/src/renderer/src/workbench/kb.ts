import type { KbLocalFile, KbRepoState, KbScanEntry, KbScanResult, KbSyncSummary } from '@workbench/kb'
import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
/**
 * 知识库的适配层：扫描（带清单原文）、读文件、内容指纹，以及那几件**受控的写动作**
 * （源头同步 / 删知识库 / 删文件 / 写清单 / 一次性迁移 / 删条目 / 重建索引），
 * 外加知识库仓库自己的两条 git 通道（kb_sync 提交拉推、kb_pull 只拉不推）。
 *
 * 与笔记适配层同一条分工：Rust（kb.rs）只带事实与受控写动作，「哪些是原始数据、
 * 哪些是条目、有没有更新、清单怎么解析」的口径都在 packages/kb/src/kb.ts 的纯函数里，
 * store 负责编排。清单在这里收成确定的形状并按相对路径排好 —— 认不出的条目丢掉，
 * 宁可少一行，也不让 undefined 流进界面。
 *
 * **仓库结构是 raw/ + data/ 两层**：原始数据物理在仓库里（清洗前上传远程是硬前置），
 * 知识库列表来自 `raw/kb.json`；本机关联的源头文件夹只落设置、每次写动作现传一份
 * （它是本机的事实，Rust 不缓存它）。
 */
import { compareKbRel } from '@workbench/kb'
import { recordActivity } from './activity'
import { guard, invoke } from './bridge'

/** root 从调用方带进来（设置里的那个值），这里不缓存：用户换了文件夹，一切都换 */
function rootArg(root: string): string {
  return root.trim()
}

/**
 * 扫知识库文件夹：收成确定的形状（rel 必须有，abs 认不出就是空串），按相对路径排好。
 * 清单文件（`raw/kb.json`）的原文一起带回去 —— 解析是渲染层的口径。
 */
export async function kbScan(
  root: string,
  links: Array<{ name: string, dir: string }>,
): Promise<Result<KbScanResult>> {
  const result = await guard(
    invoke<{
      entries?: Array<{ rel?: unknown, name?: unknown, isDir?: unknown, mtimeMs?: unknown, abs?: unknown }>
      manifest?: unknown
      local?: Array<{ name?: unknown, rel?: unknown, mtimeMs?: unknown, hash?: unknown, abs?: unknown }>
    }>('kb_scan', {
      root: rootArg(root),
      // 本机关联随扫描带走（源头文件夹指纹在 Rust 侧顺路算）：空名字 / 空路径的丢掉
      links: links
        .map(link => ({ name: link.name.trim(), dir: link.dir.trim() }))
        .filter(link => link.name !== '' && link.dir !== ''),
    }),
    '读取知识库失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '读取知识库失败')

  const entries: KbScanEntry[] = []
  for (const item of Array.isArray(result.data.entries) ? result.data.entries : []) {
    const rel = typeof item?.rel === 'string' ? item.rel.trim() : ''
    if (!rel)
      continue
    entries.push({
      rel,
      name: typeof item?.name === 'string' ? item.name : rel,
      isDir: item?.isDir === true,
      mtimeMs:
        typeof item?.mtimeMs === 'number' && Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0,
      abs: typeof item?.abs === 'string' ? item.abs : '',
    })
  }
  entries.sort(compareKbRel)

  const manifest = typeof result.data.manifest === 'string' ? result.data.manifest : ''

  const local: KbLocalFile[] = []
  for (const item of Array.isArray(result.data.local) ? result.data.local : []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    const rel = typeof item?.rel === 'string' ? item.rel.trim() : ''
    if (!name || !rel)
      continue
    local.push({
      name,
      rel,
      mtimeMs:
        typeof item?.mtimeMs === 'number' && Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0,
      hash: typeof item?.hash === 'string' ? item.hash.toLowerCase() : '',
      abs: typeof item?.abs === 'string' ? item.abs : '',
    })
  }
  return ok({ entries, manifest, local })
}

/**
 * 读知识库里 `raw/` 或 `data/` 下的一个文件文本（原始资料 / 条目 / 清单 / 生成物）。
 * 仓库根下的其他文件 Rust 侧不对外读。`links` 是本机关联（知识库名 → 源头文件夹）：
 * raw 层的文件本机里有就读本机的那份（最新内容），没有才读仓库副本。
 */
export function kbRead(
  root: string,
  rel: string,
  links: Array<{ name: string, dir: string }> = [],
): Promise<Result<string>> {
  return guard(
    invoke<string>('kb_read', {
      root: rootArg(root),
      rel,
      links: links
        .map(link => ({ name: link.name.trim(), dir: link.dir.trim() }))
        .filter(link => link.name !== '' && link.dir !== ''),
    }),
    '读取文件失败',
  )
}

/**
 * 与知识库仓库自己连着的那个 origin 对齐一次（提交 → 拉 → 推，提交信息 `kb: <设备名>`）。
 *
 * 清洗前上传原始文件、清洗后推条目、用户手点同步，走的都是它。冲突不替用户挑边
 * （Rust 中止这次 rebase、把冲突文件名带回来）。不是仓库、没连远端都是一句能看懂的话
 * —— 界面在那之前根本不该显示同步入口。
 */
export async function kbSync(dir: string): Promise<Result<KbSyncSummary>> {
  const target = rootArg(dir)
  if (!target)
    return fail('还没有选择知识库文件夹')

  const result = await guard(invoke<Partial<KbSyncSummary>>('kb_sync', { dir: target }), '同步知识库失败')
  if (!result.ok || !result.data)
    return fail(result.error ?? '同步知识库失败')

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
 * 知识库仓库**只拉不推**：打开页面时后台对齐远端用（远端有新东西落到本地工作树，
 * 让列表跟上别的设备）。不提交本机的改动。探不到仓库 / 远端按失败如实报回去，
 * 由调用方决定说不说。
 */
export async function kbPull(dir: string): Promise<Result<{ branch: string, received: boolean }>> {
  const target = rootArg(dir)
  if (!target)
    return fail('还没有选择知识库文件夹')

  const result = await guard(
    invoke<{ branch?: unknown, received?: unknown }>('kb_pull', { dir: target }),
    '拉取知识库失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '拉取知识库失败')

  return ok({
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
    received: result.data.received === true,
  })
}

/**
 * 探测知识库文件夹的 git 状态（有没有仓库、origin 是什么）：只影响界面（给不给同步入口），
 * 所以探不到就算探不到 —— 目录不存在之类的情形回一个「什么都没有」的默认值，
 * 与笔记页同一条口径：一个还没选过的目录不该让知识库页报错。
 */
export async function kbRepoState(dir: string): Promise<Result<KbRepoState>> {
  const target = rootArg(dir)
  if (!target)
    return ok({ isRepo: false, origin: '', branch: '' })

  const result = await guard(
    invoke<Partial<KbRepoState>>('note_repo_state', { dir: target }),
    '探测知识库仓库失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '探测知识库仓库失败')

  return ok({
    isRepo: result.data.isRepo === true,
    origin: typeof result.data.origin === 'string' ? result.data.origin : '',
    branch: typeof result.data.branch === 'string' ? result.data.branch : '',
  })
}

/**
 * 重建 `data/_catalog.md` 与 `data/index.json`（索引只由应用生成）。
 *
 * 这是应用**唯一直接生成知识库索引的地方**：手动重建与清洗收尾两处调用。
 * `generatedAt` 由调用方按本机时区算（packages/kb/src/kb.ts 的 todayIsoDate）。
 */
export async function kbIndexBuild(
  root: string,
  generatedAt: string,
): Promise<Result<{ count: number }>> {
  const result = await guard(
    invoke<{ count?: unknown }>('kb_index_build', { root: rootArg(root), generatedAt }),
    '重建索引失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '重建索引失败')
  const count
    = typeof result.data.count === 'number' && Number.isFinite(result.data.count)
      ? result.data.count
      : 0
  // 记一笔活跃度。建索引是应用直接写知识库的动作，两处调用（手动重建、一键清洗收尾）
  // 都走这条路 —— 顺带也就把「一次整理」记成了一次，不必在清洗那边单独记
  recordActivity('kb')
  return ok({ count })
}

/**
 * 一批原始文件的内容指纹（逻辑路径 → SHA-256 小写十六进制）。
 *
 * 只传**有条目指向的**那些（未入库的不算，见 @workbench/kb 的 kbRawReferencedRels）：
 * 每次重扫都会读这些文件一次，大文件会变慢 —— 这是跨设备准确判定的既定代价。
 * 单个文件读不到就不在结果里，状态判定回落 mtime。
 */
export async function kbFingerprints(
  root: string,
  rels: string[],
): Promise<Result<Record<string, string>>> {
  if (!rels.length)
    return ok({})
  const result = await guard(
    invoke<Record<string, unknown>>('kb_fingerprints', {
      root: rootArg(root),
      rels,
    }),
    '读取原始资料失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '读取原始资料失败')

  const hashes: Record<string, string> = {}
  for (const [rel, value] of Object.entries(result.data)) {
    if (typeof value === 'string' && value)
      hashes[rel] = value.toLowerCase()
  }
  return ok(hashes)
}

/**
 * 删除条目（受控例外）：只删 `data/` 下的 `.md`（生成物 `_catalog.md`、遗留的
 * `data/raw/` 与越界路径由 Rust 拒绝），删完由调用方重建索引（与清洗收尾同一条路）。
 * 返回实际删掉的条数。
 */
export async function kbEntryDelete(
  root: string,
  rels: string[],
): Promise<Result<{ deleted: number }>> {
  if (!rels.length)
    return ok({ deleted: 0 })
  const result = await guard(
    invoke<{ deleted?: unknown }>('kb_entry_delete', { root: rootArg(root), rels }),
    '删除条目失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '删除条目失败')
  return ok({
    deleted:
      typeof result.data.deleted === 'number' && Number.isFinite(result.data.deleted)
        ? result.data.deleted
        : 0,
  })
}

/**
 * 源头同步：把本机关联的源头文件夹复制进 `raw/<名字>/`（新增 / 有变化才复制，不删除）。
 * 添加知识库（全量）与清洗前的源头同步（增量）共用。
 */
export async function kbSourceSync(
  root: string,
  name: string,
  dir: string,
): Promise<Result<{ copied: number, scanned: number }>> {
  const result = await guard(
    invoke<{ copied?: unknown, scanned?: unknown }>('kb_source_sync', {
      root: rootArg(root),
      name,
      dir,
    }),
    '同步源头文件夹失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '同步源头文件夹失败')
  return ok({
    copied: typeof result.data.copied === 'number' ? result.data.copied : 0,
    scanned: typeof result.data.scanned === 'number' ? result.data.scanned : 0,
  })
}

/** 删一个知识库的两层（`raw/<名>/` 与 `data/<名>/`，存在才删）；源头文件夹不动 */
export async function kbDeleteTree(
  root: string,
  name: string,
): Promise<Result<{ raw: boolean, data: boolean }>> {
  const result = await guard(
    invoke<{ raw?: unknown, data?: unknown }>('kb_delete_tree', { root: rootArg(root), name }),
    '删除知识库失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '删除知识库失败')
  return ok({ raw: result.data.raw === true, data: result.data.data === true })
}

/**
 * 删一个原始文件：仓库里那份与关联的源头文件夹里那份一起删（源头持续关联着，
 * 只删仓库里那份会在下一次源头同步时回来）。`dir` 传空串 = 这台机器没有关联。
 */
export async function kbFileDelete(
  root: string,
  name: string,
  dir: string,
  rels: string[],
): Promise<Result<{ deleted: number }>> {
  if (!rels.length)
    return ok({ deleted: 0 })
  const result = await guard(
    invoke<{ deleted?: unknown }>('kb_file_delete', {
      root: rootArg(root),
      name,
      dir,
      rels,
    }),
    '删除文件失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '删除文件失败')
  return ok({
    deleted:
      typeof result.data.deleted === 'number' && Number.isFinite(result.data.deleted)
        ? result.data.deleted
        : 0,
  })
}

/**
 * 生成仓库根的 `AGENTS.md`（给进仓库的 AI 描述结构与用法，内容是应用的口径）：
 * 已存在时不覆盖 —— 用户可能补了自己的说明。添加知识库与迁移之后调一次。
 */
export async function kbAgentsDoc(root: string): Promise<Result<{ written: boolean }>> {
  const result = await guard(
    invoke<{ written?: unknown }>('kb_agents_doc', { root: rootArg(root) }),
    '生成 AGENTS.md 失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '生成 AGENTS.md 失败')
  return ok({ written: result.data.written === true })
}

/**
 * 写清单文件（`raw/kb.json`）。内容由渲染层拼好（serializeKbManifest），这里挡一层
 * 「必须是合法 JSON」。
 */
export async function kbConfigWrite(root: string, content: string): Promise<Result<{ bytes: number }>> {
  const result = await guard(
    invoke<{ bytes?: unknown }>('kb_config_write', { root: rootArg(root), content }),
    '保存知识库清单失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '保存知识库清单失败')
  return ok({ bytes: typeof result.data.bytes === 'number' ? result.data.bytes : 0 })
}

/**
 * 旧结构一次性迁移（kb/ → data/、来源复制进 raw/、source 前缀改写、旧 index/ 删除、
 * 清单落盘）。清单内容由渲染层拼好；只能迁移一次。
 */
export async function kbMigrate(
  root: string,
  sources: Array<{ name: string, dir: string }>,
  manifest: string,
): Promise<Result<{ copied: number, rewritten: number }>> {
  const result = await guard(
    invoke<{ copied?: unknown, rewritten?: unknown }>('kb_migrate', {
      root: rootArg(root),
      sources,
      manifest,
    }),
    '迁移失败',
  )
  if (!result.ok || !result.data)
    return fail(result.error ?? '迁移失败')
  return ok({
    copied: typeof result.data.copied === 'number' ? result.data.copied : 0,
    rewritten: typeof result.data.rewritten === 'number' ? result.data.rewritten : 0,
  })
}
