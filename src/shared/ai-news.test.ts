/**
 * ai-news 纯逻辑的单测：三种载荷解析、缓存收敛（含 v1 迁移）、每源退避与合并视图。
 */
import { describe, expect, it } from 'vitest'
import {
  AI_NEWS_BACKOFF_BASE_MS,
  AI_NEWS_BACKOFF_MAX_MS,
  AI_NEWS_MAX_ITEMS_PER_SOURCE,
  AI_NEWS_MERGED_MAX,
  ARTICLE_MAX_PARAGRAPHS,
  applySourceFailure,
  applySourceNotModified,
  applySourceSuccess,
  backoffDelayMs,
  emptyAiNewsCache,
  emptySourceState,
  extractArticle,
  latestUpdatedAt,
  mergedItems,
  parseAtom,
  parseHfDailyPapers,
  parseRss,
  parseSourcePayload,
  sanitizeAiNewsCache,
  shouldFetchSource,
  stripHtml,
  type AiNewsItem
} from './ai-news'

/** 机器之心风格的 RSS 2.0（CDATA 被实体转义过——实测就是这样） */
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>机器之心</title>
    <item>
      <title>第一篇：AI 的下一站</title>
      <description>&lt;![CDATA[摘要 &amp; 引号 &quot;测试&quot;]]&gt;</description>
      <pubDate>Fri, 18 Sep 2026 15:56:50 +0800</pubDate>
      <guid isPermaLink="false">ItemOne-guid</guid>
      <link>https://www.jiqizhixin.com/articles/20260918-1</link>
      <source>机器之心</source>
    </item>
    <item>
      <title>第二篇：Agent 时代</title>
      <description>&lt;![CDATA[纯文本摘要，没有 HTML]]&gt;</description>
      <pubDate>Thu, 17 Sep 2026 09:00:00 +0800</pubDate>
      <guid isPermaLink="false">ItemTwo-guid</guid>
      <link>https://www.jiqizhixin.com/articles/20260917-2</link>
    </item>
    <item>
      <title>无时间条目</title>
      <description>普通文本没有 CDATA</description>
      <guid isPermaLink="false">ItemThree-guid</guid>
      <link>https://www.jiqizhixin.com/articles/20260916-3</link>
    </item>
  </channel>
</rss>`

/** arXiv API 风格的 Atom（`<link>` 是属性元素，`<id>` 才是摘要地址） */
const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2609.20822v1</id>
    <updated>2026-09-17T17:59:59Z</updated>
    <published>2026-09-17T17:59:58Z</published>
    <title>Coding Agents with an Obstacle-Aware Harness</title>
    <summary>  Coding agents have emerged as a promising paradigm
      for robot manipulation.  </summary>
    <link href="http://arxiv.org/abs/2609.20822v1" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2609.11111v1</id>
    <published>2026-09-16T10:00:00Z</published>
    <title>第二篇论文</title>
    <summary>第二篇摘要</summary>
  </entry>
</feed>`

/** HF Daily Papers 的 JSON（paper 本体 + 外层镜像字段） */
const SAMPLE_HF = JSON.stringify([
  {
    paper: {
      id: '2609.18323',
      title: 'Can MiniMax-H3 Reason About the Physical World?',
      summary: 'Recent Omni-Modal Generative Models have advanced content generation.',
      publishedAt: '2026-09-15T20:00:00.000Z',
      upvotes: 19
    },
    publishedAt: '2026-09-15T20:00:00.000Z',
    title: 'Can MiniMax-H3 Reason About the Physical World?',
    summary: 'Recent Omni-Modal Generative Models have advanced content generation.'
  },
  {
    // 只有 paper 里有字段：外层缺失时要能回落
    paper: {
      id: '2609.20817',
      title: 'FAMOS: Feed-Forward 3D Articulation Modeling',
      summary: 'Modeling articulated objects from sparse monocular views.',
      publishedAt: '2026-09-16T20:00:00.000Z'
    }
  },
  { paper: { id: '9999.1' } } // 没有标题：丢掉
])

