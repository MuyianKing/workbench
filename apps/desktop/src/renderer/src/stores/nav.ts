import type { ViewId } from '@workbench/appearance'
import { fallbackView, sanitizeViewId } from '@workbench/appearance'
import { defineStore } from 'pinia'
/**
 * 导航：当前页、切页，以及首页布局编辑态。
 *
 * 这一坨原先住在 projects store 里，但它们是**壳层状态**，与「项目」无关 ——
 * App.vue / NavRail / 顶栏 / 画中画都为切页去 import 项目 store，说不过去，单独成片。
 *
 * 不引入 Vue Router：换页就是换这个 id，App.vue 用 <KeepAlive><component :is> 渲染，
 * 各页的滚动位置由 KeepAlive 保住。值会落盘，重启后回到上次那一页。
 */
import { ref, watch } from 'vue'
import { useSettingsStore } from './settings'

export const useNavStore = defineStore('nav', () => {
  const settingsStore = useSettingsStore()

  /**
   * 当前页（左侧导航栏的当前项）。
   *
   * 设置是异步载入的、数据目录还可能被整份换掉，所以这里要核一遍 ——
   * 与项目页的 sortBy 是同一条路。
   */
  const activeView = ref<ViewId>(sanitizeViewId(settingsStore.settings.activeView))

  // 设置是异步载入的，跟着它核一遍
  watch(
    () => settingsStore.settings.activeView,
    (value) => {
      activeView.value = sanitizeViewId(value)
    },
    { immediate: true },
  )

  /**
   * 当前页被设置里关掉之后退到第一页可见的。
   *
   * 盯的是「关掉了哪几页」这个字符串而不是那个数组本身：设置在别处每改一项都会换掉整个
   * settings 对象（数组也是新的），按引用比会每次都被唤起来。只在**关掉的那几页真的变了**、
   * 且当前页正好在其中时才换页，用户主动的切页（导航栏、布局编辑切回首页）照旧过得去。
   */
  watch(
    () => settingsStore.settings.hiddenViews.join(','),
    () => {
      const hidden = settingsStore.settings.hiddenViews
      if (!hidden.includes(activeView.value))
        return

      const next = fallbackView(hidden, settingsStore.settings.viewOrder)
      applyView(next)
      void settingsStore.updateSettings({ activeView: next })
    },
    { immediate: true },
  )

  /** 是否处于首页布局编辑态：由首页顶栏那颗「编辑布局」进入，画布上的「完成」退出 */
  const layoutEditing = ref(false)

  function setLayoutEditing(value: boolean): void {
    layoutEditing.value = value
    // 布局只有首页有得编辑（入口在首页顶栏，但键盘 / 以后别的入口不一定，这里统一兜住），
    // 进编辑态先切回首页，免得顶栏变成了编辑条、面前却没有画布
    if (value && activeView.value !== 'home') {
      applyView('home')
      void settingsStore.updateSettings({ activeView: 'home' })
    }
  }

  /** 切页的共同部分：布局编辑只对首页画布有意义，切走时收掉 */
  function applyView(value: ViewId): void {
    activeView.value = value
    if (value !== 'home')
      layoutEditing.value = false
  }

  async function setActiveView(value: ViewId): Promise<void> {
    if (value === activeView.value)
      return

    applyView(value)
    await settingsStore.updateSettings({ activeView: value })
  }

  return {
    activeView,
    setActiveView,
    applyView,
    layoutEditing,
    setLayoutEditing,
  }
})
