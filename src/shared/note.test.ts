import { describe, expect, it } from 'vitest'
import {
  NOTE_MAX_DEPTH,
  NOTE_NAME_MAX,
  addNoteNode,
  countNodes,
  countNotes,
  createNoteNode,
  emptyNoteFile,
  findNote,
  isValidNoteName,
  notePath,
  parentIdOf,
  parseNoteData,
  removeNoteNode,
  renameNoteNode,
  sanitizeNoteName,
  setNoteContent,
  sortByName,
  uniqueNoteName,
  type NoteNode
} from './note'

const NOW = 1_700_000_000_000

let counter = 0
const uuid = (): string => `id-${(counter += 1)}`

function folder(id: string, name: string, children: NoteNode[] = []): NoteNode {
  return { id, name, kind: 'folder', children, createdAt: NOW, updatedAt: NOW }
}

function note(id: string, name: string, content = ''): NoteNode {
  return { id, name, kind: 'note', content, createdAt: NOW, updatedAt: NOW }
}

/** 一棵有代表性的树：根下一夹一记，夹里再一记 */
function sample(): NoteNode[] {
  return [
    folder('f1', '工作', [note('n1', '周报', '# 本周'), folder('f2', '归档', [note('n2', '旧事')])]),
    note('n3', '随笔')
  ]
}

describe('sanitizeNoteName', () => {
  it('去掉首尾空白并把换行压成空格', () => {
    expect(sanitizeNoteName('  周报  ')).toBe('周报')
    expect(sanitizeNoteName('周\n报')).toBe('周 报')
  })

  it('超长名字按上限截断', () => {
    expect(sanitizeNoteName('x'.repeat(200))).toHaveLength(NOTE_NAME_MAX)
  })

  it('非字符串一律算空', () => {
    expect(sanitizeNoteName(undefined)).toBe('')
    expect(sanitizeNoteName(42)).toBe('')
  })

  it('空名字非法，其余合法', () => {
    expect(isValidNoteName('   ')).toBe(false)
    expect(isValidNoteName('周报')).toBe(true)
  })
})

describe('uniqueNoteName', () => {
  it('同层撞名时往后编号', () => {
    const siblings = [note('a', '新建笔记'), note('b', '新建笔记 2')]
    expect(uniqueNoteName(siblings, '新建笔记')).toBe('新建笔记 3')
  })

  it('没撞名就原样用它', () => {
    expect(uniqueNoteName([note('a', '周报')], '随笔')).toBe('随笔')
  })
})

describe('parseNoteData', () => {
  it('文件缺失 / 损坏时退化成空笔记本', () => {
    expect(parseNoteData(null, uuid, NOW).nodes).toEqual([])
    expect(parseNoteData('nonsense', uuid, NOW).nodes).toEqual([])
    expect(emptyNoteFile().nodes).toEqual([])
  })

  it('保留嵌套结构，文件夹补上空 children', () => {
    const file = parseNoteData(
      { version: 1, nodes: [{ id: 'f1', name: '工作', kind: 'folder' }] },
      uuid,
      NOW
    )
    expect(file.nodes[0].children).toEqual([])
  })

  it('没名字的节点连同子树一起丢掉', () => {
    const file = parseNoteData(
      { nodes: [folder('f1', ' ', [note('n1', '留下')]), note('n2', '    ')] },
      uuid,
      NOW
    )
    expect(file.nodes).toEqual([])
  })

  it('id 重复只留第一次，后面的重发一个', () => {
    const file = parseNoteData({ nodes: [note('same', '甲'), note('same', '乙')] }, uuid, NOW)
    expect(file.nodes).toHaveLength(2)
    expect(file.nodes[0].id).toBe('same')
    expect(file.nodes[1].id).not.toBe('same')
  })

  it('缺 createdAt / updatedAt 时按当下补齐', () => {
    const file = parseNoteData({ nodes: [note('n1', '甲')] }, uuid, NOW)
    expect(file.nodes[0].createdAt).toBe(NOW)
    expect(file.nodes[0].updatedAt).toBe(NOW)
  })

  it('嵌套过深时截断在深度上限，不至于递归爆栈', () => {
    let deep: unknown = note('leaf', '底层')
    for (let index = 0; index < NOTE_MAX_DEPTH + 5; index += 1) {
      deep = { id: `f-${index}`, name: `夹${index}`, kind: 'folder', children: [deep] }
    }

    const file = parseNoteData({ nodes: [deep] }, uuid, NOW)
    let depth = 0
    let cursor: NoteNode | undefined = file.nodes[0]
    while (cursor?.children?.length) {
      depth += 1
      cursor = cursor.children[0]
    }
    expect(depth).toBe(NOTE_MAX_DEPTH)
  })

  it('正文不是字符串时按空笔记算', () => {
    const file = parseNoteData({ nodes: [{ id: 'n1', name: '甲', kind: 'note', content: 5 }] }, uuid, NOW)
    expect(file.nodes[0].content).toBe('')
  })
})