describe('parseRss', () => {
  it('解析出全部条目并按时序从新到旧排', () => {
    const items = parseRss(SAMPLE_RSS)
    expect(items).toHaveLength(3)
    expect(items[0].title).toBe('第一篇：AI 的下一站')
    expect(items[2].title).toBe('无时间条目')
  })

  it('解出实体、去 HTML 标记、剥 CDATA', () => {
    const first = parseRss(SAMPLE_RSS)[0]
    expect(first.summary).toBe('摘要 & 引号 "测试"')
    expect(first.pubDate).toBe(new Date('2026-09-18T15:56:50+08:00').getTime())
    expect(first.guid).toBe('ItemOne-guid')
    expect(first.source).toBe('机器之心')
  })

  it('guid 缺省时回落 link', () => {
    const items = parseRss('<rss><item><title>无 guid</title><link>https://x.com/g</link></item></rss>')
    expect(items[0].guid).toBe('https://x.com/g')
  })

  it('无 title 的条目被丢掉', () => {
    const items = parseRss('<rss><item><link>https://x.com/1</link></item><item><title>有标题</title></item></rss>')
    expect(items).toHaveLength(1)
  })

  it('空文本返回空数组', () => {
    expect(parseRss('')).toEqual([])
  })
})

describe('parseAtom', () => {
  it('用 id 当链接并解析出字段', () => {
    const items = parseAtom(SAMPLE_ATOM)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Coding Agents with an Obstacle-Aware Harness')
    expect(items[0].link).toBe('http://arxiv.org/abs/2609.20822v1')
    expect(items[0].guid).toBe('http://arxiv.org/abs/2609.20822v1')
    expect(items[0].pubDate).toBe(Date.parse('2026-09-17T17:59:58Z'))
    // 摘要把换行与多余空白压平
    expect(items[0].summary).toBe('Coding agents have emerged as a promising paradigm for robot manipulation.')
  })

  it('按时间从新到旧排', () => {
    const items = parseAtom(SAMPLE_ATOM)
    expect(items[0].pubDate).toBeGreaterThan(items[1].pubDate)
  })
})

describe('parseHfDailyPapers', () => {
  it('解析出条目、拼出 papers 链接', () => {
    const items = parseHfDailyPapers(SAMPLE_HF)
    expect(items).toHaveLength(2) // 第三条没有标题被丢掉
    const first = items.find((item) => item.link.includes('2609.18323'))
    expect(first?.link).toBe('https://huggingface.co/papers/2609.18323')
    expect(first?.guid).toBe('https://huggingface.co/papers/2609.18323')
    expect(first?.source).toBe('') // 源名由适配层统一盖
    // 按时间从新到旧：09-16 那条排在 09-15 那条前面
    expect(items[0].link).toContain('2609.20817')
  })

  it('外层字段缺失时回落到 paper.*', () => {
    const items = parseHfDailyPapers(SAMPLE_HF)
    const second = items.find((item) => item.link.includes('2609.20817'))
    expect(second?.title).toBe('FAMOS: Feed-Forward 3D Articulation Modeling')
    expect(second?.summary).toBe('Modeling articulated objects from sparse monocular views.')
    expect(second?.pubDate).toBe(Date.parse('2026-09-16T20:00:00.000Z'))
  })

  it('坏 JSON 返回空数组而不是抛错', () => {
    expect(parseHfDailyPapers('not json')).toEqual([])
    expect(parseHfDailyPapers('{"a":1}')).toEqual([])
    expect(parseHfDailyPapers('')).toEqual([])
  })
})

describe('parseSourcePayload', () => {
  it('按格式分发到对应解析器', () => {
    expect(parseSourcePayload('rss', SAMPLE_RSS)).toHaveLength(3)
    expect(parseSourcePayload('atom', SAMPLE_ATOM)).toHaveLength(2)
    expect(parseSourcePayload('json-hf-papers', SAMPLE_HF)).toHaveLength(2)
  })
})

describe('单源上限', () => {
  it('超出上限时截断', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      `<item><title>标题 ${index}</title><link>https://x.com/${index}</link></item>`
    ).join('')
    expect(parseRss(`<rss>${many}</rss>`).length).toBe(AI_NEWS_MAX_ITEMS_PER_SOURCE)
  })
})

describe('stripHtml', () => {
  it('去标签并压空白', () => {
    expect(stripHtml('<p>第一段</p><p>第二段</p>')).toBe('第一段 第二段')
  })
})

