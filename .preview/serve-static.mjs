/**
 * PREVIEW-ONLY：把 .preview/dist 当静态站点起起来，供无头 Edge 截图用。
 * 用法：node .preview/serve-static.mjs [port]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

const root = new URL('./dist/', import.meta.url)
const port = Number(process.argv[2] || 5290)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  try {
    const body = await readFile(new URL(rel, root))
    res.writeHead(200, { 'content-type': TYPES[extname(rel).toLowerCase()] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`preview: http://127.0.0.1:${port}/`))
