import type { WeatherView } from './weather'
import { describe, expect, it } from 'vitest'
import { formatWeatherView, parseWeatherForecast, parseWeatherGeocoding, sanitizeWeatherCity, WEATHER_CITY_MAX, weatherTextOf } from './weather'

describe('weatherTextOf', () => {
  it('认得出 WMO 码表里的码', () => {
    expect(weatherTextOf(0)).toBe('晴')
    expect(weatherTextOf(2)).toBe('多云')
    expect(weatherTextOf(3)).toBe('阴')
    expect(weatherTextOf(45)).toBe('雾')
    expect(weatherTextOf(61)).toBe('小雨')
    expect(weatherTextOf(80)).toBe('小阵雨')
    expect(weatherTextOf(95)).toBe('雷阵雨')
  })

  it('码表外的码给空串，不硬编一个「未知」', () => {
    expect(weatherTextOf(4)).toBe('')
    expect(weatherTextOf(-1)).toBe('')
    expect(weatherTextOf(100)).toBe('')
  })
})

describe('formatWeatherView', () => {
  it('现象与气温拼成一段', () => {
    expect(formatWeatherView({ text: '多云', temperature: 18.7 })).toBe('多云 19°')
    expect(formatWeatherView({ text: '小雨', temperature: 12.2 })).toBe('小雨 12°')
  })

  it('认不出的现象只报气温', () => {
    expect(formatWeatherView({ text: '', temperature: -3.4 })).toBe('-3°')
  })

  it('气温取整数', () => {
    expect(formatWeatherView({ text: '晴', temperature: 19.5 })).toBe('晴 20°')
    expect(formatWeatherView({ text: '晴', temperature: -0.5 })).toBe('晴 0°')
  })
})

describe('sanitizeWeatherCity', () => {
  it('非字符串当没填', () => {
    expect(sanitizeWeatherCity(null)).toBe('')
    expect(sanitizeWeatherCity(42)).toBe('')
    expect(sanitizeWeatherCity(undefined)).toBe('')
  })

  it('去首尾空白、压掉中间的连续空白', () => {
    expect(sanitizeWeatherCity('  上海  ')).toBe('上海')
    expect(sanitizeWeatherCity('New\n  York')).toBe('New York')
  })

  it('截到上限', () => {
    expect(sanitizeWeatherCity('上'.repeat(WEATHER_CITY_MAX + 5)).length).toBe(WEATHER_CITY_MAX)
  })

  it('全空白等于没填（关闭这条出口）', () => {
    expect(sanitizeWeatherCity('   ')).toBe('')
  })
})

describe('parseWeatherGeocoding', () => {
  /** 一份与 Nominatim 实测回包同形的样例（经纬度是字符串） */
  const changzhou = {
    place_id: 225013803,
    osm_type: 'relation',
    lat: '31.8122623',
    lon: '119.9691539',
    name: '常州市',
    display_name: '常州市, 江苏省, 213000, 中国',
  }

  it('取第一条结果的地名与经纬度，字符串坐标收编成数', () => {
    const geo = parseWeatherGeocoding(JSON.stringify([changzhou, { lat: '0', lon: '0' }]))
    expect(geo).toEqual({ name: '常州市', latitude: 31.8122623, longitude: 119.9691539 })
  })

  it('没有 name 字段时回落到 display_name 的第一段', () => {
    const geo = parseWeatherGeocoding(
      JSON.stringify([{ lat: '31.8', lon: '119.9', display_name: '常州市, 江苏省, 中国' }]),
    )
    expect(geo).toEqual({ name: '常州市', latitude: 31.8, longitude: 119.9 })
  })

  it('没找到城市（空数组）返回 null', () => {
    expect(parseWeatherGeocoding('[]')).toBeNull()
  })

  it('坐标不是数（空串 / 乱码 / 缺字段）不算结果', () => {
    expect(parseWeatherGeocoding(JSON.stringify([{ lat: '', lon: '119.9' }]))).toBeNull()
    expect(parseWeatherGeocoding(JSON.stringify([{ lat: 'abc', lon: '119.9' }]))).toBeNull()
    expect(parseWeatherGeocoding(JSON.stringify([{ lon: '119.9' }]))).toBeNull()
  })

  it('垃圾回包（对象 / HTML / 断掉的 JSON）一律 null', () => {
    expect(parseWeatherGeocoding('{"results":[]}')).toBeNull()
    expect(parseWeatherGeocoding('<html>风控页</html>')).toBeNull()
    expect(parseWeatherGeocoding('not json')).toBeNull()
    expect(parseWeatherGeocoding('')).toBeNull()
  })
})

describe('parseWeatherForecast', () => {
  /** 一份与 Open-Meteo 实测回包同形的样例 */
  const sample = {
    latitude: 31.225,
    current_units: { temperature_2m: '°C', weather_code: 'wmo code' },
    current: { time: '2026-09-27T00:30', interval: 900, temperature_2m: 18.7, weather_code: 3 },
  }

  it('取出现象与实况气温（气温保持原值，显示时再取整）', () => {
    const view = parseWeatherForecast(JSON.stringify(sample))
    expect(view).toEqual({ text: '阴', temperature: 18.7 })
  })

  it('认不出的天气码给空串现象，气温仍在', () => {
    const body = JSON.stringify({
      current: { temperature_2m: 21.3, weather_code: 42 },
    })
    expect(parseWeatherForecast(body)).toEqual({ text: '', temperature: 21.3 })
  })

  it('缺气温就不是一份实况', () => {
    expect(parseWeatherForecast('{"current":{"weather_code":3}}')).toBeNull()
    expect(parseWeatherForecast('{"current":{"temperature_2m":null}}')).toBeNull()
    expect(parseWeatherForecast('{"current":{"temperature_2m":true}}')).toBeNull()
  })

  it('没有 current（缺字段 / 垃圾回包）一律 null', () => {
    expect(parseWeatherForecast('{}')).toBeNull()
    expect(parseWeatherForecast('{"error":true,"reason":"quota"}')).toBeNull()
    expect(parseWeatherForecast('gateway timeout')).toBeNull()
  })
})

describe('formatWeatherView 与 parseWeatherForecast 的口径', () => {
  it('解析 → 显示一路下来就是问候语里那一段', () => {
    const body = JSON.stringify({ current: { temperature_2m: 7.04, weather_code: 61 } })
    const view = parseWeatherForecast(body) as WeatherView
    expect(formatWeatherView(view)).toBe('小雨 7°')
  })
})
