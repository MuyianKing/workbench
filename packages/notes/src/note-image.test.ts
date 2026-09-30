import { describe, expect, it } from 'vitest'
import {
  buildImageAssets,
  countImageReferences,
  imageDeviceKey,
  imageExtension,
  imageFileName,
  imageMarkdown,
  imageNotebookKey,
  imageRawUrl,
  imageRepoPath,
  imageScopeDir,
  parseImageRemote,
  sanitizeImageDir,
  sanitizeImageRepo,
  sortImageAssets,
  totalImageBytes,
  unusedImages
} from './note-image'

/** 2026-09-16 10:45:12 本地时间 */
const NOW = new Date(2026, 8, 16, 10, 45, 12).getTime()

describe('仓库地址与目录的收敛', () => {
  it('空、带空白、以 - 开头的地址都当没填', () => {
    expect(sanitizeImageRepo('  git@github.com:me/pics.git ')).toBe('git@github.com:me/pics.git')
    expect(sanitizeImageRepo('')).toBe('')
    expect(sanitizeImageRepo('https://github.com/me/pics')).toBe('https://github.com/me/pics')
    // 以 `-` 开头会被 git 当成选项，填错了只会得到一条看不懂的报错
    expect(sanitizeImageRepo('--upload-pack=evil')).toBe('')
    expect(sanitizeImageRepo('https://github.com/me/my pics')).toBe('')
    expect(sanitizeImageRepo(undefined)).toBe('')
  })

  it('目录去掉多余的斜杠与 . / .. 段', () => {
    expect(sanitizeImageDir(' images ')).toBe('images')
    expect(sanitizeImageDir('/images/notes/')).toBe('images/notes')
    expect(sanitizeImageDir('images//notes')).toBe('images/notes')
    expect(sanitizeImageDir('images\\notes')).toBe('images/notes')
    expect(sanitizeImageDir('../外面')).toBe('外面')
    expect(sanitizeImageDir('  ')).toBe('')
  })
})

describe('文件名', () => {
  it('时间戳在前、随机段在后，后缀按 mime 认', () => {
    expect(imageFileName({ mime: 'image/png', now: NOW, token: 'ab12cd34ef' })).toBe(
      '20260916-104512-ab12cd34.png'
    )
    expect(imageFileName({ mime: 'image/jpeg', now: NOW, token: 'x' })).toBe('20260916-104512-x.jpg')
    // 认不出来的 mime 按 png，总得有个后缀
    expect(imageExtension('application/octet-stream')).toBe('png')
    expect(imageExtension('IMAGE/WEBP')).toBe('webp')
  })

  it('随机段里的杂字符剔掉；不传就现取一个', () => {
    expect(imageFileName({ mime: 'image/png', now: NOW, token: 'a-b/c d' })).toBe(
      '20260916-104512-abcd.png'
    )
    expect(imageFileName({ mime: 'image/png', now: NOW, token: '///' })).toBe('20260916-104512-0.png')
    expect(imageFileName({ mime: 'image/png', now: NOW })).toMatch(/^20260916-104512-[0-9a-f]{8}\.png$/)
  })

  it('仓库里的相对路径就是目录 + 文件名', () => {
    expect(imageRepoPath('images', 'a.png')).toBe('images/a.png')
    expect(imageRepoPath('', 'a.png')).toBe('a.png')
    expect(imageRepoPath('/ 图片/ ', 'a.png')).toBe('图片/a.png')
    // 可以写多级：上传前会逐级建目录
    expect(imageRepoPath('notes/images', 'a.png')).toBe('notes/images/a.png')
  })

  it('目录进了仓库路径，也进了访问地址', () => {
    const path = imageRepoPath('images', '20260916-104512-ab12cd34.png')
    expect(
      imageRawUrl({ repo: 'git@github.com:me/pics.git', branch: 'main', path })
    ).toBe('https://raw.githubusercontent.com/me/pics/main/images/20260916-104512-ab12cd34.png')

    const nested = imageRepoPath('notes/images', '20260916-104512-ab12cd34.png')
    expect(
      imageRawUrl({ repo: 'git@github.com:me/pics.git', branch: 'main', path: nested })
    ).toBe('https://raw.githubusercontent.com/me/pics/main/notes/images/20260916-104512-ab12cd34.png')
  })
})

