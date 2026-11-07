import type { AppSettings, EffectiveTheme, InstallablePackageManager, WindowState, WorkbenchApi } from '@/types'
import { ok } from '@workbench/core'
import { notifyWarning } from '@/notify'
import { errorText, guard, invoke } from './bridge'
import * as nrm from './nrm'
import * as nvm from './nvm'
import * as state from './state'
import * as system from './system'

/**
 * 系统这一侧的通道：对话框、系统集成（自启 / 快捷键 / 遮罩预热 / 悬浮球）、
 * 环境探测（nvm / nrm / 包管理器）、文件拾取与窗口控制。
 */

/** 对话框选项里的 `defaultPath` 也要过一道（它同样交给 Shell 去定位起始目录） */
function withShellPath(options: Record<string, unknown>): Record<string, unknown> {
  const value = options.defaultPath
  return typeof value === 'string' ? { ...options, defaultPath: windowsPath(value) } : options
}

/**
 * 交给资源管理器 / 文件对话框的路径：**分隔符一律换成反斜杠**。
 *
 * 设置里的路径可能是 `E:/a/b` 这种写法（技能库那一项就是），而 Shell 侧的路径解析
 * 只认反斜杠：`E:/a\b` 这种混写的 `SHParseDisplayName` 直接解析失败，explorer 就开到
 * 别处去了（实测：混写的解析不出来，整条换成反斜杠的能）。Rust 侧的文件操作两种都认，
 * 所以只在「要给 Shell」的这两个口子上换。
 */
