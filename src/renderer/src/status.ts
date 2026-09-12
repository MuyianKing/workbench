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

/**
 * 「命令」卡片的状态文案。
 *
 * 状态机与项目共用，但一条命令只有「在跑 / 没跑 / 退出了」这三种结果，
 * 用项目那套说法（空闲、打包成功）都不贴切，所以单独给一份文案；色带仍取 STATUS_META。
 */
export function commandStatusLabel(status: ProjectStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'failed') return '已退出'
  return '未运行'
}
