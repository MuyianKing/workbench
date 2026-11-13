/**
 * 清洗提示词的测试：它是清洗质量的全部，这里钉住的是**结构性的东西** ——
 * 待处理清单要带全、条目格式契约要在、几条禁令（命令 / 脚本 / git / 生成物 / raw 只读）要在。
 * 措辞本身开发期随时会改，不逐句断言。
 */
import { describe, expect, it } from 'vitest'
import { kbCleanPrompt, splitCleanWrites } from './kb-clean'

const FULL = kbCleanPrompt({
  pending: [
    { rel: 'raw/mu-ui/button.md', abs: 'E:/kb/raw/mu-ui/button.md', hash: 'aaa111' },
    { rel: 'raw/mu-ui/input.md', abs: 'E:/kb/raw/mu-ui/input.md', hash: 'bbb222' },
  ],
  stale: [{ rel: 'raw/mu-ui/dialog.md', abs: 'E:/kb/raw/mu-ui/dialog.md', hash: 'ccc333' }],
  today: '2026-09-29',
})

describe('kbCleanPrompt', () => {
  it('带全待处理清单：两组各给计数，文件一个个列出', () => {
    expect(FULL).toContain('未入库（2 个')
    expect(FULL).toContain('有更新（1 个')
    expect(FULL).toContain('- raw/mu-ui/button.md')
    expect(FULL).toContain('- raw/mu-ui/input.md')
    expect(FULL).toContain('- raw/mu-ui/dialog.md')
  })

  it('真实路径与内容指纹一起给出来；指纹缺了就只给路径', () => {
    expect(FULL).toContain('实际文件：E:/kb/raw/mu-ui/button.md')
    expect(FULL).toContain('内容指纹：aaa111')

    const target = kbCleanPrompt({
      pending: [{ rel: 'raw/a.md', abs: 'E:/kb/raw/a.md', hash: '' }],
      stale: [],
      today: '2026-09-29',
    })
    expect(target).toContain('- raw/a.md（实际文件：E:/kb/raw/a.md）')
    expect(target).not.toContain('内容指纹：')

    const bare = kbCleanPrompt({
      pending: [{ rel: 'raw/a.md', abs: '', hash: '' }],
      stale: [],
      today: '2026-09-29',
    })
    expect(bare).toContain('- raw/a.md\n')
  })

  it('带条目格式契约：八样字段、status 取值、source / source_hash 填法与落位规则', () => {
    for (const key of ['title:', 'tags:', 'created:', 'updated:', 'source:', 'source_hash:', 'status:', 'summary:']) {
      expect(FULL).toContain(key)
    }
    expect(FULL).toContain('reviewed')
    expect(FULL).toContain('今天是 2026-09-29')
    expect(FULL).toContain('NN-主题名')
    expect(FULL).toContain('同一个 source')
    // source 写逻辑路径 raw/…，条目写到同名的 data/<知识库名>/ 下
    expect(FULL).toContain('data/<知识库名>/')
    // 指纹是下一轮判「有更新」的依据，必须照抄
    expect(FULL).toContain('同一个 source_hash')
  })

  it('带做法与分工：完全访问不设命令禁令，git 归应用、仓库不留杂物、生成物不碰', () => {
    expect(FULL).toContain('完全访问')
    expect(FULL).toContain('git 提交 / 推送不用做')
    expect(FULL).toContain('data/_catalog.md')
    expect(FULL).toContain('data/index.json')
  })

  it('读文件用「实际文件」那个绝对路径；raw 层只读、产出只落 data/', () => {
    expect(FULL).toContain('读文件一律用清单里「实际文件」那个绝对路径')
    expect(FULL).toContain('raw/ 里的文件是用户上传的原文')
    expect(FULL).toContain('只写进 data/')
  })

  it('要求条目之间用相对链接互链（条目互链是检索的前提）', () => {
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
  const BEFORE = ['data/mu-ui/01-主题/button.md', 'data/mu-ui/02-其他/old.md']

  it('在旧清单里的算覆盖、不在的算新建，写出来的相对路径原样保留', () => {
    expect(
      splitCleanWrites('E:\\kb-root', ['data/mu-ui/01-主题/button.md', 'data/mu-ui/01-主题/新条目.md'], BEFORE),
    ).toEqual({ created: ['data/mu-ui/01-主题/新条目.md'], updated: ['data/mu-ui/01-主题/button.md'] })
  })

  it('绝对路径剥掉根前缀；反斜杠也认', () => {
    expect(
      splitCleanWrites('E:\\kb-root', ['E:\\kb-root\\data\\mu-ui\\01-主题\\button.md'], BEFORE),
    ).toEqual({ created: [], updated: ['data/mu-ui/01-主题/button.md'] })
  })

  it('大小写不同也算同一份（Windows 的文件名不分大小写）', () => {
    expect(splitCleanWrites('E:\\kb-root', ['data/mu-ui/01-主题/Button.md'], BEFORE)).toEqual({
      created: [],
      updated: ['data/mu-ui/01-主题/button.md'],
    })
  })

  it('data/ 之外的、非 .md 的、生成物 _catalog.md、遗留的 data/raw/ 都不进收据', () => {
    expect(
      splitCleanWrites(
        'E:\\kb-root',
        ['raw/mu-ui/x.md', 'data/raw/遗留.md', 'data/mu-ui/01-主题/a.txt', 'data/_catalog.md', 'notes.md', ''],
        BEFORE,
      ),
    ).toEqual({ created: [], updated: [] })
  })

  it('重复报同一份只算一次，两份清单各自按路径排', () => {
    expect(
      splitCleanWrites('E:\\kb-root', ['data/mu-ui/02-其他/b.md', 'data/mu-ui/02-其他/b.md', 'data/mu-ui/02-其他/a.md'], []),
    ).toEqual({ created: ['data/mu-ui/02-其他/a.md', 'data/mu-ui/02-其他/b.md'], updated: [] })
  })
})
