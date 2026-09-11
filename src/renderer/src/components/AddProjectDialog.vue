<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FolderOpened, Plus } from '@element-plus/icons-vue'
import { BUILD_TOOL_LABEL } from '@shared/dev-port'
import { parsePort } from '@shared/port'
import { samePath } from '@shared/project-path'
import { useProjectsStore } from '@/stores/projects'
import type { ScanResult } from '@/types'

const store = useProjectsStore()

const form = reactive({
  path: '',
  name: '',
  groupId: undefined as string | undefined,
  serve: undefined as string | undefined,
  build: [] as string[],
  /** 监听端口先按字符串收，提交时再校验；空串表示不检测 */
  port: ''
})

const scan = ref<ScanResult | null>(null)
const scanError = ref('')
const scanning = ref(false)
/** 用户手动改过显示名后，不再被扫描结果覆盖 */
const nameTouched = ref(false)
/** package.json 解析失败时，是否以「仅管理目录」的方式加入（设计文档 §7） */
const allowInvalid = ref(false)

const visible = computed({
  get: () => store.addDialogVisible,
  set: (v: boolean) => (store.addDialogVisible = v)
})

const allScripts = computed(() => scan.value?.allScripts ?? [])

/** 解析失败的项目只能管目录，不能执行命令，所以要用户显式勾选 */
const parseFailed = computed(() => !!scan.value?.parseError)

/** 选中的目录已经在列表里了；重复添加没有意义，在选路径这一步就拦掉 */
const duplicate = computed(() => {
  const target = form.path.trim()
  if (!target) return null
  return store.projects.find((project) => samePath(project.path, target)) ?? null
})

const canSubmit = computed(() => {
  if (scanning.value || !form.name.trim() || duplicate.value) return false
  if (scan.value?.ok) return true
  return allowInvalid.value && parseFailed.value
})

async function runScan(dirPath: string): Promise<void> {
  const target = dirPath.trim()
  scan.value = null
  scanError.value = ''
  allowInvalid.value = false

  if (!target) return

  scanning.value = true
  const result = await window.workbench.scanProject(target)
  scanning.value = false

  if (!result.ok || !result.data) {
    scanError.value = result.error ?? '扫描失败'
    return
  }

  if (!result.data.ok) {
    scanError.value = result.data.error ?? '该目录不是有效的 Node 项目'
    if (result.data.parseError) {
      // 解析失败仍允许加入，保留扫描结果供「仅管理目录」分支使用
      scan.value = result.data
      if (!nameTouched.value) form.name = result.data.name
    }
    return
  }

  scan.value = result.data
  if (!nameTouched.value) form.name = result.data.name
  form.serve = result.data.serve
  form.build = result.data.build.length ? [...result.data.build] : []
  form.port = result.data.port ? String(result.data.port) : ''
}

/** 端口那行的说明：讲清楚它是从哪儿认出来的，还是按默认值推测的 */
const portHint = computed(() => {
  const result = scan.value
  if (!result?.port) {
    return '用于判断项目是否已在运行；留空表示不检测，之后也可以在项目详情里补。'
  }

  const tool = result.buildTool ? BUILD_TOOL_LABEL[result.buildTool] : '构建工具'
  if (result.portFrom === 'config') {
    return `自动识别自 ${result.portFile}（${tool} 的监听端口）。`
  }
  if (result.portFrom === 'script') {
    return '自动识别自启动脚本里的 --port 参数。'
  }
  return `配置里没写端口，按 ${tool} 的默认值推测；端口被占时工具会自动换一个，请以实际为准。`
})

async function pickDirectory(): Promise<void> {
  const picked = await window.workbench.pickDirectory()
  if (!picked) return
  form.path = picked
  nameTouched.value = false
  await runScan(picked)
}

/** 就地新建分组并自动选中，省去先去别处建好再回来挑的来回 */
async function newGroup(): Promise<void> {
  let name: string
  try {
    const { value } = await ElMessageBox.prompt('请输入分组名称', '新建分组', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPlaceholder: '如：工作中 / 客户项目',
      inputValidator: (value: string) => (value.trim() ? true : '分组名不能为空')
    })
    name = value.trim()
  } catch {
    return // 用户取消
  }

  const group = await store.createGroup(name)
  if (group) form.groupId = group.id
}

watch(
  () => form.path,
  (path, previous) => {
    if (path === previous) return
    // 仅当路径像是一个完整目录时自动扫描，避免边输入边读盘
    if (/^[A-Za-z]:[\\/]/.test(path.trim())) void runScan(path)
  }
)

