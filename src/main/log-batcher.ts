import type { ProcessLogEvent } from '../shared/types'

/**
 * 默认聚合窗口：约一帧。
 * 取值不追求「最快送达」——渲染层本来就是按帧消费日志的，
 * 早到几百微秒没有意义，少发几千次 IPC 才是重点。
 */
export const LOG_FLUSH_INTERVAL_MS = 16

/**
 * 日志聚合器：把「一行一次 IPC」压成「一帧一次 IPC」。
 *
 * 狂刷日志的命令（npm install / vite build）能在几秒里产出上万行，
 * 逐行走 webContents.send 会把主进程和渲染进程一起拖住：每次 send 都要
 * 结构化克隆 + 跨进程唤醒。这里只攒队列，窗口到点整批交出去。
 *
 * 未开启 batching 时（active = false）走的就是原来的逐行行为，
 * 方便只在需要处开启，也方便测试在不引入定时器的前提下断言顺序。
 */
export class LogBatcher {
  private queue: ProcessLogEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = false

  constructor(private readonly emit: (events: ProcessLogEvent[]) => void) {}

  /** 开窗聚合；重复调用无副作用 */
  start(): void {
    this.active = true
  }

  push(event: ProcessLogEvent): void {
    this.queue.push(event)
    if (!this.active) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), LOG_FLUSH_INTERVAL_MS)
    }
  }

  /**
   * 把队列整批交出去。
   * 先清空引用再回调：回调里若又 push（或者抛错），队列状态不会半残。
   */
  flush(): void {
    this.clearTimer()
    if (!this.queue.length) return

    const events = this.queue
    this.queue = []
    this.emit(events)
  }

  /**
   * 先把某个终端的待发日志发出去，再执行 action。
   *
   * 用于「清空该终端输出」这类**顺序敏感**的事件：攒批会引入最长一个窗口的延迟，
   * 如果 clear 先到、上一轮的尾巴后到，那些行就会落在清屏之后 ——
   * 新一轮的输出里混进上一轮的日志。排空再清，顺序才和逐行发送时一致。
   */
  flushBefore(action: () => void): void {
    this.flush()
    action()
  }

  /** 退出前或测试收尾时用：停掉定时器并排空队列 */
  dispose(): void {
    this.flush()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
