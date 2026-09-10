/**
 * 按给定 id 顺序重排列表。
 *
 * 拖动排序只给出「用户看到的顺序」，可能不含全部条目（新建的分组、并发写入产生的条目），
 * 所以没在顺序里出现的一律追加到末尾，绝不能凭空丢掉。
 */
export function reorderById<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []

  for (const id of ids) {
    const item = byId.get(id)
    if (!item) continue
    ordered.push(item)
    byId.delete(id)
  }

  for (const item of byId.values()) ordered.push(item)
  return ordered
}

/**
 * 把 fromId 挪到 toId 当前所在的位置上（拖拽排序用）。
 *
 * 两个 id 都得在顺序里：缺一个，或本来就在同一位置，说明这次拖动没改变任何东西，
 * 返回 null 让调用方跳过那次落盘。返回新数组，不动传入的。
 */
export function moveToPosition(ids: string[], fromId: string, toId: string): string[] | null {
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from === -1 || to === -1 || from === to) return null

  const next = [...ids]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}
