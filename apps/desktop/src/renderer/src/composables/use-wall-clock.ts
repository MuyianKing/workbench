/**
 * 驱动「运行了多久」的时钟与「今天 00:00」。
 *
 * 一份就够（模块级单例）：运行时长（项目卡）、问候语的时段（HomeGreeting）、
 * 「今天」的日期键（活跃度图 / 今日完成）都跟着它走。原先它住在 projects store 里，
 * 为了一个「现在几点」让工作域的组件去 import 项目 store，不合算。
 *
 * 两条口径：
 *  - `clock` 每秒变一次 —— 显示耗时的地方拿它当秒针；
 *  - `dayStart` 只在跨天时变一次 —— 活跃度图的横轴末端是今天，
 *    每秒重铺 371 个格子没必要，跨过零点重算一次就够。
 *    依赖它的 computed 天然每秒都醒（clock 变了），但重算很便宜；
 *    铺大网格的那几个要绕开 clock、只依赖 dayStart（见 ActivityGraph）。
 */
import { ref } from 'vue'

/** 今天 00:00 的时间戳（本地时区） */
function startOfToday(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const clock = ref(Date.now())
const dayStart = ref(startOfToday())

window.setInterval(() => {
  const now = Date.now()
  clock.value = now
  const today = startOfToday()
  if (today !== dayStart.value) dayStart.value = today
}, 1000)

export function useWallClock(): { clock: typeof clock; dayStart: typeof dayStart } {
  return { clock, dayStart }
}
