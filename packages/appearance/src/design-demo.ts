/**
 * 样式页的「示例页面」：把一套设计语言的 token 装成一个完整的中文落地页。
 *
 * 上游那套成品预览页没随包带进来（它是英文页面），所以这里的页面是**照着 token 现画的**；
 * 与详情里那八段标本的区别在于「装」——导航、首屏、功能卡、数据带、行动横幅、页脚按真实
 * 网页的结构串起来，看到的是一套设计用起来的样子，而不是零件清单。
 *
 * 三件事决定了这个文件的形状：
 *
 * 1. **要挑角色，不能靠键名直取**。74 套的键名有一半是 kebab-case（`surface-card`、`hairline`，
 *    见 design-styles.ts 的词段表），另一半是 10 套散文格式品牌的人写英文（`Dark Surface`、
 *    `Near Black`）。所以每个颜色角色都是三层匹配：键名正则 → 数据里手写的中文标签正则 →
 *    画布色与文字色现调（`mixHex`）。前两层挑不出来时才用第三层，且第三层保证一定有值。
 * 2. **文案按分类走**。一套「示例页面」得说人话：数据库的页面讲扩缩容，电商的页面讲当日达。
 *    分类是数据里现成的字段，文案表按它取，取不到用通用那一套。
 * 3. **组件规格能挑到就用真的**（按钮的底色圆角内边距、输入框的描边都取它自己的），
 *    挑不到（Lamborghini / Runway / Tesla 上游没给组件规格）就按主色现画一枚，
 *    画法同样出自这套设计的颜色，不引外部资源、不出网。
 *
 * 这里只产出「该画成什么样」（颜色、字阶、尺寸、文案），DOM 结构在 StyleDemo.vue / StyleCard.vue。
 */
import {
  componentStyle,
  inkOn,
  isColorValue,
  lineHeightCss,
  mixHex,
  numericScale,
  relativeLuminance,
  safeCssValue,
  typographyScale,
  type ComponentStyle,
  type DesignStyle,
  type DesignTypeToken
} from './design-styles'

/** 示例页面用到的一组颜色角色；兜底之后每一项都必定有值 */
export interface DemoPalette {
  /** 页面底色 */
  canvas: string
  /** 卡片 / 面板底色 */
  surface: string
  /** 分隔线 */
  hairline: string
  /** 主文字 */
  ink: string
  /** 次文字 */
  muted: string
  /** 主色 */
  accent: string
  /** 主色之上的文字 */
  onAccent: string
}

/** 一枚按钮：文案 + 已展开的规格（底色、字色、圆角、内边距、字阶） */
export interface DemoButton {
  label: string
  style: ComponentStyle
}

/** 一套示例页面的文案 */
export interface DemoCopy {
  nav: string[]
  eyebrow: string
  title: string
  subtitle: string
  primary: string
  secondary: string
  cards: Array<{ title: string; text: string }>
  stats: Array<{ value: string; label: string }>
  cta: string
  ctaButton: string
  footer: string[]
}

/** 示例页面的尺寸：从这套设计的间距 / 圆角阶梯里挑出来并收敛过的像素值 */
export interface DemoMetrics {
  /** 段与段之间 */
  section: number
  /** 段内块与块之间 */
  block: number
  /** 元素之间 */
  gap: number
  cardRadius: string
  buttonRadius: string
}

export interface DesignDemo {
  palette: DemoPalette
  copy: DemoCopy
  /** 首屏字阶（这套设计里最大的一条） */
  hero: DesignTypeToken | undefined
  /** 正文、说明各自挑一条 */
  body: DesignTypeToken | undefined
  small: DesignTypeToken | undefined
  primary: DemoButton
  secondary: DemoButton
  /** 输入框样张的规格 */
  input: ComponentStyle
  metrics: DemoMetrics
}

// ---------------------------------------------------------------- 文案

const DEFAULT_COPY: DemoCopy = {
  nav: ['产品', '方案', '定价'],
  eyebrow: '全新版本',
  title: '为下一次发布做好准备',
  subtitle: '把日常的重复工作交给系统，把时间留给真正重要的事。',
  primary: '免费开始',
  secondary: '了解更多',
  cards: [
    { title: '清晰的结构', text: '每一块内容都有归属，找不到的东西几乎不存在。' },
    { title: '好用的默认值', text: '开箱即用，需要细调时每一项都留了出口。' },
    { title: '随你而变', text: '从小团队到大规模协作，同一套东西撑得住。' }
  ],
  stats: [
    { value: '12ms', label: '平均响应' },
    { value: '99.9%', label: '服务可用性' },
    { value: '40+', label: '集成' }
  ],
  cta: '现在就把第一件事交给它',
  ctaButton: '免费开始',
  footer: ['产品', '资源', '公司', '法律']
}

