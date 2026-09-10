import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow, dialog, nativeImage } from 'electron'
import type { BackgroundImage, Result } from '../shared/types'
import { resolveBackgroundTarget } from './wallpapers'

/**
 * 工作区背景图。
 *
 * 渲染层不碰文件系统，也不需要 file:// 权限：路径只存在设置里，用的时候由这里读出来、
 * 压到合适尺寸、重新编码成 JPEG 的 data URL 再交给界面。这样 dev server 与打包后的
 * 自定义协议下行为完全一致，图片也不会被塞进数据文件。
 */

/** 可选的后缀，交给系统对话框过滤；真正能不能解码由 nativeImage 说了算 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']

/** 原图上限：背景图不需要原尺寸，几十兆的文件只会让界面白等 */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024

/** 回传前的最长边。再大对一张背景没有意义，反而让 data URL 撑到几兆 */
const MAX_EDGE = 1920

/** JPEG 质量：图片上面还要盖一层蒙版，纹理留个大概就够 */
const JPEG_QUALITY = 82

export async function pickBackgroundImage(parent?: BrowserWindow): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择工作区背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }]
  }

  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/**
 * 读一张图交给渲染层。
 *
 * target 可以是磁盘路径，也可以是内置壁纸的 `builtin:<id>` 引用 —— 后者先去已发布的那份
 * 清单里查出真实文件，找不到就当读不出来，绝不会拿 id 去拼路径。
 */
export async function readBackgroundImage(target: unknown): Promise<Result<BackgroundImage>> {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (!raw) return { ok: false, error: '还没有选择背景图' }

  const resolved = await resolveBackgroundTarget(raw)
  if (!resolved.ok || !resolved.data) {
    return { ok: false, error: resolved.error ?? '背景图不存在' }
  }
  const file = resolved.data

  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return { ok: false, error: '背景图不是一个文件' }
    if (stat.size > MAX_SOURCE_BYTES) {
      const limit = Math.round(MAX_SOURCE_BYTES / 1024 / 1024)
      return { ok: false, error: `图片超过 ${limit}MB，请换一张小一点的` }
    }
  } catch {
    return { ok: false, error: '背景图不存在或无法读取，请重新选择' }
  }

  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) {
    return { ok: false, error: '这张图片解码失败，请换 png / jpg / webp 格式' }
  }

  const { width } = image.getSize()
  const scaled = width > MAX_EDGE ? image.resize({ width: MAX_EDGE, quality: 'good' }) : image

  return {
    ok: true,
    data: {
      // 回传原始值（路径或内置引用），设置里存的就是它，渲染层据此判断「是不是同一张」
      path: raw,
      name: basename(file),
      dataUrl: `data:image/jpeg;base64,${scaled.toJPEG(JPEG_QUALITY).toString('base64')}`
    }
  }
}
