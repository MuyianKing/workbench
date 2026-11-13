<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import { satisfiesNodeVersion } from '@workbench/core'
import { ElMessage } from 'element-plus'
import { computed } from 'vue'
import { useEnvironmentStore } from '@/stores/environment'
import { useProjectsStore } from '@/stores/projects'

/**
 * 项目详情抽屉的「环境」：包管理器、项目级 Node 版本、版本要求是否满足。
 *
 * 从 `ProjectDrawer.vue` 拆出来的整块。可选版本来自环境 store 的 nvm 探测结果。
 */
const store = useProjectsStore()
const environment = useEnvironmentStore()

const project = computed(() => store.drawerProject)

const pmOptions = [
  { label: '自动检测', value: 'auto' },
  { label: 'npm', value: 'npm' },
  { label: 'yarn', value: 'yarn' },
  { label: 'pnpm', value: 'pnpm' },
]

// ---------- 环境 ----------

/** 系统在用的 node：nvm 软链优先，退回到 node -v 的探测结果 */
const systemNode = computed(
  () => environment.nvm?.current ?? environment.packageManagers?.node?.replace(/^v/, '') ?? '',
)

const installedVersions = computed(() => environment.nvm?.versions ?? [])

/** nvm 可用且真的有已安装版本，才让用户选 */
const nvmUsable = computed(() => !!environment.nvm?.available && installedVersions.value.length > 0)

/** 下拉的绑定值：空字符串代表没选、跟随系统 */
const nodeVersionModel = computed({
  get: () => project.value?.nodeVersion ?? '',
  set: (value: string) => {
    const current = project.value
    if (!current)
      return
    current.nodeVersion = value || undefined
  },
})

const systemNodeLabel = computed(() =>
  systemNode.value ? `跟随系统（v${systemNode.value}）` : '跟随系统',
)

/** 项目要求与实际生效版本（选了 nvm 版本就是那个，否则是系统 node） */
const nodeState = computed(() => {
  const required = project.value?.nodeRequirement?.trim()
  const selected = project.value?.nodeVersion?.trim()
  const actual = selected ? environment.installedNodeVersion(selected) ?? selected : systemNode.value
  if (!required || !actual)
    return null
  return {
    required,
    actual,
    fromProject: !!selected,
    ok: satisfiesNodeVersion(required, actual),
  }
})

function nodeOptionLabel(version: string): string {
  const required = project.value?.nodeRequirement?.trim()
  const tags: string[] = []
  if (version === systemNode.value)
    tags.push('全局当前')
  // 项目没声明要求时，「匹配」说明不了什么，不打标签
  if (required && satisfiesNodeVersion(required, version))
    tags.push('匹配要求')
  return tags.length ? `v${version}（${tags.join(' / ')}）` : `v${version}`
}

/** 当前版本不满足要求时，给出 nvm 里第一个能救场的版本 */
const suggestedNode = computed(() => {
  const state = nodeState.value
  if (!state || state.ok)
    return null
  const current = project.value?.nodeVersion?.trim()
  return (
    installedVersions.value.find(
      (v: string) => v !== current && satisfiesNodeVersion(state.required, v),
    ) ?? null
  )
})

function applySuggestedNode(): void {
  const target = suggestedNode.value
  const current = project.value
  if (!target || !current)
    return

  current.nodeVersion = target
  ElMessage.success(`已改为使用 Node v${target}（仅本项目）`)
}
</script>

<template>
  <section v-if="project" class="block">
    <h3 class="section-title">
      环境
    </h3>

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

      <p v-if="environment.nvm?.available && installedVersions.length" class="field__hint mono">
        nvm 目录 → {{ environment.nvm?.root }}
      </p>
      <p v-else class="field__hint field__hint--warn">
        {{ environment.nvm?.error ?? '未检测到 nvm' }}
      </p>
      <el-button size="small" text :icon="Refresh" @click="environment.refreshNvm()">
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
</template>
