/**
 * `window.workbench` 上的一组通道：统计（活跃度、Token 用量、多机同步）。
 * 实现见 `workbench/activity.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  ActivityKind,
  ActivityView,
  EtfSyncPullOutcome,
  SyncDeviceInfo,
  TokenUsageResult,
} from '../index'

export interface StatsChannel {
  /**
   * 首页活跃度：按天聚合的各来源操作次数，总数（total）与分项（days）一起给，
   * 见 @workbench/core 的 ActivityView。开了同步时是**本机 + 别的机器**按天求和之后的账本
   * （别的机器那份只在内存里合并，不写回本机文件，见 workbench/activity.ts）。
   */
  getActivity: () => Promise<Result<ActivityView>>

  /**
   * 记一次活跃度（只给渲染层里那几个「适配层看不见动作成败」的来源用：AI 助手跑完一轮，
   * 见 stores/ai.ts 的 settle）。其余来源都在适配层内部直接记（见 workbench/activity.ts）。
   */
  recordActivity: (kind: ActivityKind) => Promise<Result<null>>

  /** 活跃度计数变了（任何一种来源记了一笔），首页那张图据此重拉一次 */
  onActivityChanged: (fn: () => void) => () => void

  /** Token 用量:实读各 AI 工具本地库并合并进快照;读取失败的来源带原因,数据回退快照 */
  getTokenUsage: () => Promise<Result<TokenUsageResult>>

  /**
   * 只读本地那一份（本机快照 + 克隆里别人的分片），**不实读、不落盘、不碰网络**。
   *
   * 给面板首屏用：冷读一轮要一秒上下，那段时间卡片只能拿空态示人，
   * 明明有数据的用户会以为数据没了。先把上次的数据摆出来，再被 getTokenUsage 整份覆盖。
   * 返回形状与 getTokenUsage 一致，界面上不用区分两条路。
   */
  getTokenUsageSnapshot: () => Promise<Result<TokenUsageResult>>

  /**
   * 立刻同步一次 Token 快照并返回合并后的结果（面板上的手动同步按钮）。
   * 自动同步按间隔节流，这个入口不受节流限制。
   */
  syncTokenUsage: () => Promise<Result<TokenUsageResult>>

  /**
   * 只同步外观配置（设置 → 外观 →「同步一次」）：把本机 theme.json 整份推上去、
   * 把别的机器的读回来 —— 不实读用量、不推分片，与 syncTokenUsage 互不相干。
   */
  syncThemeConfig: () => Promise<Result<{ changed: boolean }>>

  /**
   * 同步仓库里**别的机器**（各自的外观配置快照一起带回来）。
   *
   * 只读本地那份克隆，不联网、也不推东西，所以设置界面打开时随时可以问；
   * 内容是上一次同步取回来的样子。地址没填时返回空数组。
   */
  listSyncDevices: () => Promise<Result<SyncDeviceInfo[]>>

  /**
   * ETF 缓存的多机复用：拉一次同步仓库，把别的机器推上来的份额 / 净值并进本机。
   *
   * 「一台机器跑完回填，其他机器直接复用」靠的就是它 —— 合并完再规划缺口，这一轮
   * 就不会再向交易所要同样的数据（见 workbench/etf.ts 的 pullEtfCache）。
   * 没登录 / 没填仓库地址时给 `enabled: false`，页面照旧只读本机。
   */
  etfSyncPull: () => Promise<Result<EtfSyncPullOutcome>>

  /** 把本机 ETF 缓存写进 `etf/<设备id>.json` 并推送；内容没变时 git 那边不产生提交 */
  etfSyncPublish: () => Promise<Result<null>>

  /**
   * 后台的 Token 自动同步跑完一轮（成功失败都算）。
   *
   * 同步不挡出数：数据先显示，别人机器的新分片稍后才到，订阅方据此重取一次即可，
   * 不必干等到下一个轮询周期。手点的同步按钮不走这条 —— 它自己等结果。
   */
  onTokenSynced: (fn: () => void) => () => void
}
