import type { WorkbenchApi } from '@/types'
import { fail, ok } from '@workbench/core'
import { guard } from './bridge'
import * as etf from './etf'
import { gatewayUsageRecent, gatewayUsageRows, pullGatewayUsage, syncGatewayUsage } from './gateway'
import { publishQoderEarnings, pullQoderEarnings, qoderEarnings } from './qoder'
import * as state from './state'
import { getTokenUsage, getTokenUsageSnapshot, listSyncDevices, localDevice, syncThemeConfig, syncTokenUsage } from './token'
import * as workLog from './work-log'

/**
 * 同步门禁这一侧的通道：网关流水 / 领取账本 / token 用量 / 外观 / ETF。
 *
 * 它们共享同一道门 —— `syncRepo()`：**没登录一律当没填**，设置里的地址不动它。
 * 仓库与设备 id 的取法都收在这一个文件里，各域只管自己的分片格式。
 */

/**
 * 当前该用的同步仓库地址：**没登录一律当没填**。
 *
 * 同步的凭据来自账号，所以未登录时既不推也不拉，界面上的数字全部出自本机（别人机器上
 * 读回来的分片也一并撤掉，见 token.ts 的 syncLocalShards）。设置里的地址不动它 ——
 * 登录回来接着用，不必重填一遍。
 */
export function syncRepo(): string {
  return state.account() ? state.settings().tokenSyncRepo : ''
}

/**
 * 网关流水同步要的两样东西：同步仓库与本机设备 id。
 * 仓库仍然只从 `syncRepo()` 取 —— 没登录就是空串，网关只读本机，不开旁路。
 */
async function gatewayContext(): Promise<{ repo: string, device: string }> {
  const repo = syncRepo()
  if (!repo)
    return { repo: '', device: '' }
  const { id } = await localDevice()
  return { repo, device: id }
}

/** 网关流水 / 领取账本 / 用量统计 / ETF 缓存这几组「跟着同步仓库走」的通道 */
export const syncApi = {
  // 网关流水：仓库与设备 id 与 token 同步同一个门禁；空仓库时只读本机
  gatewayUsageRows: async (days: number) => {
    const { repo, device } = await gatewayContext()
    return gatewayUsageRows(days, repo, device)
  },
  gatewayUsageRecent: async (limit: number) => {
    const { repo, device } = await gatewayContext()
    return gatewayUsageRecent(limit, repo, device)
  },
  gatewayUsageSync: async (force = true) => {
    const { repo, device } = await gatewayContext()
    if (repo && !device)
      return fail('没有设备标识，无法同步')
    return syncGatewayUsage(repo, device, force)
  },
  // 只拉不推：读路径只读本地克隆，进页面时先把别的机器推上来的补进来
  gatewayUsagePull: async () => {
    const { repo } = await gatewayContext()
    return pullGatewayUsage(repo)
  },
  // Qoder 领取账本：与 token 同步同一个仓库门禁；本机 activity.jsonl 是权威，
  // 读的时候再并入别的设备推上来的分片。
  qoderEarnings: async (days: number) => {
    const { repo, device } = await gatewayContext()
    return qoderEarnings(days, repo, device)
  },
  qoderEarningsPublish: async () => {
    const { repo, device } = await gatewayContext()
    if (!repo || !device)
      return ok(null)
    return publishQoderEarnings(repo, device)
  },
  qoderEarningsPull: async () => {
    const { repo } = await gatewayContext()
    if (!repo)
      return ok(null)
    return pullQoderEarnings(repo)
  },
  gatewaySyncStatus: () =>
    guard((async () => {
      const repo = syncRepo()
      if (!repo)
        return { enabled: false, deviceName: '' }
      const { id, name } = await localDevice()
      return { enabled: Boolean(id), deviceName: name }
    })(), '读取同步状态失败'),

  // ---------- 统计 ----------
  /**
   * Token 用量：实读 + 合并 + 按需同步。
   * 同步仓库地址从设置里现取 —— 用户刚在设置里填完，下一次刷新就该用上新地址。
   */
  getTokenUsage: () => guard(getTokenUsage({ repo: syncRepo() }), '读取 token 用量失败'),
  /** 首屏先手：只读本地那份快照，实读结果随后覆盖它（见 apps/desktop/src/renderer/src/types.ts 的说明） */
  getTokenUsageSnapshot: () =>
    guard(getTokenUsageSnapshot({ repo: syncRepo() }), '读取 token 快照失败'),
  /** 手动同步：绕过自动同步的节流（面板上的同步按钮），只推拉用量分片 */
  syncTokenUsage: () => guard(syncTokenUsage(syncRepo()), '同步 token 用量失败'),
  /**
   * 只同步外观配置（设置 → 外观 →「同步一次」）：推本机 theme.json、拉回别的机器的。
   *  它自己就返回 Result（没配仓库、拿不到设备 id 都是 fail），不能再包一层 guard ——
   *  原先双层包装是靠 `as unknown` 断言压住的隐患，修掉了。
   */
  syncThemeConfig: () => syncThemeConfig(syncRepo()),
  /**
   * 仓库里的其它机器（含各自的外观配置），设置界面「从别的机器取外观」用。
   * 与上面两个同理，地址从设置现取：用户刚填完就该看到新仓库里的机器。
   */
  listSyncDevices: () => listSyncDevices(syncRepo()),

  /**
   * ETF 缓存的多机复用：开同步时先把别的机器那份并进本机，刷新完再推回去。
   * 仓库地址同样只在登录后取（`syncRepo`）；没同步可用时两个方法都直接给「未启用」。
   */
  etfSyncPull: async () => {
    const repo = syncRepo()
    if (!repo)
      return ok({ enabled: false, own: false, changed: false })
    const { id } = await localDevice()
    if (!id)
      return ok({ enabled: false, own: false, changed: false })
    return guard(etf.pullEtfCache(repo, id), '同步 ETF 缓存失败')
  },
  etfSyncPublish: async () => {
    const repo = syncRepo()
    if (!repo)
      return ok(null)
    const { id } = await localDevice()
    if (!id)
      return ok(null)
    return guard(etf.publishEtfCache(repo, id), '同步 ETF 缓存失败')
  },

  /**
   * 工作日志：与上面几条同一道门禁（没登录一律空仓库）。拉 + 合并 + 推一轮都在
   * `workbench/work-log.ts` 里；页面只在同步成功且真的合出新内容时重画。
   */
  syncWorkLogs: async () => {
    const repo = syncRepo()
    if (!repo)
      return ok({ enabled: false, changed: false, device: '', entries: [], devices: [] })
    const { id, name } = await localDevice()
    if (!id)
      return ok({ enabled: false, changed: false, device: '', entries: [], devices: [] })
    return workLog.syncWorkLog(repo, { id, name })
  },
} as Partial<WorkbenchApi>
