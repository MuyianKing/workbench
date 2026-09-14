# npm install 卡在 better-sqlite3 编译

## 现象

`npm install` 在 better-sqlite3 处失败，报错指向 Visual Studio：

```
npm error path node_modules/better-sqlite3
npm error command C:\Windows\system32\cmd.exe /d /s /c node-gyp rebuild
npm error gyp ERR! find VS unknown version "undefined" found at "D:\Microsoft Visual Studio\18\BuildTools"
npm error gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use
npm error gyp ERR! node-gyp -v v9.4.1
```

`gypfile: false`、预编译产物 `prebuilds/win32-x64.node`、`node -e "require('better-sqlite3')"` 单测全都正常，
只有 `npm install` 挂在编译上——**这个编译本来就不该发生**。

## 根因链

1. npm 安装时请求的是精简元数据（registry 的 corgi / `install-v1` 文档），这个文档不含自定义字段，
   better-sqlite3 用来抑制自动探测的 `"gypfile": false` 被丢掉了（tarball 里的 package.json 是带这个字段的）。
2. arborist 的 gyp 自动探测只看 `node_modules/<pkg>/binding.gyp` 是否存在，于是判定这是老式 node-gyp 包，
   把 `scripts.install = "node-gyp rebuild"` 写进内存里的 manifest 并排进构建队列
   （`@npmcli/arborist/lib/arborist/rebuild.js` 的 `#addToBuildSet`：`gypfile !== false` 恒成立）。
   它在需要读脚本时只把磁盘 package.json 的 `scripts` 拷回对象，没有同步 `gypfile`，所以 `gypfile: false` 永远不生效。
3. 注入的脚本按 PATH 解析 `node-gyp`，最先命中的是 `@electron/rebuild@3.6.1`（electron-builder 依赖）带进来的
   **node-gyp 9.4.1**；它只认 VS 2017–2022，识别不了新装的 VS 18（2026）BuildTools，于是 configure 阶段就失败。

只装 better-sqlite3 的干净目录里同样会注入这段脚本，但那里 PATH 上只有 npm 自带的 node-gyp 12.x，
能正常识别 VS 18 并编译通过——所以这个坑只在「依赖树里带有旧 node-gyp」时表现为安装失败。

## 处理

`package.json` 的 devDependencies 里显式钉一个新版 node-gyp：

```json
"node-gyp": "^13.0.2"
```

npm 会把它提升到顶层 `node_modules/node-gyp`，`node_modules/.bin/node-gyp` 随之指向 13.x，
注入的那次编译就用它跑，不再落到旧版本上。

electron-builder 26 起这条钉成了保险而非必需：`@electron/rebuild@4.x` 自己依赖 `node-gyp@^12.2.0`，
顶层随之被提升为 12.x；把 electron-builder 降回 25.x（那时它带的是 `node-gyp@^9`，就是本文这次踩坑）
或让别的工具成为 node-gyp 的唯一请求方时，旧 node-gyp 会重新占据顶层，所以保留这行更稳妥。
将来 npm 修掉 `gypfile` 透传的问题后可以删掉。

## 验证

```bash
npm install                                              # 应无 gyp 报错
node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('create table t(a)');console.log('ok',db.prepare('select sqlite_version() v').get())"
npm run typecheck && npm test
```

机器上必须有 VS Build Tools（含 “使用 C++ 的桌面开发” 工作负载）：npm 认为该包需要编译，
没有 MSVC 的机器仍会失败，那种环境只能先 `npm install --ignore-scripts`，再手动补
`electron`、`esbuild`、`vue-demi` 这几个带脚本的包。

## 定位手法

把 npm 真正传给脚本执行器的对象打出来最快：用 `NODE_OPTIONS="--require <hook>"` 挂一个探针，
在 `Module._load` 里包住 `@npmcli/run-script`（**注意它的导出是函数本身，不是 `runScript` 属性**），
打印 `pkg.gypfile` 与 `pkg.scripts` 即可看到注入后的 manifest。
另外 `npm i --loglevel=silly` 里 `npm info run better-sqlite3@13.0.3 install ... node-gyp rebuild`
这行就是注入点，正常安装不该有它。

顺带记一笔：`package.json` 里那个 `allowScripts` 字段在本机 npm 11.12.1 上没有任何实现
（`lib/` 与 `node_modules/@npmcli/` 里搜不到引用），它拦不住这次注入的脚本。
