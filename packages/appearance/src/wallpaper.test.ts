import { describe, expect, it } from 'vitest'
import {
  BUILTIN_WALLPAPER_PREFIX,
  builtinIdOf,
  builtinReference,
  isSafeWallpaperId,
  isWallpaperFile,
  wallpaperIdOf
} from './wallpaper'

describe('wallpaperIdOf', () => {
  it('去掉最后一段后缀', () => {
    expect(wallpaperIdOf('ink-bamboo.png')).toBe('ink-bamboo')
    expect(wallpaperIdOf('ink-bamboo.source.svg')).toBe('ink-bamboo.source')
  })

  it('没有后缀时原样返回', () => {
    expect(wallpaperIdOf('ink-bamboo')).toBe('ink-bamboo')
  })
})

describe('builtinReference', () => {
  it('拼成 builtin: 引用', () => {
    expect(builtinReference('ink-bamboo')).toBe('builtin:ink-bamboo')
    expect(BUILTIN_WALLPAPER_PREFIX).toBe('builtin:')
  })
})

describe('isSafeWallpaperId', () => {
  it('普通的文件名主干放行', () => {
    expect(isSafeWallpaperId('ink-bamboo')).toBe(true)
    expect(isSafeWallpaperId('ink_bamboo.2')).toBe(true)
    expect(isSafeWallpaperId('2026')).toBe(true)
  })

  it('中文名放行（内置壁纸就是中文名）', () => {
    expect(isSafeWallpaperId('万重山')).toBe(true)
    expect(isSafeWallpaperId('五星红旗')).toBe(true)
    expect(isSafeWallpaperId('古建云雾 2')).toBe(true)
  })

  it('路径穿越与分隔符一律拒绝', () => {
    expect(isSafeWallpaperId('../../secret')).toBe(false)
    expect(isSafeWallpaperId('..')).toBe(false)
    expect(isSafeWallpaperId('a/b')).toBe(false)
    expect(isSafeWallpaperId('a\\b')).toBe(false)
    expect(isSafeWallpaperId('a:b')).toBe(false)
    expect(isSafeWallpaperId('a*b')).toBe(false)
    expect(isSafeWallpaperId('   ')).toBe(false)
    expect(isSafeWallpaperId('')).toBe(false)
    expect(isSafeWallpaperId(null)).toBe(false)
  })
})

describe('builtinIdOf', () => {
  it('认出内置引用并取出 id', () => {
    expect(builtinIdOf('builtin:ink-bamboo')).toBe('ink-bamboo')
    expect(builtinIdOf('  builtin:ink-bamboo  ')).toBe('ink-bamboo')
    expect(builtinIdOf('builtin:万重山')).toBe('万重山')
  })

  it('磁盘路径不是内置引用', () => {
    expect(builtinIdOf('D:\\pics\\bg.jpg')).toBeNull()
    expect(builtinIdOf('')).toBeNull()
    expect(builtinIdOf(undefined)).toBeNull()
  })

  it('不合法 / 想穿越的 id 也当作认不出来', () => {
    expect(builtinIdOf('builtin:../secret')).toBeNull()
    expect(builtinIdOf('builtin:')).toBeNull()
    expect(builtinIdOf('builtin:a/b')).toBeNull()
    expect(builtinIdOf('builtin:a\\b')).toBeNull()
  })
})

describe('isWallpaperFile', () => {
  it('常见位图都认', () => {
    expect(isWallpaperFile('ink-bamboo.png')).toBe(true)
    expect(isWallpaperFile('bg.JPG')).toBe(true)
    expect(isWallpaperFile('bg.jpeg')).toBe(true)
    expect(isWallpaperFile('bg.webp')).toBe(true)
    expect(isWallpaperFile('bg.bmp')).toBe(true)
    expect(isWallpaperFile('万重山.jpg')).toBe(true)
  })

  it('svg 母版、没有后缀、隐藏文件都不是壁纸', () => {
    expect(isWallpaperFile('ink-bamboo.svg')).toBe(false)
    expect(isWallpaperFile('README')).toBe(false)
    expect(isWallpaperFile('.DS_Store')).toBe(false)
    expect(isWallpaperFile(42)).toBe(false)
  })
})