/**
 * 分类文案：只写与通用那套不同的字段，其余从 DEFAULT_COPY 兜。
 * 文案是「示例页面」的，不冒充品牌官方内容 —— 品牌名只出现在页面顶部的标志位上。
 */
const CATEGORY_COPY: Record<string, Partial<DemoCopy>> = {
  'AI 与大模型': {
    nav: ['能力', '模型', '文档'],
    eyebrow: '新一代智能体平台',
    title: '让模型替你把活干完',
    subtitle: '从对话到执行，一个界面编排你的全部工作流。',
    primary: '免费试用',
    secondary: '看演示',
    cards: [
      { title: '编排工作流', text: '把常用任务串成自动化流程，几步就能上线。' },
      { title: '接入你的数据', text: '私有知识库挂载之后，每个回答都有据可查。' },
      { title: '为团队扩展', text: '从个人实验到团队生产，配额弹性伸缩。' }
    ],
    stats: [
      { value: '10ms', label: '首字延迟' },
      { value: '120+', label: '可用模型' },
      { value: '99.9%', label: '服务可用性' }
    ],
    cta: '准备好让模型接过重复劳动了吗',
    ctaButton: '立即体验'
  },
  '后端 · 数据库 · 运维': {
    nav: ['产品', '文档', '社区'],
    eyebrow: '托管数据库',
    title: '为关键业务托底的数据库',
    subtitle: '自动扩缩、按量计费，把运维的夜班交给平台。',
    primary: '创建实例',
    secondary: '读文档',
    cards: [
      { title: '秒级扩缩容', text: '流量涨落随它去，容量跟着走，不用提前规划。' },
      { title: '自带高可用', text: '多副本同步写入，出问题自动切换，业务无感。' },
      { title: '看得见的状态', text: '慢查询、连接数、锁等待，一块面板看清楚。' }
    ],
    stats: [
      { value: '99.99%', label: '可用性' },
      { value: '5s', label: '故障切换' },
      { value: '32', label: '可用区' }
    ],
    cta: '五分钟起一个生产可用的实例',
    ctaButton: '创建实例'
  },
  '开发工具与 IDE': {
    nav: ['功能', '扩展', '下载'],
    eyebrow: '为开发者而生',
    title: '在你的编辑器里快人一步',
    subtitle: '补全、重构、审查，全部发生在你已经在用的地方。',
    primary: '下载安装',
    secondary: '查看更新',
    cards: [
      { title: '懂上下文', text: '整个仓库都是它的上下文，补全的不是字符串而是意图。' },
      { title: '批量重构', text: '一处改动跨几十个文件，改完直接给一份可审查的差异。' },
      { title: '接上你的流程', text: '构建、评审、发布都在同一个界面里闭环。' }
    ],
    stats: [
      { value: '200万', label: '开发者' },
      { value: '40+', label: '语言' },
      { value: '2min', label: '安装耗时' }
    ],
    cta: '今天就把编辑器升一级',
    ctaButton: '下载'
  },
  效率与协作: {
    nav: ['工作台', '集成', '定价'],
    eyebrow: '团队工作台',
    title: '把团队的对话变成进展',
    subtitle: '任务、文档、决策在同一处沉淀，消息不再是终点。',
    primary: '创建工作区',
    secondary: '看示例',
    cards: [
      { title: '一切可追踪', text: '每件事都有负责人和状态，翻旧账只需要一次搜索。' },
      { title: '少开一个会', text: '异步汇报自动汇总，站会可以只留十分钟。' },
      { title: '连上现有工具', text: '代码、日历、文档各留在原地，信息汇总到这里。' }
    ],
    stats: [
      { value: '30%', label: '会议时长下降' },
      { value: '120+', label: '集成' },
      { value: '8万', label: '团队在用' }
    ],
    cta: '把一个项目搬进来试试',
    ctaButton: '开始使用'
  },
  金融与加密: {
    nav: ['账户', '转账', '帮助'],
    eyebrow: '新一代账户',
    title: '看得清的每一笔资产',
    subtitle: '实时余额、即时转账、费用透明，没有藏在细则里的收费。',
    primary: '开立账户',
    secondary: '查看费率',
    cards: [
      { title: '实时到账', text: '转账秒级确认，状态每一步都看得见。' },
      { title: '费用透明', text: '汇率与手续费写在按钮旁边，确认前就知道总额。' },
      { title: '安全兜底', text: '异常交易自动拦截，可疑操作二次确认。' }
    ],
    stats: [
      { value: '0.1%', label: '手续费' },
      { value: '1.2s', label: '平均到账' },
      { value: '24/7', label: '人工支持' }
    ],
    cta: '开个账户，五分钟搞定',
    ctaButton: '立即开立'
  },
  汽车: {
    nav: ['车型', '配置', '预约'],
    eyebrow: '新一代车型',
    title: '为驾驭而生的每一处细节',
    subtitle: '从动力到底盘，每一个参数都为了一件事：开起来对。',
    primary: '预约试驾',
    secondary: '查看配置',
    cards: [
      { title: '动力响应', text: '踩下去就有，输出曲线经过反复调校。' },
      { title: '底盘调校', text: '长途不累，弯道不飘，两种性格在同一辆车里。' },
      { title: '按需定制', text: '颜色、内饰、轮毂，配置单随你组合。' }
    ],
    stats: [
      { value: '3.9s', label: '零百加速' },
      { value: '520km', label: '续航' },
      { value: '5年', label: '整车质保' }
    ],
    cta: '预约一次试驾，感受比参数更直接',
    ctaButton: '预约试驾'
  },
  媒体与消费科技: {
    nav: ['内容', '专题', '订阅'],
    eyebrow: '今日专题',
    title: '值得花时间的内容',
    subtitle: '深度报道、独家专访、每日精选，一次订阅全部送达。',
    primary: '立即订阅',
    secondary: '先看看',
    cards: [
      { title: '深度报道', text: '不只讲发生了什么，还讲清楚为什么。' },
      { title: '独家专访', text: '和当事人坐下来聊，问题问到底。' },
      { title: '每日精选', text: '每天三条，不超过十分钟。' }
    ],
    stats: [
      { value: '200万', label: '订阅者' },
      { value: '每日', label: '更新' },
      { value: '0', label: '广告干扰' }
    ],
    cta: '把这周的好内容收进邮箱',
    ctaButton: '订阅'
  },
  设计与创意工具: {
    nav: ['功能', '模板', '定价'],
    eyebrow: '创意工作台',
    title: '从灵感直达成稿',
    subtitle: '画布、组件、交付在同一条线上，设计不再来回倒手。',
    primary: '免费开始',
    secondary: '看作品',
    cards: [
      { title: '画布无限', text: '从草图画到高保真，不用换工具。' },
      { title: '组件复用', text: '改一处，所有引用同步更新。' },
      { title: '交付即代码', text: '标注、切图、变量一次导出，开发不用再问。' }
    ],
    stats: [
      { value: '500万', label: '创作者' },
      { value: '1.2亿', label: '模板' },
      { value: '实时', label: '多人协作' }
    ],
    cta: '打开画布，第一笔免费',
    ctaButton: '开始创作'
  },
  电商与零售: {
    nav: ['新品', '分类', '购物车'],
    eyebrow: '当季新品',
    title: '把好物送到家门口',
    subtitle: '严选供应链，七天无理由，下单后最快当日送达。',
    primary: '立即选购',
    secondary: '查看优惠',
    cards: [
      { title: '当日达', text: '中午前下单，晚上就能拆箱。' },
      { title: '七天无理由', text: '不合适就退，运费我们承担。' },
      { title: '正品保障', text: '每一件都可溯源，假一赔十。' }
    ],
    stats: [
      { value: '48h', label: '极速发货' },
      { value: '7天', label: '无理由退货' },
      { value: '98%', label: '好评率' }
    ],
    cta: '新客首单立减，先逛逛看',
    ctaButton: '去逛逛'
  },
  复古网页: {
    nav: ['首页', '档案', '留言板'],
    eyebrow: '自 1996 年',
    title: '欢迎来到互联网的黄金年代',
    subtitle: '没有推荐算法，只有一个个链接，和一个更慢的网页。',
    primary: '进入站点',
    secondary: '友情链接',
    cards: [
      { title: '访客计数器', text: '第 0001234 位访客，感谢你的到来。' },
      { title: '正在建设中', text: '这个区域还在施工，请戴好安全帽。' },
      { title: '留言板', text: '留下你的邮箱，我会尽快回复。' }
    ],
    stats: [
      { value: '56k', label: '调制解调器' },
      { value: '800×600', label: '最佳分辨率' },
      { value: '1996', label: '建站年份' }
    ],
    cta: '别忘了把本站加入收藏夹',
    ctaButton: '加入收藏'
  }
}

