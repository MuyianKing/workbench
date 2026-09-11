import { IPC } from '../shared/types'
import { broadcast } from './broadcast'
import { LogBatcher } from './log-batcher'
import { ProcessManager } from './process-manager'

/**
 * 运行中子进程的唯一入口。
 *
 * 这个单例原先和 IPC 注册挤在 ipc.ts 里：index.ts 只想拿 manager 和退出前的日志排空，
 * 却因为一个 import 把整张依赖图（scanner / nvm / quick-launch / wallpapers…）都拉进启动路径，
 * 窗口与退出逻辑也跟「IPC 处理器怎么注册」绑在一起。拆出来后两边各取所需。
 *
 * 这里只做「进程事件 → 广播」的纯转发；落盘、历史记录、产物目录提示等要碰 store / scanner 的
 * 监听留在 ipc.ts，免得 manager 反向依赖数据层。
 */

/**
 * 命令输出先聚合、再整批广播。
 *
 * 逐行 send 在高产出的命令下会把两侧一起拖垮 —— npm install / vite build 几秒能出
 * 上万行，每行一次结构化克隆加跨进程唤醒。这里按帧攒批，把 IPC 次数从
 * 「行数」压到「帧数」。系统提示、包管理器安装输出仍走单条直发：
 * 它们本来就稀疏，聚合只会平白多一层延迟。
 *
 * 放在 manager 之前：manager 需要它来保证「清空终端」这类事件的先后顺序。
 */
const logBatcher = new LogBatcher((events) => broadcast(IPC.eventLog, events))
logBatcher.start()

/** 退出前把还没到窗口的日志排空，免得最后几行随进程一起消失 */
export function flushLogBatches(): void {
  logBatcher.dispose()
}

export const manager = new ProcessManager(() => logBatcher.flush())

manager.on('log', (payload) => logBatcher.push(payload))
manager.on('status', (payload) => broadcast(IPC.eventStatus, payload))
manager.on('terminal-open', (payload) => broadcast(IPC.eventTerminalOpen, payload))
manager.on('clear', (payload) => broadcast(IPC.eventClear, payload))
