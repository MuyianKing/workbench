<script setup lang="ts">
/**
 * 把当前档位的工作记录发到邮箱（工作页工具带「发送到邮箱」那颗按钮的弹窗）。
 *
 * 要发的内容在页面点按钮那一刻就定稿了（subject / text 是快照，见 WorkView 的 openMail）；
 * 这里只管收件人（从**自家邮箱账号与通讯录**里挑的多选下拉，默认选中发信的那个）与真正的发送，
 * 发信走邮箱页同一条路（useMailStore 的 send → buildMime → mail_send），不新增出口。
 */
import { contactLabel } from '@workbench/mail'
import { workLogEmailFragment, workLogEmailHtml } from '@workbench/work-log'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { useMailStore } from '@/stores/mail'

const props = defineProps<{
  /** 发出去的主题（也是正文第一行） */
  subject: string
  /** Markdown 正文（含主题那一行） */
  text: string
  /** 这一段有多少条记录（弹窗里那句汇总用） */
  entryCount: number
  /** 发件账户的地址：发信用它，收件人也默认选它 */
  from: string
}>()

const open = defineModel<boolean>({ required: true })

const mail = useMailStore()

/** 收件人：自家邮箱账号或联系人的地址，可以选多个（值就是地址） */
const recipients = ref<string[]>([])
const sending = ref(false)

/** 联系人候选：与自家邮箱地址重复的不再列（值相同会同时选中两条） */
const contactOptions = computed(() =>
  mail.contacts.filter(contact => !mail.accounts.some(account => account.address === contact.address)),
)

/**
 * 收件端看到的那份：工作日志 Markdown 经 markdown-it（`html: false`）渲染，
 * 任务列表换成方框。预览与发出去的 HTML 是同一份片段 —— 下面 v-html 拿的
 * 就是它（原文标签已被转义，与 MarkdownView 同一条安全口径）。
 */
const preview = computed(() => workLogEmailFragment(props.text))

/** 每次打开都把收件人拉回「发给自己」，上一次改的收件人不留着 */
watch(open, (value) => {
  if (value)
    recipients.value = [props.from]
})

async function send(): Promise<void> {
  const to = recipients.value.slice()
  if (!to.length) {
    ElMessage.warning('收件人至少选一个')
    return
  }

  sending.value = true
  try {
    const result = await mail.send({
      from: props.from,
      to,
      subject: props.subject,
      text: props.text,
      // 纯文本那份是 Markdown 源码（兜底）；HTML 那份是排版好的整页
      html: workLogEmailHtml(props.text),
    })
    if (!result.ok) {
      ElMessage.error(result.error ?? '发送失败')
      return
    }
    ElMessage.success(`已发给 ${to.join('、')}`)
    open.value = false
  }
  finally {
    sending.value = false
  }
}
</script>

<template>
  <AppDialog
    v-model="open"
    title="发送到邮箱"
    width="560"
    align-center
    penetrable
  >
    <div class="send">
      <p class="send__summary">
        {{ subject }} · 共 {{ entryCount }} 条
      </p>
      <!-- 预览就是收件端看到的那份（markdown-it html: false 的产物，安全） -->
      <div class="send__preview" v-html="preview" />
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="收件人">
          <el-select
            v-model="recipients"
            multiple
            filterable
            placeholder="从自己的邮箱或联系人里挑"
            :disabled="sending"
          >
            <el-option-group label="我的邮箱">
              <el-option
                v-for="account in mail.accounts"
                :key="account.address"
                :label="account.address"
                :value="account.address"
              />
            </el-option-group>
            <el-option-group v-if="contactOptions.length" label="联系人">
              <el-option
                v-for="contact in contactOptions"
                :key="contact.address"
                :label="contactLabel(contact)"
                :value="contact.address"
              />
            </el-option-group>
          </el-select>
        </el-form-item>
      </el-form>
      <p class="send__note">
        正文按 HTML 邮件发出（另带一份 Markdown 纯文本兜底）；发件账户是 {{ from }}。
      </p>
    </div>

    <template #footer>
      <el-button :disabled="sending" @click="open = false">
        取消
      </el-button>
      <el-button type="primary" :loading="sending" @click="send">
        发送
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.send {
  display: grid;
  gap: 10px;
}

.send__summary {
  margin: 0;
  font-size: 13px;
  color: var(--ink);
}

/* 预览：排版排成收件端那种「一张白纸」，高度封顶、里面自己滚 */
.send__preview {
  max-height: 240px;
  padding: 12px 14px;
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ink);
  background: var(--bg-inset);
  border-radius: var(--el-border-radius-base);
}

/* v-html 的内容拿不到 scoped 属性，靠 :deep 盖一层（正文元素只来自 markdown-it） */
.send__preview :deep(h1) {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.send__preview :deep(h2) {
  margin: 14px 0 4px;
  font-size: 13px;
  font-weight: 600;
}

.send__preview :deep(p) {
  margin: 6px 0;
}

.send__preview :deep(ul) {
  margin: 0;
  padding-left: 20px;
}

.send__preview :deep(li) {
  margin: 2px 0;
}

.send__preview :deep(hr) {
  margin: 10px 0;
  border: 0;
  border-top: 1px solid var(--border);
}

.send__preview :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-surface);
}

.send__note {
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
}
</style>
