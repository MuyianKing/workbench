<script setup lang="ts">
/**
 * 给一个文件夹 / 笔记起名字（新建与重命名共用）。
 *
 * 新建与改名长得一样、校验也一样（只有「不能为空」一条），所以只留一个弹窗：
 * 打开时把名字预填成调用方给的那份、选中全部文字，回车即提交 ——
 * 从右键菜单新建时多数人直接回车，预填的「新建笔记」由适配层负责撞名退让。
 *
 * 写盘由调用方负责（它是这次业务动作的发起方），这里只把名字交出去。
 */
import { computed, ref, watch } from 'vue'
import type { InputInstance } from 'element-plus'
import { NOTE_NAME_MAX, isValidNoteName, type NoteKind } from '@shared/note'

const props = defineProps<{
  modelValue: boolean
  title: string
  /** 决定提示语怎么写（文件夹 / 笔记） */
  kind: NoteKind
  /** 打开时预填的名字 */
  defaultName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 用户确认了名字；名字已经过收敛，一定非空 */
  submit: [name: string]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const name = ref('')
const inputRef = ref<InputInstance | null>(null)

const valid = computed(() => isValidNoteName(name.value))
const hint = computed(() =>
  valid.value
    ? props.kind === 'folder'
      ? '文件夹里可以继续放文件夹与笔记。'
      : '正文按 markdown 写，随时保存。'
    : '名字不能为空。'
)

watch(
  () => props.modelValue,
  (open) => {
    if (open) name.value = props.defaultName
  }
)

/**
 * 聚焦与全选放在弹窗的 `opened` 之后，而不是上面那个 watch 里。
 *
 * `el-dialog` 的正文是打开时才挂上的，watch 里就算等过一次 `nextTick`，输入框也还没进 DOM
 * （inputRef 是 null），表现成「弹窗出来了、光标不在输入框里」——预填的名字要再点一下才能改。
 */
function focusInput(): void {
  inputRef.value?.focus()
  inputRef.value?.select()
}

function submit(): void {
  if (!valid.value) return
  emit('submit', name.value.trim())
  visible.value = false
}
</script>

<template>
  <!-- append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节） -->
  <el-dialog
    v-model="visible"
    :title="title"
    width="420"
    align-center
    append-to-body
    :close-on-click-modal="false"
    @opened="focusInput"
  >
    <el-form class="form" label-position="top" @submit.prevent="submit">
      <el-form-item :label="kind === 'folder' ? '文件夹名' : '笔记名'">
        <el-input
          ref="inputRef"
          v-model="name"
          :maxlength="NOTE_NAME_MAX"
          placeholder="起个名字"
          @keyup.enter="submit"
        />
        <p class="field__hint" :class="{ 'is-invalid': !valid }">{{ hint }}</p>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!valid" @click="submit">确定</el-button>
    </template>
  </el-dialog>
</template>