/** 这套设计该讲什么故事：分类命中就用它的，否则通用那套 */
export function demoCopy(style: DesignStyle): DemoCopy {
  const patch = CATEGORY_COPY[style.category]
  return patch ? { ...DEFAULT_COPY, ...patch } : { ...DEFAULT_COPY }
}

// ---------------------------------------------------------------- 颜色角色

interface RoleRule {
  /** 键名正则，按具体到宽泛的顺序 */
  keys: RegExp[]
  /** 数据里手写中文标签的正则（只有散文格式品牌才有标签） */
  labels: RegExp[]
}

const ROLE_RULES: Record<keyof Omit<DemoPalette, 'canvas' | 'accent'>, RoleRule> = {
  ink: {
    keys: [
      /^(ink|text|heading|title|foreground|fg|content)$/i,
      /^(ink|text|heading|title|fg)-(primary|default|base|main|strong|high)$/i,
      /^(ink|text|heading|title)(-|$)/i
    ],
    labels: [/^(标题|主文字|文字色|正文)$/, /^(标题|文字)/]
  },
  muted: {
    keys: [
      /^(text|ink|fg|content)-(secondary|tertiary|muted|subtle|soft)/i,
      /muted/i,
      /^(secondary|tertiary)(-text)?$/i,
      /^(body|paragraph|copy)(-|$)/i
    ],
    labels: [/弱化/, /次级|次要|正文|说明字/]
  },
  hairline: {
    keys: [/hairline/i, /divider/i, /(^|-)border(-|$)/i, /(^|-)rule(-|$)/i],
    labels: [/描边|边框/, /分隔线|分割线/]
  },
  surface: {
    keys: [
      /^(surface|card|panel|tile)-(card|elevated|default|primary|base)$/i,
      /^(surface|card|panel)(-|$)/i,
      /-card(-|$)/i,
      /elevated/i
    ],
    labels: [/^(卡片|表面|面板)/, /卡片$|表面$/]
  },
  onAccent: {
    keys: [/^on-(primary|accent|brand|action|cta)/i, /-on-(primary|accent|brand)/i, /^(inverse|inverted)(-|$)/i],
    labels: [/反色|反转/]
  }
}

