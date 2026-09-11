import { spawn, exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { dialog, shell, BrowserWindow } from 'electron'
import type {
  InstallablePackageManager,
  PackageManagerStatus,
  PortCheckResult,
  Result
} from '../shared/types'

/** 执行 `<bin> --version`，用于探测包管理器是否可用 */
function probeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['--version'], { shell: true, windowsHide: true })
    } catch {
      done(null)
      return
    }

    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => done(null))
    child.on('close', (code) => done(code === 0 ? out.trim().split(/\r?\n/)[0] : null))

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      done(null)
    }, 8000)
  })
}

export async function checkPackageManagers(): Promise<PackageManagerStatus> {
  const [npm, yarn, pnpm, node] = await Promise.all([
    probeVersion('npm'),
    probeVersion('yarn'),
    probeVersion('pnpm'),
    probeVersion('node')
  ])
  return {
    npm: npm !== null,
    yarn: yarn !== null,
    pnpm: pnpm !== null,
    node: node ?? ''
  }
}

/** 安装包管理器最多等 5 分钟：registry 慢的时候一分钟上下是常态，但也不能无限挂着 */
const PM_INSTALL_TIMEOUT = 5 * 60 * 1000

/**
 * 用 npm 全局安装 yarn / pnpm。
 *
 * 走 shell 是为了照顾 Windows 的 npm.cmd；输出按行回调，界面能一直看到 npm 在干什么，
 * 不用对着一个转圈等一分钟。npm 本身不在可安装之列（它随 Node.js 分发）。
 */
export function installPackageManager(
  pm: InstallablePackageManager,
  onLog?: (text: string) => void
): Promise<Result<null>> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npm', ['install', '-g', pm], { shell: true, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: `无法启动 npm：${(err as Error).message}` })
      return
    }

    let settled = false
    let timer: NodeJS.Timeout | undefined
    /** 最后一行输出：失败时把它当作原因带回去，比只报一个退出码有用 */
    let tail = ''

    const finish = (ok: boolean, error?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok ? { ok: true } : { ok: false, error })
    }

    const pipe = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const text = line.trim()
        if (!text) continue
        tail = text
        onLog?.(text)
      }
    }

    child.stdout?.on('data', pipe)
    child.stderr?.on('data', pipe)
    child.on('error', (err) => finish(false, `无法启动 npm：${err.message}`))
    child.on('close', (code) => {
      if (code === 0) {
        finish(true)
        return
      }
      finish(false, tail || `npm install -g ${pm} 退出码 ${code}`)
    })

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      finish(false, `安装 ${pm} 超时，请检查网络或手动执行 npm install -g ${pm}`)
    }, PM_INSTALL_TIMEOUT)
  })
}

/**
 * 「有主窗口就挂上去、取消或空选择都返回 null」的对话框样板。
 * 选目录、选程序、选背景图三处原本各抄一遍，统一收在这里。
 */
export async function showOpenDialogSafe(
  parent: BrowserWindow | undefined,
  options: Electron.OpenDialogOptions
): Promise<string | null> {
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

export async function pickDirectory(
  parent?: BrowserWindow,
  title = '选择项目目录'
): Promise<string | null> {
  return showOpenDialogSafe(parent, { properties: ['openDirectory'], title })
}

/** 用系统资源管理器打开目录（或定位到文件） */
export async function reveal(targetPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
  try {
    stat = await fs.stat(targetPath)
  } catch {
    throw new Error(`目录不存在：${targetPath}`)
  }

  if (stat.isDirectory()) {
    const message = await shell.openPath(targetPath)
    if (message) throw new Error(message)
  } else {
    shell.showItemInFolder(targetPath)
  }
}

/**
 * 端口是否已被占用。
 *
 * 以「能不能连上」为准。Windows 上不能只用 bind 探测：某个进程绑了 0.0.0.0:P 之后，
 * 再往 127.0.0.1:P 绑仍然会成功，于是端口明明被占着却探测成空闲。
 * 只有连接结果不明确（超时、非「拒绝」类错误，例如防火墙拦了回包）时，才回退到 bind 兜底。
 */
async function isPortInUse(port: number): Promise<boolean> {
  const connected = await canConnect(port)
  if (connected !== null) return connected
  return !(await canBind(port, '0.0.0.0')) || !(await canBind(port, '127.0.0.1'))
}

/** 连得上 = 有服务在听；ECONNREFUSED = 明确没人听；其余情况返回 null 交给调用方兜底 */
function canConnect(port: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (value: boolean | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done(err.code === 'ECONNREFUSED' || err.code === 'ENETUNREACH' ? false : null)
    )
    socket.once('timeout', () => done(null))
  })
}

/** 能不能在这个地址上监听；绑不上说明端口被占 */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(!(err.code === 'EADDRINUSE' || err.code === 'EACCES'))
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

function findPidByPort(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(undefined)
      return
    }
    exec(
      'netstat -ano -p tcp',
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(undefined)
          return
        }
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.includes('LISTENING')) continue
          const cols = line.trim().split(/\s+/)
          const local = cols[1] ?? ''
          if (!local.endsWith(`:${port}`)) continue
          const pid = Number(cols[cols.length - 1])
          if (Number.isFinite(pid) && pid > 0) {
            resolve(pid)
            return
          }
        }
        resolve(undefined)
      }
    )
  })
}

function processNameOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(undefined)
      return
    }
    exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(undefined)
        return
      }
      const matched = stdout.match(/^"([^"]+)"/m)
      resolve(matched ? matched[1] : undefined)
    })
  })
}

export async function checkPort(port: number): Promise<PortCheckResult> {
  const inUse = await isPortInUse(port)
  if (!inUse) return { port, inUse: false }

  const pid = await findPidByPort(port)
  const name = pid ? await processNameOf(pid) : undefined
  return { port, inUse: true, pid, processName: name }
}

/**
 * 结束整棵进程树。
 *
 * Windows 上必须 taskkill /T，否则 shell 拉起的 cmd 之下还有真正的 dev server。
 * POSIX 上子进程是 detached 起的（自成进程组），所以先按 `-pid` 杀整组；
 * 拿不到进程组（例如进程不是组长）再退回杀单个 pid —— 只杀父进程会留下
 * 占着端口的孙进程，表现为「已结束」但端口仍然被占。
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', (err) => reject(err))
      killer.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`taskkill 退出码 ${code}`))
      )
      return
    }

    try {
      process.kill(-pid, 'SIGKILL')
      resolve()
      return
    } catch {
      /* 不是进程组长：退回杀单个进程 */
    }
    try {
      process.kill(pid, 'SIGKILL')
      resolve()
    } catch (err) {
      reject(err as Error)
    }
  })
}

export async function killPortProcess(port: number): Promise<void> {
  const pid = await findPidByPort(port)
  if (!pid) throw new Error(`未找到占用 ${port} 端口的进程`)
  await killProcessTree(pid)
}
