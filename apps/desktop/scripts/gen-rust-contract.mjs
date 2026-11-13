/**
 * 从 Rust 的 `// @contract` 结构生成 TS 契约（`types/contract.generated.ts`）。
 *
 * 为什么自己写一个、不引 `ts-rs` / `typeshare`：AGENTS.md 第 1 节对 Rust 依赖的判据是
 * **不新增编译单元**，而现成的生成器都要往依赖树里加 crate。这里只解析我们自己写的那一小撮
 * payload 结构（`// @contract` 标记过的），够用且没有额外依赖。
 *
 * 约定（新增被标记的结构时按这个写，解析器按行读、不认复杂语法）：
 * - 标记行 `// @contract` 紧贴在一组属性 / 结构声明之前；
 * - `#[serde(rename_all = "camelCase")]` 决定字段名的写法（TS 侧按这个生成）；
 * - 字段一行一条：`pub name: Type,`，支持 `Option<T>` / `Vec<T>` / `HashMap<String, T>`；
 * - `#[serde(skip)]` 的字段不出现；`#[serde(rename = "...")]` 覆盖字段名；
 * - `#[serde(skip_serializing_if = "Option::is_none")]` 的字段在 TS 里是可选的（`?:`）。
 *
 * `--check` 只比对、不写盘（CI / verify 用）：生成结果与仓库里那份不一致就失败。
 *
 * 另一道闸门在 `src-tauri/contract-value-allow.txt`：**新增一条返回 `Value` 的命令会失败**，
 * 逼着新命令用带 `// @contract` 的结构；确实要保留 `Value` 的，人工跑 `--accept` 把清单重写
 * （跑完记得看一眼 diff，只该多出你刚加的那一条）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const RUST_DIR = join(ROOT, 'apps/desktop/src-tauri/src')
const OUT = join(ROOT, 'apps/desktop/src/renderer/src/types/contract.generated.ts')
/** 仍返回 `Value` 的命令豁免清单（历史包袱；新增一条要显式写进来，见文件头） */
const VALUE_ALLOW = join(ROOT, 'apps/desktop/src-tauri/contract-value-allow.txt')

/** Rust 基础类型 → TS */
const PRIMITIVES = new Map([
  ['bool', 'boolean'],
  ['String', 'string'],
  ['str', 'string'],
  ['&str', 'string'],
  ['char', 'string'],
  ['u8', 'number'],
  ['u16', 'number'],
  ['u32', 'number'],
  ['u64', 'number'],
  ['usize', 'number'],
  ['i8', 'number'],
  ['i16', 'number'],
  ['i32', 'number'],
  ['i64', 'number'],
  ['isize', 'number'],
  ['f32', 'number'],
  ['f64', 'number'],
  ['Value', 'unknown'],
  ['serde_json::Value', 'unknown'],
])

/** 取最后一个路径段：`crate::kb::RawSource` → `RawSource` */
function lastSegment(type) {
  return type.split('::').pop().trim()
}

/** 拆出最外层泛型的实参：`Option<String>` → ['Option', ['String']] */
function splitGeneric(type) {
  const open = type.indexOf('<')
  if (open < 0)
    return null
  const name = type.slice(0, open).trim()
  const inner = type.slice(open + 1, type.lastIndexOf('>'))
  const args = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '<')
      depth += 1
    else if (ch === '>')
      depth -= 1
    else if (ch === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  args.push(inner.slice(start).trim())
  return [name, args]
}

/** Rust 类型 → TS 类型（尽量宽松：认不出就当同名的 TS 类型） */
function tsType(raw) {
  const type = raw.trim().replace(/\s+/g, ' ')
  const generic = splitGeneric(type)
  if (generic) {
    const [name, args] = generic
    if (name === 'Option')
      return `${tsType(args[0])} | null`
    if (name === 'Vec') {
      const inner = tsType(args[0])
      // 与项目 ESLint 口径一致：简单类型写 `T[]`，带联合 / 泛型的才用 `Array<T>`
      return inner.includes(' | ') || inner.includes('<') ? `Array<${inner}>` : `${inner}[]`
    }
    if (name === 'HashMap' || name === 'BTreeMap')
      return `Record<string, ${tsType(args[1] ?? args[0])}>`
    return `${lastSegment(name)}<${args.map(tsType).join(', ')}>`
  }
  if (PRIMITIVES.has(type))
    return PRIMITIVES.get(type)
  if (type.startsWith('&'))
    return tsType(type.slice(1).trim())
  return lastSegment(type)
}

