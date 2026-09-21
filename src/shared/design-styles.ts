/**
 * 设计样式（74 套 DESIGN.md 的解析结果）的类型与纯逻辑。
 *
 * 数据本体是 `src/renderer/public/design-styles.json`（随包静态资源，页面首次打开时读一次），
 * 这里只放两端都不依赖宿主的部分：颜色计算、token 引用展开、键名的中文标签规则、筛选排序。
 *
 * **键名的中文标签是规则生成而不是手写词典**：74 套一共 677 个颜色键、221 个字阶键、829 个组件键，
 * 手写不可能维护。绝大多数键是 `surface-dark-elevated` 这种 kebab-case 组合，按下面的词段表逐段翻译即可；
 * 只有那 10 个「散文格式」品牌（键名是人写的 `Hero Display`、`Spotify Green`）译不出来，
 * 它们的中文标签由构建时写进数据的 `labels` 字段，这里优先取用。
 *
 * 没有任何键名能覆盖到底的词段会原样保留 —— 像 `rausch`（Airbnb 的品牌红）、`safu`（Kraken 的术语）
 * 本来就是专有名词，硬翻反而失真。
 */

/** 明暗基调：用页面底色判定，不是「最亮/最暗色」 */
export type DesignTheme = 'light' | 'dark'

/** 色系：只看色相，用于界面上的「按色系筛」 */
export type ColorFamily = '红' | '橙' | '黄' | '绿' | '青' | '蓝' | '紫' | '粉' | '中性'

export const COLOR_FAMILIES: readonly ColorFamily[] = [
  '红',
  '橙',
  '黄',
  '绿',
  '青',
  '蓝',
  '紫',
  '粉',
  '中性'
]

export const THEME_LABELS: Record<DesignTheme, string> = { light: '浅色系', dark: '深色系' }

/** 一个字阶（typography 里的一条） */
export interface DesignTypeToken {
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
}

/**
 * 一个组件的规格。值有两类：具体值（`12px 20px`、`#fff`）与对其它 token 的引用（`{colors.primary}`），
 * 引用由 `resolveTokenRef` 展开。
 */
export interface DesignComponentToken {
  backgroundColor?: string
  textColor?: string
  borderColor?: string
  borderWidth?: string
  borderStyle?: string
  typography?: string
  rounded?: string
  padding?: string
  height?: string
  width?: string
  size?: string
  boxShadow?: string
  [key: string]: string | undefined
}

/** 手写的中文标签，只有散文格式品牌才有；其余品牌走规则生成 */
export interface DesignStyleLabels {
  colors?: Record<string, string>
  typography?: Record<string, string>
  components?: Record<string, string>
}

export interface DesignStyle {
  brand: string
  /** 界面上的名字，专有名词保留原文 */
  title: string
  /** 中文分类，如「AI 与大模型」 */
  category: string
  theme: DesignTheme
  /** 主色（品牌色） */
  accent: string
  /** 画布色 */
  canvas: string
  /** 展示字体名，可能为空 */
  font: string
  /** 卡片色条：构建时挑好的一组代表色 */
  strip: string[]
  /** 中文描述：对这套设计语言的评述 */
  description: string
  colors: Record<string, string>
  typography: Record<string, DesignTypeToken>
  rounded: Record<string, string>
  spacing: Record<string, string>
  components: Record<string, DesignComponentToken>
  labels?: DesignStyleLabels
}

// ---------------------------------------------------------------- 颜色计算

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** 解析 hex，认不出来回 null（不抛错：外部数据手改坏过也不能白屏） */
export function parseHex(value: unknown): { r: number; g: number; b: number } | null {
  if (typeof value !== 'string') return null
  const matched = HEX_RE.exec(value.trim())
  if (!matched) return null
  let hex = matched[1]
  if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch)
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  }
}

/** 是不是一个能写进样式的颜色值（hex / 常见函数式写法 / 关键字） */
export function isColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (parseHex(text)) return true
  return /^(rgb|rgba|hsl|hsla|oklch|lab|color-mix)\(/i.test(text) || text === 'transparent'
}

/** 相对亮度（WCAG），用于决定叠在某个底色上的字用黑还是白 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  const channel = (value: number): number => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/**
 * 叠在这个底色上的字该用黑还是白。阈值取 0.45 而不是 0.5：
 * 深色系品牌里大量 `#181715` 这类近黑底，0.5 会让中灰底判成白字而糊掉。
 */
export function inkOn(background: string): string {
  return relativeLuminance(background) > 0.45 ? '#11151b' : '#ffffff'
}

