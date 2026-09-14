/**
 * 路径归一：统一大小写与斜杠方向，得到一个可直接比较的串。
 *
 * 目录是同一个就是同一个，不该因为写法不同被当成两处：
 * 盘符大小写（E:\ 与 e:\）、正反斜杠（E:/a/b 与 E:\a\b）都得归一。
 * 项目比对（pathKey）与残留进程匹配（orphan）以前各有一套相反的斜杠约定，
 * 现在共用这一个 —— 两边都只是拿来做「包含/相等」判断，方向不重要，一致才重要。
 */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

/** 目录比对键：在归一的基础上再去掉结尾斜杠 */
export function pathKey(path: string): string {
  return normalizePath(path).replace(/\/+$/, '')
}

export function samePath(left: string, right: string): boolean {
  const key = pathKey(left)
  return key.length > 0 && key === pathKey(right)
}

/**
 * 把选中的目录表示成相对项目根目录的写法。
 *
 * 输出目录在配置里一直是「相对项目根」的（扫描出来的 dist / www 就是这样），
 * 手动选目录时也要落成同一种：写绝对路径的话，项目挪个位置、换台机器就失效了。
 * 选到项目目录之外（或项目根自己）时原样返回 —— 那种情况本来就没法用相对路径表达。
 *
 * 层级按原文切，保留用户自己那套大小写；连接符统一成正斜杠，与扫描出来的写法一致。
 */
export function relativeToProject(root: string, target: string): string {
  const base = pathKey(root)
  const full = pathKey(target)
  if (!base || !full || !full.startsWith(`${base}/`)) return target

  const depth = base.split('/').length
  const segments = target
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .slice(depth)

  // 切完是空的说明 target 就是 root 本身（或者多的只是斜杠），相对路径没有意义
  return segments.length ? segments.join('/') : target
}

/**
 * 项目根 + 配置里的输出目录 → 可以直接打开 / 显示的绝对路径。
 * 配置里已经是绝对路径（UNC 或盘符开头）时原样返回。
 */
export function resolveWithinProject(root: string, outputDir: string): string {
  const trimmed = outputDir.trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) return trimmed

  const base = root.trim().replace(/[\\/]+$/, '')
  if (!base) return trimmed
  return `${base}\\${trimmed.replace(/[\\/]+/g, '\\')}`
}
