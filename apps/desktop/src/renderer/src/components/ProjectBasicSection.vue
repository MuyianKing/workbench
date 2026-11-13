<script setup lang="ts">
import type { ProjectColorPreset } from '@workbench/core'
import { FolderOpened } from '@element-plus/icons-vue'
import { isProjectColorPreset, PROJECT_COLOR_LABELS, PROJECT_COLOR_PRESETS, projectColorVar, sanitizeProjectColor } from '@workbench/core'
import { computed } from 'vue'
import { useDraftField } from '@/composables/use-draft-field'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

/**
 * 项目详情抽屉的「基本信息」：显示名、分组、标识色、首页开关、路径失效后的重新定位。
 *
 * 从 `ProjectDrawer.vue` 拆出来的整块。项目对象就是 store 里那一个（就地改），
 * 与抽屉其它区块同一份，不需要 props 传递。
 */
const store = useProjectsStore()
const settings = useSettingsStore()

const project = computed(() => store.drawerProject)
const pathValid = computed(() => (project.value ? store.isPathValid(project.value.id) : true))

/** 显示名先落在本地草稿，回车或失焦才提交，避免半截名字被写进磁盘 */
const nameDraft = useDraftField(
  () => project.value?.id ?? '',
  () => project.value?.name ?? '',
)

function commitName(): void {
  const current = project.value
  if (!current)
    return

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

/** 「在首页展示」开关：写动作归 store（与项目卡「⋯」菜单同一条路，提示也只有那一处） */
function toggleHome(value: boolean | string | number): void {
  const current = project.value
  if (!current)
    return
  store.setHome(current.id, value === true)
}

// ---------- 标识色 ----------

/** 下拉里代表「自定义」的那一项（不是颜色名，只是个哨兵值） */
const CUSTOM_COLOR = 'custom'

/** 预设色的实际取值：直接问主题变量（跟着当前明暗），取不到就退回中性灰 */
const predefineColors = computed(() => {
  // 明暗一变，主题变量就换了值，取色器里的预设也得跟着换一套
  void settings.effectiveTheme
  return PROJECT_COLOR_PRESETS.map(preset => readColorVar(preset))
})

function readColorVar(preset: ProjectColorPreset): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--el-color-${preset}`)
    .trim()
  return sanitizeProjectColor(raw) ?? '#8a94a6'
}

/**
 * 下拉的绑定值：预设取预设名，自定义色统一落到「自定义」这一项。
 * 没设颜色时给空串（下拉显示占位符），而不是把用户带到自定义那一档。
 */
const colorModel = computed({
  get: () => {
    const color = sanitizeProjectColor(project.value?.color)
    if (!color)
      return ''
    return isProjectColorPreset(color) ? color : CUSTOM_COLOR
  },
  set: (value: string) => {
    const current = project.value
    if (!current)
      return
    // 切到「自定义」时把当前看到的颜色带过去，否则取色器会从一个毫不相干的颜色开始。
    // 一律过一遍 sanitize：取值可能来自 DOM（主题变量的实际色值），落盘前要收敛成合法形态
    const color = sanitizeProjectColor(value === CUSTOM_COLOR ? customPicker.value : value)
    if (color)
      current.color = color
  },
})

/** 取色器：读的时候把预设解析成当前主题下的实际色值，写的时候直接落自定义色 */
const customPicker = computed({
  get: () => {
    void settings.effectiveTheme
    const color = sanitizeProjectColor(project.value?.color)
    if (!color)
      return readColorVar('primary')
    return isProjectColorPreset(color) ? readColorVar(color) : color
  },
  set: (value: string | null) => {
    const current = project.value
    const next = sanitizeProjectColor(value)
    if (current && next)
      current.color = next
  },
})

/** 自定义那一项的标题：带上当前色值，收起后也知道选的是哪个色 */
const customOptionLabel = computed(() => `自定义（${customPicker.value}）`)

async function relocate(): Promise<void> {
  const current = project.value
  if (current)
    await store.relocate(current.id)
}
</script>

<template>
  <section v-if="project" class="block">
    <h3 class="section-title">
      基本信息
    </h3>

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
      <p class="field__hint">
        改完按回车生效，留空会还原。
      </p>
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

    <!--
      标识色：下拉里是 Element Plus 那五个主题色（见 packages/core/src/project-color.ts），
      外加一个「自定义」—— 选中它时旁边出现取色器。
      预设存的是**主题色名**（明暗与用户自设的主题色都会跟着走），自定义色存 `#rrggbb`。
    -->
    <div class="field">
      <label class="field__label">标识色</label>
      <div class="color-row">
        <el-select v-model="colorModel" size="small" placeholder="未设置" class="select">
          <el-option
            v-for="preset in PROJECT_COLOR_PRESETS"
            :key="preset"
            :label="PROJECT_COLOR_LABELS[preset]"
            :value="preset"
          >
            <span class="color-option">
              <i
                class="color-option__dot"
                :style="{ background: projectColorVar(preset) }"
              />
              {{ PROJECT_COLOR_LABELS[preset] }}
            </span>
          </el-option>
          <el-option :label="customOptionLabel" :value="CUSTOM_COLOR">
            <span class="color-option">
              <i
                class="color-option__dot"
                :style="{ background: customPicker }"
              />
              {{ customOptionLabel }}
            </span>
          </el-option>
        </el-select>

        <el-color-picker
          v-if="colorModel === CUSTOM_COLOR"
          v-model="customPicker"
          size="small"
          :predefine="predefineColors"
        />
      </div>
      <p class="field__hint">
        用来在项目卡与工作日志里区分项目；新加的项目会自动取一个还没用过的主题色。
      </p>
    </div>

    <!--
      走 store 的 action 而不是 v-model 直接改：首页那张卡上关掉这一项，卡片会立刻消失，
      与「⋯」菜单共用同一条路才有那句说明（见 store 的 setHome）。
    -->
    <div class="field field--row">
      <label class="field__label">在首页展示</label>
      <el-switch :model-value="project.home === true" size="small" @change="toggleHome" />
    </div>

    <div v-if="!pathValid" class="field field__warn">
      <p class="field__hint field__hint--warn">
        项目目录已不存在或被移动，启动 / 打包 / 安装已禁用。
      </p>
      <el-button size="small" :icon="FolderOpened" @click="relocate">
        重新定位
      </el-button>
    </div>
  </section>
</template>

<style scoped>
/* 标识色那一行：下拉吃剩余宽度，选了自定义时右边多一个取色器 */
.color-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.color-row .select {
  flex: 1 1 auto;
  min-width: 0;
}

/* 标识色下拉里的一行：色点 + 名字 */
.color-option {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.color-option__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.field__warn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
}
</style>
