/**
 * 首页「命令」卡片：一批独立于项目的命令，点一下就跑。
 *
 * 与项目命令的差别在「配置」而不是「托管」：这里只有名称、命令原文与一个可选的监听端口，
 * 没有目录、包管理器、脚本；进程仍然由 Workbench 接管 —— 有日志、能停止、退出时一并收尾。
 * 命令一律在用户主目录下执行：这类命令多是全局 CLI，等价于新开一个终端直接敲它。
 */

import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { commandTextError } from '../shared/command'
import { parsePort } from '../shared/port'
import { fail, ok } from '../shared/result'
import type { CommandEntry, CommandInput, CommandPatch, Result } from '../shared/types'
import { manager } from './manager'
import { data, save } from './store'

/** 命令的工作目录：命令卡片没有目录配置，统一放主目录 */
function commandCwd(): string {
  return app.getPath('home')
}

export function listCommands(): CommandEntry[] {
  return data().commands
}

export function addCommand(input: CommandInput): Result<CommandEntry> {
  const command = typeof input?.command === 'string' ? input.command.trim() : ''
  const error = commandTextError(command)
  if (error) return fail(error)

  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name) return fail('名称不能为空')

  const entry: CommandEntry = {
    id: randomUUID(),
    name,
    command,
    port: parsePort(input.port),
    order: data().commands.length,
    createdAt: Date.now()
  }

  data().commands.push(entry)
  save()
  return ok(entry)
}

export function updateCommand(id: string, patch: CommandPatch): Result<CommandEntry> {
  const entry = data().commands.find((item) => item.id === id)
  if (!entry) return fail('该命令已不存在')

  if (typeof patch?.name === 'string') {
    const name = patch.name.trim()
    if (!name) return fail('名称不能为空')
    entry.name = name
  }

  if (typeof patch?.command === 'string') {
    const command = patch.command.trim()
    const error = commandTextError(command)
    if (error) return fail(error)
    entry.command = command
  }

  // 未传 port 表示不改；显式传 null / 非法值表示清空
  if ('port' in (patch ?? {})) entry.port = parsePort(patch.port)

  save()
  return ok(entry)
}

export function removeCommand(id: string): Result<null> {
  const list = data().commands
  const index = list.findIndex((item) => item.id === id)
  if (index === -1) return fail('该命令已不存在')

  // 进程还在跑就先停掉：条目一删，它的终端与停止入口就都没了
  if (manager.isActive(id)) manager.stop(id)

  list.splice(index, 1)
  list.forEach((item, position) => {
    item.order = position
  })
  save()
  return ok(null)
}

/**
 * 启动一条命令。
 * 端口占用由渲染层在调用前确认并清理（与项目启动同一套流程），这里只管把进程拉起来。
 */
export function startCommand(id: string): Result<null> {
  const entry = data().commands.find((item) => item.id === id)
  if (!entry) return fail('该命令已不存在')
  if (manager.isActive(id)) return fail('该命令正在运行')

  const error = manager.runCardCommand(entry, commandCwd())
  if (error) return fail(error)
  return ok(null)
}

export function stopCommand(id: string): Result<null> {
  if (!manager.isActive(id)) return fail('该命令没有正在运行的进程')
  manager.stop(id)
  return ok(null)
}
