/**
 * 同步仓库的串行队列。
 *
 * token 用量与网关流水共用同一个克隆（用户数据根目录下的 `token-sync/`：安装版
 * `%APPDATA%/Workbench/`、开发版 `%APPDATA%/Workbench-dev/`），
 * 两个 git 进程同时动它会撞 `index.lock`。所有「推 + 拉」都从这里排队，
 * 只读本地克隆的取数不走队列。
 *
 * 任务失败也要把队列放行：一次推送失败不能把后面所有同步永久卡住。
 */
let inflight: Promise<unknown> = Promise.resolve()

export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = inflight.then(task, task)
  inflight = next.catch(() => undefined)
  return next
}
