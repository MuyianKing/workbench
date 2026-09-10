/**
 * PREVIEW-ONLY：在 Electron 里跑真实的主进程逻辑，验证内置壁纸这条链路。
 *
 * 先打包再跑：
 *   node_modules\.bin\esbuild src/main/wallpapers.ts --bundle --platform=node --format=cjs ^
 *     --external:electron --outfile=.preview/wallpapers.cjs
 *   node_modules\electron\dist\electron.exe .preview/check-wallpapers.cjs
 */
const { app } = require('electron')

// 直接跑脚本时 app 根目录不是仓库根，这里固定成仓库根，
// 让 builtinDir() 走到 resources/backgrounds（与 electron-vite dev 下的取值一致）
app.getAppPath = () => 'F:/projects/workbench'

const { listWallpapers, resolveBackgroundTarget } = require('./wallpapers.cjs')
const { readBackgroundImage } = require('./background.cjs')

app.whenReady().then(async () => {
  const list = await listWallpapers()
  console.log(`内置壁纸：${list.length} 张`)
  for (const item of list) {
    console.log(
      `  id=${item.id}  ref=${item.reference}  name=${item.name}  缩略图=${Math.round(item.thumbnail.length / 1024)}KB`
    )
  }

  for (const item of list.slice(0, 2)) {
    const image = await readBackgroundImage(item.reference)
    console.log(
      image.ok
        ? `  读 ${item.reference} → ${image.data.name}，背景图 ${Math.round(image.data.dataUrl.length / 1024)}KB`
        : `  读 ${item.reference} 失败：${image.error}`
    )
  }

  console.log('脏数据：')
  for (const bad of ['builtin:../secret', 'builtin:没有这张', 'builtin:', 'D:/nope/x.jpg']) {
    const resolved = await resolveBackgroundTarget(bad)
    console.log(`  ${JSON.stringify(bad)} → ${resolved.ok ? `ok ${resolved.data}` : `fail ${resolved.error}`}`)
  }

  app.exit(0)
})
