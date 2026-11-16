/**
 * `window.workbench` 上的一组通道：AI 热点与 Pi 技能（会话类通道在 workbench/ai.ts，不走 window.workbench）。
 * 实现见 `workbench/ai-news.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  AiNewsArticle,
  AiNewsRefreshResult,
  AiNewsSourceInfo,
  AiNewsView,
} from '../index'

export interface AiChannel {
  /**
   * AI 热点：读本地缓存（`ai-news.json`）的合并视图。**不联网** —— 只回上次拉回来的那份。
   * 卡片首屏先走它：有内容就直接摆出来，再交给 refreshAiNews 后台更新。
   */
  getAiNews: () => Promise<Result<AiNewsView>>

  /**
   * AI 热点：按缓存策略刷新到期的源（见 @workbench/ai 的 ai-news）。**可能出网** ——
   * 只拉「已启用、配好了凭据、且到了各自的 nextFetchAt」的源；都没到期就原样回缓存。
   * 每个源各自退避，一个源失败不影响别的源，失败说明逐条放在 notes 里。
   */
  refreshAiNews: () => Promise<Result<AiNewsRefreshResult>>

  /**
   * AI 热点站内阅读：抓一条热点的正文页并提取段落。**会出网，且只在用户点开那条时才调**。
   *
   * 只允许抓热点源自己的域名（Rust 侧按后缀白名单核过，`ai_news.rs` 的 `article_hosts`）；
   * 页面脚本不会被执行 —— 提出来的是纯文本段落。提不出正文时返回失败，
   * 界面降级成「标题 + 导语 + 在浏览器中打开」。
   */
  loadAiNewsArticle: (url: string) => Promise<Result<AiNewsArticle>>

  /**
   * AI 热点：内置源清单（id / 名字 / 载荷格式 / 建议刷新间隔）。
   *
   * 不给地址：地址只住在宿主侧的白名单里，渲染层连一个能出网的字符串都拿不到。
   */
  aiNewsSources: () => Promise<Result<AiNewsSourceInfo[]>>

  // ---------- Pi 的技能（AI 助手页那颗「技能」按钮，见 @workbench/ai 的 pi-skills） ----------
  //
  // 与上面技能页那组**不是一回事**：那组管的是「技能库 + 装到项目」，这一组管的是
  // AI 助手页那两条 `.agents/skills`（全局 / 项目）—— 一个技能 = 一个带 SKILL.md 的子目录。
  // 装进来的东西只落盘：包里的脚本一概不执行（跑不跑是 Pi 自己的事，受权限档管）。
  /**
   * 列一个技能根里的技能（`{id, fileCount, skillMd}[]`）。**根不存在就是空表**：
   * 第一次用、或者这个项目里还没装过技能，都不是错误。
   */
  piSkillList: (root: string) => Promise<Result<unknown>>

  /**
   * 装一个本地 zip（同名先报错，确认过再带 `overwrite` 重调）。返回落下去的技能名与文件数。
   */
  piSkillInstallZip: (
    root: string,
    zip: string,
    id: string | null,
    overwrite: boolean,
  ) => Promise<Result<unknown>>

  /**
   * 装一个本机文件夹（那个文件夹本身就是一个技能：根上要有 SKILL.md）。
   * **不走 git**：装进用户自己那两个技能根，不替他在他的仓库里提交。
   */
  piSkillInstallDir: (
    root: string,
    source: string,
    id: string | null,
    overwrite: boolean,
  ) => Promise<Result<unknown>>

  /**
   * 从用户粘的地址装（GET 一次、跟随跳转）。**这是应用的一条网络出口**：主机由用户给、
   * 点了才走一次，跳数有上限（见 AGENTS.md 第 1 节的清单与 pi_skills.rs 的文件头）。
   */
  piSkillInstallUrl: (
    root: string,
    url: string,
    id: string | null,
    overwrite: boolean,
  ) => Promise<Result<unknown>>

  /** 卸掉一个技能（删掉那个技能目录整棵）；界面那一侧先问过一次 */
  piSkillRemove: (root: string, id: string) => Promise<Result<null>>
  // AI 助手那几条不在这里：会话类通道（要回传进程输出、要按会话 id 认领事件）一直住在
  // 适配层，与 spawn_session / stop_session 同一条路子 —— 见 workbench/ai.ts 的 aiRun。
}
