/**
 * 快捷启动：把常用的软件挂在首页，点一下就拉起来。
 *
 * 与项目命令是两条完全不同的路：这里不接管进程 —— 不记日志、不提供停止，
 * Workbench 退出时也不会连带结束它们。用户要的只是「少一次找图标」。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell, type BrowserWindow } from 'electron'
import { defaultQuickAppName } from '../shared/quick-launch'
import { reorderById } from '../shared/reorder'
import { fail, ok } from '../shared/result'
import {
  IPC,
  type QuickApp,
  type QuickAppInput,
  type QuickAppList,
  type QuickAppPatch,
  type Result
} from '../shared/types'
import { broadcast } from './broadcast'
import { statOrNull } from './fs-util'
import { showOpenDialogSafe } from './system'
import { data, save } from './store'

/** 文件对话框里的类型筛选项：程序本体、快捷方式、批处理，最后兜一个「所有文件」 */
const TARGET_FILTERS: Electron.FileFilter[] = [
  { name: '程序与快捷方式', extensions: ['exe', 'com', 'bat', 'cmd', 'lnk'] },
  { name: '所有文件', extensions: ['*'] }
]

function blankToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

// ---------- 列表 ----------

/**
 * 列表 + 失效标记。
 *
 * 失效是「现在这个瞬间磁盘上有没有」，不落盘：程序被重新装回来时应当自己恢复，
 * 不该因为上次没找到就永久标红。
 */
export async function quickAppList(): Promise<QuickAppList> {
  const apps = data().quickApps
  const missing: Record<string, boolean> = {}

  await Promise.all(
    apps.map(async (entry) => {
      missing[entry.id] = (await statOrNull(entry.target)) === null
    })
  )

  return { apps, missing }
}

// ---------- 选择程序 ----------

/**
 * 对话框的起始目录：开始菜单里的「程序」。
 * 常用软件的快捷方式基本都在那儿（安装时自动放的），比让人从「此电脑」一层层翻快得多。
 */
function startMenuDir(): string | undefined {
  if (process.platform !== 'win32') return undefined

  const roots = [process.env.ProgramData, process.env.APPDATA].filter(
    (root): root is string => !!root
  )
  const candidates = roots.map((root) =>
    join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  )
  return candidates.find((dir) => existsSync(dir))
}

export async function pickApplication(parent?: BrowserWindow): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择要启动的程序',
    properties: ['openFile'],
    filters: TARGET_FILTERS,
    defaultPath: startMenuDir()
  }

  return showOpenDialogSafe(parent, options)
}

// ---------- 启动 ----------

/**
 * 交给系统打开。
 *
 * shell.openPath 走的是 ShellExecute，各类型都按各自最自然的方式起来：
 * .lnk 解析到它自己的目标（连同快捷方式里自带的参数与工作目录）、.exe 直接运行、
 * .bat / .cmd 自己开一个控制台、文档按系统关联打开。进程不归我们管，应用退出也不影响它。
 */
async function startProgram(entry: QuickApp): Promise<void> {
  const target = entry.target.trim()
  if (!target) throw new Error('这个启动项还没有选择程序')
  if (!(await statOrNull(target))) throw new Error(`程序不存在或已被移动：${target}`)

  // 失败时 ShellExecute 返回的是系统给的说明文字，成功是空串
  const message = await shell.openPath(target)
  if (message) throw new Error(message)
}

/** 启动一个快捷启动项：失败抛出可读原因，成功后更新最近使用时间并把列表推回界面 */
export async function launchQuickApp(id: string): Promise<void> {
  const entry = data().quickApps.find((item) => item.id === id)
  if (!entry) throw new Error('该快捷启动项已不存在')

  await startProgram(entry)

  entry.lastUsedAt = Date.now()
  save()
  broadcast(IPC.eventQuickApps, await quickAppList())
}

// ---------- 图标 ----------

/** 取过的图标按「来源 + 修改时间 + 大小」缓存：程序升级换了图标会自动失效 */
const iconCache = new Map<string, string>()
const ICON_CACHE_LIMIT = 64

