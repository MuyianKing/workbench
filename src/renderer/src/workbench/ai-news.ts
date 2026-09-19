/**
 * AI 热点（首页「AI 热点」卡片）的适配层实现。
 *
 * **数据流**：缓存住在 `%APPDATA%\Workbench\data\ai-news.json`（Rust 侧 JsonStore 管读写），
 * 源清单住在 Rust 的 `SOURCES`。这一层做的是「读缓存 + 清单 → 挑出到期的源 → 并发拉 → 解析 →
 * 按源写回 → 合并出视图」，一切策略来自 shared/ai-news.ts（每源 TTL / 退避 / 合并去重），
 * 这里不自己拍一套。
 *
 * **为什么会出网**：这张卡片是那份白名单的唯一出口，而且地址只在 Rust 侧 ——
 * 这一层只能报源 id。卡片没画在首页上、或源没到期，都不发请求。
 */
import {
  applySourceFailure,
  applySourceNotModified,
  applySourceSuccess,
  extractArticle,
  latestUpdatedAt,
  mergedItems,
  parseSourcePayload,
  sanitizeAiNewsCache,
  shouldFetchSource,
  type AiNewsArticle,
  type AiNewsCache,
  type AiNewsRefreshResult,
  type AiNewsSourceInfo,
  type AiNewsView
} from '@shared/ai-news'
import { fail, ok } from '@shared/result'
import type { Result } from '@shared/types'
import { invoke } from './bridge'

/** 问一次源清单。它只读宿主侧的白名单，不走网络，所以每次刷新都现问一遍 */
async function loadSources(): Promise<AiNewsSourceInfo[]> {
  return (await invoke<AiNewsSourceInfo[]>('ai_news_sources')) ?? []
}

async function loadCache(): Promise<AiNewsCache> {
  const raw = await invoke<unknown>('ai_news_load')
  return sanitizeAiNewsCache(raw)
}

async function saveCache(cache: AiNewsCache): Promise<void> {
  await invoke('ai_news_save', { value: cache })
}

function reasonOf(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/**
 * 拼出界面要的那一份视图。
 *
 * 传给合并视图的是**清单顺序的 id**：缓存里可能还留着已经撤掉的源（比如单源时代那份），
 * 那些 id 不在清单里，因此不会被并进来 —— 从用户视角就是「说好的去掉，就真的不在了」。
 */
function buildView(cache: AiNewsCache, sources: AiNewsSourceInfo[]): AiNewsView {
  const ids = sources.map((source) => source.id)
  return {
    items: mergedItems(cache, ids),
    updatedAt: latestUpdatedAt(cache, ids)
  }
}

/** 只读缓存：不联网。卡片首屏先摆出上次的内容，再交给 refresh 后台更新 */
export async function getAiNews(): Promise<Result<AiNewsView>> {
  try {
    const [cache, sources] = await Promise.all([loadCache(), loadSources()])
    return ok(buildView(cache, sources))
  } catch (error) {
    return fail(reasonOf(error, '读取 AI 热点缓存失败'))
  }
}

/** 一个源这一轮的拉取结论：有没有真的发请求，以及失败时要说的那句话 */
interface Attempt {
  fired: boolean
  error?: string
}

/**
 * 按缓存策略刷新一次：只处理**清单里、且到了各自 nextFetchAt** 的源。
 *
 * 各源并发拉取（互不影响），每源独立退避；一个源失败不会影响别的源的结果，
 * 也不会把已经拿到的内容清掉 —— 失败原因逐条放进 notes 交给界面如实显示。
 */
export async function refreshAiNews(): Promise<Result<AiNewsRefreshResult>> {
  try {
    const [cache, sources] = await Promise.all([loadCache(), loadSources()])
    const now = Date.now()
    const notes: string[] = []

    const attempts = await Promise.all(
      sources.map(async (source): Promise<Attempt> => {
        const current = cache.sources[source.id]

        if (!shouldFetchSource(current, now)) return { fired: false }

        try {
          const fetched = await invoke<{ status: number; body: string; etag: string }>(
            'ai_news_fetch',
            { sourceId: source.id, etag: current?.etag ?? '' }
          )

          if (fetched.status === 304) {
            cache.sources[source.id] = applySourceNotModified(current, fetched.etag, source.ttlMs, now)
            return { fired: true }
          }

          if (fetched.status === 200) {
            const items = parseSourcePayload(source.format, fetched.body).map((item) => ({
              ...item,
              // 源名统一盖成清单里的名字：载荷里没自带来源的（JSON / Atom 那几类）也有名字，
              // 将来在清单里改名不必重刷缓存
              source: item.source || source.name
            }))

            // 200 但解析不出任何条目：说明对面回了意外的东西（风控页 / 空壳），按失败处理，
            // 不能把「有内容」显示成「没内容」
            if (items.length === 0 && fetched.body.trim().length > 0) {
              const message = `${source.name} 拉回来的是个空壳，解析不出条目`
              cache.sources[source.id] = applySourceFailure(current, now, message)
              return { fired: true, error: message }
            }

            cache.sources[source.id] = applySourceSuccess(current, items, fetched.etag, source.ttlMs, now)
            return { fired: true }
          }

          // 429（被限流）与其它的 4xx / 5xx：指数退避，下次可拉时刻往后推
          const message =
            fetched.status === 429
              ? `${source.name} 被限流了（429），已按退避安排重试`
              : `${source.name} 拉取失败（HTTP ${fetched.status}）`
          cache.sources[source.id] = applySourceFailure(current, now, message)
          return { fired: true, error: message }
        } catch (error) {
          const message = `${source.name}：${reasonOf(error, '拉取失败')}`
          cache.sources[source.id] = applySourceFailure(current, now, message)
          return { fired: true, error: message }
        }
      })
    )

    // 只有真的动过缓存才落盘：全都没到期时不必写一次盘
    if (attempts.some((attempt) => attempt.fired)) await saveCache(cache)

    for (const attempt of attempts) {
      if (attempt.error) notes.push(attempt.error)
    }

    return ok({
      view: buildView(cache, sources),
      refreshed: attempts.some((attempt) => attempt.fired),
      notes
    })
  } catch (error) {
    return fail(reasonOf(error, '刷新 AI 热点失败'))
  }
}

// ---------- 站内阅读 ----------

/**
 * 抓一条热点的正文页并提取段落（用户点开那条时才调用）。
 *
 * Rust 侧只做「按域名白名单抓原始 HTML」，提取在这里做 —— 于是提取规则能被单测直接覆盖，
 * 改一版显示口径也不必重编 Rust（与整条 AI 热点链路的职责划分一致）。
 */
export async function loadAiNewsArticle(url: string): Promise<Result<AiNewsArticle>> {
  if (!url) return fail('这条热点没有可打开的原文地址')
  try {
    const html = await invoke<string>('ai_news_article', { url })
    const article = extractArticle(html)
    if (!article.paragraphs.length) {
      return fail('没能从原页里提出正文（可能是会员专属、或正文由脚本动态加载）')
    }
    return ok(article)
  } catch (error) {
    return fail(reasonOf(error, '抓取原文失败'))
  }
}
