import type { ProjectStatus } from '@/types'

/**
 * 项目状态 → 文案与色带的唯一映射。
 *
 * 这份表原先在 ProjectCard / RecentPanel / ProjectDrawer / TerminalPanel 各抄了一遍，
 * 新增一个状态要改四处，漏一处就会出现「卡片说打包中、抽屉说空闲」这类不一致。
 * tone 对应全局样式里的 `--st-<tone>` 变量。
 */
export const STATUS_META: Record<ProjectStatus, { label: string; tone: string }> = {
  idle: { label: '空闲', tone: 'idle' },
  installing: { label: '安装中', tone: 'run' },
  running: { label: '运行中', tone: 'run' },
  building: { label: '打包中', tone: 'run' },
  success: { label: '打包成功', tone: 'ok' },
  failed: { label: '执行失败', tone: 'fail' }
}

export function statusLabel(status: ProjectStatus): string {
  return STATUS_META[status].label
}

export function statusTone(status: ProjectStatus): string {
  return STATUS_META[status].tone
}

/** 忙碌（安装 / 打包）时卡片与抽屉都不允许再次触发命令 */
export function isBusyStatus(status: ProjectStatus): boolean {
  return status === 'installing' || status === 'building'
}
