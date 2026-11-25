/**
 * 笔记导出版面（纸张）大小的口径：允许哪几种、缺项 / 坏值怎么收敛、CSS 里怎么写。
 *
 * 只管导出那一份自包含 HTML（见 export-html.ts）：注入 `@page { size: … }` 让浏览器
 * 「打印 / 另存为 PDF」按对应纸张排版，同时给 `.export-page` 一个与纸张相称的最大宽度。
 * 编辑器本身不按纸张排版（正文左右固定留白、宽度自适应，见 NoteEditor），这里不动。
 *
 * 默认 A4：新装、老数据文件缺项、值被手工改坏时都落回它。
 */

/** 支持的纸张：只有常见的两种；其余交给浏览器默认不归这里管 */
export const NOTE_PAGE_SIZES = ['A4', 'Letter'] as const
export type NotePageSize = (typeof NOTE_PAGE_SIZES)[number]

/** 默认纸张 */
export const NOTE_PAGE_SIZE_DEFAULT: NotePageSize = 'A4'

/**
 * 老数据文件里没有这个字段 / 值被改坏时收敛到 A4。
 * 只认清单里那几种（大小写不敏感，统一成大写），其余一律回默认。
 */
export function sanitizeNotePageSize(value: unknown): NotePageSize {
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase()
    // 大小写不敏感地比对，但要回清单里那份规范写法（'Letter' 不是 'LETTER'）
    const match = NOTE_PAGE_SIZES.find(size => size.toUpperCase() === upper)
    if (match)
      return match
  }
  return NOTE_PAGE_SIZE_DEFAULT
}

/**
 * 纸张对应的 CSS声明：@page 的 size 与导出容器的最大宽度。
 *
 * 容器宽度取纸张短边（A4 210mm ≈ 794px、Letter 216mm ≈ 816px）减去左右各 32px 内边距
 * 后的可读宽度，跟 export-html.ts 的 `.export-page` padding 对齐；打印时由 @media print
 * 把宽度与内边距收掉，交给 @page 自己控制分页。
 */
export function notePageSizeCss(size: NotePageSize): { atPage: string, maxWidth: string } {
  if (size === 'Letter') {
    return { atPage: 'Letter', maxWidth: '752px' }
  }
  return { atPage: 'A4', maxWidth: '730px' }
}
