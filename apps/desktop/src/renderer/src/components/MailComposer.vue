<script setup lang="ts">
import type { MailAttachmentInput } from '@workbench/mail'
import type { MailReplyTarget } from '@/stores/mail'
import { Close, Paperclip } from '@element-plus/icons-vue'
import { contactLabel, contentTypeForFileName, formatMailSize, splitTypedAddresses } from '@workbench/mail'
/**
 * 写信 / 回信的弹层：发件邮箱、收件人、主题、正文与附件，发送走 stores/mail.ts 的
 * send（报文构建在 @workbench/mail 的 buildMime，SMTP 传输在 Rust）。
 *
 * 发件邮箱：配了多个账户才要挑（回信默认收信的那个，新邮件是清单里第一个）；
 * 只有一个账户时这一栏不画 —— 没什么可选的。
 *
 * 收件人是一颗**可新建的多选下拉**：候选来自通讯录（settings.mailContacts，标签是
 * 「名字 <地址>」），也可以当场打一个地址回车进去（allow-create）—— 粘一段
 * 「a@x.com, b@y.com」进来也算，值拆解走 splitTypedAddresses。选中的地址不在通讯录里时
 * 也补成候选，标签才不会掉成空白。地址存在的意义只是发信，落选的联系人不顺手存。
 *
 * 附件一次可以挑多个（pickFiles），内容按路径读成 base64（fs_read_base64）——
 * 文件本身是用户在对话框里亲手挑的，读取范围不需要额外圈。发出去之后清空草稿，
 * 发送失败的东西留在原地，改一改还能再发一次。
 *
 * 这个弹层是**填内容的那种**（收件人多半要回列表里抄），所以不挡背后 ——
 * 见 AGENTS.md 第 4 节：联系人弹层就从左栏那颗「联系人」进去，填着填着能开着它加人。
 */
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { basenameOf } from '@/format'
import { notifyError, notifySuccess } from '@/notify'
import { useMailStore } from '@/stores/mail'

const props = defineProps<{ reply: MailReplyTarget | null }>()
const visible = defineModel<boolean>({ required: true })
const mail = useMailStore()

const fromAccount = ref('')
/** 收件人（多选下拉的值：一个个地址） */
const to = ref<string[]>([])
const subject = ref('')
const body = ref('')
const attachments = ref<MailAttachmentInput[]>([])
const formError = ref('')
/** 收件人输入框的就地校验（store.send 那边还会再拦一遍） */
const toError = ref('')

