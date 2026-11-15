/**
 * 渲染层未捕获异常 → Rust 的 error.log（`frontend_error` 命令，实现见 workbench/api-events.ts）。
 *
 * 渲染层连 stderr 都没有：dev 控制台之外，正式版上「白了一下 / 弹一下就没了」的异常
 * 什么都不剩。三处入口都汇到这里：`error`（含资源加载失败）、`unhandledrejection`
 * （没人接的 Promise）与 Vue 的 `errorHandler`（组件树里的错 —— 装了它 Vue 就不再往
 * console 抛，细节去 error.log 看）。
 *
 * 防刷屏：错误可能在循环里成串出现（1 秒一次的轮询里同一个错），按分钟限流，超过就把
 * 这一分钟里剩下的丢弃 —— error.log 有轮转兜底，这里只挡大头。
 */
import type { App } from 'vue'

const MAX_PER_MINUTE = 20
let minute = -1
let sentInMinute = 0

function report(message: string, stack?: string): void {
  const thisMinute = Math.floor(Date.now() / 60_000)
  if (thisMinute !== minute) {
    minute = thisMinute
    sentInMinute = 0
  }
  sentInMinute += 1
  if (sentInMinute > MAX_PER_MINUTE)
    return
  // logError 经 guard 收敛、永不 reject，void 掉不会造成「报异常的通道自己报异常」
  void window.workbench?.logError(message, stack)
}

function describe(error: unknown): { message: string, stack?: string } {
  if (error instanceof Error)
    return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

/** 装全局钩子。main.ts 里 createApp 之后、mount 之前调一次。 */
export function installErrorReport(app: App): void {
  window.addEventListener('error', (event) => {
    if (event.error) {
      const { message, stack } = describe(event.error)
      report(message || '脚本错误', stack)
    }
    else {
      // 资源加载失败（img / script 404）走的是没有 error 对象的那一档
      report(`资源加载失败：${event.filename || '未知文件'}:${event.lineno}`)
    }
  })
  window.addEventListener('unhandledrejection', (event) => {
    const { message, stack } = describe(event.reason)
    report(`未处理的 Promise 拒绝：${message}`, stack)
  })
  app.config.errorHandler = (error, _instance, info) => {
    const described = describe(error)
    report(`Vue 组件错误（${info}）：${described.message}`, described.stack)
  }
}
