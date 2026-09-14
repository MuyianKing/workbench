import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectConfiguredOutputDir,
  detectFramework,
  detectPackageManager,
  isNonEmptyDir,
  isValidScriptName,
  pickBuild,
  pickServe,
  resolveOutputDir,
  scanProject,
  type ScanFs
} from './scanner'

/**
 * 测试用的 ScanFs：直接走 node:fs。
 * 把 fs 抽成参数就是为了这个——逻辑留在 TS、测试留在 vitest，
 * 生产的实现换成走 Rust 命令（见 src/renderer/src/workbench/scanner.ts）而不用改一行断言。
 */
const nodeFs: ScanFs = {
  async readText(path) {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return null
    }
  },
  async isDirectory(path) {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  async listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  }
}

const tempDirs: string[] = []

function makeProject(pkg: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-scan-'))
  tempDirs.push(dir)

  if (pkg !== undefined) {
    writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg))
  }
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('isValidScriptName', () => {
  it('放行常规脚本名', () => {
    expect(isValidScriptName('dev')).toBe(true)
    expect(isValidScriptName('build:prod')).toBe(true)
    expect(isValidScriptName('test.unit')).toBe(true)
    expect(isValidScriptName('lint_all')).toBe(true)
  })

  it('挡掉可能拼进命令行的字符', () => {
    expect(isValidScriptName('dev && rm -rf /')).toBe(false)
    expect(isValidScriptName('dev; calc')).toBe(false)
    expect(isValidScriptName('dev | more')).toBe(false)
    expect(isValidScriptName('')).toBe(false)
  })
})

describe('pickServe', () => {
  it('优先级 serve > dev > start', () => {
    expect(pickServe({ start: 'x', dev: 'x', serve: 'x' })).toBe('serve')
    expect(pickServe({ start: 'x', dev: 'x' })).toBe('dev')
    expect(pickServe({ start: 'x' })).toBe('start')
  })

  it('没有约定名时匹配变体', () => {
    expect(pickServe({ 'dev:web': 'x' })).toBe('dev:web')
    expect(pickServe({ 'serve:docs': 'x' })).toBe('serve:docs')
    expect(pickServe({ build: 'x' })).toBeUndefined()
    expect(pickServe({})).toBeUndefined()
  })
})

describe('pickBuild', () => {
  it('收集 build 及其变体', () => {
    expect(pickBuild({ build: 'x', 'build:prod': 'x', 'docs:build': 'x', dev: 'x' })).toEqual([
      'build',
      'build:prod',
      'docs:build'
    ])
  })

  it('没有 build 时返回空数组', () => {
    expect(pickBuild({ dev: 'x' })).toEqual([])
  })
})

describe('detectFramework', () => {
  it('按依赖推断框架', () => {
    expect(detectFramework({ vite: '^5' })).toBe('Vite')
    expect(detectFramework({ vue: '^3', '@vue/cli-service': '^5' })).toBe('Vue CLI')
    expect(detectFramework({ next: '^14' })).toBe('Next.js')
    expect(detectFramework({ vitepress: '^1' })).toBe('VitePress')
    expect(detectFramework({ lodash: '^4' })).toBe('Node')
  })
})

describe('detectPackageManager', () => {
  it('按锁文件判定，pnpm > yarn > npm', async () => {
    expect((await detectPackageManager(nodeFs, makeProject({}, { 'pnpm-lock.yaml': '' }))).pm).toBe('pnpm')
    expect((await detectPackageManager(nodeFs, makeProject({}, { 'yarn.lock': '' }))).pm).toBe('yarn')
    expect((await detectPackageManager(nodeFs, makeProject({}, { 'package-lock.json': '{}' }))).pm).toBe(
      'npm'
    )
  })

  it('多个锁文件同时存在时取优先级最高的', async () => {
    const dir = makeProject({}, { 'yarn.lock': '', 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })
    expect((await detectPackageManager(nodeFs, dir)).pm).toBe('pnpm')
  })

  it('没有锁文件时回退 npm', async () => {
    const result = await detectPackageManager(nodeFs, makeProject({}))
    expect(result.pm).toBe('npm')
    expect(result.lockFile).toBeUndefined()
  })
})

describe('detectConfiguredOutputDir', () => {
  it('读 vite.config 的 build.outDir', async () => {
    const dir = makeProject({}, { 'vite.config.ts': "export default { build: { outDir: 'www' } }" })
    expect(await detectConfiguredOutputDir(nodeFs, dir)).toBe('www')
  })

  it('读 vue.config.js 的 outputDir', async () => {
    const dir = makeProject({}, { 'vue.config.js': "module.exports = { outputDir: 'public/dist' }" })
    expect(await detectConfiguredOutputDir(nodeFs, dir)).toBe('public/dist')
  })

  it('没有声明时返回 undefined', async () => {
    expect(await detectConfiguredOutputDir(nodeFs, makeProject({}))).toBeUndefined()
  })
})

describe('isNonEmptyDir', () => {
  it('空目录不算命中', async () => {
    const dir = makeProject({})
    mkdirSync(join(dir, 'dist'))
    expect(await isNonEmptyDir(nodeFs, join(dir, 'dist'))).toBe(false)

    writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>')
    expect(await isNonEmptyDir(nodeFs, join(dir, 'dist'))).toBe(true)
  })

  it('不存在的路径返回 false', async () => {
    expect(await isNonEmptyDir(nodeFs, join(makeProject({}), 'nope'))).toBe(false)
  })
})

