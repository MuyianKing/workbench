/**
 * 定长环形缓冲：终端日志的存储层。
 *
 * 为什么不用普通数组：`push` 到 5000 行以后，每来一行都要 `splice(0, 1)`
 * 把整个数组往前搬一次；而且被 Vue 包成响应式数组后，每次写入都会触发
 * 依赖追踪。这里的两件事都要避开：
 *
 * - 写入摊还 O(1)：写满就覆盖最旧的那格，不动其余元素；
 * - 交给调用方 `markRaw` 掉，不参与响应式（渲染依赖另设的版本号）。
 */
export class RingLog<T> {
  private readonly items: Array<T | undefined>

  /** 已写入的累计条数（不受容量限制），用于判断覆盖情况 */
  private written = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('RingLog 容量必须是正整数')
    }
    this.items = new Array<T | undefined>(capacity)
  }

  /** 当前保留的条数（写满后等于容量） */
  get size(): number {
    return Math.min(this.written, this.capacity)
  }

  push(item: T): void {
    this.items[this.written % this.capacity] = item
    this.written += 1
  }

  /** 批量写入：一次调用写多行，只在最后更新一次计数 */
  pushMany(items: readonly T[]): void {
    for (const item of items) this.push(item)
  }

  /** 按写入顺序导出（最旧 → 最新） */
  toArray(): T[] {
    const size = this.size
    const out = new Array<T>(size)
    if (size < this.written) {
      // 已经绕过一圈：最旧的一条落在 written % capacity 这一格
      const start = this.written % this.capacity
      for (let i = 0; i < size; i += 1) {
        out[i] = this.items[(start + i) % this.capacity] as T
      }
      return out
    }

    for (let i = 0; i < size; i += 1) out[i] = this.items[i] as T
    return out
  }

  /** 清空，但保留容量：清日志是一个常见动作，没必要重建数组 */
  clear(): void {
    this.written = 0
    this.items.fill(undefined)
  }
}
