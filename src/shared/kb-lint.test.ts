/**
 * 知识库巡检的测试。
 *
 * 巡检是「只报事实」的那一类逻辑：五类问题各自的边界（导航页的链接算不算引用、source
 * 像不像路径、`..` 越出仓库根算不算断链）比实现对错更要紧 —— 报错一条，用户就会开始
 * 不信这张清单，所以这里逐条钉住口径。
 */
import { describe, expect, it } from 'vitest'
import {
  KB_ISSUE_KINDS,
  kbEntryLinks,
  kbIssueCounts,
  kbLint,
  resolveKbLink,
  type KbIssue,
  type KbIssueKind
} from './kb-lint'
import type { KbEntryMeta, KbScanEntry } from './kb'

/** 造一条扫描清单：rel 之外都有说得过去的默认值 */
function file(rel: string, isDir = false): KbScanEntry {
  return { rel, name: rel.split('/').pop() ?? rel, isDir, mtimeMs: 1000 }
}

/** 造一条「哪儿都挑不出毛病」的条目：各用例只改自己要考的那一处 */
function meta(partial: Partial<KbEntryMeta> = {}): KbEntryMeta {
  return {
    rel: 'kb/01-主题/a.md',
    title: '某条目',
    tags: ['主题'],
    status: 'reviewed',
    created: '2026-09-28',
    updated: '2026-09-28',
    summary: '一句话',
    source: '',
    links: [],
    mtimeMs: 1000,
    ...partial
  }
}

/** 只看某一类的说法（别的类在不在不掺和这一条用例） */
function ofKind(issues: KbIssue[], kind: KbIssueKind): string[] {
  return issues.filter((issue) => issue.kind === kind).map((issue) => issue.text)
}

describe('kbLint：孤儿', () => {
  it('没有别的条目链接它 → 孤儿', () => {
    const issues = kbLint([meta()], [file('kb/01-主题/a.md')])
    expect(ofKind(issues, 'orphan')).toEqual(['没有其它条目链接它'])
  })

  it('被别的条目链到就不是孤儿（跨目录的相对路径也算）', () => {
    const entries = [
      meta({ rel: 'kb/01-主题/a.md' }),
      meta({ rel: 'kb/02-其他/b.md', links: ['../01-主题/a.md'] })
    ]
    const issues = kbLint(entries, [file('kb/01-主题/a.md'), file('kb/02-其他/b.md')])
    expect(issues.filter((issue) => issue.rel === 'kb/01-主题/a.md' && issue.kind === 'orphan')).toEqual([])
    expect(ofKind(issues, 'orphan')).toEqual(['没有其它条目链接它'])
  })

  it('导航页（README.md）发的链接不算引用，它自己也不参与判定', () => {
    const entries = [
      meta({ rel: 'kb/01-主题/README.md', links: ['./a.md'] }),
      meta({ rel: 'kb/01-主题/a.md' })
    ]
    const issues = kbLint(entries, [file('kb/01-主题/README.md'), file('kb/01-主题/a.md')])
    // 总览把同目录的条目全链一遍 —— 算上它这个数就永远是零
    expect(ofKind(issues, 'orphan')).toEqual(['没有其它条目链接它'])
    expect(issues.filter((issue) => issue.rel === 'kb/01-主题/README.md' && issue.kind === 'orphan')).toEqual([])
  })

  it('链到原始资料不算「被引用」：目标不是条目', () => {
    const entries = [
      meta({ rel: 'kb/01-主题/a.md' }),
      meta({ rel: 'kb/01-主题/b.md', links: ['../../data/raw/x.md'] })
    ]
    const issues = kbLint(entries, [file('kb/01-主题/a.md'), file('kb/01-主题/b.md'), file('data/raw/x.md')])
    expect(ofKind(issues, 'orphan')).toEqual(['没有其它条目链接它', '没有其它条目链接它'])
    expect(ofKind(issues, 'link')).toEqual([])
  })
})

