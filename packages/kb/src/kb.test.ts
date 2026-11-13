import type { KbEntryMeta, KbLocalFile, KbRawItem, KbRawStatus, KbScanEntry } from './kb'
/**
 * 知识库纯逻辑的测试。
 *
 * 重点全在「状态判定」上（这是这一页的核心口径）：frontmatter 怎么认、source 的两种写法
 * 怎么配对、mtime 怎么比。清单拆分、清单文件与统计是几行代码，抽查即可；解析失败一律回
 * 空值而不是报错 —— 这个「不是错误」的口径本身也要测到。
 */
import { describe, expect, it } from 'vitest'
import { compareKbRel, isInsideKbRoot, KB_DATA_DIR, KB_MANIFEST_REL, KB_RAW_DIR, kbDanglingGroups, kbEntryFiles, kbLibraryRows, kbRawDisplayPath, kbRawFiles, kbRawReferencedRels, kbRawSourceNameOf, kbRawStatusText, kbRawTree, kbRawViewKind, kbSourceLinkKey, kbSourceLinksFor, kbSourceNameHint, kbSourceRef, kbStats, kbTreeFolderIds, matchKbRawStatus, normalizeKbSource, parseKbFrontmatter, parseKbIndex, parseKbManifest, sanitizeKbName, sanitizeKbSourceLinks, serializeKbManifest } from './kb'

/** 造一条扫描清单：rel 之外都有说得过去的默认值 */
function entry(rel: string, mtimeMs = 1000, isDir = false): KbScanEntry {
  return { rel, name: rel.split('/').pop() ?? rel, isDir, mtimeMs }
}

/** 造一条条目元数据：title 之外都有默认值 */
function meta(partial: Partial<KbEntryMeta>): KbEntryMeta {
  return {
    rel: `${KB_DATA_DIR}/x.md`,
    title: '某条目',
    tags: [],
    status: 'reviewed',
    created: '2026-09-28',
    updated: '2026-09-28',
    summary: '',
    source: '',
    sourceHash: '',
    mtimeMs: 1000,
    ...partial,
  }
}

describe('parseKbFrontmatter', () => {
  it('认八样字段，tags 认列表写法，引号剥一层', () => {
    const text = [
      '---',
      'title: "MuButton（mu-button）"',
      'tags: [mu-ui, 组件, \'按钮\']',
      'status: reviewed',
      'created: 2026-09-28',
      'updated: 2026-09-28',
      'summary: 通用按钮组件',
      'source: raw/mu-ui/button.md',
      'source_hash: abc123',
      '---',
      '',
      '# MuButton（mu-button）',
    ].join('\n')

    const meta = parseKbFrontmatter(text)
    expect(meta.title).toBe('MuButton（mu-button）')
    expect(meta.tags).toEqual(['mu-ui', '组件', '按钮'])
    expect(meta.status).toBe('reviewed')
    expect(meta.created).toBe('2026-09-28')
    expect(meta.updated).toBe('2026-09-28')
    expect(meta.summary).toBe('通用按钮组件')
    expect(meta.source).toBe('raw/mu-ui/button.md')
    expect(meta.sourceHash).toBe('abc123')
  })

  it('没有 frontmatter / 空串 / 非 string 都回全空，不是错误', () => {
    for (const text of ['# 只有正文', '', 'title: 没有 --- 围栏']) {
      const meta = parseKbFrontmatter(text)
      expect(meta.title).toBe('')
      expect(meta.tags).toEqual([])
      expect(meta.source).toBe('')
    }
    // @ts-expect-error 故意喂错类型，兜底口径要稳
    expect(parseKbFrontmatter(null).title).toBe('')
  })

  it('bOM 不挡解析，tags 认单个裸标量，不认识的键不碰', () => {
    const meta = parseKbFrontmatter('\uFEFF---\ntags: 部署\nalias: 别名\n---\n正文')
    expect(meta.tags).toEqual(['部署'])
    expect(meta.title).toBe('')
  })
})

