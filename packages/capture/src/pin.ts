/**
 * 钉图的尺寸与透明度算术。
 *
 * 钉图窗口不是「图片控件」而是**一块和图片一样大的窗口**（见 Rust 侧 pin.rs）：
 * 缩放要同时改窗口尺寸与位置，所以这里的函数都返回「新的位置 + 新的尺寸」。
 * 位置以**虚拟桌面物理坐标**为准，与遮罩窗口同一套（见 coords.ts）。
 */
import type { Point, Size } from './rect'

/** 钉图最小边长（物理像素）：再小就没法用鼠标把它抓住了 */
export const PIN_MIN_EDGE = 32
/** 钉图最大边长：一张 8K 的图不该把窗口撑到系统不认的尺寸 */
export const PIN_MAX_EDGE = 16000
/** 透明度下限（百分比）：再低就看不清内容，直接变成一块看不见的挡板 */
export const PIN_OPACITY_MIN = 20
export const PIN_OPACITY_MAX = 100

/** 透明度收敛：认不出的（NaN / 字符串过来）回满，越界的夹回区间 */
export function clampPinOpacity(percent: number): number {
  if (!Number.isFinite(percent))
    return PIN_OPACITY_MAX
  return Math.min(Math.max(Math.round(percent), PIN_OPACITY_MIN), PIN_OPACITY_MAX)
}

/**
 * 边长夹回可用区间，并保持长宽比。
 *
 * **两边都必须是整数**：窗口的位置与尺寸都是物理像素，而 Rust 那边 `pin_update` 收的是
 * u32/i32 —— 滚轮缩放 `* 1.1` 出来的长边带着小数（`1193 * 1.1 = 1312.3000…`），
 * 原样送过去会被 serde 直接拒掉（`invalid type: floating point …, expected u32`，踩过一次）。
 */
export function clampPinSize(size: Size, ratio: number): Size {
  const safeRatio = ratio > 0 ? ratio : 1
  const target = Math.round(Math.min(Math.max(Math.max(size.width, size.height), PIN_MIN_EDGE), PIN_MAX_EDGE))
  // 以长边为准反推另一边：钉图的窗口永远与图片同比例，不留黑边
  return size.width >= size.height
    ? { width: target, height: Math.round(target / safeRatio) }
    : { width: Math.round(target * safeRatio), height: target }
}

/**
 * 初始尺寸：按图片原始像素，但不超过这块屏的 `maxFraction`（默认七成）。
 * 一张 4K 截图直接钉出来会盖满整块屏，用户还得再滚轮缩一次。
 */
export function initialPinSize(image: Size, viewport: Size, maxFraction = 0.7): Size {
  const ratio = image.height > 0 ? image.width / image.height : 1
  const limit = {
    width: Math.max(PIN_MIN_EDGE, Math.round(viewport.width * maxFraction)),
    height: Math.max(PIN_MIN_EDGE, Math.round(viewport.height * maxFraction)),
  }
  if (image.width <= limit.width && image.height <= limit.height)
    return clampPinSize(image, ratio)

  // 先按宽度收到限制内，超高了再按高度收回去（与 CSS 的 contain 同一个算法）
  const byWidth = { width: limit.width, height: Math.round(limit.width / ratio) }
  return clampPinSize(byWidth.height <= limit.height ? byWidth : { width: Math.round(limit.height * ratio), height: limit.height }, ratio)
}

/**
 * 以 `anchor`（虚拟桌面物理坐标，一般取光标）为不动点缩放：
 * 光标底下的那块内容缩放前后停在原位，与滚轮缩放图片的手感一致。
 */
export function zoomAround(anchor: Point, position: Point, size: Size, next: Size): Point {
  if (size.width <= 0 || size.height <= 0)
    return position
  const factor = next.width / size.width
  return {
    x: Math.round(anchor.x - (anchor.x - position.x) * factor),
    y: Math.round(anchor.y - (anchor.y - position.y) * factor),
  }
}
