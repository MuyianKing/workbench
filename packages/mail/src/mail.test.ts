import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from './base64'
import { isBulkMail, sanitizeMailBulkSenders } from './bulk'
import { MAIL_ACCOUNTS_MAX, MAIL_POLL_DEFAULT, MAIL_POLL_MAX, MAIL_POLL_MIN, mailAccountReady, presetForAddress, sanitizeMailAccount, sanitizeMailAccounts, sanitizeMailAddress, sanitizeMailHost, sanitizeMailPollMinutes, sanitizeMailPort } from './mail'
import { buildMime } from './mime'
import { accountTag, displayDate, displaySender, htmlBody, mailTime, parseMessage, senderAddress } from './parse'
import { decodeEncodedWords, encodeRfc2047Word } from './rfc2047'

describe('账户配置收敛', () => {
  it('地址 trim、小写，没有 @ 就当没填', () => {
    expect(sanitizeMailAddress(' User@163.COM ')).toBe('user@163.com')
    expect(sanitizeMailAddress('not-an-address')).toBe('')
    expect(sanitizeMailAddress(undefined)).toBe('')
    // 过长的串（前 80 字符里都没有 @）整条当没填
    expect(sanitizeMailAddress(`${'x'.repeat(100)}@163.com`)).toBe('')
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

  it('qQ 地址（含 foxmail.com）走腾讯那套收发服务器', () => {
    const account = sanitizeMailAccount({ address: 'Someone@QQ.com' })
    expect(account.imapHost).toBe('imap.qq.com')
    expect(account.imapPort).toBe(993)
    expect(account.smtpHost).toBe('smtp.qq.com')
    expect(account.smtpPort).toBe(465)
    // foxmail.com 的邮箱也是同一套服务器、同一把授权码
    expect(presetForAddress('a@foxmail.com')?.imapHost).toBe('imap.qq.com')
  })

  it('用户自己填过的服务器不被预设覆盖', () => {
    const account = sanitizeMailAccount({
      address: 'a@163.com',
      imapHost: 'imap.example.com',
      imapPort: 10993,
      smtpHost: 'smtp.example.com',
      smtpPort: 10465,
    })
    expect(account.imapHost).toBe('imap.example.com')
    expect(account.imapPort).toBe(10993)
  })

  it('配置齐不齐的判断', () => {
    expect(mailAccountReady(sanitizeMailAccount({ address: 'a@163.com' }))).toBe(true)
    expect(mailAccountReady(sanitizeMailAccount({ address: 'a@example.com' }))).toBe(false)
    expect(mailAccountReady(sanitizeMailAccount({}))).toBe(false)
  })

  it('账户清单的收敛：没地址的丢、按地址去重、超上限截断', () => {
    const accounts = sanitizeMailAccounts([
      { address: ' A@163.com ' },
      { address: 'a@163.com', imapHost: 'imap.example.com' }, // 同地址：保留前一条，后面的丢
      { address: 'b@qq.com' },
      { imapHost: 'imap.example.com' }, // 没地址的半截，丢
      'not-an-object',
    ])
    expect(accounts.map(account => account.address)).toEqual(['a@163.com', 'b@qq.com'])
    expect(accounts[0].imapHost).toBe('imap.163.com')

    const full = Array.from({ length: MAIL_ACCOUNTS_MAX + 2 }, (_, index) => ({ address: `u${index}@163.com` }))
    expect(sanitizeMailAccounts(full)).toHaveLength(MAIL_ACCOUNTS_MAX)
    expect(sanitizeMailAccounts(undefined)).toEqual([])
    expect(sanitizeMailAccounts('a@163.com')).toEqual([])
  })

  it('后台检查周期：0 = 关闭，其余夹进 1..1440，非数字回默认', () => {
    expect(sanitizeMailPollMinutes(0)).toBe(0)
    expect(sanitizeMailPollMinutes(30)).toBe(30)
    expect(sanitizeMailPollMinutes(2.4)).toBe(2) // 四舍五入取整
    expect(sanitizeMailPollMinutes(0.4)).toBe(0) // 取整后 0，当关闭而不是夹回下限
    expect(sanitizeMailPollMinutes(MAIL_POLL_MAX + 500)).toBe(MAIL_POLL_MAX)
    expect(sanitizeMailPollMinutes(-10)).toBe(MAIL_POLL_MIN)
    expect(sanitizeMailPollMinutes(undefined)).toBe(MAIL_POLL_DEFAULT)
    expect(sanitizeMailPollMinutes('30')).toBe(MAIL_POLL_DEFAULT)
    expect(sanitizeMailPollMinutes(Number.NaN)).toBe(MAIL_POLL_DEFAULT)
  })
})

describe('rFC 2047 编码词', () => {
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
      attachments: [{ name: '报告.pdf', contentType: 'application/pdf', bytesBase64: bytesToBase64(new TextEncoder().encode('pdf-bytes')) }],
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
        attachments: [{ name: 'a.bin', contentType: 'application/octet-stream', bytesBase64: big }],
      }),
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
      '',
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
      '',
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

  it('日期的时间戳给排序用：解析不动给 0', () => {
    const older = mailTime('Mon, 5 Oct 2026 10:00:00 +0800')
    const newer = mailTime('Tue, 6 Oct 2026 09:00:00 +0800')
    expect(older).toBeGreaterThan(0)
    expect(newer).toBeGreaterThan(older)
    expect(mailTime('not a date')).toBe(0)
    expect(mailTime('')).toBe(0)
  })

  it('来源标注：本地部分 + 域名第一段，拆不动的原样给', () => {
    expect(accountTag('ZhangSan@163.com')).toBe('ZhangSan@163')
    expect(accountTag('lisi@qq.com')).toBe('lisi@qq')
    expect(accountTag('a@mail.corp.example.com')).toBe('a@mail')
    expect(accountTag('no-at-sign')).toBe('no-at-sign')
    expect(accountTag('@163.com')).toBe('@163.com')
  })
})

