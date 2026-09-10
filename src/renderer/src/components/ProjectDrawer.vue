<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Box,
  Close,
  Download,
  FolderOpened,
  Plus,
  Refresh,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue'
import { satisfiesNodeVersion } from '@shared/node-version'
import { useProjectsStore } from '@/stores/projects'
import type { ProjectStatus, RunRecord } from '@/types'

const store = useProjectsStore()

/** 抽屉关闭动画期间仍需项目数据，因此用本地开关驱动，动画结束后再清空选中项 */
const visible = ref(false)

watch(
  () => store.drawerProjectId,
  (id) => {
    if (id) visible.value = true
  }
)

onMounted(() => {
  visible.value = !!store.drawerProjectId
})

const project = computed(() => store.drawerProject)
const runtime = computed(() => (project.value ? store.runtimeOf(project.value.id) : null))
const status = computed<ProjectStatus>(() => runtime.value?.status ?? 'idle')
const isBusy = computed(() => status.value === 'installing' || status.value === 'building')
const isRunning = computed(() => status.value === 'running')
const pathValid = computed(() => (project.value ? store.isPathValid(project.value.id) : true))

/** 显示名先落在本地草稿，回车或失焦才提交，避免半截名字被写进磁盘 */
const nameDraft = ref('')

watch(
  () => project.value?.id,
  () => {
    nameDraft.value = project.value?.name ?? ''
  },
  { immediate: true }
)

function commitName(): void {
  const current = project.value
  if (!current) return

  const next = nameDraft.value.trim()
  if (!next) {
    nameDraft.value = current.name // 空名不是有效修改，回退
    return
  }
  if (next !== current.name) {
    current.name = next
    store.warnIfDuplicateName(current)
  }
}

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
  { immediate: true }
)

const serveOptions = computed(() => {
  const set = new Set(allScripts.value)
  if (project.value?.scripts.serve) set.add(project.value.scripts.serve)
  return [...set]
})

const buildOptions = computed(() => {
  const set = new Set(allScripts.value)
  for (const name of project.value?.scripts.build ?? []) set.add(name)
  return [...set]
})

const STATUS_LABEL: Record<ProjectStatus, string> = {
  idle: '空闲',
  installing: '安装中',
  running: '运行中',
  building: '打包中',
  success: '打包成功',
  failed: '执行失败'
}

const tone = computed(() => {
  if (!pathValid.value) return 'fail'
  const s = status.value
  if (s === 'failed') return 'fail'
  if (s === 'success') return 'ok'
  if (s === 'idle') return 'idle'
  return 'run'
})

const pmOptions = [
  { label: '自动检测', value: 'auto' },
  { label: 'npm', value: 'npm' },
  { label: 'yarn', value: 'yarn' },
  { label: 'pnpm', value: 'pnpm' }
]

const history = computed<RunRecord[]>(() => project.value?.history ?? [])

const RESULT_META: Record<RunRecord['result'], { label: string; tone: string }> = {
  success: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'fail' },
  stopped: { label: '已停止', tone: 'idle' }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(ms?: number): string {
  if (!ms) return '—'
  return `${(ms / 1000).toFixed(1)}s`
}

function close(): void {
  visible.value = false
}

function onClosed(): void {
  store.closeDrawer()
}

function restart(): void {
  const current = project.value
  if (current) void store.restart(current.id)
}

function onBuild(script?: unknown): void {
  const current = project.value
  if (current) void store.build(current.id, typeof script === 'string' ? script : undefined)
}

// ---------- 自定义命令（F-2.6） ----------

const customDraft = ref({ name: '', command: '' })

const customs = computed(() => project.value?.scripts.custom ?? [])

function addCustom(): void {
  const current = project.value
  if (!current) return

  const name = customDraft.value.name.trim()
  const command = customDraft.value.command.trim()
  if (!name || !command) {
    ElMessage.warning('命令名称与命令行都要填写')
    return
  }
  if (customs.value.some((item) => item.name === name)) {
    ElMessage.warning(`已存在同名命令「${name}」`)
    return
  }

  // 整个数组替换：scripts 是嵌套对象，直接 push 也能被 watch 捕获，但显式赋值更直观
  current.scripts.custom = [...customs.value, { name, command }]
  customDraft.value = { name: '', command: '' }
}

function removeCustom(index: number): void {
  const current = project.value
  if (!current) return
  current.scripts.custom = customs.value.filter((_, i) => i !== index)
}

function runCustom(index: number): void {
  const current = project.value
  if (current) void store.runCustom(current.id, index)
}

// ---------- 环境 ----------

