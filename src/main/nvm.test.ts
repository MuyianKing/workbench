import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getNvmStatus,
  listInstalledVersions,
  matchInstalledVersion,
  nodeEnvFor,
  normalizeVersion,
  readNvmSettings,
  sortVersions
} from './nvm'

const ENV_KEYS = ['NVM_HOME', 'NVM_SYMLINK'] as const

let root = ''
let saved: Record<string, string | undefined> = {}

/** 造一个「已安装」的版本目录：nvm 认 vX.Y.Z + node.exe */
function makeVersion(version: string): string {
  const dir = join(root, `v${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'node.exe'), '')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workbench-nvm-'))
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  // junction 先单独摘掉，再删整棵树，避免递归删除踩到重解析点
  rmSync(join(root, 'nodejs'), { force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('listInstalledVersions', () => {
  it('只认 vX.Y.Z 且带 node.exe 的目录，并按版本号从高到低', () => {
    makeVersion('9.9.9')
    makeVersion('10.0.0')
    makeVersion('20.20.2')

    mkdirSync(join(root, 'v1.2')) // 版本号不完整
    mkdirSync(join(root, 'v14.18.2')) // 缺 node.exe，nvm 自己也视为损坏
    writeFileSync(join(root, 'v24.15.0.zip'), '') // 下载缓存
    writeFileSync(join(root, 'settings.txt'), 'root: whatever')

    expect(listInstalledVersions(root)).toEqual(['20.20.2', '10.0.0', '9.9.9'])
  })

  it('目录不存在时返回空数组而不是抛错', () => {
    expect(listInstalledVersions(join(root, 'nope'))).toEqual([])
  })
})

describe('sortVersions', () => {
  it('按数字比较，9 不会排到 10 前面', () => {
    expect(sortVersions(['9.9.9', '10.0.0', '10.0.1', '8.17.0'])).toEqual([
      '10.0.1',
      '10.0.0',
      '9.9.9',
      '8.17.0'
    ])
  })
})

describe('matchInstalledVersion', () => {
  const installed = ['20.20.2', '18.20.4', '8.17.0']

  it('精确匹配优先，允许带 v 前缀', () => {
    expect(matchInstalledVersion('20.20.2', installed)).toBe('20.20.2')
    expect(matchInstalledVersion('v18.20.4', installed)).toBe('18.20.4')
  })

  it('.nvmrc 里常见的段前缀落到该段内最高的版本', () => {
    expect(matchInstalledVersion('20', installed)).toBe('20.20.2')
    expect(matchInstalledVersion('18.20', installed)).toBe('18.20.4')
  })

  it('段前缀是按段比较，不是字符串前缀', () => {
    expect(matchInstalledVersion('20.2', installed)).toBeNull()
    expect(matchInstalledVersion('2', installed)).toBeNull()
  })

  it('读不懂或没装的返回 null', () => {
    expect(matchInstalledVersion('lts/*', installed)).toBeNull()
    expect(matchInstalledVersion('node', installed)).toBeNull()
    expect(matchInstalledVersion('', installed)).toBeNull()
    expect(matchInstalledVersion('99.0.0', installed)).toBeNull()
  })
})

describe('normalizeVersion', () => {
  it('去掉 v 前缀与空白', () => {
    expect(normalizeVersion(' v20.20.2 ')).toBe('20.20.2')
    expect(normalizeVersion('V18')).toBe('18')
  })
})

describe('readNvmSettings', () => {
  it('解析 root / path 两行，容忍引号与 CRLF', () => {
    writeFileSync(
      join(root, 'settings.txt'),
      `root: C:\\nvm\r\npath: "C:\\Program Files\\nodejs"\r\n`
    )
    expect(readNvmSettings(root)).toEqual({
      root: 'C:\\nvm',
      path: 'C:\\Program Files\\nodejs'
    })
  })

  it('没有 settings.txt 时返回空对象', () => {
    expect(readNvmSettings(root)).toEqual({})
  })
})

describe('getNvmStatus / nodeEnvFor', () => {
  it('以 NVM_HOME 为根：列出已装版本并解析软链当前版本', () => {
    makeVersion('20.20.2')
    makeVersion('24.15.0')
    const link = join(root, 'nodejs')
    writeFileSync(join(root, 'settings.txt'), `root: ${root}\r\npath: ${link}\r\n`)
    process.env.NVM_HOME = root
    process.env.NVM_SYMLINK = link

    // junction 不需要管理员权限；建不出来就只校验版本列表那一半
    try {
      symlinkSync(join(root, 'v20.20.2'), link, 'junction')
    } catch {
      /* 忽略 */
    }

    const status = getNvmStatus()
    expect(status.available).toBe(true)
    expect(status.root).toBe(root)
    expect(status.versions).toEqual(['24.15.0', '20.20.2'])
    expect(status.error).toBeUndefined()
    if (existsSync(link)) expect(status.current).toBe('20.20.2')
  })

  it('nodeEnvFor 把版本目录前置到 PATH，并解析出完整版本号', () => {
    makeVersion('20.20.2')
    process.env.NVM_HOME = root

    const runtime = nodeEnvFor('20', { Path: 'C:\\Windows' })
    expect(runtime?.version).toBe('20.20.2')
    expect(runtime?.dir).toBe(join(root, 'v20.20.2'))
    // PATH 的键名沿用传入环境里的写法（Windows 上常见 Path）
    expect(runtime?.env.Path).toBe(`${join(root, 'v20.20.2')}${win32.delimiter}C:\\Windows`)
    expect(runtime?.env.PATH).toBeUndefined()
  })

  it('PATH 缺失时也给出可用环境', () => {
    makeVersion('20.20.2')
    process.env.NVM_HOME = root
    expect(nodeEnvFor('20.20.2', {})?.env.PATH).toBe(join(root, 'v20.20.2'))
  })

  it('没选版本或没装该版本时返回 null，由调用方决定拦截还是走系统 node', () => {
    makeVersion('20.20.2')
    process.env.NVM_HOME = root

    expect(nodeEnvFor(undefined)).toBeNull()
    expect(nodeEnvFor('   ')).toBeNull()
    expect(nodeEnvFor('99.0.0')).toBeNull()
  })
})
