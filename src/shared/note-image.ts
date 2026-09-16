/**
 * 笔记里的图片：文件名怎么起、放进仓库哪个目录、**上传成功后插进正文的那个地址怎么拼**。
 *
 * 上传本身（克隆 / 写文件 / 提交 / 推送）在 Rust 侧（`src-tauri/src/sync.rs` 的 `publish_image`），
 * 它只回「图片在仓库里的相对路径 + 推到了哪个分支」；访问地址由这一份拼出来 ——
 * 「GitHub 拼 `raw.githubusercontent.com`、Gitee 拼 `/raw/`」这类口径全是纯计算，
 * 放这里才有单测护着，改起来也不必重编 Rust（与其余模块同一条分工）。
 *
 * 一次上传的产物就是一条 markdown：`![图片](https://…/images/20260916-104512-ab12cd34.png)`。
 * 地址是**外链**：图片存在用户自己的仓库里，笔记文件里只有一个链接，
 * 于是笔记本搬到别的机器上、用别的编辑器打开，图照样在。
 *
 * 图片进仓库的落点是**三层**：`<图片目录>/<设备>/<笔记本>/<文件名>`。
 * 后两层是「素材管理只看自己这一份」的前提：图片仓库是全机器共用的一份，
 * 而「这张图有没有人用」只有**某一个笔记本**说得清（见 buildImageAssets）——
 * 不分层的话面板里那列「未引用」混着别的笔记本与别的机器传上来的图，
 * 看着能删、删了却会裂图。两层的算法都在这里（`imageScopeDir`），有单测护着。
 */

/** 图片在仓库里的默认子目录 */
export const NOTE_IMAGE_DEFAULT_DIR = 'images'

/** 单张图片的大小上限。剪切板里的截图通常几百 KB，这里拦的是误贴的大文件 */
export const NOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** 仓库地址上限，和 Token 同步仓库同一个口径 */
const REPO_MAX_LENGTH = 300

/** 认得出的图片后缀；认不出来的按 png（剪切板里的图基本都是 png） */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/tiff': 'tiff'
}

/** 一次上传要带的东西：图片本身（base64）与它该去哪儿 */
export interface NoteImageUploadInput {
  /** 图片仓库地址（设置里的那个） */
  repo: string
  /** 图片在仓库里的基础目录（设置里的那个），设备与笔记本两层由它往下拼 */
  dir: string
  /**
   * 当前笔记本（笔记文件夹的绝对路径）：图片落进仓库的哪一层由它算出来。
   *
   * 落点是 `<dir>/<设备>/<笔记本>/<文件名>`（见 imageScopeDir）—— 素材管理只列这同一个目录，
   * 所以「哪台机器、哪个笔记本」必须由调用方如实带进来，适配层不缓存它。
   */
  root: string
  /** 访问地址前缀（可选覆盖，见 sanitizeImageBaseUrl） */
  baseUrl?: string
  /** 文件名（含后缀），由调用方用 `imageFileName` 算好 */
  name: string
  /** 整张图的 base64 */
  data: string
  /** 是否用已登录账号的 token 授权（私有仓库用；关掉就走系统 git 凭据） */
  useAccount?: boolean
}

/** 上传的结果：图片进了仓库的哪里，以及怎么访问它 */
export interface NoteImageUploaded {
  /** 仓库里的相对路径 */
  path: string
  /** 推上去的分支（拼地址要用它） */
  branch: string
  /** 可直接放进正文的访问地址；推不出来时是空串 */
  url: string
}

/** 收敛仓库地址。与 Token 同步仓库同一条口径：空、含空白、以 `-` 开头的都当没填 ——
 * 后面那个值会被当成 git 的选项，填错了就是一条看不懂的报错。
 */
export function sanitizeImageRepo(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (!value || value.length > REPO_MAX_LENGTH) return ''
  if (/\s/.test(value) || value.startsWith('-')) return ''
  return value
}

/**
 * 收敛仓库里的子目录：去掉首尾与重复的斜杠，丢掉 `.` 与 `..` 段。
 * 空串表示直接放在仓库根目录。
 */
export function sanitizeImageDir(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

/**
 * 收敛「访问地址前缀」（可选）：末尾的斜杠去掉，中间有空白就当没填。
 *
 * 这一项是给推不出地址的仓库准备的（自建 GitLab / Gitea、对象存储镜像、
 * 或者仓库本身的 GitHub Pages）—— 自动推导只认三家公开托管。
 */
export function sanitizeImageBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().replace(/\/+$/, '')
  if (!value || value.length > REPO_MAX_LENGTH || /\s/.test(value)) return ''
  return value
}

