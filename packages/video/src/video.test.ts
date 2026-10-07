import type { VideoEntry } from './video'
import { describe, expect, it } from 'vitest'
import { buildVideoTree, clampVideoFloatHeight, clampVideoFloatPercent, clampVideoFloatWidth, clampVideoRate, countVideos, findVideoNode, fitVideoFloatGeometry, formatVideoTime, isVideoFile, nextVideoNode, nextVideoRate, pushVideoHistory, removeFromVideoHistory, resizeVideoFloat, sanitizeVideoHistory, sanitizeVideoLastRel, sanitizeVideoRoot, sanitizeVideoTreeExpanded, VIDEO_FLOAT_SIZE_DEFAULT, VIDEO_FLOAT_SIZE_MAX, VIDEO_FLOAT_SIZE_MIN, VIDEO_HISTORY_MAX, VIDEO_NEXT_SECONDS, VIDEO_RATES, VIDEO_SEEK_SECONDS, VIDEO_TREE_EXPANDED_MAX, videoChain, videoDisplayName } from './video'

function dir(rel: string): VideoEntry {
  return { rel, name: relName(rel), isDir: true }
}

function video(rel: string, duration = 0): VideoEntry {
  return { rel, name: relName(rel), isDir: false, duration }
}

/** 路径的最后一段（与 Rust 回来的 name 字段同一个写法） */
function relName(rel: string): string {
  const parts = rel.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** 树里某一层的名字（按显示顺序），写断言时比整棵树好读 */
function namesOf(nodes: readonly { name: string }[]): string[] {
  return nodes.map(node => node.name)
}

describe('mP4 过滤与建树', () => {
  it('只收 mp4 与文件夹，字幕、封面等不进树', () => {
    const tree = buildVideoTree([
      dir('第一季'),
      video('第一季/第1集.mp4'),
      video('第一季/第1集.ass'),
      video('封面.jpg'),
      video('第一季/花絮.MP4'),
    ])

    expect(namesOf(tree)).toEqual(['第一季'])
    expect(namesOf(tree[0].children ?? [])).toEqual(['第1集', '花絮'])
  })

  it('文件夹在前、视频在后，同层按名字排（numeric）', () => {
    const tree = buildVideoTree([
      video('第10集.mp4'),
      dir('花絮'),
      video('第9集.mp4'),
      dir(' extras '),
      video('第1集.mp4'),
    ])

    // 与笔记树同一条排序规则（zh-Hans-CN），中文名与英文名的先后由它说了算，这里只锁住「稳定」
    expect(namesOf(tree)).toEqual(['花絮', 'extras', '第1集', '第9集', '第10集'])
  })

  it('父目录不在清单里时挂到根上', () => {
    const tree = buildVideoTree([video('丢失的文件夹/第1集.mp4')])
    expect(namesOf(tree)).toEqual(['第1集'])
  })

  it('duration 只认正的有限数，认不出按 0', () => {
    const tree = buildVideoTree([video('a.mp4', 95), { rel: 'b.mp4', name: 'b.mp4', isDir: false }])
    expect(findVideoNode(tree, 'a.mp4')?.duration).toBe(95)
    expect(findVideoNode(tree, 'b.mp4')?.duration).toBe(0)
  })

  it('isVideoFile 与显示名去后缀', () => {
    expect(isVideoFile('movie.MP4')).toBe(true)
    expect(isVideoFile('movie.mkv')).toBe(false)
    expect(videoDisplayName('第1集.mp4')).toBe('第1集')
  })

  it('计数与按链找节点', () => {
    const tree = buildVideoTree([dir('a'), video('a/1.mp4'), video('a/2.mp4'), video('b.mp4')])
    expect(countVideos(tree)).toBe(3)
    expect(videoChain(tree, 'a/2.mp4').map(node => node.name)).toEqual(['a', '2'])
    expect(videoChain(tree, '不存在的.mp4')).toEqual([])
    expect(findVideoNode(tree, 'a/2.mp4')?.kind).toBe('video')
  })
})

describe('目录收敛与历史', () => {
  it('目录收敛复用笔记文件夹那条规矩（盘根留住分隔符）', () => {
    expect(sanitizeVideoRoot(' D:\\电影\\ ')).toBe('D:\\电影')
    expect(sanitizeVideoRoot('C:\\')).toBe('C:\\')
    expect(sanitizeVideoRoot('')).toBe('')
  })

  it('历史去重、上限截断，打开过的排最前', () => {
    expect(sanitizeVideoHistory(['D:\\a', 'D:\\a', ''])).toEqual(['D:\\a'])
    // 推入的那条原样排前（它的大小写说了算），已在清单里的同名条目让位
    expect(pushVideoHistory(['D:\\a', 'D:\\b'], 'd:\\A')).toEqual(['d:\\A', 'D:\\b'])
    expect(removeFromVideoHistory(['D:\\a', 'D:\\b'], 'd:\\a')).toEqual(['D:\\b'])

    const full = Array.from({ length: VIDEO_HISTORY_MAX + 2 }, (_, i) => `D:\\v${i}`)
    expect(sanitizeVideoHistory(full)).toHaveLength(VIDEO_HISTORY_MAX)
  })

  it('展开清单收敛：分隔符统一、丢 .. 与重复', () => {
    expect(sanitizeVideoTreeExpanded(['a\\b', 'A/B', '../outside', ''])).toEqual(['a/b'])
    const full = Array.from({ length: VIDEO_TREE_EXPANDED_MAX + 1 }, (_, i) => `dir${i}`)
    expect(sanitizeVideoTreeExpanded(full)).toHaveLength(VIDEO_TREE_EXPANDED_MAX)
  })

  it('上次打开的视频收敛：归一化、丢 .. 与空值', () => {
    expect(sanitizeVideoLastRel(' 第一季\\第1集.mp4 ')).toBe('第一季/第1集.mp4')
    expect(sanitizeVideoLastRel('../outside.mp4')).toBe('')
    expect(sanitizeVideoLastRel('')).toBe('')
    expect(sanitizeVideoLastRel(undefined)).toBe('')
  })
})

describe('播放速率', () => {
  it('档位表有序且含常速', () => {
    expect(VIDEO_RATES).toContain(1)
    expect([...VIDEO_RATES]).toEqual([...VIDEO_RATES].sort((a, b) => a - b))
  })

  it('升一档 / 降一档，顶到头不动', () => {
    expect(nextVideoRate(1, 1)).toBe(1.25)
    expect(nextVideoRate(1, -1)).toBe(0.75)
    expect(nextVideoRate(3, 1)).toBe(3)
    expect(nextVideoRate(0.5, -1)).toBe(0.5)
  })

  it('认不出的取值夹回最近的档位', () => {
    expect(clampVideoRate(1.3)).toBe(1.25)
    expect(clampVideoRate(undefined)).toBe(1)
    expect(clampVideoRate(Number.NaN)).toBe(1)
  })

  it('快进步长是定死的常量（快捷键提示要跟它一致）', () => {
    expect(VIDEO_SEEK_SECONDS).toBe(5)
  })
})

describe('画中画小窗', () => {
  it('位置收敛到 0–100 的视口百分比，认不出的回到 0', () => {
    expect(clampVideoFloatPercent(-20)).toBe(0)
    expect(clampVideoFloatPercent(100)).toBe(100)
    expect(clampVideoFloatPercent(137.5)).toBe(100)
    expect(clampVideoFloatPercent(undefined)).toBe(0)
    expect(clampVideoFloatPercent(Number.NaN)).toBe(0)
  })

  it('尺寸收敛到边界内，缺失回到默认尺寸', () => {
    expect(clampVideoFloatWidth(100)).toBe(VIDEO_FLOAT_SIZE_MIN.width)
    expect(clampVideoFloatWidth(9999)).toBe(VIDEO_FLOAT_SIZE_MAX.width)
    expect(clampVideoFloatWidth(402.4)).toBe(402)
    expect(clampVideoFloatHeight(1)).toBe(VIDEO_FLOAT_SIZE_MIN.height)
    expect(clampVideoFloatHeight(9999)).toBe(VIDEO_FLOAT_SIZE_MAX.height)
    expect(clampVideoFloatWidth(undefined)).toBe(VIDEO_FLOAT_SIZE_DEFAULT.width)
    expect(clampVideoFloatHeight(undefined)).toBe(VIDEO_FLOAT_SIZE_DEFAULT.height)
  })

  it('默认小窗是 16:9（320×180），最小尺寸也是', () => {
    expect(VIDEO_FLOAT_SIZE_DEFAULT).toEqual({ width: 320, height: 180 })
    expect(VIDEO_FLOAT_SIZE_MIN.width / VIDEO_FLOAT_SIZE_MIN.height).toBeCloseTo(16 / 9)
  })
})

describe('浮窗贴合与缩放', () => {
  const viewport = { w: 1600, h: 900 }

  it('落盘值折成视口内的渲染盒子：超界的宽高与落点都压回来', () => {
    expect(fitVideoFloatGeometry({ x: 50, y: 25, w: 320, h: 180 }, viewport)).toEqual({
      left: 800,
      top: 225,
      width: 320,
      height: 180,
    })
    // 比视口还大的宽高压到视口为止（渲染不可能比视口大）
    expect(fitVideoFloatGeometry({ x: 0, y: 0, w: 9999, h: 9999 }, viewport)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    })
  })

  it('抓右下角：左上角钉住，宽高随位移长，越界压回边界', () => {
    expect(resizeVideoFloat({ x: 20, y: 10, w: 320, h: 180 }, viewport, 'right', 80, 20)).toEqual({
      x: 20,
      y: 10,
      w: 400,
      h: 200,
    })
    expect(resizeVideoFloat({ x: 20, y: 10, w: 320, h: 180 }, viewport, 'right', -9999, -9999)).toEqual({
      x: 20,
      y: 10,
      w: VIDEO_FLOAT_SIZE_MIN.width,
      h: VIDEO_FLOAT_SIZE_MIN.height,
    })
  })

  it('抓左下角：右上角钉住 —— 往左拖是长大，宽度的变化全折进左缘', () => {
    const next = resizeVideoFloat({ x: 80, y: 10, w: 320, h: 180 }, viewport, 'left', -80, 20)
    // 右缘钉在 1280 + 320 = 1600 不动：宽长到 400，左缘退到 1200（视口百分比 75）
    expect(next.w).toBe(400)
    expect(next.h).toBe(200)
    expect(next.x).toBeCloseTo(75)
    expect(next.y).toBe(10)
  })

  it('左缘不得越过视口左缘：宽最多长到右缘那么宽', () => {
    // 右缘在 560px：宽再想长也长不过右缘（左缘钉在 0，正好贴满左半边）
    const next = resizeVideoFloat({ x: 20, y: 0, w: 240, h: 180 }, viewport, 'left', -9999, 0)
    expect(next.w).toBe(560)
    expect(next.x).toBe(0)

    // 视口比最小宽还窄的极端情形：保住最小宽，左缘钉在 0（越界的那点交给渲染再压）
    const tiny = resizeVideoFloat({ x: 0, y: 0, w: 240, h: 180 }, { w: 200, h: 900 }, 'left', -9999, 0)
    expect(tiny.w).toBe(VIDEO_FLOAT_SIZE_MIN.width)
    expect(tiny.x).toBe(0)
  })
})

