/**
 * 极简 Node 版本区间判定（F-9.3）。
 *
 * 只覆盖 package.json engines / .nvmrc 里实际会出现的写法，避免为一条“仅提示”的需求
 * 引入 semver 依赖：
 *   18 / 18.2 / 18.2.3      精确或 X 区间（18 → >=18.0.0 <19.0.0）
 *   >=18 <21               比较符（部分版本按 0 补位）
 *   ^18.2.3 ~18.2          插入号 / 波浪号
 *   18.x / 18.*            通配
 *   >=18 || >=20           并集
 *
 * 解析不出来的写法一律判定为「满足」——这是个提示功能，宁可漏报也不误报。
 */

interface Parsed {
  major: number
  minor: number | null
  patch: number | null
}

const VERSION_RE = /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/

function parseVersion(text: string): Parsed | null {
  const matched = VERSION_RE.exec(text.trim())
  if (!matched) return null

  const read = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === 'x' || raw === '*') return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  const major = read(matched[1])
  if (major === null) return null // 版本必须至少给出 major

  return { major, minor: read(matched[2]), patch: read(matched[3]) }
}

function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major
  const am = a.minor ?? 0
  const bm = b.minor ?? 0
  if (am !== bm) return am - bm
  return (a.patch ?? 0) - (b.patch ?? 0)
}

function gte(a: Parsed, b: Parsed): boolean {
  return compare(a, b) >= 0
}

function lt(a: Parsed, b: Parsed): boolean {
  return compare(a, b) < 0
}

/** 把部分版本补全成下界，如 18 → 18.0.0 */
function floor(version: Parsed): Parsed {
  return { major: version.major, minor: version.minor ?? 0, patch: version.patch ?? 0 }
}

/** 由下界算出 exclusived 上界（用于 X 区间 / ^ / ~） */
function upperBoundOfCaret(version: Parsed): Parsed {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 }
  if (version.minor === null) return { major: 0, minor: 1, patch: 0 }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: (version.patch ?? 0) + 1 }
}

function upperBoundOfTilde(version: Parsed): Parsed {
  if (version.minor === null) return { major: version.major + 1, minor: 0, patch: 0 }
  return { major: version.major, minor: version.minor + 1, patch: 0 }
}

function upperBoundOfXRange(version: Parsed): Parsed {
  if (version.minor === null) return { major: version.major + 1, minor: 0, patch: 0 }
  if (version.patch === null) return { major: version.major, minor: version.minor + 1, patch: 0 }
  return floor(version)
}

type Predicate = (actual: Parsed) => boolean

function predicateFor(token: string): Predicate | null {
  const matched = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/.exec(token.trim())
  if (!matched) return null

  const operator = matched[1] ?? ''
  const version = parseVersion(matched[2])
  if (!version) return null

  switch (operator) {
    case '>=':
      return (actual) => gte(actual, floor(version))
    case '<=':
      return (actual) => !gte(actual, floor(version)) || compare(actual, floor(version)) === 0
    case '>':
      // 「>18」按 >18.0.0 处理：比 node-semver 宽松，宁可漏报
      return (actual) => compare(actual, floor(version)) > 0
    case '<':
      return (actual) => lt(actual, floor(version))
    case '^': {
      const upper = upperBoundOfCaret(version)
      return (actual) => gte(actual, floor(version)) && lt(actual, upper)
    }
    case '~': {
      const upper = upperBoundOfTilde(version)
      return (actual) => gte(actual, floor(version)) && lt(actual, upper)
    }
    default: {
      const stable = upperBoundOfXRange(version)
      if (compare(floor(version), stable) === 0) {
        return (actual) => compare(actual, floor(version)) === 0
      }
      return (actual) => gte(actual, floor(version)) && lt(actual, stable)
    }
  }
}

/**
 * 判断 actual（如 '20.11.1'）是否落在 range（如 '>=18 <21'）内。
 * range 为空或无法解析时返回 true。
 */
export function satisfiesNodeVersion(range: string | undefined | null, actual: string): boolean {
  const required = (range ?? '').trim()
  if (!required) return true

  const current = parseVersion(actual)
  if (!current) return true

  const groups = required.split('||')
  for (const group of groups) {
    const tokens = group.split(/[\s,]+/).filter(Boolean)
    if (tokens.length === 0) continue

    let all = true
    let understood = true
    for (const token of tokens) {
      const predicate = predicateFor(token)
      if (!predicate) {
        understood = false
        break
      }
      if (!predicate(current)) {
        all = false
        break
      }
    }
    // 整组都读不懂就别下结论；读懂了且全部通过才算命中
    if (understood && all) return true
  }

  // 一个 token 都没读懂（例如 "lts/*"）时不做提示
  const anyUnderstood = groups.some((group) =>
    group
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((token) => predicateFor(token) !== null)
  )
  return !anyUnderstood
}
