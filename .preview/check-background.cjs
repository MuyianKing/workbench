/**
 * PREVIEW-ONLY：在 Electron 里直接跑主进程的读图逻辑，确认 nativeImage 解码 / 缩放 / 转 JPEG
 * 这条链路真的能用（浏览器预览只能覆盖渲染层那一半）。
 *
 * 先打包再跑：
 *   node_modules\.bin\esbuild src/main/background.ts --bundle --platform=node --format=cjs ^
 *     --external:electron --outfile=.preview/background.cjs
 *   node_modules\electron\dist\electron.exe .preview/check-background.cjs
 */
const { app } = require('electron')
const { readBackgroundImage } = require('./background.cjs')

app.whenReady().then(async () => {
  const cases = [
    ['水墨竹背景图', 'F:/projects/workbench/resources/backgrounds/ink-bamboo.png'],
    ['文件不存在', 'F:/nope/missing.jpg'],
    ['空路径', ''],
    ['不是图片', 'F:/projects/workbench/package.json']
  ]

  for (const [label, target] of cases) {
    const result = await readBackgroundImage(target)
    if (result.ok) {
      const bytes = Buffer.from(result.data.dataUrl.split(',')[1], 'base64').length
      console.log(
        `${label}: ok name=${result.data.name} jpeg=${Math.round(bytes / 1024)}KB url=${Math.round(result.data.dataUrl.length / 1024)}KB head=${result.data.dataUrl.slice(0, 32)}`
      )
    } else {
      console.log(`${label}: fail ${result.error}`)
    }
  }

  app.exit(0)
})

