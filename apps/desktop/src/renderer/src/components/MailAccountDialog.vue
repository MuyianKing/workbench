<script setup lang="ts">
/**
 * 邮箱账户的管理弹层：地址、授权码与收发服务器，一条链路走完 ——
 * 填地址（163 / 126 自动带出官方服务器，自定义域就自己填）、粘授权码、
 * 「验证并保存」一次做完：验证是 Rust 那边把收发两个服务器各连一遍
 * （mail_verify），保存落两处 —— 连接参数进设置（workbench-data.json）、
 * 授权码进 Windows 凭据管理器（mail_key_save，只写不读回）。
 *
 * 换了地址时旧地址的授权码会被清掉 —— 凭据管理器里不该留着没人认领的条目。
 *
 * 这个弹层是**填内容的那种**（授权码要从邮箱后台抄过来），所以不挡背后 ——
 * 与 AI 服务、添加项目那几个同一条（见 AGENTS.md 第 4 节）。
 */
import { computed, ref, watch } from 'vue'
import {
  mailAccountReady,
  presetForAddress,
  sanitizeMailAccount,
  type MailAccount
} from '@workbench/mail'
import AppDialog from '@/components/AppDialog.vue'
import { clearMailKey, mailKeyState, saveMailKey, verifyMailAccount } from '@/workbench/mail'
import { useSettingsStore } from '@/stores/settings'
import { notifyError, notifySuccess } from '@/notify'

const visible = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const settings = useSettingsStore()

const address = ref('')
const secretDraft = ref('')
const imapHost = ref('')
const imapPort = ref<number | ''>('')
const smtpHost = ref('')
const smtpPort = ref<number | ''>('')

const verifying = ref(false)
/**
 * 服务器字段的摊开没有：163 / 126 的收发服务器跟着地址后缀自动带出（presetForAddress），
 * 常年摆着就是两行用不上的输入框 —— 收进「服务器设置」，认不出的域名才自动摊开
 * （与 AI 服务弹层的高级设置同一套做法）。手动摊开过就不替用户收回去。
 */
const advanced = ref(false)
/** 校验与验证失败的那句话：就地显示在弹层里，不飘 toast */
const formError = ref('')
/** 保存走到一半失败的那句话（toast 会消失，这行留在弹层里） */
const saveError = ref('')
/** 这个地址在凭据管理器里有没有授权码（界面上只显示「已配置 / 未配置」） */
const keyConfigured = ref(false)
/** 服务器字段用户动过没有：没动过就跟着地址后缀的预设走 */
const hostsTouched = ref(false)
/** 打开弹层时那份账户的地址（换地址保存时要把旧授权码清掉） */
const originalAddress = computed(() => settings.settings.mailAccount.address)

/** 每次打开都从已存的配置起手：授权码不回读，只显示「已配置 / 未配置」 */
watch(visible, (open) => {
  if (!open) return
  const saved = settings.settings.mailAccount
  address.value = saved.address
  secretDraft.value = ''
  imapHost.value = saved.imapHost
  imapPort.value = saved.imapPort || ''
  smtpHost.value = saved.smtpHost
  smtpPort.value = saved.smtpPort || ''
  hostsTouched.value = false
  formError.value = ''
  saveError.value = ''
  verifying.value = false
  // 之前存的就是个认不出后缀的地址：服务器是用户自己填的，摊开着让他看到现状
  advanced.value = saved.address.includes('@') && !presetForAddress(saved.address)
  void refreshKeyState()
})

async function refreshKeyState(): Promise<void> {
  keyConfigured.value = false
  if (!address.value.includes('@')) return
  const result = await mailKeyState(address.value)
  keyConfigured.value = result.ok && result.data === true
}

/**
 * 地址变了：认得出后缀且服务器没被手动改过，就带出官方预设 ——
 * 用户自己填过服务器（自定义域邮箱）就不动它。
 */
watch(address, () => {
  formError.value = ''
  void refreshKeyState()
  const preset = presetForAddress(address.value)
  // 认不出的域名（且像是个地址）：服务器得自己填，自动摊开；163 / 126 静静带出预设
  if (address.value.includes('@') && !preset) advanced.value = true
  if (hostsTouched.value || !preset) return
  imapHost.value = preset.imapHost
  imapPort.value = preset.imapPort
  smtpHost.value = preset.smtpHost
  smtpPort.value = preset.smtpPort
})

/** 收集当前草稿；端口字段空着按 0 走（sanitize 那边收敛为「没填」） */
function draftOf(): MailAccount {
  return sanitizeMailAccount({
    address: address.value,
    imapHost: imapHost.value,
    imapPort: Number(imapPort.value) || 0,
    smtpHost: smtpHost.value,
    smtpPort: Number(smtpPort.value) || 0
  })
}

/** 保存前过一遍必填项；差什么就地说什么 */
function validate(draft: MailAccount, secret: string): string {
  if (!draft.address) return '先填邮箱地址'
  if (!draft.imapHost || !draft.imapPort) return '收件服务器（IMAP）没填全 —— 在上面的「服务器设置」里补上'
  if (!draft.smtpHost || !draft.smtpPort) return '发件服务器（SMTP）没填全 —— 在上面的「服务器设置」里补上'
  if (!secret && !keyConfigured.value) return '先填授权码（邮箱后台「POP3/SMTP/IMAP」里生成的那个，不是登录密码）'
  return ''
}

