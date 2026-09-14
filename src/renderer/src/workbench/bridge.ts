/**
 * 渲染层与 Tauri 后端之间的桥。
 *
 * 三条约定：
 *  1. 前端只认 `window.workbench` 这个契约，不认识 Tauri 命令名 —— 名字映射收敛在这里；
 *  2. 尚未移植的通道统一走 `notPorted`，返回与 `Result` 同形的失败值而不是抛错，
 *     界面因此降级成空态而不是白屏（迁移期间的可观测性靠它）；
 *  3. 全部经 `__TAURI__` / `__TAURI_INTERNALS__`，不引 npm 依赖（tauri.conf.json 里开了 withGlobalTauri）。
 */

/** Tauri 注入到 window 上的全局对象（withGlobalTauri） */
interface TauriGlobalApi {
  core?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
    /** 磁盘路径 → webview 能直接加载的 asset URL（scheme 各平台不同，别自己拼） */
    convertFileSrc?: (path: string) => string
  }
  event?: {
    listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>
  }
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobalApi
    __TAURI_INTERNALS__?: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
    }
    /** 主进程在页面加载前注入的首屏快照（见 src-tauri/src/main.rs 的 bootstrap_script） */
    __WB_BOOTSTRAP__?: unknown
  }
}

/** 当前是否跑在 Tauri 里。不是的话说明还在浏览器预览里，适配层不接管。 */
export function hasTauri(): boolean {
  return Boolean(window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke)
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // 必须带上 this 调用：Tauri 注入的 invoke 是挂在 core 上的方法，
  // 摘下来单独引用（const f = core.invoke; f(...)）会丢掉绑定 —— 表现出来就是
  // 「无参数的调用正常、带参数的调用到不了 Rust」这种很迷惑的形态。
  const core = window.__TAURI__?.core
  if (core) return core.invoke(command, args) as Promise<T>

  const internals = window.__TAURI_INTERNALS__
  if (internals) return internals.invoke(command, args) as Promise<T>

  return Promise.reject(new Error(`Tauri 运行时不可用，无法调用 ${command}`))
}

/**
 * 磁盘路径 → webview 能直接加载的 asset URL（工作区背景图走这条路，见适配层的 loadBackground）。
 *
 * 转换交给 Tauri 的 convertFileSrc：asset 协议的 scheme 与转义规则各平台不一样，自己拼迟早出错。
 * 同样要带上 this 调用（理由见上面 invoke 那条注释）。拿不到它就说明不在 Tauri 里，抛错交给调用方。
 *
 * 注意能力边界：asset 协议只认 Rust 侧显式授权过的文件（见 commands.rs 的 allow_background），
 * 这里能拼出 URL 不代表 webview 读得到。
 */
export function assetUrl(path: string): string {
  const core = window.__TAURI__?.core
  if (!core?.convertFileSrc) throw new Error('Tauri 运行时不可用，无法加载本地文件')

  return core.convertFileSrc(path)
}

/**
 * 订阅后端事件，返回取消订阅函数。
 * 与 preload 版的 subscribe 同形，调用方（组件）不需要知道底下是 ipcRenderer 还是 Tauri event。
 */
export function listen<T>(event: string, handler: (payload: T) => void): () => void {
  let dispose: (() => void) | null = null
  let cancelled = false

  void window.__TAURI__?.event
    ?.listen<T>(event, ({ payload }) => handler(payload))
    .then((unlisten) => {
      if (cancelled) unlisten()
      else dispose = unlisten
    })

  return () => {
    cancelled = true
    dispose?.()
  }
}

/** 已经报过「尚未移植」的通道，避免同一个警告刷满控制台 */
const warned = new Set<string>()

/**
 * 尚未移植的通道。
 *
 * 返回 `{ ok: false }` 而不是抛错：绝大多数通道本来就是 `Result` 形状，
 * 界面会照常走「失败提示」那条路；数组型的取值接口会退化成空态。
 */
export function notPorted(channel: string): Promise<never> {
  if (!warned.has(channel)) {
    warned.add(channel)
    console.warn(`[workbench] 通道尚未移植到 Tauri 后端: ${channel}`)
  }
  return Promise.resolve({ ok: false, error: `「${channel}」尚未移植到 Tauri 后端` } as never)
}
