/**
 * 渲染层依赖的 `window.workbench` 契约。
 *
 * 从 src/preload/index.d.ts 搬过来：preload 已经随 Electron 一起删除，
 * 而这个全局声明是 78 处调用的类型来源，必须留在渲染层自己的 tsconfig 覆盖范围内。
 * 运行时的实现见 ./index.ts（Tauri invoke 适配层）。
 */
import type { WorkbenchApi } from '@shared/types'

declare global {
  interface Window {
    workbench: WorkbenchApi
  }
}

export {}
