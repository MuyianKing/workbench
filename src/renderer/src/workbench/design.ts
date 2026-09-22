/**
 * 样式参考库的适配层：把一份设计规范写到用户选的项目里。
 *
 * 生成什么内容、给谁用都在 shared/design-export.ts（纯逻辑，带单测）；
 * 这一层只做两件渲染层不该操心的事：
 *   1. 把项目路径收敛成命令参数（去空白，与笔记那条 `rootArg` 同一条口径）；
 *   2. 把宿主抛出的失败收敛成 `Result`（`guard`，见 bridge.ts）。
 *
 * 路径由调用方带进来（项目卡上的 `Project.path`），这里不缓存也不查项目列表 ——
 * 项目列表只活在 store 里，Rust 侧不知道它。
 */
import type { DesignWriteOutcome, Result } from '@shared/types'
import { guard, invoke } from './bridge'

/** 把一套设计规范写到项目根目录的 DESIGN.md（同名覆盖） */
export async function writeDesign(
  projectDir: string,
  content: string
): Promise<Result<DesignWriteOutcome>> {
  return guard(
    invoke<DesignWriteOutcome>('design_write', { projectDir: projectDir.trim(), content }),
    '写入 DESIGN.md 失败'
  )
}
