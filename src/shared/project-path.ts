/**
 * 路径归一：统一大小写与斜杠方向，得到一个可直接比较的串。
 *
 * 目录是同一个就是同一个，不该因为写法不同被当成两处：
 * 盘符大小写（E:\ 与 e:\）、正反斜杠（E:/a/b 与 E:\a\b）都得归一。
 * 项目比对（pathKey）与残留进程匹配（orphan）以前各有一套相反的斜杠约定，
 * 现在共用这一个 —— 两边都只是拿来做「包含/相等」判断，方向不重要，一致才重要。
 */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

/** 目录比对键：在归一的基础上再去掉结尾斜杠 */
export function pathKey(path: string): string {
  return normalizePath(path).replace(/\/+$/, '')
}

export function samePath(left: string, right: string): boolean {
  const key = pathKey(left)
  return key.length > 0 && key === pathKey(right)
}