/**
 * 挑一个颜色角色：键名 → 中文标签 → 交给调用方兜底。
 * 两层都按数据里的原顺序取第一个命中的（数据顺序就是上游按重要性排的）。
 */
function pickColor(style: DesignStyle, rule: RoleRule): string | undefined {
  const entries = Object.entries(style.colors).filter(([, value]) => isColorValue(value))
  for (const pattern of rule.keys) {
    const hit = entries.find(([key]) => pattern.test(key))
    if (hit) return hit[1]
  }
  const labels = style.labels?.colors
  if (labels) {
    for (const pattern of rule.labels) {
      const hit = entries.find(([key]) => pattern.test(labels[key] ?? ''))
      if (hit) return hit[1]
    }
  }
  return undefined
}

/** 按规则收集全部候选（键名优先，其次中文标签），去重且保持优先级顺序 */
function colorCandidates(style: DesignStyle, rule: RoleRule): string[] {
  const entries = Object.entries(style.colors).filter(([, value]) => isColorValue(value))
  const out: string[] = []
  for (const pattern of rule.keys) {
    for (const [key, value] of entries) if (pattern.test(key)) out.push(value)
  }
  const labels = style.labels?.colors
  if (labels) {
    for (const pattern of rule.labels) {
      for (const [key, value] of entries) if (pattern.test(labels[key] ?? '')) out.push(value)
    }
  }
  return [...new Set(out)]
}