describe('normalizeKbSource', () => {
  it('统一分隔符、去掉 ./ 与首尾空白', () => {
    expect(normalizeKbSource(' raw\\mu-ui\\button.md ')).toBe('raw/mu-ui/button.md')
    expect(normalizeKbSource('./raw/x.md')).toBe('raw/x.md')
    expect(normalizeKbSource('\uFEFFraw/x.md')).toBe('raw/x.md')
  })

  it('非 string 回空串；链接之类的值原样留着（配不上就参与不了判定）', () => {
    expect(normalizeKbSource(42)).toBe('')
    expect(normalizeKbSource('https://example.com/a')).toBe('https://example.com/a')
  })
})

describe('清单拆分', () => {
  it('条目只认 data/ 下的 .md，_catalog.md 与遗留的 data/raw/ 不算；原始数据认 raw/ 下任意后缀，清单文件不算', () => {
    const scan = [
      entry('README.md'),
      entry(KB_DATA_DIR, 0, true),
      entry(`${KB_DATA_DIR}/_catalog.md`),
      entry(`${KB_DATA_DIR}/mu-ui/button.md`),
      entry(`${KB_DATA_DIR}/mu-ui/草图.png`),
      entry(`${KB_DATA_DIR}/raw/遗留/button.md`),
      entry(KB_RAW_DIR, 0, true),
      entry(`${KB_RAW_DIR}/mu-ui/button.md`),
      entry(`${KB_RAW_DIR}/手册.pdf`),
      entry(`${KB_MANIFEST_REL}`),
    ]
    expect(kbEntryFiles(scan).map(item => item.rel)).toEqual([`${KB_DATA_DIR}/mu-ui/button.md`])
    expect(kbRawFiles(scan).map(item => item.rel)).toEqual([
      `${KB_RAW_DIR}/mu-ui/button.md`,
      `${KB_RAW_DIR}/手册.pdf`,
    ])
  })

  it('compareKbRel 按中文与数字排', () => {
    const items = [entry('data/第10篇.md'), entry('data/第2篇.md'), entry('data/按钮.md')]
    expect([...items].sort(compareKbRel).map(item => item.rel)).toEqual([
      'data/按钮.md',
      'data/第2篇.md',
      'data/第10篇.md',
    ])
  })
})

describe('matchKbRawStatus', () => {
  it('没有条目指向 = 未入库', () => {
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/新的.md`, 5000)], [])
    expect(items[0].status).toBe('pending')
    expect(items[0].entryRels).toEqual([])
  })

  it('原始文件比条目新 = 有更新；条目更新（或同刻）= 已入库', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/button.md`, source: `${KB_RAW_DIR}/mu-ui/button.md`, mtimeMs: 2000 })]
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/button.md`, 3000)], entries)[0].status).toBe('stale')
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/button.md`, 2000)], entries)[0].status).toBe('synced')
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/button.md`, 1000)], entries)[0].status).toBe('synced')
  })

  it('source 不带 raw/ 前缀也认；内层路径大小写不敏感；反斜杠归一', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/b.md`, source: 'mu-ui\\Button.md', mtimeMs: 2000 })]
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/button.md`, 1000)], entries)
    expect(items[0].status).toBe('synced')
    expect(items[0].entryRels).toEqual([`${KB_DATA_DIR}/b.md`])
  })

  it('知识库名大小写敏感：Mu-UI 与 mu-ui 是两个知识库，配不上', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/b.md`, source: `${KB_RAW_DIR}/Mu-UI/button.md`, mtimeMs: 2000 })]
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/button.md`, 1000)], entries)[0].status).toBe('pending')
  })

  it('一拆多时取最新的那份条目比；entryRels 按修改时间新的在前', () => {
    const entries = [
      meta({ rel: `${KB_DATA_DIR}/旧.md`, source: `${KB_RAW_DIR}/mu-ui/a.md`, mtimeMs: 1500 }),
      meta({ rel: `${KB_DATA_DIR}/新.md`, source: `${KB_RAW_DIR}/mu-ui/a.md`, mtimeMs: 4000 }),
    ]
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/a.md`, 3000)], entries)
    // 最新的条目（4000）比原始文件（3000）新，所以已入库
    expect(items[0].status).toBe('synced')
    expect(items[0].entryRels).toEqual([`${KB_DATA_DIR}/新.md`, `${KB_DATA_DIR}/旧.md`])
  })

  it('source 是链接之类的值时参与不了判定，条目不算丢', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/外链.md`, source: 'https://example.com/a' })]
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/a.md`)], entries)
    expect(items[0].status).toBe('pending')
  })
})

