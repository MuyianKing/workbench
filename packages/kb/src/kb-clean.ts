/**
 * 知识库清洗的提示词：**应用内的资产**，不对外提供。
 *
 * 清洗由应用全程编排（见 stores/kb.ts）：应用把扫描出的待处理清单、条目格式契约与做法
 * 要求拼成一段指令交给内置的 Pi，它读写文件完成整理，跑完由应用重建索引并上传。这一段话是
 * 清洗质量的全部 —— 它的迭代发生在开发期（改这里、跑一轮真实清洗、看效果），用户既看不到
 * 也改不了。仓库侧（raw、data）因此是纯数据：没有脚本、没有 Agent 说明文件。
 *
 * 提示词只交代「清洗」这一件事，资料自己的结构（怎么分类、打什么标签）让 Pi 进了目录
 * 先读清单里那批文件自己归纳 —— 那是模型擅长的事，应用不替某个资料源写死规则。
 *
 * **清单里的每一行都带两个事实**：逻辑路径（`raw/<知识库名>/…`，条目 source 写它）
 * 与真实绝对路径（仓库里那份的位置，读文件走它）。另外每行带**内容指纹**（应用算好的
 * SHA-256），Pi 按提示词抄进条目的 `source_hash`：下一轮靠它判断「内容没变、只是 mtime
 * 被 git 重写了」。同时这里有两条硬禁令：raw 层是用户上传的原文（清洗的输入），一个字
 * 都不许动；生成物（`data/_catalog.md` 与 `data/index.json`）只归应用重建。
 *
 * 条目落位跟着原始文件走：`raw/<名>/…` 的条目写到 `data/<名>/…`（同名目录），主题目录
 * 那层约定在它下面。删除知识库时按 `data/<名>/` 整目录清，两边对得上。
 *
 * 文件末尾那一节是**清洗的收据**：跑完把 Pi 报出的写入路径分成「新建 / 覆盖」两组，
 * 界面拿它说清这一轮动了哪几条（口径在那里，不散在组件里）。
 */
import { KB_CATALOG_NAME, KB_DATA_DIR, KB_INDEX_REL, KB_RAW_DIR } from './kb'

/**
 * 清洗流程的阶段：store 里推进，面板与工具条都按它说话。
 * `preparing` 是**准备阶段**（源头同步 → 上传远程 → 算清单）—— 这几步是实打实的耗时
 * （上传是三次出网），面板先行、逐行打日志，不让「点了没反应」。
 */
export type KbCleanPhase
  = | 'idle'
    | 'preparing'
    | 'blocked'
    | 'cleaning'
    | 'indexing'
    | 'done'
    | 'failed'
    | 'cancelled'

/** 清洗清单里的一个待处理文件：逻辑路径给 source 用，绝对路径给读文件用，指纹写进条目 */
export interface KbCleanTarget {
  /** 逻辑路径（`raw/<知识库名>/…`）：条目 source 写这个 */
  rel: string
  /** 真实绝对路径（仓库里那份）；认不出时是空串 */
  abs: string
  /** 内容指纹（SHA-256 小写十六进制），抄进条目的 source_hash；空串 = 这一轮没算出来 */
  hash: string
}

/** 清洗的输入：应用扫描出的两组待处理文件与今天的日期 */
export interface KbCleanInput {
  /** 未入库：没有任何条目指向它 */
  pending: KbCleanTarget[]
  /** 有更新：原始文件的内容指纹与指向它的条目不一致（重洗覆盖） */
  stale: KbCleanTarget[]
  /** 本机时区的今天（YYYY-MM-DD），写进新条目的 created / updated */
  today: string
}

/** 清单里的一行：逻辑路径在上，真实路径与内容指纹跟在括号里 */
function targetLine(target: KbCleanTarget): string {
  const rel = target.rel.trim().replace(/\\/g, '/')
  const parts: string[] = []
  const abs = target.abs.trim().replace(/\\/g, '/')
  if (abs)
    parts.push(`实际文件：${abs}`)
  const hash = target.hash.trim()
  if (hash)
    parts.push(`内容指纹：${hash}`)
  return parts.length ? `- ${rel}（${parts.join('；')}）` : `- ${rel}`
}

