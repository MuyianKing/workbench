<script setup lang="ts">
/**
 * 邮箱账户的管理弹层：上面是已配账户的清单（逐个编辑 / 删除，可同时配多个 ——
 * 收件箱合并成一份按时间排），下面是表单 —— 新增一个账户，或编辑选中的那个。
 *
 * 一条链路走完：填地址（163 / 126 / QQ 自动带出官方服务器，自定义域就自己填）、
 * 粘授权码、「验证并保存」—— 验证是 Rust 那边把收发两个服务器各连一遍
 * （mail_verify），保存落两处 —— 连接参数进设置（workbench-data.json 的
 * mailAccounts 清单）、授权码进 Windows 凭据管理器（mail_key_save，按地址一条，
 * 只写不读回）。编辑模式里地址不可改 —— 地址就是账户的身份，换地址走「删除 + 新增」，
 * 不做静默改名（免得旧账户的授权码被顺手清掉）。
 *
 * 新增保存后弹层留着（清单里立刻能看到，接着添下一个）；编辑保存后关掉。
 * 弹层末尾还有一行**全局项**「新邮件检查」—— 后台监视的周期（不挑账户），
 * 改了立即生效，不进下面的保存链路。
 * 这个弹层是**填内容的那种**（授权码要从邮箱后台抄过来），所以不挡背后 ——
 * 与 AI 服务、添加项目那几个同一条（见 AGENTS.md 第 4 节）。
 */
import { computed, ref, watch } from 'vue'
import {
  MAIL_ACCOUNTS_MAX,
  mailAccountReady,
  presetForAddress,
  sanitizeMailAccount,
  type MailAccount
} from '@workbench/mail'
import AppDialog from '@/components/AppDialog.vue'
import { clearMailKey, mailKeyState, saveMailKey, verifyMailAccount } from '@/workbench/mail'
import { useSettingsStore } from '@/stores/settings'
import { confirmAction, notifyError, notifySuccess } from '@/notify'

const visible = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const settings = useSettingsStore()

/** 已配的账户清单（落盘的那份） */
const accounts = computed(() => settings.settings.mailAccounts)
/** 正在编辑的账户地址；null = 表单在新增模式 */
const editing = ref<string | null>(null)

const address = ref('')
const secretDraft = ref('')
const imapHost = ref('')
const imapPort = ref<number | ''>('')
const smtpHost = ref('')
const smtpPort = ref<number | ''>('')

const verifying = ref(false)
/**
 * 服务器字段的摊开没有：163 / 126 / QQ 的收发服务器跟着地址后缀自动带出
 * （presetForAddress），常年摆着就是两行用不上的输入框 —— 收进「服务器设置」，
 * 认不出的域名才自动摊开（与 AI 服务弹层的高级设置同一套做法）。手动摊开过就不替用户收回去。
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
/** 正在删的账户地址（行上转圈） */
const removing = ref<string | null>(null)

/** 每次打开都回新增模式：清单看得见现有的，表单是空的 */
watch(visible, (open) => {
  if (open) startAdd()
})

/** 表单回到新增模式：全空 */
function startAdd(): void {
  editing.value = null
  address.value = ''
  secretDraft.value = ''
  imapHost.value = ''
  imapPort.value = ''
  smtpHost.value = ''
  smtpPort.value = ''
  hostsTouched.value = false
  formError.value = ''
  saveError.value = ''
  verifying.value = false
  keyConfigured.value = false
  advanced.value = false
}

/** 把一个已配的账户装进表单：地址锁住（身份不可改），服务器与授权码可改 */
function startEdit(account: MailAccount): void {
  editing.value = account.address
  // 先按住服务器不动（hostsTouched），再填地址 —— 地址的 watch 见到动过就不套预设，
  // 用户自定义过的服务器不会被官方预设覆盖回去
  hostsTouched.value = true
  address.value = account.address
  secretDraft.value = ''
  imapHost.value = account.imapHost
  imapPort.value = account.imapPort || ''
  smtpHost.value = account.smtpHost
  smtpPort.value = account.smtpPort || ''
  formError.value = ''
  saveError.value = ''
  verifying.value = false
  // 存的就是个认不出后缀的地址：服务器是用户自己填的，摊开着让他看到现状
  advanced.value = !presetForAddress(account.address)
  void refreshKeyState()
}

async function refreshKeyState(): Promise<void> {
  keyConfigured.value = false
  if (!address.value.includes('@')) return
  const result = await mailKeyState(address.value)
  keyConfigured.value = result.ok && result.data === true
}

/**
 * 地址变了（新增模式才有的事）：认得出后缀且服务器没被手动改过，就带出官方预设 ——
 * 用户自己填过服务器（自定义域邮箱）就不动它。
 */
