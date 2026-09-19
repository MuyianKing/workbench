<script setup lang="ts">
/**
 * 导入技能的弹窗：挑一个本机文件夹（通常是从别处 clone 或手工整理好的技能目录），
 * 复制进技能库并提交一次版本。
 *
 * 名字默认取所选目录的名字（可改）；`.git` 之类点开头的目录整支不带进来 ——
 * 那些是别人的仓库状态，不是技能的内容（Rust 侧同样挡一道）。
 */
import { computed, ref, watch } from 'vue'
import { noteNameProblem, sanitizeNoteName } from '@shared/note'
import { useSkillsStore } from '@/stores/skills'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const store = useSkillsStore()

const sourcePath = ref('')
const id = ref('')
const submitting = ref(false)

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

watch(
  () => props.open,
  (value) => {
    if (value) {
      sourcePath.value = ''
      id.value = ''
    }
  }
)

async function pick(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择技能文件夹')
  if (!picked) return
  sourcePath.value = picked
  if (!id.value.trim()) {
    // 名字默认取目录名：多数时候导入的就是一个已经起好名字的技能目录
    id.value = sanitizeNoteName(picked.split(/[\\/]/).pop() ?? '')
  }
}

const idProblem = computed(() => noteNameProblem(id.value))

async function submit(): Promise<void> {
  if (!sourcePath.value || !id.value.trim() || idProblem.value || submitting.value) return
  submitting.value = true
  const imported = await store.importFrom(sourcePath.value, id.value)
  submitting.value = false
  if (imported) visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="导入技能" width="520px" append-to-body>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="技能文件夹">
        <div class="pick">
          <el-button @click="pick">选择文件夹…</el-button>
          <span v-if="sourcePath" class="pick__path mono" :title="sourcePath">{{ sourcePath }}</span>
          <span v-else class="pick__hint">整棵复制（含子目录），.git 等隐藏目录不带</span>
        </div>
      </el-form-item>
      <el-form-item label="技能名" :error="idProblem || undefined">
        <el-input
          v-model="id"
          spellcheck="false"
          placeholder="存进技能库的目录名"
          @keyup.enter="submit"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="!sourcePath || !id.trim() || Boolean(idProblem)"
        @click="submit"
      >
        导入
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.pick {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  width: 100%;
}

.pick__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.pick__hint {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
