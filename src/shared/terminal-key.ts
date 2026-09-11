/**
 * 终端键的命名规则。
 *
 * 「一个项目的一类操作一个终端」是整个日志/终端模型的基础：主进程用它决定日志落到哪个
 * 终端、打开哪个 Tab，渲染层再按同一规则反推。以前这套 `id::kind` 拼接散在主进程和
 * 渲染层三四处，拼错一处就会把日志送进不存在的终端（打包提示写进「启动」标签就是例子），
 * 因此统一收在这里。
 */
export function terminalKey(projectId: string, kind: string): string {
  return `${projectId}::${kind}`
}
