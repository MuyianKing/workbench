<script setup lang="ts">
import { FolderOpened } from '@element-plus/icons-vue'
/**
 * 添加 / 指定一个原始数据来源（知识库页「原始数据」签最外层那一格）。
 *
 * 只收「名字 + 文件夹」两件事：**配置只是一层映射** —— 应用不搬运、不复制、不删除任何
 * 文件，改的只有「去哪儿读」。名字是逻辑路径 `data/raw/<名字>` 的那一段，也是条目
 * frontmatter 的 source 引用的那一截，所以**只在新增时能填**：换名字等于全库断出处，
 * 要换就移除再加一个（那是调用方的事，这里如实说清）。来源文件夹里的资料是用户自己的
 * 原文，应用与清洗都只读它。
 */
import { computed, reactive, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'

const props = defineProps<{
  /** 已有的来源名；空串 = 新加一个 */
  name: string
  /** 当前配的文件夹（新加时是空串） */
  dir: string
  /** 这条来源在设置里有记录（有记录才谈得上「移除」） */
  configured: boolean
}>()

const emit = defineEmits<{
  /** 确认：名字 + 文件夹（调用方按「新加」还是「指定路径」分流） */
  submit: [payload: { name: string, dir: string }]
  /** 移除这条来源：只删配置，不动任何文件 */
  remove: [name: string]
}>()

/** 打开着没有（v-model，与 AI 模型弹窗同一条写法） */
const visible = defineModel<boolean>({ required: true })

const form = reactive({ name: '', dir: '' })

/** 新加一个才填名字；给已有的来源指定路径时名字是定死的 */
const adding = computed(() => !props.name)
const title = computed(() => (adding.value ? '添加原始数据' : `来源：${props.name}`))
const canSubmit = computed(() => !!form.name.trim() && !!form.dir.trim())

function reset(): void {
  form.name = props.name
  form.dir = props.dir
}

watch(visible, (open) => {
  if (open)
    reset()
})

async function browse(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择来源文件夹')
  if (picked)
    form.dir = picked
}

function submit(): void {
  if (!canSubmit.value)
    return
  emit('submit', { name: form.name.trim(), dir: form.dir.trim() })
  visible.value = false
}

function remove(): void {
  emit('remove', props.name)
  visible.value = false
}
</script>

<template>
  <!-- penetrable：路径常要回资源管理器看一眼再抄过来（见 AppDialog.vue） -->
  <AppDialog
    v-model="visible"
    :title="title"
    width="520"
    align-center
    penetrable
    @closed="reset"
  >
    <el-form class="form" :model="form" label-position="top" @submit.prevent>
      <el-form-item label="名称">
        <el-input
          v-model="form.name"
          :disabled="!adding"
          placeholder="这一格在「原始数据」里的名字"
          spellcheck="false"
        />
        <p v-if="!adding" class="field__hint">
          条目按这个名字找原始资料，改名等于全库断出处；要换名字就移除再加一个。
        </p>
      </el-form-item>

      <el-form-item label="文件夹">
        <div class="field__row">
          <el-input
            v-model="form.dir"
            placeholder="资料实际所在的那个文件夹"
            spellcheck="false"
          />
          <el-button :icon="FolderOpened" @click="browse">
            浏览
          </el-button>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button v-if="configured" class="form__remove" text type="danger" @click="remove">
        移除来源
      </el-button>
      <el-button @click="visible = false">
        取消
      </el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">
        {{ adding ? '添加' : '保存' }}
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 字段排版与说明小字由 global.css 的「弹窗表单」一节统一给，这里只留这个弹窗特有的 */
.field__row {
  display: flex;
  gap: var(--sp-2);
  width: 100%;
}

.field__row :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

/* 「移除来源」推到左边去：取消 / 保存留在右缘（footer 默认右对齐） */
.form__remove {
  margin-right: auto;
}
</style>