describe('广告邮件的识别', () => {
  const base = { subject: '周末的照片', from: 'alice@example.com' }

  it('黑名单说了算：用户标记过的发件人，过去将来的信都算广告', () => {
    expect(isBulkMail({ ...base, subject: 'Re: 项目排期', from: '张三 <zhang@corp.com>' }, ['zhang@corp.com'])).toBe(true)
    // 发件人头部带着显示名也认得出地址（senderAddress 提取）
    expect(isBulkMail(base, ['alice@example.com'])).toBe(true)
    expect(isBulkMail(base, [])).toBe(false)
    // 别的发件人不连坐
    expect(isBulkMail({ ...base, from: 'bob@example.com' }, ['alice@example.com'])).toBe(false)
  })

  it('带通知类 List-Unsubscribe 场景不再误拦（该信号已弃用：正常通知邮件也带）', () => {
    // 网易收件箱实测：注册确认、订单提醒这类都带 List-Unsubscribe —— 只凭它拦会误伤一片。
    // isBulkMail 不再收这个字段；这类信只有发件人进黑名单或撞上启发式才算广告。
    expect(isBulkMail({ subject: '你的帐号创建成功', from: 'noreply@github.com' })).toBe(false)
    expect(isBulkMail({ subject: '订单已发货', from: 'order@shop.example.com' })).toBe(false)
  })

  it('发件人地址一眼是批量发的算；事务性前缀不误伤', () => {
    expect(isBulkMail({ ...base, from: 'promo@shop.example.com' })).toBe(true)
    expect(isBulkMail({ ...base, from: '京东会员 <newsletter@mail.jd.com>' })).toBe(true)
    expect(isBulkMail({ ...base, from: 'no-reply@service.example.com' })).toBe(false)
    // 订单确认这类走 service / order 前缀 —— 不能拦
    expect(isBulkMail({ ...base, from: 'order@shop.example.com', subject: '订单已发货' })).toBe(false)
  })

  it('主题里的广告词算（中文包含、英文整词）', () => {
    expect(isBulkMail({ ...base, subject: '【京东】限时秒杀 全场 5 折' })).toBe(true)
    expect(isBulkMail({ ...base, subject: '双11 狂欢节提前购' })).toBe(true)
    expect(isBulkMail({ ...base, subject: 'Your weekly newsletter is here' })).toBe(true)
    // wholesale 不是 sale；整词匹配不误伤
    expect(isBulkMail({ ...base, subject: 'wholesale price inquiry' })).toBe(false)
    expect(isBulkMail({ ...base, subject: '周末拍的照片已修好' })).toBe(false)
    expect(isBulkMail({ ...base, subject: '关于项目排期的一封信' })).toBe(false)
  })

  it('黑名单的收敛：trim、小写、去重，认不出像地址的丢掉', () => {
    expect(sanitizeMailBulkSenders([' A@B.com ', 'a@b.com', 'not-an-address', '', 42, null])).toEqual(['a@b.com'])
    expect(sanitizeMailBulkSenders(undefined)).toEqual([])
    expect(sanitizeMailBulkSenders('a@b.com')).toEqual([])
  })
})