async function save(): Promise<void> {
  const draft = draftOf()
  const secret = secretDraft.value.trim()
  formError.value = validate(draft, secret)
  if (formError.value) return

  verifying.value = true
  saveError.value = ''
  // 授权码重填了就连收发两个服务器各验一遍；没重填（沿用已存的那把）就直接保存
  if (secret) {
    const verified = await verifyMailAccount(draft, secret)
    if (!verified.ok) {
      verifying.value = false
      formError.value = verified.error ?? '验证没有通过'
      return
    }
  }
  const updated = await settings.updateSettings({ mailAccount: draft })
  if (!updated) {
    verifying.value = false
    saveError.value = '保存设置失败'
    return
  }
  if (secret) {
    const stored = await saveMailKey(draft.address, secret)
    if (!stored.ok) {
      verifying.value = false
      saveError.value = stored.error ?? '保存授权码失败'
      return
    }
  }
  // 换了地址：旧地址的授权码从凭据管理器里清掉（清不干净不拦保存，只留一句话）
  if (originalAddress.value && originalAddress.value !== draft.address) {
    const cleared = await clearMailKey(originalAddress.value)
    if (!cleared.ok) notifyError(cleared.error ?? '旧地址的授权码没清掉，可以到系统凭据管理器里手动删')
  }
  verifying.value = false
  secretDraft.value = ''
  keyConfigured.value = keyConfigured.value || !!secret
  notifySuccess('邮箱账户已保存')
  emit('saved')
  visible.value = false
}

const ready = computed(() => mailAccountReady(draftOf()))
</script>

<template>
  <AppDialog v-model="visible" title="邮箱账户" width="520px" penetrable>
    <div class="acct">
      <el-form label-position="top" class="acct__form" @submit.prevent>
        <el-form-item label="邮箱地址">
          <el-input
            v-model="address"
            placeholder="user@163.com"
            :maxlength="80"
            @change="() => (address = address.trim())"
          />
        </el-form-item>
      </el-form>

      <!-- 服务器设置：163 / 126 默认整段藏着（跟着地址自动带出），自定义域名才需要它 -->
      <div class="acct__advanced-head">
        <span class="acct__advanced-title">服务器设置</span>
        <el-button link size="small" @click="advanced = !advanced">
          {{ advanced ? '收起' : '展开' }}
        </el-button>
      </div>
      <div v-show="advanced" class="acct__servers">
        <el-form label-position="top" @submit.prevent>
          <div class="acct__pair">
            <el-form-item label="收件服务器（IMAP）">
              <el-input v-model="imapHost" placeholder="imap.163.com" @input="hostsTouched = true" />
            </el-form-item>
            <el-form-item label="端口" class="acct__port">
              <el-input v-model="imapPort" placeholder="993" inputmode="numeric" @input="hostsTouched = true" />
            </el-form-item>
          </div>
          <div class="acct__pair">
            <el-form-item label="发件服务器（SMTP）">
              <el-input v-model="smtpHost" placeholder="smtp.163.com" @input="hostsTouched = true" />
            </el-form-item>
            <el-form-item label="端口" class="acct__port">
              <el-input v-model="smtpPort" placeholder="465" inputmode="numeric" @input="hostsTouched = true" />
            </el-form-item>
          </div>
        </el-form>
      </div>

      <!-- 授权码：只在提交那一刻读一次，存起来之后就再也读不回来（凭据管理器里那条） -->
      <div class="acct__key">
        <span class="acct__key-label">
          客户端授权码
          <span class="acct__state" :class="{ 'is-ok': keyConfigured }">
            {{ keyConfigured ? '已配置' : '未配置' }}
          </span>
        </span>
        <el-input
          v-model="secretDraft"
          type="password"
          show-password
          :placeholder="keyConfigured ? '已存好，重填即覆盖' : '粘贴授权码'"
        />
        <p class="acct__hint">
          网页版邮箱「设置 → POP3/SMTP/IMAP」里开启服务并生成授权码（不是登录密码）。
          它存进 Windows 凭据管理器，不落明文。
        </p>
      </div>

      <p v-if="formError" class="acct__error">{{ formError }}</p>
      <p v-if="saveError" class="acct__error">{{ saveError }}</p>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="verifying" :disabled="!ready && !address" @click="save">
        验证并保存
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.acct {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* 收发服务器各占一行：主机吃剩余宽度，端口窄列跟在后面 */
.acct__advanced-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: calc(-1 * var(--sp-1));
}

.acct__advanced-title {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.acct__servers {
  margin-top: var(--sp-1);
}

.acct__pair {
  display: flex;
  gap: var(--sp-3);
}

.acct__pair > :first-child {
  flex: 1;
  min-width: 0;
}

.acct__port {
  width: 84px;
  flex-shrink: 0;
}

.acct__key {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.acct__key-label {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.acct__state {
  color: var(--ink-3);
}

.acct__state.is-ok {
  color: var(--st-ok);
}

.acct__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.acct__error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
}
</style>
