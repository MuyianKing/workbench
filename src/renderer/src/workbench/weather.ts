/**
 * 实时天气（顶栏问候语旁那一小段）的适配层实现。
 *
 * **为什么会出网**：命令在 Rust 侧（`src-tauri/src/weather.rs`），白名单两台主机、各管一段 ——
 * 城市名检索走 OpenStreetMap 的 Nominatim（对中文城市名的匹配比 Open-Meteo 自带检索可靠），
 * 实况走 Open-Meteo。这一层能带下去的只有设置里的城市名与上一步换来的经纬度，
 * 拼不出任意地址。这里只做「取原始回包 → 交给 shared/weather.ts 解析」，策略
 * （间隔、按城市缓存坐标）在 stores/weather.ts。
 */
import {
  parseWeatherForecast,
  parseWeatherGeocoding,
  type WeatherGeo,
  type WeatherView
} from '@shared/weather'
import { fail, ok } from '@shared/result'
import type { Result } from '@shared/types'
import { guard, invoke } from './bridge'

/** Rust 回来的原始取数结果（与 weather.rs 的 WeatherFetchResult 一致） */
interface WeatherFetchResult {
  status: number
  body: string
}

function reasonOf(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/**
 * 城市名换经纬度。没找到（HTTP 404 或回包里没有结果）与取数失败都如实说 ——
 * 失败原因会落到问候语旁边吗？不会：问候语那一行只画成功的值，
 * 失败原因只在控制台留一条（城市是用户手填的，填错了改一下就行）。
 */
export async function geocodeCity(city: string): Promise<Result<WeatherGeo>> {
  try {
    const fetched = await invoke<WeatherFetchResult>('weather_geocode', { city })
    if (fetched.status !== 200) {
      return fail(`查「${city}」失败（HTTP ${fetched.status}）`)
    }
    const geo = parseWeatherGeocoding(fetched.body)
    if (!geo) return fail(`没找到「${city}」，看看是不是这个名字的另一种写法`)
    return ok(geo)
  } catch (error) {
    return fail(reasonOf(error, '查询城市失败'))
  }
}

/** 经纬度取实况。回包的解析在 shared（天气码表有单测），这里只管取回原文 */
export async function fetchWeather(geo: WeatherGeo): Promise<Result<WeatherView>> {
  const fetched = await guard(
    invoke<WeatherFetchResult>('weather_forecast', {
      latitude: geo.latitude,
      longitude: geo.longitude
    }),
    '获取天气失败'
  )
  if (!fetched.ok || !fetched.data) return fail(fetched.error ?? '获取天气失败')
  if (fetched.data.status !== 200) {
    return fail(`获取天气失败（HTTP ${fetched.data.status}）`)
  }
  const view = parseWeatherForecast(fetched.data.body)
  if (!view) return fail('天气接口回了个空壳，解析不出实况')
  return ok(view)
}
