/**
 * 截图落盘的默认文件名。
 *
 * 时间是本地时间、不含冒号（Windows 文件名里冒号非法）：`截图-2026-10-12-143012.png`。
 * 排序友好是顺手的好处 —— 同一秒内的两张靠后缀区分（见 `uniqueName`）。
 */

/** 默认文件名。`date` 由调用方注入（测试要用固定时刻） */
export function defaultCaptureName(date: Date): string {
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-')
  const clock = [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
  return `截图-${stamp}-${clock}.png`
}

/**
 * 同名时加 `-2` / `-3` 后缀，直到不撞上。
 * `exists` 由调用方注入（真实判存在要走 Rust，测试直接给集合）。
 */
export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name))
    return name

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!exists(candidate))
      return candidate
  }
  return name
}

/**
 * 绝对路径 → 目录与文件名。
 *
 * 「另存为」那条路用得着：用户在对话框里挑的是一个**完整路径**，而落盘那条通道
 * （capture_save）要的是目录与文件名分开的两截（它自己去处理重名）。
 * 两种分隔符都认（对话框回来的可能是 `/`）。
 */
export function splitPath(path: string): { dir: string, name: string } {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (cut < 0)
    return { dir: '', name: path }

  // 盘根那个分隔符要留住（`C:\图.png` → 目录是 `C:\`，不是 `C:`）
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}