/** 图片后缀（不带点）：按 mime 认，认不出来按 png */
export function imageExtension(mime: string): string {
  return MIME_EXTENSIONS[mime.trim().toLowerCase()] ?? 'png'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 文件名：`20260916-104512-ab12cd34.png`。
 *
 * 时间戳在前是为了在仓库的文件列表里**按名字排就是按时间排**，
 * 随机段在后是防撞名（同一秒里贴两张图）+ 防「同一张图反复贴时互相覆盖」。
 * `token` 由调用方给（测试里钉死），不传就现取一个随机串。
 */
export function imageFileName(input: {
  mime: string
  now?: number
  token?: string
}): string {
  const date = new Date(input.now ?? Date.now())
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`

  const token = (input.token ?? fallbackToken())
    .toLowerCase()
    .replace(/[^0-9a-z]/g, '')
    .slice(0, 8)
  return `${stamp}-${token || '0'}.${imageExtension(input.mime)}`
}

/** 随机段：随机就够用，不需要密码学强度 —— 它的作用是避开同一秒里的第二次粘贴 */
function fallbackToken(): string {
  return Math.random().toString(16).slice(2, 10)
}

/** 仓库里的相对路径：子目录 + 文件名（子目录为空就是文件名本身） */
export function imageRepoPath(dir: string, name: string): string {
  const clean = sanitizeImageDir(dir)
  return clean ? `${clean}/${name}` : name
}

/**
 * 笔记本那一段名字的长度上限。按字符算：中文目录名比 ASCII 长得多，
 * 而这一段只是给人看的，认不认得出是哪个笔记本靠的是后面的路径摘要。
 */
const NOTEBOOK_KEY_NAME_MAX = 32

/** 设备那一段的长度上限：设备 id 就是个 uuid（36 位），留点余量给别处生成的标识 */
const DEVICE_KEY_MAX = 64

/** 路径摘要的位数。要撞上得「目录名相同 + 摘要相同」同时成立，够用了 */
const PATH_HASH_LENGTH = 8

/**
 * 收敛成一段普通目录名：去掉路径分隔符与 Windows 的保留字符，压掉首尾的点与空白。
 *
 * 与 `sanitizeImageDir` 的区别是**只处理一段**：那个收的是用户手写的多级目录（认 `/`），
 * 而这里要收的是拼进路径的一段 —— 多一个分隔符就等于多出一层目录。
 */
function plainSegment(raw: string): string {
  return raw
    // 保留字符与控制字符都去掉：留着它们 git 在 Windows 上会直接报错
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
}

/**
 * 32 位 FNV-1a，取 8 位十六进制。
 *
 * 只是给路径摘要用（同名的两个笔记本别落进同一个目录），不需要密码学强度 ——
 * 这里也就不引 crypto：shared 里不许 import node 的东西，而这个函数在渲染层直接跑。
 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(PATH_HASH_LENGTH, '0')
}

/**
 * 设备那一段：本机的设备标识（`%APPDATA%/Workbench/device.json`，与 Token 分片同一个 id），
 * 收敛成一段目录名。
 *
 * 空串表示拿不到标识：那时**不要**退回上一层去上传 / 列图 / 删图 ——
 * 退回等于让所有机器的图混进同一个目录，素材管理立刻就说不清「谁在用」了。
 */
export function imageDeviceKey(deviceId: string): string {
  return typeof deviceId === 'string'
    ? plainSegment(deviceId).toLowerCase().slice(0, DEVICE_KEY_MAX)
    : ''
}

/**
 * 笔记本那一段：`<目录名>-<路径摘要>`，例如 `笔记-3f2a91c4`。
 *
 * 摘要取的是**整个路径**，不是目录名：`D:\a\笔记` 与 `E:\b\笔记` 是两个笔记本，
 * 只按名字分就会把它们的图混进一个目录，引用次数跟着串。
 * 摘要前把路径统一成小写 + `/` 分隔 —— Windows 上 `E:\Notes` 与 `e:/notes` 是同一个目录，
 * 不收敛的话同一个笔记本会按两种写法各建一份。
 *
 * 代价说清楚：同一个笔记本从**另一个路径**打开（映射的盘符、网络路径、junction）
 * 会算成另一个目录，那些图在这边就列不出来（正文里的外链照样能用）。
 */
export function imageNotebookKey(root: string): string {
  const clean =
    typeof root === 'string' ? root.trim().replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (!clean) return ''

  const parts = clean.split('/').filter(Boolean)
  const name = plainSegment(parts[parts.length - 1] ?? '')
    .toLowerCase()
    .slice(0, NOTEBOOK_KEY_NAME_MAX)
  return `${name || 'notebook'}-${shortHash(clean.toLowerCase())}`
}

/**
 * 这台机器上这个笔记本的素材目录：`<图片目录>/<设备>/<笔记本>`（图片目录留空就是两层）。
 *
 * 上传、列清单、删图三条通道**都用它**算落点，于是素材管理看到的正好是「这个笔记本自己的图」，
 * 面板里那列「未引用」才真的可以照它删。
 *
 * 返回空串表示缺设备标识或没打开笔记本：调用方要如实报错，不要退回上一层目录。
 */
export function imageScopeDir(dir: string, deviceId: string, root: string): string {
  const device = imageDeviceKey(deviceId)
  const notebook = imageNotebookKey(root)
  if (!device || !notebook) return ''
  return [sanitizeImageDir(dir), device, notebook].filter(Boolean).join('/')
}

/** 仓库地址拆出来的三样东西 */
export interface ImageRemote {
  host: string
  owner: string
  name: string
}

/**
 * 拆仓库地址。两种写法都要认：`https://host/owner/repo.git` 与 `git@host:owner/repo.git`
 * （后者没有 scheme，URL 解析器认不出来，得单独按 scp 那种写法切）。
 * 拆不出来返回 null —— 那时地址推不出来，界面会提示用户自己填前缀。
 */
export function parseImageRemote(repo: string): ImageRemote | null {
  const clean = repo.trim().replace(/\/+$/, '')
  if (!clean) return null

  let host = ''
  let path = ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(clean)
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(clean)

  if (!hasScheme && scp) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const url = new URL(clean)
      host = url.hostname
      path = url.pathname
    } catch {
      return null
    }
  }

  path = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const parts = path.split('/').filter(Boolean)
  // 至少要有 `owner/repo` 两段：只有一段的话推不出托管方给的 raw 地址
  if (!host || parts.length < 2) return null

  return {
    host: host.toLowerCase(),
    owner: parts.slice(0, -1).join('/'),
    name: parts[parts.length - 1]
  }
}

