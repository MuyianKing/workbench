import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from './base64'
import { mailAccountReady, presetForAddress, sanitizeMailAccount, sanitizeMailAddress, sanitizeMailHost, sanitizeMailPort } from './mail'
import { decodeEncodedWords, encodeRfc2047Word } from './rfc2047'
import { buildMime } from './mime'
import { displayDate, displaySender, htmlBody, parseMessage, senderAddress } from './parse'

describe('账户配置收敛', () => {
  it('地址 trim、小写，没有 @ 就当没填', () => {
    expect(sanitizeMailAddress(' User@163.COM ')).toBe('user@163.com')
    expect(sanitizeMailAddress('not-an-address')).toBe('')
    expect(sanitizeMailAddress(undefined)).toBe('')
    // 过长的串（前 80 字符里都没有 @）整条当没填
    expect(sanitizeMailAddress('x'.repeat(100) + '@163.com')).toBe('')
  })

  it('主机名剥掉协议头与路径', () => {
    expect(sanitizeMailHost('ssl://imap.163.com/')).toBe('imap.163.com')
    expect(sanitizeMailHost('  SMTP.126.com ')).toBe('smtp.126.com')
    expect(sanitizeMailHost('')).toBe('')
  })

  it('端口收敛成 0-65535 的整数，0 表示没填', () => {
    expect(sanitizeMailPort(993)).toBe(993)
    expect(sanitizeMailPort('465')).toBe(465)
    expect(sanitizeMailPort(0)).toBe(0)
    expect(sanitizeMailPort(-1)).toBe(0)
    expect(sanitizeMailPort(99999)).toBe(0)
    expect(sanitizeMailPort('abc')).toBe(0)
  })

  it('163 地址自动带出官方服务器预设', () => {
    const account = sanitizeMailAccount({ address: 'Someone@163.com' })
    expect(account.address).toBe('someone@163.com')
    expect(account.imapHost).toBe('imap.163.com')
    expect(account.imapPort).toBe(993)
    expect(account.smtpHost).toBe('smtp.163.com')
    expect(account.smtpPort).toBe(465)
  })

  it('126 地址走 126 的预设；认不出的域名不瞎猜', () => {
    expect(presetForAddress('a@126.com')?.imapHost).toBe('imap.126.com')
    expect(presetForAddress('a@example.com')).toBeNull()
    const account = sanitizeMailAccount({ address: 'a@example.com' })
    expect(account.imapHost).toBe('')
    expect(account.imapPort).toBe(0)
  })

  it('用户自己填过的服务器不被预设覆盖', () => {
    const account = sanitizeMailAccount({
      address: 'a@163.com',
      imapHost: 'imap.example.com',
      imapPort: 10993,
      smtpHost: 'smtp.example.com',
      smtpPort: 10465
    })
    expect(account.imapHost).toBe('imap.example.com')
    expect(account.imapPort).toBe(10993)
  })

  it('配置齐不齐的判断', () => {
    expect(mailAccountReady(sanitizeMailAccount({ address: 'a@163.com' }))).toBe(true)
    expect(mailAccountReady(sanitizeMailAccount({ address: 'a@example.com' }))).toBe(false)
    expect(mailAccountReady(sanitizeMailAccount({}))).toBe(false)
  })
})

describe('RFC 2047 编码词', () => {
  it('解 B 编码的 UTF-8 中文', () => {
    // "测试" 的 UTF-8 字节经 B 编码
    expect(decodeEncodedWords('=?utf-8?B?5rWL6K+V?=')).toBe('测试')
  })

  it('解 Q 编码', () => {
    // "测试" 的 Q 编码（UTF-8）
    expect(decodeEncodedWords('=?utf-8?Q?=E6=B5=8B=E8=AF=95?=')).toBe('测试')
    // 下划线当空格
    expect(decodeEncodedWords('=?utf-8?Q?hello_world?=')).toBe('hello world')
  })

  it('解 gb2312 的中文', () => {
    // "中文" 的 GBK 字节（D6 D0 CE C4）经 B 编码
    expect(decodeEncodedWords('=?gb2312?B?1tDOxA==?=')).toBe('中文')
  })

  it('相邻编码词之间的空白缝掉', () => {
    // "测" 与 "试" 各编一词
    expect(decodeEncodedWords('=?utf-8?B?5rWL?= =?utf-8?B?6K+V?=')).toBe('测试')
    expect(decodeEncodedWords('=?utf-8?B?5rWL?=\r\n\t=?utf-8?B?6K+V?=')).toBe('测试')
  })

  it('认不出的字符集原样保留', () => {
    const raw = '=?x-unknown?B?5rWL6K+V?='
    expect(decodeEncodedWords(raw)).toBe(raw)
  })

  it('坏 base64 原样保留', () => {
    const raw = '=?utf-8?B?%%%not-base64%%%?='
    expect(decodeEncodedWords(raw)).toBe(raw)
  })

  it('中文主题 B 编码回去、纯 ASCII 不编码', () => {
    const encoded = encodeRfc2047Word('测试')
    expect(encoded).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/]*={0,2}\?=$/)
    expect(decodeEncodedWords(encoded)).toBe('测试')
    expect(encodeRfc2047Word('plain subject')).toBe('plain subject')
  })
})