/** snake_case → camelCase（与 serde 的 rename_all = "camelCase" 同口径） */
function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())
}

/** 从属性块里取 `rename_all` 的值 */
function renameAll(attrs) {
  for (const attr of attrs) {
    const match = /rename_all\s*=\s*"([^"]+)"/.exec(attr)
    if (match)
      return match[1]
  }
  return null
}

function applyRename(name, rule) {
  if (rule === 'camelCase')
    return camel(name)
  if (rule === 'lowercase')
    return name.toLowerCase()
  if (rule === 'SCREAMING_SNAKE_CASE')
    return name.toUpperCase()
  return name
}

function parseFile(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\/\/\s*@contract\s*$/.test(lines[i]))
      continue

    let j = i + 1
    const attrs = []
    while (j < lines.length && /^\s*#\[/.test(lines[j])) {
      attrs.push(lines[j].trim())
      j += 1
    }

    const header = /^\s*pub (struct|enum) (\w+)/.exec(lines[j] ?? '')
    if (!header)
      throw new Error(`${path}:${i + 1} 的 @contract 后面不是 pub struct / enum`)
    const [, kind, name] = header
    const rule = renameAll(attrs)

    j += 1
    const body = []
    while (j < lines.length && !/^\s*\}\s*$/.test(lines[j])) {
      body.push(lines[j])
      j += 1
    }

    if (kind === 'enum') {
      const values = []
      for (const line of body) {
        const match = /^\s*(\w+)\s*(?:=\s*"[^"]*")?\s*,?\s*(?:\/\/.*)?$/.exec(line)
        if (match)
          values.push(applyRename(match[1], rule ?? 'camelCase'))
      }
      out.push({ name, kind: 'enum', values })
      continue
    }

    const fields = []
    let pending = []
    for (const line of body) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#[')) {
        pending.push(trimmed)
        continue
      }
      const match = /^pub (\w+): (.+?),\s*(?:\/\/.*)?$/.exec(trimmed)
      if (!match) {
        pending = []
        continue
      }
      const [, field, type] = match
      if (pending.some(attr => /serde\([^)]*skip(?:,|\))/.test(attr))) {
        pending = []
        continue
      }
      const rename = pending
        .map(attr => /rename\s*=\s*"([^"]+)"/.exec(attr)?.[1])
        .find(Boolean)
      const optional = pending.some(attr => attr.includes('skip_serializing_if'))
      fields.push({
        name: rename ?? applyRename(field, rule),
        type: tsType(type),
        optional,
      })
      pending = []
    }
    out.push({ name, kind: 'struct', fields })
  }
  return out
}

/** 命令层还返回 `Value` 的函数名：历史包袱，新增的必须走 typed payload 或显式登记 */
function valueCommands(files) {
  const names = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*#\[tauri::command/.test(lines[i]))
        continue
      let signature = ''
      let j = i + 1
      while (j < lines.length && j < i + 30) {
        signature += `${lines[j]} `
        if (/\{\s*$/.test(lines[j]))
          break
        j += 1
      }
      const fn = /pub (?:async )?fn (\w+)\s*\(/.exec(signature)
      const returnType = signature.split('->')[1]
      if (fn && returnType && /\bValue\b/.test(returnType))
        names.push(fn[1])
      i = j
    }
  }
  return names.sort()
}

