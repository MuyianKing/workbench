import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage } from 'electron'
import {
  BUILTIN_WALLPAPER_PREFIX,
  builtinIdOf,
  builtinReference,
  isWallpaperFile,
  wallpaperIdOf
} from '../shared/wallpaper'
import type { BuiltinWallpaper, Result } from '../shared/types'

/**
 * 内置壁纸：随应用一起发布、在设置里直接点选的那几张。
 *
 * 开发态读仓库里的 resources/backgrounds，打包后读 extraResources 放进 resourcesPath 的那一份
 * （见 electron-builder.yml）。目录不存在（比如老版本升级上来）就当作没有内置壁纸，
 * 设置里那一栏会自动收起，不影响用户自己挑图。
 */
function builtinDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'backgrounds')
    : join(app.getAppPath(), 'resources', 'backgrounds')
}

interface WallpaperFile {
  id: string
  name: string
  file: string
}

/** 扫描目录：只认解得开的位图（svg 是出图母版，不在这儿），按文件名排序保证顺序稳定 */
async function scanWallpaperFiles(): Promise<WallpaperFile[]> {
  const dir = builtinDir()

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  return entries
    .filter((name) => isWallpaperFile(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: wallpaperIdOf(name), name, file: join(dir, name) }))
}

/** 缩略图宽度：设置里那一排小图，够看清是哪张就行 */
const THUMBNAIL_WIDTH = 360

function thumbnailOf(file: string): string {
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) return ''

  const { width } = image.getSize()
  const scaled =
    width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }) : image

  return `data:image/jpeg;base64,${scaled.toJPEG(72).toString('base64')}`
}

export async function listWallpapers(): Promise<BuiltinWallpaper[]> {
  const files = await scanWallpaperFiles()

  return files.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reference: builtinReference(entry.id),
    thumbnail: thumbnailOf(entry.file)
  }))
}

/**
 * 把设置里那个字符串换成真正能读的文件路径。
 *
 * 内置引用一律去已扫描出来的列表里查，不拿 id 拼路径 —— 这样即使数据文件被手工改成
 * `builtin:../../…`，也只是查不到而已。
 */
export async function resolveBackgroundTarget(value: string): Promise<Result<string>> {
  if (!value.startsWith(BUILTIN_WALLPAPER_PREFIX)) return { ok: true, data: value }

  const id = builtinIdOf(value)
  if (id === null) return { ok: false, error: '内置壁纸的引用不合法' }

  const matched = (await scanWallpaperFiles()).find((entry) => entry.id === id)
  if (!matched) return { ok: false, error: '这张内置壁纸已经不在安装目录里了' }

  return { ok: true, data: matched.file }
}
