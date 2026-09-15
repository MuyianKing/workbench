/**
 * 界面上「说一句话」与「问一句」的唯一出口。
 *
 * 存在的理由是可测性：业务动作（启动 / 打包 / 迁移数据目录…）要给出成功与失败反馈，
 * 而它们住在 store 里 —— 让 store 直接 import element-plus，等于任何一条 action 的单测
 * 都得先跑起一个组件库的运行环境。收成这一层薄封装之后，store 只依赖下面这几个函数，
 * 测试用 `vi.mock('@/notify')` 就能把「说了什么」记下来断言，组件那边照旧拿到 ElMessage。
 *
 * 组件里直接调 ElMessage 也仍然可以（它们本来就在组件树里）；这一层管的是**非组件代码**
 * 怎么说话。
 */
import { ElMessage, ElMessageBox } from 'element-plus'

export function notifySuccess(message: string): void {
  ElMessage.success(message)
}

export function notifyWarning(message: string): void {
  ElMessage.warning(message)
}

export function notifyInfo(message: string): void {
  ElMessage.info(message)
}

export function notifyError(message: string): void {
  ElMessage.error(message)
}

/**
 * 问一句「要不要这么做」，用户点了确认返回 true。
 *
 * `ElMessageBox.confirm` 取消时是 reject —— 这里收敛成布尔值，调用方不必每个地方
 * 都包一层 try/catch（取消是**正常路径**，不是异常）。
 */
export async function confirmAction(
  message: string,
  title: string,
  options: { confirmButtonText?: string; cancelButtonText?: string; type?: 'warning' | 'info' | 'error' | 'success' } = {}
): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: options.confirmButtonText ?? '确定',
      cancelButtonText: options.cancelButtonText ?? '取消',
      type: options.type ?? 'warning'
    })
    return true
  } catch {
    return false
  }
}
