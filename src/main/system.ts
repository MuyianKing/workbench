import { spawn, exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { dialog, shell, BrowserWindow } from 'electron'
import type { PackageManagerStatus, PortCheckResult } from '../shared/types'

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

export async function pickDirectory(
  parent?: BrowserWindow,
  title = '选择项目目录'
): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'], title }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
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

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES')
    })
    server.once('listening', () => {
      server.close(() => resolve(false))
    })
    server.listen(port, '127.0.0.1')
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
