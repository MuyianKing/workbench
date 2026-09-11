/**
 * 项目目录的比对键。
 *
 * 目录是同一个就是同一个，不该因为写法不同被当成两处：
 * 盘符大小写（E:\ 与 e:\）、正反斜杠（E:/a/b 与 E:\a\b）、结尾多一个斜杠都得归一。
 * 添加与重新定位都用它判断「这个目录是不是已经有主了」。
 */
export function pathKey(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function samePath(left: string, right: string): boolean {
  const key = pathKey(left)
  return key.length > 0 && key === pathKey(right)
}