describe('extractArticle', () => {
  /** 一段像样的新闻正文页：导航、脚本、正文、评论区、页脚 */
  const PAGE = `<!DOCTYPE html>
<html><head>
  <title>某篇报道</title>
  <style>.a{color:red}</style>
  <script>var x = 'id="comments"';</script>
</head><body>
  <nav><p>首页 关于 联系</p></nav>
  <article>
    <h2>小标题一：事情是怎么开始的</h2>
    <p>这是正文的第一段，长度足够，应该被保留下来作为站内阅读的第一段内容。</p>
    <p>第二段同样是一段真正的正文，里面有 <strong>强调</strong> 与 <a href="https://x.com">链接</a>，标签要去掉。</p>
    <p>短</p>
    <p>&nbsp;&nbsp;带实体 &amp; 与引号 &quot;引号&quot; 的段落也要正确解码，长度足够。</p>
    <h3>小标题二</h3>
    <p>第三段正文，放在一个三级小标题之后，仍然应当按顺序出现在正文里。</p>
  </article>
  <div id="comments">
    <p>这是一条很长的读者评论，内容足够长但它属于评论区，不该出现在正文里。</p>
  </div>
  <footer><p>版权所有，这段也很长但是页脚内容，不该出现。</p></footer>
</body></html>`

  it('按顺序取出正文段落，去掉标签与实体', () => {
    const article = extractArticle(PAGE)
    expect(article.paragraphs[0]).toBe('小标题一：事情是怎么开始的')
    expect(article.paragraphs[1]).toContain('这是正文的第一段')
    expect(article.paragraphs[2]).toContain('强调')
    expect(article.paragraphs[2]).not.toContain('<strong>')
    expect(article.paragraphs[3]).toBe('带实体 & 与引号 "引号" 的段落也要正确解码，长度足够。')
    expect(article.truncated).toBe(false)
  })

  it('过短的段落（导航、按钮）被丢掉', () => {
    const article = extractArticle(PAGE)
    expect(article.paragraphs.some((p) => p === '短')).toBe(false)
    expect(article.paragraphs.some((p) => p.includes('首页 关于 联系'))).toBe(false)
  })

  it('脚本与样式进不了正文', () => {
    const article = extractArticle(PAGE)
    expect(article.paragraphs.some((p) => p.includes('var x'))).toBe(false)
    expect(article.paragraphs.some((p) => p.includes('color:red'))).toBe(false)
  })

  it('评论区与页脚在截断点之后，不会混进正文', () => {
    const article = extractArticle(PAGE)
    expect(article.paragraphs.some((p) => p.includes('读者评论'))).toBe(false)
    expect(article.paragraphs.some((p) => p.includes('版权所有'))).toBe(false)
  })

  it('script 里的 id="comments" 字样不会把正文提前切断', () => {
    // 上面那段 <script> 恰好含 id="comments"：先删脚本再找分界，正文才完整
    const article = extractArticle(PAGE)
    expect(article.paragraphs.length).toBeGreaterThanOrEqual(5)
  })

  it('提不出来时返回空数组（交给调用方降级），不抛错', () => {
    expect(extractArticle('').paragraphs).toEqual([])
    expect(extractArticle('<html><body><div>没有段落标签</div></body></html>').paragraphs).toEqual([])
  })

  it('过长时截断并如实标记', () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => `<p>这是第 ${i} 段正文，长度足够被当成正文段落保留下来。</p>`
    ).join('')
    const article = extractArticle(`<html><body>${many}</body></html>`)
    expect(article.truncated).toBe(true)
    expect(article.paragraphs.length).toBeLessThanOrEqual(ARTICLE_MAX_PARAGRAPHS)
  })

  /** 真实页面那样：正文在一个容器里，侧栏与相关阅读在容器外 */
  const LAYOUT_PAGE = `<html><body>
  <div class="nav"><p>首页 快讯 融资 机器人 关于我们</p></div>
  <div class="content">
    <div class="article">
      <h2>正文的小标题</h2>
      <p>正文第一段，长度足够，应该被当成正文保留下来。</p>
      <div class="figure"><p>图注：这是正文里嵌着的一个 div，长度也足够，不该把正文截断。</p></div>
      <p>正文第二段，在嵌套的 div 之后，仍然属于正文，必须出现。</p>
    </div>
    <div class="xiangguan"><h3>相关阅读</h3><ul><li>另一篇文章的标题在这里</li></ul></div>
  </div>
  <div class="content_right">
    <div class="yaowen"><h3>热门文章</h3><p>侧栏里的一段推荐语，长度足够但它不是正文。</p></div>
  </div>
</body></html>`

  it('按正文容器取子树：嵌套的 div 不会把正文截断', () => {
    const article = extractArticle(LAYOUT_PAGE)
    expect(article.paragraphs).toContain('正文第二段，在嵌套的 div 之后，仍然属于正文，必须出现。')
    expect(article.paragraphs).toContain('图注：这是正文里嵌着的一个 div，长度也足够，不该把正文截断。')
  })

  it('容器之外的侧栏与相关阅读进不来', () => {
    const article = extractArticle(LAYOUT_PAGE)
    expect(article.paragraphs.some((p) => p.includes('侧栏里的一段推荐语'))).toBe(false)
    expect(article.paragraphs.some((p) => p.includes('相关阅读'))).toBe(false)
    expect(article.paragraphs.some((p) => p.includes('热门文章'))).toBe(false)
    expect(article.paragraphs.some((p) => p.includes('首页 快讯'))).toBe(false)
  })

  it('词边界卡住形近的类名：content_right / article_info 不算正文容器', () => {
    const page = `<html><body>
      <div class="article_info"><p>这里是文章信息栏的一段，长度足够但属于元信息区域。</p></div>
      <div class="content_right"><p>这里是右栏的一段推荐文字，长度足够但不是正文内容。</p></div>
      <article><p>这才是正文那一段，长度足够，应该被保留在提取结果里。</p></article>
    </body></html>`
    const article = extractArticle(page)
    expect(article.paragraphs).toEqual(['这才是正文那一段，长度足够，应该被保留在提取结果里。'])
  })

  it('认不出容器时退回整篇（末尾分界仍然生效）', () => {
    const page = `<html><body>
      <p>没有正文容器标记的一段正文，长度足够，应该被保留下来。</p>
      <div id="comments"><p>评论区里一段很长的读者留言，长度足够但不该出现在正文里。</p></div>
    </body></html>`
    const article = extractArticle(page)
    expect(article.paragraphs).toEqual(['没有正文容器标记的一段正文，长度足够，应该被保留下来。'])
  })
})