/** 色相（0–360），灰阶回 -1 */
export function hueOf(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return -1
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  if (span < 0.04) return -1
  let hue: number
  if (max === r) hue = ((g - b) / span) % 6
  else if (max === g) hue = (b - r) / span + 2
  else hue = (r - g) / span + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

/**
 * 色系判定：按色相切档，低饱和/极值的归「中性」。
 * 界面上的「按色系筛」和卡片角标都用它，两处必须是同一个判据。
 */
export function colorFamily(hex: string): ColorFamily {
  const rgb = parseHex(hex)
  if (!rgb) return '中性'
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  // 接近纯黑/纯白/灰：没有色相可言
  if (span < 0.08 || max < 0.09 || min > 0.94) return '中性'
  const hue = hueOf(hex)
  if (hue < 0) return '中性'
  // 粉与红用「红偏冷 + 偏亮」区分，纯靠色相分不开
  if (hue < 12 || hue >= 345) return b > r * 0.62 && max > 0.55 ? '粉' : '红'
  if (hue < 40) return '橙'
  if (hue < 68) return '黄'
  if (hue < 160) return '绿'
  if (hue < 200) return '青'
  // 蓝紫分界放在 245：品牌里的 violet / indigo（#6a5fc1 这类）色相在 246 上下，
  // 边界划在 255 会让它们全被算成蓝，界面上就没有紫色可筛了
  if (hue < 245) return '蓝'
  if (hue < 292) return '紫'
  return '粉'
}

/** 这套设计的色系：跟着主色走 */
export function designStyleFamily(style: DesignStyle): ColorFamily {
  return colorFamily(style.accent)
}

// ---------------------------------------------------------------- token 引用

const REF_RE = /^\{([a-zA-Z]+)\.([^}]+)\}$/

/**
 * 展开 `{colors.primary}` 这类引用。引用指向不存在的 token 时回 undefined（而不是回原字符串 ——
 * 那会被当成 CSS 值原样写进样式，静默画出一个错颜色）。
 */
export function resolveTokenRef(
  value: unknown,
  style: Pick<DesignStyle, 'colors' | 'typography' | 'rounded' | 'spacing'>
): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  const matched = REF_RE.exec(text)
  if (!matched) return text
  const block = matched[1]
  const key = matched[2]
  if (block === 'colors') return style.colors[key]
  if (block === 'rounded') return style.rounded[key]
  if (block === 'spacing') return style.spacing[key]
  if (block === 'typography') return undefined // 字阶不是单个值，走 typographyRef
  return undefined
}

/** `{typography.button}` 指向的是整条字阶，单独取出来用 */
export function typographyRef(
  value: unknown,
  style: Pick<DesignStyle, 'typography'>
): DesignTypeToken | undefined {
  if (typeof value !== 'string') return undefined
  const matched = REF_RE.exec(value.trim())
  if (!matched || matched[1] !== 'typography') return undefined
  return style.typography[matched[2]]
}

/** 只放行看起来像 CSS 值的短字符串，挡住 `url(...)`、分号、花括号这类会改变样式表结构的输入 */
export function safeCssValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > 120) return undefined
  if (/[<>;{}]/.test(text)) return undefined
  if (/url\s*\(|expression|javascript:/i.test(text)) return undefined
  return text
}

/** 一个组件渲染到界面上的最终样式（值都已展开、已收敛） */
export interface ComponentStyle {
  background?: string
  color?: string
  border?: string
  borderRadius?: string
  padding?: string
  height?: string
  width?: string
  boxShadow?: string
  font?: DesignTypeToken
}

/** 把一条组件规格展开成可直接绑到 :style 的对象；缺 textColor 时按底色自动定黑白字 */
export function componentStyle(token: DesignComponentToken, style: DesignStyle): ComponentStyle {
  const background = safeCssValue(resolveTokenRef(token.backgroundColor, style))
  // 没给字色时按底色自动定黑白。只有认得出 hex 才敢算对比度：`rgba(...)` 算不出亮度，
  // 硬猜会把白字放到浅底上。
  const color =
    safeCssValue(resolveTokenRef(token.textColor, style)) ??
    (background && parseHex(background) ? inkOn(background) : undefined)
  const borderColor = safeCssValue(resolveTokenRef(token.borderColor, style))
  const borderWidth = safeCssValue(token.borderWidth)
  const borderStyle = safeCssValue(token.borderStyle) ?? (borderWidth ? 'solid' : undefined)
  const border = borderColor ? `${borderWidth ?? '1px'} ${borderStyle ?? 'solid'} ${borderColor}` : undefined
  return {
    background,
    color,
    border: safeCssValue(border),
    borderRadius: safeCssValue(resolveTokenRef(token.rounded, style)),
    padding: safeCssValue(token.padding),
    height: safeCssValue(token.height ?? token.size),
    width: safeCssValue(token.width),
    boxShadow: safeCssValue(token.boxShadow),
    font: typographyRef(token.typography, style)
  }
}

// ---------------------------------------------------------------- 中文标签

/**
 * 词段表：键名按 `-` 拆开后逐段查这里。
 * 顺序无关，查不到的词段原样保留（专有名词靠这个兜底）。
 */
