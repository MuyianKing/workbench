/**
 * 视频页：**用户自己挑的那个文件夹**里的 MP4 文件，与播放器的几个纯逻辑口径。
 *
 * 与笔记（shared/note.ts）同一套分工：磁盘那一半在 `src-tauri/src/video.rs`
 * （递归扫目录、只收文件夹与 MP4），这里管三件事：
 *   1. 把后端扫出来的平铺清单组回一棵树（文件夹在前、同层按名字排）；
 *   2. 「打开过的目录」那份历史（与笔记本的「最近打开」同一条收敛 —— 复用 note.ts 的实现，
 *      名字各叫各的，逻辑只有一份）；
 *   3. 播放速率的档位表与相邻档的换算（快捷键 ↑/↓ 走它）。
 *
 * 全是纯函数，放这里是为了被单测直接覆盖。目录收敛（sanitizeVideoRoot）与
 * 笔记文件夹是同一件事（本机挑的一个目录），直接复用 note.ts 的那几个函数。
 */
import {
  buildRelTree,
  countRelNodes,
  findRelNode,
  normalizeRel,
  noteRootName,
  pushNoteHistory,
  relChain,
  removeFromNoteHistory,
  sanitizeNoteHistory,
  sanitizeNoteRoot,
  sanitizeNoteTreeExpanded,
  sortRelNodes
} from '@workbench/notes'

/** 只认这一种后缀。别的容器（mkv / avi / flv…）webview 里的解码器不一定有，先不收 */
const VIDEO_EXTENSION = '.mp4'

export const VIDEO_KINDS = ['folder', 'video'] as const
export type VideoKind = (typeof VIDEO_KINDS)[number]

/** 后端扫出来的一个条目（原始的平铺清单，树由 `buildVideoTree` 组） */
export interface VideoEntry {
  /** 相对视频根的路径，用 `/` 分隔 */
  rel: string
  /** 条目自己的名字（含后缀） */
  name: string
  isDir: boolean
  /** 视频时长（秒，Rust 解 MP4 容器得来，四舍五入到整数）；文件夹与读不出的按 0 */
  duration?: number
}

/** 树上的一个节点：文件夹或一个视频 */
export interface VideoNode {
  /** `el-tree` 的 node-key：就是 `rel`（同一个文件夹里不会有两条同路径的条目） */
  id: string
  /** 相对视频根的路径 */
  rel: string
  /** 显示名。视频不含 `.mp4` 后缀 —— 后缀是「它是什么」的表达，由图标承担 */
  name: string
  kind: VideoKind
  /** 子项；只有文件夹有 */
  children?: VideoNode[]
  /** 视频时长（秒）；文件夹与读不出的按 0 */
  duration?: number
}

/** 是不是一个视频文件（按后缀判，与 Rust 侧同一个口径） */
export function isVideoFile(name: string): boolean {
  return name.trim().toLowerCase().endsWith(VIDEO_EXTENSION)
}

/** 文件名 → 显示名（去掉后缀） */
export function videoDisplayName(fileName: string): string {
  return fileName.replace(/\.mp4$/i, '')
}

/**
 * 树这一套（排序 / 组树 / 查找 / 计数 / 链）与笔记树逐行同构，实现只在 note.ts 里写一份
 * （buildRelTree / sortRelNodes / findRelNode / relChain / countRelNodes）；这里按视频的
 * 名字各留一个出口 —— 名字各叫各的，逻辑只有一份。
 */

/** 收敛一个相对路径：分隔符统一成 `/`、去掉空段与 `.` 段（与 note.ts 同一条口径） */
export const normalizeVideoRel = normalizeRel

/**
 * 同层排序：**文件夹在前、视频在后**，各自按名字排（与笔记树同一条规则，
 * 连 `笔记 10` 排在 `笔记 9` 后面的 numeric 口径也一样）。
 */
export function sortVideoNodes(nodes: readonly VideoNode[]): VideoNode[] {
  return sortRelNodes(nodes)
}