/** 系统在用的 node：nvm 软链优先，退回到 node -v 的探测结果 */
const systemNode = computed(
  () => store.nvm?.current ?? store.packageManagers?.node?.replace(/^v/, '') ?? ''
)

const installedVersions = computed(() => store.nvm?.versions ?? [])

/** nvm 可用且真的有已安装版本，才让用户选 */
const nvmUsable = computed(() => !!store.nvm?.available && installedVersions.value.length > 0)

/** 下拉的绑定值：空字符串代表没选、跟随系统 */
const nodeVersionModel = computed({
  get: () => project.value?.nodeVersion ?? '',
  set: (value: string) => {
    const current = project.value
    if (!current) return
    current.nodeVersion = value || undefined
  }
})

const systemNodeLabel = computed(() =>
  systemNode.value ? `跟随系统（v${systemNode.value}）` : '跟随系统'
)

/** 项目要求与实际生效版本（选了 nvm 版本就是那个，否则是系统 node） */
const nodeState = computed(() => {
  const required = project.value?.nodeRequirement?.trim()
  const selected = project.value?.nodeVersion?.trim()
  const actual = selected ? store.installedNodeVersion(selected) ?? selected : systemNode.value
  if (!required || !actual) return null
  return {
    required,
    actual,
    fromProject: !!selected,
    ok: satisfiesNodeVersion(required, actual)
  }
})

function nodeOptionLabel(version: string): string {
  const required = project.value?.nodeRequirement?.trim()
  const tags: string[] = []
  if (version === systemNode.value) tags.push('全局当前')
  // 项目没声明要求时，「匹配」说明不了什么，不打标签
  if (required && satisfiesNodeVersion(required, version)) tags.push('匹配要求')
  return tags.length ? `v${version}（${tags.join(' / ')}）` : `v${version}`
}

/** 当前版本不满足要求时，给出 nvm 里第一个能救场的版本 */
const suggestedNode = computed(() => {
  const state = nodeState.value
  if (!state || state.ok) return null
  const current = project.value?.nodeVersion?.trim()
  return (
    installedVersions.value.find(
      (v) => v !== current && satisfiesNodeVersion(state.required, v)
    ) ?? null
  )
})

function applySuggestedNode(): void {
  const target = suggestedNode.value
  const current = project.value
  if (!target || !current) return

  current.nodeVersion = target
  ElMessage.success(`已改为使用 Node v${target}（仅本项目）`)
}

async function relocate(): Promise<void> {
  const current = project.value
  if (current) await store.relocate(current.id)
}