describe('这台机器上这个笔记本那一层', () => {
  const DEVICE = '6f1e2d3c-4b5a-6789-0abc-def012345678'

  it('设备段就是设备标识本身；拿不到标识时给空串', () => {
    expect(imageDeviceKey(DEVICE)).toBe(DEVICE)
    // 大小写与非法字符都收敛（它要当一段目录名用）
    expect(imageDeviceKey(' My PC ')).toBe('my pc')
    expect(imageDeviceKey('')).toBe('')
    expect(imageDeviceKey(undefined as unknown as string)).toBe('')
  })

  it('笔记本段是「目录名-路径摘要」：同名的两个目录不会落进同一层', () => {
    const a = imageNotebookKey('D:\\a\\笔记')
    const b = imageNotebookKey('E:\\b\\笔记')
    expect(a).toMatch(/^笔记-[0-9a-f]{8}$/)
    expect(a).not.toBe(b)

    // 同一个目录换个写法（大小写、分隔符、末尾多一条斜杠）还是同一层
    expect(imageNotebookKey('e:/notes')).toBe(imageNotebookKey('E:\\Notes'))
    expect(imageNotebookKey('E:\\Notes\\')).toBe(imageNotebookKey('E:\\Notes'))
    expect(imageNotebookKey('  ')).toBe('')
  })

  it('盘根（没有目录名）也给得出一段能当目录名用的字', () => {
    expect(imageNotebookKey('E:\\')).toMatch(/^e-[0-9a-f]{8}$/)
  })

  it('两层拼起来就是素材目录；缺哪一层都给空串', () => {
    const notebook = imageNotebookKey('E:\\Notes')
    expect(imageScopeDir('images', DEVICE, 'E:\\Notes')).toBe(`images/${DEVICE}/${notebook}`)
    // 目录传空串 = 只有设备与笔记本两层（应用里固定传 NOTE_IMAGE_DIR，空串只是这个函数的边界）
    expect(imageScopeDir('', DEVICE, 'E:\\Notes')).toBe(`${DEVICE}/${notebook}`)
    // 缺设备标识 / 没打开笔记本：空串，调用方据此报错而不是退回上一层
    expect(imageScopeDir('images', '', 'E:\\Notes')).toBe('')
    expect(imageScopeDir('images', DEVICE, '')).toBe('')
  })

  it('上传落点就是这三层，正文里插的地址照着它拼', () => {
    const notebook = imageNotebookKey('E:\\muyian\\Notes')
    const scope = imageScopeDir('images', DEVICE, 'E:\\muyian\\Notes')
    expect(notebook).toMatch(/^notes-[0-9a-f]{8}$/)

    const path = imageRepoPath(scope, '20260916-104512-ab12cd34.png')
    expect(path).toBe(`images/${DEVICE}/${notebook}/20260916-104512-ab12cd34.png`)
    expect(imageRawUrl({ repo: 'git@github.com:me/pics.git', branch: 'main', path })).toBe(
      `https://raw.githubusercontent.com/me/pics/main/images/${DEVICE}/${notebook}/20260916-104512-ab12cd34.png`
    )
  })
})

describe('拆仓库地址', () => {
  it('认 https 与 scp 两种写法', () => {
    expect(parseImageRemote('https://github.com/muyian/pics.git')).toEqual({
      host: 'github.com',
      owner: 'muyian',
      name: 'pics'
    })
    expect(parseImageRemote('git@github.com:muyian/pics.git')).toEqual({
      host: 'github.com',
      owner: 'muyian',
      name: 'pics'
    })
    expect(parseImageRemote('ssh://git@gitee.com/muyian/pics.git')).toEqual({
      host: 'gitee.com',
      owner: 'muyian',
      name: 'pics'
    })
    // 自建服务器上的分组路径：owner 可以是多段
    expect(parseImageRemote('git@git.example.com:team/docs/pics.git')).toEqual({
      host: 'git.example.com',
      owner: 'team/docs',
      name: 'pics'
    })
  })

  it('拆不出来的一律返回 null，而不是编一个地址出来', () => {
    expect(parseImageRemote('')).toBeNull()
    expect(parseImageRemote('不是地址')).toBeNull()
    expect(parseImageRemote('https://github.com/only-owner')).toBeNull()
    expect(parseImageRemote('https://github.com/')).toBeNull()
  })
})