/**
 * 平铺清单 → 树。
 *
 * 只收文件夹与 MP4 文件：别的文件（字幕、封面、nfo）不进树 —— 这一页是看视频的，
 * 树里摆一排打不开的东西只会添堵。父目录不在清单里时（扫描期间被删掉）挂到根上。
 */
export function buildVideoTree(entries: readonly VideoEntry[]): VideoNode[] {
  return buildRelTree(entries, (rel, fileName, entry): VideoNode | null => {
    if (!isVideoFile(fileName)) return null
    return {
      id: rel,
      rel,
      name: videoDisplayName(fileName),
      kind: 'video',
      duration:
        typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0
          ? entry.duration
          : 0
    }
  })
}

/** 整棵树里的视频个数（文件夹不算） */
export function countVideos(nodes: readonly VideoNode[]): number {
  return countRelNodes(nodes, 'video')
}

/** 深度优先找到某个路径上的节点；找不到返回 null */
export function findVideoNode(nodes: readonly VideoNode[], rel: string): VideoNode | null {
  return findRelNode(nodes, rel)
}

/** 从最外层到该节点的完整链（含自身）；找不到返回空数组。选中项所在的那几层靠它展开 */
export function videoChain(nodes: readonly VideoNode[], rel: string): VideoNode[] {
  return relChain(nodes, rel)
}

// ---------- 打开过的视频目录（与笔记本的「最近打开」同一条收敛） ----------

/**
 * 「最近打开」最多留几条。与笔记同款：再多只是一份往回找的清单，
 * 目的只有「换回上次那个目录不必再翻一遍」。
 */
export const VIDEO_HISTORY_MAX = 6

/**
 * 视频文件夹的收敛与显示名**就是**笔记文件夹那两个：都是「本机挑的一个目录」，
 * 规矩（去首尾空白与末尾分隔符、盘根留住分隔符）不该有两份，见 note.ts 的说明。
 */
export const sanitizeVideoRoot = sanitizeNoteRoot
export const videoRootName = noteRootName

/** 收敛一份「打开过的视频目录」清单：逐条收敛、去重（不分大小写）、超上限整段丢掉 */
export function sanitizeVideoHistory(raw: unknown): string[] {
  return sanitizeNoteHistory(raw)
}

/** 打开（或换到）一个目录：它排到最前面，已在那儿的不会出现两次 */
export function pushVideoHistory(history: unknown, dir: unknown): string[] {
  return pushNoteHistory(history, dir)
}

/** 删掉清单里的一条（历史记录可以删）；本来就不在里面时原样返回 */
export function removeFromVideoHistory(history: unknown, dir: unknown): string[] {
  return removeFromNoteHistory(history, dir)
}

/**
 * 收敛「目录树里摊开了哪几层」（相对视频根的文件夹路径）。
 *
 * 与笔记树的展开清单同一条规矩：分隔符统一、去重不看大小写、含 `..` 的直接丢掉、
 * 超上限整段丢掉。换目录时清空 —— 相对路径在另一个目录里指的是完全不同的东西。
 */
export const VIDEO_TREE_EXPANDED_MAX = 64

export function sanitizeVideoTreeExpanded(raw: unknown): string[] {
  return sanitizeNoteTreeExpanded(raw)
}

/**
 * 收敛「上次打开的视频」（相对视频根的路径，空串 = 没有记录）。
 *
 * 与树展开清单同一条防线：归一化分隔符，含 `..` 的直接丢掉 —— 那个路径不属于这个目录，
 * 留着永远匹配不上任何一个节点。它只对**当前这个目录**成立，换目录时清空
 * （见 stores/video.ts 的 setRoot）。
 */
export function sanitizeVideoLastRel(raw: unknown): string {
  const rel = normalizeVideoRel(raw)
  if (!rel || rel.split('/').includes('..')) return ''
  return rel
}

// ---------- 播放 ----------

/** 打开一个视频后交给 `<video>` 的东西：URL 由后端授权 asset 协议后转出 */
export interface VideoSource {
  /** 相对视频根的路径 */
  rel: string
  /** 显示名（不含后缀） */
  name: string
  /** webview 能直接加载的地址（asset 协议，支持 Range，拖进度条不用整份下完） */
  url: string
}