function reset(): void {
  form.path = ''
  form.name = ''
  form.groupId = undefined
  form.serve = undefined
  form.build = []
  form.port = ''
  scan.value = null
  scanError.value = ''
  scanning.value = false
  nameTouched.value = false
  allowInvalid.value = false
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return

  const rawPort = form.port.trim()
  if (rawPort && !parsePort(rawPort)) {
    ElMessage.warning('监听端口需为 1–65535 的整数，或留空表示不检测')
    return
  }

  const added = await store.addProject({
    path: form.path.trim(),
    name: form.name.trim(),
    groupId: form.groupId,
    serve: form.serve,
    build: form.build,
    defaultBuild: form.build[0],
    port: rawPort ? parsePort(rawPort) : null,
    allowInvalid: allowInvalid.value
  })

  if (added) visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="添加项目"
    width="560"
    align-center
    :close-on-click-modal="false"
    @closed="reset"
  >
    <div class="form">
      <div class="field">
        <label class="field__label">项目目录</label>
        <div class="field__row">
          <el-input
            v-model="form.path"
            placeholder="选择包含 package.json 的项目根目录"
            spellcheck="false"
            @keydown.enter="runScan(form.path)"
          />
          <el-button :icon="FolderOpened" @click="pickDirectory">浏览</el-button>
        </div>
      </div>

      <p v-if="duplicate" class="hint hint--error">
        该目录已经在项目列表里了（「{{ duplicate.name }}」），不能重复添加。
      </p>
      <p v-else-if="scanning" class="hint">正在读取 package.json…</p>
      <p v-else-if="scanError" class="hint hint--error">{{ scanError }}</p>

      <el-alert
        v-if="parseFailed"
        class="alert"
        type="warning"
        :closable="false"
        show-icon
        title="也可以只把目录纳入管理"
        description="勾选下方选项后，Workbench 只记录这个目录、不执行任何命令；等 package.json 修好后，可在详情抽屉里用「重新定位」重新识别。"
      />

      <template v-if="scan && (scan.ok || parseFailed) && !duplicate">
        <div class="field">
          <label class="field__label">显示名</label>
          <el-input
            v-model="form.name"
            placeholder="列表中展示的名称"
            @input="nameTouched = true"
          />
        </div>

        <div class="field">
          <label class="field__label">分组</label>
          <div class="field__row">
            <el-select v-model="form.groupId" placeholder="未分组" clearable>
              <el-option
                v-for="g in store.sortedGroups"
                :key="g.id"
                :label="g.name"
                :value="g.id"
              />
            </el-select>
            <el-button :icon="Plus" @click="newGroup">新建分组</el-button>
          </div>
        </div>

        <el-checkbox v-if="parseFailed" v-model="allowInvalid" class="allow">
          以「仅管理目录」方式加入（不执行命令）
        </el-checkbox>

        <div v-if="scan.ok" class="scan">
          <div class="scan__head">
            <span class="eyebrow">自动识别结果</span>
            <span class="scan__pm mono">
              {{ scan.detectedPackageManager }}
              <template v-if="scan.lockFile"> · 依据 {{ scan.lockFile }}</template>
              <template v-else> · 未检测到锁文件</template>
            </span>
          </div>

          <ul class="scan__facts mono">
            <li>{{ scan.framework }}</li>
            <li>v{{ scan.version }}</li>
            <li v-if="scan.outputDir">产物 {{ scan.outputDir }}</li>
            <li v-else>未探测到产物目录</li>
            <li v-if="scan.enginesNode">
              node {{ scan.enginesNode }}
              <template v-if="scan.nodeRequirementFrom === 'nvmrc'">（来自 .nvmrc）</template>
            </li>
          </ul>

          <div class="field">
            <label class="field__label">启动命令</label>
            <el-select
              v-model="form.serve"
              placeholder="未识别到启动脚本"
              clearable
              style="width: 100%"
            >
              <el-option v-for="s in allScripts" :key="s" :label="s" :value="s" />
            </el-select>
            <p v-if="!scan.serve" class="field__hint">
              scripts 中没有 serve / dev / start，请手动指定。
            </p>
          </div>

          <div class="field">
            <label class="field__label">监听端口</label>
            <el-input v-model="form.port" placeholder="留空表示不检测" spellcheck="false" />
            <p class="field__hint">{{ portHint }}</p>
          </div>

          <div class="field">
            <label class="field__label">打包命令</label>
            <el-select
              v-model="form.build"
              multiple
              placeholder="未识别到打包脚本"
              style="width: 100%"
            >
              <el-option v-for="s in allScripts" :key="s" :label="s" :value="s" />
            </el-select>
            <p class="field__hint">可多选；列表中的第一条作为默认打包命令。</p>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">添加项目</el-button>
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
}

.field__row :deep(.el-select) {
  flex: 1;
  min-width: 0;
}

.field__hint {
  margin-top: 5px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.hint {
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.hint--error {
  color: var(--st-fail);
}

.alert {
  margin-bottom: var(--sp-1);
}

.allow {
  align-self: flex-start;
}

.allow :deep(.el-checkbox__label) {
  font-size: var(--fs-body);
}

.scan {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.scan__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.scan__pm {
  font-size: var(--fs-micro);
  color: var(--ink-2);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  padding: 2px 9px;
}

.scan__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.scan__facts li + li::before {
  content: '·';
  margin-right: var(--sp-2);
  color: var(--border-strong);
}
</style>
