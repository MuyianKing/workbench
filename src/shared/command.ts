/**
 * 「命令」卡片的纯逻辑。
 *
 * 放在 shared 是因为两边都要用：渲染层拿它做表单校验与默认名，适配层拿它清洗落盘数据。
 * 真正的执行在 workbench/session.ts 与 src-tauri/src/session.rs，这里不碰任何 Node 内置模块。
 */

import { parsePort } from './port'
import type { CommandEntry } from './types'

/**
 * 命令原文的长度上限（与项目自定义命令同一口径）。
 * 换行等于偷偷执行多条命令，一律拒绝；超长的多半是贴错了整段脚本。
 */
export const COMMAND_TEXT_MAX = 500

/**
 * 命令原文是否可用。
 * 返回 null 表示通过，否则是一句可以直接展示给用户的原因。
 */
export function commandTextError(command: unknown): string | null {
  const text = typeof command === 'string' ? command.trim() : ''
  if (!text) return '命令不能为空'
  if (text.length > COMMAND_TEXT_MAX) return `命令过长（上限 ${COMMAND_TEXT_MAX} 字符）`
  if (/[\r\n]/.test(text)) return '命令不能包含换行'
  return null
}

/** 从命令原文推一个默认显示名：`npx @deepseek-ai/dsh web` → `npx` */
export function defaultCommandName(command: string): string {
  return command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '') ?? ''
}

/**
 * 把磁盘上读到的命令列表收敛到合法形状。
 *
 * 数据文件可能被老版本写过或被手工改过：丢掉命令为空 / 含换行 / 超长的条目，
 * 补回缺失的 id、名称与 order，最后按 order 排一遍并重新编号（列表顺序依赖它是紧凑的）。
 * makeId 由调用方注入（主进程用 randomUUID），这里保持纯函数。
 */
export function sanitizeCommands(raw: unknown, makeId: () => string): CommandEntry[] {
  if (!Array.isArray(raw)) return []

  const list: Array<{ entry: CommandEntry; order: number }> = []

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const value = item as Partial<CommandEntry>

    const command = typeof value.command === 'string' ? value.command.trim() : ''
    if (commandTextError(command)) return

    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const order =
      typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : index

    list.push({
      order,
      entry: {
        id: typeof value.id === 'string' && value.id ? value.id : makeId(),
        name: name || defaultCommandName(command),
        command,
        // 非法端口归到 undefined，与项目端口同一套规则
        port: parsePort(value.port),
        order: 0,
        createdAt:
          typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
            ? value.createdAt
            : Date.now()
      }
    })
  })

  list.sort((a, b) => a.order - b.order)
  return list.map((item, index) => ({ ...item.entry, order: index }))
}
