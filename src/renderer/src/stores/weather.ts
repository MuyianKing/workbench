/**
 * 实时天气（顶栏问候语旁那一小段）的状态。
 *
 * **数据流**：设置里的城市（`settings.weatherCity`，留空 = 整条出口关闭）→ 经 Rust 的
 * 天气白名单换经纬度（`workbench/weather.ts`：检索走 OpenStreetMap 的 Nominatim，
 * 实况走 Open-Meteo）→ 按间隔取实况 → `view` 是问候语显示的那一小段。失败不清掉上一次的值：实况晚到几分钟比问候语闪一下诚实得多；
 * 原因只在控制台留一条 —— 城市是用户手填的，填错了到设置里改一下就行。
 *
 * 经纬度按城市缓存在内存里（换城市才重新查），**不落盘、不参与同步**：
 * 它只是一个中间量，丢了就再查一次。
 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { WEATHER_REFRESH_MS, type WeatherGeo, type WeatherView } from '@shared/weather'
import { fetchWeather, geocodeCity } from '@/workbench/weather'
import { useSettingsStore } from './settings'

export const useWeatherStore = defineStore('weather', () => {
  /** 已收敛的实况；null = 没填城市 / 还没取到 / 失败 —— 问候语那一小段就不画 */
  const view = ref<WeatherView | null>(null)

  /** 上一次成功 geocode 的坐标与对应城市；换城市后置空，下一次刷新重新查 */
  let geo: WeatherGeo | null = null

  /** 上一轮还没回来时不再起一轮：实况半小时才变一次，抢跑没有意义 */
  let inFlight = false

  async function refresh(): Promise<void> {
    const city = useSettingsStore().settings.weatherCity
    if (!city) {
      view.value = null
      geo = null
      return
    }
    if (inFlight) return
    inFlight = true
    try {
      if (!geo) {
        const located = await geocodeCity(city)
        if (!located.ok || !located.data) {
          console.warn('[workbench]', located.error)
          return
        }
        geo = located.data
      }
      const result = await fetchWeather(geo)
      if (result.ok && result.data) view.value = result.data
      else console.warn('[workbench]', result.error)
    } finally {
      inFlight = false
    }
  }

  /** 城市变了：坐标作废，马上取一次（间隔定时器随后会接上节拍） */
  watch(
    () => useSettingsStore().settings.weatherCity,
    () => {
      geo = null
      void refresh()
    }
  )

  /** 启动取一次，之后按间隔续。重复调用只起一个定时器（App.vue 的 onMounted 只该走一次，这里兜住） */
  let started = false
  function start(): void {
    if (started) return
    started = true
    void refresh()
    window.setInterval(() => void refresh(), WEATHER_REFRESH_MS)
  }

  return { view, refresh, start }
})
