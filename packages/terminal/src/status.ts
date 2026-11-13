/**
 * 终端 / 进程的运行状态。
 *
 * 原先 `RUNNING_STATUS` 住在渲染层的 terminal store、`describeHolder` 是它的私有函数；
 * projects store 为了判「在不在跑」跨 store 引常量，这层引用没有必要 ——
 * 状态属于终端域，收进包里两边各自导入。
 */

/** 处于「正在干活」的几个状态；重启、关闭终端、批量检测都要判它 */
export const RUNNING_STATUS: ReadonlyArray<string> = ['running', 'installing', 'building']

/** 端口被谁占着，拼成一句给人看的说明。线上契约里 pid / 进程名可能是 null（没问到） */
export function describeHolder(check: { pid?: number | null, processName?: string | null }): string {
  return check.processName ? `${check.processName}（PID ${check.pid ?? '未知'}）` : `PID ${check.pid ?? '未知'}`
}
