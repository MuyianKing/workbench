/**
 * AI 助手页那份「技能」弹窗的纯逻辑：**两条技能根、开关状态与列表怎么合、目录名怎么收敛**。
 * 读写与出网都在 Rust（`pi_skills.rs`），这里只留口径与判定，带单测。
 *
 * 技能是什么：**根下一个带 `SKILL.md` 的子目录**（与技能页的技能库同一条约定，见
 * [skills.ts](./skills.ts) 的文件头）。两条根各管一段：
 *
 *  - **全局级** `%USERPROFILE%\.agents\skills`（路径由 Rust 的 `pi_skills::global_root` 给，
 *    探测器 `ai_runtime` 里带回来）—— 这份**与别的 agent 共用**（ZCode 这类也读它），
 *    应用只增删自己装进去的那几个目录，别人的账本一概不碰；
 *  - **项目级** `<会话工作目录>\.agents\skills` —— 与技能页的「安装到项目」是**同一份目录**：
 *    技能页装过去的技能，在这里直接就能开、能用，也能从这里卸掉（卸掉的是项目里那份，
 *    技能库里那份还在）。
 *
 * 起 Pi 时**启用的技能逐个目录**交给它（`--skill`，见 ai.rs 的 `run`）：没启用的不进参数，
 * Pi 那边就是「这一轮没有它」。开关状态住在持久化数据里（`aiSkillsOff`，键见 `skillKey`），
 * 形状是「被关掉的那些」，不是「开着的那些」—— 新装进来、别处放进来的技能默认就是开着的，
 * 不需要应用替它们登记一遍。
 */
import { SKILL_INSTALL_DIR, toSkillEntry, type SkillEntry } from '@workbench/skills'

/** 技能分两级：全局那份、项目那份 */
export type AiSkillLevel = 'global' | 'project'

/**
 * 交给 Rust 的一条技能：**根 + 技能名**（不是路径）。
 *
 * 路径由 Rust 拼（`pi_skills::skill_path`，那边还要挡越界），渲染层不碰分隔符 ——
 * 起 Pi 时逐条变成 `--skill <目录>`（见 ai.rs 的 run 与 shared/types.ts 的 AiRunInput）。
 */
export interface AiSkillRef {
  root: string
  id: string
}

/** 一个技能的名字上限（目录名一样长）；比这个长的不像技能名，当认不出处理 */
const SKILL_ID_MAX = 120

/** 开关表最多记多少条：一份技能根的目录数不会到这个量级，超出的是垃圾数据 */
const AI_SKILLS_OFF_MAX = 500

/** 一条已经合并好的技能行（列表就按这个画） */
export interface AiSkillRow extends SkillEntry {
  level: AiSkillLevel
  /** 它所在的那个技能根（全局那份是绝对路径，项目那份由工作目录拼出来） */
  root: string
  /** 开关表里的键（`skillKey`），界面拿它去切开关 */
  key: string
  /** 这一轮交给 Pi 没有（关掉的不进 `--skill`） */
  enabled: boolean
  /** SKILL.md 的原文（列表那一下已经读回来了）：详情那一栏直接画它，不再跑一趟通道 */
  md: string
}

/**
 * 项目级技能根：`<工作目录>\.agents\skills`。
 *
 * 分隔符跟着工作目录自己的写法走（Windows 两种都认，但拼出来与用户看到的那个路径一致更好读）；
 * 目录为空（会话还没挑目录）时返回空串 —— 调用方按「这个会话没有项目技能」处理。
 */
export function projectSkillsRoot(dir: string): string {
  const base = dir.trim()
  if (!base) return ''
  return skillPathOf(base, SKILL_INSTALL_DIR)
}

/**
 * 开关表里的键：根 + 技能名，**统一大小写与分隔符**（Windows 的路径不认大小写，
 * 同一个技能换个写法写进表里不该算两条）。
 */
export function skillKey(root: string, id: string): string {
  const base = root.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\')
  return `${base}\\${id.trim()}`.toLowerCase()
}

/**
 * 一个技能在盘上的路径（给界面用：在文件管理器里打开、显示给人看）。
 *
 * **真正的拼法在 Rust 侧**（`pi_skills::skill_path`，那边还要挡越界）—— 这里只服务展示，
 * 分隔符跟着根自己的写法走。别拿它去当 `--skill` 的参数（那条由 Rust 拼）。
 */
export function skillPathOf(root: string, id: string): string {
  const base = root.trim().replace(/[\\/]+$/, '')
  const name = id.trim()
  if (!base) return name
  const separator = base.includes('\\') || !base.includes('/') ? '\\' : '/'
  return `${base}${separator}${name.replace(/[\\/]/g, separator)}`
}

/**
 * 收敛开关表（持久化数据里那一条）：只留像路径的字符串，去重、去空、限长限量。
 * 认不出的整条丢掉 —— 它只影响「默认开还是默认关」，不该拖垮整份数据。
 */
export function sanitizeAiSkillsOff(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (!key || key.length > 400 || /[\r\n]/.test(key)) continue
    if (!out.includes(key)) out.push(key)
    if (out.length >= AI_SKILLS_OFF_MAX) break
  }
  return out
}

/**
 * 一个技能根扫回来的原始记录 → 界面要的行（顺带把开关状态合进来）。
 *
 * `raw` 就是 Rust 那条通道回来的东西（`{id, fileCount, skillMd}[]`），解析成名字 / 描述 /
 * 版本的规矩在 `toSkillEntry`（与技能页**同一个函数**，别另写一份）。
 */
export function aiSkillRows(
  level: AiSkillLevel,
  root: string,
  raw: unknown,
  disabled: readonly string[]
): AiSkillRow[] {
  if (!Array.isArray(raw)) return []
  const rows: AiSkillRow[] = []
  for (const item of raw) {
    const record = (item ?? {}) as { id?: unknown; fileCount?: unknown; skillMd?: unknown }
    const entry = toSkillEntry(record)
    if (!entry || entry.id.length > SKILL_ID_MAX) continue
    const key = skillKey(root, entry.id)
    rows.push({
      ...entry,
      level,
      root,
      key,
      enabled: !disabled.includes(key),
      md: typeof record.skillMd === 'string' ? record.skillMd : ''
    })
  }
  return rows
}

/**
 * 这一轮要交给 Pi 的技能（根 + 技能名）—— 关掉的不在里面。
 * 同名的技能在两个根上都有时两条都留下（Pi 自己按名字去重，先加载的赢；
 * 界面上两栏也照实各显示各的）。
 */
export function enabledAiSkills(rows: readonly AiSkillRow[]): AiSkillRef[] {
  return rows
    .filter((row) => row.enabled)
    .map((row) => ({ root: row.root, id: row.id }))
}
