/**
 * 快捷启动（常用软件）的纯逻辑。
 *
 * 放在 shared 是因为两端都要用：渲染层用默认名给出即时反馈，主进程用它清洗落盘数据。
 * 真正的动作（对话框、系统图标、把程序拉起来）在 main/quick-launch.ts，这里不碰 Node 内置模块。
 */

import type { QuickApp } from './types'

/**
 * 从程序路径推一个默认显示名：`C:\…\Code.exe` → `Code`，
 * `Visual Studio Code.lnk` → `Visual Studio Code`。用户随时可以改。
 */
export function defaultQuickAppName(target: string): string {
  const trimmed = target.trim().replace(/[\\/]+$/, '')
  const file = trimmed.split(/[\\/]/).pop() ?? ''
  const dot = file.lastIndexOf('.')
  // dot === 0 是 `.gitignore` 这类隐藏文件，去掉扩展名就什么都不剩了，保留原名
  const name = dot > 0 ? file.slice(0, dot) : file
  return name.trim() || file
}

/**
 * 把磁盘上读到的快捷启动列表收敛到合法形状。
 *
 * 数据文件可能被老版本写过或被手工改过：丢掉没有路径的条目，补回缺失的
 * id 与 order，最后按 order 排一遍并重新编号（拖动排序依赖它是紧凑的）。
 * makeId 由调用方注入（主进程用 randomUUID），这里保持纯函数。
 */
export function sanitizeQuickApps(raw: unknown, makeId: () => string): QuickApp[] {
  if (!Array.isArray(raw)) return []

  const list: Array<{ app: QuickApp; order: number }> = []

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const value = item as Partial<QuickApp>

    const target = typeof value.target === 'string' ? value.target.trim() : ''
    if (!target) return

    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const order = typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : index

    list.push({
      order,
      app: {
        id: typeof value.id === 'string' && value.id ? value.id : makeId(),
        name: name || defaultQuickAppName(target),
        target,
        order: 0,
        createdAt:
          typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
            ? value.createdAt
            : Date.now(),
        lastUsedAt:
          typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt)
            ? value.lastUsedAt
            : undefined
      }
    })
  })

  list.sort((a, b) => a.order - b.order)
  return list.map((item, index) => ({ ...item.app, order: index }))
}
