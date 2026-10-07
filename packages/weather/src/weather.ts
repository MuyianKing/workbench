/**
 * 实时天气（顶栏问候语旁那一小段）的纯逻辑：WMO 天气码的中文码表、两家接口回包的解析、
 * 城市名设置的收敛。
 *
 * **职责分工与 AI 热点一致**：取数在 Rust 侧（`src-tauri/src/weather.rs`，白名单两台主机：
 * 城市名检索走 OpenStreetMap 的 Nominatim、实况走 Open-Meteo 的 forecast），这里只做
 * 「把回包收敛成问候语能显示的一小段」，于是码表与口径可以单测、改起来走热更新不必重编 Rust。
 *
 * 显示口径：只说「现象 + 气温」两个已经发生的事实（`多云 19°`），不加语气、不给建议 ——
 * 与问候语整行的「如实说明」同一个调子。
 */

/** 一次实况的显示数据：现象文本（认不出的码为空串）与取整后的气温（℃） */
export interface WeatherView {
  text: string
  temperature: number
}

/** geocoding 的结果：地名与经纬度（经纬度只在本机内存里缓存，不落盘、不参与同步） */
export interface WeatherGeo {
  name: string
  latitude: number
  longitude: number
}

/** 实况刷新间隔：半小时一次，够新也不打扰源站 */
export const WEATHER_REFRESH_MS = 30 * 60 * 1000

/** 城市名设置的上限：中文城市名最长也就七八个字，40 是给「市 / 自治州全称」留的余量 */
export const WEATHER_CITY_MAX = 40

/**
 * WMO 天气码 → 中文现象（Open-Meteo 的 `weather_code`，按 WMO 4677 表）。
 * 码表外的码显示为空串：只说认得出的，不硬编一个「未知」出来占地方。
 */const WEATHER_TEXTS: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '中毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '大冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '大冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
}

/** 天气码的中文现象；码表外的码给空串 */
export function weatherTextOf(code: number): string {
  return WEATHER_TEXTS[code] ?? ''
}

/** 气温按整数控一位小数（18.7 → 19）：实况的第三位小数没有意义 */
export function formatWeatherView(view: WeatherView): string {
  const temperature = `${Math.round(view.temperature)}°`
  return view.text ? `${view.text} ${temperature}` : temperature
}

/**
 * 城市名设置的收敛：非字符串当没填、空白串压成一个空格、去首尾、截到上限。
 * 留空（空串）= 关闭这条出口 —— 与两个同步仓库「留空即关闭」同一条规矩。
 */
export function sanitizeWeatherCity(raw: unknown): string {
  if (typeof raw !== 'string')
    return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, WEATHER_CITY_MAX)
}

/** 两家接口的共同骨架：只认 JSON 对象，其余（HTML 风控页、空壳）一律当没数据 */
function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  }
  catch {
    return null
  }
}

/** 数字或数字字符串都收（Nominatim 把经纬度当字符串给），NaN / Infinity / 缺字段不算 */
function numericOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 解析 geocoding 的回包（Nominatim 的 `/search`，limit=1）：取第一条结果。
 * 坐标在回包里是字符串，这里收编成数；没找到城市（空数组）与垃圾回包都返回 null ——
 * 调用方把 null 说成「没找到」。
 */
export function parseWeatherGeocoding(body: string): WeatherGeo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed))
    return null

  const first = parsed[0]
  if (typeof first !== 'object' || first === null)
    return null
  const record = first as Record<string, unknown>
  const latitude = numericOf(record.lat)
  const longitude = numericOf(record.lon)
  if (latitude === null || longitude === null)
    return null

  const displayName = typeof record.display_name === 'string' ? record.display_name : ''
  return {
    name: typeof record.name === 'string' && record.name ? record.name : displayName.split(',')[0]?.trim() ?? '',
    latitude,
    longitude,
  }
}

/**
 * 解析 forecast 的回包（`/v1/forecast`，current=temperature_2m,weather_code）。
 * 回来的是**实况**：气温必须是有限的数；天气码认不出就给空串现象，
 * 气温仍在 —— 「多少度」永远比「叫什么」先成立。
 */
export function parseWeatherForecast(body: string): WeatherView | null {
  const root = parseJsonObject(body)
  const current = root?.current
  if (typeof current !== 'object' || current === null)
    return null

  const record = current as Record<string, unknown>
  const temperature = numericOf(record.temperature_2m)
  if (temperature === null)
    return null

  const code = numericOf(record.weather_code)
  return {
    text: code === null ? '' : weatherTextOf(code),
    temperature,
  }
}
