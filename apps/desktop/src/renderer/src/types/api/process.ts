/**
 * `window.workbench` 上的一组通道：项目命令的进程会话与终端事件。
 * 实现见 `workbench/session.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  ProcessLogPayload,
  ProcessStatusEvent,
  TerminalKind,
  TerminalOpenEvent,
} from '../index'

export interface ProcessChannel {
  install: (id: string) => Promise<Result<null>>

  start: (id: string) => Promise<Result<null>>

  build: (id: string, script: string) => Promise<Result<null>>

  /** 执行项目配置里的第 index 条自定义命令 */
  runCustom: (id: string, index: number) => Promise<Result<null>>

  /**
   * 停止项目当前在跑的那条命令。
   *
   * 一个项目可以同时挂着几条会话（dev server 在跑、又点了一次打包），`kind` 就是「界面此刻
   * 显示的是哪一类」—— 给了就只停那一条，不给才退回「在跑的任意一条」。
   */
  stop: (id: string, kind?: TerminalKind) => Promise<Result<null>>

  /** 启动一条命令；进程由 Workbench 接管，日志进底部终端 */
  startCommand: (id: string) => Promise<Result<null>>

  /** 停止一条命令；已在应用外跑着的那种只能按端口结束，由渲染层先确认 */
  stopCommand: (id: string) => Promise<Result<null>>

  /** 日志可能单条推来，也可能是一批（主进程按帧聚合） */
  onLog: (fn: (e: ProcessLogPayload) => void) => () => void

  onStatus: (fn: (e: ProcessStatusEvent) => void) => () => void

  onTerminalOpen: (fn: (e: TerminalOpenEvent) => void) => () => void

  onClear: (fn: (e: { terminal: string }) => void) => () => void
}
