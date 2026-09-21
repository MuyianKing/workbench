import { describe, expect, it } from 'vitest'
import {
  buildNoteTree,
  countNodes,
  countNotes,
  findNoteNode,
  isNoteFile,
  isValidNoteName,
  joinRel,
  noteChain,
  noteDisplayName,
  noteDropAllowed,
  noteFileName,
  noteNameProblem,
  noteRootName,
  normalizeRel,
  parentRel,
  relName,
  pushNoteHistory,
  removeFromNoteHistory,
  resolveNoteLink,
  sanitizeNoteRepo,
  sanitizeNoteHistory,
  sanitizeNoteName,
  sanitizeNoteRoot,
  sanitizeNoteTreeExpanded,
  sortNoteNodes,
  uniqueNoteName,
  NOTE_HISTORY_MAX,
  NOTE_TREE_EXPANDED_MAX,
  type NoteEntry,
  type NoteNode
} from './note'

function dir(rel: string): NoteEntry {
  return { rel, name: relName(rel), isDir: true }
}

function file(rel: string, mtimeMs = 0): NoteEntry {
  return { rel, name: relName(rel), isDir: false, mtimeMs }
}

/** 树里某一层的名字（按显示顺序），写断言时比整棵树好读 */
function namesOf(nodes: readonly NoteNode[]): string[] {
  return nodes.map((node) => node.name)
}

describe('路径', () => {
  it('统一分隔符、去掉空段与 . 段，但不动 ..', () => {
    expect(normalizeRel('工作\\归档//周报.md')).toBe('工作/归档/周报.md')
    expect(normalizeRel(' ./工作/ ')).toBe('工作')
    expect(normalizeRel('../外面.md')).toBe('../外面.md')
    expect(normalizeRel(undefined)).toBe('')
  })

  it('拼路径与取父级/末段', () => {
    expect(joinRel('工作', '周报.md')).toBe('工作/周报.md')
    expect(joinRel('', '周报.md')).toBe('周报.md')
    expect(joinRel('工作/', '')).toBe('工作')
    expect(parentRel('工作/归档/周报.md')).toBe('工作/归档')
    expect(parentRel('周报.md')).toBe('')
    expect(relName('工作/周报.md')).toBe('周报.md')
  })

  it('收敛笔记文件夹：去空白与末尾分隔符，盘根要留住分隔符', () => {
    expect(sanitizeNoteRoot('  D:\\notes\\ ')).toBe('D:\\notes')
    expect(sanitizeNoteRoot('D:/notes/')).toBe('D:/notes')
    // `C:` 在 Windows 上是「当前目录」，与 `C:\` 不是一回事，去掉分隔符会换个地方
    expect(sanitizeNoteRoot('C:\\')).toBe('C:\\')
    expect(sanitizeNoteRoot('')).toBe('')
  })

  it('笔记名字取路径最后一段', () => {
    expect(noteRootName('D:\\notes\\我的笔记')).toBe('我的笔记')
    expect(noteRootName('D:/notes/')).toBe('notes')
  })
})

describe('名字', () => {
  it('收敛：压空白、剔非法字符、去掉末尾的点、按上限截断', () => {
    expect(sanitizeNoteName('  周 报  ')).toBe('周 报')
    expect(sanitizeNoteName('a\nb')).toBe('a b')
    expect(sanitizeNoteName('a/b:c')).toBe('abc')
    expect(sanitizeNoteName('草稿.')).toBe('草稿')
    expect(sanitizeNoteName('x'.repeat(80))).toHaveLength(60)
    expect(sanitizeNoteName(undefined)).toBe('')
  })

  it('非法名字给出具体原因（界面据此写提示）', () => {
    expect(noteNameProblem('周报')).toBe('')
    expect(noteNameProblem('   ')).toBe('名字不能为空')
    expect(noteNameProblem('a/b')).toContain('/')
    expect(noteNameProblem('.隐藏')).toBe('名字不能以点开头')
    expect(noteNameProblem('con')).toBe('这是系统的保留名字，换一个')
    expect(isValidNoteName('周报')).toBe(true)
    expect(isValidNoteName('a?b')).toBe(false)
  })

  it('笔记的文件名一律补 .md', () => {
    expect(noteFileName('周报')).toBe('周报.md')
    expect(isNoteFile('周报.md')).toBe(true)
    expect(isNoteFile('周报.MARKDOWN')).toBe(true)
    expect(isNoteFile('图片.png')).toBe(false)
    expect(noteDisplayName('周报.md')).toBe('周报')
    expect(noteDisplayName('周报.markdown')).toBe('周报')
  })

  it('同层撞名时往后编号，文件夹与笔记一起算', () => {
    const siblings = buildNoteTree([dir('周报'), file('周报.md'), file('周报 2.md')])
    expect(uniqueNoteName(siblings, '周报')).toBe('周报 3')
    expect(uniqueNoteName(siblings, '别的')).toBe('别的')
    // 空名字落到默认名上
    expect(uniqueNoteName([], '  ')).toBe('新建笔记')
  })
})

