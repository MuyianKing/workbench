/**
 * 知识库纯逻辑的测试。
 *
 * 重点全在「状态判定」上（这是这一页的核心口径）：frontmatter 怎么认、source 的两种写法
 * 怎么配对、mtime 怎么比。清单拆分与统计是几行 filter，抽查即可；解析失败一律回空值
 * 而不是报错 —— 这个「不是错误」的口径本身也要测到。
 */
import { describe, expect, it } from 'vitest'
import {
  KB_DIR,
  KB_RAW_DIR,
  compareKbRel,
  kbEntryFiles,
  kbEntryTree,
  kbFolderChain,
  kbRawFiles,
  kbRawStatusText,
  kbRawTree,
  kbRawViewKind,
  kbStats,
  kbTagCounts,
  kbTreeFolderIds,
  matchKbRawStatus,
  normalizeKbSource,
  parseKbFrontmatter,
  parseKbIndex,
  type KbEntryMeta,
  type KbRawItem,
  type KbRawStatus,
  type KbScanEntry
} from './kb'

/** 造一条扫描清单：rel 之外都有说得过去的默认值 */
function entry(rel: string, mtimeMs = 1000, isDir = false): KbScanEntry {
  return { rel, name: rel.split('/').pop() ?? rel, isDir, mtimeMs }
}

/** 造一条条目元数据：title 之外都有默认值 */
function meta(partial: Partial<KbEntryMeta>): KbEntryMeta {
  return {
    rel: `${KB_DIR}/x.md`,
    title: '某条目',
    tags: [],
    status: 'reviewed',
    created: '2026-09-28',
    updated: '2026-09-28',
    summary: '',
    source: '',
    links: [],
    mtimeMs: 1000,
    ...partial
  }
}

