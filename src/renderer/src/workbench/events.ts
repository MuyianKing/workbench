/**
 * 适配层内部的事件分发。
 *
 * Electron 时代这些事件是从主进程经 IPC 推过来的；现在后端（Rust）只发原始行，
 * 事件语义在适配层里翻译，而渲染层的 store 仍然通过 `window.workbench.onXxx()` 订阅——
 * 换句话说这里补上的是「主进程本来那一段广播」的角色，契约一个字没变。
 */

type Handler = (payload: unknown) => void

const handlers = new Map<string, Set<Handler>>()

/** 订阅；返回退订函数（与 preload 版同形，组件 unmount 时直接调用） */
export function subscribe<T>(name: string, handler: (payload: T) => void): () => void {
  let group = handlers.get(name)
  if (!group) {
    group = new Set()
    handlers.set(name, group)
  }
  const entry = handler as Handler
  group.add(entry)
  return () => {
    group.delete(entry)
  }
}

export function emit<T>(name: string, payload: T): void {
  const group = handlers.get(name)
  if (!group) return
  // 先复制再遍历：处理器里可能出现退订（组件销毁）
  for (const handler of [...group]) handler(payload)
}
