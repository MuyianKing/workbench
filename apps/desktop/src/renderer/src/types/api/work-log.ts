/**
 * `window.workbench` 上的一组通道：工作日志（本机文件、多机同步、从提交生成）。
 * 实现见 `workbench/work-log.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type { WorkLogSyncOutcome } from '@workbench/work-log'
import type {
  GitCommitLog,
  GitWorkLogDraft,
  WorkLogEntry,
  WorkLogInput,
  WorkLogPatch,
} from '../index'

export interface WorkLogChannel {
  /**
   * 工作日志：整份列表（时间轴自己按范围分组、分页）。
   *
   * 数据住在本机的 `work-log.json`；配了同步仓库时会按设备分片推 / 拉
   * （`work-log/<设备id>.json`，合并规则见 @workbench/work-log 的 work-log-sync.ts）。
   *
   * 这里是 `Result` 而不是裸数组：读盘失败与「确实还没写过」必须分得开，
   * 把前者显示成空列表会让人以为自己的记录丢了。
   */
  listWorkLogs: () => Promise<Result<WorkLogEntry[]>>

  /** 新增一条；工作内容必填，为空时返回失败 */
  addWorkLog: (input: WorkLogInput) => Promise<Result<WorkLogEntry>>

  updateWorkLog: (id: string, patch: WorkLogPatch) => Promise<Result<WorkLogEntry>>

  removeWorkLog: (id: string) => Promise<Result<null>>

  /**
   * 工作日志的多机同步：拉别的设备分片 → 合并写回本机 → 推本机分片。
   *
   * 没登录 / 没配同步仓库时返回 `enabled: false`（本机数据照常）；
   * 失败时 `Result` 带原因，页面只在工具带留一行字，不弹消息。
   */
  syncWorkLogs: () => Promise<Result<WorkLogSyncOutcome>>

  /**
   * 读一个项目仓库的提交记录。**只读、本地**：只跑 git log 与 git config，
   * 不写仓库、不联网，也不是新的网络出口。
   *
   * `since` / `until` 是毫秒时间戳，宿主侧拿它们做 git `--since` / `--until` 的粗筛；
   * 精确到天的过滤与按项目 / 按天分组在 `@workbench/work-log` 里。不是 git 仓库时 `isRepo: false`。
   */
  projectGitLog: (dir: string, since?: number, until?: number) => Promise<Result<GitCommitLog>>

  /**
   * 把「从提交生成」预览里确认过的草稿写进工作日志。
   * 新建的条目带来源哈希（下次生成不会重复写），`appendTo` 的条目追加到已有记录上；
   * `deviceId` 指定新建条目属于哪台设备，留空 / 不传落本机。
   */
  importGitDrafts: (
    drafts: readonly GitWorkLogDraft[],
    deviceId?: string,
  ) => Promise<Result<WorkLogEntry[]>>
}
