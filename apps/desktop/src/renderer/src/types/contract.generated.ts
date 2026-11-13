// 由 apps/desktop/scripts/gen-rust-contract.mjs 从 Rust 的 `// @contract` 结构生成。
// 不要手改：改 Rust 那边的结构，然后跑 `pnpm run contract:gen`。

export interface AiRuntimeStatus {
  source: string
  cli: string
  pi: string
  node: string
  detail: string
  skillRoot: string
}

export interface AuthStatusWire {
  configured: boolean
  redirectUri: string
  providers: string[]
  configError: string
}

export interface NoteRepoStateWire {
  isRepo: boolean
  origin: string
  branch: string
}

export interface NrmRegistry {
  name: string
  url: string
  current: boolean
}

export interface NrmStatus {
  available: boolean
  version?: string | null
  current?: string | null
  registries: NrmRegistry[]
  error?: string | null
}

export interface NvmStatus {
  available: boolean
  root?: string | null
  symlink?: string | null
  current?: string | null
  versions: string[]
  error?: string | null
}

export interface PortCheckResult {
  port: number
  inUse: boolean
  pid?: number | null
  processName?: string | null
}

export interface TokenDevice {
  id: string
  name: string
}