watch(address, () => {
  formError.value = ''
  void refreshKeyState()
  const preset = presetForAddress(address.value)
  // 认不出的域名（且像是个地址）：服务器得自己填，自动摊开；认得出的静静带出预设
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
  if (!editing.value) {
    if (accounts.value.some((account) => account.address === draft.address)) {
      return '这个地址已经配过了 —— 在上面的清单里点「编辑」改它'
    }
    if (accounts.value.length >= MAIL_ACCOUNTS_MAX) return `最多配 ${MAIL_ACCOUNTS_MAX} 个邮箱`
  }
  if (!draft.imapHost || !draft.imapPort) return '收件服务器（IMAP）没填全 —— 在下面的「服务器设置」里补上'
  if (!draft.smtpHost || !draft.smtpPort) return '发件服务器（SMTP）没填全 —— 在下面的「服务器设置」里补上'
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
  const next = editing.value
    ? accounts.value.map((account) => (account.address === editing.value ? draft : account))
    : [...accounts.value, draft]
  const updated = await settings.updateSettings({ mailAccounts: next })
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
  verifying.value = false
  notifySuccess('邮箱账户已保存')
  emit('saved')
  if (editing.value) {
    visible.value = false
  } else {
    // 新增完留在弹层里（清单里立刻能看到），接着添下一个
    startAdd()
  }
}

const ready = computed(() => mailAccountReady(draftOf()))

/** 「新邮件检查」的候选周期（分钟）：0 = 关闭。下限与 @workbench/mail 的 MAIL_POLL_MIN 同源 */
const POLL_CHOICES = [0, 1, 5, 10, 15, 30, 60]
const pollLabel = (minutes: number): string => (minutes === 0 ? '关闭' : `每 ${minutes} 分钟`)

/** 后台检查周期：全局一项，改了立即落盘（store 的 startWatch 盯着它重登监视配置） */
const pollMinutes = computed<number>({
  get: () => settings.settings.mailPollMinutes,
  set: (value) => {
    void settings.updateSettings({ mailPollMinutes: value })
  }
})

/** 删除走一次确认：清掉的是这个账户的授权码与配置，误手滑还有一次回头的机会 */
async function remove(account: MailAccount): Promise<void> {
  if (removing.value) return
  if (!(await confirmAction('它的授权码也会从凭据管理器清掉，要重新填才能再收发这个邮箱的信。', `删除 ${account.address}`))) {
    return
  }
  removing.value = account.address
  const cleared = await clearMailKey(account.address)
  if (!cleared.ok) notifyError(cleared.error ?? '授权码没清掉，可以到系统凭据管理器里手动删')
  const updated = await settings.updateSettings({
    mailAccounts: accounts.value.filter((entry) => entry.address !== account.address)
  })
  removing.value = null
  if (!updated) {
    saveError.value = '删除没有完成（设置没写回去），再试一次'
    return
  }
  if (editing.value === account.address) startAdd()
  notifySuccess('邮箱已删除')
  emit('saved')
}
</script>

<template>
  <AppDialog v-model="visible" title="邮箱账户" width="520px" penetrable>
    <div class="acct">
      <!-- 已配的账户清单：逐个编辑 / 删除（正在编辑的那行高亮） -->
      <div v-if="accounts.length" class="acct__list">
        <div
          v-for="account in accounts"
          :key="account.address"
          class="acct__row"
          :class="{ 'is-editing': account.address === editing }"
        >
          <span class="acct__addr" :title="account.address">{{ account.address }}</span>
          <el-button text size="small" @click="startEdit(account)">编辑</el-button>
          <el-button
            text
            size="small"
            class="acct__row-remove"
            :loading="removing === account.address"
            @click="remove(account)"
          >
            删除
          </el-button>
        </div>
      </div>

      <p v-if="editing" class="acct__mode">
        正在编辑 {{ editing }}
        <el-button link size="small" @click="startAdd">不编辑了</el-button>
      </p>
      <p v-else-if="accounts.length" class="acct__mode">添加邮箱</p>

      <el-form label-position="top" class="acct__form" @submit.prevent>
        <el-form-item label="邮箱地址">
          <el-input
            v-model="address"
            placeholder="user@163.com"
            :maxlength="80"
            :disabled="!!editing"
            @change="() => (address = address.trim())"
          />
        </el-form-item>
      </el-form>

      <!-- 服务器设置：163 / 126 / QQ 默认整段藏着（跟着地址自动带出），自定义域名才需要它 -->
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

      <!-- 后台检查：新邮件通知的周期。全局项（不挑账户），改了立即生效，不进下面的保存链路 -->
      <div class="acct__poll">
        <span class="acct__key-label">新邮件检查</span>
        <el-select v-model="pollMinutes" class="acct__poll-select">
          <el-option
            v-for="choice in POLL_CHOICES"
            :key="choice"
            :label="pollLabel(choice)"
            :value="choice"
          />
        </el-select>
      </div>

      <p v-if="formError" class="acct__error">{{ formError }}</p>
      <p v-if="saveError" class="acct__error">{{ saveError }}</p>
    </div>

    <template #footer>
      <div class="acct__footer">
        <span class="acct__footer-spacer" />
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="verifying" :disabled="!ready && !address" @click="save">
          {{ editing ? '保存修改' : '验证并保存' }}
        </el-button>
      </div>
    </template>
  </AppDialog>
</template>

<style scoped>
.acct {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* 已配账户的清单：一行一个地址，编辑 / 删除跟在右边 */
.acct__list {
  display: flex;
  flex-direction: column;
}

.acct__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px var(--sp-1);
  border-radius: var(--r-2);
}

.acct__row.is-editing {
  background: var(--bg-inset);
}

.acct__addr {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.acct__row.is-editing .acct__addr {
  color: var(--ink);
}

/* 删除常驻危险档（与右键菜单的删信同一口径） */
.acct__row-remove {
  color: var(--st-fail);
}

/* 模式行：新增时的分隔注脚 / 编辑时的现状一行 */
.acct__mode {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
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

/* 后台检查一行：全局项摆在账户表单之后，一条细线隔开 */
.acct__poll {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

.acct__poll-select {
  width: 128px;
}

.acct__error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
}

/* footer 一行两颗，靠右 */
.acct__footer {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.acct__footer-spacer {
  flex: 1;
}
</style>
