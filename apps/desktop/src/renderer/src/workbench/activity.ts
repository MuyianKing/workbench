import type { ActivityBreakdown, ActivityKind, ActivityShard, ActivityView } from '@workbench/core'
import { ACTIVITY_SHARD_VERSION, mergeActivityBreakdowns, pruneDays, sanitizeActivityShard, totalOf } from '@workbench/core'
import { createAutoSync } from './auto-sync'
import { invoke } from './bridge'
import { emit } from './events'
import * as state from './state'
import { localDevice } from './token'

/**
 * 活跃度的两个出口：**记一笔**（本机账本）与**多机合并**（同步仓库里别的机器那份）。
 *
 * **两件事必须成对**：只记不广播，首页那张图要等到下次回首页、或下一次项目推送才会变色 ——
 * 用户明明刚写完一篇笔记，图上却什么动静都没有。凑在一起的地方只有这一处，
 * 所以单开一个模块：调用点分散在笔记 / 工作日志 / 知识库 / 会话四处，
 * 各写一遍迟早漏掉 `emit` 那一半。
 *
 * 调用点都在**真正做那件事、且知道成了**的地方（写盘 / 建索引成功之后）：
 * 「界面以为成了、其实失败了，格子里却多了一笔」这种账不许出现。
 * 适配层内部直接调它；AI 助手那一轮跑完在渲染层的 store 里才知道（见 stores/ai.ts 的 settle），
 * 走的是暴露出去的同名通道，最终也落到这里。
 *
 * 多机那一路（`activityView`）与用量同步共用一个克隆、一条串行队列：
 * 本机账本推 `activity/<设备id>.json`，别的机器那份读回来**只在内存里合并**给界面看 ——
 * 不写回本机文件，否则下一次推送会把它当成自己的，两台机器互相翻倍。
 */
export function recordActivity(kind: ActivityKind): void {
  state.recordActivity(kind)
  emit('activityChanged', null)
}

/**
 * 自动同步的节流：与用量那一路同一档（一小时）。
 *
 * 每记一笔就推一次会让仓库里堆满提交（写笔记一个下午就有几十笔）；
 * 一小时一轮足够「两台机器合起来看」，临时想立刻看到就重开首页（启动那一次不受节流限制）。
 * 间隔 / 换仓库即失效 / 同一时刻只跑一条这三条口径与用量、网关流水共用 `createAutoSync`。
 */
const syncGate = createAutoSync({
  intervalMs: 60 * 60_000,
  settled: () => emit('activityChanged', null),
})

/** 别的机器那份（已收敛、已修剪）；本机文件里不掺它，只在交给界面时合并 */
let remoteDays: ActivityBreakdown = {}
/** 上面那份读自哪个仓库：换仓库要重读，没配仓库时清空 */
let remoteRepo = ''

/**
 * 交给界面的一份活跃度：本机账本 + 同步仓库里别的机器那份（按天按来源求和）。
 *
 * 读回别人的分片只碰本地克隆（见 sync.rs 的 read_activity_shards），网络那一段按小时节流
 * 丢到后台；跑完广播 activityChanged，首页那张图据此重取并带上新数据。
 * 没登录 / 没配仓库（`repo` 为空）时只剩本机 —— 这也是「退出登录后数字回到本机」的落点。
 */
export async function activityView(repo: string): Promise<ActivityView> {
  const local = state.activityView()
  if (!repo) {
    resetRemote()
    return local
  }

  // 同一个仓库只在换仓库时读一次：两次同步之间克隆目录不会被别的进程改写
  if (remoteRepo !== repo)
    await readRemote(repo)

  scheduleSync(repo)

  const days = mergeActivityBreakdowns([local.days, remoteDays])
  return { total: totalOf(days), days }
}

/**
 * 读回别人的分片。**只碰本地克隆，不联网**（见 sync.rs 的 read_activity_shards）：
 * 内容是上一次同步取回来的样子，所以放进取数的关键路径也足够便宜。
 */
async function readRemote(repo: string): Promise<void> {
  try {
    const { id } = await localDevice()
    // 没有设备标识就分不出哪份是自己：宁可只显示本机，也不把本机那份再算一遍
    if (!id) {
      remoteDays = {}
      remoteRepo = repo
      return
    }

    const files = await invoke<unknown[]>('activity_sync_shards', { repo, device: id })
    const now = Date.now()
    remoteDays = mergeActivityBreakdowns(
      (Array.isArray(files) ? files : [])
        .map(item => sanitizeActivityShard(item))
        .filter((shard): shard is ActivityShard => shard !== null)
        .map(shard => pruneDays(shard.activity, now)),
    )
    remoteRepo = repo
  }
  catch {
    // 读不回来（克隆还指着上个仓库 / 目录被占）就把旧的丢掉：宁可少显示，也不显示错的
    remoteDays = {}
  }
}

/** 关掉同步 / 换仓库时把别人的那份撤掉，界面回到「只有本机」 */
function resetRemote(): void {
  remoteDays = {}
  remoteRepo = ''
  syncGate.reset()
}

/**
 * 该推 / 该拉的时候排一轮：本机账本推上去 → 读回别人的。
 *
 * 推送失败（没网 / 凭据过期）不该连带把读别人的分片停掉 —— 克隆还在，读是纯本地操作，
 * 读到就还能看到别的机器的最新数据。跑完无论成败都广播一次：新读回的分片立刻上屏。
 */
function scheduleSync(repo: string): void {
  syncGate.schedule(repo, async () => {
    try {
      const { id } = await localDevice()
      if (!id)
        return
      await invoke('activity_sync_publish', {
        repo,
        device: id,
        shard: captureShard(id),
      })
    }
    catch {
      // 推送失败只影响「别的机器什么时候看到本机」，读本地克隆那一步照旧往下走
    }

    await readRemote(repo)
  })
}

/** 推上去的永远只有本机账本 —— 别的机器那份只在内存里合并，写回去就会互相翻倍 */
function captureShard(device: string): ActivityShard {
  return {
    version: ACTIVITY_SHARD_VERSION,
    device,
    activity: pruneDays(state.activityView().days, Date.now()),
  }
}