const SEGMENTS: Record<string, string> = {
  // 角色
  primary: '主色',
  secondary: '次色',
  tertiary: '三级色',
  accent: '强调色',
  brand: '品牌色',
  signature: '标志色',
  commerce: '电商色',
  neutral: '中性色',
  inverse: '反色',
  inverted: '反色',
  semantic: '语义',
  success: '成功',
  warning: '警告',
  warn: '警告',
  error: '错误',
  danger: '危险',
  critical: '严重',
  info: '信息',
  positive: '正向',
  negative: '负向',
  attention: '注意',
  alert: '警报',
  sale: '促销',
  trading: '交易',
  fin: '金融',
  // 明暗与浓淡
  dark: '深色',
  darkest: '最深',
  deeper: '更深',
  deep: '深',
  night: '夜间',
  light: '浅色',
  lightest: '最浅',
  bright: '明亮',
  pale: '淡',
  soft: '柔和',
  softer: '更柔和',
  subtle: '微妙',
  faint: '极淡',
  muted: '弱化',
  mute: '弱化',
  strong: '加重',
  stronger: '更重',
  subdued: '收敛',
  translucent: '半透明',
  frosted: '磨砂',
  tinted: '着色',
  tint: '浅调',
  shade: '色阶',
  // 表面与结构
  canvas: '画布',
  surface: '表面',
  background: '背景',
  bg: '背景',
  card: '卡片',
  panel: '面板',
  tile: '方块',
  block: '区块',
  box: '盒子',
  bar: '条',
  band: '色带',
  strip: '条纹',
  stripe: '条纹',
  ribbon: '缎带',
  chip: '标签块',
  tag: '标签',
  badge: '徽标',
  pill: '胶囊',
  capsule: '胶囊',
  dot: '圆点',
  orb: '圆球',
  circle: '圆形',
  square: '方形',
  avatar: '头像',
  logo: '标志',
  wordmark: '品牌字标',
  icon: '图标',
  illustration: '插画',
  mascot: '吉祥物',
  sticker: '贴纸',
  mockup: '示意稿',
  screenshot: '截图',
  thumbnail: '缩略图',
  swatch: '色块',
  palette: '色板',
  gradient: '渐变',
  glow: '光晕',
  shadow: '阴影',
  overlay: '蒙层',
  scrim: '遮罩',
  frame: '画框',
  border: '描边',
  bordered: '描边',
  outline: '外框',
  divider: '分隔线',
  rule: '分隔线',
  hairline: '细线',
  ring: '焦点环',
  keycap: '键帽',
  inset: '内嵌',
  floating: '浮动',
  // 文字
  ink: '文字色',
  text: '文字',
  body: '正文',
  title: '标题',
  heading: '标题',
  headline: '大标题',
  subhead: '副标题',
  subtitle: '副标题',
  sub: '次级',
  overline: '顶线',
  eyebrow: '眉题',
  caption: '说明字',
  label: '标签字',
  micro: '微型字',
  mono: '等宽',
  code: '代码',
  terminal: '终端',
  tui: '终端界面',
  stat: '数据',
  stats: '数据',
  number: '数字',
  quote: '引语',
  byline: '署名',
  tagline: '标语',
  prose: '正文',
  legal: '法务',
  fine: '细则',
  print: '印刷',
  // 表单与控件
  button: '按钮',
  input: '输入框',
  textarea: '多行输入框',
  select: '选择器',
  dropdown: '下拉',
  checkbox: '复选框',
  radio: '单选',
  toggle: '开关',
  switch: '开关',
  slider: '滑块',
  picker: '选择器',
  form: '表单',
  field: '字段',
  auth: '认证',
  login: '登录',
  signup: '注册',
  search: '搜索',
  filter: '筛选',
  sort: '排序',
  pagination: '分页',
  breadcrumb: '面包屑',
  nav: '导航',
  subnav: '次级导航',
  menu: '菜单',
  sidebar: '侧栏',
  rail: '侧栏',
  header: '页头',
  footer: '页脚',
  top: '顶部',
  sticky: '吸顶',
  pane: '面板',
  window: '窗口',
  modal: '弹窗',
  drawer: '抽屉',
  sheet: '抽屉面板',
  toast: '提示条',
  tip: '提示',
  tooltip: '提示框',
  banner: '横幅',
  promo: '促销',
  callout: '提示块',
  announcement: '公告',
  newsletter: '订阅',
  cookie: 'Cookie',
  consent: '同意',
  segmented: '分段选择',
  // 版式
  hero: '首屏',
  section: '区块',
  content: '内容',
  page: '页面',
  app: '应用',
  shell: '外壳',
  layout: '布局',
  grid: '网格',
  matrix: '矩阵',
  row: '行',
  cell: '单元格',
  table: '表格',
  data: '数据',
  list: '列表',
  item: '条目',
  step: '步骤',
  steps: '步骤',
  timeline: '时间轴',
  accordion: '折叠面板',
  faq: '常见问题',
  carousel: '轮播',
  gallery: '画廊',
  tabs: '标签页',
  tab: '标签页',
  tabbed: '标签页式',
  option: '选项',
  group: '分组',
  collection: '合集',
  region: '区域',
  wall: '墙',
  stack: '堆叠',
  sphere: '圆球',
  // 商业
  pricing: '定价',
  tier: '档位',
  plan: '套餐',
  price: '价格',
  buy: '购买',
  cart: '购物车',
  checkout: '结算',
  shop: '商店',
  store: '商店',
  product: '产品',
  pdp: '商品详情',
  inventory: '库存',
  order: '订单',
  discount: '折扣',
  coupon: '优惠券',
  perk: '权益',
  rewards: '奖励',
  subscription: '订阅',
  monthly: '月付',
  yearly: '年付',
  amount: '金额',
  currency: '货币',
  markets: '市场',
  funds: '资金',
  invoice: '账单',
  billing: '计费',
  // 内容与功能
  feature: '功能',
  features: '功能',
  benefit: '优势',
  comparison: '对比',
  testimonial: '用户评价',
  customer: '客户',
  reviews: '评价',
  review: '评价',
  rating: '评分',
  star: '星级',
  stars: '星级',
  trust: '信任',
  spotlight: '聚光灯',
  showcase: '展示',
  preview: '预览',
  demo: '演示',
  example: '示例',
  ex: '示例',
  cta: '行动按钮',
  link: '链接',
  inline: '行内',
  ghost: '幽灵',
  filled: '实心',
  dotted: '点线',
  dashed: '虚线',
  circular: '圆形',
  rounded: '圆角',
  inner: '内',
  outer: '外',
  left: '左',
  right: '右',
  end: '结束',
  start: '开始',
  from: '起点',
  to: '终点',
  up: '涨',
  down: '跌',
  new: '新建',
  popular: '热门',
  featured: '精选',
  active: '激活',
  pressed: '按下',
  press: '按下',
  hover: '悬停',
  focused: '聚焦',
  focus: '聚焦',
  disabled: '禁用',
  inactive: '未激活',
  visited: '已访问',
  required: '必填',
  selected: '选中',
  selection: '选中',
  default: '默认',
  state: '状态',
  status: '状态',
  empty: '空态',
  placeholder: '占位',
  skeleton: '骨架',
  loading: '加载中',
  secure: '安全',
  // 文档与站点
  snippet: '代码片段',
  keyword: '关键词',
  command: '命令',
  prompt: '提示词',
  token: '设计变量',
  spec: '规格',
  specs: '规格',
  doc: '文档',
  docs: '文档',
  changelog: '更新日志',
  blog: '博客',
  article: '文章',
  news: '新闻',
  newsroom: '新闻中心',
  story: '报道',
  campaign: '活动',
  magazine: '杂志',
  masthead: '报头',
  marquee: '走马灯',
  podcast: '播客',
  // 场景
  project: '项目',
  workflow: '工作流',
  workspace: '工作区',
  environment: '环境',
  ecosystem: '生态',
  platform: '平台',
  enterprise: '企业',
  business: '商业',
  startup: '创业',
  developer: '开发者',
  develop: '开发',
  deploy: '部署',
  install: '安装',
  download: '下载',
  host: '主机',
  driver: '驱动',
  extension: '扩展',
  plugin: '插件',
  toolkit: '工具包',
  capability: '能力',
  program: '计划',
  course: '课程',
  university: '大学',
  research: '研究',
  community: '社区',
  support: '支持',
  help: '帮助',
  contact: '联系',
  career: '招聘',
  events: '活动',
  event: '活动',
  about: '关于',
  why: '为什么',
  day: '日',
  date: '日期',
  calendar: '日历',
  time: '时间',
  // 素材
  asset: '素材',
  image: '图片',
  photo: '摄影',
  photographic: '摄影',
  cinematic: '电影感',
  video: '视频',
  audio: '音频',
  voice: '语音',
  waveform: '波形',
  qr: '二维码',
  // 游戏 / 汽车 / 硬件
  game: '游戏',
  games: '游戏',
  console: '主机',
  paddle: '手柄',
  esrb: '分级',
  vehicle: '车型',
  motorsport: '赛车',
  race: '赛道',
  livery: '涂装',
  preowned: '二手车',
  warranty: '质保',
  service: '服务',
  reservation: '预约',
  guest: '访客',
  member: '会员',
  amenity: '设施',
  experience: '体验',
  sku: '商品编号',
  // 尺寸阶梯
  xxs: '微小',
  xxxs: '极小',
  xs: '极小',
  sm: '小',
  md: '中',
  lg: '大',
  xl: '特大',
  xxl: '超大',
  xxxl: '巨大',
  xxxxl: '宏大',
  '2xl': '超大',
  '3xl': '巨大',
  '4xl': '宏大',
  '5xl': '极大',
  '6xl': '最大',
  huge: '特大',
  super: '超大',
  mega: '超大',
  jumbo: '巨型',
  large: '大',
  medium: '中',
  small: '小',
  mini: '迷你',
  nano: '极微',
  tight: '紧凑',
  dense: '密集',
  airy: '疏朗',
  bold: '粗体',
  emph: '强调',
  emphasis: '强调',
  emphasized: '强调',
  caps: '全大写',
  uppercase: '全大写',
  tabular: '等宽数字',
  utility: '功能',
  base: '基础',
  none: '无',
  full: '全',
  hair: '极细',
  height: '高度',
  width: '宽度',
  size: '尺寸',
  typography: '字体',
  // 颜色词：色板里大量直接以颜色命名的键（`accent-blue`、`stone`、`charcoal`），
  // 这一段是标签能全中文的关键，缺一个就漏一个英文串
  white: '白',
  black: '黑',
  gray: '灰',
  grey: '灰',
  blue: '蓝',
  yellow: '黄',
  green: '绿',
  purple: '紫',
  orange: '橙',
  pink: '粉',
  red: '红',
  teal: '青绿',
  cyan: '青',
  coral: '珊瑚',
  cream: '奶油',
  violet: '紫罗兰',
  magenta: '洋红',
  mint: '薄荷',
  peach: '蜜桃',
  rose: '玫瑰',
  amber: '琥珀',
  gold: '金',
  navy: '藏青',
  sage: '鼠尾草绿',
  salmon: '鲑粉',
  olive: '橄榄绿',
  indigo: '靛蓝',
  lilac: '丁香紫',
  ochre: '赭黄',
  aubergine: '茄紫',
  sunshine: '阳光黄',
  sky: '天蓝',
  lime: '青柠',
  brown: '棕',
  forest: '森林绿',
  emerald: '祖母绿',
  turquoise: '绿松石',
  platinum: '铂金',
  graphite: '石墨灰',
  crimson: '绯红',
  ruby: '宝石红',
  wine: '酒红',
  ice: '冰蓝',
  chrome: '铬色',
  periwinkle: '长春花蓝',
  parchment: '羊皮纸色',
  pearl: '珍珠白',
  aloe: '芦荟绿',
  pistachio: '开心果绿',
  charcoal: '炭黑',
  stone: '石灰',
  ash: '灰白',
  slate: '石板灰',
  steel: '钢灰',
  iron: '铁灰',
  smoke: '烟灰',
  mist: '雾灰',
  fog: '雾色',
  cloud: '云灰',
  silver: '银灰',
  bronze: '青铜',
  copper: '铜色',
  sand: '沙色',
  clay: '陶土',
  moss: '苔绿',
  sea: '海蓝',
  ocean: '海洋蓝',
  storm: '风暴灰',
  bloom: '花开色',
  sunset: '落日色',
  twilight: '暮色',
  dusk: '黄昏色',
  midnight: '午夜蓝',
  breeze: '微风色',
  bone: '骨白',
  paper: '纸白',
  snow: '雪白',
  ivory: '象牙白',
  beige: '米色',
  taupe: '灰褐',
  electric: '电光',
  saturated: '高饱和',
  warm: '暖',
  cool: '冷',
  deepest: '最深',
  // 其它高频词
  display: '展示字',
  branding: '品牌',
  template: '模板',
  model: '模型',
  marketing: '营销',
  cap: '全大写',
  invert: '反色',
  elevated: '抬升',
  mid: '中间',
  m: '中',
  s: '小',
  ui: '界面',
  ide: '编辑器',
  editor: '编辑器',
  toc: '目录',
  resource: '资源',
  industry: '行业',
  contributor: '贡献者',
  segment: '分段',
  category: '分类',
  property: '属性',
  city: '城市',
  favorite: '收藏',
  feedback: '反馈',
  mustard: '芥末黄',
  topic: '话题',
  lead: '引导',
  global: '全局',
  subscribe: '订阅',
  arena: '竞技场',
  crypto: '加密',
  chart: '图表',
  conversion: '转化',
  trader: '交易',
  luxe: '奢华',
  plus: '增强',
  lavender: '薰衣草',
  carbon: '碳灰',
  action: '行动',
  device: '设备',
  phone: '手机',
  expert: '专家',
  agent: '智能体',
  configurator: '配置器',
  chatbot: '聊天机器人',
  launcher: '启动器',
  connector: '连接器',
  arrow: '箭头',
  listing: '列表',
  burst: '爆炸标',
  cert: '证书',
  seal: '印章',
  tracked: '加宽字距',
  illustrated: '插画',
  cinema: '影院',
  // Cursor 的产品内时间轴阶段名，原文就是这几个词
  thinking: '思考',
  read: '读取',
  edit: '编辑',
  grep: '检索',
  done: '完成',
  report: '报告',
  position: '名次',
  checkmark: '对勾',
  decoration: '装饰',
  color: '色'
}

