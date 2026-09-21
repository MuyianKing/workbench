import { describe, expect, it } from 'vitest'
import {
  SKILL_VERSION_DEFAULT,
  compareSkillVersions,
  hasSkillFrontmatter,
  libraryInNotebook,
  mergeVersionCopies,
  parseSkillFrontmatter,
  sanitizeSkillSyncDir,
  skillFileRel,
  skillMdTemplate,
  skillRel,
  skillVersionOf,
  skillVersionProblem,
  toSkillEntry,
  withoutSkillDir,
  yamlScalar
} from './skills'
import type { NoteNode } from './note'

describe('parseSkillFrontmatter', () => {
  it('提取 name、description 与 version', () => {
    const text = [
      '---',
      'name: 提交规范',
      'description: 按约定式提交写 commit message',
      'version: 1.2.0',
      '---',
      '',
      '# 提交规范'
    ].join('\n')
    expect(parseSkillFrontmatter(text)).toEqual({
      name: '提交规范',
      description: '按约定式提交写 commit message',
      version: '1.2.0'
    })
  })

  it('去掉一层成对的引号', () => {
    const text = '---\nname: "my-skill"\ndescription: \'说了: 冒号也行\'\nversion: "2.0.0"\n---\n'
    expect(parseSkillFrontmatter(text)).toEqual({
      name: 'my-skill',
      description: '说了: 冒号也行',
      version: '2.0.0'
    })
  })

  it('容忍 BOM、CRLF 与围栏前的空行', () => {
    const text = '\uFEFF\r\n\r\n---\r\nname: a\r\ndescription: b\r\nversion: 0.1.0\r\n---\r\nbody'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'a', description: 'b', version: '0.1.0' })
  })

  it('没有 frontmatter、空文本、非字符串都返回三个空串', () => {
    expect(parseSkillFrontmatter('# 直接开写的正文')).toEqual({ name: '', description: '', version: '' })
    expect(parseSkillFrontmatter('')).toEqual({ name: '', description: '', version: '' })
    expect(parseSkillFrontmatter(undefined as unknown as string)).toEqual({
      name: '',
      description: '',
      version: ''
    })
  })

  it('多行块标量不带内容（不猜缩进），其余键不碰', () => {
    const text = '---\ndescription: >-\n  跨行的描述\nignored: x\nname: n\n---\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'n', description: '', version: '' })
  })

  it('description 里带冒号时取第一处冒号后的全部', () => {
    const text = '---\ndescription: 用法: 先读后写\n---\n'
    expect(parseSkillFrontmatter(text).description).toBe('用法: 先读后写')
  })
})

describe('版本：保存的必经门槛', () => {
  it('合法的三段数字通过（容忍可选的 v 前缀，归一化时去掉）', () => {
    expect(skillVersionProblem('---\nversion: 1.2.3\n---\n')).toBe('')
    expect(skillVersionProblem('---\nversion: "v0.1.0"\n---\n')).toBe('')
    expect(skillVersionOf('---\nversion: 1.2.3\n---\n')).toBe('1.2.3')
    expect(skillVersionOf('---\nversion: v0.1.0\n---\n')).toBe('0.1.0')
  })

  it('没写 version：有没有 frontmatter 各说各的', () => {
    expect(skillVersionProblem('---\nname: n\n---\n')).toBe(
      'frontmatter 里还没有 version，补一行 version: 1.0.0 再保存'
    )
    expect(skillVersionProblem('# 没有围栏的正文')).toBe(
      'SKILL.md 开头要有 frontmatter（--- 包住的那段），version 写在那里（如 version: 1.0.0）'
    )
    expect(hasSkillFrontmatter('---\nname: n\n---\n')).toBe(true)
    expect(hasSkillFrontmatter('# 没有围栏')).toBe(false)
  })

  it('不是三段数字的不合语义：两位数、纯数字、带空段都挡回来', () => {
    expect(skillVersionProblem('---\nversion: 0.1\n---\n')).toContain('不是语义化版本')
    expect(skillVersionProblem('---\nversion: 12\n---\n')).toContain('不是语义化版本')
    expect(skillVersionProblem('---\nversion: 1.x.0\n---\n')).toContain('不是语义化版本')
    expect(skillVersionProblem('---\nversion: 1..0\n---\n')).toContain('不是语义化版本')
    expect(skillVersionOf('---\nversion: 0.1\n---\n')).toBe('')
  })

  it('模板自带默认版本，写出来再解析取回的就是它', () => {
    const parsed = parseSkillFrontmatter(skillMdTemplate('commit-lint', '按约定式提交写 message'))
    expect(parsed.version).toBe(SKILL_VERSION_DEFAULT)
    expect(skillVersionProblem(skillMdTemplate('a', 'b'))).toBe('')
  })

  it('版本比较按数字逐段比，不是按字符串', () => {
    expect(compareSkillVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareSkillVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareSkillVersions('2.0.0', '1.99.99')).toBe(1)
    expect(compareSkillVersions('1.2.3', '1.2.3')).toBe(0)
    // 任一侧不合语义按 0.0.0 兜底：库里还没有 version 时，项目里任何合法版本都算更高
    expect(compareSkillVersions('0.1.0', '')).toBe(1)
    expect(compareSkillVersions('', '0.1.0')).toBe(-1)
    expect(compareSkillVersions('', '')).toBe(0)
    expect(compareSkillVersions('abc', '0.0.1')).toBe(-1)
  })
})

