/**
 * PREVIEW-ONLY：生成「水墨竹」出图母版。
 *
 * 手写 SVG 画竹子很难看：等宽描边像塑料管，叶子一片片摆位置也摆不出簇。
 * 这里用脚本算几何——竹竿是底粗梢细的实心锥形，叶子按枝头成簇发散——
 * 输出 resources/masters/ink-bamboo.svg，再用无头浏览器按 1920×1016 出 PNG。
 *
 * 注意：产物落在 masters（母版），不是 backgrounds（内置壁纸目录）——
 * backgrounds 里放什么，设置里就会列出什么，别把母版混进去。
 *
 *   node .preview/make-ink-bamboo.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const W = 1920
const H = 1016

/** 固定种子的伪随机：同一份脚本永远画出同一张图 */
let seed = 20260910
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const between = (a, b) => a + (b - a) * rnd()
const round = (n) => Number(n.toFixed(1))

// ---------- 几何 ----------

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]
  ]
}

/** 竹竿中心线：从地面拉到梢头，中间带一点自然的弯 */
function centerline({ baseX, topX, topY, bow }) {
  const span = H - topY
  const p0 = [baseX, H]
  const p1 = [baseX + bow, H - span * 0.45]
  const p2 = [topX - bow * 0.7, topY + span * 0.32]
  const p3 = [topX, topY]
  return (t) => bezier(p0, p1, p2, p3, t)
}

const SAMPLES = 26
const widthAt = (t, wb, wt) => wb + (wt - wb) * Math.pow(t, 0.85)

/** 竿身：左缘上去、右缘下来，收成一个尖梢 */
function stalkPath(spec) {
  const line = centerline(spec)
  const left = []
  const right = []
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = i / SAMPLES
    const [cx, cy] = line(t)
    const half = widthAt(t, spec.widthBase, spec.widthTop) / 2
    left.push([cx - half, cy])
    right.push([cx + half, cy])
  }

  const d = [`M ${round(left[0][0])} ${round(left[0][1])}`]
  for (const [x, y] of left.slice(1)) d.push(`L ${round(x)} ${round(y)}`)
  for (const [x, y] of right.reverse()) d.push(`L ${round(x)} ${round(y)}`)
  d.push('Z')
  return d.join(' ')
}

/** 竹节：横跨竿身的一道弧，比竿略宽一点 */
function nodePath(spec, t) {
  const [cx, cy] = centerline(spec)(t)
  const half = widthAt(t, spec.widthBase, spec.widthTop) / 2
  return `M ${round(cx - half - 5)} ${round(cy + 3)} Q ${round(cx)} ${round(cy - 6)} ${round(cx + half + 5)} ${round(cy + 3)}`
}

/**
 * 一片竹叶：以 (0,0) 为叶柄、向 +x 长出，尖端收细，上缘比下缘鼓一点。
 * 水墨里叶子是一笔扫出来的，所以上缘的弧要更饱满。
 */
function leafPath(len, wid) {
  const tip = len
  return [
    `M 0 0`,
    `C ${round(len * 0.16)} ${round(-wid * 0.52)} ${round(len * 0.6)} ${round(-wid * 0.56)} ${round(tip)} 0`,
    `C ${round(len * 0.62)} ${round(wid * 0.4)} ${round(len * 0.18)} ${round(wid * 0.44)} 0 0`,
    'Z'
  ].join(' ')
}

/** 枝：从竹节斜挑出去的一根细枝 */
function branchPath(from, to, bend) {
  const mx = (from[0] + to[0]) / 2 + bend
  const my = (from[1] + to[1]) / 2 - Math.abs(bend) * 0.6
  return `M ${round(from[0])} ${round(from[1])} Q ${round(mx)} ${round(my)} ${round(to[0])} ${round(to[1])}`
}

// ---------- 画 ----------

const parts = []
const push = (s) => parts.push(s)

/** 竹竿 + 竹节 */
function drawStalk(spec, ink) {
  const line = centerline(spec)
  const [cx, cy] = line(0.001)

  // 竿身：先铺一层模糊的墨晕（湿墨洇开），再压一笔实的
  push(
    `  <path d="${stalkPath(spec)}" fill="#3d4653" opacity="0.16" filter="url(#bleed)" />`
  )
  push(`  <path d="${stalkPath(spec)}" fill="url(#${ink})" />`)

  // 根部再压重一档，让竹子「扎」在地上
  push(
    `  <path d="${stalkPath({ ...spec, topY: H - (H - spec.topY) * 0.34 })}" fill="#232932" opacity="0.3" />`
  )

  const nodes = []
  for (let t = between(0.12, 0.2); t < 0.96; t += between(0.16, 0.23)) nodes.push(t)
  push(`  <g fill="none" stroke="#20262f" stroke-opacity="0.5" stroke-width="4.5" stroke-linecap="round">`)
  for (const t of nodes) push(`    <path d="${nodePath(spec, t)}" />`)
  push(`  </g>`)

  return { line, nodes }
}