describe('resolveOutputDir', () => {
  /** 在项目里造一个非空目录 */
  function makeDirWithFile(dir: string, name: string): void {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'index.html'), '<html></html>')
  }

  it('手动配置优先，且相对项目根解析', async () => {
    const dir = makeProject({}, { 'vite.config.ts': "export default { build: { outDir: 'www' } }" })
    makeDirWithFile(dir, 'www')
    makeDirWithFile(dir, 'public/dist')

    const result = await resolveOutputDir(nodeFs, dir, 'public/dist')
    expect(result).toEqual({ dir: join(dir, 'public', 'dist'), detected: true })
  })

  it('手动配置为空目录时退回探测', async () => {
    const dir = makeProject({}, { 'vite.config.ts': "export default { build: { outDir: 'www' } }" })
    mkdirSync(join(dir, 'public/dist'), { recursive: true })
    makeDirWithFile(dir, 'www')

    // 空目录不算命中：产物压根没生成，打开它没有意义
    const result = await resolveOutputDir(nodeFs, dir, 'public/dist')
    expect(result).toEqual({ dir: join(dir, 'www'), detected: true })
  })

  it('没有手动配置时用构建配置声明的 outDir', async () => {
    const dir = makeProject({}, { 'vite.config.ts': "export default { build: { outDir: 'www' } }" })
    makeDirWithFile(dir, 'www')

    expect(await resolveOutputDir(nodeFs, dir)).toEqual({ dir: join(dir, 'www'), detected: true })
  })

  it('回退到常见目录名', async () => {
    const dir = makeProject({})
    makeDirWithFile(dir, 'dist')

    expect(await resolveOutputDir(nodeFs, dir)).toEqual({ dir: join(dir, 'dist'), detected: true })
  })

  it('都没有命中时回退项目根并标记未探测到', async () => {
    const dir = makeProject({})
    expect(await resolveOutputDir(nodeFs, dir)).toEqual({ dir, detected: false })
  })

  it('手动配置写成绝对路径时原样使用', async () => {
    const dir = makeProject({})
    const outside = mkdtempSync(join(tmpdir(), 'workbench-scan-out-'))
    tempDirs.push(outside)
    makeDirWithFile(outside, 'release')

    const result = await resolveOutputDir(nodeFs, dir, join(outside, 'release'))
    expect(result).toEqual({ dir: join(outside, 'release'), detected: true })
  })
})

describe('scanProject', () => {
  it('正常项目返回完整识别结果', async () => {
    const dir = makeProject(
      {
        name: 'admin-web',
        version: '1.2.0',
        scripts: { dev: 'vite', build: 'vite build', 'build:test': 'vite build --mode test' },
        devDependencies: { vite: '^5' },
        engines: { node: '>=18' }
      },
      { 'pnpm-lock.yaml': '', 'vite.config.ts': "export default { build: { outDir: 'www' } }" }
    )
    mkdirSync(join(dir, 'www'))
    writeFileSync(join(dir, 'www', 'index.html'), 'x')

    const scan = await scanProject(nodeFs, dir)

    expect(scan.ok).toBe(true)
    expect(scan.name).toBe('admin-web')
    expect(scan.version).toBe('1.2.0')
    expect(scan.framework).toBe('Vite')
    expect(scan.detectedPackageManager).toBe('pnpm')
    expect(scan.serve).toBe('dev')
    expect(scan.build).toEqual(['build', 'build:test'])
    expect(scan.outputDir).toBe('www')
    expect(scan.enginesNode).toBe('>=18')
    expect(scan.nodeRequirementFrom).toBe('engines')
  })

  it('没有 engines 时回退 .nvmrc', async () => {
    const dir = makeProject({ name: 'a' }, { '.nvmrc': 'v18.16.0\n' })
    const scan = await scanProject(nodeFs, dir)

    expect(scan.enginesNode).toBe('v18.16.0')
    expect(scan.nodeRequirementFrom).toBe('nvmrc')
  })

  it('目录不存在时直接报错', async () => {
    const scan = await scanProject(nodeFs, join(tmpdir(), 'workbench-not-exist-2f8a'))
    expect(scan.ok).toBe(false)
    expect(scan.error).toContain('目录不存在')
  })

  it('没有 package.json 时拒绝', async () => {
    const dir = makeProject(undefined)
    const scan = await scanProject(nodeFs, dir)

    expect(scan.ok).toBe(false)
    expect(scan.parseError).toBeUndefined()
    expect(scan.error).toContain('package.json')
  })

  it('package.json 损坏时标记 parseError 而不是普通失败', async () => {
    const dir = makeProject('{ this is not json')
    const scan = await scanProject(nodeFs, dir)

    expect(scan.ok).toBe(false)
    expect(scan.parseError).toBe(true)
    expect(scan.error).toContain('解析失败')
    // 名字保底为目录名，方便「仅管理目录」方式加入
    expect(scan.name.length).toBeGreaterThan(0)
  })
})