describe('parseKbFrontmatter', () => {
  it('认七样字段，tags 认列表写法，引号剥一层', () => {
    const text = [
      '---',
      'title: "MuButton（mu-button）"',
      "tags: [mu-ui, 组件, '按钮']",
      'status: reviewed',
      'created: 2026-09-28',
      'updated: 2026-09-28',
      'summary: 通用按钮组件',
      'source: data/raw/mu-ui/button.md',
      '---',
      '',
      '# MuButton（mu-button）'
    ].join('\n')

    const meta = parseKbFrontmatter(text)
    expect(meta.title).toBe('MuButton（mu-button）')
    expect(meta.tags).toEqual(['mu-ui', '组件', '按钮'])
    expect(meta.status).toBe('reviewed')
    expect(meta.created).toBe('2026-09-28')
    expect(meta.updated).toBe('2026-09-28')
    expect(meta.summary).toBe('通用按钮组件')
    expect(meta.source).toBe('data/raw/mu-ui/button.md')
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

  it('BOM 不挡解析，tags 认单个裸标量，不认识的键不碰', () => {
    const meta = parseKbFrontmatter('\uFEFF---\ntags: 部署\nalias: 别名\n---\n正文')
    expect(meta.tags).toEqual(['部署'])
    expect(meta.title).toBe('')
  })
})

describe('normalizeKbSource', () => {
  it('统一分隔符、去掉 ./ 与首尾空白', () => {
    expect(normalizeKbSource(' data\\raw\\mu-ui\\button.md ')).toBe('data/raw/mu-ui/button.md')
    expect(normalizeKbSource('./data/raw/x.md')).toBe('data/raw/x.md')
    expect(normalizeKbSource('\uFEFFdata/raw/x.md')).toBe('data/raw/x.md')
  })

  it('非 string 回空串；链接之类的值原样留着（配不上就参与不了判定）', () => {
    expect(normalizeKbSource(42)).toBe('')
    expect(normalizeKbSource('https://example.com/a')).toBe('https://example.com/a')
  })
})

describe('清单拆分', () => {
  it('条目只认 kb/ 下的 .md，_catalog.md 不算；原始数据认 data/raw/ 下任意后缀', () => {
    const scan = [
      entry('README.md'),
      entry(KB_DIR, 0, true),
      entry(`${KB_DIR}/_catalog.md`),
      entry(`${KB_DIR}/button.md`),
      entry(`${KB_DIR}/草图.png`),
      entry(KB_RAW_DIR, 0, true),
      entry(`${KB_RAW_DIR}/mu-ui/button.md`),
      entry(`${KB_RAW_DIR}/手册.pdf`)
    ]
    expect(kbEntryFiles(scan).map((item) => item.rel)).toEqual([`${KB_DIR}/button.md`])
    expect(kbRawFiles(scan).map((item) => item.rel)).toEqual([
      `${KB_RAW_DIR}/mu-ui/button.md`,
      `${KB_RAW_DIR}/手册.pdf`
    ])
  })

  it('compareKbRel 按中文与数字排', () => {
    const items = [entry('kb/第10篇.md'), entry('kb/第2篇.md'), entry('kb/按钮.md')]
    expect([...items].sort(compareKbRel).map((item) => item.rel)).toEqual([
      'kb/按钮.md',
      'kb/第2篇.md',
      'kb/第10篇.md'
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
    const entries = [meta({ rel: `${KB_DIR}/button.md`, source: `${KB_RAW_DIR}/button.md`, mtimeMs: 2000 })]
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/button.md`, 3000)], entries)[0].status).toBe('stale')
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/button.md`, 2000)], entries)[0].status).toBe('synced')
    expect(matchKbRawStatus([entry(`${KB_RAW_DIR}/button.md`, 1000)], entries)[0].status).toBe('synced')
  })

  it('source 不带 data/raw/ 前缀也认；大小写不敏感；反斜杠归一', () => {
    const entries = [meta({ rel: `${KB_DIR}/b.md`, source: 'mu-ui\\Button.md', mtimeMs: 2000 })]
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/Mu-UI/button.md`, 1000)], entries)
    expect(items[0].status).toBe('synced')
    expect(items[0].entryRels).toEqual([`${KB_DIR}/b.md`])
  })

  it('一拆多时取最新的那份条目比；entryRels 按修改时间新的在前', () => {
    const entries = [
      meta({ rel: `${KB_DIR}/旧.md`, source: `${KB_RAW_DIR}/a.md`, mtimeMs: 1500 }),
      meta({ rel: `${KB_DIR}/新.md`, source: `${KB_RAW_DIR}/a.md`, mtimeMs: 4000 })
    ]
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/a.md`, 3000)], entries)
    // 最新的条目（4000）比原始文件（3000）新，所以已入库
    expect(items[0].status).toBe('synced')
    expect(items[0].entryRels).toEqual([`${KB_DIR}/新.md`, `${KB_DIR}/旧.md`])
  })

  it('source 是链接之类的值时参与不了判定，条目不算丢', () => {
    const entries = [meta({ rel: `${KB_DIR}/外链.md`, source: 'https://example.com/a' })]
    const items = matchKbRawStatus([entry(`${KB_RAW_DIR}/a.md`)], entries)
    expect(items[0].status).toBe('pending')
  })
})

describe('统计', () => {
  it('kbStats 数对四样', () => {
    const entries = [meta({ status: 'draft' }), meta({ status: 'reviewed' })]
    const raw = matchKbRawStatus(
      [entry(`${KB_RAW_DIR}/a.md`, 9000), entry(`${KB_RAW_DIR}/b.md`, 3000), entry(`${KB_RAW_DIR}/c.md`)],
      [meta({ source: `${KB_RAW_DIR}/b.md`, mtimeMs: 1000 })]
    )
    const stats = kbStats(entries, raw)
    expect(stats).toEqual({ entries: 2, drafts: 1, raws: 3, pending: 2, stale: 1 })
  })

  it('kbTagCounts 按数量降序、同数按名字', () => {
    const counts = kbTagCounts([
      meta({ tags: ['组件', 'mu-ui'] }),
      meta({ tags: ['组件'] }),
      meta({ tags: ['部署'] })
    ])
    expect(counts).toEqual([
      { tag: '组件', count: 2 },
      { tag: '部署', count: 1 },
      { tag: 'mu-ui', count: 1 }
    ])
  })
})

describe('parseKbIndex', () => {
  it('认 generated_at 与 count 两样', () => {
    expect(parseKbIndex('{"generated_at":"2026-09-28","count":50}')).toEqual({
      generatedAt: '2026-09-28',
      count: 50
    })
  })

  it('认不出的形状一律回 null：缺失、写坏、不是这份脚本生成的', () => {
    expect(parseKbIndex('{"count":50}')).toBeNull()
    expect(parseKbIndex('not json')).toBeNull()
    expect(parseKbIndex('[]')).toBeNull()
    expect(parseKbIndex('{"generated_at":"2026-09-28"}')).toBeNull()
  })
})

