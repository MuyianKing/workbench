/**
 * TBuddy 模型目录的排序口径。
 *
 * 目录是上游拉下来的，界面不写死顺序；倍率（上游 `credits` 字段，界面叫「倍率」）是
 * 用户挑模型时最关心的那一项，所以默认按它从低到高排。**倍率原文是给人看的字符串**：
 * 实测上游给 `x0.29` / `x1.00`，旧入口也出现过 `0.69x` 这种后缀写法，还有一批模型
 * 干脆没给（空串）。解析只从串里抠出**第一个**有限非负小数，前后缀的 `x` 都不影响；
 * 抠不出数的一律当「未知」，与「不猜数字」那条口径一致 —— 不拿 0 冒充免费。
 *
 * 未知的永远沉底（升序降序都一样），不能因为 `localeCompare` 把空串排到最前、
 * 也不能让 `NaN` 把稳定排序搅乱；同值时退回模型 id 的字典序，保证每次进来顺序一样。
 *
 * 排序只需要条目里的 id / name / rate / context / maxOutput 这五项：渲染层的
 * `GatewayModelInfo` 结构兼容这个子集，域包不反向 import 渲染层类型
 * （与 `gateway-usage.ts` 的 `GatewayUsageRowLike` 同一做法）。
 */
export interface ModelCatalogEntry {
  id: string
  name: string
  /** 消费倍率原文（`x0.29` / `0.69x` / 空串），只用于显示与排序 */
  rate: string
  context: number
  maxOutput: number
}

/** 排序方式：默认按倍率升序（便宜的先看） */
export type ModelSortKey = 'rate' | 'rateDesc' | 'context' | 'maxOutput' | 'name' | 'default'

/** 下拉里的选项（顺序即显示顺序） */
export const MODEL_SORTS: { label: string, value: ModelSortKey }[] = [
  { label: '倍率从低到高', value: 'rate' },
  { label: '倍率从高到低', value: 'rateDesc' },
  { label: '上下文从大到小', value: 'context' },
  { label: '最大输出从大到小', value: 'maxOutput' },
  { label: '按名称', value: 'name' },
  { label: '上游顺序', value: 'default' },
]

/**
 * 倍率原文 → 数值；认不出返回 `null`（未知），不返回 0。
 *
 * 只取第一个匹配：上游偶尔会在一串里带说明文字（如 `x0.29 限时`），
 * 后面的数字不属于倍率。带前导负号、NaN 这类不可能是倍率的串一律归未知。
 */
export function parseModelRate(rate: string): number | null {
  const text = rate.trim()
  if (text.startsWith('-'))
    return null
  const match = /(\d+(?:\.\d+)?)/.exec(text)
  if (!match)
    return null
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 给一个稳定的排序键：带 `null` 的（未知）永远排在带值的后面，
 * 不受升序 / 降序影响。`tone` 只用 `id` 做同值兜底。
 */
function rank(value: number | null, id: string) {
  return value === null
    ? { known: 1, value: 0, id }
    : { known: 0, value, id }
}

/**
 * 给目录排序，返回**新数组**，不改上游给的顺序（「上游顺序」那一档要用原序）。
 *
 * 每个键的比较都先在「已知 / 未知」两档之间分胜负，再比数值，最后用 id 兜底：
 * 数值列里上游没给就是 0，但「没给」和「真的是 0」不是一回事，
 * 所以 0 也按未知处理、一起沉底（`rate = x0.00` 是明确给过的 0，仍算已知）。
 */
export function sortModels<T extends ModelCatalogEntry>(models: T[], key: ModelSortKey): T[] {
  if (key === 'default')
    return [...models]

  const copy = [...models]
  if (key === 'name') {
    // 中文名与英文 id 混排时按本地习惯；空名退到 id
    return copy.sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, 'zh-CN') || a.id.localeCompare(b.id))
  }

  const numeric = key === 'rate' || key === 'rateDesc'
    ? (model: T) => parseModelRate(model.rate)
    : (model: T) => {
        const value = key === 'context' ? model.context : model.maxOutput
        return value > 0 ? value : null
      }
  const ascending = key === 'rate'
  const sign = ascending ? 1 : -1

  return copy.sort((a, b) => {
    const left = rank(numeric(a), a.id)
    const right = rank(numeric(b), b.id)
    // 未知沉底：这一条先于升降序，降序时也不能把未知翻到最前
    if (left.known !== right.known)
      return left.known - right.known
    if (left.known === 1)
      return left.id.localeCompare(right.id)
    if (left.value !== right.value)
      return (left.value - right.value) * sign
    return left.id.localeCompare(right.id)
  })
}
