<script setup lang="ts">
/**
 * 添加 / 编辑一个常用软件。
 *
 * 只收「程序 + 名字」两件事：Workbench 不接管它的进程，启动方式一律交给系统，
 * 所以没有参数、工作目录这类选项。中间那块预览用真实图标，选完就能确认没选错。
 */
import { computed, reactive, ref, watch } from 'vue'
import { Monitor } from '@element-plus/icons-vue'
import { defaultQuickAppName } from '@shared/quick-launch'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

const form = reactive({
  target: '',
  name: ''
})

/** 用户手动改过名称后，不再被路径推出来的默认名覆盖 */
const nameTouched = ref(false)

const visible = computed({
  get: () => store.quickDialogVisible,
  set: (value: boolean) => (store.quickDialogVisible = value)
})

const editing = computed(() => store.quickEditing)
const title = computed(() => (editing.value ? '编辑常用软件' : '添加常用软件'))

const icon = computed(() => (form.target.trim() ? store.quickIconOf(form.target.trim()) : ''))
const initial = computed(() => (form.name.trim() || '?').slice(0, 1).toUpperCase())

const canSubmit = computed(() => !!form.target.trim() && !!form.name.trim())

/** 打开弹窗时按当前模式填值：编辑就回填已有配置，新增就是一张白纸 */
function reset(): void {
  const entry = store.quickEditing
  form.target = entry?.target ?? ''
  form.name = entry?.name ?? ''
  nameTouched.value = !!entry
}

watch(
  () => store.quickDialogVisible,
  (open) => {
    if (open) reset()
  }
)

/** 手输路径时跟着推默认名（选文件走 browse，同样只在没改过名字时覆盖） */
function onTargetInput(): void {
  if (!nameTouched.value) form.name = defaultQuickAppName(form.target)
}

async function browse(): Promise<void> {
  const picked = await window.workbench.pickQuickTarget()
  if (!picked) return

  form.target = picked
  if (!nameTouched.value) form.name = defaultQuickAppName(picked)
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return

  const payload = {
    target: form.target.trim(),
    name: form.name.trim()
  }

  const current = editing.value
  const done = current
    ? await store.updateQuickApp(current.id, payload)
    : await store.addQuickApp(payload)

  if (done) visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title"
    width="520"
    align-center
    :close-on-click-modal="false"
    @closed="reset"
  >
    <div class="form">
      <div class="field">
        <label class="field__label">程序</label>
        <div class="field__row">
          <el-input
            v-model="form.target"
            placeholder="选择一个程序或开始菜单里的快捷方式"
            spellcheck="false"
            @input="onTargetInput"
          />
          <el-button :icon="Monitor" @click="browse">浏览</el-button>
        </div>
        <p class="field__hint">
          支持 .exe、快捷方式（.lnk）与 .bat / .cmd；对话框默认从开始菜单打开。
        </p>
      </div>

      <div class="preview">
        <span class="preview__icon">
          <img v-if="icon" :src="icon" alt="" />
          <template v-else>{{ initial }}</template>
        </span>
        <div class="preview__body">
          <p class="preview__name truncate">{{ form.name.trim() || '未命名' }}</p>
          <p class="preview__path mono truncate" :title="form.target">
            {{ form.target.trim() || '还没有选择程序' }}
          </p>
        </div>
      </div>

      <div class="field">
        <label class="field__label">名称</label>
        <el-input
          v-model="form.name"
          placeholder="显示在首页的名字"
          @input="nameTouched = true"
        />
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">
        {{ editing ? '保存' : '添加' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.field__label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.field__row {
  display: flex;
  gap: var(--sp-2);
}

.field__row :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

.field__hint {
  margin-top: 5px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
}

/* ---------- 预览：选完文件先在这儿看一眼，免得存进去才发现选错了 ---------- */
.preview {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  min-width: 0;
}

.preview__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  color: var(--ink-3);
  font-size: 16px;
  font-weight: 600;
}

.preview__icon img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.preview__body {
  min-width: 0;
}

.preview__name {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.preview__path {
  margin-top: 3px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
