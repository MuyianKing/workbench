<script setup lang="ts">
/**
 * 新建技能的弹窗：填名字（即目录名）与描述，提交后建目录、写 SKILL.md 骨架。
 *
 * 名字最终就是一个文件夹名，非法字符就地说明（与笔记起名同一条规矩，见 shared/note.ts）；
 * 校验失败显示在字段下面，不弹消息。同名在 store 里拦（列表就在手上）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { noteNameProblem } from '@shared/note'
import { useSkillsStore } from '@/stores/skills'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const store = useSkillsStore()

const form = reactive({ id: '', description: '' })
const submitting = ref(false)

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

watch(
  () => props.open,
  (value) => {
    if (value) {
      form.id = ''
      form.description = ''
    }
  }
)

const idProblem = computed(() => noteNameProblem(form.id))

async function submit(): Promise<void> {
  if (!form.id.trim() || idProblem.value || submitting.value) return
  submitting.value = true
  // 名字与描述写进 frontmatter；正文骨架由适配层生成，建完选中的就是它
  const created = await store.create({ id: form.id, name: form.id, description: form.description })
  submitting.value = false
  if (created) visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="新建技能" width="460px" append-to-body>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="名字" :error="idProblem || undefined">
        <el-input
          v-model="form.id"
          spellcheck="false"
          placeholder="目录名，也是安装到项目时的目录名"
          @keyup.enter="submit"
        />
      </el-form-item>
      <el-form-item label="描述">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="2"
          placeholder="这个技能做什么、什么时候用（写进 frontmatter 的 description，agent 靠它决定何时触发）"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="!form.id.trim() || Boolean(idProblem)"
        @click="submit"
      >
        创建
      </el-button>
    </template>
  </el-dialog>
</template>