describe('统计', () => {
  it('kbStats 数对四样', () => {
    const raw = matchKbRawStatus(
      [
        entry(`${KB_RAW_DIR}/mu-ui/a.md`, 9000),
        entry(`${KB_RAW_DIR}/mu-ui/b.md`, 3000),
        entry(`${KB_RAW_DIR}/mu-ui/c.md`),
      ],
      [meta({ source: `${KB_RAW_DIR}/mu-ui/b.md`, mtimeMs: 1000 })],
    )
    const stats = kbStats([meta({}), meta({})], raw)
    expect(stats).toEqual({ entries: 2, raws: 3, pending: 2, stale: 1 })
  })
})

describe('parseKbIndex', () => {
  it('认 generated_at 与 count 两样', () => {
    expect(parseKbIndex('{"generated_at":"2026-09-28","count":50}')).toEqual({
      generatedAt: '2026-09-28',
      count: 50,
    })
  })

  it('认不出的形状一律回 null：缺失、写坏、不是这份脚本生成的', () => {
    expect(parseKbIndex('{"count":50}')).toBeNull()
    expect(parseKbIndex('not json')).toBeNull()
    expect(parseKbIndex('[]')).toBeNull()
    expect(parseKbIndex('{"generated_at":"2026-09-28"}')).toBeNull()
  })
})

describe('清单（raw/kb.json）', () => {
  it('parse：认 kbs 数组，收敛名字、去重（忽略大小写）；认不出回 null 不是错误', () => {
    expect(parseKbManifest('{"version":1,"kbs":[{"name":"mu-ui","created":"2026-11-14"},{"name":"日志"}]}'))
      .toEqual([
        { name: 'mu-ui', created: '2026-11-14' },
        { name: '日志', created: '' },
      ])
    // 同名（忽略大小写）去重，保留先出现的；没有名字的条目丢掉
    expect(parseKbManifest('{"kbs":[{"name":"mu-ui"},{"name":"MU-UI"},{"name":""},{"name":"a/b"}]}'))
      .toEqual([{ name: 'mu-ui', created: '' }])
    for (const bad of ['', '   ', 'not json', '[]', '"str"', '{"kbs":"x"}']) {
      expect(parseKbManifest(bad)).toBeNull()
    }
    // 形状对但没有一条有效：回空清单，不是 null（文件在、就是空的）
    expect(parseKbManifest('{"kbs":[1,null]}')).toEqual([])
  })

  it('serialize：产出稳定的 JSON（带 version 与换行），再解析回来一致', () => {
    const text = serializeKbManifest([
      { name: 'mu-ui', created: '2026-11-14' },
      { name: '', created: '' },
      { name: '日志', created: 'x' },
    ])
    expect(text).toBe(`${JSON.stringify({ version: 1, kbs: [{ name: 'mu-ui', created: '2026-11-14' }, { name: '日志', created: 'x' }] }, null, 2)}\n`)
    expect(parseKbManifest(text)).toEqual([
      { name: 'mu-ui', created: '2026-11-14' },
      { name: '日志', created: 'x' },
    ])
  })

  it('清单路径常量在 raw 层', () => {
    expect(KB_MANIFEST_REL).toBe('raw/kb.json')
  })
})

