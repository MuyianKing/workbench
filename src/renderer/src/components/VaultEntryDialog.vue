<script setup lang="ts">
/**
 * 添加 / 编辑一条记录的弹框：名字、密码、分组、备注。
 *
 * **添加走弹框、卡片上只有复制与查看**：卡片墙是「用」的地方（看一眼、复制一下），
 * 改是偶尔才做一次的事 —— 把四个字段摊在每张卡片上，等于把最不常做的动作摆到最显眼的位置。
 *
 * 分组是一栏**自由文本**，不是一份要管理的清单：下拉里给出已经有的那些（选一下省得打字），
 * 也能直接敲一个新的 —— 那一组随之出现，最后一条离开它也随之消失（见 shared/vault.ts 的 vaultGroups）。
 *
 * 校验就地显示在字段下面（`vaultEntryProblem` 是唯一那份规则，store 里还拿它兜一次），
 * 不弹消息。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { InputInstance } from 'element-plus'
import { emptyVaultEntry, vaultEntryProblem, type VaultEntry, type VaultRecord } from '@shared/vault'
import AppDialog from '@/components/AppDialog.vue'

const visible = defineModel<boolean>('visible', { required: true })

const props = defineProps<{
  /** 要编辑的那条；null = 添加一条新的 */
  record: VaultRecord | null
  /** 已经有的那些分组：下拉里给出来，也能直接打一个新的 */
  groups: string[]
}>()

const emit = defineEmits<{ save: [entry: VaultEntry] }>()

const draft = ref<VaultEntry>(emptyVaultEntry())
const nameInput = ref<InputInstance>()
const submitting = ref(false)

const problem = computed(() => vaultEntryProblem(draft.value) ?? '')

/** 编辑时只把正文那几项铺进表单，元信息（id / 时间 / 设备）不归这里管 */
function fieldsOf(record: VaultRecord): VaultEntry {
  return {
    name: record.name,
    password: record.password,
    notes: record.notes,
    group: record.group
  }
}

// 每次打开都重新铺一遍：上一次留下的草稿不该跟着进这一次
watch(visible, (open) => {
  if (!open) return
  draft.value = props.record ? fieldsOf(props.record) : emptyVaultEntry()
  submitting.value = false
})

/**
 * 聚焦挂在 `@opened` 之后，不能写在 watch 里 —— 内容要等弹框打开才挂进 DOM，
 * 那时 `nextTick` 也还没轮到它（笔记的起名弹窗踩过同一个坑：弹窗出来了、光标不在框里）。
 */
function focusName(): void {
  void nextTick(() => nameInput.value?.focus())
}

function submit(): void {
  if (problem.value || submitting.value) return
  submitting.value = true
  emit('save', draft.value)
}

/** 存失败时由调用方把 submitting 放回去（弹框留着，填过的内容不动） */
defineExpose({ done: () => (submitting.value = false) })
</script>

<template>
  <!-- penetrable：填这条时常常要切到笔记里把密码抄过来（见 AppDialog.vue） -->
  <AppDialog
    v-model="visible"
    :title="record ? '编辑记录' : '添加记录'"
    width="520"
    penetrable
    @opened="focusName"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="名字" :error="problem || undefined">
        <el-input
          ref="nameInput"
          v-model="draft.name"
          spellcheck="false"
          placeholder="这条记的是什么，比如「宽带账号」"
          @keyup.enter="submit"
        />
      </el-form-item>

      <el-form-item label="密码">
        <el-input
          v-model="draft.password"
          spellcheck="false"
          placeholder="留空也行（只记个名字和备注也成立）"
        />
      </el-form-item>

      <el-form-item label="分组">
        <el-select
          v-model="draft.group"
          class="entry__group"
          filterable
          allow-create
          default-first-option
          clearable
          placeholder="不填就是未分组；打一个新的就是新的一组"
        >
          <el-option v-for="group in props.groups" :key="group" :label="group" :value="group" />
        </el-select>
      </el-form-item>

      <el-form-item label="备注">
        <el-input
          v-model="draft.notes"
          type="textarea"
          :rows="3"
          spellcheck="false"
          placeholder="两段式验证、备用码放在哪…"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="Boolean(problem)" @click="submit">
        {{ record ? '保存' : '添加' }}
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* el-select 默认跟着内容走，这里让它与上面几个输入框一样占满一行 */
.entry__group {
  width: 100%;
}
</style>
