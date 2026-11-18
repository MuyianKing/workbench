/**
 * `window.workbench` 上的一组通道：笔记（用户自己挑的一个文件夹）。
 * 实现见 `workbench/note.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type { NoteRead } from '@workbench/notes'
import type {
  NoteChange,
  NoteCreateInput,
  NoteImageDeleted,
  NoteImageDeleteInput,
  NoteImageList,
  NoteImageListInput,
  NoteImageMigrated,
  NoteImageUploaded,
  NoteImageUploadInput,
  NoteNode,
  NoteRepoState,
  NoteSyncInput,
  NoteSyncSummary,
  NoteTextScan,
} from '../index'

export interface NotesChannel {
  /**
   * 笔记：**用户自己挑的一个文件夹**里的目录树（文件夹 + markdown 文件）。
   *
   * 笔记不再有数据文件：它就是这个目录里的 `.md` 文件（见 @workbench/notes 的文件头），
   * 应用只记住「选的是哪个目录」（设置里的 `noteDir`）。所以每条通道都要带上 root ——
   * 用户换了文件夹，同一份树就换了来源，把路径存在适配层里迟早会与设置不一致。
   *
   * 结构变化（新建 / 改名 / 删除 / 拖动）一律回整棵新树 **加上被改动节点的新路径**：
   * 树是这个文件夹现在的样子，而「打开的那一篇挪到哪去了」只有执行改动的那一侧知道。
   * 回来的是 `Result`：目录被移走、被拔掉的网络盘都要与「里面什么都没有」分得开。
   */
  listNotes: (root: string) => Promise<Result<NoteNode[]>>

  /** 读一篇的正文与它此刻的 mtime；文件在应用外面被改成读不出来的内容时在这里报错 */
  readNote: (root: string, rel: string) => Promise<Result<NoteRead>>

  /**
   * 保存正文（编辑器防抖后落盘）。
   *
   * `expectedMtimeMs` 是这份正文基于磁盘上哪个版本改的（打开 / 上次落盘时记下的 mtime）：
   * 传了就核一遍，文件被别处改过 / 被删掉时拒绝写；回来的是写完之后文件自己的 mtime。
   */
  writeNote: (root: string, rel: string, content: string, expectedMtimeMs?: number) => Promise<Result<number>>

  /** 新建一个文件夹或笔记；名字撞上同层的由调用方先往后编号 */
  createNote: (root: string, input: NoteCreateInput) => Promise<Result<NoteChange>>

  /** 改名（名字不带后缀）；回来的是新树 + 改完之后的路径 */
  renameNote: (root: string, rel: string, name: string) => Promise<Result<NoteChange>>

  /** 删除；文件夹会连整棵子树一起删掉 */
  removeNote: (root: string, rel: string) => Promise<Result<NoteChange>>

  /** 把一篇移进某个文件夹（拖动）；targetDir 为空串表示移到笔记根 */
  moveNote: (root: string, rel: string, targetDir: string) => Promise<Result<NoteChange>>

  /**
   * 笔记同步：把**当前这个笔记文件夹**与它自己的 `origin` 对齐（提交 → pull --rebase → 推送）。
   *
   * 远端不在设置里 —— 同步到哪儿就是这个文件夹自己连着的那个仓库。所以这里既不 `git init`
   * 也不接远端：不是仓库、或者没有 origin，都按失败如实报回去（见 @workbench/notes 的 NoteRepoState）。
   * 与用量 / 图片那两处同步的区别是它没有克隆目录：跑 git 的地方就是用户自己的文件夹。
   * 撞上冲突**不替用户挑边**：中止 rebase、把本地那笔提交留着，把冲突的文件名带回来让用户手工处理。
   */
  syncNotes: (input: NoteSyncInput) => Promise<Result<NoteSyncSummary>>

  /**
   * 笔记仓库**只拉不推**：进笔记页 / 窗口聚焦时后台对齐远端用（远端有新东西落到本地工作树）。
   * 不提交、不推送本机的改动（`--autostash` 保护未提交现场）—— 那是 syncNotes 的事，
   * 只放在停笔 / 切页那几处，避免每次进页面就推一次。
   */
  pullNotes: (dir: string) => Promise<Result<{ branch: string, received: boolean }>>

  /**
   * 探测一个笔记文件夹的 git 状态：有没有仓库、origin 是什么。
   *
   * 只读、不落盘：它在界面上决定「给不给同步入口」与「同步到哪儿」两句提示，
   * 而这两件事随时会被用户在终端里改掉（`git init` / `git remote add`），存进设置就又有了第二份真源。
   * 不是仓库**不是错误** —— 没仓库的笔记就是本机的笔记，探回来 `isRepo: false` 照常返回。
   */
  noteRepoState: (dir: string) => Promise<Result<NoteRepoState>>

  /**
   * 上传一张图片（笔记里粘贴的图片走这条路）：推到设置的图片仓库，回来的是**可直接用的访问地址**。
   *
   * 与其它笔记通道一样，配置由调用方带进来（仓库地址与目录都在设置里），
   * 另外还要带上**当前笔记本**（`root`）与它连着的 `origin`：有 origin 就按 origin 分层、
   * 跨设备共享（落点 `<目录>/<origin-key>/<文件名>`），没有才退回 `<目录>/<本机设备>/<笔记本>/<文件名>`。
   * 两层都由适配层现算（见 @workbench/notes 的 imageOriginScopeDir / imageScopeDir），
   * 缺该有的那一层就如实失败。推不出访问地址时（仓库不在 GitHub / Gitee / GitLab 上）不是失败：
   * `url` 是空串，由界面如实说明 —— 图片此时已经进了仓库，只是应用拼不出访问它的地址。
   */
  uploadNoteImage: (input: NoteImageUploadInput) => Promise<Result<NoteImageUploaded>>

  /**
   * 素材管理：**当前这个笔记本**传过哪些图（顺手把本地克隆拉到最新，会走一次网络）。
   *
   * 有 origin 的笔记本列共享层（所有设备同一层）、没有的列本机层；`scope: 'legacy'` 额外列
   * 旧的设备 + 本机路径层给面板做并集（迁移前的老图在那里）。清单只回图片文件 ——
   * 「谁被引用了多少次」是把笔记正文读出来（见 `scanNoteTexts`）后按文件名数，留在渲染层。
   */
  listNoteImages: (input: NoteImageListInput) => Promise<Result<NoteImageList>>

  /**
   * 素材管理：批量删掉**这个笔记本（并集里）**的图片，**一次提交、一次推送**。
   *
   * `paths` 是列表回来的仓库内相对路径；Rust 逐条校验它落在允许层（共享层 + 旧层）里、
   * 必须是图片、逐段是普通名字 —— 删不到别处的图。已经不在的文件跳过，空删不留空提交。
   */
  deleteNoteImages: (input: NoteImageDeleteInput) => Promise<Result<NoteImageDeleted>>

  /**
   * 把旧层的图片搬到 origin 共享层，并改写笔记本正文里的图片 URL。
   *
   * `renames`（哪些图、旧路径→新路径）与 `replacements`（正文里的前缀替换）由渲染层的纯函数
   * 算好，这里交给 Rust 执行：它在**图片仓库** git mv + 一次提交推送，并在**笔记本文件夹**逐篇
   * 替换正文（带 mtime 校验，读不出来 / 被并发改过的篇跳过并计数）。改过的 `.md` 由上层紧接着
   * 触发一次笔记同步推到笔记本 origin —— 两个仓库各提交一次，做不到原子。
   */
  migrateNoteImages: (input: {
    repo: string
    root: string
    oldDir: string
    newDir: string
    renames: { from: string, to: string, name: string }[]
    replacements: { from: string, to: string }[]
  }) => Promise<Result<NoteImageMigrated>>

  /**
   * 笔记本里所有笔记的正文（素材管理算引用次数用）。
   *
   * 只读盘、只回原始文本：怎么算「引用了一次」是渲染层的纯函数（见 @workbench/notes）。
   * `failed` 是读不出来的篇数 —— 大于 0 时界面必须如实说一句，少读一篇就可能把
   * 一张还在用的图当成没人引用。
   */
  scanNoteTexts: (root: string) => Promise<Result<NoteTextScan>>
}
