/**
 * `window.workbench` 上的一组通道：技能库（笔记仓库的子目录与版本提交）。
 * 实现见 `workbench/skill.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type { SkillCompareFile } from '@workbench/skills'
import type {
  SkillCommit,
  SkillCreateInput,
  SkillEntry,
  SkillFileInfo,
  SkillInstalledScan,
  SkillLibraryState,
  SkillSyncSummary,
} from '../index'

export interface SkillsChannel {
  // ---------- 技能（住在笔记仓库的一个子目录里，见 @workbench/skills） ----------
  /**
   * 列出技能库里的技能：Rust 回 id / 文件数 / SKILL.md 原文，名字与描述由适配层解析。
   * 技能库还不存在（第一次用）时是空数组，不是错误。
   */
  listSkills: (root: string, dir: string) => Promise<Result<SkillEntry[]>>

  /**
   * 技能库与它的仓库：**从选中的技能库目录开始看有没有 `.git`，没有就往上找最近的**。
   *
   * 回的 `repo` / `libraryRel` 就是后面每条技能通道要用的那两个值（`<repo>/<libraryRel>`
   * 才是技能库本身；库自己就是仓库根时 `libraryRel` 是空串）。
   * 目录不在时如实报错 —— 界面据此提示「重新选一个技能文件夹」。
   */
  skillState: (dir: string) => Promise<Result<SkillLibraryState>>

  /**
   * 同步技能库所在的仓库：**先提交技能库那一层**，再拉、再推（见 Rust 侧 `skills::sync`）。
   *
   * 与 `syncNotes` 的区别只在提交范围：那边提交整个笔记本（笔记就是这个文件夹），
   * 这边只提交技能库 —— 技能库可能住在别人的仓库里（往上找到的那个），
   * 一次同步把那个仓库的其他改动一起提交走是不能接受的。
   * 不在仓库里、没连远端都只如实报一句带解决办法的话；推的是整条分支（git 没有「半个分支」）。
   */
  skillSync: (root: string, dir: string) => Promise<Result<SkillSyncSummary>>

  /**
   * 技能库所在的仓库**只拉不推**：进技能页 / 窗口聚焦时后台对齐远端用（见 Rust 侧 `skills::pull`）。
   *
   * 不提交、也不推本机改动 —— 保存时已经各自提交过，推送只在保存之后那次自动同步里做；
   * 未提交的改动由 `--autostash` 挪开再放回来，冲突不替用户挑边。
   */
  pullSkills: (root: string, dir: string) => Promise<Result<{ branch: string, received: boolean }>>

  /** 新建技能：建目录 + 写 SKILL.md 骨架 + 在笔记仓库里提交一次 */
  createSkill: (root: string, dir: string, input: SkillCreateInput) => Promise<Result<null>>

  /**
   * 保存技能里的一个文件；**保存 SKILL.md（清单）时有必经的 version 门槛**
   * （frontmatter 必须带语义化 version），附属文件没有这一关。
   * 内容真的变了才产生一次版本提交，提交信息带版本号（清单）或文件路径（附属文件）。
   */
  saveSkillFile: (
    root: string,
    dir: string,
    id: string,
    rel: string,
    content: string,
  ) => Promise<Result<null>>

  /** 删除技能（整棵目录），并提交这次删除 */
  removeSkill: (root: string, dir: string, id: string) => Promise<Result<null>>

  /** 从本机一个文件夹导入技能（复制进技能库），并提交 */
  importSkill: (root: string, dir: string, source: string, id: string) => Promise<Result<null>>

  /** 某个技能的版本历史（就是它在笔记仓库里的提交记录，新的在前） */
  skillHistory: (root: string, dir: string, id: string, limit?: number) => Promise<Result<SkillCommit[]>>

  /** 把某个技能恢复到指定版本（旧版内容检出并提交一次恢复记录） */
  restoreSkill: (root: string, dir: string, id: string, hash: string) => Promise<Result<null>>

  /**
   * 某一版与现在这一份的逐文件对比（恢复之前先看清差异）：适配层把 Rust 回来的两侧拼成
   * 对比弹窗认的那份清单 —— base = 现在库里的内容、incoming = 那一版的内容，
   * 文件取两侧的**并集**（那一版有、现在删掉的同样是差异）。形状与「项目副本 vs 库」完全一致。
   */
  compareSkillVersion: (
    root: string,
    dir: string,
    id: string,
    hash: string,
  ) => Promise<Result<SkillCompareFile[]>>

  /**
   * 把技能安装到指定项目（复制到 `<项目>/.agents/skills/<id>/`）。
   * 目标已存在且未给 overwrite 时返回失败 —— 界面确认过「要覆盖」再带 overwrite 重调。
   */
  installSkill: (
    root: string,
    dir: string,
    id: string,
    projectDir: string,
    overwrite: boolean,
  ) => Promise<Result<null>>

  /**
   * 库与各项目副本的**全部文本文件**（只读扫描）：详情页据此判定「项目里的副本和库不一样」
   * 并在切文件时弹对比。口径在域包 `@workbench/skills` 的 `compareSkillCopy`
   * （版本更高 / 项目里多出的文件 / 同版本以上内容不同，带单测）；
   * 二进制（content 为 null）读不出文本，不参与比对。
   */
  scanSkillCopies: (
    root: string,
    dir: string,
    id: string,
    projectDirs: string[],
  ) => Promise<Result<SkillInstalledScan>>

  /**
   * 技能目录里的全部文件（相对路径 + 字节数）：一个技能往往不止 SKILL.md，
   * 脚本 / 模板 / 子文档都是技能的一部分。点开头的项不进清单。
   */
  listSkillFiles: (root: string, dir: string, id: string) => Promise<Result<SkillFileInfo[]>>

  /** 读技能里的一个文件（任意文本文件；二进制读不出文本时如实失败） */
  readSkillFile: (root: string, dir: string, id: string, rel: string) => Promise<Result<string>>
}