/** 每次打开按需起手：回信预填引用（用收信的那个账户发），新邮件是空白的；关闭不保留草稿 */
watch(visible, (open) => {
  if (!open)
    return
  formError.value = ''
  toError.value = ''
  const reply = props.reply
  const from = reply?.from ?? ''
  fromAccount.value = mail.accounts.some(account => account.address === from)
    ? from
    : (mail.accounts[0]?.address ?? '')
  if (reply) {
    to.value = splitTypedAddresses([reply.to])
    subject.value = /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`
    body.value = quote(reply)
  }
  else {
    to.value = []
    subject.value = ''
    body.value = ''
    attachments.value = []
  }
})

/** 回信引用体：原文整段用「> 」垫起来，一眼分得出哪些是别人的话 */
function quote(reply: MailReplyTarget): string {
  const quoted = reply.text
    .split('\r\n')
    .map(line => `> ${line}`)
    .join('\n')
  return `\n\n---- ${reply.to} 写道 ----\n${quoted}\n`
}

/**
 * 下拉的候选：通讯录逐个来一条，再补上「已经填进来、但还不在通讯录里」的地址
 * （手打的、回信预填的）—— el-select 对没有对应项的值会拿值本身当标签，补一条更稳，
 * 标签一律与候选一起渲染。
 */
const recipientOptions = computed(() => {
  const known = new Set(mail.contacts.map(contact => contact.address))
  const extra = to.value
    .filter(address => !known.has(address.trim().toLowerCase()))
    .map(address => ({ value: address, label: address }))
  return [...mail.contacts.map(contact => ({ value: contact.address, label: contactLabel(contact) })), ...extra]
})

/** 收件人：下拉里一个个地址（新建出来的那条可能是一段带分隔符的串，一起拆） */
function recipients(): string[] {
  return splitTypedAddresses(to.value)
}

function validateTo(): boolean {
  const list = recipients()
  if (list.length === 0) {
    toError.value = '收件人是空的'
    return false
  }
  const bad = list.find(address => !address.includes('@') || /\s/.test(address))
  if (bad) {
    toError.value = `收件人地址不对：${bad}`
    return false
  }
  toError.value = ''
  return true
}

/** 挑附件：一次可多选，读成 base64 挂进来。读不动的那个跳过并提示。 */
async function addAttachments(): Promise<void> {
  const picked = await window.workbench.pickFiles('选择附件')
  if (!picked || picked.length === 0)
    return
  for (const path of picked) {
    const file = await window.workbench.readBinaryFile(path)
    if (!file.ok || !file.data) {
      notifyError(file.error ?? `读不了 ${path}`)
      continue
    }
    const name = basenameOf(path)
    attachments.value.push({
      name,
      contentType: contentTypeForFileName(name),
      bytesBase64: file.data,
    })
  }
}

function removeAttachment(index: number): void {
  attachments.value.splice(index, 1)
}

function attachmentSize(base64: string): string {
  return formatMailSize(Math.floor((base64.length * 3) / 4))
}

async function send(): Promise<void> {
  if (!validateTo())
    return
  const result = await mail.send({
    from: fromAccount.value,
    to: recipients(),
    subject: subject.value.trim(),
    text: body.value,
    attachments: attachments.value,
  })
  if (!result.ok) {
    formError.value = result.error ?? '发送失败'
    return
  }
  notifySuccess('邮件已发出')
  visible.value = false
}
</script>

<template>
  <AppDialog v-model="visible" title="写邮件" width="640px" penetrable>
    <div class="comp">
      <el-form label-position="top" class="comp__form" @submit.prevent>
        <!-- 发件邮箱：配了多个账户才要挑（一个账户没什么可选的，不画） -->
        <el-form-item v-if="mail.accounts.length > 1" label="发件邮箱">
          <el-select v-model="fromAccount">
            <el-option
              v-for="account in mail.accounts"
              :key="account.address"
              :label="account.address"
              :value="account.address"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="收件人" :error="toError">
          <el-select
            v-model="to"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="从联系人里挑，或直接输入地址"
            @change="validateTo"
          >
            <el-option
              v-for="option in recipientOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="主题">
          <el-input v-model="subject" placeholder="主题" :maxlength="200" />
        </el-form-item>
        <el-form-item label="正文">
          <el-input
            v-model="body"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 18 }"
            placeholder="正文"
          />
        </el-form-item>
      </el-form>

      <div class="comp__files">
        <el-button size="small" :icon="Paperclip" @click="addAttachments">
          添加附件
        </el-button>
        <span v-for="(file, index) in attachments" :key="`${index}-${file.name}`" class="comp__file">
          <span class="comp__file-name" :title="file.name">{{ file.name }}</span>
          <span class="comp__file-size">{{ attachmentSize(file.bytesBase64) }}</span>
          <el-button
            class="comp__file-remove"
            text
            size="small"
            :icon="Close"
            aria-label="移除附件"
            @click="removeAttachment(index)"
          />
        </span>
      </div>

      <p v-if="formError" class="comp__error">
        {{ formError }}
      </p>
    </div>

    <template #footer>
      <el-button @click="visible = false">
        取消
      </el-button>
      <el-button type="primary" :loading="mail.sending" @click="send">
        发送
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.comp {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/** 附件一行：添加按钮 + 一串文件片 */
.comp__files {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.comp__file {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  max-width: 260px;
  padding: 2px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  font-size: var(--fs-meta);
}

.comp__file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
}

.comp__file-size {
  flex-shrink: 0;
  color: var(--ink-3);
}

.comp__file-remove {
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--ink-3);
}

.comp__error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
}
</style>