describe('组树', () => {
  it('文件夹排在文件前面，同层按名字排（数字按大小比）', () => {
    const nodes = buildNoteTree([
      file('笔记 10.md'),
      file('笔记 9.md'),
      dir('工作'),
      file('笔记 8.md'),
      dir('归档')
    ])
    expect(namesOf(nodes)).toEqual(['工作', '归档', '笔记 8', '笔记 9', '笔记 10'])
  })

  it('非 markdown 的文件不进树，嵌套的文件夹挂到它的父级下', () => {
    const nodes = buildNoteTree([
      dir('工作'),
      file('工作/周报.md'),
      dir('工作/归档'),
      file('工作/归档/旧事.md'),
      file('工作/配图.png'),
      file('随手记.markdown')
    ])

    expect(namesOf(nodes)).toEqual(['工作', '随手记'])
    const work = nodes[0]
    expect(namesOf(work.children ?? [])).toEqual(['归档', '周报'])
    expect(namesOf(work.children?.[0].children ?? [])).toEqual(['旧事'])
  })

  it('父目录没被扫出来时挂到根上，而不是整篇丢掉', () => {
    const nodes = buildNoteTree([file('工作/周报.md')])
    expect(namesOf(nodes)).toEqual(['周报'])
    expect(nodes[0].rel).toBe('工作/周报.md')
  })

  it('同一路径只收第一条；笔记的显示名不带后缀', () => {
    const nodes = buildNoteTree([file('周报.md', 111), file('周报.md', 222)])
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('周报')
    expect(nodes[0].mtimeMs).toBe(111)
    expect(nodes[0].kind).toBe('note')
  })

  it('排序返回新对象、不改入参', () => {
    const folder: NoteNode = { id: 'b', rel: 'b', name: 'b', kind: 'folder', children: [] }
    const note: NoteNode = { id: 'a.md', rel: 'a.md', name: 'a', kind: 'note' }
    const source = [note, folder]

    const sorted = sortNoteNodes(source)
    expect(namesOf(sorted)).toEqual(['b', 'a'])
    expect(namesOf(source)).toEqual(['a', 'b'])
    expect(sorted[0]).not.toBe(folder)
  })

  it('树里没有「根」这一层：顶层条目就是笔记本里的东西', () => {
    const nodes = buildNoteTree([file('周报.md'), dir('工作')])
    expect(namesOf(nodes)).toEqual(['工作', '周报'])
    expect(nodes.every((node) => node.rel && node.id === node.rel)).toBe(true)
  })
})

describe('读树', () => {
  const nodes = buildNoteTree([
    dir('工作'),
    file('工作/周报.md'),
    dir('工作/归档'),
    file('工作/归档/旧事.md'),
    file('随手记.md')
  ])

  it('findNoteNode 能找到任意深度，找不到返回 null', () => {
    expect(findNoteNode(nodes, '工作/归档/旧事.md')?.name).toBe('旧事')
    expect(findNoteNode(nodes, '工作')?.kind).toBe('folder')
    expect(findNoteNode(nodes, '没有/这个.md')).toBeNull()
    // 空路径是笔记本本身，树里没有对应的节点
    expect(findNoteNode(nodes, '')).toBeNull()
  })

  it('noteChain 给出从最外层到自身的链', () => {
    expect(noteChain(nodes, '工作/归档/旧事.md').map((node) => node.name)).toEqual([
      '工作',
      '归档',
      '旧事'
    ])
    expect(noteChain(nodes, '随手记.md')).toHaveLength(1)
    expect(noteChain(nodes, '工作/没有.md')).toEqual([])
  })

  it('数笔记只数文件，数节点连文件夹一起数', () => {
    expect(countNotes(nodes)).toBe(3)
    expect(countNodes(nodes)).toBe(5)
  })
})

