/**
 * 画中画悬浮小窗的位置与尺寸档位。
 *
 * 它们落在 theme.json（`videoFloatX` / `Y` / `W` / `H`），所以归外观这一边管：
 * 读它的一方（`sanitizeTheme`）与拖动它的一方（视频页的 `VideoPlayer`）必须用同一套边界 ——
 * 手改过的数据文件不能把小窗放到够不着的地方去。
 *
 * **位置存视口百分比而不是像素**：换台机器、把窗口拉大拉小，小窗都还停在差不多的地方。
 * 窗口内的最终落点渲染时按当前视口再 clamp 一次（那里才知道小窗自己的宽高），
 * 这里的边界只是数据文件的第一道防线。
 */

/** 小窗默认尺寸（px）：16:9 出来的 320×180，不压内容也不挡太多笔记 */
export const VIDEO_FLOAT_SIZE_DEFAULT = { width: 320, height: 180 }

/** 小窗最小 / 最大尺寸（px）：再小看不清字幕，再大就是回去看视频页了 */
export const VIDEO_FLOAT_SIZE_MIN = { width: 240, height: 135 }
export const VIDEO_FLOAT_SIZE_MAX = { width: 1280, height: 720 }

/** 位置（视口百分比）的默认落点：右上角 —— 那儿离笔记正文最远，也最少挡东西 */
export const VIDEO_FLOAT_X_DEFAULT = 100
export const VIDEO_FLOAT_Y_DEFAULT = 0

/**
 * 收敛位置（视口百分比）：0–100，超界一律拉回；缺失 / 认不出的取值回到 `fallback`
 * —— X 的默认是右上角、Y 的默认是顶边（与 DEFAULT_THEME 同一口径）。
 */
export function clampVideoFloatPercent(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return clampVideoFloatPercent(fallback)
  return Math.min(100, Math.max(0, value))
}

function clampVideoFloatSide(value: unknown, min: number, max: number, fallback: number): number {
  const size = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(size)))
}

/** 收敛小窗宽度（px）；缺失 / 认不出的取值回到默认尺寸 */
export function clampVideoFloatWidth(value: unknown): number {
  return clampVideoFloatSide(value, VIDEO_FLOAT_SIZE_MIN.width, VIDEO_FLOAT_SIZE_MAX.width, VIDEO_FLOAT_SIZE_DEFAULT.width)
}

/** 收敛小窗高度（px）；缺失 / 认不出的取值回到默认尺寸 */
export function clampVideoFloatHeight(value: unknown): number {
  return clampVideoFloatSide(value, VIDEO_FLOAT_SIZE_MIN.height, VIDEO_FLOAT_SIZE_MAX.height, VIDEO_FLOAT_SIZE_DEFAULT.height)
}
