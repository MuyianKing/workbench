import { describe, expect, it } from 'vitest'
import { setVideoStageHost, useVideoStageHost } from './use-video-stage'

describe('use-video-stage', () => {
  it('注册的宿主元素从读取方原样拿到', () => {
    // 测的只是「注册什么读出什么」的引用传递，不需要真 DOM（测试环境没有 document）
    const el = {} as HTMLElement
    setVideoStageHost(el)
    expect(useVideoStageHost().value).toBe(el)
  })

  it('置 null 表示宿主还没就位（视频页没挂载过）', () => {
    setVideoStageHost(null)
    expect(useVideoStageHost().value).toBeNull()
  })
})
