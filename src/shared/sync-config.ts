/**
 * 同步仓库里 `config/<设备id>.json` 的结构：**本机 theme.json 的整份副本 + 一层设备信封**。
 *
 * 为什么是「整份 theme.json」而不是拆成「外观 + 布局」两段：那份配置的用途就是让另一台机器
 * 变成这台机器的样子，整份采用最直接，也不会有「一半用你的、一半用我的」这种拼出来谁都没见过的外观。
 * 于是仓库里两台机器各一个文件、每个文件只有一个写者，冲突模型与用量分片完全一样。
 *
 * 结构里没有单调递增的计数器，所以合并语义无从谈起：**采用哪一台的配置只能由用户点**
 * （两台机器互相自动采用对方的配置会来回覆盖、永远收敛不了）。时间戳取自 theme.updatedAt ——
 * 那是这台机器上外观最后一次真的变化的时间，不是「推送到仓库」的时间。
 */
import { THEME_VERSION, sanitizeTheme, type ThemeConfig } from './theme'

/** 仓库里一台机器的那份配置 */
export interface ThemeFile {
  /** 机器本地生成的 id，也就是文件名；与用量分片同名同源 */
  device: string
  /** 设备名（默认主机名），只当界面上的标签用 */
  name: string
  /**
   * 那台机器的 theme.json 内容。
   * 版本对不上时为 null：那种文件整份收敛回默认布局，套到本机等于把用户的摆放清掉。
   */
  theme: ThemeConfig | null
}

/**
 * 打包一份要写进仓库的配置（渲染层现抓本机 theme.json，Rust 那边原样写盘）。
 * 与 sanitizeThemeFile 是一对：写的是它，读回来的也过它。
 */
export function captureThemeFile(device: string, name: string, theme: ThemeConfig): ThemeFile {
  return { device: device.trim(), name: name.trim(), theme }
}

/**
 * 仓库里读回来的配置 → 能安全采用的一份。
 * 认不出（不是对象、没有设备 id）返回 null；主题内容一律过一遍收敛，
 * 手改过的 JSON 不会把越界的值带进界面。
 */
export function sanitizeThemeFile(raw: unknown): ThemeFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const input = raw as { device?: unknown; name?: unknown; theme?: unknown }
  const device = typeof input.device === 'string' ? input.device.trim() : ''
  if (!device) return null

  const theme = input.theme as { version?: unknown } | undefined
  const usable = theme && typeof theme === 'object' && theme.version === THEME_VERSION

  return {
    device,
    name: typeof input.name === 'string' ? input.name.trim() : '',
    theme: usable ? sanitizeTheme(theme) : null
  }
}

/**
 * 设置界面「从别的机器取外观」里的一项。
 *
 * 它是用量分片与配置文件**按设备 id 配对**后的结果：只有推了用量、或只有配置的机器都列出来，
 * 缺的那一半算 null（关掉外观同步的机器就只有用量）。
 */
export interface SyncDeviceInfo {
  id: string
  name: string
  /** 那台机器最后一次写东西的时间：两份文件取较新的那个 */
  updatedAt: number
  /** 可采用的配置（整份 theme.json）；对方没推配置、或那份配置的版本对不上时为 null */
  theme: ThemeConfig | null
}
