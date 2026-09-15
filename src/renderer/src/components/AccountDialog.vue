<script setup lang="ts">
/**
 * 账号弹窗：登录 / 看当前账号 / 退出登录。
 *
 * **这里没有「填 client_id」那种表单**：OAuth 应用是编译期内置进安装包的
 * （见 src-tauri/oauth.example.json），使用者只需要有一个 GitHub 或 Gitee 账号，
 * 点一下就登录 —— 和 VS Code 是同一套做法。
 *
 * token 全程不进渲染层（它在 Rust 侧落进 Windows 凭据管理器），所以这个弹窗能看到的
 * 只有昵称、头像、登录名。
 *
 * **没有页脚按钮**：右上角那个 × 就是关闭，再放一个「关闭」只是把同一个动作说两遍。
 */
import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Loading, User } from '@element-plus/icons-vue'
import { AUTH_PROVIDERS, AUTH_PROVIDER_HINTS, AUTH_PROVIDER_LABELS, accountLabel } from '@shared/auth'
import { useAuthStore } from '@/stores/auth'
import type { AuthProvider } from '@/types'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const auth = useAuthStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 手动兜底那一栏：默认收起，只有回调没跳回来时用户才需要它 */
const manualOpen = ref(false)
const manualUrl = ref('')
const manualBusy = ref(false)
const manualError = ref('')

const account = computed(() => auth.status?.account ?? null)
const configured = computed(() => auth.status?.configured !== false)

watch(visible, (open) => {
  if (!open) return

  manualOpen.value = false
  manualUrl.value = ''
  manualError.value = ''
  void auth.refreshAuth()
  // 头像在平台上换过之后，打开这个弹窗就能看到；失败时静默保留旧资料
  void auth.refreshAccount()
})

/**
 * 关掉弹窗要顺带把进行中的登录收掉，否则回环监听会一直占着端口到超时。
 * 等待期间禁掉了点遮罩和 Esc 关闭（见模板），就是为了让「关掉 = 主动取消」这件事
 * 只由明确的动作触发 —— 去浏览器授权时顺手点一下界面，不该把正在进行的登录掐掉。
 */
function onClosed(): void {
  void auth.cancelLogin()
}

function start(provider: AuthProvider): void {
  void auth.login(provider)
}

async function submitManual(): Promise<void> {
  const url = manualUrl.value.trim()
  if (!url || manualBusy.value) return

  manualBusy.value = true
  manualError.value = ''
  try {
    const done = await auth.submitLoginCallback(url)
    if (done) {
      manualUrl.value = ''
      manualOpen.value = false
    } else {
      manualError.value = '这段地址里没有可用的授权码，请复制浏览器地址栏里以 /callback 开头的那一整条'
    }
  } finally {
    manualBusy.value = false
  }
}