/** 取某竿上最接近目标位置的那个竹节：枝要从节上长出来，不能在竿身上凭空冒 */
function nodeNear(stalk, target) {
  const t = stalk.nodes.reduce((best, value) =>
    Math.abs(value - target) < Math.abs(best - target) ? value : best
  )
  return stalk.line(t)
}

/**
 * 一簇叶子：从枝头散开，角度铺在一个扇形里，长短浓淡各不相同。
 * 叶子画两遍——模糊的一遍是洇开的湿墨，清楚的一遍是笔锋。
 */
function drawLeafCluster(origin, baseAngle, count, scale = 1) {
  const spread = between(52, 78)
  const leaves = []
  for (let i = 0; i < count; i += 1) {
    const k = count === 1 ? 0.5 : i / (count - 1)
    const angle = baseAngle + (k - 0.5) * spread + between(-6, 6)
    const len = between(72, 116) * scale
    const wid = len * between(0.17, 0.22)
    // 墨色压在中间调：再重就成了黑羽，卷面上也没有那么浓的叶子
    const opacity = between(0.24, 0.56)
    const dx = Math.cos((angle * Math.PI) / 180) * between(-10, 16)
    const dy = Math.sin((angle * Math.PI) / 180) * between(-10, 16)
    leaves.push({ angle, len, wid, opacity, x: origin[0] + dx, y: origin[1] + dy })
  }
  return leaves
}

function leafMarkup(leaves) {
  const out = []
  for (const leaf of leaves) {
    const xf = `translate(${round(leaf.x)} ${round(leaf.y)}) rotate(${round(leaf.angle)})`
    out.push(
      `    <path d="${leafPath(leaf.len, leaf.wid)}" transform="${xf}" fill="#3d4653" ` +
        `opacity="${round(leaf.opacity * 0.36)}" filter="url(#bleed)" />`
    )
    out.push(
      `    <path d="${leafPath(leaf.len, leaf.wid)}" transform="${xf}" fill="#2b323d" ` +
        `opacity="${round(leaf.opacity)}" />`
    )
  }
  return out.join('\n')
}

// 竹竿：左三竿、右两竿。左边是主景，右边只作呼应，中间整块留给卡片。
const leftStalks = [
  { baseX: 118, topX: 158, topY: 58, widthBase: 34, widthTop: 9, bow: 14, ink: 'ink-big' },
  { baseX: 226, topX: 252, topY: 238, widthBase: 25, widthTop: 8, bow: -10, ink: 'ink-mid' },
  { baseX: 300, topX: 308, topY: 622, widthBase: 14, widthTop: 6, bow: 6, ink: 'ink-thin' }
]
const rightStalks = [
  { baseX: 1714, topX: 1744, topY: 300, widthBase: 26, widthTop: 8, bow: -12, ink: 'ink-mid' },
  { baseX: 1818, topX: 1830, topY: 664, widthBase: 15, widthTop: 6, bow: 8, ink: 'ink-thin' }
]

const branchGroups = []

push('  <!-- 左丛 -->')
const leftStalkNodes = leftStalks.map((spec) => drawStalk(spec, spec.ink))
push('')

// 左丛的枝：两根长枝向右挑，把左丛「推」进画面中间（这一段大多在卡片后面，看不全也不碍事）
push('  <g fill="none" stroke="#39414d" stroke-opacity="0.46" stroke-width="4" stroke-linecap="round">')
const leftBranches = [
  [nodeNear(leftStalkNodes[0], 0.3), [352, 462], 44],
  [nodeNear(leftStalkNodes[0], 0.66), [452, 668], 40],
  [nodeNear(leftStalkNodes[1], 0.52), [318, 452], 24],
  [nodeNear(leftStalkNodes[2], 0.2), [262, 806], -22]
]
for (const [from, to, bend] of leftBranches) push(`    <path d="${branchPath(from, to, bend)}" />`)
push('  </g>')

for (const [i, [, to]] of leftBranches.entries()) {
  branchGroups.push({
    origin: [to[0], to[1]],
    angle: i === 2 ? -34 : i === 3 ? 168 : -12 + i * 6,
    count: i === 3 ? 3 : 4 + (i % 2),
    scale: i === 2 ? 0.78 : 1
  })
}

push('')
push('  <!-- 右丛 -->')
const rightStalkNodes = rightStalks.map((spec) => drawStalk(spec, spec.ink))
push('')

push('  <g fill="none" stroke="#39414d" stroke-opacity="0.42" stroke-width="4" stroke-linecap="round">')
const rightBranches = [
  [nodeNear(rightStalkNodes[0], 0.34), [1560, 686], -46],
  [nodeNear(rightStalkNodes[0], 0.62), [1648, 792], -34],
  [nodeNear(rightStalkNodes[1], 0.3), [1770, 866], 26]
]
for (const [from, to, bend] of rightBranches) push(`    <path d="${branchPath(from, to, bend)}" />`)
push('  </g>')

