import type { VideoEntry, VideoNode, VideoSource } from '@workbench/video'
import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
/**
 * 视频的适配层实现：**用户自己挑的那个文件夹** ↔ 磁盘上的 MP4 文件。
 *
 * 与笔记（workbench/note.ts）同一条分工：这里没有数据文件、也没有内存副本，
 * 扫描每次都把 root 带下去，读一次就回来 —— 用户在文件管理器里挪了文件、删了视频，
 * 回来点一下刷新就是最新的样子。
 *
 * 这一层只做两件渲染层不该操心的事：
 *   1. 把 Rust 扫出来的**平铺清单**组回一棵排好序的树（纯函数在 shared/video.ts）；
 *   2. 打开一个视频：拼出绝对路径 → 让后端核一遍并授权 asset 协议 → 转出可直接给
 *      `<video>` 的 URL。授权按文件给（tauri.conf.json 的 scope 保持为空），
 *      所以「能拼出 URL」与「webview 读得到」两件事在这里一次做完。
 */
import { buildVideoTree, normalizeVideoRel, sanitizeVideoRoot, videoDisplayName } from '@workbench/video'
import { assetUrl, guard, invoke } from './bridge'

/** root 从调用方带进来（设置里的那个值），这里不缓存：用户换了文件夹，来源就换了 */
function rootArg(root: string): string {
  return root.trim()
}

/** 读一个文件夹的视频树（文件夹 + MP4 文件），已按「文件夹在前、同层按名字」排好 */
export async function listVideos(root: string): Promise<Result<VideoNode[]>> {
  const result = await guard(
    invoke<VideoEntry[]>('video_scan', { root: rootArg(root) }),
    '读取视频文件夹失败',
  )
  if (!result.ok)
    return fail(result.error ?? '读取视频文件夹失败')

  const entries = Array.isArray(result.data) ? result.data : []
  return ok(buildVideoTree(entries))
}

/**
 * 打开一个视频，回来的是可直接给 `<video>` 的地址。
 *
 * 路径在**这一层**拼（业务语义留 TS）：root 是本机目录、rel 是树里那条相对路径，
 * 拼出来的绝对路径同时交给授权命令与 assetUrl —— 两处用的是同一个字符串，
 * 「授权的」与「播放的」永远是同一个文件。
 */
export async function loadVideo(root: string, rel: string): Promise<Result<VideoSource>> {
  const base = sanitizeVideoRoot(root)
  const clean = normalizeVideoRel(rel)
  if (!base)
    return fail('还没有选择视频文件夹')
  if (!clean)
    return fail('路径不合法')

  const path = `${base}/${clean}`
  const allowed = await guard(invoke<null>('allow_video', { path }), '打开视频失败')
  if (!allowed.ok)
    return fail(allowed.error ?? '打开视频失败')

  try {
    return ok({
      rel: clean,
      name: videoDisplayName(clean.split('/').pop() ?? clean),
      url: assetUrl(path),
    })
  }
  catch {
    return fail('Tauri 运行时不可用，无法播放本地视频')
  }
}
