import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useDraftField } from './use-draft-field'

describe('useDraftField', () => {
  it('初始化时把外部值抄进草稿', () => {
    const settings = ref('程序名')
    const draft = useDraftField(() => settings.value)
    expect(draft.value).toBe('程序名')
  })

  it('外部值变化时草稿跟着走', async () => {
    const settings = ref('a')
    const draft = useDraftField(() => settings.value)
    settings.value = 'b'
    await nextTick()
    expect(draft.value).toBe('b')
  })

  it('用户正在打的草稿不被外部值冲掉,除非外部值真的变了', async () => {
    const settings = ref('a')
    const draft = useDraftField(() => settings.value)
    draft.value = 'a 草稿'
    await nextTick()
    expect(draft.value).toBe('a 草稿')
    settings.value = 'a' // 同值再赋值不触发 watch,草稿不动
    await nextTick()
    expect(draft.value).toBe('a 草稿')
    settings.value = 'b'
    await nextTick()
    expect(draft.value).toBe('b')
  })

  it('read 从当前对象里取值:随选中对象重置的草稿(抽屉用法)', async () => {
    const project = ref<{ id: string; name: string } | null>({ id: 'p1', name: '项目一' })
    const draft = useDraftField(
      () => project.value?.id ?? '',
      () => project.value?.name ?? ''
    )
    expect(draft.value).toBe('项目一')

    project.value = { id: 'p2', name: '项目二' }
    await nextTick()
    expect(draft.value).toBe('项目二')

    project.value = null
    await nextTick()
    expect(draft.value).toBe('')
  })
})