/**
 * 挑一个「读得出来」的颜色：候选按优先级排，取第一个与参考色拉开足够明暗差的。
 *
 * 这一关是必要的，不是保险 —— 深色设计里的 `ink` 键有时指的是深色表面（Binance 的
 * `#181a20`、PlayStation 的 `#000000`），直接拿它当文字色，会在近黑画布上糊成一片；
 * 候选全不达标时按参考色现算（`inkOn` / 混色），保证一定有可读的值。
 */
function pickReadable(
  style: DesignStyle,
  rule: RoleRule,
  reference: string,
  minDiff: number,
  fallback: string
): string {
  const referenceLuminance = relativeLuminance(reference)
  for (const value of colorCandidates(style, rule)) {
    if (Math.abs(relativeLuminance(value) - referenceLuminance) >= minDiff) return value
  }
  return fallback
}

/** 页面底色直接用数据里那个字段；画布色认不出时退回主色 */
function canvasOf(style: DesignStyle): string {
  return isColorValue(style.canvas) ? style.canvas : style.accent
}

/**
 * 把一套设计的颜色收敛成示例页面用的七个角色。
 * 顺序有讲究：`ink` 先定，缺的分隔线 / 卡片底 / 次文字都从「画布 ↔ 文字」之间现调，
 * 调出来的深浅天然跟着这套设计的明暗走。
 */
export function demoPalette(style: DesignStyle): DemoPalette {
  const canvas = canvasOf(style)
  const accent = isColorValue(style.accent) ? style.accent : canvas
  const ink = pickReadable(style, ROLE_RULES.ink, canvas, 0.2, inkOn(canvas))
  const dark = style.theme === 'dark'
  // 次文字本来就比主文字淡，能认出来的门槛放低一档
  const muted = pickReadable(style, ROLE_RULES.muted, canvas, 0.06, mixHex(ink, canvas, 0.45))
  const hairline = pickColor(style, ROLE_RULES.hairline) ?? mixHex(ink, canvas, 0.85)
  const surface = pickColor(style, ROLE_RULES.surface) ?? mixHex(canvas, ink, dark ? 0.1 : 0.05)
  const onAccent = pickReadable(style, ROLE_RULES.onAccent, accent, 0.2, inkOn(accent))
  return { canvas, surface, hairline, ink, muted, accent, onAccent }
}

// ---------------------------------------------------------------- 字阶与组件

/** 字号认不出来的那条按 -1 排到后面 */
function fontSizeOf(token: DesignTypeToken | undefined): number {
  const matched = /([\d.]+)/.exec(token?.fontSize ?? '')
  return matched ? Number(matched[1]) : -1
}

/**
 * 首屏 / 正文 / 说明各挑一条字阶。
 * 首屏是这套设计里最大的一条；正文优先键名里有 `body` 的，否则取第一条降到正文尺度的；
 * 说明取 `caption` / `label` / 按钮那一类小字阶。
 */
function demoTypes(style: DesignStyle): {
  hero: DesignTypeToken | undefined
  body: DesignTypeToken | undefined
  small: DesignTypeToken | undefined
} {
  const scale = typographyScale(style)
  if (!scale.length) return { hero: undefined, body: undefined, small: undefined }
  const hero = scale[0][1]
  const body =
    scale.find(([key]) => /(^|-)body(-|$)/i.test(key))?.[1] ??
    scale.find(([, token]) => {
      const size = fontSizeOf(token)
      return size > 0 && size <= 18
    })?.[1] ??
    hero
  const small =
    scale.find(([key]) => /caption|label|micro|eyebrow|overline|tag|badge|nav|link|button/i.test(key))?.[1] ??
    body
  return { hero, body, small }
}

const BUTTON_PRIMARY: RegExp[] = [
  /^button-primary/i,
  /primary-button/i,
  /button[-_ ]?cta/i,
  /^(cta|primary)(-|$)/i,
  /filled|solid/i,
  /^primary/i
]

const BUTTON_SECONDARY: RegExp[] = [
  /^button-secondary/i,
  /button-(secondary|ghost|outline|tertiary)/i,
  /secondary-button/i,
  /ghost|outlined?|outline/i,
  /^secondary/i
]

const INPUT_PATTERNS: RegExp[] = [/^text-input/i, /input/i, /search/i]

/**
 * 展开一条组件规格；展开后既没底色也没描边的（引用的颜色键在这套设计里不存在）算没挑到 ——
 * 只剩一条字阶的样张等于看不见，不如按主色现画一枚。
 */