async function removeProject(): Promise<void> {
  const current = project.value
  if (!current) return

  try {
    await ElMessageBox.confirm(
      `确定把「${current.name}」从列表中移除？磁盘上的项目文件不会被删除。`,
      '移除项目',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }

  visible.value = false
  await store.removeProject(current.id)
}
</script>

<template>
  <el-drawer v-model="visible" :with-header="false" :size="420" direction="rtl" @closed="onClosed">
    <div v-if="project" class="drawer">
      <!-- 头部 -->
      <header class="drawer__head">
        <div class="drawer__identity">
          <h2 class="drawer__name truncate">{{ project.name }}</h2>
          <span class="drawer__path mono truncate" :title="project.path">{{ project.path }}</span>
        </div>
        <el-button class="icon-btn" :icon="Close" text aria-label="关闭" @click="close" />
      </header>

      <div class="drawer__status">
        <span class="pill" :class="`tone-${tone}`">
          <i class="pill__dot" />
          {{ pathValid ? STATUS_LABEL[status] : '路径无效' }}
        </span>
        <span v-if="runtime?.pid" class="mono drawer__pid">PID {{ runtime.pid }}</span>
        <el-button
          class="drawer__reveal"
          size="small"
          :icon="FolderOpened"
          text
          :disabled="!pathValid"
          @click="store.reveal(project.path)"
        >
          打开目录
        </el-button>
      </div>

      <p v-if="project.manageOnly" class="drawer__notice">
        这个项目是以「仅管理目录」加入的：package.json 无法解析，Workbench 只能帮你管目录，
        不会执行任何命令。修好 package.json 后可用「重新定位」重新识别。
      </p>

      <!-- 主操作 -->
      <div class="drawer__actions">
        <el-button
          v-if="!isRunning"
          type="primary"
          :icon="VideoPlay"
          :disabled="isBusy || !pathValid || !project.scripts.serve || !!project.manageOnly"
          @click="store.start(project.id)"
        >
          启动
        </el-button>
        <template v-else>
          <el-button :icon="VideoPause" @click="store.stop(project.id)">停止</el-button>
          <el-button :icon="Refresh" @click="restart">重启</el-button>
        </template>

        <el-dropdown
          split-button
          :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly || !project.scripts.build.length"
          @click="onBuild()"
          @command="onBuild"
        >
          <span class="drawer__build"><el-icon><Box /></el-icon>打包</span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="s in project.scripts.build"
                :key="s"
                :command="s"
                :class="{ 'is-current': s === project.scripts.defaultBuild }"
              >
                {{ s }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-button
          :icon="Download"
          :loading="status === 'installing'"
          :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly"
          @click="store.install(project.id)"
        >
          安装依赖
        </el-button>
      </div>

      <div class="drawer__scroll">
        <!-- 基本信息 -->
        <section class="block">
          <h3 class="section-title">基本信息</h3>

          <div class="field">
            <label class="field__label">显示名</label>
            <el-input
              v-model="nameDraft"
              size="small"
              maxlength="60"
              spellcheck="false"
              placeholder="列表中展示的名称"
              @blur="commitName"
              @keydown.enter="commitName"
            />
            <p class="field__hint">改完按回车生效，留空会还原。</p>
          </div>

          <div class="field">
            <label class="field__label">分组</label>
            <el-select
              v-model="project.groupId"
              size="small"
              placeholder="未分组"
              clearable
              style="width: 100%"
            >
              <el-option
                v-for="g in store.sortedGroups"
                :key="g.id"
                :label="g.name"
                :value="g.id"
              />
            </el-select>
          </div>

          <div v-if="!pathValid" class="field field__warn">
            <p class="field__hint field__hint--warn">
              项目目录已不存在或被移动，启动 / 打包 / 安装已禁用。
            </p>
            <el-button size="small" :icon="FolderOpened" @click="relocate">重新定位</el-button>
          </div>
        </section>

        <!-- 命令配置 -->
        <section class="block">
          <h3 class="section-title">命令配置</h3>

          <div class="field">
            <label class="field__label">启动命令</label>
            <el-select
              v-model="project.scripts.serve"
              size="small"
              placeholder="未配置"
              clearable
              style="width: 100%"
            >
              <el-option v-for="s in serveOptions" :key="s" :label="s" :value="s" />
            </el-select>
            <p class="field__hint">来自 package.json 的 scripts，可手动指定。</p>
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
              <el-option v-for="s in buildOptions" :key="s" :label="s" :value="s" />
            </el-select>
            <p class="field__hint">勾选多条后，卡片上的「打包」可通过下拉切换。</p>
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
              <el-option v-for="s in project.scripts.build" :key="s" :label="s" :value="s" />
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
                  :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly"
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
            <p v-else class="field__hint">
              还没有自定义命令。常用的检查 / 发布命令挂到这里后，卡片「⋯」菜单里可以一键运行。
            </p>

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
              <el-button size="small" :icon="Plus" @click="addCustom">添加</el-button>
            </div>
          </div>
        </section>

        <!-- 环境 -->
        <section class="block">
          <h3 class="section-title">环境</h3>

          <div class="field">
            <label class="field__label">包管理器</label>
            <el-select v-model="project.packageManager" size="small" style="width: 100%">
              <el-option v-for="o in pmOptions" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <p class="field__hint mono">
              自动检测结果 → {{ project.detectedPackageManager }}（依据锁文件）
            </p>
          </div>

          <div class="field">
            <label class="field__label">Node 版本</label>
            <el-select
              v-model="nodeVersionModel"
              size="small"
              style="width: 100%"
              :disabled="!nvmUsable"
              placeholder="未检测到可用的 nvm 版本"
            >
              <el-option :label="systemNodeLabel" value="" />
              <el-option
                v-for="v in installedVersions"
                :key="v"
                :label="nodeOptionLabel(v)"
                :value="v"
              />
            </el-select>

            <p class="field__hint">
              只在本项目执行命令时生效：启动 / 打包 / 安装 / 自定义命令都会把该版本目录前置到
              PATH。不改全局 node，也不需要管理员权限，多个项目可以同时跑不同版本。
            </p>

            <p v-if="store.nvm?.available && installedVersions.length" class="field__hint mono">
              nvm 目录 → {{ store.nvm?.root }}
            </p>
            <p v-else class="field__hint field__hint--warn">
              {{ store.nvm?.error ?? '未检测到 nvm' }}
            </p>
            <el-button size="small" text :icon="Refresh" @click="store.refreshNvm()">
              重新检测
            </el-button>
          </div>

          <div v-if="nodeState" class="field">
            <label class="field__label">Node 版本要求</label>
            <p class="field__hint" :class="{ 'field__hint--warn': !nodeState.ok }">
              要求 {{ nodeState.required }}，{{ nodeState.fromProject ? '本项目' : '系统' }}当前
              {{ nodeState.actual }}{{ nodeState.ok ? '' : '（不满足，启动可能失败）' }}
            </p>
            <el-button
              v-if="suggestedNode"
              size="small"
              text
              type="primary"
              @click="applySuggestedNode"
            >
              改用已安装的 v{{ suggestedNode }}
            </el-button>
          </div>
        </section>

        <!-- 打包输出 -->
        <section class="block">
          <h3 class="section-title">打包输出</h3>

          <div class="field">
            <label class="field__label">输出目录</label>
            <el-input
              v-model="project.outputDir"
              size="small"
              placeholder="留空则自动探测（dist 等）"
            />
          </div>

          <div class="field field--row">
            <label class="field__label">打包完成后打开资源管理器</label>
            <el-switch v-model="project.autoOpenExplorer" size="small" />
          </div>
        </section>

        <!-- 运行记录 -->
        <section class="block">
          <h3 class="section-title">运行记录</h3>

          <ul v-if="history.length" class="history">
            <li v-for="record in history" :key="record.id" class="history__row">
              <span class="history__result" :class="`tone-${RESULT_META[record.result].tone}`">
                {{ RESULT_META[record.result].label }}
              </span>
              <span class="history__cmd mono truncate" :title="record.command">
                {{ record.command }}
              </span>
              <span class="history__meta mono">
                {{ formatTime(record.startedAt) }} · {{ formatDuration(record.durationMs) }}
              </span>
            </li>
          </ul>
          <p v-else class="field__hint">还没有执行记录。</p>
        </section>

        <!-- 危险操作 -->
        <section class="block">
          <h3 class="section-title">危险操作</h3>
          <el-button type="danger" size="small" @click="removeProject">从列表中移除</el-button>
          <p class="field__hint">仅从 Workbench 列表移除，不会删除磁盘上的项目文件。</p>
        </section>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-surface);
}