/**
 * 取图标时该看哪个文件。
 *
 * 直接对 .lnk 取图标只能拿到「快捷方式」那个通用图标（一张白底小箭头），
 * 所以先把它解开：快捷方式自己指定了图标文件就用它，否则用目标程序的文件。
 * 两者都落空（快捷方式损坏、目标被卸载）时退回快捷方式本身，能取到什么算什么。
 */
function iconSourceOf(target: string): string {
  if (!/\.lnk$/i.test(target)) return target

  try {
    const link = shell.readShortcutLink(target)
    for (const candidate of [link.icon, link.target]) {
      const path = candidate?.trim()
      if (path && existsSync(path)) return path
    }
  } catch {
    /* 不是标准的 .lnk（或被删了）：按原路径取 */
  }

  return target
}

/** 同一个文件不重复尝试「从资源里抽图标」：抽过一次（哪怕失败）就记下来 */
const extractTried = new Set<string>()

/** 抽出来的图标边长。卡片上显示 24px，48 在高分屏下也够清楚 */
const EXTRACT_SIZE = 48
/**
 * 抽一张要一两秒（PowerShell 起进程 + 编译 P/Invoke 声明），所以只在 shell 没取到真图标时走；
 * 同时限制并发，程序多了不至于一下点着十几个 PowerShell。
 */
const EXTRACT_CONCURRENCY = 3
const EXTRACT_TIMEOUT = 10_000

/**
 * 从程序资源里直接抽图标的脚本。
 *
 * PrivateExtractIcons 按要求的边长取，程序里只有 16/32 的小图时也能拿到，
 * 不像 shell 的图标列表那样直接退回默认图。脚本以 UTF-16LE base64 通过
 * -EncodedCommand 传进去：不落临时脚本文件，也不用操心换行与引号转义。
 */
const EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Workbench -Name Icon -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, int[] ids, int count, uint flags);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
'@
$size = [int]$env:WB_ICON_SIZE
$handles = New-Object IntPtr[] 1
$ids = New-Object int[] 1
$n = [Workbench.Icon]::PrivateExtractIcons($env:WB_ICON_TARGET, 0, $size, $size, $handles, $ids, 1, 0)
if ($n -le 0 -or $handles[0] -eq [IntPtr]::Zero) { exit 2 }
$icon = [System.Drawing.Icon]::FromHandle($handles[0])
$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$bitmap.Dispose(); $icon.Dispose(); [void][Workbench.Icon]::DestroyIcon($handles[0])
`

let encodedScript: string | null = null

function encodedExtractScript(): string {
  encodedScript ??= Buffer.from(EXTRACT_SCRIPT, 'utf16le').toString('base64')
  return encodedScript
}

function runExtract(source: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodedExtractScript()
        ],
        {
          windowsHide: true,
          env: { ...process.env, WB_ICON_TARGET: source, WB_ICON_SIZE: String(EXTRACT_SIZE) }
        }
      )
    } catch {
      resolve(null)
      return
    }

    let out = ''
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
      done(null)
    }, EXTRACT_TIMEOUT)

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.once('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const base64 = out.trim()
      done(code === 0 && base64 ? `data:image/png;base64,${base64}` : null)
    })
  })
}

/** 抽取排队：同一时刻最多跑 EXTRACT_CONCURRENCY 个 */
let extractActive = 0
const extractWaiting: Array<() => void> = []

async function extractIcon(source: string): Promise<string | null> {
  if (extractActive >= EXTRACT_CONCURRENCY) {
    await new Promise<void>((resolve) => extractWaiting.push(resolve))
  }
  extractActive += 1
  try {
    return await runExtract(source)
  } finally {
    extractActive -= 1
    extractWaiting.shift()?.()
  }
}

/**
 * 通用图标的基准。
 *
 * 给一个不存在的 .exe 路径，shell 会返回「exe 这个类型的默认图标」——
 * 正是 getFileIcon 取不到真图标时给的那张。拿它当尺子，就能认出「这次没取到真图标」。
 */
let genericIcon: string | null | undefined

async function genericIconUrl(): Promise<string | null> {
  if (genericIcon !== undefined) return genericIcon

  try {
    const probe = join(app.getPath('temp'), 'workbench-icon-probe-nonexistent.exe')
    const image = await app.getFileIcon(probe, { size: 'large' })
    genericIcon = image.isEmpty() ? null : image.toDataURL()
  } catch {
    genericIcon = null
  }
  return genericIcon
}

/**
 * 程序的系统图标。
 *
 * 不落盘：图标是 data URL，几十个程序各存一份会让数据文件迅速变胖，
 * 而它随时能从系统再取一次。渲染层拿到后自己留一份，不必每次重取。
 *
 * 取图分两步：先问 shell（快，绝大多数程序一步到位）；拿到的是「该类型的默认图标」时
 * 说明 shell 没读出真图标（见 genericIconUrl 的说明），再花一两秒从程序资源里抽一张。
 */
export async function quickAppIcon(target: string): Promise<Result<string>> {
  const path = (target ?? '').trim()
  if (!path) return fail('程序路径为空')

  const source = iconSourceOf(path)
  const stat = await statOrNull(source)
  if (!stat) return fail('程序不存在或已被移动')

  const key = `${source}|${stat.mtimeMs}|${stat.size}`
  const cached = iconCache.get(key)
  if (cached) return ok(cached)

  const image = await app.getFileIcon(source, { size: 'large' }).catch(() => null)
  let dataUrl = image && !image.isEmpty() ? image.toDataURL() : ''

  const fallback = await genericIconUrl()
  if ((!dataUrl || (fallback && dataUrl === fallback)) && !extractTried.has(key)) {
    extractTried.add(key)
    const extracted = await extractIcon(source)
    if (extracted) dataUrl = extracted
  }

  if (!dataUrl) return fail('系统没有返回这个程序的图标')

  if (iconCache.size >= ICON_CACHE_LIMIT) iconCache.clear()
  iconCache.set(key, dataUrl)
  return ok(dataUrl)
}

// ---------- 增删改 ----------

export function addQuickApp(input: QuickAppInput): Result<QuickApp> {
  const target = typeof input?.target === 'string' ? input.target.trim() : ''
  if (!target) return fail('请先选择要启动的程序')

  const entry: QuickApp = {
    id: randomUUID(),
    name: blankToUndefined(input.name) ?? defaultQuickAppName(target),
    target,
    order: data().quickApps.length,
    createdAt: Date.now()
  }

  data().quickApps.push(entry)
  save()
  return ok(entry)
}

export function updateQuickApp(id: string, patch: QuickAppPatch): Result<QuickApp> {
  const entry = data().quickApps.find((item) => item.id === id)
  if (!entry) return fail('该快捷启动项已不存在')

  if (typeof patch?.name === 'string') {
    const name = patch.name.trim()
    if (!name) return fail('名称不能为空')
    entry.name = name
  }

  if (typeof patch?.target === 'string') {
    const target = patch.target.trim()
    if (!target) return fail('程序路径不能为空')
    entry.target = target
  }

  save()
  return ok(entry)
}

export function removeQuickApp(id: string): Result<null> {
  const list = data().quickApps
  const index = list.findIndex((item) => item.id === id)
  if (index === -1) return fail('该快捷启动项已不存在')

  list.splice(index, 1)
  list.forEach((item, position) => {
    item.order = position
  })
  save()
  return ok(null)
}

/** 拖动排序：与分组同一套做法，顺序即 order */
export function reorderQuickApps(ids: string[]): Result<QuickApp[]> {
  if (!Array.isArray(ids)) return fail('参数不合法')

  const ordered = reorderById(data().quickApps, ids)
  ordered.forEach((item, index) => {
    item.order = index
  })
  data().quickApps = ordered

  save()
  return ok(ordered)
}
