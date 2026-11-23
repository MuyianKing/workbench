<script setup lang="ts">
import { Close, Operation, Plus, VideoPlay } from '@element-plus/icons-vue'
import { commandLabel, customRef } from '@workbench/core'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { isBusyStatus } from '@/status'
import { useProjectsStore } from '@/stores/projects'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 项目详情抽屉的「命令配置」：启动 / 打包命令、监听端口（只读）、自定义命令。
 *
 * 从 `ProjectDrawer.vue` 拆出来的整块。启动 / 打包下拉的候选既有 package.json 的 scripts，
 * 也有项目里配的自定义命令（编码成 `@custom:<i>`，原始命令行执行，不以 node 为前提）；
 * 前者进抽屉时扫一次盘，后者直接读 store 里那个项目对象。
 */
const store = useProjectsStore()
const terminal = useTerminalStore()

const project = computed(() => store.drawerProject)
const runtime = computed(() => (project.value ? terminal.runtimeOf(project.value.id) : null))
const pathValid = computed(() => (project.value ? store.isPathValid(project.value.id) : true))
const isBusy = computed(() => isBusyStatus(runtime.value?.status ?? 'idle'))
const isRunning = computed(() => runtime.value?.status === 'running')

/** 从磁盘重新读取 scripts 作为下拉候选，保证是项目真实存在的命令 */
const allScripts = ref<string[]>([])

watch(
  () => project.value?.id,
  async (id) => {
    const current = project.value
    if (!id || !current || !store.isPathValid(id)) {
      allScripts.value = []
      return
    }
    const result = await window.workbench.scanProject(current.path)
    const scan = result.ok ? result.data : undefined
    allScripts.value = scan?.ok ? scan.allScripts : []
  },
  { immediate: true },
)

/** 下拉候选：scripts 名用原名，自定义命令显示成「自定义：名称」，值是 @custom:<i> 引用 */
interface CommandOption { value: string, label: string }

const customs = computed(() => project.value?.scripts.custom ?? [])

function customOptions(): CommandOption[] {
  return customs.value.map((entry, index) => ({ value: customRef(index), label: `自定义：${entry.name}` }))
}

const serveOptions = computed<CommandOption[]>(() => {
  const set = new Map<string, string>()
  for (const s of allScripts.value) set.set(s, s)
  if (project.value?.scripts.serve)
    set.set(project.value.scripts.serve, commandLabel(project.value.scripts.serve, customs.value))
  for (const opt of customOptions()) set.set(opt.value, opt.label)
  return [...set].map(([value, label]) => ({ value, label }))
})

const buildOptions = computed<CommandOption[]>(() => {
  const set = new Map<string, string>()
  for (const name of allScripts.value) set.set(name, name)
  for (const name of project.value?.scripts.build ?? [])
    set.set(name, commandLabel(name, customs.value))
  for (const opt of customOptions()) set.set(opt.value, opt.label)
  return [...set].map(([value, label]) => ({ value, label }))
})

const defaultBuildOptions = computed<CommandOption[]>(() =>
  (project.value?.scripts.build ?? []).map(name => ({
    value: name,
    label: commandLabel(name, customs.value),
  })),
)

// ---------- 监听端口 ----------

/**
 * 端口由应用自己维护（启动后从日志写回、停止时清空），这里只读：
 * 运行态里那个是本次认出的；没有运行态还留着值，就是上次运行留下的。
 */
const portText = computed(() => {
  const port = runtime.value?.port ?? project.value?.port
  if (!port)
    return '未识别'
  return runtime.value?.port ? `:${port}` : `:${port}（上次运行）`
})

// ---------- 自定义命令（F-2.6） ----------

const customDraft = ref({ name: '', command: '' })

function addCustom(): void {
  const current = project.value
  if (!current)
    return

  const name = customDraft.value.name.trim()
  const command = customDraft.value.command.trim()
  if (!name || !command) {
    ElMessage.warning('命令名称与命令行都要填写')
    return
  }
  if (customs.value.some(item => item.name === name)) {
    ElMessage.warning(`已存在同名命令「${name}」`)
    return
  }

  // 整个数组替换：scripts 是嵌套对象，直接 push 也能被 watch 捕获，但显式赋值更直观
  current.scripts.custom = [...customs.value, { name, command }]
  customDraft.value = { name: '', command: '' }
}

