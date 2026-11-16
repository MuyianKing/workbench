/**
 * `window.workbench` 上的一组通道：知识库（raw/ + data/ 两层的独立仓库）。
 * 实现见 `workbench/kb.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  KbRepoState,
  KbScanResult,
  KbSyncSummary,
} from '../index'

export interface KbChannel {
  // ---------- 知识库（仓库里 raw/ + data/ 两层的独立项目，见 @workbench/kb） ----------
  /**
   * 扫描知识库文件夹：回来的是平铺清单（文件夹 + 任意后缀的文件，带修改时间与绝对路径）
   * 与清单文件 `raw/kb.json` 的原文 —— 知识库列表的数据源就是这份清单，解析在渲染层
   * （@workbench/kb 的 parseKbManifest），树与「哪些是原始数据、哪些是条目」的拆分也在那边。
   *
   * 读是只读的；写全是受控动作（见下面那几条）。每条通道都带上 root，与笔记同一套原因：
   * 用户换了文件夹，一切就换了。
   */
  kbScan: (root: string, links: Array<{ name: string, dir: string }>) => Promise<Result<KbScanResult>>

  /**
   * 读 `raw/` 或 `data/` 下的一个文件文本；仓库根下的其他文件 Rust 侧不对外读。
   * `links` 是本机关联（知识库名 → 源头文件夹）：raw 层的文件本机里有就读本机的那份
   * （最新内容），没有才读仓库副本。
   */
  kbRead: (root: string, rel: string, links?: Array<{ name: string, dir: string }>) => Promise<Result<string>>

  /**
   * 重建 `data/_catalog.md` 与 `data/index.json`（索引只由应用生成，格式与既有生成物
   * 一致、换行写成 CRLF）。`generatedAt` 由渲染层按本机时区算（@workbench/kb 的 todayIsoDate）。
   */
  kbIndexBuild: (root: string, generatedAt: string) => Promise<Result<{ count: number }>>

  /**
   * 一批原始文件的内容指纹：逻辑路径 → SHA-256（小写十六进制）。只算调用方挑出来的
   * 那些（**有条目指向的**）；单个文件读不到就不在结果里，调用方回落 mtime。
   * 跨设备判定「已入库 / 有更新」靠它（git 会重写 mtime）。
   */
  kbFingerprints: (root: string, rels: string[]) => Promise<Result<Record<string, string>>>

  /**
   * 删除条目（受控例外）：只删 `data/` 下的 `.md`，生成物 `_catalog.md`、遗留的
   * `data/raw/` 与越界路径由 Rust 拒绝。
   */
  kbEntryDelete: (root: string, rels: string[]) => Promise<Result<{ deleted: number }>>

  /**
   * 源头同步：把本机关联的源头文件夹复制进 `raw/<名字>/`（新增 / 有变化才复制，不删除）。
   * 添加知识库（全量）与清洗前的源头同步（增量）共用。源头文件夹与知识库文件夹
   * 互相套住时由 Rust 拒绝。
   */
  kbSourceSync: (
    root: string,
    name: string,
    dir: string,
  ) => Promise<Result<{ copied: number, scanned: number }>>

  /** 删一个知识库的两层（`raw/<名>/` 与 `data/<名>/`，存在才删）；源头文件夹不动 */
  kbDeleteTree: (root: string, name: string) => Promise<Result<{ raw: boolean, data: boolean }>>

  /**
   * 删一个原始文件：仓库里那份与关联的源头文件夹里那份一起删（源头持续关联着，
   * 只删仓库里那份会在下一次源头同步时回来）。`dir` 传空串 = 这台机器没有关联。
   */
  kbFileDelete: (
    root: string,
    name: string,
    dir: string,
    rels: string[],
  ) => Promise<Result<{ deleted: number }>>

  /**
   * 生成仓库根的 `AGENTS.md`（给进仓库的 AI 描述结构与用法，内容是应用的口径）：
   * 已存在时不覆盖。添加知识库与迁移之后调用。
   */
  kbAgentsDoc: (root: string) => Promise<Result<{ written: boolean }>>

  /** 写清单文件 `raw/kb.json`（内容由渲染层拼好，Rust 挡一层「必须是合法 JSON」） */
  kbConfigWrite: (root: string, content: string) => Promise<Result<{ bytes: number }>>

  /**
   * 旧结构一次性迁移：来源复制进 raw/、kb/ 搬进 data/、source 前缀改写、旧 index/ 删除、
   * 清单落盘。只能迁移一次（`raw/kb.json` 已存在时 Rust 拒绝）。
   */
  kbMigrate: (
    root: string,
    sources: Array<{ name: string, dir: string }>,
    manifest: string,
  ) => Promise<Result<{ copied: number, rewritten: number }>>

  /**
   * 知识库与**它自己连着的那个仓库**对齐一次（提交 → 拉 → 推，提交信息 `kb: <设备名>`）。
   *
   * 清洗前上传原始文件、清洗后推条目、用户手点同步，走的都是它。远端就是 `dir` 自己的
   * `origin`，不由参数指定；仓库没连远端时调用就是一句说清楚原因的失败 ——
   * 界面在那之前根本不显示同步入口。
   */
  kbSync: (dir: string) => Promise<Result<KbSyncSummary>>

  /**
   * 知识库仓库**只拉不推**：打开页面时后台对齐远端用（远端有新东西落到本地工作树，
   * 让列表跟上别的设备）。不提交本机的改动（`--autostash` 保护未提交现场）。
   */
  kbPull: (dir: string) => Promise<Result<{ branch: string, received: boolean }>>

  /** 探测知识库文件夹的 git 状态（只读）：界面拿它决定给不给同步入口、同步到哪儿 */
  kbRepoState: (dir: string) => Promise<Result<KbRepoState>>
}
