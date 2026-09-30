import { describe, expect, it } from 'vitest'
import { relativeToProject, resolveWithinProject } from './project-path'

describe('relativeToProject', () => {
  it('把项目内的子目录落成相对写法', () => {
    expect(relativeToProject('E:\\proj', 'E:\\proj\\dist')).toBe('dist')
    expect(relativeToProject('E:\\proj\\', 'E:\\proj\\packages\\web\\dist')).toBe(
      'packages/web/dist'
    )
  })

  it('大小写与斜杠方向不影响判断，但保留下半段的原样大小写', () => {
    expect(relativeToProject('e:/proj', 'E:\\Proj\\Dist')).toBe('Dist')
  })

  it('项目外的目录与项目根本身保持原样', () => {
    // 项目外：相对路径表达不了，原样留着（界面提示里会显示实际路径）
    expect(relativeToProject('E:\\proj', 'D:\\other\\dist')).toBe('D:\\other\\dist')
    expect(relativeToProject('E:\\proj', 'E:\\proj')).toBe('E:\\proj')
    // 只是前缀相同但不是同一层：proj2 不是 proj 的子目录
    expect(relativeToProject('E:\\proj', 'E:\\proj2\\dist')).toBe('E:\\proj2\\dist')
  })

  it('根目录为空时不做任何转换', () => {
    expect(relativeToProject('', 'E:\\proj\\dist')).toBe('E:\\proj\\dist')
  })
})

describe('resolveWithinProject', () => {
  it('相对写法拼到项目根下', () => {
    expect(resolveWithinProject('E:\\proj', 'dist')).toBe('E:\\proj\\dist')
    expect(resolveWithinProject('E:\\proj\\', 'packages/web/dist')).toBe(
      'E:\\proj\\packages\\web\\dist'
    )
  })

  it('已经是绝对路径的原样返回', () => {
    expect(resolveWithinProject('E:\\proj', 'D:\\out\\dist')).toBe('D:\\out\\dist')
    expect(resolveWithinProject('E:\\proj', '\\\\nas\\share\\dist')).toBe('\\\\nas\\share\\dist')
  })

  it('留空时返回空串，界面据此不显示提示行', () => {
    expect(resolveWithinProject('E:\\proj', '')).toBe('')
    expect(resolveWithinProject('E:\\proj', '   ')).toBe('')
  })
})
