/**
 * 项目里「启动 / 打包」怎么引用一条命令的纯逻辑。
 *
 * 下拉候选既有 package.json 的 scripts 名，也有项目里的自定义命令（整行原文）。
 * 两者必须能存在同一个字段里，又要让执行这一侧分得清：脚本名拼成 `<pm> run <name>`，
 * 自定义命令直接交给 shell，不以 node / npm / nvm 为前提（见 workbench/session.ts）。
 *
 * 自定义命令编码成 `@custom:<index>`。`@` 不在脚本名正则 `^\w[\w:.-]*$` 里，
 * 既不会和真实脚本名撞上，又会被 isValidScriptName 自动挡在 `<pm> run` 之外。
 */

/** 自定义命令引用的前缀；索引从 0 起，对应 scripts.custom 的下标 */
const CUSTOM_REF_PREFIX = '@custom:'

/** 把一条自定义命令的下标编码成可存进 scripts.serve / build 的引用 */
export function customRef(index: number): string {
  return `${CUSTOM_REF_PREFIX}${index}`
}

/**
 * 解出一个引用指向哪条自定义命令；不是自定义引用时返回 null。
 * 只认非负整数下标，手改数据文件写进来的 `@custom:x` 当普通（非法）脚本名处理。
 */
export function customRefIndex(ref: string | undefined): number | null {
  if (!ref?.startsWith(CUSTOM_REF_PREFIX))
    return null
  const raw = ref.slice(CUSTOM_REF_PREFIX.length)
  if (!/^\d+$/.test(raw))
    return null
  const index = Number(raw)
  return Number.isSafeInteger(index) ? index : null
}

/**
 * 把一个引用解析成界面上显示的文字。自定义引用显示成「自定义：名称」，
 * 下标越界（手改数据文件删过了）就退回原样，让人看出这条已经失效。
 */
export function commandLabel(
  ref: string,
  customs: ReadonlyArray<{ name: string }>,
): string {
  const index = customRefIndex(ref)
  if (index === null)
    return ref
  const name = customs[index]?.name
  return name ? `自定义：${name}` : ref
}