describe('拖动', () => {
  it('文件可以拖进别的文件夹', () => {
    expect(noteDropAllowed({ rel: '周报.md', kind: 'note' }, { rel: '工作', kind: 'folder' })).toBe(
      true
    )
    // 拖回最外层（目录树下面的空白区，落点按 rel 为空串的文件夹算）
    expect(
      noteDropAllowed({ rel: '工作/周报.md', kind: 'note' }, { rel: '', kind: 'folder' })
    ).toBe(true)
  })

  it('已经在里面的、落在文件上的、拖文件夹的一律不行', () => {
    expect(
      noteDropAllowed({ rel: '工作/周报.md', kind: 'note' }, { rel: '工作', kind: 'folder' })
    ).toBe(false)
    expect(noteDropAllowed({ rel: '周报.md', kind: 'note' }, { rel: '', kind: 'folder' })).toBe(
      false
    )
    expect(noteDropAllowed({ rel: '周报.md', kind: 'note' }, { rel: '别的.md', kind: 'note' })).toBe(
      false
    )
    expect(noteDropAllowed({ rel: '工作', kind: 'folder' }, { rel: '归档', kind: 'folder' })).toBe(
      false
    )
  })
})

describe('正文里的链接', () => {
  it('相对的是这一篇所在的文件夹，几种写法都认', () => {
    expect(resolveNoteLink('./别的.md', '周报.md')).toBe('别的.md')
    expect(resolveNoteLink('别的.md', '周报.md')).toBe('别的.md')
    expect(resolveNoteLink('./别的.md', '归档/周报.md')).toBe('归档/别的.md')
    expect(resolveNoteLink('子/深的.md', '归档/周报.md')).toBe('归档/子/深的.md')
    expect(resolveNoteLink('./别的.markdown', '周报.md')).toBe('别的.markdown')
    // 从笔记本根写起的写法（几个平台上都有人这么写）
    expect(resolveNoteLink('/别的.md', '归档/周报.md')).toBe('别的.md')
    // 反斜杠是 Windows 上的写法，一并当分隔符
    expect(resolveNoteLink('.\\归档\\别的.md', '周报.md')).toBe('归档/别的.md')
  })

  it('.. 可以往上走，越过笔记本根就不是这里的笔记了', () => {
    expect(resolveNoteLink('../外面的.md', '归档/周报.md')).toBe('外面的.md')
    expect(resolveNoteLink('../子/深的.md', '归档/周报.md')).toBe('子/深的.md')
    expect(resolveNoteLink('../归档/别的.md', '归档/周报.md')).toBe('归档/别的.md')
    expect(resolveNoteLink('../../外面.md', '归档/周报.md')).toBe('')
    expect(resolveNoteLink('./../别处.md', '周报.md')).toBe('')
  })

  it('切掉锚点与查询串，百分号编码解回文件名', () => {
    expect(resolveNoteLink('./别的.md#小节', '周报.md')).toBe('别的.md')
    expect(resolveNoteLink('./别的.md?raw=true', '周报.md')).toBe('别的.md')
    expect(resolveNoteLink('%E5%91%A8%E6%8A%A5.md', '别的.md')).toBe('周报.md')
    expect(resolveNoteLink('./%E5%BD%92%E6%A1%A3/%E5%91%A8%E6%8A%A5.md', '别的.md')).toBe(
      '归档/周报.md'
    )
    // 解不开的编码（半截的、或者文件名里真的带 %）按原样用，别把链接整个丢掉
    expect(resolveNoteLink('./50%.md', '别的.md')).toBe('50%.md')
  })

  it('外部地址、锚点、非笔记的目标一律不算', () => {
    expect(resolveNoteLink('https://example.com/别的.md', '周报.md')).toBe('')
    expect(resolveNoteLink('mailto:me@example.com', '周报.md')).toBe('')
    expect(resolveNoteLink('C:\\笔记\\别的.md', '周报.md')).toBe('')
    expect(resolveNoteLink('#小节', '周报.md')).toBe('')
    expect(resolveNoteLink('./配图.png', '周报.md')).toBe('')
    expect(resolveNoteLink('./子目录/', '周报.md')).toBe('')
    expect(resolveNoteLink('./子目录', '周报.md')).toBe('')
    expect(resolveNoteLink('', '周报.md')).toBe('')
    expect(resolveNoteLink('   ', '周报.md')).toBe('')
    expect(resolveNoteLink(undefined, '周报.md')).toBe('')
  })
})

