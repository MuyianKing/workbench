/**
 * 知识库巡检：库内一致性的**只读**检查 —— 只报问题，不改任何文件。
 *
 * 与状态口径（[kb.ts](kb.ts) 的「未入库 / 有更新」）分工不同：那一份回答「原始资料进了没」，
 * 这一份回答「库本身有没有毛病」：孤儿条目、断链、frontmatter 缺必填项、出处指不到文件、
 * 主题目录不合 `NN-主题名`。
 *
 * 条目之间的链接也归这里：正文里的链接怎么认（kbEntryLinks）与怎么解析成仓库里的一条
 * 路径（resolveKbLink）—— 巡检按它算「谁链到谁」，界面按它做站内跳转，一份口径两处用。
 * 链接写**相对路径**（`[MuButton](./button.md)`），不写 Obsidian 的双链：工作台与
 * Obsidian 都认相对链接，而 `[[ ]]` 只有后者认，markdown-it 还会把它当普通文本渲染出来。
 *
 * 一切都是纯函数（扫描结果进、问题清单出）：没有 IO，也不知道 store 的存在。
 */
import { KB_DIR, KB_RAW_DIR, type KbEntryMeta, type KbScanEntry } from './kb'
import { markdownLinks } from './markdown'

/** 巡检的问题分类；界面上的说法在 KB_ISSUE_LABELS */
export type KbIssueKind = 'orphan' | 'link' | 'meta' | 'source' | 'topic'

/** 分类的固定顺序：汇总行与问题清单都按它排（一份名单，别处不再另拍） */
export const KB_ISSUE_KINDS: KbIssueKind[] = ['orphan', 'link', 'meta', 'source', 'topic']

/** 每一类在界面上的名字 */
export const KB_ISSUE_LABELS: Record<KbIssueKind, string> = {
  orphan: '孤儿',
  link: '断链',
  meta: '元数据',
  source: '出处',
  topic: '主题目录'
}

/** 巡检发现的一处问题 */
export interface KbIssue {
  kind: KbIssueKind
  /** 出问题的条目（相对仓库根）；界面点一下直接打开它 */
  rel: string
  /** 一句话说清是什么问题，界面直接显示 */
  text: string
}

/** 分类计数（只有非零的那几类）：界面汇总行念成「孤儿 2 · 断链 1」 */
export function kbIssueCounts(
  issues: KbIssue[]
): Array<{ kind: KbIssueKind; label: string; count: number }> {
  return KB_ISSUE_KINDS.map((kind) => ({
    kind,
    label: KB_ISSUE_LABELS[kind],
    count: issues.filter((issue) => issue.kind === kind).length
  })).filter((item) => item.count > 0)
}

// ---------- 链接 ----------

/**
 * 条目正文里的**站内链接目标**（原始 href，去重保序）。
 *
 * 认的是 markdown 的链接 `[文字](地址)`（走与渲染同一份 token 流，代码块里的方括号
 * 不会被误认成链接），图片 `![…](…)` 不算链接。外部地址（`http(s):` / `mailto:` …）
 * 与纯锚点（`#…`）在这里就滤掉 —— 它们由渲染层的既有出口管，与库内互链是两回事。
 */
export function kbEntryLinks(text: string): string[] {
  if (typeof text !== 'string' || !text.trim()) return []

  const seen = new Set<string>()
  for (const href of markdownLinks(text)) {
    const raw = href.trim()
    if (!raw || raw.startsWith('#')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    seen.add(raw)
  }
  return [...seen]
}

/**
 * 一个链接目标解析成仓库相对路径（`kb/…` / `data/raw/…`）；解析不出返回 null。
 *
 * 相对的是**这条条目所在的目录**：`kb/02-xx/a.md` 里的 `./b.md` 落到 `kb/02-xx/b.md`，
 * `../01-yy/c.md` 落到 `kb/01-yy/c.md`。下面这些一律不解析：空地址、纯锚点（`#…`）、
 * 带协议的地址（`http:` / `mailto:` …）、写死根部的绝对路径（`/…`），以及 `..` 退过头、
 * 越出仓库根的目标（退到仓库根为止：`kb/01-xx/a.md` 里的 `../../templates/x.md` 是合法的
 * —— 它落到仓库根下的 `templates/x.md`）。地址里的 URL 编码（`%20`）解开一层，
 * 不是合法编码就按原文用。
 *
 * 只看路径、不查文件在不在：**能不能跳到归调用方判**（巡检拿扫描清单判、界面拿条目清单判）。
 */
export function resolveKbLink(fromRel: string, href: string): string | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('/')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null

  // 锚点与查询串只属于定位，不是路径的一部分（`./b.md#第三节` → `./b.md`）
  const target = raw.split('#')[0].split('?')[0]
  if (!target) return null

  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    // 原文里本来就有 %（不是编码）：按原文用，不是错误
  }

  // 条目自己那一段不算目录（`kb/02-xx/a.md` 的上一层是 `kb/02-xx`）
  const segments = fromRel.split('/').slice(0, -1)
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segments.length) return null
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length ? segments.join('/') : null
}

// ---------- 巡检 ----------

/** 主题目录：`NN-主题名`（两位序号 + 名字），与条目格式规范、清洗提示词同一口径 */
const TOPIC_DIR = /^\d{2}-.+$/
/** 必填的两处日期：仓库自己的写法就是 `YYYY-MM-DD` */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** 导航页的文件名：主题总览（README.md）只是那个主题的入口 */
const NAV_NAME = 'readme.md'

/** 文件名是不是导航页（大小写不敏感，与文件系统的口径一致） */
function isNav(rel: string): boolean {
  return (rel.split('/').pop() ?? '').toLowerCase() === NAV_NAME
}

