/**
 * 监听端口的解析与校验。
 *
 * 界面输入与主进程落库共用同一套规则：端口要么是一个 1–65535 的整数，
 * 要么就是「没有」——空串、null、越界、小数都归到 undefined，
 * 不抛错也不保留非法值，免得一个手滑把脏数据写进项目配置。
 */

export const PORT_MIN = 1
export const PORT_MAX = 65535

export function parsePort(input: unknown): number | undefined {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= PORT_MIN && input <= PORT_MAX ? input : undefined
  }

  if (typeof input !== 'string') return undefined

  const text = input.trim()
  if (!text) return undefined

  const value = Number(text)
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX ? value : undefined
}
