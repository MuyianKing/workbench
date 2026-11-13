<script setup lang="ts">
import { FolderOpened } from '@element-plus/icons-vue'
import { kbSourceNameHint, sanitizeKbName } from '@workbench/kb'
/**
 * 添加一个知识库（工具条那颗「添加知识库」）。
 *
 * 只收「名字 + 本机源头文件夹」两件事：源头是持续关联的（之后改它 → 清洗前应用会把
 * 变化复制进 raw 再上传）。名字是 `raw/` 下的目录名、条目 source 引用的那一截，
 * 所以**名字定了不给改**（换名走「删除 + 重新添加」）。
 *
 * **第一次添加直接清洗，需要二次确认**：表单填完点「添加」不是终点 —— 弹层翻到确认页，
 * 写明「将复制上传并立即清洗（调用 AI）」，点确认才开始干活；不确认就当不添加，
 * 一个字都不会落盘。
 *
 * **名称要与远程清单对得上**：拿清单里已有的名字实时核对（口径在 @workbench/kb 的
 * kbSourceNameHint）—— 完全一致就是同名知识库（拦住）、忽略大小写相同给警告并一键改成
 * 清单里的写法、编辑距离 ≤ 2 提醒可能是笔误。
 */
import { computed, reactive, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'

const props = defineProps<{
  /** 清单里已有的知识库名（跨设备唯一看得见的参照，可点选） */
  referenced: string[]
  /** 本机已配的关联（判「同一个文件夹不挂两个名字」） */
  existing: Array<{ name: string, dir: string }>
  /** 提交后的活儿还在跑（复制 / 上传 / 清洗）：确认按钮转圈、弹层不关 */
  working?: boolean
}>()

const emit = defineEmits<{
  /** 二次确认后提交：名字 + 源头文件夹（复制、上传与首洗由 store 编排） */
  submit: [payload: { name: string, dir: string }]
}>()

/** 打开着没有（v-model，与 AI 模型弹窗同一条写法） */
const visible = defineModel<boolean>({ required: true })

const form = reactive({ name: '', dir: '' })
/** 表单页（false）→ 确认页（true）：二次确认就在弹层里翻一页，不再叠一个框 */
const confirming = ref(false)

const cleanName = computed(() => sanitizeKbName(form.name))
/** 名称核对（只对清单里的名字；本机判重在下面） */
const hint = computed(() => kbSourceNameHint(form.name, props.referenced))
/** 清单里已有同名知识库（精确比较）：名字即目录，同名就是同一个 */
const duplicateName = computed(
  () => !!cleanName.value && props.referenced.includes(cleanName.value),
)
/**
 * 这个文件夹已经挂在别的**活着**的知识库下（Windows 口径不敏感）—— 只认清单里还有的
 * 名字：旧配置的残留（名字不在清单里，多半是失败添加 / 旧模型留下的）不拦，
 * 添加时会被这条新关联顶掉（见 store 的 addLibrary）。
 */
const dirConflict = computed(() => {
  const key = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = key(form.dir)
  if (!target)
    return null
  return props.existing.find(
    link => props.referenced.includes(link.name) && key(link.dir) === target,
  ) ?? null
})

const canSubmit = computed(
  () => !!cleanName.value && !!form.dir.trim() && !duplicateName.value && !dirConflict.value,
)

/** 默认摊开的候选名：清单里已经有的那几个，点一下就是精确写法 */
const candidates = computed(() => props.referenced.filter(Boolean))

function reset(): void {
  form.name = ''
  form.dir = ''
  confirming.value = false
}

watch(visible, (open) => {
  if (open)
    reset()
})

async function browse(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择源头文件夹')
  if (picked)
    form.dir = picked
}

/** 表单页点「添加」：先别干活 —— 翻到确认页，把接下来会发生的事说明白 */
function startConfirm(): void {
  if (!canSubmit.value)
    return
  confirming.value = true
}

function submit(): void {
  if (!canSubmit.value)
    return
  emit('submit', { name: form.name.trim(), dir: form.dir.trim() })
}
</script>

<template>
  <!-- penetrable：路径常要回资源管理器看一眼再抄过来（见 AppDialog.vue） -->
  <AppDialog
    v-model="visible"
    title="添加知识库"
    width="520"
    align-center
    penetrable
    @closed="reset"
  >
    <!-- 表单页 -->
    <el-form v-if="!confirming" class="form" :model="form" label-position="top" @submit.prevent>
      <el-form-item label="名称">
        <el-input
          v-model="form.name"
          placeholder="知识库的名字（也是 raw/ 下的目录名）"
          spellcheck="false"
        />
        <!-- 清单里已有的名字：跨设备身份键，点一下就用那个精确写法 -->
        <div v-if="candidates.length" class="name-candidates">
          <span class="name-candidates__label">清单里已有：</span>
          <button
            v-for="candidate in candidates"
            :key="candidate"
            type="button"
            class="name-candidates__item"
            @click="form.name = candidate"
          >
            {{ candidate }}
          </button>
        </div>
        <!-- 名称核对：完全一致拦住（同名就是同一个）、大小写不同给精确写法、近似提醒可能是笔误 -->
        <p v-if="hint.kind === 'case'" class="field__hint field__hint--warn">
          清单里的写法是 <span class="mono">{{ hint.suggestion }}</span>，你输入的是
          <span class="mono">{{ cleanName }}</span>，名字必须一模一样。
          <button type="button" class="name-fix" @click="form.name = hint.suggestion">
            使用 {{ hint.suggestion }}
          </button>
        </p>
        <p v-else-if="hint.kind === 'close'" class="field__hint field__hint--warn">
          清单里没有这个名字；如果是笔误，最接近的是
          <span class="mono">{{ hint.suggestion }}</span>。
          <button type="button" class="name-fix" @click="form.name = hint.suggestion">
            使用 {{ hint.suggestion }}
          </button>
        </p>
        <p v-if="duplicateName" class="field__hint field__hint--warn">
          清单里已经有叫「{{ cleanName }}」的知识库了；名字即目录，同名就是同一个，换个名字。
        </p>
      </el-form-item>

      <el-form-item label="源头文件夹">
        <div class="field__row">
          <el-input
            v-model="form.dir"
            placeholder="本机存放原始资料的那个文件夹（持续关联）"
            spellcheck="false"
          />
          <el-button :icon="FolderOpened" @click="browse">
            浏览
          </el-button>
        </div>
        <p v-if="dirConflict" class="field__hint field__hint--warn">
          这个文件夹已经关联给「{{ dirConflict.name }}」了，同一个文件夹不能挂两个名字。
        </p>
        <p v-else class="field__hint">
          之后改这个文件夹的内容，清洗前应用会自动把变化复制进仓库并上传。
        </p>
      </el-form-item>
    </el-form>

    <!-- 确认页：把接下来会发生的事说明白，点确认才动手 -->
    <div v-else class="confirm">
      <p class="confirm__lead">
        添加「{{ cleanName }}」后会立刻执行：
      </p>
      <ol class="confirm__steps">
        <li>把 <span class="mono">{{ form.dir.trim() || '源头文件夹' }}</span> 复制进仓库的 <span class="mono">raw/{{ cleanName }}/</span></li>
        <li>登记进清单并<b>上传远程仓库</b></li>
        <li><b>立即清洗</b>：调用 AI，需要一点时间与用量</li>
      </ol>
      <p class="confirm__note">
        清洗要花一点时间与 AI 用量；现在取消的话，这个知识库不会被添加。
      </p>
    </div>

    <template #footer>
      <el-button v-if="confirming" :disabled="working" @click="confirming = false">
        上一步
      </el-button>
      <el-button @click="visible = false">
        取消
      </el-button>
      <el-button
        v-if="confirming"
        type="primary"
        :loading="working"
        @click="submit"
      >
        确认添加并清洗
      </el-button>
      <el-button v-else type="primary" :disabled="!canSubmit" @click="startConfirm">
        添加
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

/* 名称核对：候选名排成一行可点的标签（与 .field__hint 同一档小字） */
.name-candidates {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.name-candidates__item,
.name-fix {
  padding: 0;
  border: none;
  background: none;
  color: var(--ink-2);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.name-candidates__item:hover,
.name-fix:hover {
  color: var(--ink);
}

/* 要留意的那种提示：与「要催」的文案同色（不改结构，只换颜色） */
.field__hint--warn {
  color: var(--st-fail);
}

/* 确认页：三步说明 + 一句取消的后果；排版与表单同一档小字 */
.confirm__lead,
.confirm__note {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}

.confirm__steps {
  margin: var(--sp-3) 0;
  padding-left: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  color: var(--ink);
  font-size: var(--fs-body);
  line-height: 1.7;
}

.confirm__note {
  color: var(--ink-3);
  font-size: var(--fs-meta);
}
</style>