/**
 * source 长得像不像**库里的一条路径**：带目录分隔（`data/raw/x.md`、`mu-ui/x.md`）、
 * 或者带 `.md` 后缀（条目多半在 `kb/` 下）。**不像的不查** —— source 允许写书名、网址、
 * 对话这类出处，也允许写库外的一份资料（`某某书.pdf`），那些不是缺陷。
 */
function looksLikePath(source: string): boolean {
  if (!source || /\s/.test(source)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return false
  return source.includes('/') || /\.md$/i.test(source)
}

/**
 * 巡检一遍：条目与全库文件清单进、问题清单出（只读，不改任何东西）。五类的口径：
 *
 *  - **孤儿**：除导航页外，没有任何条目链接它。导航页发的链接**不算引用** —— 主题总览
 *    把同目录的条目全链一遍，算上它这个数就永远是零（README 自己也不参与判定）；
 *  - **断链**：正文里的站内链接解析不出库里的文件（解析规则见 resolveKbLink）；
 *  - **元数据**：缺 tags / status / created / updated（日期要 `YYYY-MM-DD`），
 *    或者整篇就没有 frontmatter（这时只报一条，不逐项报）；
 *  - **出处**：source 像库里的一条路径、但那个文件不在库里（不像路径的见 looksLikePath
 *    —— 书名、网址、库外的一份 pdf 都不查）；
 *  - **主题目录**：条目没归进主题目录（直接躺在 `kb/` 根下），或最外层目录名不是 `NN-主题名`。
 *
 * 只报事实、不报感觉：每一条都说得出是哪个文件的哪一处，界面点一下就能去改。
 * 大小写按 Windows 的口径比（`./Button.md` 对 `button.md` 打得开，不报）。
 */
export function kbLint(entries: KbEntryMeta[], files: KbScanEntry[]): KbIssue[] {
  const found: Record<KbIssueKind, KbIssue[]> = {
    orphan: [],
    link: [],
    meta: [],
    source: [],
    topic: []
  }

  /** 库里真有的文件（小写 rel）：断链与出处都拿它判「在不在」 */
  const known = new Set<string>()
  for (const file of files) {
    if (!file.isDir) known.add(file.rel.toLowerCase())
  }
  const entryRels = new Set(entries.map((entry) => entry.rel.toLowerCase()))

  // 入链先算一遍：条目正文里解析得出、且目标也是条目的那些（导航页发的不算）
  const inbound = new Set<string>()
  for (const entry of entries) {
    if (isNav(entry.rel)) continue
    for (const href of entry.links) {
      const target = resolveKbLink(entry.rel, href)
      if (target && entryRels.has(target.toLowerCase())) inbound.add(target.toLowerCase())
    }
  }

  for (const entry of entries) {
    // 元数据：通篇没有 frontmatter 只报一条（逐项报是同一件事说四遍）
    const bare =
      !entry.tags.length &&
      !entry.status &&
      !entry.created &&
      !entry.updated &&
      !entry.summary &&
      !entry.source
    if (bare) {
      found.meta.push({ kind: 'meta', rel: entry.rel, text: '没有 frontmatter：除了文件名什么都没有' })
    } else {
      if (!entry.tags.length) {
        found.meta.push({ kind: 'meta', rel: entry.rel, text: '没有 tags：搜索与标签筛选挂不上它' })
      }
      if (!entry.status) {
        found.meta.push({ kind: 'meta', rel: entry.rel, text: '没有 status' })
      }
      if (!ISO_DATE.test(entry.created)) {
        found.meta.push({ kind: 'meta', rel: entry.rel, text: `created 不是 YYYY-MM-DD：${entry.created || '（空）'}` })
      }
      if (!ISO_DATE.test(entry.updated)) {
        found.meta.push({ kind: 'meta', rel: entry.rel, text: `updated 不是 YYYY-MM-DD：${entry.updated || '（空）'}` })
      }
    }

    // 出处：只查长得像路径的那种（带不带 data/raw/ 前缀两种写法都认）
    if (looksLikePath(entry.source)) {
      const key = entry.source.toLowerCase()
      if (!known.has(key) && !known.has(`${KB_RAW_DIR}/${key}`)) {
        found.source.push({ kind: 'source', rel: entry.rel, text: `出处指不到库里的文件：${entry.source}` })
      }
    }

    // 主题目录：只看最外层那一级（主题目录下再分不分小目录是它自己的事）
    const inner = entry.rel.startsWith(`${KB_DIR}/`) ? entry.rel.slice(KB_DIR.length + 1) : entry.rel
    const segments = inner.split('/')
    if (segments.length < 2) {
      found.topic.push({ kind: 'topic', rel: entry.rel, text: '直接放在 kb/ 根下，没有归进主题目录' })
    } else if (!TOPIC_DIR.test(segments[0])) {
      found.topic.push({ kind: 'topic', rel: entry.rel, text: `主题目录名不是 NN-主题名：${segments[0]}` })
    }

    // 链接与孤儿
    for (const href of entry.links) {
      const target = resolveKbLink(entry.rel, href)
      if (!target) {
        found.link.push({ kind: 'link', rel: entry.rel, text: `链接跳不到库里：${href}` })
      } else if (!known.has(target.toLowerCase())) {
        found.link.push({ kind: 'link', rel: entry.rel, text: `链接指向的文件不存在：${target}` })
      }
    }
    if (!isNav(entry.rel) && !inbound.has(entry.rel.toLowerCase())) {
      found.orphan.push({ kind: 'orphan', rel: entry.rel, text: '没有其它条目链接它' })
    }
  }

  // 按分类的固定顺序拼起来：界面上一眼看得出「哪一类有几处」
  return KB_ISSUE_KINDS.flatMap((kind) => found[kind])
}
