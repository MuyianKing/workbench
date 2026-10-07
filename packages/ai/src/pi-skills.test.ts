import { describe, expect, it } from 'vitest'
import { aiSkillRows, enabledAiSkills, projectSkillsRoot, sanitizeAiSkillsOff, skillKey, skillPathOf } from './pi-skills'

const SKILL_MD = [
  '---',
  'name: 通用图表生成器',
  'slug: universal--charts',
  'description: 上传 CSV 自动出图',
  'version: 1.0.1',
  '---',
  '',
  '正文',
].join('\n')

const RAW = [
  { id: 'universal--charts', fileCount: 9, skillMd: SKILL_MD },
  { id: '另一个技能', fileCount: 1, skillMd: '---\nname: 另一个\ndescription: x\n---\n' },
]

describe('projectSkillsRoot', () => {
  it('拼在工作目录下，分隔符跟工作目录一致', () => {
    expect(projectSkillsRoot('E:\\work')).toBe('E:\\work\\.agents\\skills')
    expect(projectSkillsRoot('E:\\work\\')).toBe('E:\\work\\.agents\\skills')
    expect(projectSkillsRoot('E:/work')).toBe('E:/work/.agents/skills')
  })

  it('还没挑目录就是空串', () => {
    expect(projectSkillsRoot('')).toBe('')
    expect(projectSkillsRoot('   ')).toBe('')
  })
})

describe('skillKey', () => {
  it('大小写与分隔符都不影响同一个技能的身份', () => {
    expect(skillKey('E:\\Work', 'tauri')).toBe(skillKey('E:/work/', 'tauri'))
    expect(skillKey('C:\\Users\\Admin\\.agents\\skills', 'Tauri')).toBe(
      'c:\\users\\admin\\.agents\\skills\\tauri',
    )
  })
})

describe('skillPathOf', () => {
  it('给界面用的路径：分隔符跟着根走，尾部分隔符不留', () => {
    expect(skillPathOf('C:\\Users\\Admin\\.agents\\skills', 'find-skills')).toBe(
      'C:\\Users\\Admin\\.agents\\skills\\find-skills',
    )
    expect(skillPathOf('C:/g/', 'a')).toBe('C:/g/a')
    expect(skillPathOf('', 'a')).toBe('a')
  })
})

describe('sanitizeAiSkillsOff', () => {
  it('只留长得像路径的字符串，去重限长', () => {
    expect(sanitizeAiSkillsOff(['a\\b', 'a\\b', 42, '', '  ', 'x'.repeat(500)])).toEqual(['a\\b'])
    expect(sanitizeAiSkillsOff(null)).toEqual([])
    expect(sanitizeAiSkillsOff('a\\b')).toEqual([])
  })
})

describe('aiSkillRows', () => {
  it('把 Rust 回来的记录收敛成行，并合上开关状态', () => {
    const disabled = [skillKey('C:\\Users\\Admin\\.agents\\skills', 'universal--charts')]
    const rows = aiSkillRows('global', 'C:\\Users\\Admin\\.agents\\skills', RAW, disabled)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'universal--charts',
      name: '通用图表生成器',
      description: '上传 CSV 自动出图',
      version: '1.0.1',
      fileCount: 9,
      level: 'global',
      enabled: false,
    })
    // 原文跟着行一起带着（详情那一栏直接画它，不再跑一趟通道）
    expect(rows[0].md).toContain('正文')
    // 没写 version 的如实空串，名字回落目录名
    expect(rows[1]).toMatchObject({ id: '另一个技能', version: '', enabled: true })
  })

  it('认不出的记录直接丢掉，不拖垮整表', () => {
    const rows = aiSkillRows('project', 'E:\\work\\.agents\\skills', [null, {}, { id: '' }], [])
    expect(rows).toEqual([])
    expect(aiSkillRows('project', 'E:\\work\\.agents\\skills', 'nope', [])).toEqual([])
  })
})

describe('enabledAiSkills', () => {
  it('交给 Pi 的只有开着的那几条，两个根各按各的来', () => {
    const rows = aiSkillRows('global', 'C:\\g', RAW, [])
    const project = aiSkillRows('project', 'E:\\work\\.agents\\skills', RAW, [
      skillKey('E:\\work\\.agents\\skills', 'universal--charts'),
    ])
    expect(enabledAiSkills([...rows, ...project])).toEqual([
      { root: 'C:\\g', id: 'universal--charts' },
      { root: 'C:\\g', id: '另一个技能' },
      { root: 'E:\\work\\.agents\\skills', id: '另一个技能' },
    ])
  })
})
