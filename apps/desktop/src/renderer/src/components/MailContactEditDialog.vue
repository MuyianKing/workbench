<script setup lang="ts">
import type { MailContact } from '@workbench/mail'
/**
 * 新增 / 编辑一个联系人：名字与邮箱地址两栏，保存走 stores/mail.ts 的 saveContact。
 * **地址是身份** —— 编辑时它锁死，换地址走「删除 + 新增」（与邮箱账户弹层同一条口径）。
 *
 * 名单本身摆在邮箱页左栏的「联系人」那一签里（MailView.vue），这里只管这一张表单：
 * 列表归列表、编辑归弹窗。
 *
 * 这个弹层是**填内容的那种**（地址多半要从别处抄过来），所以不挡背后 ——
 * 见 AGENTS.md 第 4 节。
 */
import { ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { notifySuccess } from '@/notify'
import { useMailStore } from '@/stores/mail'

const props = defineProps<{
  /** 要编辑的那个联系人；null = 新增 */
  contact: MailContact | null
}>()
const emit = defineEmits<{ saved: [] }>()
const visible = defineModel<boolean>({ required: true })
const mail = useMailStore()

const name = ref('')
const address = ref('')
/** 校验与保存失败的那句话：就地显示，不飘 toast */
const formError = ref('')
const saving = ref(false)

/** 每次打开都按传进来的那个起手（新增就是两张空栏）；关掉不保留草稿 */
watch(visible, (open) => {
  if (!open)
    return
  name.value = props.contact?.name ?? ''
  address.value = props.contact?.address ?? ''
  formError.value = ''
  saving.value = false
})

/** 保存前过一遍必填项；差什么就地说什么 */
function validate(): string {
  const value = address.value.trim()
  if (!value.includes('@') || /\s/.test(value))
    return '先填一个像样的邮箱地址'
  // 新增不能撞上名单里已有的那条（编辑时地址锁着，不存在撞的问题）
  if (!props.contact && mail.isContact(value))
    return '这个地址已经在名单里了'
  return ''
}

async function save(): Promise<void> {
  formError.value = validate()
  if (formError.value)
    return
  saving.value = true
  const result = await mail.saveContact({ name: name.value.trim(), address: address.value.trim() })
  saving.value = false
  if (!result.ok) {
    formError.value = result.error ?? '保存失败'
    return
  }
  notifySuccess('联系人已保存')
  emit('saved')
  visible.value = false
}
</script>

<template>
  <AppDialog
    v-model="visible"
    :title="contact ? '编辑联系人' : '新增联系人'"
    width="440px"
    penetrable
  >
    <el-form label-position="top" class="contact-form" @submit.prevent>
      <el-form-item label="名字">
        <el-input v-model="name" placeholder="名字（可以留空）" :maxlength="60" />
      </el-form-item>
      <el-form-item label="邮箱地址">
        <el-input
          v-model="address"
          placeholder="user@163.com"
          :maxlength="80"
          :disabled="!!contact"
          @change="() => (address = address.trim())"
        />
      </el-form-item>
    </el-form>

    <p v-if="formError" class="contact-form__error">
      {{ formError }}
    </p>

    <template #footer>
      <el-button @click="visible = false">
        取消
      </el-button>
      <el-button type="primary" :loading="saving" :disabled="!address.trim()" @click="save">
        保存
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.contact-form {
  display: flex;
  flex-direction: column;
}

.contact-form__error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
}
</style>
