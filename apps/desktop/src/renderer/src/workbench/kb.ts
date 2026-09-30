/**
 * 知识库的适配层：应用对知识库**只读**，这里只有「扫清单」与「读文件」两条自己的通道，
 * 外加复用笔记那两条通用通道的同步与仓库探测（`note_sync` / `note_repo_state` 本来就是
 * 「对任意文件夹、认它自己的 origin」的实现，技能页同步走的也是它们这族）。
 *
 * 与笔记适配层同一条分工：Rust（kb.rs）只带事实（平铺清单 + 文件文本），
 * 「哪些是原始数据、哪些是条目、有没有更新」的口径都在 shared/kb.ts 的纯函数里，
 * store 负责编排。清单在这里收成确定的形状并按相对路径排好 —— 认不出的条目丢掉，
 * 宁可少一行，也不让 undefined 流进界面。
 */
import { compareKbRel, type KbRepoState, type KbScanEntry, type KbSyncInput, type KbSyncSummary } from '@workbench/kb'
import { fail, ok } from '@workbench/core'
import type { Result } from '@/types'
import { guard, invoke } from './bridge'

/** root 从调用方带进来（设置里的那个值），这里不缓存：用户换了文件夹，来源就换了 */
function rootArg(root: string): string {
  return root.trim()
}

/** 扫知识库文件夹：收成确定的形状（rel 必须有），按相对路径排好 */
export async function kbScan(root: string): Promise<Result<KbScanEntry[]>> {
  const result = await guard(
    invoke<Array<{ rel?: unknown; name?: unknown; isDir?: unknown; mtimeMs?: unknown }>>('kb_scan', {
      root: rootArg(root)
    }),
    '读取知识库失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '读取知识库失败')

  const entries: KbScanEntry[] = []
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const rel = typeof item?.rel === 'string' ? item.rel.trim() : ''
    if (!rel) continue
    entries.push({
      rel,
      name: typeof item?.name === 'string' ? item.name : rel,
      isDir: item?.isDir === true,
      mtimeMs:
        typeof item?.mtimeMs === 'number' && Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0
    })
  }
  entries.sort(compareKbRel)
  return ok(entries)
}

/** 读知识库里的一个文件文本（条目正文 / index.json） */
export function kbRead(root: string, rel: string): Promise<Result<string>> {
  return guard(invoke<string>('kb_read', { root: rootArg(root), rel }), '读取文件失败')
}

/**
 * 知识库与它自己连着的那个仓库对齐一次（提交 → 拉 → 推）。
 *
 * 与笔记同步同一条通道、同一条边界：远端就是 `dir` 自己的 `origin`，不在参数里；
 * 冲突不替用户挑边（Rust 中止这次 rebase、把冲突文件名带回来）。不是仓库、没连远端
 * 都是一句能看懂的话 —— 界面在那之前根本不该显示同步按钮。
 */
export async function kbSync(input: KbSyncInput): Promise<Result<KbSyncSummary>> {
  const dir = rootArg(input.dir)
  if (!dir) return fail('还没有选择知识库文件夹')

  const result = await guard(invoke<Partial<KbSyncSummary>>('note_sync', { dir }), '同步知识库失败')
  if (!result.ok || !result.data) return fail(result.error ?? '同步知识库失败')

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

/**
 * 探测知识库文件夹的 git 状态（有没有仓库、origin 是什么）：只影响界面（给不给同步入口），
 * 所以探不到就算探不到 —— 目录不存在之类的情形回一个「什么都没有」的默认值，
 * 与笔记页同一条口径：一个还没选过的目录不该让知识库页报错。
 */
export async function kbRepoState(dir: string): Promise<Result<KbRepoState>> {
  const target = rootArg(dir)
  if (!target) return ok({ isRepo: false, origin: '', branch: '' })

  const result = await guard(
    invoke<Partial<KbRepoState>>('note_repo_state', { dir: target }),
    '探测知识库仓库失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '探测知识库仓库失败')

  return ok({
    isRepo: result.data.isRepo === true,
    origin: typeof result.data.origin === 'string' ? result.data.origin : '',
    branch: typeof result.data.branch === 'string' ? result.data.branch : ''
  })
}

/**
 * 重建目录与索引（`kb/_catalog.md` 与 `index/index.json`）。
 *
 * 这是应用**唯一直接写知识库的地方**，写的是脚本的产物、不是内容：内容由 AI 助手那一轮
 * 整理写入（写的人是 Pi）。`generatedAt` 由调用方按本机时区算（shared/kb.ts 的
 * todayIsoDate）—— 与仓库脚本的 `date.today()` 同一条口径。
 */
export async function kbIndexBuild(
  root: string,
  generatedAt: string
): Promise<Result<{ count: number }>> {
  const result = await guard(
    invoke<{ count?: unknown }>('kb_index_build', { root: rootArg(root), generatedAt }),
    '重建索引失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '重建索引失败')
  const count =
    typeof result.data.count === 'number' && Number.isFinite(result.data.count)
      ? result.data.count
      : 0
  return ok({ count })
}