function resolveVisible(style: DesignStyle, key: string | undefined): ComponentStyle | null {
  if (!key) return null
  const token = style.components[key]
  if (!token) return null
  const resolved = componentStyle(token, style)
  return resolved.background || resolved.border ? resolved : null
}

/** 组件键名 → 中文标签，标签命中用它兜（散文格式品牌的键名正则认不出来） */
function pickComponent(
  style: DesignStyle,
  patterns: RegExp[],
  labels: RegExp[]
): string | undefined {
  const keys = Object.keys(style.components)
  for (const pattern of patterns) {
    const hit = keys.find((key) => pattern.test(key))
    if (hit) return hit
  }
  const table = style.labels?.components
  if (table) {
    for (const pattern of labels) {
      const hit = keys.find((key) => pattern.test(table[key] ?? ''))
      if (hit) return hit
    }
  }
  return undefined
}

/** 内边距收到 32px 以内：上游有 `96px` 这种首屏级内边距，照搬会把样张撑爆 */
export function clampPadding(raw: string | undefined): string | undefined {
  const value = safeCssValue(raw)
  if (!value) return undefined
  return value.replace(/([\d.]+)px/g, (_, number: string) =>
    `${Math.min(32, Math.round(Number(number)))}px`
  )
}

/** 字号收到上限以内（卡片档与详情档给的上限不同，所以上限由调用方给）；非 px 单位原样留着 */
export function clampFontSize(raw: string | undefined, max: number): string | undefined {
  const value = safeCssValue(raw)
  if (!value) return undefined
  const matched = /^([\d.]+)px$/.exec(value)
  if (!matched) return value
  const size = Number(matched[1])
  return size > max ? `${max}px` : `${Math.round(size)}px`
}

// ---------------------------------------------------------------- 尺寸

/** 从间距阶梯里按相对位置取一档，再收到区间内 —— 阶梯长短不一，按比例取才通用 */
function scaleStep(block: Record<string, string>, ratio: number, min: number, max: number, fallback: number): number {
  const steps = numericScale(block).filter(([, , value]) => value > 0)
  if (!steps.length) return fallback
  const index = Math.min(steps.length - 1, Math.floor((steps.length - 1) * ratio))
  return Math.min(max, Math.max(min, Math.round(steps[index][2])))
}

/** 圆角阶梯里挑一档并收敛；挑不到给一个中性值 */
function radiusStep(block: Record<string, string>, patterns: RegExp[], min: number, max: number, fallback: string): string {
  const keys = Object.keys(block)
  for (const pattern of patterns) {
    const hit = keys.find((key) => pattern.test(key))
    if (hit) {
      const value = Number(/([\d.]+)/.exec(block[hit])?.[1] ?? NaN)
      if (Number.isFinite(value)) return `${Math.min(max, Math.max(min, Math.round(value)))}px`
    }
  }
  return fallback
}

function demoMetrics(style: DesignStyle): DemoMetrics {
  return {
    section: scaleStep(style.spacing, 0.7, 32, 56, 40),
    block: scaleStep(style.spacing, 0.45, 12, 24, 16),
    gap: scaleStep(style.spacing, 0.3, 8, 16, 12),
    cardRadius: radiusStep(style.rounded, [/^(lg|xl|md)$/i, /card/i, /radius/i], 8, 20, '12px'),
    buttonRadius: radiusStep(style.rounded, [/^(sm|md|xs)$/i, /button/i], 6, 14, '10px')
  }
}

// ---------------------------------------------------------------- 组装

/** 挑不到组件规格时现画一枚主按钮：底色主色、字色按对比度定 */
function fallbackPrimary(copy: DemoCopy, palette: DemoPalette, metrics: DemoMetrics, font: DesignTypeToken | undefined): DemoButton {
  return {
    label: copy.primary,
    style: {
      background: palette.accent,
      color: palette.onAccent,
      borderRadius: metrics.buttonRadius,
      padding: '10px 22px',
      font
    }
  }
}

/** 次按钮：描边、透底 */
function fallbackSecondary(copy: DemoCopy, palette: DemoPalette, metrics: DemoMetrics, font: DesignTypeToken | undefined): DemoButton {
  return {
    label: copy.secondary,
    style: {
      color: palette.ink,
      border: `1px solid ${palette.hairline}`,
      borderRadius: metrics.buttonRadius,
      padding: '10px 22px',
      font
    }
  }
}

