/**
 * 像素取色的几个小函数（放大镜旁边那个色块与十六进制读数）。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

function toHex(value: number): string {
  const byte = Math.min(255, Math.max(0, Math.round(value)))
  return byte.toString(16).padStart(2, '0')
}

/** `{r,g,b}` → `#rrggbb` */
export function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
}

/** `#rgb` / `#rrggbb` → `{r,g,b}`；认不出的回黑色（色块总得有个颜色画） */
export function hexToRgb(hex: string): Rgb {
  const text = hex.trim().replace(/^#/, '')
  const full = text.length === 3
    ? text.split('').map(char => `${char}${char}`).join('')
    : text
  if (!/^[\da-f]{6}$/i.test(full))
    return { r: 0, g: 0, b: 0 }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

/**
 * 铺在给定底色上的文字该用黑还是白（放大镜读数框要压在一片像素上，
 * 固定用白字在亮部就看不清了）。
 */
export function readableInkOn(color: Rgb): string {
  // 感知亮度（ITU-R BT.601），阈值取中间偏一点：白底上用深字更稳
  const luminance = (color.r * 299 + color.g * 587 + color.b * 114) / 1000
  return luminance > 150 ? '#111111' : '#ffffff'
}