/** 播放速率的档位表（倍）；快捷键 ↑/↓ 与界面上的菜单共用这一份 */
export const VIDEO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

/** 快进 / 快退一步多少秒 */
export const VIDEO_SEEK_SECONDS = 5

/** 播完自动接下一个的倒计时（秒）；浮层上的秒数与进度线都按它走 */
export const VIDEO_NEXT_SECONDS = 3

/**
 * 播放顺序里的下一个视频：把树按展示顺序（文件夹在前、同层按名字，深度优先）摊平，
 * 取当前那一个后面的第一个视频 —— 「播完自动接下去」的顺序与树上从上往下的阅读顺序一致。
 * 现在播的就是最后一个（或这个路径根本不在树里）时返回 null，此时不自动接。
 */
export function nextVideoNode(nodes: readonly VideoNode[], rel: string): VideoNode | null {
  const target = normalizeVideoRel(rel)
  if (!target) return null

  const videos: VideoNode[] = []
  const walk = (list: readonly VideoNode[]): void => {
    for (const node of list) {
      if (node.kind === 'video') videos.push(node)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)

  const at = videos.findIndex((node) => node.rel === target)
  // 当前那一个不在树里（被删了、路径是别的目录的）按「没有下一个」算，
  // 不能让 -1 + 1 恰好捞回第一个视频
  if (at === -1) return null
  return videos[at + 1] ?? null
}

/** 把速率夹回档位表：认不出的取值（手工改坏的落盘值）回到常速 */
export function clampVideoRate(value: unknown): number {
  const rate = typeof value === 'number' && Number.isFinite(value) ? value : 1
  const nearest = VIDEO_RATES.reduce((best, item) =>
    Math.abs(item - rate) < Math.abs(best - rate) ? item : best
  )
  return nearest
}

/**
 * 当前档位的相邻档：`direction` 正数升、负数降，顶到头就不动。
 * 当前值不在档位表里时（理论上到不了，clamp 兜底）按最近的档算。
 */
export function nextVideoRate(current: number, direction: 1 | -1): number {
  const rate = clampVideoRate(current)
  const index = VIDEO_RATES.indexOf(rate as (typeof VIDEO_RATES)[number])
  const next = index + direction
  return VIDEO_RATES[Math.max(0, Math.min(VIDEO_RATES.length - 1, next))]
}

// ---------- 画中画悬浮小窗 ----------

/**
 * 切到别的页时正播的视频缩成的那只悬浮小窗。
 *
 * 位置与尺寸会落盘（theme.json，与视频树宽同属「这一页长什么样」），读它的一方
 * （sanitizeTheme）与拖动它的一方（VideoPlayer）必须用同一套边界 —— 共用规则与
 * 终端悬浮按钮（shared/terminal-dock.ts）同一个道理：手改过的数据文件不能把小窗
 * 放到够不着的地方去。
 *
 * **位置存视口百分比而不是像素**（同 terminal-dock.ts 的口径）：换台机器、把窗口
 * 拉大拉小，小窗都还停在差不多的地方。窗口内的最终落点渲染时按当前视口再 clamp
 * 一次（那里才知道小窗自己的宽高），这里的边界只是数据文件的第一道防线。
 */

/** 小窗默认尺寸（px）：16:9 出来的 320×180，不压内容也不挡太多笔记 */
export const VIDEO_FLOAT_SIZE_DEFAULT = { width: 320, height: 180 }

/** 小窗最小 / 最大尺寸（px）：再小看不清字幕，再大就是回去看视频页了 */
export const VIDEO_FLOAT_SIZE_MIN = { width: 240, height: 135 }
export const VIDEO_FLOAT_SIZE_MAX = { width: 1280, height: 720 }

/** 位置（视口百分比）的默认落点：右上角 —— 那儿离笔记正文最远，也最少挡东西 */
export const VIDEO_FLOAT_X_DEFAULT = 100
export const VIDEO_FLOAT_Y_DEFAULT = 0

/**
 * 收敛位置（视口百分比）：0–100，超界一律拉回；缺失 / 认不出的取值回到 `fallback`
 * —— X 的默认是右上角、Y 的默认是顶边（与 DEFAULT_THEME 同一口径）。
 */
export function clampVideoFloatPercent(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return clampVideoFloatPercent(fallback)
  return Math.min(100, Math.max(0, value))
}

function clampVideoFloatSide(value: unknown, min: number, max: number, fallback: number): number {
  const size = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(size)))
}

