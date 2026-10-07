import type { Result } from '@/types'
/**
 * Pi 技能的适配层（AI 助手页那颗「技能」按钮）：列一个技能根里的技能、往里装、从里卸。
 *
 * 与技能页那套（`workbench/skill.ts`）**不是一回事**：那套管的是「技能库 + 装到项目 + 版本提交」，
 * 这一条只管 AI 助手页那两个 `.agents/skills` 根里的目录（一个技能 = 一个带 SKILL.md 的子目录），
 * 没有 git、没有版本 —— 装进来的东西只落盘，包里的脚本一概不执行。
 *
 * 收敛与判定都在 shared/pi-skills.ts（有单测），这里只把四条通道接上：
 * 形状、错误文案、以及「装好了但没拿回技能名」这种不该发生的情况。
 */
import { fail, ok } from '@workbench/core'
import { guard, invoke } from './bridge'

/** 装完之后的回执：落下去的技能名与文件数（界面拿它拼提示文案） */
export interface PiSkillInstallResult {
  id: string
  files: number
}

/** 列一个技能根里的技能（原始记录：id + 文件数 + SKILL.md 原文） */
export async function piSkillList(root: string): Promise<Result<unknown>> {
  return guard(invoke<unknown>('pi_skill_list', { root: root.trim() }), '读取技能列表失败')
}

/** 装一个本地 zip（同名先报错；确认过再带 `overwrite` 重调） */
export async function piSkillInstallZip(
  root: string,
  zip: string,
  id: string | null,
  overwrite: boolean,
): Promise<Result<PiSkillInstallResult>> {
  const result = await guard(
    invoke<unknown>('pi_skill_install_zip', {
      root: root.trim(),
      zip: zip.trim(),
      id: id ?? null,
      overwrite,
    }),
    '装技能失败',
  )
  return result.ok ? readInstall(result.data) : fail(result.error ?? '装技能失败')
}

/** 装一个本机文件夹（那个文件夹本身就是一个技能：根上要有 SKILL.md） */
export async function piSkillInstallDir(
  root: string,
  source: string,
  id: string | null,
  overwrite: boolean,
): Promise<Result<PiSkillInstallResult>> {
  const result = await guard(
    invoke<unknown>('pi_skill_install_dir', {
      root: root.trim(),
      source: source.trim(),
      id: id ?? null,
      overwrite,
    }),
    '装技能失败',
  )
  return result.ok ? readInstall(result.data) : fail(result.error ?? '装技能失败')
}

/** 从用户粘的地址装（GET 一次、跟随跳转；出口的边界见 shared/types.ts 那一段） */
export async function piSkillInstallUrl(
  root: string,
  url: string,
  id: string | null,
  overwrite: boolean,
): Promise<Result<PiSkillInstallResult>> {
  const result = await guard(
    invoke<unknown>('pi_skill_install_url', {
      root: root.trim(),
      url: url.trim(),
      id: id ?? null,
      overwrite,
    }),
    '装技能失败',
  )
  return result.ok ? readInstall(result.data) : fail(result.error ?? '装技能失败')
}

/** 卸掉一个技能（删掉那个技能目录整棵） */
export async function piSkillRemove(root: string, id: string): Promise<Result<null>> {
  const result = await guard(
    invoke<null>('pi_skill_remove', { root: root.trim(), id: id.trim() }),
    '卸掉技能失败',
  )
  return result.ok ? ok(null) : fail(result.error ?? '卸掉技能失败')
}

/** 安装回执的形状收敛：没有技能名就没法告诉用户装了什么，当失败报出来 */
function readInstall(raw: unknown): Result<PiSkillInstallResult> {
  const data = (raw ?? {}) as { id?: unknown, files?: unknown }
  const id = typeof data.id === 'string' ? data.id : ''
  if (!id)
    return fail('装完了，但没拿回技能名')
  return ok({ id, files: typeof data.files === 'number' ? data.files : 0 })
}