describe('发信报文构建', () => {
  it('无附件：text/plain 单段', () => {
    const mime = buildMime({ from: 'me@163.com', to: ['you@qq.com'], subject: '你好', text: '第一行\n第二行' })
    expect(mime).toContain('From: me@163.com')
    expect(mime).toContain('To: you@qq.com')
    expect(mime).toMatch(/^Subject: =\?utf-8\?B\?/m)
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8')
    expect(mime).not.toContain('multipart/mixed')
    // 换行归一成 CRLF，且整体是 CRLF 分行
    expect(mime).not.toMatch(/(?<!\r)\n/)
  })

  it('有附件：multipart/mixed 包住文本与文件，文件名走 RFC 2231', () => {
    const mime = buildMime({
      from: 'me@163.com',
      to: ['you@qq.com'],
      subject: '带附件',
      text: '见附件',
      attachments: [{ name: '报告.pdf', contentType: 'application/pdf', bytesBase64: bytesToBase64(new TextEncoder().encode('pdf-bytes')) }]
    })
    expect(mime).toContain('multipart/mixed; boundary=')
    expect(mime).toContain('Content-Type: application/pdf')
    // ASCII 兜底名把非 ASCII 换成下划线（两个中文字符两个下划线），RFC 2231 的是完整百分号编码
    expect(mime).toMatch(/Content-Disposition: attachment; filename="__\.pdf"; filename\*=utf-8''%E6%8A%A5%E5%91%8A\.pdf/)
    expect(mime).toContain(`--${mime.match(/boundary="([^"]+)"/)![1]}--`)
  })

  it('超 30 MB 直接拒', () => {
    const big = bytesToBase64(new Uint8Array(31 * 1024 * 1024 / 4 * 3)).slice(0, 31 * 1024 * 1024)
    expect(() =>
      buildMime({
        from: 'me@163.com',
        to: ['you@qq.com'],
        subject: 'too big',
        text: 'x',
        attachments: [{ name: 'a.bin', contentType: 'application/octet-stream', bytesBase64: big }]
      })
    ).toThrow(/30 MB/)
  })
})

describe('收信侧解析', () => {
  /** 拼一份最小的 multipart 报文：正文 + 一个内联图 + 一个附件 */
  function sampleMessageBase64(): string {
    const raw = [
      'From: =?utf-8?B?5byg5LiJ?= <alice@example.com>',
      'To: me@163.com',
      'Subject: =?gb2312?B?1tDOxA==?=',
      'Date: Mon, 5 Oct 2026 10:00:00 +0800',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="BB"',
      '',
      '--BB',
      'Content-Type: multipart/alternative; boundary="AA"',
      '',
      '--AA',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '纯文本正文',
      '--AA',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>富文本 <img src="cid:pic1"></p>',
      '--AA--',
      '--BB',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <pic1>',
      'Content-Disposition: inline',
      '',
      'iVBORw0KGgo=',
      '--BB',
      'Content-Type: application/pdf; name="a.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="a.pdf"',
      '',
      'JVBERi0=',
      '--BB--',
      ''
    ].join('\r\n')
    return bytesToBase64(new TextEncoder().encode(raw))
  }

  it('parseMessage 拆出文本、HTML、附件与内联图', async () => {
    const parsed = await parseMessage(sampleMessageBase64())
    expect(parsed.subject).toBe('中文')
    expect(parsed.from?.name).toBe('张三')
    expect(parsed.from?.address).toBe('alice@example.com')
    expect(parsed.text).toContain('纯文本正文')
    expect(parsed.html).toContain('富文本')
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0].name).toBe('a.pdf')
    expect(parsed.inline).toHaveLength(1)
    expect(parsed.inline[0].contentId).toBe('pic1')
  })

  it('htmlBody 注入 CSP 并把 cid 换成 data URL', async () => {
    const parsed = await parseMessage(sampleMessageBase64())
    const html = htmlBody(parsed)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('img-src data:')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(html).not.toContain('cid:')
  })

  it('没有 HTML 正文时返回 null', () => {
    expect(htmlBody({ subject: '', from: null, text: 'x', html: '', attachments: [], inline: [] })).toBeNull()
  })

  it('外链图片保留原样（加载被 CSP 挡住，标记不动）', async () => {
    const raw = [
      'From: a@b.com',
      'Subject: tracking',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<img src="https://tracker.example.com/pixel">',
      ''
    ].join('\r\n')
    const parsed = await parseMessage(bytesToBase64(new TextEncoder().encode(raw)))
    expect(htmlBody(parsed)).toContain('https://tracker.example.com/pixel')
  })
})

describe('展示层的拆解', () => {
  it('发件人名字优先，编码词解码；没名字退回地址', () => {
    expect(displaySender('Alice <alice@example.com>')).toBe('Alice')
    expect(displaySender('=?utf-8?B?5byg5LiJ?= <alice@example.com>')).toBe('张三')
    expect(displaySender('bob@example.com')).toBe('bob@example.com')
    expect(senderAddress('Alice <alice@example.com>')).toBe('alice@example.com')
    expect(senderAddress('bob@example.com')).toBe('bob@example.com')
  })

  it('日期解析成短串，解析不动原样给', () => {
    expect(displayDate('Mon, 5 Oct 2026 10:00:00 +0800')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/)
    expect(displayDate('not a date')).toBe('not a date')
    expect(displayDate('')).toBe('')
  })
})