describe('访问地址', () => {
  it('GitHub / Gitee / GitLab 各按各的规则拼', () => {
    expect(
      imageRawUrl({ repo: 'git@github.com:muyian/pics.git', branch: 'main', path: 'images/a.png' })
    ).toBe('https://raw.githubusercontent.com/muyian/pics/main/images/a.png')

    expect(
      imageRawUrl({
        repo: 'https://gitee.com/muyian/pics.git',
        branch: 'master',
        path: 'images/a.png'
      })
    ).toBe('https://gitee.com/muyian/pics/raw/master/images/a.png')

    expect(
      imageRawUrl({
        repo: 'https://gitlab.com/muyian/pics.git',
        branch: 'main',
        path: 'images/a.png'
      })
    ).toBe('https://gitlab.com/muyian/pics/-/raw/main/images/a.png')
  })

  it('三家以外的仓库给空串，不拼一个点不开的地址', () => {
    expect(
      imageRawUrl({ repo: 'git@git.example.com:team/pics.git', branch: 'main', path: 'images/a.png' })
    ).toBe('')

    // 本地路径当远端的测试仓库，一样认不出托管方
    expect(
      imageRawUrl({ repo: 'C:/tmp/images.git', branch: 'main', path: 'images/a.png' })
    ).toBe('')
  })

  it('目录名是中文、地址里有空格时都要编码', () => {
    expect(
      imageRawUrl({
        repo: 'git@github.com:me/pics.git',
        branch: 'main',
        path: '我的图片/a b.png'
      })
    ).toBe('https://raw.githubusercontent.com/me/pics/main/%E6%88%91%E7%9A%84%E5%9B%BE%E7%89%87/a%20b.png')
  })

  it('没有文件名、没有分支时给空串，不拼一个点不开的地址', () => {
    expect(imageRawUrl({ repo: 'git@github.com:me/pics.git', branch: 'main', path: '' })).toBe('')
    expect(imageRawUrl({ repo: 'git@github.com:me/pics.git', branch: '  ', path: 'a.png' })).toBe('')
  })

  it('markdown 就是一行图片语法', () => {
    expect(imageMarkdown('https://x/a.png')).toBe('![图片](https://x/a.png)')
    expect(imageMarkdown('https://x/a.png', '截图')).toBe('![截图](https://x/a.png)')
  })
})

describe('素材管理：谁还在用', () => {
  const images = [
    { path: 'images/20260916-104512-ab12cd34.png', name: '20260916-104512-ab12cd34.png', size: 2048 },
    { path: 'images/20260915-090000-ffffffff.png', name: '20260915-090000-ffffffff.png', size: 1024 },
    { path: 'images/20260101-000000-00000000.jpg', name: '20260101-000000-00000000.jpg', size: 4096 }
  ]

  it('按文件名数出现次数，写成什么地址都认', () => {
    const texts = [
      '看这张 ![图片](https://raw.githubusercontent.com/me/pics/main/images/20260916-104512-ab12cd34.png)',
      '同一个文件又贴了一次：![](https://cdn.example.com/images/20260916-104512-ab12cd34.png?raw=true)',
      '本地相对路径也算：![](images/20260915-090000-ffffffff.png)'
    ]

    expect(countImageReferences(texts, '20260916-104512-ab12cd34.png')).toBe(2)
    expect(countImageReferences(texts, '20260915-090000-ffffffff.png')).toBe(1)
    // 一次都没提到
    expect(countImageReferences(texts, '20260101-000000-00000000.jpg')).toBe(0)
    // 名字对不上（多一个字母）不算
    expect(countImageReferences(texts, '20260916-104512-ab12cd34.png.bak')).toBe(0)
  })

  it('大小写不敏感，且同一段里出现几次算几次', () => {
    const texts = ['![](A.PNG) 和 ![](a.png)', '![](a.png)']
    expect(countImageReferences(texts, 'a.png')).toBe(3)
    expect(countImageReferences(texts, '')).toBe(0)
  })

  it('清单带上引用次数与访问地址，排序把没引用的放前面', () => {
    const assets = buildImageAssets({
      images,
      texts: ['![](https://raw.githubusercontent.com/me/pics/main/images/20260915-090000-ffffffff.png)'],
      repo: 'git@github.com:me/pics.git',
      branch: 'main'
    })

    const sorted = sortImageAssets(assets)
    expect(sorted.map((asset) => asset.name)).toEqual([
      '20260916-104512-ab12cd34.png',
      '20260101-000000-00000000.jpg',
      '20260915-090000-ffffffff.png'
    ])
    expect(sorted[0].refs).toBe(0)
    expect(sorted[1].refs).toBe(0)
    expect(sorted[2].refs).toBe(1)
    expect(sorted[2].url).toBe(
      'https://raw.githubusercontent.com/me/pics/main/images/20260915-090000-ffffffff.png'
    )
    expect(sorted[0].url).toBe(
      'https://raw.githubusercontent.com/me/pics/main/images/20260916-104512-ab12cd34.png'
    )
    expect(
      unusedImages(sorted).map((asset) => asset.name)
    ).toEqual(['20260916-104512-ab12cd34.png', '20260101-000000-00000000.jpg'])
    expect(totalImageBytes(sorted)).toBe(2048 + 1024 + 4096)
  })

  it('推不出地址的仓库给空串，界面据此不显示缩略图', () => {
    const [asset] = buildImageAssets({
      images: [images[0]],
      texts: [],
      repo: 'https://git.example.com/me/pics.git',
      branch: 'main'
    })
    expect(asset.url).toBe('')
  })
})