/** 组件规格里的字阶引用可能是空的，按钮文字小了也不好看 —— 缺了用正文那条补 */
function buttonFont(resolved: ComponentStyle, fallback: DesignTypeToken | undefined): DesignTypeToken | undefined {
  return resolved.font ?? fallback
}

/** 把一套设计组装成示例页面要的全部素材 */
export function buildDesignDemo(style: DesignStyle): DesignDemo {
  const palette = demoPalette(style)
  const copy = demoCopy(style)
  const { hero, body, small } = demoTypes(style)
  const metrics = demoMetrics(style)

  const primaryKey = pickComponent(style, BUTTON_PRIMARY, [/主按钮|主要|^主/])
  const secondaryKey = pickComponent(style, BUTTON_SECONDARY, [/次按钮|次要|幽灵|描边/])
  const inputKey = pickComponent(style, INPUT_PATTERNS, [/输入框/])

  const primaryResolved = resolveVisible(style, primaryKey)
  const secondaryResolved = resolveVisible(style, secondaryKey)
  const inputResolved = resolveVisible(style, inputKey)

  const primary: DemoButton = primaryResolved
    ? {
        label: copy.primary,
        style: { ...primaryResolved, padding: clampPadding(primaryResolved.padding), font: buttonFont(primaryResolved, small) }
      }
    : fallbackPrimary(copy, palette, metrics, small)

  const secondary: DemoButton = secondaryResolved
    ? {
        label: copy.secondary,
        style: { ...secondaryResolved, padding: clampPadding(secondaryResolved.padding), font: buttonFont(secondaryResolved, small) }
      }
    : fallbackSecondary(copy, palette, metrics, small)

  const input: ComponentStyle = inputResolved
    ? { ...inputResolved, padding: clampPadding(inputResolved.padding), font: buttonFont(inputResolved, body) }
    : {
        background: palette.surface,
        color: palette.muted,
        border: `1px solid ${palette.hairline}`,
        borderRadius: metrics.buttonRadius,
        padding: '10px 14px',
        font: body
      }

  return { palette, copy, hero, body, small, primary, secondary, input, metrics }
}

// ---------------------------------------------------------------- 内联样式

/**
 * 字阶 → 可绑到 `:style` 的样式对象。`maxSize` 是这一档允许的最大字号 ——
 * 卡片与详情宽度差着好几倍，上限由调用方按档位给（收敛规则见 `clampFontSize`）。
 */
export function typeCss(token: DesignTypeToken | undefined, maxSize: number): Record<string, string> {
  if (!token) return {}
  const out: Record<string, string> = {}
  const family = safeCssValue(token.fontFamily)
  const size = clampFontSize(token.fontSize, maxSize)
  const weight = safeCssValue(token.fontWeight)
  const lineHeight = lineHeightCss(token.lineHeight, token.fontSize)
  const spacing = safeCssValue(token.letterSpacing)
  if (family) out.fontFamily = family
  if (size) out.fontSize = size
  if (weight) out.fontWeight = weight
  if (lineHeight) out.lineHeight = lineHeight
  if (spacing) out.letterSpacing = spacing
  return out
}

/**
 * 按钮规格 → 可绑的内联样式：底色、字色、描边、阴影都取它自己的，
 * 高度与字号按档位收敛（真实网页的 48px 按钮摆不进卡片）。
 * 规格里没给圆角时用这套设计的按钮圆角兜底。
 */
export function buttonCss(
  button: DemoButton,
  fallbackRadius: string,
  fontMax: number,
  heightMax: number
): Record<string, string> {
  const spec = button.style
  const out: Record<string, string> = {}
  if (spec.background) out.background = spec.background
  if (spec.color) out.color = spec.color
  if (spec.border) out.border = spec.border
  if (spec.boxShadow) out.boxShadow = spec.boxShadow
  if (spec.padding) out.padding = spec.padding
  out.borderRadius = spec.borderRadius ?? fallbackRadius
  const height = spec.height ? /^([\d.]+)px$/.exec(spec.height) : null
  out.height = `${height ? Math.min(heightMax, Number(height[1])) : heightMax}px`
  Object.assign(out, typeCss(spec.font, fontMax))
  return out
}

/** 列表里那半张页面用的缩字号：卡片档的标题、副文案、按钮各一档 */
export const CARD_TYPE = { brand: 12, title: 19, text: 12, button: 11, buttonHeight: 26 } as const