describe('知识库名与关联', () => {
  const KB_ROOT = 'E:\\muyian\\agent'

  it('知识库名：挡分隔符与 ./..，中文、空格与点开头的名字照旧', () => {
    expect(sanitizeKbName('  mu-ui  ')).toBe('mu-ui')
    expect(sanitizeKbName('组件库 v2')).toBe('组件库 v2')
    expect(sanitizeKbName('.hidden')).toBe('.hidden')
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 42, null]) {
      expect(sanitizeKbName(bad as unknown as string)).toBe('')
    }
    expect(sanitizeKbName('x'.repeat(80))).toHaveLength(60)
  })

  it('关联收敛：缺项丢掉、同名去重；同一文件夹只挂一个名字；指到库里的按没配处理', () => {
    const links = sanitizeKbSourceLinks([
      { root: 'E:\\muyian\\agent\\', name: 'mu-ui', dir: 'D:\\work\\mu-ui\\' },
      { root: 'E:/muyian/agent', name: 'mu-ui', dir: 'D:/other' },
      { root: 'E:/muyian/agent', name: '日志', dir: 'd:\\work\\MU-UI' },
      { root: 'E:/muyian/agent', name: 'v2', dir: 'E:/muyian/agent/raw/v2' },
      { root: '', name: '孤儿', dir: 'D:/x' },
      { root: 'E:/muyian/agent', name: 'a/b', dir: 'D:/x' },
      'not an object',
    ])

    expect(links).toEqual([
      { root: 'E:\\muyian\\agent', name: 'mu-ui', dir: 'D:\\work\\mu-ui' },
      { root: 'E:/muyian/agent', name: '日志', dir: '' },
      { root: 'E:/muyian/agent', name: 'v2', dir: '' },
    ])
  })

  it('不是数组 / 空数组都回空清单', () => {
    expect(sanitizeKbSourceLinks(null)).toEqual([])
    expect(sanitizeKbSourceLinks([])).toEqual([])
  })

  it('isInsideKbRoot：等于知识库文件夹或在它下面都算「库里的」', () => {
    expect(isInsideKbRoot('E:/muyian/agent', KB_ROOT)).toBe(true)
    expect(isInsideKbRoot('E:\\muyian\\agent\\raw\\mu-ui', KB_ROOT)).toBe(true)
    expect(isInsideKbRoot('E:/muyian/agent2', KB_ROOT)).toBe(false)
    expect(isInsideKbRoot('D:/work', KB_ROOT)).toBe(false)
  })

  it('按知识库根过滤：别的库配的关联不串过来', () => {
    const links = [
      { root: 'E:\\muyian\\agent', name: 'mu-ui', dir: 'D:/work/mu-ui' },
      { root: 'E:/别的库', name: 'mu-ui', dir: 'D:/other' },
    ]
    expect(kbSourceLinksFor(links, 'E:/muyian/agent/')).toEqual([links[0]])
    expect(kbSourceLinksFor(links, '')).toEqual([])
  })

  it('逻辑路径认知识库名：raw 里那份、简写、直接躺在 raw 下的文件', () => {
    expect(kbRawSourceNameOf('raw/mu-ui/button.md')).toBe('mu-ui')
    expect(kbRawSourceNameOf('raw/mu-ui/子目录/a.md')).toBe('mu-ui')
    expect(kbRawSourceNameOf('raw/随手记.md')).toBe('')
    expect(kbRawSourceNameOf('data/mu-ui/a.md')).toBe('')
    // 旧前缀 data/raw/ 不再是原始数据区
    expect(kbRawSourceNameOf('data/raw/mu-ui/button.md')).toBe('')
  })

  it('kbSourceRef：带前缀与简写都拆得开；链接书名拆不开', () => {
    expect(kbSourceRef('raw/mu-ui/a/b.md')).toEqual({ name: 'mu-ui', inner: 'a/b.md' })
    expect(kbSourceRef('mu-ui/a.md')).toEqual({ name: 'mu-ui', inner: 'a.md' })
    expect(kbSourceRef('https://example.com/a')).toBeNull()
    expect(kbSourceRef('raw/mu-ui')).toBeNull()
  })

  it('配对键：条目 source 与 raw 文件 rel 两边相等即配对（内层不敏感）', () => {
    expect(kbSourceLinkKey('raw/mu-ui/a/B.md')).toBe(kbSourceLinkKey('mu-ui/a/b.md'))
    expect(kbSourceLinkKey('raw/mu-ui/a.md')).not.toBe(kbSourceLinkKey('raw/Mu-UI/a.md'))
  })

  it('列表行：清单一条一行，关联补上源头目录，数出未入库 / 有更新 / 已删除', () => {
    const items = matchKbRawStatus(
      [
        entry(`${KB_RAW_DIR}/mu-ui/a.md`, 1000),
        entry(`${KB_RAW_DIR}/mu-ui/b.md`, 9000),
        entry(`${KB_RAW_DIR}/mu-ui/c.md`, 1000),
        entry(`${KB_RAW_DIR}/workbench/d.md`, 1000),
      ],
      [
        meta({ rel: `${KB_DATA_DIR}/a.md`, source: `${KB_RAW_DIR}/mu-ui/a.md`, mtimeMs: 5000 }),
        meta({ rel: `${KB_DATA_DIR}/b.md`, source: `${KB_RAW_DIR}/mu-ui/b.md`, mtimeMs: 500 }),
      ],
    )
    const dangling = [
      { source: 'mu-ui', rel: `${KB_RAW_DIR}/mu-ui/没了.md`, entryRels: [`${KB_DATA_DIR}/old.md`] },
    ]
    const rows = kbLibraryRows(
      [{ name: 'mu-ui', created: '2026-11-14' }, { name: 'workbench', created: '' }],
      [
        { root: 'E:/kb', name: 'mu-ui', dir: 'D:/work/mu-ui' },
        { root: 'E:/kb', name: '别的', dir: 'D:/other' },
      ],
      items,
      dangling,
    )

    expect(rows.map(row => [row.name, row.dir, row.files])).toEqual([
      ['mu-ui', 'D:/work/mu-ui', 3],
      ['workbench', '', 1],
    ])
    expect(rows[0]).toMatchObject({ pending: 1, stale: 1, deleted: 1 })
    expect(rows[1]).toMatchObject({ pending: 1, stale: 0, deleted: 0 })
    // 清单里没有的知识库：条目再多也不占行（列表数据来自清单）
    expect(rows.every(row => row.name !== '别的')).toBe(true)
  })

  it('raw 树：知识库行在最外层（清单一条一行），文件挂在同名目录下', () => {
    const tree = kbRawTree(
      [
        rawItem('raw/mu-ui/button.md'),
        rawItem('raw/mu-ui/子目录/avatar.md', 'stale'),
      ],
      [
        { name: 'mu-ui', dir: 'D:/work/mu-ui', files: 2, pending: 0, stale: 1, deleted: 0 },
        { name: '空库', dir: '', files: 0, pending: 0, stale: 0, deleted: 0 },
      ],
    )

    expect(tree.map(node => node.id)).toEqual(['空库', 'mu-ui'])
    expect(tree[1].children.map(node => node.id)).toEqual(['mu-ui/子目录', 'raw/mu-ui/button.md'])
    expect(tree[1].children[0].children[0]).toMatchObject({ kind: 'file', name: 'avatar.md' })
    expect(tree[1].library).toMatchObject({ dir: 'D:/work/mu-ui' })
    expect(tree[0].library).toMatchObject({ files: 0 })
  })

  it('kbTreeFolderIds 只收目录、逐层都算；空清单回空树', () => {
    const tree = kbRawTree([rawItem('raw/mu-ui/嵌套/button.md')], [{ name: 'mu-ui', dir: '', files: 1, pending: 0, stale: 0, deleted: 0 }])
    expect(kbTreeFolderIds(tree)).toEqual(['mu-ui', 'mu-ui/嵌套'])
    expect(kbRawTree([])).toEqual([])
  })
})

