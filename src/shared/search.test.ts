import { describe, expect, it } from 'vitest'
import {
  PROJECT_HIT_LIMIT,
  SEARCH_SOURCE_PROJECT,
  highlightSegments,
  normalizeKeyword,
  projectMatchesKeyword,
  searchProjects,
  type SearchableProject
} from '@shared/search'

function project(id: string, name: string, path: string): SearchableProject {
  return { id, name, path }
}

const LIST: SearchableProject[] = [
  project('p1', 'ICU 2.0', 'E:\\git-projects\\ICU2.0\\code\\ICUClient'),
  project('p2', 'anes-page', 'E:\\git-projects\\anes\\code\\anes-page'),
  project('p3', 'icu-client', 'E:\\git-projects\\icu-client'),
  project('p4', '门口屏', 'E:\\git-projects\\doorScreen\\door-admin')
]

describe('关键词归一', () => {
  it('去空白并转小写', () => {
    expect(normalizeKeyword('  ICU ')).toBe('icu')
    expect(normalizeKeyword('   ')).toBe('')
  })
})

describe('项目匹配', () => {
  it('名字或路径任一命中即可', () => {
    expect(projectMatchesKeyword(LIST[0], 'icu')).toBe(true)
    // 名字里没有，但路径里有
    expect(projectMatchesKeyword(LIST[3], 'doorscreen')).toBe(true)
    expect(projectMatchesKeyword(LIST[0], 'anes')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(projectMatchesKeyword(LIST[2], 'ICU')).toBe(true)
  })

  it('空关键词视为不筛', () => {
    expect(projectMatchesKeyword(LIST[0], '   ')).toBe(true)
  })
})

describe('高亮分段', () => {
  it('一段文字里的多处命中都要标出来', () => {
    expect(highlightSegments('ICU2.0/ICUClient', 'icu')).toEqual([
      { text: 'ICU', hit: true },
      { text: '2.0/', hit: false },
      { text: 'ICU', hit: true },
      { text: 'Client', hit: false }
    ])
  })

  it('命中在开头 / 结尾时不留空段', () => {
    expect(highlightSegments('icu-utils', 'icu')).toEqual([
      { text: 'icu', hit: true },
      { text: '-utils', hit: false }
    ])
    expect(highlightSegments('my-icu', 'icu')).toEqual([
      { text: 'my-', hit: false },
      { text: 'icu', hit: true }
    ])
  })

  it('没命中就是整段普通文字', () => {
    expect(highlightSegments('anes-page', 'icu')).toEqual([{ text: 'anes-page', hit: false }])
  })

  it('空关键词 / 空文本不会崩', () => {
    expect(highlightSegments('anes-page', '  ')).toEqual([{ text: 'anes-page', hit: false }])
    expect(highlightSegments('', 'icu')).toEqual([])
  })

  it('关键词比原文长时不越界', () => {
    expect(highlightSegments('ic', 'icu')).toEqual([{ text: 'ic', hit: false }])
  })
})

describe('项目搜索', () => {
  const labelOf = (p: SearchableProject) => (p.id === 'p1' ? '运行中' : '空闲')

  it('按传入顺序返回，并带上分组标题与行尾说明', () => {
    const group = searchProjects(LIST, 'icu', PROJECT_HIT_LIMIT, labelOf)

    expect(group.total).toBe(2)
    expect(group.label).toBe('项目')
    expect(group.hits.map((hit) => hit.id)).toEqual(['p1', 'p3'])
    expect(group.hits[0]).toMatchObject({
      source: SEARCH_SOURCE_PROJECT,
      title: 'ICU 2.0',
      subtitle: 'E:\\git-projects\\ICU2.0\\code\\ICUClient',
      detail: '运行中'
    })
  })

  it('截断到上限，但总数照旧数全', () => {
    const group = searchProjects(LIST, 'e', 2, labelOf)

    expect(group.hits).toHaveLength(2)
    expect(group.total).toBe(4)
  })

  it('空关键词什么都不返回（面板此时不该弹出来）', () => {
    for (const kw of ['', '   ']) {
      const group = searchProjects(LIST, kw, PROJECT_HIT_LIMIT, labelOf)
      expect(group.hits).toEqual([])
      expect(group.total).toBe(0)
    }
  })

  it('一个都没命中时两类都是空', () => {
    const group = searchProjects(LIST, 'zzz', PROJECT_HIT_LIMIT, labelOf)
    expect(group.hits).toEqual([])
    expect(group.total).toBe(0)
  })
})