describe('kbLint：断链', () => {
  it('指向库里没有的文件 → 一条断链', () => {
    const entries = [meta({ links: ['./没有这个.md'] })]
    const issues = kbLint(entries, [file('kb/01-主题/a.md')])
    expect(ofKind(issues, 'link')).toEqual(['链接指向的文件不存在：kb/01-主题/没有这个.md'])
  })

  it('越出仓库根 / 写死根部 / 带协议的，都算跳不到库里', () => {
    const entries = [meta({ links: ['../../../外面.md', '/abs/x.md', 'https://example.com/a'] })]
    const issues = kbLint(entries, [file('kb/01-主题/a.md')])
    expect(ofKind(issues, 'link')).toEqual([
      '链接跳不到库里：../../../外面.md',
      '链接跳不到库里：/abs/x.md',
      '链接跳不到库里：https://example.com/a'
    ])
  })

  it('退到仓库根为止是合法的（templates / 根下的文件照样能链）', () => {
    const entries = [meta({ rel: 'kb/01-主题/a.md', links: ['../../templates/note-template.md'] })]
    const issues = kbLint(entries, [file('kb/01-主题/a.md'), file('templates/note-template.md')])
    expect(ofKind(issues, 'link')).toEqual([])
  })

  it('跳得到的（含 URL 编码）不报', () => {
    const entries = [meta({ links: ['./b.md', './%E7%BB%84%E4%BB%B6.md'] })]
    const issues = kbLint(entries, [file('kb/01-主题/a.md'), file('kb/01-主题/b.md'), file('kb/01-主题/组件.md')])
    expect(ofKind(issues, 'link')).toEqual([])
  })
})

describe('kbLint：元数据', () => {
  it('缺 tags / status 各报一条，日期格式不对也报', () => {
    const issues = kbLint(
      [meta({ tags: [], status: '', created: '2026/09/28', updated: '' })],
      [file('kb/01-主题/a.md')]
    )
    expect(ofKind(issues, 'meta')).toEqual([
      '没有 tags：搜索与标签筛选挂不上它',
      '没有 status',
      'created 不是 YYYY-MM-DD：2026/09/28',
      'updated 不是 YYYY-MM-DD：（空）'
    ])
  })

  it('整篇没有 frontmatter 只报一条（同一件事不说四遍）', () => {
    const bare = meta({ tags: [], status: '', created: '', updated: '', summary: '', source: '' })
    const issues = kbLint([bare], [file('kb/01-主题/a.md')])
    expect(ofKind(issues, 'meta')).toEqual(['没有 frontmatter：除了文件名什么都没有'])
  })
})

describe('kbLint：出处', () => {
  it('像路径但库里没有 → 报；带不带 data/raw/ 前缀两种写法都认', () => {
    const files = [file('kb/01-主题/a.md'), file('data/raw/mu-ui/select.md')]
    const missing = kbLint([meta({ source: 'data/raw/mu-ui/没有.md' })], files)
    expect(ofKind(missing, 'source')).toEqual(['出处指不到库里的文件：data/raw/mu-ui/没有.md'])

    const full = kbLint([meta({ source: 'data/raw/mu-ui/select.md' })], files)
    expect(ofKind(full, 'source')).toEqual([])

    const inner = kbLint([meta({ source: 'mu-ui/select.md' })], files)
    expect(ofKind(inner, 'source')).toEqual([])
  })

  it('书名 / 网址 / 一句话 / 库外的一份资料这种非路径不查', () => {
    const files = [file('kb/01-主题/a.md')]
    for (const source of ['初始搭建', '某本书第 3 章', 'https://example.com/a', '内部讨论', '某某书.pdf']) {
      expect(ofKind(kbLint([meta({ source })], files), 'source')).toEqual([])
    }
  })
})

describe('kbLint：主题目录', () => {
  it('直接躺在 kb/ 根下或目录名不是 NN- 的都报', () => {
    const entries = [meta({ rel: 'kb/散页.md' }), meta({ rel: 'kb/notes/a.md' }), meta({ rel: 'kb/01-主题/a.md' })]
    const issues = kbLint(entries, [file('kb/散页.md'), file('kb/notes/a.md'), file('kb/01-主题/a.md')])
    expect(ofKind(issues, 'topic')).toEqual([
      '直接放在 kb/ 根下，没有归进主题目录',
      '主题目录名不是 NN-主题名：notes'
    ])
  })
})

