/**
 * 内置壁纸的引用规则。
 *
 * 设置里的 workspaceBackground 要同时容下两种东西：用户在磁盘上自己挑的绝对路径，
 * 和随应用一起发布的内置壁纸。后者用 `builtin:<id>` 引用，id 就是文件名主干 ——
 * 打包后壁纸的绝对路径会落在 resourcesPath 下，把路径写进设置文件的话，
 * 换个安装位置、换台机器就全失效了。
 */

export const BUILTIN_WALLPAPER_PREFIX = 'builtin:'

/** 能当壁纸的后缀：只收能解码的位图（svg 是母版，不是壁纸） */
export const WALLPAPER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] as const

/** 图片文件名 → 壁纸 id（去掉最后一段后缀） */
export function wallpaperIdOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

/** 内置壁纸的引用串 */
export function builtinReference(id: string): string {
  return `${BUILTIN_WALLPAPER_PREFIX}${id}`
}

/**
 * id 只允许「文件名主干」，挡掉能改变路径的东西：分隔符、`..`、盘符那些保留字符、
 * 控制字符与开头的点。**中文要放行** —— 内置壁纸就是「万重山.jpg」这种名字，
 * 用 ASCII 白名单会把它们全判死。
 *
 * 另外主进程只拿 id 去已扫描出来的列表里查，不拼路径，这里是第二道闸。
 */
export function isSafeWallpaperId(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  if (value.includes('..')) return false
  return !/[/\\:*?"<>|\u0000-\u001f]/.test(value)
}

/** 取出内置壁纸 id；不是内置引用、或 id 不合法时返回 null */
export function builtinIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (!text.startsWith(BUILTIN_WALLPAPER_PREFIX)) return null

  const id = text.slice(BUILTIN_WALLPAPER_PREFIX.length)
  return isSafeWallpaperId(id) ? id : null
}

/** 这个文件名能不能当壁纸（按后缀判断，真正的解码能力由后端 imaging.rs 的 image crate 说了算） */
export function isWallpaperFile(fileName: unknown): boolean {
  if (typeof fileName !== 'string') return false

  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return false

  const ext = fileName.slice(dot + 1).toLowerCase()
  return (WALLPAPER_EXTENSIONS as readonly string[]).includes(ext)
}
