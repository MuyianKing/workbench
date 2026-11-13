import type { WorkLogDeviceRef, WorkLogEntry, WorkLogStatus, WorkLogSyncOutcome } from '@workbench/work-log'
import type { Result } from '@/types'
import { fail } from '@workbench/core'
import { toggleWorkLogStatus } from '@workbench/work-log'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { workLogLocalDevice } from '@/workbench/work-log'

/**
 * 工作日志的数据层：整份条目、本机与别的设备的身份、读盘与写盘。
 *
 * **为什么是 store**：这条数据跨页共享 —— 「工作」页会写，「首页·今日完成」只读，
 * 两边必须看到同一份（原先各拉一次、各自持有 entries，写完还要等下一次进页面才对齐）。
 * 页面只留各自的交互状态：工作页的范围 / 排序 / 分页 / 正在看哪台设备，
 * 首页那张卡片只算今天完成了哪几条。
 *
 * 落盘仍在适配层（[workbench/work-log.ts](../workbench/work-log.ts)）：那条路
 * 「读一次文件 → 内存里增删改 → 整份写回」，这里只是把结果接住并分发给两个消费方。
 */
export const useWorkLogStore = defineStore('workLog', () => {
  const entries = ref<WorkLogEntry[]>([])
  const loading = ref(false)
  /** 读盘失败与「一条都还没写过」是两回事，不能都显示成空列表 */
  const error = ref('')
  /** 本机设备标识；拿不到时 id / name 都是空串，页面据此不按设备筛 */
  const localDevice = ref<{ id: string, name: string }>({ id: '', name: '' })
  /** 同步拉回来的设备身份（含名字）：切换器里别的机器靠它显示 */
  const remoteDevices = ref<WorkLogDeviceRef[]>([])

  /** 已经读过一次：两个页面都会在挂载时调 load，别各读一遍 */
  let loadedOnce = false

  /**
   * 本机设备标识只取一次（适配层与 Token 面板共用同一份缓存）。
   * 拿不到时 id 为空 —— 页面退化成「不按设备筛」，不把整份日志藏起来。
   */
  async function loadDevice(): Promise<void> {
    localDevice.value = await workLogLocalDevice()
  }

  /** 读整份日志；已经读过就直接用内存里那份（跨页共享的意义就在这里） */
  async function load(): Promise<void> {
    if (loadedOnce)
      return

    loading.value = true
    error.value = ''
    try {
      const result = await window.workbench.listWorkLogs()
      if (result.ok && result.data) {
        entries.value = result.data
        loadedOnce = true
      }
      else {
        error.value = result.error ?? '读取工作日志失败'
      }
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : '读取工作日志失败'
    }
    finally {
      loading.value = false
    }
  }

  /** 重试：把「读过」的标记清掉再读一次（失败态的那颗按钮用） */
  async function refresh(): Promise<void> {
    loadedOnce = false
    await load()
  }

  /** 把一条落盘后的记录并进内存（新建追加、已有替换），不重读文件 */
  function applyEntry(entry: WorkLogEntry): void {
    const index = entries.value.findIndex(item => item.id === entry.id)
    if (index === -1)
      entries.value = [...entries.value, entry]
    else entries.value.splice(index, 1, entry)
  }

  /** 批量并入（「从提交生成」可能新建几条、也可能追加到已有记录） */
  function applyEntries(changed: readonly WorkLogEntry[]): void {
    for (const entry of changed)
      applyEntry(entry)
  }

  /**
   * 点记录 = 在「已完成 / 待办」之间切一下。
   *
   * 交互要立刻有反馈，所以先把内存里那条改掉、再落盘；写失败就把它改回去。
   * 提示留在调用方（store 不碰 Element Plus，见 ipc-and-state.md）。
   */
  async function toggleStatus(entry: WorkLogEntry): Promise<Result<WorkLogEntry>> {
    const index = entries.value.findIndex(item => item.id === entry.id)
    if (index === -1)
      return fail('找不到这条工作记录')

    const before = entry.status
    const next: WorkLogStatus = toggleWorkLogStatus(before)
    entries.value.splice(index, 1, { ...entry, status: next })

    const result = await window.workbench.updateWorkLog(entry.id, { status: next })
    if (!result.ok || !result.data) {
      entries.value.splice(index, 1, entry)
      return fail(result.error ?? '修改状态失败')
    }
    entries.value.splice(index, 1, result.data)
    return result
  }

  async function remove(id: string): Promise<Result<null>> {
    const result = await window.workbench.removeWorkLog(id)
    if (result.ok)
      entries.value = entries.value.filter(item => item.id !== id)
    return result
  }

  /**
   * 同步一轮：拉别的设备的分片 → 合并写回本机 → 推本机分片。
   *
   * 节奏与成败提示留给页面（进页面 / 切回来 / 每次增删改之后各跑一轮）；
   * 这里只把合并后的条目与设备清单接住。
   */
  async function sync(): Promise<Result<WorkLogSyncOutcome>> {
    const result = await window.workbench.syncWorkLogs()
    const data = result.ok ? result.data : undefined
    if (!data || !data.enabled)
      return result

    // 设备名跟着分片走：别的机器在设置里改了名，下一轮这里就显示新的
    remoteDevices.value = data.devices ?? []
    const self = remoteDevices.value.find(item => item.id === data.device)
    if (self && !localDevice.value.name)
      localDevice.value = { id: self.id, name: self.name }
    // 远端条目并进来了：直接换成本机文件合并后的那份，不再多读一次盘
    if (data.changed)
      entries.value = data.entries

    return result
  }

  return {
    entries,
    loading,
    error,
    localDevice,
    remoteDevices,
    loadDevice,
    load,
    refresh,
    applyEntry,
    applyEntries,
    toggleStatus,
    remove,
    sync,
  }
})
