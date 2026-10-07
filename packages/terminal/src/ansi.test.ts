import { describe, expect, it } from 'vitest'
import { cleanLogLine, stripAnsi } from './ansi'

describe('stripAnsi', () => {
  it('去掉颜色 SGR，只留文字', () => {
    expect(stripAnsi('\u001B[32m✓\u001B[0m built in 1.2s')).toBe('✓ built in 1.2s')
  })

  it('支持带多个参数的 SGR（256 色 / 真彩）', () => {
    expect(stripAnsi('\u001B[38;5;196merr\u001B[m')).toBe('err')
  })

  it('去掉进度条的「清行 + 上移 + 清行 + 回行首」（log-update 每帧重画时打的那套）', () => {
    const line
      = '\u001B[2K\u001B[1A\u001B[2K\u001B[G[92%] sealing (asset processing HotModuleReplacement)'
    expect(cleanLogLine(line)).toBe('[92%] sealing (asset processing HotModuleReplacement)')
  })

  it('进度条上色时每段外面套着 SGR，也一并清掉', () => {
    const line
      = '\u001B[2K\u001B[1A\u001B[2K\u001B[G\u001B[33m[93%] \u001B[39m\u001B[37msealing \u001B[39m\u001B[90m(emitting emit)\u001B[39m'
    expect(cleanLogLine(line)).toBe('[93%] sealing (emitting emit)')
  })

  it('去掉隐藏 / 显示光标这类带 ? 的私有序列', () => {
    expect(stripAnsi('\u001B[?25l\u001B[?25h 完成')).toBe(' 完成')
  })

  it('去掉 OSC（改标题、超链接），BEL 与 ST 两种收尾都要认', () => {
    expect(stripAnsi('\u001B]0;my title\u0007ok')).toBe('ok')
    expect(stripAnsi('\u001B]8;;https://example.com\u001B\\链接\u001B]8;;\u001B\\')).toBe('链接')
  })

  it('去掉字符集切换与短转义', () => {
    expect(stripAnsi('a\u001B(Bb\u001B=c')).toBe('abc')
  })

  it('落单的 ESC 与退格、响铃一并清掉', () => {
    expect(stripAnsi('a\u001Bb\u0008\u0007')).toBe('ab')
  })

  it('保留制表符与正文，不误伤正常的中括号文本', () => {
    expect(stripAnsi('a\tb\t[2K] 表头')).toBe('a\tb\t[2K] 表头')
  })

  it('没有控制序列时原样返回', () => {
    expect(stripAnsi('vite v7.3.6  ready in 320 ms')).toBe('vite v7.3.6  ready in 320 ms')
  })

  it('空串不出错', () => {
    expect(stripAnsi('')).toBe('')
  })
})

describe('cleanLogLine', () => {
  it('\\r 按终端语义处理：只保留最后一次改写的内容', () => {
    expect(cleanLogLine('10%\r50%\r100%')).toBe('100%')
  })

  it('先清控制序列再截 \\r，两者混在一起也一样', () => {
    expect(cleanLogLine('10%\r\u001B[K\u001B[32mdone\u001B[0m')).toBe('done')
  })

  it('没有 \\r 时等于 stripAnsi 的结果', () => {
    expect(cleanLogLine('\u001B[36mhttp://localhost:5173/\u001B[0m')).toBe('http://localhost:5173/')
  })

  it('整行都是控制序列时清完为空，交给调用方决定是否丢弃', () => {
    expect(cleanLogLine('\u001B[2K')).toBe('')
  })
})