export function windowsPath(raw: string): string {
  return raw.replace(/\//g, '\\')
}

/**
 * 文件对话框：直接调插件命令，不引 @tauri-apps/plugin-dialog 包
 * （tauri.conf.json 里开了 withGlobalTauri，走 __TAURI__ 即可）。
 */
export async function openDialog(options: Record<string, unknown>): Promise<string | null> {
  const selected = await invoke<string | string[] | null>('plugin:dialog|open', {
    options: withShellPath(options),
  })
  if (typeof selected === 'string')
    return selected
  if (Array.isArray(selected))
    return selected[0] ?? null
  return null
}

/**
 * 多选版：返回全部选中的路径（邮箱发信的附件要一次挑好几个）。
 * 单选环境里插件回的是单个字符串，也包成单元素数组 —— 调用方只面对一种形状。
 */
export async function openDialogMultiple(options: Record<string, unknown>): Promise<string[] | null> {
  const selected = await invoke<string | string[] | null>('plugin:dialog|open', {
    options: withShellPath(options),
  })
  if (Array.isArray(selected))
    return selected
  return typeof selected === 'string' && selected.trim() ? [selected] : null
}

/**
 * 「另存为」对话框（保险库密钥导出用）。与 openDialog 同一个理由：直接调插件命令，
 * 不引 @tauri-apps/plugin-dialog 包。用户在对话框里取消时返回 null。
 */
export async function saveDialog(options: Record<string, unknown>): Promise<string | null> {
  const selected = await invoke<string | null>('plugin:dialog|save', {
    options: withShellPath(options),
  })
  return typeof selected === 'string' && selected.trim() ? selected : null
}

/**
 * 把设置里的 system 解析成实际明暗
 */
export function resolveTheme(theme: AppSettings['theme']): EffectiveTheme {
  if (theme === 'light' || theme === 'dark')
    return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 三条全局快捷键的值。
 *
 * **值由这一侧给**（Rust 不读设置）：默认值（截图是 F1）只活在 `@workbench/capture` 里，
 * Rust 去数据文件里读的话，「刚加上的字段还没被写回盘」那一段读到的是空的 ——
 * 首启按 F1 就没反应，而且之后再也不会补注册（踩过一次）。
 * 关掉的开关、空串都收敛成 null = 不要那一条。
 */
export function hotkeyArgs(settings: AppSettings): Record<string, string | null> {
  return {
    main: settings.hotkeyEnabled ? settings.hotkey : null,
    capture: settings.captureEnabled ? settings.captureHotkey : null,
  }
}

/**
 * 把设置里的系统集成项落到系统上：开机自启、全局快捷键、截图遮罩预热、网速球。
 *
 * 失败只记一笔就够：设置已经存下了，注册不上（被占用、被策略拦）不该连带让改设置这件事失败。
 * 只有快捷键那条会**说一句**：界面上看着「设过了」、按下去却没反应是最难查的那种，
 * 得让用户知道是「被别的程序占了」而不是功能坏了。
 */
export async function syncSystemIntegration(settings: AppSettings): Promise<void> {
  // **遮罩池先开始建、而且不排在后面 await**：它要起 WebView2（一块屏一百多毫秒），是这几项里
  // 最重的一笔；开机自启与快捷键都是毫秒级。并行起来，启动后能尽快具备「按热键即出」的条件。
  const prewarm = invoke('capture_prewarm', { enabled: settings.captureEnabled }).catch((error) => {
    console.warn('[workbench] 预建截图遮罩失败', error)
  })

  try {
    await invoke('set_autostart', { enabled: settings.launchAtLogin })
  }
  catch (error) {
    console.warn('[workbench] 设置开机自启失败', error)
  }

  try {
    // 三条一起装：插件注册是「先全清再逐条注册」，分几次调会互相注销（见 main.rs）
    await invoke('apply_hotkeys', hotkeyArgs(settings))
  }
  catch (error) {
    notifyWarning(errorText(error, '全局快捷键注册失败，可能被别的程序占用了'))
  }

  try {
    // 网速球：开 / 关那一扇独立的置顶窗口。**同样必须等设置载完再调**（它读的正是 ballEnabled）。
    // 失败不打扰用户：设置已经存下了，下次改一下开关还能再试
    await invoke('ball_apply', { visible: settings.ballEnabled })
  }
  catch (error) {
    console.warn('[workbench] 开关悬浮球失败', error)
  }

  await prewarm
}

export const systemApi = {
  // Tauri 下没有 Node 版本；Chromium 版本取 WebView2 的 UA。
  versions: {
    node: '—',
    chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '—',
  },

  getBootstrap: () => ({
    theme: resolveTheme(state.initialSettings().theme),
    settings: state.initialSettings(),
    themeConfig: state.initialTheme(),
  }),

  // ---------- 系统 ----------
  checkPackageManagers: () => system.checkPackageManagers(),
  installPackageManager: (pm: InstallablePackageManager) => system.installPackageManager(pm),

  checkNodeVersion: (id: string) => nvm.checkNodeVersion(id),

  /** nvm 只读探测：目录、settings.txt、软链都由 Rust 扫，形状与 NvmStatus 一致 */
  getNvmStatus: () => nvm.status(),

  /** nrm：镜像清单与「当前是哪个」都问 nrm 自己（见 src-tauri/src/nrm.rs） */
  getNrmStatus: () => nrm.status(),
  installNrm: () => nrm.install(),
  useNrmRegistry: (name: string) => nrm.useRegistry(name),

  pickDirectory: (title?: string, defaultPath?: string) =>
    openDialog({
      directory: true,
      multiple: false,
      title: title ?? '选择项目目录',
      ...(defaultPath ? { defaultPath } : {}),
    }),
  // 挑一个文件（技能包那种要按后缀过滤的走这条；取消回 null，不是失败）
  pickFile: (title?: string, filters?: Array<{ name: string, extensions: string[] }>) =>
    openDialog({
      directory: false,
      multiple: false,
      title: title ?? '选择文件',
      ...(filters && filters.length ? { filters } : {}),
    }),
  // 挑多个文件（邮箱发信的附件用）；全取消回 null
  pickFiles: (title?: string, filters?: Array<{ name: string, extensions: string[] }>) =>
    openDialogMultiple({
      directory: false,
      multiple: true,
      title: title ?? '选择文件',
      ...(filters && filters.length ? { filters } : {}),
    }),
  // 「另存为」挑保存路径（邮箱附件下载用）；取消回 null，不是失败
  pickSavePath: (options: { title?: string, defaultPath?: string, filters?: Array<{ name: string, extensions: string[] }> }) =>
    saveDialog({
      title: options.title ?? '另存为',
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
      ...(options.filters && options.filters.length ? { filters: options.filters } : {}),
    }),
  checkPort: (port: number) => invoke('check_port', { port }),
  killPortProcess: (port: number) =>
    guard(invoke<null>('kill_port_process', { port }), '结束进程失败'),
  reveal: (targetPath: string) => {
    // 资源管理器只认反斜杠：给它的路径一律换过（见 windowsPath），否则会开到别处
    void invoke('reveal', { path: windowsPath(targetPath) })
    return Promise.resolve(ok(null))
  },
  // 这条**要**等结果：没装 VS Code 时 ShellExecute 会失败，得把原因说出来
  openInVSCode: (path: string) =>
    guard(invoke<null>('open_in_vscode', { path }), '打开 VS Code 失败'),
  openExternal: (url: string) =>
    guard(invoke<null>('open_external', { url }), '打开链接失败'),
  /** 用系统默认程序打开本地文件（与快捷启动同走 open_path，不新增 Rust 命令） */
  openPath: (path: string) => guard(invoke<null>('open_path', { path }), '打开文件失败'),
  /** 按路径读一个文本文件（AI 预览栏用；fs_read_text 一直在，这里给个能判 ok 的门面） */
  readTextFile: (path: string) => guard(invoke<string>('fs_read_text', { path }), '读取文件失败'),
  /**
   * 按路径读一个二进制文件、以 base64 回传（AI 预览栏的 DOCX / PPTX 是 zip 容器，
   * 文本通道读不了；解码见 decodeBase64ToBuffer）。
   */
  readBinaryFile: (path: string) =>
    guard(invoke<string>('fs_read_base64', { path }), '读取文件失败'),

  // ---------- 窗口 ----------
  minimizeWindow: () => {
    void invoke('window_minimize')
  },
  toggleMaximizeWindow: () => {
    void invoke('window_toggle_maximize')
  },
  closeWindow: () => {
    void invoke('window_close')
  },
  getWindowState: () =>
    invoke<boolean>('window_is_maximized').then((maximized): WindowState => ({ maximized })),
  // 窗口标题与托盘提示归系统，只能在 Rust 侧设；失败无处可报（它不影响任何功能），
  // 名字的收敛已经在上游做过了
  setAppName: (name: string) => {
    void invoke('set_app_name', { name })
  },
  getAppVersion: () => invoke<string>('app_version').catch(() => '—'),
} as Partial<WorkbenchApi>
