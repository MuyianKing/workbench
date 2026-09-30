import { describe, expect, it } from 'vitest'
import {
  AUTH_PROVIDERS,
  accountLabel,
  isAuthProvider,
  sanitizeAccount
} from './auth'

describe('isAuthProvider', () => {
  it('只认这两家', () => {
    expect(isAuthProvider('github')).toBe(true)
    expect(isAuthProvider('gitee')).toBe(true)
    expect(isAuthProvider('gitlab')).toBe(false)
    expect(isAuthProvider(undefined)).toBe(false)
    expect(isAuthProvider(1)).toBe(false)
  })
})

describe('sanitizeAccount', () => {
  const valid = {
    provider: 'github',
    id: '1234',
    login: 'octocat',
    name: 'The Octocat',
    avatar: 'data:image/png;base64,AAAA'
  }

  it('原样保留一份合法的资料', () => {
    expect(sanitizeAccount(valid)).toEqual(valid)
  })

  it('认不出 provider 或没有登录名就整条丢掉', () => {
    // 这两项缺任何一个，界面上都是「显示了一个没有内容的账号」
    expect(sanitizeAccount({ ...valid, provider: 'gitlab' })).toBeNull()
    expect(sanitizeAccount({ ...valid, login: '' })).toBeNull()
    expect(sanitizeAccount({ ...valid, login: '   ' })).toBeNull()
    expect(sanitizeAccount(null)).toBeNull()
    expect(sanitizeAccount('octocat')).toBeNull()
    expect(sanitizeAccount({})).toBeNull()
  })

  it('去掉两端的空白', () => {
    const account = sanitizeAccount({ ...valid, login: '  octocat  ', name: '  喵  ' })
    expect(account?.login).toBe('octocat')
    expect(account?.name).toBe('喵')
  })

  it('昵称缺省或只有空白时落成 null，交给界面回落到登录名', () => {
    expect(sanitizeAccount({ ...valid, name: undefined })?.name).toBeNull()
    expect(sanitizeAccount({ ...valid, name: '   ' })?.name).toBeNull()
    expect(sanitizeAccount({ ...valid, name: 42 })?.name).toBeNull()
  })

  it('头像只认 data URL，外链一律丢掉', () => {
    // 手改数据文件不该能让界面去访问外网
    expect(sanitizeAccount({ ...valid, avatar: 'https://evil.example/a.png' })?.avatar).toBeNull()
    expect(sanitizeAccount({ ...valid, avatar: 'data:text/html,<script>' })?.avatar).toBeNull()
    expect(sanitizeAccount({ ...valid, avatar: undefined })?.avatar).toBeNull()
    expect(sanitizeAccount({ ...valid, avatar: 'data:image/webp;base64,AA' })?.avatar).toBe(
      'data:image/webp;base64,AA'
    )
  })

  it('id 缺失时落成空串而不是 undefined', () => {
    expect(sanitizeAccount({ ...valid, id: undefined })?.id).toBe('')
  })
})

describe('accountLabel', () => {
  it('优先用昵称，没填就用登录名', () => {
    expect(
      accountLabel({ provider: 'gitee', id: '1', login: 'muyian', name: '木言', avatar: null })
    ).toBe('木言')
    expect(
      accountLabel({ provider: 'gitee', id: '1', login: 'muyian', name: null, avatar: null })
    ).toBe('muyian')
  })
})

describe('AUTH_PROVIDERS', () => {
  it('只有两家，顺序固定（界面按钮按它渲染）', () => {
    expect(AUTH_PROVIDERS).toEqual(['github', 'gitee'])
  })
})