/**
 * 图片的访问地址（markdown 里用的那个）。
 *
 * 顺序是：**用户填的前缀优先**，其次按仓库地址推导（只认 GitHub / Gitee / GitLab 三家公开托管，
 * 它们的 raw 地址规则各不相同且都是长期稳定的），都拿不到就返回空串 ——
 * 那时调用方要给一句「请在设置里填访问地址前缀」，而不是插一个点不开的地址进正文。
 *
 * 每一段都做百分号编码：目录名可能是中文，而 markdown 的链接里出现空格就直接断了。
 */
export function imageRawUrl(input: {
  repo: string
  branch: string
  path: string
  baseUrl?: string
}): string {
  const path = input.path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
  if (!path) return ''

  const override = sanitizeImageBaseUrl(input.baseUrl ?? '')
  if (override) return `${override}/${path}`

  const remote = parseImageRemote(input.repo)
  if (!remote) return ''

  const branch = input.branch.trim().replace(/^\/+|\/+$/g, '')
  if (!branch) return ''

  const { owner, name } = remote
  switch (remote.host) {
    case 'github.com':
      return `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(branch)}/${path}`
    case 'gitee.com':
      return `https://gitee.com/${owner}/${name}/raw/${encodeURIComponent(branch)}/${path}`
    case 'gitlab.com':
      return `https://gitlab.com/${owner}/${name}/-/raw/${encodeURIComponent(branch)}/${path}`
    default:
      return ''
  }
}

/** 插进正文的那一段。alt 只在图片没加载出来时显示，给一句人话即可 */
export function imageMarkdown(url: string, alt = '图片'): string {
  return `![${alt}](${url})`
}

// ---------- 素材管理：仓库里有哪些图、谁还在用 ----------

/** 图片仓库里的一张图（Rust 扫出来的原始信息） */
export interface NoteImage {
  /** 仓库内相对路径（含子目录），与上传回来的是同一种写法 */
  path: string
  /** 文件名（含后缀） */
  name: string
  /** 字节数 */
  size: number
}

/**
 * 一张图 + 「被引用了几次」+ 可直接打开的地址。
 *
 * `url` 是照仓库地址拼出来的（推不出来时是空串，界面据此不显示缩略图）。
 */
export interface NoteImageAsset extends NoteImage {
  refs: number
  url: string
}

/**
 * 列出图片仓库的入参：配置由调用方从设置里带过来（适配层不缓存设置），
 * 当前笔记本由调用方逐次带进来 —— **列的是「这台机器上这个笔记本」那一层**（见 imageScopeDir）。
 */
