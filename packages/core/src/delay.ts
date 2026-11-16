/**
 * 等 ms 毫秒。定时器不归业务管 —— 调用方只关心「过了这些毫秒再继续」。
 *
 * 轮询、节流与退避都用它，别在各处再各写一遍 `new Promise(resolve => setTimeout(...))`。
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