function removeCustom(index: number): void {
  const current = project.value
  if (!current)
    return
  current.scripts.custom = customs.value.filter((_: unknown, i: number) => i !== index)
}

function runCustom(index: number): void {
  const current = project.value
  if (current)
    void store.runCustom(current.id, index)
}
</script>

<template>
  <section v-if="project" class="block">
    <h3 class="section-title">
      命令配置
    </h3>

    <div class="field">
      <label class="field__label">启动命令</label>
      <el-select
        v-model="project.scripts.serve"
        size="small"
        placeholder="未配置"
        clearable
        style="width: 100%"
      >
        <el-option v-for="opt in serveOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <p class="field__hint">
        来自 package.json 的 scripts，或下方添加的自定义命令（原始命令行，不依赖 node）。
      </p>
    </div>

    <div class="field">
      <label class="field__label">监听端口</label>
      <p class="port mono" :class="{ 'port--empty': portText === '未识别' }">
        {{ portText }}
      </p>
    </div>

    <div class="field">
      <label class="field__label">打包命令</label>
      <el-select
        v-model="project.scripts.build"
        size="small"
        multiple
        collapse-tags
        placeholder="未配置"
        style="width: 100%"
      >
        <el-option v-for="opt in buildOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <p class="field__hint">
        勾选多条后，卡片上的「打包」可通过下拉切换；自定义命令按原始命令行执行。
      </p>
    </div>

    <div class="field">
      <label class="field__label">默认打包命令</label>
      <el-select
        v-model="project.scripts.defaultBuild"
        size="small"
        placeholder="未配置"
        clearable
        style="width: 100%"
      >
        <el-option v-for="opt in defaultBuildOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
    </div>

    <div class="field">
      <label class="field__label">自定义命令</label>

      <ul v-if="customs.length" class="customs">
        <li
          v-for="(item, index) in customs"
          :key="`${item.name}-${index}`"
          class="customs__row"
        >
          <div class="customs__text">
            <span class="customs__name truncate">{{ item.name }}</span>
            <span class="customs__cmd mono truncate" :title="item.command">
              {{ item.command }}
            </span>
          </div>
          <el-button
            class="icon-btn"
            size="small"
            :icon="VideoPlay"
            text
            :disabled="isBusy || isRunning || !pathValid"
            aria-label="运行该命令"
            @click="runCustom(index)"
          />
          <el-button
            class="icon-btn"
            size="small"
            :icon="Close"
            text
            aria-label="删除该命令"
            @click="removeCustom(index)"
          />
        </li>
      </ul>
      <div v-else class="empty customs__empty">
        <el-icon class="empty__icon">
          <Operation />
        </el-icon>
        <p>还没有自定义命令。常用的检查 / 发布命令挂到这里后，卡片「⋯」菜单里可以一键运行。</p>
      </div>

      <div class="customs__form">
        <el-input
          v-model="customDraft.name"
          class="customs__input-name"
          size="small"
          placeholder="名称"
          spellcheck="false"
        />
        <el-input
          v-model="customDraft.command"
          size="small"
          placeholder="命令行，如 npm run type-check"
          spellcheck="false"
        />
        <el-button size="small" :icon="Plus" @click="addCustom">
          添加
        </el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 监听端口只读展示：应用自己写回 / 清空，不提供输入框（见 docs/modules/projects.md） */
.port {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.port--empty {
  color: var(--ink-3);
}

/* ---------- 自定义命令 ---------- */
.customs__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}

.customs__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.customs__name {
  font-size: var(--fs-body);
  color: var(--ink);
}

.customs__cmd {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.customs__form {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.customs__form :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

/* 名称是个短词，固定 110px；省下来的宽度全给命令行（flex-basis 会盖掉 width，所以要一起改） */
.customs__form :deep(.el-input.customs__input-name) {
  flex: 0 0 110px;
  width: 110px;
}

/* 自定义命令的空栏：表单格里塞不下整页那档的图，收成面板那一档 */
.customs__empty {
  flex: none;
  gap: var(--sp-1);
  padding: var(--sp-2) 0;
}

.customs__empty .empty__icon {
  font-size: 26px;
}

.customs__empty p {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
  line-height: 1.7;
}

.icon-btn {
  width: 28px;
  padding: 0;
  flex-shrink: 0;
}
</style>
