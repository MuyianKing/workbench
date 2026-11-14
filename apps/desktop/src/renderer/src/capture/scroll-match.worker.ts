/**
 * 滚动截图的匹配 worker（无状态）：主线程把前后两帧的原始字节发过来，这里跑
 * `@workbench/capture` 的 `analyzeScrollOffset`（纯缓冲运算），把位移与粘住行数发回去。
 *
 * **为什么要单独的线程**：匹配是几十万到上千万次像素比较，在主线程上跑每步要冻结
 * 遮罩几十到几百毫秒（首步与回退全量扫最重）。挪进 worker 后主线程只剩字节搬运与
 * 贴画布 —— 稳态的预测窗口匹配只有几毫秒，回退全量扫也不挡 UI（eSearch 把匹配放
 * 在不挡界面的上下文里是同一个道理）。worker 建不起来（CSP / 环境）或中途出错时，
 * 主线程退回同步直调，行为一致只是那一步会卡 —— 见 CaptureApp 的 `matchScroll`。
 */

import type { ScrollMatchResult, StitchFrame } from '@workbench/capture'
import { analyzeScrollOffset } from '@workbench/capture'

/**
 * 主线程 → worker 的请求：前后两帧的原始 RGBA 字节（拷贝，不 transfer —— 主线程
 * 还要用 next 的字节贴画布、留 prev 比下一帧）
 */
export interface ScrollMatchRequest {
  prev: ArrayBuffer
  next: ArrayBuffer
  width: number
  height: number
  /** 预测位移（上一步实测 × 本步实发齿数），首步不给 */
  hintDelta?: number
}

/** worker → 主线程的应答：`analyzeScrollOffset` 的原样产出 */
export type ScrollMatchReply = ScrollMatchResult

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScrollMatchRequest>) => void) | null
  postMessage: (message: ScrollMatchReply) => void
}

scope.onmessage = (event) => {
  const { prev, next, width, height, hintDelta } = event.data
  const frame = (bytes: ArrayBuffer): StitchFrame => ({ width, height, data: new Uint8ClampedArray(bytes) })
  scope.postMessage(analyzeScrollOffset(frame(prev), frame(next), { hintDelta }))
}