/**
 * 少数高频键按整键覆盖：规则拼出来的读不通，而这些键在 74 套里反复出现，值得逐条写清楚。
 * 查表顺序是「整键覆盖 → 词段规则」。
 */
const KEY_LABELS: Record<string, string> = {
  'text-input': '输入框',
  'text-input-focused': '输入框（聚焦）',
  'button-primary': '主按钮',
  'button-primary-active': '主按钮（激活）',
  'button-primary-pressed': '主按钮（按下）',
  'button-primary-disabled': '主按钮（禁用）',
  'button-secondary': '次按钮',
  'button-secondary-on-dark': '次按钮（深色上）',
  'button-tertiary': '三级按钮',
  'button-tertiary-text': '三级文字按钮',
  'button-ghost': '幽灵按钮',
  'button-outline': '描边按钮',
  'button-outline-on-dark': '描边按钮（深色上）',
  'button-link': '文字按钮',
  'button-text-link': '文字链接按钮',
  'button-icon-circular': '圆形图标按钮',
  'button-disabled': '禁用按钮',
  'text-link': '文字链接',
  'link-inline': '行内链接',
  'footer-link': '页脚链接',
  'top-nav': '顶部导航',
  'nav-bar': '导航栏',
  'nav-link': '导航链接',
  'primary-nav': '主导航',
  'hero-band': '首屏色带',
  'hero-band-dark': '首屏色带（深色）',
  'feature-card': '功能卡片',
  'pricing-card': '定价卡片',
  'pricing-card-featured': '定价卡片（推荐）',
  'pricing-tier-card': '定价档卡片',
  'pricing-tier-card-featured': '定价档卡片（推荐）',
  'product-card': '产品卡片',
  'testimonial-card': '用户评价卡片',
  'card-feature': '功能卡片',
  'badge-pill': '胶囊徽标',
  'pill-tab': '胶囊标签页',
  'pill-tab-active': '胶囊标签页（激活）',
  'category-tab': '分类标签页',
  'category-tab-active': '分类标签页（激活）',
  'code-block': '代码块',
  'search-pill': '胶囊搜索框',
  'promo-banner': '促销横幅',
  'faq-row': '常见问题行',
  'faq-accordion-item': '常见问题折叠项',
  'footer-section': '页脚分组',
  'footer-region': '页脚区域',
  'footer-light': '页脚（浅色）',
  'card-pricing': '定价卡片',
  'link-md': '链接（中）',
  'ex-pricing-tier': '示例·定价档',
  'ex-pricing-tier-featured': '示例·定价档（推荐）',
  'ex-product-selector': '示例·产品选择器',
  'ex-cart-drawer': '示例·购物车抽屉',
  'ex-app-shell-row': '示例·应用外壳行',
  'ex-data-table-cell': '示例·数据表单元格',
  'ex-auth-form-card': '示例·认证表单卡片',
  'ex-modal-card': '示例·弹窗卡片',
  'ex-empty-state-card': '示例·空态卡片',
  'ex-toast': '示例·提示条',
  'card-title': '卡片标题',
  'display-xxl': '展示字（超大）',
  'display-xl': '展示字（特大）',
  'display-lg': '展示字（大）',
  'display-md': '展示字（中）',
  'display-sm': '展示字（小）',
  'display-xs': '展示字（极小）',
  'heading-xl': '标题（特大）',
  'heading-lg': '标题（大）',
  'heading-md': '标题（中）',
  'heading-sm': '标题（小）',
  'body-lg': '正文（大）',
  'body-md': '正文（中）',
  'body-sm': '正文（小）',
  'body-lg-strong': '正文（大·加重）',
  'body-md-medium': '正文（中·中等）',
  'body-md-bold': '正文（中·粗体）',
  'body-sm-medium': '正文（小·中等）',
  'body-sm-strong': '正文（小·加重）',
  'body-strong': '正文（加重）',
  'button-md': '按钮（中）',
  'button-sm': '按钮（小）',
  'button-lg': '按钮（大）',
  'button-large': '按钮（大）',
  'button-cap': '按钮（全大写）',
  'caption-uppercase': '说明字（全大写）',
  'caption-strong': '说明字（加重）',
  'micro-uppercase': '微型字（全大写）',
  'eyebrow-uppercase': '眉题（全大写）',
  'number-display': '数据展示字',
  'number-md': '数字（中）',
  'number-sm': '数字（小）',
  'stat-display': '数据展示字',
  'hero-display': '首屏展示字',
  'body-md-strong': '正文（中·加重）',
  card: '卡片圆角',
  hero: '首屏圆角',
  feature: '特色圆角'
}