describe('kbLint：整体形状', () => {
  it('按分类的固定顺序拼（界面上一眼看得出哪一类有几处）', () => {
    const entries = [
      meta({ rel: 'kb/notes/a.md', links: ['./没有.md'] }) // 断链 + 主题目录 + 孤儿
    ]
    const issues = kbLint(entries, [file('kb/notes/a.md')])
    expect(issues.map((issue) => issue.kind)).toEqual(['orphan', 'link', 'topic'])
    const order = issues.map((issue) => KB_ISSUE_KINDS.indexOf(issue.kind))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('干净的库一个问题都没有（条目之间互相链着）', () => {
    const entries = [
      meta({ rel: 'kb/01-主题/README.md', links: ['./a.md'] }),
      meta({ rel: 'kb/01-主题/a.md', source: 'data/raw/x.md', links: ['./b.md'] }),
      meta({ rel: 'kb/01-主题/b.md', links: ['./a.md'] })
    ]
    const issues = kbLint(entries, [
      file('kb/01-主题/README.md'),
      file('kb/01-主题/a.md'),
      file('kb/01-主题/b.md'),
      file('data/raw/x.md')
    ])
    expect(issues).toEqual([])
  })
})

describe('kbIssueCounts', () => {
  it('只给非零的几类，按固定顺序，带界面上的说法', () => {
    const issues: KbIssue[] = [
      { kind: 'topic', rel: 'kb/a.md', text: 'x' },
      { kind: 'orphan', rel: 'kb/a.md', text: 'y' },
      { kind: 'orphan', rel: 'kb/b.md', text: 'z' }
    ]
    expect(kbIssueCounts(issues)).toEqual([
      { kind: 'orphan', label: '孤儿', count: 2 },
      { kind: 'topic', label: '主题目录', count: 1 }
    ])
  })
})

describe('kbEntryLinks', () => {
  it('收站内链接、去重保序；外部地址与纯锚点滤掉', () => {
    const text = '见 [甲](./a.md)、[乙](./a.md)、[外部](https://example.com)、[锚点](#第三节)。'
    expect(kbEntryLinks(text)).toEqual(['./a.md'])
  })

  it('空内容返回空数组', () => {
    expect(kbEntryLinks('')).toEqual([])
    expect(kbEntryLinks('   ')).toEqual([])
  })
})

describe('resolveKbLink', () => {
  it('相对的是条目所在的目录', () => {
    expect(resolveKbLink('kb/02-其他/b.md', './c.md')).toBe('kb/02-其他/c.md')
    expect(resolveKbLink('kb/02-其他/b.md', 'c.md')).toBe('kb/02-其他/c.md')
    expect(resolveKbLink('kb/02-其他/b.md', '../01-主题/a.md')).toBe('kb/01-主题/a.md')
    expect(resolveKbLink('kb/01-主题/a.md', '../../data/raw/x.md')).toBe('data/raw/x.md')
  })

  it('锚点与查询串不参与路径', () => {
    expect(resolveKbLink('kb/01-主题/a.md', './b.md#第三节')).toBe('kb/01-主题/b.md')
    expect(resolveKbLink('kb/01-主题/a.md', './b.md?v=2')).toBe('kb/01-主题/b.md')
  })

  it('跳不到库里的一律回 null', () => {
    expect(resolveKbLink('kb/01-主题/a.md', '')).toBeNull()
    expect(resolveKbLink('kb/01-主题/a.md', '#第三节')).toBeNull()
    expect(resolveKbLink('kb/01-主题/a.md', '/abs/x.md')).toBeNull()
    expect(resolveKbLink('kb/01-主题/a.md', 'https://example.com/a')).toBeNull()
    expect(resolveKbLink('kb/01-主题/a.md', 'mailto:a@b.c')).toBeNull()
    // 越出仓库根：`..` 只能退到仓库根，退过头的不解析
    expect(resolveKbLink('kb/a.md', '../../外面.md')).toBeNull()
    expect(resolveKbLink('kb/02-其他/b.md', '../../../外面.md')).toBeNull()
    // 退到仓库根为止是合法的：落到根下的文件（templates / README 这类）
    expect(resolveKbLink('kb/01-主题/a.md', '../../templates/note-template.md')).toBe(
      'templates/note-template.md'
    )
  })

  it('URL 编码解开一层，解不开就按原文用', () => {
    expect(resolveKbLink('kb/01-主题/a.md', './%E7%BB%84%E4%BB%B6.md')).toBe('kb/01-主题/组件.md')
    expect(resolveKbLink('kb/01-主题/a.md', './100%.md')).toBe('kb/01-主题/100%.md')
  })
})
