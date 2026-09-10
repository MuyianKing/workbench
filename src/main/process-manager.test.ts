import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/types'
import { buildInvocation, detectServerAddress, resolvePackageManager } from './process-manager'

function project(patch: Partial<Project>): Project {
  return {
    packageManager: 'auto',
    detectedPackageManager: 'npm',
    ...patch
  } as Project
}

describe('resolvePackageManager', () => {
  it('auto 时用锁文件探测结果', () => {
    expect(resolvePackageManager(project({ packageManager: 'auto', detectedPackageManager: 'pnpm' }))).toBe(
      'pnpm'
    )
  })

  it('手动指定时覆盖探测结果', () => {
    expect(
      resolvePackageManager(project({ packageManager: 'yarn', detectedPackageManager: 'pnpm' }))
    ).toBe('yarn')
  })
})

describe('buildInvocation', () => {
  it('安装依赖：yarn 不带 install 子命令', () => {
    expect(buildInvocation('npm', 'install')).toEqual({
      bin: 'npm',
      args: ['install'],
      label: 'npm install'
    })
    expect(buildInvocation('pnpm', 'install')).toEqual({
      bin: 'pnpm',
      args: ['install'],
      label: 'pnpm install'
    })
    expect(buildInvocation('yarn', 'install')).toEqual({ bin: 'yarn', args: [], label: 'yarn' })
  })

  it('启动与打包统一走 run <script>', () => {
    expect(buildInvocation('npm', 'start', 'serve')).toEqual({
      bin: 'npm',
      args: ['run', 'serve'],
      label: 'npm run serve'
    })
    expect(buildInvocation('pnpm', 'build', 'build:prod')).toEqual({
      bin: 'pnpm',
      args: ['run', 'build:prod'],
      label: 'pnpm run build:prod'
    })
  })

  it('脚本名作为独立参数传递，不拼接进命令字符串', () => {
    // 参数来源只允许受信任的脚本名，拼接才需要担心注入
    const inv = buildInvocation('npm', 'start', 'dev')
    expect(inv.args).toEqual(['run', 'dev'])
    expect(inv.bin).toBe('npm')
  })
})

describe('detectServerAddress', () => {
  it('识别常见的 dev server 输出', () => {
    expect(detectServerAddress('  ➜  Local:   http://localhost:5173/')).toEqual({
      url: 'http://localhost:5173/',
      port: 5173
    })
    expect(detectServerAddress('App running at http://127.0.0.1:3000/')).toEqual({
      url: 'http://127.0.0.1:3000/',
      port: 3000
    })
    expect(detectServerAddress('- Local: http://localhost:8080/')).toEqual({
      url: 'http://localhost:8080/',
      port: 8080
    })
  })

  it('句尾标点不算 URL 的一部分', () => {
    expect(detectServerAddress('open http://localhost:5173/.')).toEqual({
      url: 'http://localhost:5173/',
      port: 5173
    })
  })

  it('只有 host:port 时兜底补上协议', () => {
    expect(detectServerAddress('listening on localhost:4200')).toEqual({
      url: 'http://localhost:4200',
      port: 4200
    })
    expect(detectServerAddress('  > Local: 0.0.0.0:7000')).toEqual({
      url: 'http://localhost:7000',
      port: 7000
    })
  })

  it('默认端口按协议补全', () => {
    expect(detectServerAddress('see https://example.com/docs')).toEqual({
      url: 'https://example.com/docs',
      port: 443
    })
  })

  it('普通日志与错误信息不会误判', () => {
    expect(detectServerAddress('VITE v5.0.0  ready in 320 ms')).toBeNull()
    expect(detectServerAddress('error: listen EADDRINUSE: address already in use :::3000')).toBeNull()
    expect(detectServerAddress('localhost:99999')).toBeNull()
  })
})
