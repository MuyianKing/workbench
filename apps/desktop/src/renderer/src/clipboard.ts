/**
 * 复制到剪贴板。
 *
 * 原先八处各写一遍 try/catch 与成功失败文案，措辞与回退策略还各不一样
 * （有的 ElMessage、有的 notify、失败提示三种说法）；收到这里统一成一套。
 * 「写剪贴板」与「说不说、说什么」分两档：要提示的走 `copyText`，
 * 静默的（失败由调用方自己兜的，比如把失败画进自己的界面里）走 `tryCopy`。
 *
 * 截图遮罩那几处不在这里：capture.html 是独立窗口，提示画在遮罩上，
 * 不经 ElMessage（见 capture/CaptureApp.vue 的 failTransient / copyNote）。
 */
import { notifyError, notifySuccess } from './notify'

/** 写入剪贴板，不说话。返回成没成，提示归调用方。空串直接算失败。 */
export async function tryCopy(text: string): Promise<boolean> {
  if (!text)
    return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    return false
  }
}

/** 复制并提示：成功 `{label}已复制`，失败「复制失败，可以手动选中再复制」。 */
export async function copyText(text: string, label: string): Promise<boolean> {
  const done = await tryCopy(text)
  if (done)
    notifySuccess(`${label}已复制`)
  else
    notifyError('复制失败，可以手动选中再复制')
  return done
}
