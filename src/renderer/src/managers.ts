import type { InstallablePackageManager } from '@/types'

/**
 * 界面上要展示的三个包管理器，以及本机环境信息的兜底值。
 *
 * AppHeader、WelcomePanel、SystemPanel 原先各写一份清单，顺序与字段还不一致，
 * 想加 bun 就得改三处。统一到这里，顺序也统一成 npm → pnpm → yarn。
 */
export type PackageManagerKey = InstallablePackageManager | 'npm'

export interface PackageManagerEntry {
  key: PackageManagerKey
  label: string
  /** installable 为 true 的可以点一下用 npm 全局装；npm 自己随 Node.js 分发，装不了 */
  installable: boolean
}

export const PACKAGE_MANAGERS: readonly PackageManagerEntry[] = [
  { key: 'npm', label: 'npm', installable: false },
  { key: 'pnpm', label: 'pnpm', installable: true },
  { key: 'yarn', label: 'yarn', installable: true }
]

/** preload 拿不到版本信息时的占位，避免界面上出现 undefined */
export const VERSIONS_FALLBACK = { electron: '—', node: '—', chrome: '—' } as const
