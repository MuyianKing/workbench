<script setup lang="ts">
/**
 * 写信 / 回信的弹层：发件邮箱、收件人、主题、正文与附件，发送走 stores/mail.ts 的
 * send（报文构建在 @workbench/mail 的 buildMime，SMTP 传输在 Rust）。
 *
 * 发件邮箱：配了多个账户才要挑（回信默认收信的那个，新邮件是清单里第一个）；
 * 只有一个账户时这一栏不画 —— 没什么可选的。
 *
 * 附件一次可以挑多个（pickFiles），内容按路径读成 base64（fs_read_base64）——
 * 文件本身是用户在对话框里亲手挑的，读取范围不需要额外圈。发出去之后清空草稿，
 * 发送失败的东西留在原地，改一改还能再发一次。
 *
 * 这个弹层是**填内容的那种**（收件人多半要回列表里抄），所以不挡背后 ——
 * 见 AGENTS.md 第 4 节。
 */
import { ref, watch } from 'vue'
import { Close, Paperclip } from '@element-plus/icons-vue'
import {
  contentTypeForFileName,
  formatMailSize,
  type MailAttachmentInput
} from '@workbench/mail'
import AppDialog from '@/components/AppDialog.vue'
import { useMailStore, type MailReplyTarget } from '@/stores/mail'
import { notifyError, notifySuccess } from '@/notify'
import { basenameOf } from '@/format'

const visible = defineModel<boolean>({ required: true })
const props = defineProps<{ reply: MailReplyTarget | null }>()

const mail = useMailStore()

const fromAccount = ref('')
const to = ref('')
const subject = ref('')
const body = ref('')
const attachments = ref<MailAttachmentInput[]>([])
const formError = ref('')
/** 收件人输入框的就地校验（store.send 那边还会再拦一遍） */
const toError = ref('')

/** 每次打开按需起手：回信预填引用（用收信的那个账户发），新邮件是空白的；关闭不保留草稿 */
watch(visible, (open) => {
  if (!open) return
  formError.value = ''
  toError.value = ''
  const reply = props.reply
  const from = reply?.from ?? ''
  fromAccount.value = mail.accounts.some((account) => account.address === from)
    ? from
    : (mail.accounts[0]?.address ?? '')
  if (reply) {
    to.value = reply.to
    subject.value = /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`
    body.value = quote(reply)
  } else {
    to.value = ''
    subject.value = ''
    body.value = ''
    attachments.value = []
  }
})

/** 回信引用体：原文整段用「> 」垫起来，一眼分得出哪些是别人的话 */
function quote(reply: MailReplyTarget): string {
  const quoted = reply.text
    .split('\r\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `\n\n---- ${reply.to} 写道 ----\n${quoted}\n`
}

/** 收件人：逗号 / 分号 / 空白都能当分隔符，逐个要有 @ */
function recipients(): string[] {
  return to.value
    .split(/[,;，；\s]+/)
    .map((address) => address.trim())
    .filter(Boolean)
}

function validateTo(): boolean {
  const list = recipients()
  if (list.length === 0) {
    toError.value = '收件人是空的'
    return false
  }
  const bad = list.find((address) => !address.includes('@') || /\s/.test(address))
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
  if (!picked || picked.length === 0) return
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
      bytesBase64: file.data
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
  if (!validateTo()) return
  const result = await mail.send({
    from: fromAccount.value,
    to: recipients(),
    subject: subject.value.trim(),
    text: body.value,
    attachments: attachments.value
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
          <el-input
            v-model="to"
            placeholder="多个地址用逗号隔开"
            :maxlength="600"
            @change="validateTo"
          />
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
        <el-button size="small" :icon="Paperclip" @click="addAttachments">添加附件</el-button>
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

      <p v-if="formError" class="comp__error">{{ formError }}</p>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="mail.sending" @click="send">发送</el-button>
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
  border-radius: var(--r-2);
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
