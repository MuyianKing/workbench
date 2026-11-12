/**
 * 「最近打开的仓库」清单（Git 页头部的仓库下拉）。
 *
 * 与笔记的「最近打开」同一套形状：路径按目录的规矩收敛（去首尾空白与末尾分隔符，
 * 盘根留住分隔符），去空、按 Windows 的口径不区分大小写去重，超过上限的整段丢掉。
 * 收敛放在这里是为了有单测：它落在磁盘边界上，手工改坏的数据不该把下拉弄乱。
 * 路径只对本机成立，所以它进数据文件、不参与外观同步。
 */

/** 「最近打开」最多留几个：再多也只是往回找的清单，下拉放不下 */
export const GIT_REPO_HISTORY_MAX = 10

/** 一个仓库根目录的收敛口径（与笔记 / 技能目录同一条：盘根 `E:` 保留成 `E:\`） */
export function sanitizeGitRepoRoot(raw: unknown): string {
  if (typeof raw !== 'string')
    return ''
  const trimmed = raw.trim()
  if (!trimmed)
    return ''
  const cut = trimmed.replace(/[\\/]+$/, '')
  return /^[a-z]:$/i.test(cut) ? `${cut}\\` : cut
}

/** 收敛一份「打开过的仓库」清单：空的、重复的、超过上限的都丢掉 */
export function sanitizeRepoHistory(raw: unknown): string[] {
  if (!Array.isArray(raw))
    return []

  const seen = new Set<string>()
  const list: string[] = []
  for (const item of raw) {
    const root = sanitizeGitRepoRoot(item)
    if (!root)
      continue

    // 同一个目录在 Windows 上不分大小写，`/` 与 `\` 也等价：比对键统一成小写正斜杠
    const key = root.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    list.push(root)
    if (list.length >= GIT_REPO_HISTORY_MAX)
      break
  }
  return list
}

/** 打开（或换到）一个仓库：它排到最前面，已在那儿的不会出现两次 */
export function pushRepoHistory(history: unknown, root: unknown): string[] {
  const target = sanitizeGitRepoRoot(root)
  if (!target)
    return sanitizeRepoHistory(history)
  return sanitizeRepoHistory([target, ...sanitizeRepoHistory(history)])
}