describe('sanitizeAiNewsCache', () => {
  it('空输入回到空缓存', () => {
    const cache = sanitizeAiNewsCache(null)
    expect(cache.version).toBe(2)
    expect(cache.sources).toEqual({})
  })

  it('收敛各源状态与条目', () => {
    const cache = sanitizeAiNewsCache({
      sources: {
        qbitai: {
          updatedAt: 123,
          etag: 'W/"a"',
          nextFetchAt: -5,
          failCount: -2,
          lastError: '限流',
          items: [{ guid: 'g', title: 't', link: 'l', pubDate: 1 }]
        }
      }
    })
    const state = cache.sources.qbitai
    expect(state.updatedAt).toBe(123)
    expect(state.etag).toBe('W/"a"')
    expect(state.nextFetchAt).toBe(0) // 负值夹到 0
    expect(state.failCount).toBe(0)
    expect(state.lastError).toBe('限流')
    expect(state.items).toHaveLength(1)
  })

  it('没有标题的条目被滤掉（避免界面上出现空行）', () => {
    const cache = sanitizeAiNewsCache({
      sources: { s: { items: [{ title: '有' }, { title: '' }, { guid: 'only-guid' }] } }
    })
    expect(cache.sources.s.items).toHaveLength(1)
  })

  it('v1 单源结构搬进 sources.jiqizhixin，内容不丢', () => {
    const cache = sanitizeAiNewsCache({
      version: 1,
      updatedAt: 777,
      etag: 'W/"old"',
      nextFetchAt: 888,
      failCount: 1,
      items: [{ guid: 'g1', title: '旧缓存的一条', link: 'https://x.com/1', pubDate: 5 }]
    })
    const state = cache.sources.jiqizhixin
    expect(cache.version).toBe(2)
    expect(state.updatedAt).toBe(777)
    expect(state.etag).toBe('W/"old"')
    expect(state.nextFetchAt).toBe(888)
    expect(state.items[0].title).toBe('旧缓存的一条')
  })

  it('v1 且从来没有内容时不会凭空造出一个源', () => {
    const cache = sanitizeAiNewsCache({ version: 1, updatedAt: 0, items: [] })
    expect(cache.sources).toEqual({})
  })
})