/**
 * 键名 → 中文标签。`labels` 里有就用手写的（散文格式品牌），否则走词段规则。
 *
 * 规则：`on-xxx` 读作「xxx 上的文字」；其余按 `-` 拆段逐段翻译后用 `·` 连起来，
 * 原样保持词序 —— 这些键本来就是「主体 + 修饰」的顺序（`surface-dark-elevated` = 表面·深色·抬升）。
 */
export function tokenLabel(key: string, labels?: Record<string, string>): string {
  const hand = labels?.[key]
  if (hand) return hand
  const whole = KEY_LABELS[key]
  if (whole) return whole

  if (key.startsWith('on-')) {
    return `${tokenLabel(key.slice(3), labels)}上的文字`
  }
  // 中缀的 on 表示「放在什么底色上」：`link-on-light` 读作「链接（浅色上）」
  const middle = key.indexOf('-on-')
  if (middle > 0) {
    return `${tokenLabel(key.slice(0, middle), labels)}（${tokenLabel(key.slice(middle + 4), labels)}上）`
  }

  const parts = key.split('-').filter(Boolean)
  const translated = parts.map((part) => {
    const lower = part.toLowerCase()
    return SEGMENTS[lower] ?? SEGMENTS[part] ?? part
  })
  return translated.join('·')
}

