/**
 * 账号：登录状态、授权中的过程态，以及退出登录。
 *
 * 唯一的机密（access_token）在 Windows 凭据管理器里，从不进渲染层 —— 这里存的只是
 * 显示资料（昵称 / 头像 / 登录名）与「哪几家已登录」的判定结果，见 workbench/auth.ts。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { accountLabel } from '@shared/auth'
import type { AuthProvider, AuthStatus } from '@/types'
import { notifyError, notifySuccess } from '@/notify'

export const useAuthStore = defineStore('auth', () => {
  /**
   * 账号状态。null 表示还没问过后端 —— 账号弹窗与设置界面据此显示加载态。
   * 资料来源见 workbench/auth.ts：是否已登录以凭据管理器为准，这里存的只是显示资料。
   */
  const status = ref<AuthStatus | null>(null)
  /** 正在等待授权的那一家；null 表示空闲 */
  const pending = ref<AuthProvider | null>(null)
  /** 等待期间的授权页地址（浏览器没被自动打开时，界面要把它露出来给用户点） */
  const url = ref('')
  /** 浏览器是不是自动打开了；false 时界面把 url 显眼地摆出来 */
  const opened = ref(true)

  /**
   * 问一次后端：能不能登录、已登录哪一家。
   *
   * 只读凭据管理器、不联网，所以启动时直接调也没问题；
   * 头像那张图不在这一步拉（那是网络请求），留给账号弹窗打开时按需刷新。
   */
  async function refreshAuth(): Promise<void> {
    try {
      status.value = await window.workbench.authStatus()
    } catch {
      // 拿不到就当没登录：账号是可选功能，不该把首屏拖下水
      status.value = null
    }
  }

  /** 走一次登录。成功后账号资料由适配层落盘，这里只负责界面状态与提示 */
  async function login(provider: AuthProvider): Promise<void> {
    // 一次只允许一个登录流程：重复点击会让两个轮询循环对着同一个回环监听说话
    if (pending.value) return

    pending.value = provider
    url.value = ''
    opened.value = true

    try {
      // 等待期间的授权页地址与「浏览器是否自动打开了」，界面要据此决定怎么提示
      const outcome = await window.workbench.authLogin(provider, (authUrl, browserOpened) => {
        url.value = authUrl
        opened.value = browserOpened
      })

      if (outcome.status === 'ok') {
        notifySuccess(`已登录 ${accountLabel(outcome.account)}`)
      } else if (outcome.status === 'failed') {
        // 只剩「失败」要报：cancelled 是用户自己关掉或点了取消，弹红字只会惹人烦
        notifyError(outcome.error)
      }
    } finally {
      pending.value = null
      url.value = ''
      await refreshAuth()
    }
  }

  /**
   * 手动兜底：把粘贴回来的回调地址交上去。
   * 返回是否成功；失败原因内联显示在输入框旁边，不弹全局提示 ——
   * 成功那条由 login() 统一报一次，这里再报就重复了。
   */
  async function submitLoginCallback(url: string): Promise<boolean> {
    const result = await window.workbench.authLoginSubmit(url)
    if (!result.ok) return false

    await refreshAuth()
    return true
  }

  /** 放弃进行中的登录（点取消、关弹窗） */
  async function cancelLogin(): Promise<void> {
    if (!pending.value) return
    await window.workbench.authLoginCancel()
  }

  /** 退出登录；是否先确认由调用方决定 */
  async function logout(): Promise<boolean> {
    const provider = status.value?.account?.provider
    if (!provider) return false

    const result = await window.workbench.authLogout(provider)
    if (!result.ok) {
      notifyError(result.error ?? '退出登录失败')
      return false
    }

    await refreshAuth()
    return true
  }

  /** 重新拉一次账号资料（联网）：头像在平台上换过之后，打开账号弹窗就能看到 */
  async function refreshAccount(): Promise<void> {
    const provider = status.value?.account?.provider
    if (!provider) return

    // 刷新失败就保留旧资料：头像没了比头像旧了更让人困惑
    const result = await window.workbench.authRefreshAccount(provider)
    if (!result.ok) return
    await refreshAuth()
  }

  return {
    status,
    pending,
    url,
    opened,
    refreshAuth,
    login,
    submitLoginCallback,
    cancelLogin,
    logout,
    refreshAccount
  }
})
