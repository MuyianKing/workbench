/**
 * 清洗提示词的测试：它是清洗质量的全部，这里钉住的是**结构性的东西** ——
 * 待处理清单要带全、条目格式契约要在、几条禁令（命令 / 脚本 / git / 生成物）要在。
 * 措辞本身开发期随时会改，不逐句断言。
 */
import { describe, expect, it } from 'vitest'
import { kbCleanPrompt, splitCleanWrites } from './kb-clean'

const FULL = kbCleanPrompt({
  pending: ['data/raw/mu-ui/button.md', 'data/raw/mu-ui/input.md'],
  stale: ['data/raw/mu-ui/dialog.md'],
  today: '2026-09-29',
})

describe('kbCleanPrompt', () => {
  it('带全待处理清单：两组各给计数，文件一个个列出', () => {
    expect(FULL).toContain('未入库（2 个')
    expect(FULL).toContain('有更新（1 个')
    expect(FULL).toContain('- data/raw/mu-ui/button.md')
    expect(FULL).toContain('- data/raw/mu-ui/input.md')
    expect(FULL).toContain('- data/raw/mu-ui/dialog.md')
  })

  it('带条目格式契约：七样字段、status 取值、source 填法与主题目录命名', () => {
    for (const key of ['title:', 'tags:', 'created:', 'updated:', 'source:', 'status:', 'summary:']) {
      expect(FULL).toContain(key)
    }
    expect(FULL).toContain('reviewed')
    expect(FULL).toContain('今天是 2026-09-29')
    expect(FULL).toContain('NN-主题名')
    expect(FULL).toContain('同一个 source')
  })

  it('带做法与分工：完全访问不设命令禁令，git 归应用、仓库不留杂物、生成物不碰', () => {
    expect(FULL).toContain('完全访问')
    expect(FULL).toContain('git 提交 / 推送不用做')
    expect(FULL).toContain('kb/_catalog.md')
    expect(FULL).toContain('index/index.json')
  })

  it('要求条目之间用相对链接互链（库内互链是巡检与站内跳转的前提）', () => {
    expect(FULL).toContain('相对链接')
    expect(FULL).toContain('[[双链]]')
  })

  it('待处理为空时明说（两个组都在，不给空列表）', () => {
    const idle = kbCleanPrompt({ pending: [], stale: [], today: '2026-09-29' })
    expect(idle).toContain('未入库：没有')
    expect(idle).toContain('有更新：没有')
  })
})

describe('splitCleanWrites', () => {
  const BEFORE = ['kb/01-主题/button.md', 'kb/02-其他/old.md']

  it('在旧清单里的算覆盖、不在的算新建，写出来的相对路径原样保留', () => {
    expect(
      splitCleanWrites('E:\\kb-root', ['kb/01-主题/button.md', 'kb/01-主题/新条目.md'], BEFORE),
    ).toEqual({ created: ['kb/01-主题/新条目.md'], updated: ['kb/01-主题/button.md'] })
  })

  it('绝对路径剥掉根前缀；反斜杠也认', () => {
    expect(
      splitCleanWrites('E:\\kb-root', ['E:\\kb-root\\kb\\01-主题\\button.md'], BEFORE),
    ).toEqual({ created: [], updated: ['kb/01-主题/button.md'] })
  })

  it('大小写不同也算同一份（Windows 的文件名不分大小写）', () => {
    expect(splitCleanWrites('E:\\kb-root', ['kb/01-主题/Button.md'], BEFORE)).toEqual({
      created: [],
      updated: ['kb/01-主题/button.md'],
    })
  })

  it('kb/ 之外的、非 .md 的、生成物 _catalog.md 都不进收据', () => {
    expect(
      splitCleanWrites(
        'E:\\kb-root',
        ['data/raw/x.md', 'kb/01-主题/a.txt', 'kb/_catalog.md', 'notes.md', ''],
        BEFORE,
      ),
    ).toEqual({ created: [], updated: [] })
  })

  it('重复报同一份只算一次，两份清单各自按路径排', () => {
    expect(
      splitCleanWrites('E:\\kb-root', ['kb/02-其他/b.md', 'kb/02-其他/b.md', 'kb/02-其他/a.md'], []),
    ).toEqual({ created: ['kb/02-其他/a.md', 'kb/02-其他/b.md'], updated: [] })
  })
})