export function colorLabel(style: DesignStyle, key: string): string {
  return tokenLabel(key, style.labels?.colors)
}

export function typeLabel(style: DesignStyle, key: string): string {
  return tokenLabel(key, style.labels?.typography)
}

export function componentLabel(style: DesignStyle, key: string): string {
  return tokenLabel(key, style.labels?.components)
}

export function roundedLabel(style: DesignStyle, key: string): string {
  return tokenLabel(key)
}

export function spacingLabel(style: DesignStyle, key: string): string {
  return tokenLabel(key)
}

// ---------------------------------------------------------------- 配色分组

/** 详情页配色的分组标题，顺序即显示顺序 */
export const COLOR_GROUPS = ['品牌与强调', '表面与画布', '文字与线条', '语义状态', '其它'] as const
export type ColorGroup = (typeof COLOR_GROUPS)[number]

const GROUP_RULES: Array<[ColorGroup, RegExp]> = [
  ['语义状态', /success|warning|warn|error|danger|critical|info|positive|negative|attention|alert/],
  [
    '品牌与强调',
    /primary|accent|brand|signature|secondary|tertiary|link|cta|commerce|sale|trading|fin|highlight/
  ],
  ['文字与线条', /ink|text|body|caption|muted|mute|hairline|border|divider|rule|outline|ring|focus|label|heading|title|byline/],
  ['表面与画布', /canvas|surface|background|bg|card|panel|overlay|scrim|elevated|inset|paper|cream|night/]
]