/* ---------- 头部 ---------- */
.drawer__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
}

.drawer__identity {
  min-width: 0;
  flex: 1;
}

.drawer__name {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.drawer__path {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.drawer__status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-3);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: var(--r-pill);
  font-size: var(--fs-meta);
  font-weight: 500;
  background: var(--st-idle-soft);
  color: var(--ink-3);
}

.pill__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}

.pill.tone-run {
  background: var(--st-run-soft);
  color: var(--st-run);
}

.pill.tone-ok {
  background: var(--st-ok-soft);
  color: var(--st-ok);
}

.pill.tone-fail {
  background: var(--st-fail-soft);
  color: var(--st-fail);
}

.drawer__pid {
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.drawer__reveal {
  margin-left: auto;
}

.drawer__actions {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-4);
  border-bottom: 1px solid var(--border);
}

/* 「仅管理目录」的说明条：把原因讲清楚，别让用户对着灰按钮猜 */
.drawer__notice {
  margin: 0 var(--sp-4) var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--st-run);
  border-radius: var(--r-sm);
  background: var(--st-run-soft);
  font-size: var(--fs-meta);
  line-height: 1.7;
  color: var(--ink-2);
}

.drawer__build {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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

/* ---------- 内容区 ---------- */
.drawer__scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-4);
}

.block + .block {
  margin-top: var(--sp-6);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--border);
}

/* 区块大标题：15px 正黑，和下面的字段标签拉开层次 */
.section-title {
  margin-bottom: var(--sp-3);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.field + .field {
  margin-top: var(--sp-4);
}

.field__label {
  display: block;
  margin-bottom: 7px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--ink-2);
}

.field__hint {
  margin-top: 6px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
  line-height: 1.7;
}

.field__hint--warn {
  color: var(--st-fail);
}

.field__value {
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.field__warn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
}

.field--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.field--row .field__label {
  margin-bottom: 0;
}

/* ---------- 运行记录 ---------- */
.history {
  display: flex;
  flex-direction: column;
}

.history__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 9px 0;
  font-size: var(--fs-body);
}

.history__row + .history__row {
  border-top: 1px solid var(--border);
}

.history__result {
  flex-shrink: 0;
  width: 46px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.history__result.tone-ok {
  color: var(--st-ok);
}

.history__result.tone-fail {
  color: var(--st-fail);
}

.history__cmd {
  flex: 1;
  min-width: 0;
  color: var(--ink-2);
}

.history__meta {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.icon-btn {
  width: 28px;
  padding: 0;
  flex-shrink: 0;
}
</style>
