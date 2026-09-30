import type { ProjectStatus, TerminalKind } from '@/types'

/**
 * 项目状态 → 文案与色带的唯一映射。
 *
 * 这份表原先在 ProjectCard / RecentPanel / ProjectDrawer / TerminalPanel 各抄了一遍，
 * 新增一个状态要改四处，漏一处就会出现「卡片说打包中、抽屉说空闲」这类不一致。
 * tone 对应全局样式里的 `--st-<tone>` 变量。
 *
 * `success` 的文案在这里是最中性的那份（命令跑完了），「打包成功」要由 statusLabel 按
 * 命令类型补上 —— 直接取这张表的 label 只会得到「已结束」，不会把启动说成打包。
 */
export const STATUS_META: Record<ProjectStatus, { label: string; tone: string }> = {
  idle: { label: '空闲', tone: 'idle' },
  installing: { label: '安装中', tone: 'run' },
  running: { label: '运行中', tone: 'run' },
  building: { label: '打包中', tone: 'run' },
  success: { label: '已结束', tone: 'ok' },
  failed: { label: '执行失败', tone: 'fail' }
}

/**
 * 状态文案。
 *
 * 只有**打包**正常退出才叫「打包成功」。启动 / 安装 / 自定义命令退出码同样是 0 时，
 * 只说明那条命令自己跑完了 —— 启动的往往还是个包装命令（`npm run dev` 之下还有
 * `tauri dev`、`beforeDevCommand`），dev server 有没有起来它答不了，说成「打包成功」
 * 既不对又误导。`kind` 缺省时按中性文案走（老运行态、外部探测出来的运行态都没有它）。
 */
export function statusLabel(status: ProjectStatus, kind?: TerminalKind): string {
  if (status === 'success' && kind === 'build') return '打包成功'
  return STATUS_META[status].label
}

export function statusTone(status: ProjectStatus): string {
  return STATUS_META[status].tone
}

/** 文案 + 色带。色带只看状态（绿=正常退出），文案还要看是哪类命令 */
export function statusMeta(status: ProjectStatus, kind?: TerminalKind): { label: string; tone: string } {
  return { label: statusLabel(status, kind), tone: STATUS_META[status].tone }
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