describe('kbEntryTree', () => {
  it('按目录结构收成树：目录一层层往下，条目挂在所在目录上', () => {
    const tree = kbEntryTree([
      meta({ rel: 'kb/01-组件库/add-button.md', title: 'MuAddButton' }),
      meta({ rel: 'kb/00-规范/条目格式.md', title: '条目格式规范' }),
      meta({ rel: 'kb/01-组件库/嵌套/button.md', title: 'MuButton' })
    ])

    expect(tree.map((node) => node.id)).toEqual(['00-规范', '01-组件库'])
    expect(tree[0].children[0]).toMatchObject({ id: 'kb/00-规范/条目格式.md', name: '条目格式规范' })
    const nested = tree[1].children
    expect(nested.map((node) => node.id)).toEqual(['01-组件库/嵌套', 'kb/01-组件库/add-button.md'])
    expect(nested[0].children[0]).toMatchObject({ id: 'kb/01-组件库/嵌套/button.md', kind: 'entry' })
  })

  it('目录排在条目前面、同层按名字；条目节点带上 status', () => {
    const tree = kbEntryTree([
      meta({ rel: 'kb/库/b.md', title: '乙', status: 'draft' }),
      meta({ rel: 'kb/库/a.md', title: '甲' }),
      meta({ rel: 'kb/库.md', title: '单文件' })
    ])

    const folder = tree[0]
    expect(folder.kind).toBe('folder')
    expect(folder.children.map((node) => node.name)).toEqual(['甲', '乙'])
    expect(folder.children[1].status).toBe('draft')
    expect(tree[1]).toMatchObject({ id: 'kb/库.md', kind: 'entry' })
  })

  it('空清单回空树；条目直接在 kb 最外层时就是顶层条目', () => {
    expect(kbEntryTree([])).toEqual([])
    const tree = kbEntryTree([meta({ rel: 'kb/README.md', title: '说明' })])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ id: 'kb/README.md', kind: 'entry' })
  })
})

describe('kbTreeFolderIds / kbFolderChain', () => {
  it('folderIds 只收目录、逐层都算；chain 从最外层排下来、不含条目自己', () => {
    const tree = kbEntryTree([
      meta({ rel: 'kb/01-组件库/嵌套/button.md', title: 'MuButton' }),
      meta({ rel: 'kb/00-规范/条目格式.md', title: '条目格式规范' })
    ])

    expect(kbTreeFolderIds(tree)).toEqual(['00-规范', '01-组件库', '01-组件库/嵌套'])
    expect(kbFolderChain('kb/01-组件库/嵌套/button.md')).toEqual(['01-组件库', '01-组件库/嵌套'])
    // 最外层的条目没有上一级可展开
    expect(kbFolderChain('kb/README.md')).toEqual([])
  })
})

describe('kbRawTree', () => {
  /** 造一条原始数据：rel 之外都有默认值 */
  function raw(rel: string, status: KbRawStatus = 'synced'): KbRawItem {
    return { rel, name: rel.split('/').pop() ?? rel, ext: 'md', mtimeMs: 1000, status, entryRels: [] }
  }

  it('按目录结构收成树，文件节点带上 item；目录在前、同层按名字', () => {
    const tree = kbRawTree([
      raw('data/raw/mu-ui/button.md'),
      raw('data/raw/随手记.md', 'pending'),
      raw('data/raw/mu-ui/子目录/avatar.md', 'stale')
    ])

    expect(tree.map((node) => node.id)).toEqual(['mu-ui', 'data/raw/随手记.md'])
    const folder = tree[0]
    expect(folder.children.map((node) => node.id)).toEqual([
      'mu-ui/子目录',
      'data/raw/mu-ui/button.md'
    ])
    expect(folder.children[1].item).toMatchObject({ status: 'synced' })
    expect(folder.children[0].children[0]).toMatchObject({ kind: 'file', name: 'avatar.md' })
  })

  it('空清单回空树', () => {
    expect(kbRawTree([])).toEqual([])
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

  it('状态词三种都有', () => {
    expect(kbRawStatusText('pending')).toBe('未入库')
    expect(kbRawStatusText('stale')).toBe('有更新')
    expect(kbRawStatusText('synced')).toBe('已入库')
  })
})