describe('createNoteNode', () => {
  it('文件夹带空 children，笔记带空正文', () => {
    const dir = createNoteNode({ kind: 'folder', name: '  工作 ' }, uuid, NOW)
    expect(dir).toMatchObject({ name: '工作', kind: 'folder', children: [] })

    const leaf = createNoteNode({ kind: 'note', name: '随笔' }, uuid, NOW)
    expect(leaf).toMatchObject({ name: '随笔', kind: 'note', content: '' })
  })

  it('名字为空时返回 null', () => {
    expect(createNoteNode({ kind: 'note', name: '   ' }, uuid, NOW)).toBeNull()
  })
})

describe('树的读', () => {
  it('findNote 能找到任意深度，找不到返回 null', () => {
    expect(findNote(sample(), 'n2')?.name).toBe('旧事')
    expect(findNote(sample(), 'missing')).toBeNull()
  })

  it('notePath 给出从根到自身的链', () => {
    expect(notePath(sample(), 'n2').map((node) => node.id)).toEqual(['f1', 'f2', 'n2'])
    expect(notePath(sample(), 'missing')).toEqual([])
  })

  it('parentIdOf 在根上返回 null', () => {
    expect(parentIdOf(sample(), 'n2')).toBe('f2')
    expect(parentIdOf(sample(), 'f1')).toBeNull()
  })

  it('countNotes 只数笔记，countNodes 数上文件夹', () => {
    expect(countNotes(sample())).toBe(3)
    expect(countNodes(sample())).toBe(5)
  })
})

describe('树的写', () => {
  it('addNoteNode 追加到指定文件夹末尾', () => {
    const tree = addNoteNode(sample(), 'f2', note('n4', '新记'))
    expect(findNote(tree, 'f2')?.children?.map((node) => node.id)).toEqual(['n2', 'n4'])
    // 原树不动
    expect(findNote(sample(), 'n4')).toBeNull()
  })

  it('addNoteNode 在根上就是追加到最外层', () => {
    const tree = addNoteNode(sample(), null, note('n4', '新记'))
    expect(tree.map((node) => node.id)).toEqual(['f1', 'n3', 'n4'])
  })

  it('addNoteNode 落在一个笔记或已删除的文件夹上时原样返回', () => {
    const tree = sample()
    expect(addNoteNode(tree, 'n3', note('n4', '新记'))).toBe(tree)
    expect(addNoteNode(tree, 'missing', note('n4', '新记'))).toBe(tree)
  })

  it('renameNoteNode 改名并刷新 updatedAt', () => {
    const tree = renameNoteNode(sample(), 'n1', '月报', NOW + 5)
    expect(findNote(tree, 'n1')).toMatchObject({ name: '月报', updatedAt: NOW + 5 })
  })

  it('renameNoteNode 名字没变时引用不变（不产生无意义的落盘）', () => {
    const tree = sample()
    expect(renameNoteNode(tree, 'n1', ' 周报 ', NOW + 5)).toBe(tree)
    expect(renameNoteNode(tree, 'n1', '   ', NOW + 5)).toBe(tree)
  })

  it('setNoteContent 改正文，文件夹不受影响', () => {
    const tree = setNoteContent(sample(), 'n1', '# 新内容', NOW + 5)
    expect(findNote(tree, 'n1')).toMatchObject({ content: '# 新内容', updatedAt: NOW + 5 })
    expect(setNoteContent(tree, 'f1', 'x')).toBe(tree)
  })

  it('setNoteContent 内容相同时引用不变', () => {
    const tree = sample()
    expect(setNoteContent(tree, 'n1', '# 本周', NOW + 5)).toBe(tree)
  })

  it('removeNoteNode 删文件夹会带走整棵子树', () => {
    const tree = removeNoteNode(sample(), 'f1')
    expect(tree.map((node) => node.id)).toEqual(['n3'])
  })

  it('removeNoteNode 没命中时引用不变', () => {
    const tree = sample()
    expect(removeNoteNode(tree, 'missing')).toBe(tree)
  })
})

describe('sortByName', () => {
  it('逐层按名字排，且不修改原树', () => {
    const tree = sample()
    const sorted = sortByName(tree)
    expect(sorted.map((node) => node.name)).toEqual(['工作', '随笔'])
    expect(tree.map((node) => node.name)).toEqual(['工作', '随笔'])
    expect(sorted[0].children?.map((node) => node.name)).toEqual(['归档', '周报'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  })
})
