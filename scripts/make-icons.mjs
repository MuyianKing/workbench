/**
 * 程序化生成应用图标，避免往仓库里塞（也没法用工具导出的）二进制素材。
 *
 *   node scripts/make-icons.mjs
 *
 * 产物：
 *   build/icon.ico            electron-builder 打包用（含 256/64/32/16）
 *   src/main/tray-icon.ts     托盘图标（32px PNG 的 data URL，运行时不依赖任何资源文件）
 *
 * 图形语言与标题栏的「›_」标记一致：深色圆角方块 + 白色折角与下划线。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---------- PNG 编码 ----------

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 绘制 ----------

const BG = [0x11, 0x15, 0x1b]
const FG = [0xff, 0xff, 0xff]

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function insideRoundedRect(x, y, size, radius, inset) {
  const min = inset
  const max = size - inset
  if (x < min || x > max || y < min || y > max) return false
  const cx = Math.min(Math.max(x, min + radius), max - radius)
  const cy = Math.min(Math.max(y, min + radius), max - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
}

/** 「›」折角 + 「_」下划线 */
function insideGlyph(x, y, size) {
  const stroke = 0.085 * size
  const chevron =
    distanceToSegment(x, y, 0.3 * size, 0.28 * size, 0.55 * size, 0.5 * size) <= stroke ||
    distanceToSegment(x, y, 0.55 * size, 0.5 * size, 0.3 * size, 0.72 * size) <= stroke
  const bar = distanceToSegment(x, y, 0.63 * size, 0.72 * size, 0.78 * size, 0.72 * size) <= 0.048 * size
  return chevron || bar
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 4
  const radius = size * 0.22
  const inset = size * 0.04
  const total = samples * samples

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let body = 0
      let ink = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = px + (sx + 0.5) / samples
          const y = py + (sy + 0.5) / samples
          if (!insideRoundedRect(x, y, size, radius, inset)) continue
          body += 1
          if (insideGlyph(x, y, size)) ink += 1
        }
      }

      const mix = body > 0 ? ink / body : 0
      const i = (py * size + px) * 4
      rgba[i] = Math.round(BG[0] * (1 - mix) + FG[0] * mix)
      rgba[i + 1] = Math.round(BG[1] * (1 - mix) + FG[1] * mix)
      rgba[i + 2] = Math.round(BG[2] * (1 - mix) + FG[2] * mix)
      rgba[i + 3] = Math.round((body / total) * 255)
    }
  }

  return rgba
}

// ---------- ICO 封装 ----------

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16
  for (const image of images) {
    const entry = Buffer.alloc(16)
    // 256 在这两个字段里用 0 表示
    entry[0] = image.size >= 256 ? 0 : image.size
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0 // 调色板数
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

// ---------- 输出 ----------

const sizes = [256, 64, 32, 16]
const images = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }))

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'icon.ico'), buildIco(images))

const tray = images.find((image) => image.size === 32)
const dataUrl = `data:image/png;base64,${tray.png.toString('base64')}`

writeFileSync(
  join(root, 'src', 'main', 'tray-icon.ts'),
  `/**
 * 由 scripts/make-icons.mjs 生成，请勿手工编辑。
 *
 * 托盘图标内联为 data URL：主进程在开发态与打包态都能直接拿到，
 * 不需要把资源文件额外搬进 out/ 或 app.asar 的资源目录。
 */
export const TRAY_ICON_DATA_URL =\n  '${dataUrl}'\n`
)

console.log(`已生成 build/icon.ico（${sizes.join('/')}）与 src/main/tray-icon.ts`)
