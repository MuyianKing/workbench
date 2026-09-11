import { describe, expect, it } from 'vitest'
import { splitLinks } from './linkify'

describe('splitLinks', () => {
  it('没有地址时原样返回一段文本', () => {
    const text = '  ➜  Local:   ready in 320 ms'
    expect(splitLinks(text)).toEqual([{ text, url: null }])
  })

  it('切出中间的一段地址', () => {
    expect(splitLinks('  ➜  Local:   http://localhost:5173/blog/')).toEqual([
      { text: '  ➜  Local:   ', url: null },
      { text: 'http://localhost:5173/blog/', url: 'http://localhost:5173/blog/' }
    ])
  })

  it('https 同样识别', () => {
    expect(splitLinks('open https://example.com/docs now')).toEqual([
      { text: 'open ', url: null },
      { text: 'https://example.com/docs', url: 'https://example.com/docs' },
      { text: ' now', url: null }
    ])
  })

  it('地址后面紧跟的句号与全角标点不并进地址', () => {
    expect(splitLinks('见 http://localhost:5173/。')).toEqual([
      { text: '见 ', url: null },
      { text: 'http://localhost:5173/', url: 'http://localhost:5173/' },
      { text: '。', url: null }
    ])
  })

  it('一行里可以切出多个地址', () => {
    expect(splitLinks('a http://a.test/x b http://b.test/y')).toEqual([
      { text: 'a ', url: null },
      { text: 'http://a.test/x', url: 'http://a.test/x' },
      { text: ' b ', url: null },
      { text: 'http://b.test/y', url: 'http://b.test/y' }
    ])
  })

  it('只认带协议的地址，裸域名原样保留', () => {
    const text = 'see README.md or localhost:5173'
    expect(splitLinks(text)).toEqual([{ text, url: null }])
  })

  it('只有协议头不算链接', () => {
    expect(splitLinks('http://')).toEqual([{ text: 'http://', url: null }])
  })

  it('空串返回空数组', () => {
    expect(splitLinks('')).toEqual([])
  })
})