/** 收敛小窗宽度（px）；缺失 / 认不出的取值回到默认尺寸 */
export function clampVideoFloatWidth(value: unknown): number {
  return clampVideoFloatSide(value, VIDEO_FLOAT_SIZE_MIN.width, VIDEO_FLOAT_SIZE_MAX.width, VIDEO_FLOAT_SIZE_DEFAULT.width)
}

/** 收敛小窗高度（px）；缺失 / 认不出的取值回到默认尺寸 */
export function clampVideoFloatHeight(value: unknown): number {
  return clampVideoFloatSide(value, VIDEO_FLOAT_SIZE_MIN.height, VIDEO_FLOAT_SIZE_MAX.height, VIDEO_FLOAT_SIZE_DEFAULT.height)
}

/**
 * 落盘值 → 当前视口里的渲染盒子：宽高先压进视口（渲染不可能比视口大），
 * 落点再压到「整个小窗都在视口内」。拖动 / 缩放 / 渲染共用这一份口径 ——
 * 位置存的是视口百分比，只知道「大概在哪」；压不进视口的边界在这里收口。
 */
export function fitVideoFloatGeometry(
  geometry: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number }
): { left: number; top: number; width: number; height: number } {
  const width = Math.min(geometry.w, viewport.w)
  const height = Math.min(geometry.h, viewport.h)
  return {
    width,
    height,
    left: Math.min(Math.max(0, (geometry.x / 100) * viewport.w), viewport.w - width),
    top: Math.min(Math.max(0, (geometry.y / 100) * viewport.h), viewport.h - height)
  }
}

/**
 * 抓角落缩放悬浮小窗：右下 / 左下两枚手柄共用这一份。
 *
 * **抓哪一角、对角钉住不动**：
 *   - 右下角：左上角钉住，宽高随位移长（往右下拖是长大）；
 *   - 左下角：**右上角钉住** —— 往左拖是长大，宽度的变化全部折进左缘
 *     （`left = 右缘 - 新宽`），右缘按当前视口现算的渲染位置钉住不漂。
 *
 * 宽高各自压回 [MIN, MAX]；左缘不得越过视口左缘（宽最多长到右缘那么宽）。
 * 视口比最小宽还窄的极端情形保住 MIN：左缘钉在 0，越界的那一点交给渲染再压。
 */
export function resizeVideoFloat(
  geometry: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  edge: 'left' | 'right',
  dx: number,
  dy: number
): { x: number; y: number; w: number; h: number } {
  const height = clampVideoFloatHeight(geometry.h + dy)

  if (edge === 'right') {
    return { x: geometry.x, y: geometry.y, w: clampVideoFloatWidth(geometry.w + dx), h: height }
  }

  // 右上角钉住：右缘是当前视口里渲染出来的那条边（拖动期间起点不变，锚不漂）
  const fit = fitVideoFloatGeometry(geometry, viewport)
  const rightEdge = fit.left + fit.width
  const width = Math.min(
    clampVideoFloatWidth(geometry.w - dx),
    Math.max(VIDEO_FLOAT_SIZE_MIN.width, rightEdge)
  )
  const left = Math.max(0, rightEdge - width)

  return { x: (left / viewport.w) * 100, y: geometry.y, w: width, h: height }
}

/** 秒 → `h:mm:ss`（不足一小时不带小时段）；NaN / 无穷按 0 处理 */
export function formatVideoTime(totalSeconds: number): string {
  const total = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (value: number): string => String(value).padStart(2, '0')
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}