describe('打开过的笔记本', () => {
  it('收敛掉空的、重复的与超上限的', () => {
    expect(sanitizeNoteHistory('不是数组')).toEqual([])
    expect(sanitizeNoteHistory(['D:\\笔记\\', '', '  ', null, 'D:\\笔记', 'E:\\工作'])).toEqual([
      'D:\\笔记',
      'E:\\工作'
    ])

    const many = Array.from({ length: NOTE_HISTORY_MAX + 3 }, (_, index) => `D:\\n${index}`)
    expect(sanitizeNoteHistory(many)).toHaveLength(NOTE_HISTORY_MAX)
    // 留下的是排在前面的那几个（最近打开的）
    expect(sanitizeNoteHistory(many)[0]).toBe('D:\\n0')
  })

  it('刚打开的排到最前面，重复的不会出现两次', () => {
    expect(pushNoteHistory(['D:\\甲', 'D:\\乙'], 'D:\\乙')).toEqual(['D:\\乙', 'D:\\甲'])
    expect(pushNoteHistory([], '  D:\\笔记\\  ')).toEqual(['D:\\笔记'])
    // 空目录不入清单（等于「还没选过」）
    expect(pushNoteHistory(['D:\\甲'], '')).toEqual(['D:\\甲'])
  })

  it('删一条只删这一条', () => {
    expect(removeFromNoteHistory(['D:\\甲', 'D:\\乙'], 'D:\\甲')).toEqual(['D:\\乙'])
    expect(removeFromNoteHistory(['D:\\甲'], 'D:\\没有它')).toEqual(['D:\\甲'])
  })
})

describe('笔记仓库地址', () => {
  it('去掉首尾空白，认不出的当没填（等于关掉同步）', () => {
    expect(sanitizeNoteRepo('  git@github.com:me/notes.git ')).toBe('git@github.com:me/notes.git')
    expect(sanitizeNoteRepo('https://gitee.com/me/notes')).toBe('https://gitee.com/me/notes')
    expect(sanitizeNoteRepo('')).toBe('')
    expect(sanitizeNoteRepo('   ')).toBe('')
    expect(sanitizeNoteRepo(undefined)).toBe('')
    // 这个值最终是一条 git 命令行参数：含空白会被拆成两个参数，以 `-` 开头会被当成选项
    expect(sanitizeNoteRepo('https://github.com/me/my notes')).toBe('')
    expect(sanitizeNoteRepo('--upload-pack=evil')).toBe('')
    expect(sanitizeNoteRepo('x'.repeat(400))).toBe('')
  })
})

describe('目录树的展开清单', () => {
  it('分隔符统一、去掉空段与末尾分隔符', () => {
    expect(sanitizeNoteTreeExpanded(['工作\\周报\\'])).toEqual(['工作/周报'])
    expect(sanitizeNoteTreeExpanded(['工作//周报'])).toEqual(['工作/周报'])
  })

  it('去重不看大小写（Windows 上就是同一个目录）', () => {
    expect(sanitizeNoteTreeExpanded(['Work', 'work'])).toEqual(['Work'])
    expect(sanitizeNoteTreeExpanded(['工作/', '工作'])).toEqual(['工作'])
  })

  /** 相对路径只在这个笔记本里有意义，越界的项留着永远匹配不上任何一个节点 */
  it('丢掉空串与含 .. 的项', () => {
    expect(sanitizeNoteTreeExpanded(['', '   ', '../别处', '工作/../秘密', '工作'])).toEqual(['工作'])
  })

  it('非数组与非字符串一律当空', () => {
    expect(sanitizeNoteTreeExpanded(undefined)).toEqual([])
    expect(sanitizeNoteTreeExpanded('工作')).toEqual([])
    expect(sanitizeNoteTreeExpanded([1, null, {}, '工作'])).toEqual(['工作'])
  })

  it('超过上限的部分整段丢掉', () => {
    const many = Array.from({ length: NOTE_TREE_EXPANDED_MAX + 10 }, (_, i) => `目录${i}`)
    expect(sanitizeNoteTreeExpanded(many)).toHaveLength(NOTE_TREE_EXPANDED_MAX)
  })
})
