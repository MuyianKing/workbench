import { promises as fs, writeFileSync } from 'node:fs'

/**
 * 「JSON 单文件 + 300ms 防抖 + 先写临时文件再 rename + 退出前同步落盘」的持久化引擎。
 *
 * 项目数据（workbench-data.json）与首页布局（theme.json）本来各写了一遍完全相同的时序逻辑，
 * 各自维护 loaded / writeTimer 两个状态，改一处崩溃安全就得改两处。抽成泛型后两者只提供
 * 路径、默认值和日志标签。
 */
export class JsonStore<T> {
  private cache: T
  private loaded = false
  private writeTimer: NodeJS.Timeout | null = null

  constructor(
    /** 每次写盘时重新取路径：数据目录可被用户迁移，路径并非固定 */
    private readonly filePath: () => string,
    /** 首次运行 / 文件损坏时的回退值，每次深拷一份由调用方负责 */
    private readonly fallback: () => T,
    /** 出错日志里的名字，例如「保存项目数据」 */
    private readonly label: string
  ) {
    this.cache = fallback()
  }

  get(): T {
    return this.cache
  }

  /**
   * 从磁盘载入。文件缺失或损坏时回到 fallback —— 不影响启动。
   * `parse` 负责把 unknown 收敛成 T（逐项 sanitize），由各存储自己提供。
   */
  async load(parse: (raw: unknown) => T): Promise<T> {
    try {
      const text = await fs.readFile(this.filePath(), 'utf-8')
      this.cache = parse(JSON.parse(text))
    } catch {
      this.cache = this.fallback()
    }
    this.loaded = true
    return this.cache
  }

  /** 直接替换内存值（调用方应已 sanitize 过） */
  set(value: T): void {
    this.cache = value
  }

  /** 变更即写，防抖 300ms；载入前不写盘，避免用空数据覆盖真实文件 */
  schedule(): void {
    if (!this.loaded) return
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, 300)
  }

  private async flush(): Promise<void> {
    const target = this.filePath()
    const tmp = `${target}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
      await fs.rename(tmp, target)
    } catch (err) {
      console.error(`[workbench] ${this.label}失败:`, err)
    }
  }

  /** 退出前同步落盘，防止防抖窗口内的改动丢失 */
  flushSync(): void {
    if (!this.loaded) return
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      writeFileSync(this.filePath(), JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error(`[workbench] 退出前${this.label}失败:`, err)
    }
  }
}