describe('yamlScalar / skillMdTemplate', () => {
  it('普通文本不加引号，含特殊字符时加双引号并转义', () => {
    expect(yamlScalar('提交规范')).toBe('提交规范')
    expect(yamlScalar('my-skill')).toBe('my-skill')
    expect(yamlScalar('说了: 冒号')).toBe('"说了: 冒号"')
    expect(yamlScalar('带"引号"')).toBe('"带\\"引号\\""')
    expect(yamlScalar('')).toBe("''")
  })

  it('模板写出来再解析，取回的就是填进去的（版本取默认那档）', () => {
    const name = 'commit-lint'
    const description = '按约定式提交写 message'
    const parsed = parseSkillFrontmatter(skillMdTemplate(name, description))
    expect(parsed.name).toBe(name)
    expect(parsed.description).toBe(description)
    expect(parsed.version).toBe(SKILL_VERSION_DEFAULT)
  })
})

describe('sanitizeSkillSyncDir', () => {
  it('空串是合法的（技能库自己就是仓库根），只规范化写法', () => {
    expect(sanitizeSkillSyncDir('')).toBe('')
    expect(sanitizeSkillSyncDir('   ')).toBe('')
    expect(sanitizeSkillSyncDir(undefined)).toBe('')
  })

  it('统一分隔符、逐段清洗、保留多段', () => {
    expect(sanitizeSkillSyncDir('skills')).toBe('skills')
    expect(sanitizeSkillSyncDir(' AI\\skills ')).toBe('AI/skills')
    expect(sanitizeSkillSyncDir('a//b')).toBe('a/b')
  })

  it('挡住越界与认不出的值（它们接下来要去拼文件路径与 git pathspec）', () => {
    expect(sanitizeSkillSyncDir('..')).toBe('')
    expect(sanitizeSkillSyncDir('skills/../../x')).toBe('')
    // 清洗后为空的段让整条作废：拼出来的路径已经不是磁盘上那个了
    expect(sanitizeSkillSyncDir('skills/???')).toBe('')
    const long = `${'x'.repeat(60)}/${'y'.repeat(60)}/${'z'.repeat(60)}`
    expect(sanitizeSkillSyncDir(long)).toBe('')
  })
})

describe('libraryInNotebook', () => {
  it('技能库在笔记本里：给出它相对笔记本的路径（两种分隔符都认）', () => {
    expect(libraryInNotebook('D:/notes/agent-knowledge/skills', 'D:/notes')).toBe(
      'agent-knowledge/skills'
    )
    expect(libraryInNotebook('D:\\notes\\skills', 'D:/notes')).toBe('skills')
    expect(libraryInNotebook('D:/notes/skills/', 'D:/notes')).toBe('skills')
  })

  it('大小写不敏感（Windows 上同一个目录），返回库里那一段的原样写法', () => {
    expect(libraryInNotebook('d:/Notes/Skills', 'D:/notes')).toBe('Skills')
  })

  it('不在笔记本里 / 就是笔记本自己 / 比笔记本还浅：都回空串（什么都不藏）', () => {
    expect(libraryInNotebook('E:/skills', 'D:/notes')).toBe('')
    expect(libraryInNotebook('D:/notes', 'D:/notes')).toBe('')
    expect(libraryInNotebook('D:/', 'D:/notes')).toBe('')
    // 只是名字像，不是祖先关系
    expect(libraryInNotebook('D:/notes2/skills', 'D:/notes')).toBe('')
    expect(libraryInNotebook('', 'D:/notes')).toBe('')
    expect(libraryInNotebook('D:/notes/skills', '')).toBe('')
  })
})