export function colorGroup(key: string): ColorGroup {
  for (const [group, rule] of GROUP_RULES) if (rule.test(key)) return group
  return '其它'
}

// ---------------------------------------------------------------- 组件分类

/** 详情页里组件样张的分组 */
export type ComponentGroup = '按钮' | '表单' | '卡片' | '版式'

export const COMPONENT_GROUPS: readonly ComponentGroup[] = ['按钮', '卡片', '表单', '版式']

const COMPONENT_RULES: Array<[ComponentGroup, RegExp]> = [
  ['按钮', /button|cta|(^|-)tabs?(-|$)|pill-tab|link|badge|chip/],
  ['表单', /input|field|textarea|select|checkbox|radio|toggle|switch|search|form/],
  ['卡片', /card|tile|pricing|tier|modal|toast|callout|drawer|sheet|panel|table|row|cell|empty|story|quote|testimonial/]
]

export function componentGroup(key: string): ComponentGroup {
  for (const [group, rule] of COMPONENT_RULES) if (rule.test(key)) return group
  return '版式'
}

/** 按组分好的组件键；组内保持数据里的原顺序（上游是按重要性排的） */
export function groupComponents(style: DesignStyle): Record<ComponentGroup, string[]> {
  const out: Record<ComponentGroup, string[]> = { 按钮: [], 卡片: [], 表单: [], 版式: [] }
  for (const key of Object.keys(style.components)) out[componentGroup(key)].push(key)
  return out
}

// ---------------------------------------------------------------- 列表取值

/**
 * 按主色统计出来的色系清单。界面上的色系 chip 由它生成 —— 直接铺满九档会出现
 * 「点了没有任何结果」的空档（真实数据里就没有紫色主色的品牌）。
 */
export function familyCounts(
  styles: DesignStyle[],
  familyOf: (style: DesignStyle) => ColorFamily = designStyleFamily
): Array<{ family: ColorFamily; count: number }> {
  const counts = new Map<ColorFamily, number>()
  for (const style of styles) {
    const family = familyOf(style)
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  return COLOR_FAMILIES.filter((family) => counts.has(family)).map((family) => ({
    family,
    count: counts.get(family) ?? 0
  }))
}

/** 按分类统计，规则同上：界面上只列真实存在的分类 */
export function categoryCounts(styles: DesignStyle[]): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>()
  for (const style of styles) counts.set(style.category, (counts.get(style.category) ?? 0) + 1)
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, 'zh'))
}


/** 组件排在前面的那几条最值得画出来，其余只做计数 */
export const GROUP_PREVIEW_LIMIT: Record<ComponentGroup, number> = {
  按钮: 12,
  卡片: 6,
  表单: 4,
  版式: 10
}

/** 字阶按字号从大到小（认不出字号的一律排到最后） */
export function typographyScale(style: DesignStyle): Array<[string, DesignTypeToken]> {
  const size = (token: DesignTypeToken): number => {
    const matched = /([\d.]+)/.exec(token.fontSize ?? '')
    return matched ? Number(matched[1]) : -1
  }
  return Object.entries(style.typography).sort((a, b) => size(b[1]) - size(a[1]))
}

/** 间距 / 圆角按数值从小到大 —— 它们是阶梯，按阶梯顺序看才有意义 */
export function numericScale(
  block: Record<string, string>
): Array<[string, string, number]> {
  const value = (raw: string): number => {
    const matched = /([\d.]+)/.exec(raw)
    return matched ? Number(matched[1]) : -1
  }
  return Object.entries(block)
    .map(([key, raw]) => [key, raw, value(raw)] as [string, string, number])
    .sort((a, b) => a[2] - b[2])
}

/**
 * 一套设计最终能看的组件样张：分组 + 每组截断。
 * 三个品牌（lamborghini / runwayml / tesla）上游没给组件规格，这里自然回空。
 */
export function componentSamples(style: DesignStyle): Array<{
  group: ComponentGroup
  keys: string[]
  rest: number
}> {
  const grouped = groupComponents(style)
  return COMPONENT_GROUPS.map((group) => {
    const keys = grouped[group]
    const limit = GROUP_PREVIEW_LIMIT[group]
    return { group, keys: keys.slice(0, limit), rest: Math.max(0, keys.length - limit) }
  }).filter((entry) => entry.keys.length > 0)
}

// ---------------------------------------------------------------- 筛选与排序

export type ThemeFilter = 'all' | DesignTheme
export type FamilyFilter = 'all' | ColorFamily
export type DesignStyleSort = 'az' | 'hue' | 'dark'

export const SORT_LABELS: Record<DesignStyleSort, string> = {
  az: '名称 A–Z',
  hue: '按色相',
  dark: '深色优先'
}

export interface DesignStyleFilter {
  query?: string
  theme?: ThemeFilter
  family?: FamilyFilter
  category?: string
}

/**
 * 关键词索引：把品牌名、分类、字体、中文描述、每个颜色的键名与中文标签、以及全部色值拼成一串。
 * 建一次缓存起来（74 套 × 几十个 token，每次输入都重算没必要）。
 */