function readAllowList() {
  try {
    return readFileSync(VALUE_ALLOW, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  }
  catch {
    return null
  }
}

/**
 * 豁免清单的闸门：新增一条返回 Value 的命令会让 `contract:check` 失败。
 * `--accept` 是人工动作（真的决定接受一条新的 Value 命令时才跑），会重写清单。
 */
function checkValueAllow(files, { accept }) {
  const current = valueCommands(files)
  if (accept) {
    const header = [
      '# 仍返回 serde_json::Value 的命令（历史包袱）。',
      '# 新命令请改成带 // @contract 的结构；确实要保留 Value 的，显式加到这里并说明原因。',
      '# 生成：node apps/desktop/scripts/gen-rust-contract.mjs --accept（人工动作）',
      '',
    ]
    writeFileSync(VALUE_ALLOW, `${[...header, ...current].join('\n')}\n`)
    console.log(`✅ 已更新 ${relative(ROOT, VALUE_ALLOW)}（${current.length} 条）`)
    return true
  }

  const allow = readAllowList()
  if (!allow) {
    console.error(`缺少豁免清单：${relative(ROOT, VALUE_ALLOW)}`)
    return false
  }
  const extra = current.filter(name => !allow.includes(name))
  const stale = allow.filter(name => !current.includes(name))
  if (extra.length) {
    console.error('新增了返回 Value 的命令（改成 typed payload，或显式加进豁免清单）：')
    for (const name of extra)
      console.error(`  ${name}`)
    return false
  }
  if (stale.length)
    console.warn(`豁免清单里有 ${stale.length} 条已不再返回 Value（可以删掉）：${stale.join(', ')}`)
  return true
}

function render(contracts) {
  const blocks = contracts
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => {
      if (item.kind === 'enum') {
        const values = item.values.map(value => `'${value}'`).join(' | ')
        return `export type ${item.name} = ${values || 'never'}`
      }
      const fields = item.fields
        .map(field => `  ${field.name}${field.optional ? '?' : ''}: ${field.type}`)
        .join('\n')
      return `export interface ${item.name} {\n${fields}\n}`
    })
  return [
    '// 由 apps/desktop/scripts/gen-rust-contract.mjs 从 Rust 的 `// @contract` 结构生成。',
    '// 不要手改：改 Rust 那边的结构，然后跑 `pnpm run contract:gen`。',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n')
}

function main() {
  const files = readdirSync(RUST_DIR)
    .filter(name => name.endsWith('.rs'))
    .map(name => join(RUST_DIR, name))

  const accept = process.argv.includes('--accept')
  if (!checkValueAllow(files, { accept })) {
    process.exitCode = 1
    return
  }
  if (accept)
    return

  const contracts = files.flatMap(parseFile)
  const seen = new Map()
  for (const item of contracts) {
    if (seen.has(item.name))
      throw new Error(`契约类型重名：${item.name}（${seen.get(item.name)} 与 ${relative(ROOT, RUST_DIR)}）`)
    seen.set(item.name, relative(ROOT, RUST_DIR))
  }
  if (!contracts.length)
    throw new Error('一个 // @contract 结构都没找到')

  const next = render(contracts)
  const check = process.argv.includes('--check')

  if (check) {
    let current = ''
    try {
      current = readFileSync(OUT, 'utf8')
    }
    catch {
      console.error(`缺少生成文件：${relative(ROOT, OUT)}（跑 pnpm run contract:gen）`)
      process.exitCode = 1
      return
    }
    if (current !== next) {
      const a = current.split('\n')
      const b = next.split('\n')
      const at = a.findIndex((line, index) => line !== b[index])
      console.error(`契约与 Rust 不一致（${relative(ROOT, OUT)}:${(at < 0 ? 0 : at) + 1}）—— 跑 pnpm run contract:gen`)
      console.error(`  仓库里：${a[at] ?? '(文件结束)'}`)
      console.error(`  生成结果：${b[at] ?? '(文件结束)'}`)
      process.exitCode = 1
      return
    }
    console.log(`✅ 契约已对齐（${contracts.length} 个类型）`)
    return
  }

  writeFileSync(OUT, next)
  console.log(`✅ 已生成 ${relative(ROOT, OUT)}（${contracts.length} 个类型）`)
}

main()
