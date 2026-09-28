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
  kbOrganizeInstruction,
  kbRawFiles,
  kbStats,
  kbTagCounts,
  matchKbRawStatus,
  normalizeKbSource,
  parseKbFrontmatter,
  parseKbIndex,
  type KbEntryMeta,
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

describe('统计与指令', () => {
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

  it('整理指令带得上待处理计数，一个都没有时也明说', () => {
    const withWork = kbOrganizeInstruction(3, 1)
    expect(withWork).toContain('3 个未入库')
    expect(withWork).toContain('1 个有更新')
    expect(withWork).toContain('py scripts/build_index.py')

    const idle = kbOrganizeInstruction(0, 0)
    expect(idle).toContain('当前没有待处理的原始数据')
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
