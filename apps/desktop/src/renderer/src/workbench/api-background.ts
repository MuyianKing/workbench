import type { BackgroundImage, BuiltinWallpaper, Result, WorkbenchApi } from '@/types'
import { fail, ok } from '@workbench/core'
import { openDialog } from './api-system'
import { assetUrl, errorText, invoke } from './bridge'

/**
 * 工作区背景图与图片授权这两条通道。
 *
 * 图片本身交给 webview 按文件加载（asset 协议），这一侧只做「解析内置引用 +
 * 让后端把读取权限授给 asset 协议」，不解码、不缩放、不编码（原理见
 * docs/features-and-architecture.md 的 asset 协议那一段）。
 */

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']

/** 设置里内置壁纸的引用前缀，与 shared 侧的约定一致 */
const BUILTIN_PREFIX = 'builtin:'

/** 内置壁纸的缩略图：面板里就那么点大 */
const THUMBNAIL_MAX_EDGE = 320
const THUMBNAIL_QUALITY = 75

/** 内置壁纸的 id 就是文件名主干；写进设置的引用串为 builtin:<id> */
function wallpaperFrom(filePath: string): BuiltinWallpaper {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const id = name.replace(/\.[^.]+$/, '')
  return { id, name, reference: `${BUILTIN_PREFIX}${id}`, thumbnail: '' }
}

/** 内置壁纸引用 → 真实文件路径；清单由 Rust 提供（打包后走 resource_dir，开发态读仓库） */
async function resolveBuiltin(id: string): Promise<string | null> {
  const files = await invoke<string[]>('list_wallpapers')
  return files.find(file => wallpaperFrom(file).id === id) ?? null
}

export const backgroundApi = {
  // ---------- 背景图 ----------
  pickBackground: () =>
    openDialog({
      directory: false,
      multiple: false,
      title: '选择工作区背景图',
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
    }),

  /**
   * 取工作区背景图。
   *
   * 只做两件事：把 `builtin:<id>` 解析成真实路径，再让后端把这张图的读取权限授给 asset 协议。
   * 图片本身交给 webview 按文件加载，我们这边不解码、不缩放、不编码，也不生成 base64 字符串。
   *
   * 之前是后端解码 → 缩到 2560 → 编成 JPEG → base64 回传：实测一张 3824×2400 的壁纸要 249ms、
   * 产物 270KB，而且**每次启动都重算一遍**，那 249ms 正好落在首屏之后，表现成「背景图晚一步才出来」。
   * 现在这条路只剩一次「读文件头校验 + 授权」，1ms 量级。
   *
   * 失败原因依旧照实带回去：坏图 / 不存在的图在设置面板里会被提示，而不是静默地什么都不显示。
   */
  loadBackground: async (path: string): Promise<Result<BackgroundImage>> => {
    try {
      const target = path.startsWith(BUILTIN_PREFIX)
        ? await resolveBuiltin(path.slice(BUILTIN_PREFIX.length))
        : path
      if (!target)
        return fail(`内置壁纸已不存在：${path}`)

      await invoke('allow_background', { path: target })
      return ok({ path, name: target.split(/[\\/]/).pop() ?? target, url: assetUrl(target) })
    }
    catch (error) {
      return fail(errorText(error, '读取背景图失败'))
    }
  },

  /** 内置壁纸清单（含缩略图）：缩略图压到 320 就够面板里看了 */
  listWallpapers: async (): Promise<BuiltinWallpaper[]> => {
    const files = await invoke<string[]>('list_wallpapers')
    const items = await Promise.all(
      files.map(async (file) => {
        const item = wallpaperFrom(file)
        try {
          return {
            ...item,
            thumbnail: await invoke<string>('image_data_url', {
              path: file,
              maxEdge: THUMBNAIL_MAX_EDGE,
              quality: THUMBNAIL_QUALITY,
            }),
          }
        }
        catch {
          return item
        }
      }),
    )
    return items
  },

  /**
   * 把一张图片按**单个文件**授权给 asset 协议，回传 webview 能直接加载的 URL。
   * 与工作区背景图同一条命令（`allow_background`：读文件头验图 + 授权）——
   * AI 预览栏显示回答里提到的图片走的就是这条边界，不另开命令。
   */
  allowPreviewImage: async (path: string): Promise<Result<{ url: string }>> => {
    try {
      await invoke('allow_background', { path })
      return ok({ url: assetUrl(path) })
    }
    catch (error) {
      return fail(errorText(error, '这张图交不到预览里'))
    }
  },
} as Partial<WorkbenchApi>