describe('路径拼接与摘要', () => {
  it('skillRel / skillFileRel 拼相对路径', () => {
    expect(skillRel('skills', 'alpha')).toBe('skills/alpha')
    expect(skillFileRel('skills', 'alpha')).toBe('skills/alpha/SKILL.md')
  })

  it('toSkillEntry：名字缺省回落 id，版本归一化，认不出的条目丢掉', () => {
    expect(
      toSkillEntry({ id: 'alpha', fileCount: 2, skillMd: '---\nname: 阿尔法\nversion: v1.0.0\n---\n' })
    ).toEqual({
      id: 'alpha',
      name: '阿尔法',
      description: '',
      version: '1.0.0',
      hasSkillMd: true,
      fileCount: 2
    })

    const noMd = toSkillEntry({ id: 'beta', skillMd: null })
    expect(noMd).toMatchObject({ id: 'beta', name: 'beta', version: '', hasSkillMd: false })
    const badVersion = toSkillEntry({ id: 'gamma', skillMd: '---\nversion: 0.1\n---\n' })
    expect(badVersion).toMatchObject({ id: 'gamma', version: '' })
    expect(toSkillEntry({ id: '  ' })).toBeNull()
    expect(toSkillEntry({})).toBeNull()
  })
})

/**
 * 版本对比的清单合成：方向不能反、并集不能漏 —— 这两条错了界面都不报错，
 * 只是把「恢复到这一版会变成什么样」显示成另一回事，而恢复按钮就摆在那张表下面。
 */
describe('mergeVersionCopies', () => {
  it('base 是现在这份、incoming 是所选那一版，两侧都在的看内容差异', () => {
    const merged = mergeVersionCopies(
      [{ rel: 'SKILL.md', content: '现在的\n' }],
      [{ rel: 'SKILL.md', content: '那一版\n' }]
    )
    expect(merged).toEqual([{ rel: 'SKILL.md', base: '现在的\n', incoming: '那一版\n' }])
  })

  it('那一版有、现在删掉的文件照样列出来（incoming 有内容、base 为空）', () => {
    const merged = mergeVersionCopies(
      [{ rel: 'SKILL.md', content: '现在的\n' }],
      [
        { rel: 'SKILL.md', content: '那一版\n' },
        { rel: '旧脚本.sh', content: 'echo 1\n' }
      ]
    )
    expect(merged.map((file) => file.rel)).toEqual(['SKILL.md', '旧脚本.sh'])
    expect(merged[1]).toEqual({ rel: '旧脚本.sh', base: '', incoming: 'echo 1\n' })
  })

  it('现在新增、那一版没有的文件也列出来（incoming 为 null，恢复会把它删掉）', () => {
    const merged = mergeVersionCopies(
      [
        { rel: 'SKILL.md', content: '现在的\n' },
        { rel: '后来加的.md', content: '新内容\n' }
      ],
      [{ rel: 'SKILL.md', content: '那一版\n' }]
    )
    expect(merged).toEqual([
      { rel: 'SKILL.md', base: '现在的\n', incoming: '那一版\n' },
      { rel: '后来加的.md', base: '新内容\n', incoming: null }
    ])
  })

  it('读不出文本的（二进制）如实留空串 / null，不编内容', () => {
    const merged = mergeVersionCopies(
      [{ rel: 'logo.png', content: null }],
      [{ rel: 'logo.png', content: null }]
    )
    expect(merged).toEqual([{ rel: 'logo.png', base: '', incoming: null }])
  })

  it('结果按 rel 的码点顺序排（与 Rust 递回来的那一侧同一口径），与输入顺序无关', () => {
    const merged = mergeVersionCopies(
      [{ rel: 'z.md', content: 'z' }, { rel: 'a.md', content: 'a' }],
      [{ rel: 'm.md', content: 'm' }]
    )
    expect(merged.map((file) => file.rel)).toEqual(['a.md', 'm.md', 'z.md'])
  })
})

describe('withoutSkillDir', () => {
  const node = (rel: string): NoteNode => ({ id: rel, rel, name: rel, kind: 'folder', children: [] })

  it('顶层同名的目录被藏掉，其余原样保留', () => {
    const nodes = [node('skills'), node('工作'), node('skills/inner')]
    const kept = withoutSkillDir(nodes, 'skills')
    expect(kept.map((item) => item.rel)).toEqual(['工作', 'skills/inner'])
  })

  it('多段的技能库路径与空路径都原样返回', () => {
    const nodes = [node('AI'), node('skills')]
    expect(withoutSkillDir(nodes, 'AI/skills')).toHaveLength(2)
    expect(withoutSkillDir(nodes, '')).toHaveLength(2)
  })
})