export function designStyleHaystack(style: DesignStyle): string {
  const parts: string[] = [
    style.title,
    style.brand,
    style.category,
    style.font,
    style.description,
    // 主色与画布色是卡片上最显眼的两个值，用户很可能会照着它们搜
    style.accent,
    style.canvas
  ]
  for (const [key, value] of Object.entries(style.colors)) {
    parts.push(key, colorLabel(style, key), value)
  }
  for (const key of Object.keys(style.components)) parts.push(key, componentLabel(style, key))
  for (const key of Object.keys(style.typography)) parts.push(key, typeLabel(style, key))
  for (const key of Object.keys(style.spacing)) parts.push(key, spacingLabel(style, key))
  for (const key of Object.keys(style.rounded)) parts.push(key, roundedLabel(style, key))
  return parts.join(' ').toLowerCase()
}

export function filterDesignStyles(
  styles: DesignStyle[],
  filter: DesignStyleFilter,
  haystackOf: (style: DesignStyle) => string = designStyleHaystack
): DesignStyle[] {
  const query = (filter.query ?? '').trim().toLowerCase()
  const theme = filter.theme ?? 'all'
  const family = filter.family ?? 'all'
  const category = filter.category ?? 'all'
  return styles.filter((style) => {
    if (theme !== 'all' && style.theme !== theme) return false
    if (family !== 'all' && designStyleFamily(style) !== family) return false
    if (category !== 'all' && style.category !== category) return false
    if (!query) return true
    return haystackOf(style).includes(query)
  })
}

export function sortDesignStyles(
  styles: DesignStyle[],
  sort: DesignStyleSort,
  familyOf: (style: DesignStyle) => ColorFamily = designStyleFamily
): DesignStyle[] {
  const list = [...styles]
  if (sort === 'az') {
    list.sort((a, b) => a.title.localeCompare(b.title, 'en'))
    return list
  }
  if (sort === 'dark') {
    // 深色系排前面；同档按名称，避免每次渲染顺序抖动
    list.sort((a, b) => {
      if (a.theme !== b.theme) return a.theme === 'dark' ? -1 : 1
      return a.title.localeCompare(b.title, 'en')
    })
    return list
  }
  const familyOrder = COLOR_FAMILIES
  list.sort((a, b) => {
    const fa = familyOrder.indexOf(familyOf(a))
    const fb = familyOrder.indexOf(familyOf(b))
    if (fa !== fb) return fa - fb
    const ha = hueOf(a.accent)
    const hb = hueOf(b.accent)
    if (ha !== hb) return ha - hb
    return a.title.localeCompare(b.title, 'en')
  })
  return list
}

// ---------------------------------------------------------------- 外部数据收敛

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && raw.trim()) out[key] = raw
  }
  return out
}

function typographyMap(value: unknown): Record<string, DesignTypeToken> {
  if (!isRecord(value)) return {}
  const out: Record<string, DesignTypeToken> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const token: DesignTypeToken = {}
    for (const field of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'] as const) {
      const text = raw[field]
      if (typeof text === 'string' && text.trim()) token[field] = text
      else if (typeof text === 'number') token[field] = String(text)
    }
    out[key] = token
  }
  return out
}

function componentMap(value: unknown): Record<string, DesignComponentToken> {
  if (!isRecord(value)) return {}
  const out: Record<string, DesignComponentToken> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const token: DesignComponentToken = {}
    for (const [field, cell] of Object.entries(raw)) {
      if (typeof cell === 'string' && cell.trim()) token[field] = cell
      else if (typeof cell === 'number') token[field] = String(cell)
    }
    out[key] = token
  }
  return out
}

function labelsOf(value: unknown): DesignStyleLabels | undefined {
  if (!isRecord(value)) return undefined
  const labels: DesignStyleLabels = {
    colors: stringMap(value.colors),
    typography: stringMap(value.typography),
    components: stringMap(value.components)
  }
  return labels
}

/**
 * 收敛随包的那份 JSON。它不会真的坏，但落盘数据一律收敛是项目约定：
 * 读不动的一条直接丢掉，不能让整个页面白屏。
 */
export function sanitizeDesignStyles(raw: unknown): DesignStyle[] {
  const list = isRecord(raw) && Array.isArray(raw.styles) ? raw.styles : Array.isArray(raw) ? raw : []
  const out: DesignStyle[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const brand = typeof entry.brand === 'string' ? entry.brand.trim() : ''
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    const accent = typeof entry.accent === 'string' ? entry.accent.trim() : ''
    if (!brand || !title || !isColorValue(accent)) continue
    const canvas = typeof entry.canvas === 'string' && isColorValue(entry.canvas) ? entry.canvas : accent
    out.push({
      brand,
      title,
      category: typeof entry.category === 'string' ? entry.category : '其它',
      theme: entry.theme === 'dark' ? 'dark' : 'light',
      accent,
      canvas,
      font: typeof entry.font === 'string' ? entry.font : '',
      strip: Array.isArray(entry.strip) ? entry.strip.filter(isColorValue) : [],
      description: typeof entry.description === 'string' ? entry.description : '',
      colors: stringMap(entry.colors),
      typography: typographyMap(entry.typography),
      rounded: stringMap(entry.rounded),
      spacing: stringMap(entry.spacing),
      components: componentMap(entry.components),
      labels: labelsOf(entry.labels)
    })
  }
  return out
}