/** 清洗指令的全文：一段话交给子进程的 stdin（RPC 协议），格式随内容定 */
export function kbCleanPrompt(input: KbCleanInput): string {
  const { pending, stale, today } = input

  const list: string[] = []
  list.push(
    pending.length
      ? [`未入库（${pending.length} 个，还没有条目指向它们）：`, ...pending.map(targetLine)].join('\n')
      : '未入库：没有',
  )
  list.push(
    stale.length
      ? [`有更新（${stale.length} 个，内容指纹与指向它们的条目不一致）：`, ...stale.map(targetLine)].join('\n')
      : '有更新：没有',
  )

  return [
    '任务：清洗本知识库的原始资料 —— 把下面清单里的原始文件整理成知识条目，写入 data/。',
    '',
    '【待处理清单（应用扫描得出，以它为准）】',
    list.join('\n'),
    '',
    '【条目格式（必须遵守）】',
    '- 每个条目是 data/ 下的一个 .md 文件，开头是 frontmatter（--- 围栏），字段与填法：',
    '  title: 条目标题（与文件名一致）',
    '  tags: [标签1, 标签2] —— 从资料内容与所属主题归纳，便于跨主题检索',
    `  created: 建条目日期；updated: 最后修改日期 —— 都是 YYYY-MM-DD，今天是 ${today}`,
    '  source: 清单里那一行的**逻辑路径**（如 raw/某知识库/某文件.md）—— 照抄清单上的写法；同一原始文件拆出的多条目都填同一个 source',
    '  source_hash: 清单里那一行的**内容指纹** —— 照抄那一串十六进制，一个字都不要改；同一原始文件拆出的多条目都填同一个 source_hash',
    '  status: reviewed（清洗生成的条目一律 reviewed）',
    '  summary: 一句话概括，会显示在全库目录与机器索引里',
    '- 条目落位跟着原始文件走：raw/<知识库名>/… 的条目写到 data/<知识库名>/…（知识库名就是清单路径里 raw/ 后面那一段，一个字不要改）。',
    '- 主题目录命名 NN-主题名（NN 是两位序号，决定排序），放在 data/<知识库名>/ 下面：资料属于已有主题就归入现有目录，没有合适的就新建一个。',
    '- 一个条目只讲一件事：内容太长就拆成多条，拆出的都指回同一个 source。',
    '- 正文里第一次提到库内已有条目时，用**相对链接**指过去（同目录 `[MuButton](./button.md)`、跨目录 `[xx](../02-主题/xx.md)`）—— 链上它，别把那份条目里的内容再抄一遍；链接写相对路径，不要用 [[双链]] 写法。',
    '- 正文要求：开头一段说清「这是什么、什么时候查阅」；结论在前、细节在后；数据注明来源与日期；转载内容保留原出处，不抹掉作者信息。',
    '- 「有更新」的原始文件：以原始文件为唯一事实源重洗 —— 先读指向它的旧条目（frontmatter 与正文都看），重建内容覆盖它们；created 保留原值，updated 写今天。',
    '',
    '【做法】',
    '1. 动手前先通读待处理清单里的文件名与它们所在的目录，弄清这批资料的结构与分类（tags 与主题归类都从它来），再逐个文件整理。',
    '2. 只处理清单里的文件；清单之外的条目与原始文件一律不动，也不删除任何现有条目。',
    '3. 原始资料可能是任意格式：文本类（md / txt 等）读出来整理；读不了的（二进制等）跳过，总结里说明是哪几个、为什么。',
    '4. 读文件一律用清单里「实际文件」那个绝对路径。',
    '5. **raw/ 里的文件是用户上传的原文，一个字都不许改、不许移动、不许删除**：只读它们；这一轮所有产出都只写进 data/。',
    `6. data/${KB_CATALOG_NAME} 与 ${KB_INDEX_REL} 是应用自动重建的生成物：不必读它们，也绝不要改；仓库根下的其他文件（README 等）同样不要碰。`,
    '7. 你有这台机器的完全访问权限，需要什么命令就用什么命令；git 提交 / 推送不用做（上传与同步由应用负责），也不要在任何目录里留下脚本或临时文件。',
    '8. 全部处理完后用一段话总结：每个原始文件新建了哪些条目、覆盖了哪些条目、还是跳过了（跳过的说明原因），以及遇到的问题。',
  ].join('\n')
}

// ---------- 清洗的收据 ----------

/** 一轮清洗动过的条目：新建的与覆盖的分开（界面按它说话，见 KbCleanPanel） */
export interface KbCleanWrites {
  /** 这一轮新建的条目（相对仓库根） */
  created: string[]
  /** 这一轮覆盖的条目（跑之前就在库里） */
  updated: string[]
}

/**
 * 把 Pi 报出的写入路径分成「新建」与「覆盖」两组。
 *
 * 写入路径是**工具事件里原样报出来的**（它可能写 cwd 相对路径 `data/…`，也可能是绝对
 * 路径），所以先归一：统一 `/`、剥掉知识库根那一段前缀、去掉 `./`。归一之后只认
 * `data/` 下的 `.md`（`_catalog.md` 是生成物，不算条目；遗留的 `data/raw/` 也不是条目），
 * 别的路径不往收据上放。
 *
 * 「新建还是覆盖」拿**跑之前那份条目清单**（before）比：在里面就是覆盖，不在就是新建。
 * 大小写按 Windows 的口径比。两份清单各自去重、按路径排 —— 收据要的是「有哪几条」。
 */
export function splitCleanWrites(root: string, paths: string[], before: string[]): KbCleanWrites {
  const known = new Map<string, string>()
  for (const rel of before) known.set(rel.toLowerCase(), rel)

  const created = new Set<string>()
  const updated = new Set<string>()
  for (const raw of paths) {
    const rel = kbRelOfWrite(root, raw)
    if (!rel)
      continue
    const hit = known.get(rel.toLowerCase())
    if (hit)
      updated.add(hit)
    else created.add(rel)
  }

  return {
    created: [...created].sort((a, b) => a.localeCompare(b)),
    updated: [...updated].sort((a, b) => a.localeCompare(b)),
  }
}

/** 一条写入路径归一成 `data/…` 相对路径；不是 data/ 下的条目文件（或认不出来）回空串 */
function kbRelOfWrite(root: string, rawPath: string): string {
  let path = rawPath.trim().replace(/\\/g, '/')
  if (!path)
    return ''

  const base = root.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    path = path.slice(base.length + 1)
  }
  path = path.replace(/^\.\//, '').replace(/^\/+/, '')

  if (!path.startsWith(`${KB_DATA_DIR}/`))
    return ''
  if (path.toLowerCase().startsWith(`${KB_DATA_DIR}/${KB_RAW_DIR.toLowerCase()}/`))
    return ''
  if (!path.toLowerCase().endsWith('.md'))
    return ''
  if ((path.split('/').pop() ?? '').toLowerCase() === KB_CATALOG_NAME)
    return ''
  return path
}
