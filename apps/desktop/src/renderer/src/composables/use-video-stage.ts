import type { ShallowRef } from 'vue'
/**
 * 视频播放器的「传送宿主」。
 *
 * 播放器本体是全局单例（VideoPlayer，挂在 App.vue 上，与终端面板同层）：在视频页时
 * 它要内嵌进视频页的画布里，切到别的页就缩成悬浮小窗。**内嵌**用 Teleport 实现 ——
 * 视频页把画布里的宿主元素注册到这里的模块级 ref，VideoPlayer 读它当传送目标；
 * 传送开 / 关只是把同一个 `<video>` 元素在两处之间搬，元素不重建，播放因此不断。
 *
 * 为什么是模块级 ref 而不是 store 或 provide：宿主只是一个 DOM 元素的引用，
 * 没有业务语义、不落盘、只有一个写入方（视频页）与一个读取方（播放器），
 * 一次注册长期有效 —— 视频页被 KeepAlive 包着，切走的页面元素只是脱离文档、不销毁。
 */
import { shallowRef } from 'vue'

/**
 * 视频页画布里供传送落位的那个元素；视频页没挂载过（没进过那一页）时是 null。
 * 用 **shallowRef**：装的是 DOM 元素的引用，深响应（ref 会把对象包成 reactive 代理）
 * 对它毫无意义，还会在测试里把「原样传递」变成「代理换手」—— 拿出去的必须还是那一个元素。
 */
const stageHost = shallowRef<HTMLElement | null>(null)

/** 视频页挂载后调用；重复调用以后来的为准（KeepAlive 下不会发生，兜个底） */
export function setVideoStageHost(el: HTMLElement | null): void {
  stageHost.value = el
}

/** VideoPlayer 读传送目标用 */
export function useVideoStageHost(): ShallowRef<HTMLElement | null> {
  return stageHost
}
