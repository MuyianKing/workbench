import { describe, expect, it } from 'vitest'
import { parsePortFromLog } from './dev-port'

describe('parsePortFromLog', () => {
  it('认得 Vite / vue-cli 常见的启动输出', () => {
    expect(parsePortFromLog('  ➜  Local:   http://localhost:5173/')).toBe(5173)
    expect(parsePortFromLog('  - Local:   http://localhost:8080/')).toBe(8080)
    expect(parsePortFromLog('App running at http://127.0.0.1:3000')).toBe(3000)
    expect(parsePortFromLog('listening on 0.0.0.0:4000')).toBe(4000)
    expect(parsePortFromLog('server started http://[::1]:5200')).toBe(5200)
  })

  it('同一行里只取第一个端口', () => {
    expect(parsePortFromLog('proxying localhost:5173 -> localhost:9000')).toBe(5173)
  })

  it('认不出就返回 undefined，调用方据此跳过占用检查', () => {
    expect(parsePortFromLog('ready in 320ms')).toBeUndefined()
    expect(parsePortFromLog('http://example.com/docs')).toBeUndefined()
    expect(parsePortFromLog('')).toBeUndefined()
  })

  it('越界的数字不当端口', () => {
    expect(parsePortFromLog('localhost:99999')).toBeUndefined()
    expect(parsePortFromLog('localhost:0')).toBeUndefined()
  })
})