describe('播放顺序', () => {
  it('下一个按树的展示顺序摊平：文件夹在前、深度优先，最后一个没有下一个', () => {
    const tree = buildVideoTree([dir('a'), video('a/1.mp4'), video('a/2.mp4'), video('b.mp4')])
    expect(nextVideoNode(tree, 'a/1.mp4')?.rel).toBe('a/2.mp4')
    expect(nextVideoNode(tree, 'a/2.mp4')?.rel).toBe('b.mp4')
    expect(nextVideoNode(tree, 'b.mp4')).toBeNull()
  })

  it('路径先归一化再匹配，认不出的返回 null', () => {
    const tree = buildVideoTree([video('1.mp4'), video('2.mp4')])
    expect(nextVideoNode(tree, '\\1.mp4')?.rel).toBe('2.mp4')
    expect(nextVideoNode(tree, '不存在的.mp4')).toBeNull()
    expect(nextVideoNode(tree, '')).toBeNull()
  })

  it('播完接下去的倒计时时长是 3 秒（浮层文案与进度线都按它走）', () => {
    expect(VIDEO_NEXT_SECONDS).toBe(3)
  })
})

describe('时间与体积', () => {
  it('秒 → h:mm:ss', () => {
    expect(formatVideoTime(0)).toBe('0:00')
    expect(formatVideoTime(65)).toBe('1:05')
    expect(formatVideoTime(3600 + 60 + 5)).toBe('1:01:05')
    expect(formatVideoTime(Number.NaN)).toBe('0:00')
  })
})