describe('失联条目', () => {
  it('来源名在清单里、文件不在扫描清单：失联组按 raw 文件分组（每个文件一组）', () => {
    const entries = [
      meta({ rel: `${KB_DATA_DIR}/01-主题/a.md`, source: `${KB_RAW_DIR}/mu-ui/a.md` }),
      meta({ rel: `${KB_DATA_DIR}/01-主题/a2.md`, source: `${KB_RAW_DIR}/mu-ui/a.md` }),
      meta({ rel: `${KB_DATA_DIR}/01-主题/b.md`, source: 'mu-ui/b.md' }),
      meta({ rel: `${KB_DATA_DIR}/01-主题/在.md`, source: `${KB_RAW_DIR}/mu-ui/在.md` }),
      meta({ rel: `${KB_DATA_DIR}/01-主题/外.md`, source: 'https://example.com/x' }),
    ]
    // 「在.md」还在清单里：不算失联
    const present = matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/在.md`)], entries)

    const groups = kbDanglingGroups(entries, present, ['mu-ui', '别的库'])
    expect(groups.map(group => [group.rel, group.entryRels])).toEqual([
      [`${KB_RAW_DIR}/mu-ui/a.md`, [`${KB_DATA_DIR}/01-主题/a.md`, `${KB_DATA_DIR}/01-主题/a2.md`]],
      [`${KB_RAW_DIR}/mu-ui/b.md`, [`${KB_DATA_DIR}/01-主题/b.md`]],
    ])
  })

  it('知识库名不在清单里：不判定失联（不给删除入口）', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/a.md`, source: `${KB_RAW_DIR}/mu-ui/a.md` })]
    expect(kbDanglingGroups(entries, [], ['别的库'])).toEqual([])
  })

  it('知识库名精确：条目写 Mu-UI、清单里是 mu-ui 不算失联', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/a.md`, source: `${KB_RAW_DIR}/Mu-UI/a.md` })]
    expect(kbDanglingGroups(entries, [], ['mu-ui'])).toEqual([])
  })

  it('文件还在时不算失联', () => {
    const entries = [meta({ rel: `${KB_DATA_DIR}/a.md`, source: `${KB_RAW_DIR}/mu-ui/a.md` })]
    const present = matchKbRawStatus([entry(`${KB_RAW_DIR}/mu-ui/a.md`)], entries)
    expect(kbDanglingGroups(entries, present, ['mu-ui'])).toEqual([])
  })
})

describe('内容指纹', () => {
  it('一致 = 已入库、不同 = 有更新（即使 mtime 没变）；缺哈希回落 mtime', () => {
    const file = entry(`${KB_RAW_DIR}/mu-ui/a.md`, 5000)
    const entryWith = (hash: string, mtimeMs = 1000): KbEntryMeta =>
      meta({ rel: `${KB_DATA_DIR}/a.md`, source: `${KB_RAW_DIR}/mu-ui/a.md`, sourceHash: hash, mtimeMs })

    expect(matchKbRawStatus([file], [entryWith('abc')], { [`${KB_RAW_DIR}/mu-ui/a.md`]: 'abc' })[0].status)
      .toBe('synced')
    expect(matchKbRawStatus([file], [entryWith('abc')], { [`${KB_RAW_DIR}/mu-ui/a.md`]: 'def' })[0].status)
      .toBe('stale')
    // 旧条目没有 source_hash：回落 mtime（原始文件更新 → 有更新）
    expect(matchKbRawStatus([file], [entryWith('')])[0].status).toBe('stale')
    // 这一轮没算出哈希（读不到）：同样回落 mtime
    expect(matchKbRawStatus([file], [entryWith('abc')], {})[0].status).toBe('stale')
    // 只有 mtime 变化、内容一致：仍是已入库
    expect(matchKbRawStatus([{ ...file, mtimeMs: 9000 }], [entryWith('abc')], { [`${KB_RAW_DIR}/mu-ui/a.md`]: 'abc' })[0].status)
      .toBe('synced')
  })

  it('有关联时以本地为准：本地内容变了 = 有更新（raw 副本还旧着也算）；本地缺失回落 raw', () => {
    const file = entry(`${KB_RAW_DIR}/b/b.md`, 5000)
    const entries = [meta({ rel: `${KB_DATA_DIR}/b.md`, source: `${KB_RAW_DIR}/b/b.md`, sourceHash: 'abc', mtimeMs: 1000 })]
    const local = (hash: string): KbLocalFile => ({ name: 'b', rel: 'b.md', mtimeMs: 9000, hash, abs: 'F:/src/b.md' })

    // 本地改了（≠ source_hash）：有更新 —— 即使仓库副本还等于已洗内容
    expect(matchKbRawStatus([file], entries, { [`${KB_RAW_DIR}/b/b.md`]: 'abc' }, [local('def')])[0].status).toBe('stale')
    // 本地 == source_hash：已入库
    expect(matchKbRawStatus([file], entries, {}, [local('abc')])[0].status).toBe('synced')
    // 本地没有这份：回落仓库副本的哈希
    expect(matchKbRawStatus([file], entries, { [`${KB_RAW_DIR}/b/b.md`]: 'abc' }, [])[0].status).toBe('synced')
    // 本地指纹这轮没算出来（空串）：同样回落
    expect(matchKbRawStatus([file], entries, { [`${KB_RAW_DIR}/b/b.md`]: 'abc' }, [local('')])[0].status).toBe('synced')
    // 没条目指向：照旧未入库（本地为准不改变这条）
    expect(matchKbRawStatus([file], [], {}, [local('abc')])[0].status).toBe('pending')
  })

  it('只对有条目指向的文件算指纹；未入库的不参与', () => {
    const files = [
      entry(`${KB_RAW_DIR}/mu-ui/a.md`),
      entry(`${KB_RAW_DIR}/mu-ui/新.md`),
    ]
    const entries = [meta({ source: `${KB_RAW_DIR}/mu-ui/a.md` })]
    expect(kbRawReferencedRels(files, entries)).toEqual([`${KB_RAW_DIR}/mu-ui/a.md`])
  })
})

describe('名称核对（添加知识库时比对清单里已有的名字）', () => {
  it('四条口径：完全一致 / 忽略大小写 / 编辑距离 ≤ 2 / 新知识库', () => {
    const names = ['mu-ui', 'workbench']
    expect(kbSourceNameHint('mu-ui', names)).toEqual({ kind: 'exact', suggestion: 'mu-ui', distance: 0 })
    expect(kbSourceNameHint('Mu-UI', names)).toMatchObject({ kind: 'case', suggestion: 'mu-ui' })
    expect(kbSourceNameHint('mu-u', names)).toMatchObject({ kind: 'close', suggestion: 'mu-ui' })
    expect(kbSourceNameHint('完全不同的名字', names).kind).toBe('new')
    expect(kbSourceNameHint('  ', names).kind).toBe('empty')
    // 清单还是空的时候没有参照
    expect(kbSourceNameHint('mu-ui', []).kind).toBe('new')
  })
})

describe('kbRawViewKind / kbRawStatusText', () => {
  it('md 渲染成正文，认得出的文本后缀按纯文本，其余交出去；没有后缀也交出去', () => {
    expect(kbRawViewKind('button.md')).toBe('markdown')
    expect(kbRawViewKind('notes.markdown')).toBe('markdown')
    expect(kbRawViewKind('随手记.TXT')).toBe('text')
    for (const name of ['data.json', '结果.csv', 'config.yml', 'a.toml', 'b.log', 'c.xml']) {
      expect(kbRawViewKind(name)).toBe('text')
    }
    for (const name of ['资料.pdf', '说明.docx', '截图.png', 'archive.zip', '.gitignore']) {
      expect(kbRawViewKind(name)).toBe('external')
    }
  })

  it('kbRawDisplayPath：剥掉 raw/ 这层，显示 知识库/内层；不是 raw 形状原样返回', () => {
    expect(kbRawDisplayPath('raw/mu-ui/button.md')).toBe('mu-ui/button.md')
    expect(kbRawDisplayPath('raw/mu-ui/子目录/a.md')).toBe('mu-ui/子目录/a.md')
    expect(kbRawDisplayPath('raw/随手记.md')).toBe('随手记.md')
    expect(kbRawDisplayPath('data/mu-ui/a.md')).toBe('data/mu-ui/a.md')
  })

  it('状态词三种都有', () => {
    expect(kbRawStatusText('pending')).toBe('未入库')
    expect(kbRawStatusText('stale')).toBe('有更新')
    expect(kbRawStatusText('synced')).toBe('已入库')
  })
})

/** 造一条原始数据：rel 之外都有默认值 */
function rawItem(rel: string, status: KbRawStatus = 'synced'): KbRawItem {
  return {
    rel,
    name: rel.split('/').pop() ?? rel,
    ext: 'md',
    mtimeMs: 1000,
    abs: `E:/kb/${rel}`,
    status,
    entryRels: [],
  }
}