export interface NoteImageListInput {
  repo: string
  dir: string
  /** 当前笔记本（空串 = 还没打开笔记本，调用方要挡住，不要退回上一层） */
  root: string
  useAccount?: boolean
}

/** 列表的结果：分支（拼访问地址要用）+ 图片清单 */
export interface NoteImageList {
  branch: string
  files: NoteImage[]
}

/** 批量删除的入参 */
export interface NoteImageDeleteInput extends NoteImageListInput {
  /** 仓库内相对路径（列表回来的那些）；越界、非法路径、不在这台机器这个笔记本那一层的一律被 Rust 挡住 */
  paths: string[]
}

/** 删除的结果 */
export interface NoteImageDeleted {
  /** 真的删掉了几张（已经不在的会被跳过） */
  deleted: number
  /** 有没有产生提交（一张都没删到时是 false） */
  changed: boolean
  branch: string
  /** git 自己的输出，删失败时界面拿它说明原因 */
  log: string
}

/** 扫出来的笔记正文（引用计数用） */
export interface NoteTextScan {
  files: { rel: string; text: string }[]
  /** 读不出来的篇数：大于 0 时界面要如实说一句（少读一篇就可能误判「没人引用」） */
  failed: number
}

/**
 * 一张图在正文里被引用了多少次。
 *
 * 按**文件名**数，不按完整地址：同一个文件在正文里可能是 raw 地址、带访问前缀的地址、
 * 相对路径，甚至带 `?raw=true` 这类查询串 —— 它们共有的、唯一确定指向这张图的只有文件名。
 * 名字是「时间戳 + 随机段」（见 `imageFileName`），撞名可以忽略。
 *
 * 数的是**出现次数**而不是「有几篇提到」：同一篇里引了三次就是三次。
 * 大小写不敏感（别处编辑器可能把名字写成大写），且按不重叠计。
 * 传进来的文本已经转成小写（`buildImageAssets` 先把整批转一次，免得每张图各转一遍几兆）。
 */
function countInLowered(loweredTexts: readonly string[], name: string): number {
  const needle = name.trim().toLowerCase()
  if (!needle) return 0

  let total = 0
  for (const text of loweredTexts) {
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      total += 1
      from = at + needle.length
    }
  }
  return total
}

/** 上面的单张版本（给测试与别处复用；每次调用会把整批文本各转一遍小写） */
export function countImageReferences(texts: readonly string[], name: string): number {
  return countInLowered(
    texts.map((text) => text.toLowerCase()),
    name
  )
}

/**
 * 列表 + 笔记正文 → 素材清单（每张图带上被引用次数与访问地址）。
 *
 * 这是整个素材管理的核心判断：**引用次数是 0 才会被推荐删除**，所以口径必须只有一处。
 * `images` 只该是**这台机器上这个笔记本那一层**的图（见 imageScopeDir），`texts` 是同一个笔记本的正文：
 * 两边限定在同一个笔记本里，「0 次」才真的等于「没人用」。
 */
export function buildImageAssets(input: {
  images: readonly NoteImage[]
  /** 笔记本里所有笔记的正文 */
  texts: readonly string[]
  repo: string
  branch: string
  baseUrl?: string
}): NoteImageAsset[] {
  const lowered = input.texts.map((text) => text.toLowerCase())

  return input.images.map((image) => ({
    path: image.path,
    name: image.name,
    size: Math.max(0, Math.round(image.size)),
    refs: countInLowered(lowered, image.name),
    url: imageRawUrl({
      repo: input.repo,
      branch: input.branch,
      path: image.path,
      baseUrl: input.baseUrl
    })
  }))
}

/**
 * 排序：**没人引用的排在最前面**（要删的就是它们），其余按文件名倒序（新的在前 ——
 * 名字以时间戳开头，倒序就是「最近贴的」在前）。
 */
export function sortImageAssets(assets: readonly NoteImageAsset[]): NoteImageAsset[] {
  return [...assets].sort((left, right) => {
    const leftUnused = left.refs === 0
    const rightUnused = right.refs === 0
    if (leftUnused !== rightUnused) return leftUnused ? -1 : 1
    return right.name.localeCompare(left.name)
  })
}

/** 没人引用的那些（批量删除的对象） */
export function unusedImages(assets: readonly NoteImageAsset[]): NoteImageAsset[] {
  return assets.filter((asset) => asset.refs === 0)
}

/** 一批图片一共多少字节（确认框里说「要删掉多少」用它） */
export function totalImageBytes(assets: readonly NoteImageAsset[]): number {
  return assets.reduce((sum, asset) => sum + Math.max(0, asset.size), 0)
}
