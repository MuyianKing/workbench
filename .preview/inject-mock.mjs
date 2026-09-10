/**
 * PREVIEW-ONLY：把 mock 脚本注入到构建产物 index.html 里。
 *
 * 必须用 Node 读写：PowerShell 的 Get-Content / Set-Content 往返会按本地代码页解码，
 * 把中文注释里的字节连同后面的换行一起吃掉，注入后的脚本直接语法错误。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const target = '.preview/dist/index.html'
const mockPath = '.preview/preview-mock.html'

const html = readFileSync(target, 'utf8')
if (html.includes('PREVIEW-ONLY')) {
  console.log('mock already injected')
  process.exit(0)
}

const mock = readFileSync(mockPath, 'utf8')
writeFileSync(target, html.replace('<script type="module"', `${mock}<script type="module"`), 'utf8')
console.log('mock injected')
