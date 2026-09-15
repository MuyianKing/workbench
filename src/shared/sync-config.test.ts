/**
 * 仓库里 `config/<设备id>.json` 的读写口径。
 *
 * 这份文件是「一台机器 theme.json 的整份副本」，采用它的后果是整份换掉本机外观 ——
 * 所以这里的重点是「什么样的一份文件才敢让用户点应用」：版本对不上、内容被手工改坏、
 * 连设备 id 都没有的，一律不能采用（用 null 表达，界面上那颗按钮也就点不动）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEME_VERSION, sanitizeTheme } from './theme'
import { captureThemeFile, sanitizeThemeFile } from './sync-config'

describe('打包一份要推上去的配置', () => {
  it('就是本机 theme.json 的整份内容加一层设备信封', () => {
    const theme = sanitizeTheme({ ...DEFAULT_THEME, gridStep: 4, leftWidth: 320 })
    const file = captureThemeFile('dev-1', ' 办公室 ', theme)

    expect(file.device).toBe('dev-1')
    expect(file.name).toBe('办公室')
    expect(file.theme).toEqual(theme)

    // 写出去再读回来必须一模一样：它是「一对一副本」，不是另一种结构
    const back = sanitizeThemeFile(JSON.parse(JSON.stringify(file)))
    expect(back?.theme).toEqual(theme)
  })
})

describe('读一份别人推上来的配置', () => {
  it('缺设备 id / 不是对象一律不认', () => {
    expect(sanitizeThemeFile(null)).toBeNull()
    expect(sanitizeThemeFile([])).toBeNull()
    expect(sanitizeThemeFile('配置')).toBeNull()
    expect(sanitizeThemeFile({ name: '没有 id', theme: DEFAULT_THEME })).toBeNull()
    expect(sanitizeThemeFile({ device: '   ', theme: DEFAULT_THEME })).toBeNull()
  })

  it('版本对不上的布局不采用：整份回默认套上去等于把对方的摆放清掉', () => {
    const file = sanitizeThemeFile({
      device: 'dev-2',
      name: '笔记本',
      theme: { ...DEFAULT_THEME, version: THEME_VERSION - 1 }
    })

    expect(file).not.toBeNull()
    expect(file?.theme).toBeNull()
  })

  it('内容被手工改坏时逐项收敛，越界的值不进界面', () => {
    const file = sanitizeThemeFile({
      device: 'dev-3',
      name: '书房',
      theme: {
        version: THEME_VERSION,
        leftWidth: 99999,
        updatedAt: 99,
        appearance: { accentColor: 'red', cardOpacity: 999, topBarStyle: 'rainbow' }
      }
    })

    expect(file?.theme?.leftWidth).toBeLessThanOrEqual(720)
    expect(file?.theme?.appearance.accentColor).toBe('')
    expect(file?.theme?.appearance.cardOpacity).toBe(100)
    expect(file?.theme?.appearance.topBarStyle).toBe(DEFAULT_THEME.appearance.topBarStyle)
    expect(file?.theme?.updatedAt).toBe(99)
  })

  it('没有 theme 字段也算不认（半个文件不该画出一半的外观）', () => {
    expect(sanitizeThemeFile({ device: 'dev-4', name: '书房' })?.theme).toBeNull()
  })
})