for (const [i, [, to]] of rightBranches.entries()) {
  branchGroups.push({ origin: [to[0], to[1]], angle: 186 - i * 8, count: 3 + (i % 2), scale: 0.86 })
}

// 叶簇
push('')
push('  <!-- 叶：枝头成簇 -->')
push('  <g>')
for (const group of branchGroups) {
  push(leafMarkup(drawLeafCluster(group.origin, group.angle, group.count, group.scale)))
}
push('  </g>')

// 竿脚附近的几片落叶，压住画面下缘
push('')
push('  <!-- 叶：竿脚与地面 -->')
push('  <g>')
push(leafMarkup(drawLeafCluster([124, 902], 22, 3, 0.92)))
push(leafMarkup(drawLeafCluster([248, 946], -18, 3, 0.8)))
push(leafMarkup(drawLeafCluster([300, 872], 200, 2, 0.72)))
push(leafMarkup(drawLeafCluster([1762, 934], 158, 3, 0.82)))
push(leafMarkup(drawLeafCluster([1838, 872], 196, 2, 0.7)))
push('  </g>')

// 中间几片飘叶：极淡，只在页脚留白里透出来
push('')
push('  <!-- 叶：中间飘叶，最淡 -->')
push('  <g fill="#5d6673">')
for (const [x, y, a, s] of [
  [700, 952, -14, 0.66],
  [1012, 978, 12, 0.58],
  [1236, 936, -26, 0.62],
  [560, 300, -40, 0.5],
  [1380, 264, 24, 0.46]
]) {
  push(
    `    <path d="${leafPath(96 * s, 96 * s * 0.22)}" transform="translate(${x} ${y}) rotate(${a})" opacity="0.14" />`
  )
}
push('  </g>')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!--
    工作区背景：水墨竹（由 .preview/make-ink-bamboo.mjs 生成，改构图请改脚本再跑一遍）

    尺寸 1920×1016 = 默认画布 1360×720 的同比例放大（1.889），也正好是主进程读图时的压缩上限，
    所以默认窗口、放大窗口都不会被拉伸。
    构图：左右两丛竹子把画布分成左中右三段，中间整块留白给卡片；墨集中在下半部，
    上缘几乎无墨——首页顶部还有一层白色光晕，正好接住这片留白。
    纯墨色：这个应用里颜色只用来表达运行状态。
  -->
  <defs>
    <!-- 竿身：根部浓、梢头淡，模拟一笔拉上去的枯笔 -->
    <linearGradient id="ink-big" x1="0" y1="${H}" x2="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#232932" stop-opacity="0.95" />
      <stop offset="0.4" stop-color="#39414d" stop-opacity="0.66" />
      <stop offset="0.75" stop-color="#5d6673" stop-opacity="0.3" />
      <stop offset="1" stop-color="#7f8a98" stop-opacity="0.08" />
    </linearGradient>
    <linearGradient id="ink-mid" x1="0" y1="${H}" x2="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2b323d" stop-opacity="0.86" />
      <stop offset="0.5" stop-color="#49525f" stop-opacity="0.5" />
      <stop offset="1" stop-color="#7f8a98" stop-opacity="0.06" />
    </linearGradient>
    <linearGradient id="ink-thin" x1="0" y1="${H}" x2="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#39414d" stop-opacity="0.68" />
      <stop offset="0.6" stop-color="#5d6673" stop-opacity="0.32" />
      <stop offset="1" stop-color="#8b95a3" stop-opacity="0.05" />
    </linearGradient>

    <!-- 湿墨洇开 -->
    <filter id="bleed" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="6" />
    </filter>
    <!-- 地面上那层雾 -->
    <filter id="mist" x="-20%" y="-60%" width="140%" height="220%">
      <feGaussianBlur stdDeviation="30" />
    </filter>
    <!-- 宣纸颗粒 -->
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.86" numOctaves="3" seed="11" />
      <feColorMatrix type="saturate" values="0" />
      <feComponentTransfer>
        <feFuncA type="linear" slope="0.07" />
      </feComponentTransfer>
    </filter>
  </defs>

  <!-- 宣纸底：与画布同色系，压上去不会跳出一块不同的白 -->
  <rect width="${W}" height="${H}" fill="#eff1f3" />
  <rect width="${W}" height="${H}" filter="url(#grain)" />

  <!-- 下半部一层极淡的墨气，把纸压出「地」的感觉 -->
  <ellipse cx="${W / 2}" cy="${H + 60}" rx="1120" ry="250" fill="#6b7480" opacity="0.11" filter="url(#mist)" />

${parts.join('\n')}
</svg>
`

mkdirSync('resources/masters', { recursive: true })
writeFileSync('resources/masters/ink-bamboo.svg', svg, 'utf8')
console.log(`ink-bamboo.svg 已生成：${svg.length} 字节`)