describe('每源调度策略', () => {
  it('没有状态或过了 nextFetchAt 就该拉', () => {
    expect(shouldFetchSource(undefined, 100)).toBe(true)
    expect(shouldFetchSource({ ...emptySourceState(), nextFetchAt: 100 }, 99)).toBe(false)
    expect(shouldFetchSource({ ...emptySourceState(), nextFetchAt: 100 }, 100)).toBe(true)
  })

  it('成功：续期该源的间隔、清零失败计数与错误', () => {
    const before = { ...emptySourceState(), failCount: 3, lastError: '限流' }
    const after = applySourceSuccess(before, [], 'W/"e"', 3 * 3600_000, 1000)
    expect(after.updatedAt).toBe(1000)
    expect(after.nextFetchAt).toBe(1000 + 3 * 3600_000)
    expect(after.failCount).toBe(0)
    expect(after.lastError).toBe('')
  })

  it('304：只续期并换 ETag，已有条目留着', () => {
    const before = { ...emptySourceState(), etag: 'W/"old"', items: [item('旧')] }
    const after = applySourceNotModified(before, 'W/"new"', 3600_000, 2000)
    expect(after.etag).toBe('W/"new"')
    expect(after.items).toHaveLength(1)
    expect(after.nextFetchAt).toBe(2000 + 3600_000)
  })

  it('304 但服务端没给新 ETag 时保留旧的', () => {
    const after = applySourceNotModified({ ...emptySourceState(), etag: 'W/"keep"' }, '', 1000, 0)
    expect(after.etag).toBe('W/"keep"')
  })

  it('失败：指数退避、累加计数、记下原因', () => {
    const first = applySourceFailure(undefined, 1000, '限流了')
    expect(first.failCount).toBe(1)
    expect(first.lastError).toBe('限流了')
    expect(first.nextFetchAt).toBe(1000 + AI_NEWS_BACKOFF_BASE_MS)

    const second = applySourceFailure(first, first.nextFetchAt, '还是失败')
    expect(second.failCount).toBe(2)
    expect(second.nextFetchAt).toBe(first.nextFetchAt + AI_NEWS_BACKOFF_BASE_MS * 2)
  })

  it('退避封顶在 2 小时', () => {
    expect(backoffDelayMs(0)).toBe(AI_NEWS_BACKOFF_BASE_MS)
    expect(backoffDelayMs(10)).toBe(AI_NEWS_BACKOFF_MAX_MS)
  })
})

describe('合并视图', () => {
  it('只并启用源，按时间从新到旧', () => {
    const cache = cacheOf({
      qbitai: [item('量子位旧', 100), item('量子位新', 300)],
      hf: [item('HF 中', 200)]
    })
    const merged = mergedItems(cache, ['qbitai', 'hf'])
    expect(merged.map((i) => i.title)).toEqual(['量子位新', 'HF 中', '量子位旧'])
  })

  it('没启用的源不出现', () => {
    const cache = cacheOf({ qbitai: [item('量子位', 100)], hf: [item('HF', 200)] })
    expect(mergedItems(cache, ['hf']).map((i) => i.title)).toEqual(['HF'])
  })

  it('同一个链接在多源出现时先去重（按启用顺序先到先得）', () => {
    const dup: AiNewsItem = { guid: 'g', title: '同一条', link: 'https://x.com/same', pubDate: 100, summary: '', source: 'A' }
    const cache = cacheOf({ qbitai: [dup], hf: [{ ...dup, source: 'B' }] })
    const merged = mergedItems(cache, ['qbitai', 'hf'])
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('A')
  })

  it('截断到总上限', () => {
    const many = Array.from({ length: 60 }, (_, i) => item(`第 ${i} 条`, i))
    const merged = mergedItems(cacheOf({ qbitai: many }), ['qbitai'])
    expect(merged.length).toBeLessThanOrEqual(AI_NEWS_MERGED_MAX)
  })

  it('没有任何源时返回空数组', () => {
    expect(mergedItems(emptyAiNewsCache(), ['qbitai'])).toEqual([])
  })

  it('最近更新时间取启用源里最大的那个', () => {
    const cache = cacheOf({ qbitai: [], hf: [] })
    cache.sources.qbitai.updatedAt = 500
    cache.sources.hf.updatedAt = 900
    expect(latestUpdatedAt(cache, ['qbitai', 'hf'])).toBe(900)
    expect(latestUpdatedAt(cache, ['qbitai'])).toBe(500)
    expect(latestUpdatedAt(cache, ['unknown'])).toBe(0)
  })
})

function item(title: string, pubDate = 0): AiNewsItem {
  return { guid: title, title, link: `https://x.com/${encodeURIComponent(title)}`, pubDate, summary: '', source: '' }
}

function cacheOf(sources: Record<string, AiNewsItem[]>) {
  const cache = emptyAiNewsCache()
  for (const [id, items] of Object.entries(sources)) {
    cache.sources[id] = { ...emptySourceState(), items }
  }
  return cache
}