async function signOut(): Promise<void> {
  const current = account.value
  if (!current) return

  try {
    await ElMessageBox.confirm(
      `退出后 Workbench 会删掉本机保存的 ${AUTH_PROVIDER_LABELS[current.provider]} 凭据，` +
        '同步随之停止，数据只留在这台机器上（设置里的仓库地址不会丢，重新登录即可接着同步）。',
      '退出登录',
      { confirmButtonText: '退出登录', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    // 用户点了取消
    return
  }

  await auth.logout()
}
</script>

<template>
  <el-dialog
    v-model="visible"
    class="account-dialog"
    title="账号"
    width="400"
    align-center
    append-to-body
    :close-on-click-modal="!auth.pending"
    :close-on-press-escape="!auth.pending"
    @closed="onClosed"
  >
    <!-- 用不了：把 Rust 侧给出的具体原因摆在最前面，别让人以为是网络问题。
         只留「原因 + 怎么办」两段，背后那套「凭据随安装包发布」的机制在 README 里说。 -->
    <div v-if="!configured" class="block">
      <p class="block__title">账号登录当前不可用</p>
      <p class="block__text">
        {{ auth.status?.configError || '当前构建未内置 OAuth 凭据。' }}
      </p>
      <p class="block__note">
        自己从源码构建的话，把 <code class="mono">src-tauri/oauth.example.json</code> 复制成
        <code class="mono">oauth.local.json</code>、填齐凭据后重新构建即可（步骤见 README 的
        「启用账号登录」）。凭据是编译期注入的，改完不重新构建不生效。
      </p>
    </div>

    <!-- 等待授权 -->
    <div v-else-if="auth.pending" class="waiting">
      <!-- 转圈用 Element Plus 图标自带的 .is-loading（不必自己写 keyframes） -->
      <span class="waiting__badge"><el-icon class="is-loading"><Loading /></el-icon></span>
      <p class="waiting__title">已打开浏览器，请在那里完成授权</p>
      <p class="waiting__text">
        正在等待 {{ AUTH_PROVIDER_LABELS[auth.pending] }} 授权完成，这里会自动更新。
      </p>

      <!-- 只在浏览器没能自动打开时才把地址露出来：正常情况下它只是一串噪音 -->
      <template v-if="!auth.opened">
        <p class="waiting__warn">浏览器没能自动打开，请手动访问：</p>
        <a class="waiting__link" :href="auth.url" target="_blank" rel="noreferrer">
          {{ auth.url }}
        </a>
      </template>

      <!-- 手动兜底：浏览器没跳回来时，把地址栏那条地址粘进来 -->
      <div v-if="manualOpen" class="manual">
        <p class="manual__hint">
          把浏览器地址栏里以 <code class="mono">/callback</code> 开头的那一整条地址粘到这里。
        </p>
        <div class="manual__row">
          <el-input
            v-model="manualUrl"
            size="small"
            placeholder="http://127.0.0.1:45871/callback?code=…"
            spellcheck="false"
          />
          <el-button size="small" :loading="manualBusy" @click="submitManual">提交</el-button>
        </div>
        <p v-if="manualError" class="manual__error">{{ manualError }}</p>
      </div>

      <div class="waiting__actions">
        <el-button size="small" text @click="manualOpen = !manualOpen">
          {{ manualOpen ? '收起' : '没有自动跳回来？' }}
        </el-button>
        <el-button size="small" @click="auth.cancelLogin()">取消</el-button>
      </div>
    </div>

    <!-- 已登录：一行身份 + 右侧退出，与设置里的「左信息右操作」同一形状 -->
    <div v-else-if="account" class="block">
      <div class="row">
        <div class="row__who">
          <el-avatar :size="40" :src="account.avatar ?? undefined" class="row__avatar">
            <el-icon><User /></el-icon>
          </el-avatar>
          <span class="row__text">
            <span class="row__name">{{ accountLabel(account) }}</span>
            <span class="row__meta">{{ account.login }} · {{ AUTH_PROVIDER_LABELS[account.provider] }}</span>
          </span>
        </div>
        <el-button size="small" @click="signOut">退出登录</el-button>
      </div>

      <p class="block__note block__note--after">
        同步用量与外观时会用这个账号的凭据推送私有仓库，不必再事先在命令行里给 git 配一次凭据。
      </p>
    </div>

    <!-- 未登录 -->
    <div v-else class="block">
      <p class="block__text">用一个已有的账号登录，不需要额外注册：</p>

      <button
        v-for="provider in AUTH_PROVIDERS"
        :key="provider"
        type="button"
        class="provider"
        @click="start(provider)"
      >
        <span class="provider__label">使用 {{ AUTH_PROVIDER_LABELS[provider] }} 登录</span>
        <span class="provider__hint">{{ AUTH_PROVIDER_HINTS[provider] }}</span>
      </button>

      <p class="block__note">
        授权全程在你的浏览器里完成，Workbench 只拿得到昵称与头像；凭据保存在 Windows 凭据管理器里，
        随时可以在系统里删掉。
      </p>
    </div>
  </el-dialog>
</template>

<style scoped>
/* ---------- 通用块 ---------- */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.block__title {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.block__text {
  margin: 0;
  font-size: var(--fs-meta);
  line-height: 1.65;
  color: var(--ink-2);
}

/* 补充说明比正文再低一档，读的时候不会和正文抢注意力 */
.block__note {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
}

.block__note--after {
  margin-top: calc(var(--sp-1) * -1);
}

code.mono {
  font-family: var(--font-mono);
  color: var(--ink-2);
}

/* ---------- 已登录：左身份 / 右操作 ---------- */
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.row__who {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  /* 把「退出登录」推到最右，身份块占满剩下的宽度 */
  flex: 1;
}

.row__avatar {
  flex-shrink: 0;
  background: var(--bg-subtle);
  color: var(--ink-3);
}

.row__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row__name {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__meta {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 等待授权 ---------- */
.waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  text-align: center;
}

.waiting__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: var(--sp-1);
  font-size: 20px;
  color: var(--st-run);
  background: var(--st-run-soft);
  border-radius: var(--r-md);
}


.waiting__title {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.waiting__text {
  margin: 0;
  font-size: var(--fs-meta);
  line-height: 1.65;
  color: var(--ink-2);
}

.waiting__warn {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

/* 授权页地址可能很长，用等宽字并允许折行，别把弹窗撑宽 */
.waiting__link {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--st-run);
  word-break: break-all;
}

.waiting__actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.manual {
  width: 100%;
  margin-top: var(--sp-2);
  padding: var(--sp-3);
  text-align: left;
  background: var(--bg-subtle);
  border-radius: var(--r-md);
}

.manual__hint {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--ink-3);
}

.manual__row {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.manual__error {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--st-fail);
}

/* ---------- 未登录：两个登录入口 ---------- */
.provider {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 10px var(--sp-3);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.provider:hover {
  background: var(--bg-subtle);
  border-color: var(--border-strong);
}

.provider:focus-visible {
  outline: 2px solid var(--st-run);
  outline-offset: 1px;
}

.provider__label {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.provider__hint {
  font-size: var(--fs-micro);
  line-height: 1.55;
  color: var(--ink-3);
}
</style>
