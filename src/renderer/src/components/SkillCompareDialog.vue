<script setup lang="ts">
/**
 * 内容差异弹窗：GitHub split 视图那样的逐行对比 —— 左边现在库里的那份，右边要采纳的那份。
 *
 * **两种对比共用这一份实现**，区别只在右边是谁、底下那颗按钮做什么：
 *  - `project`（默认）：右边是某个项目里的副本 →「用项目版本更新到库」；
 *  - `version`：右边是所选的历史版本 →「恢复到这个版本」（整目录一次检出，跟正在看哪个文件无关）。
 * 两者右边都是「要采纳的那一份」，所以行模型、红绿语义、文件条一个都不用变。
 *
 * **对比弹窗自带文件条**：列出全部文件，点哪个看哪个的差异（有差异的挂一枚圆点），
 * 不必关掉弹窗换文件。数据由父级组装好传入（每个文件的两侧内容），这里只切换与渲染；
 * 差异行模型来自 shared/text-diff.ts（jsdiff 算行块与行内变化段，带单测）。
 *
 * 两个动作各走各的必经之路：「更新到库」就是**正常保存**（stores/skills.ts 的 saveContent），
 * version 门槛照常生效 —— 只有 SKILL.md（清单）有这一关；「恢复到这个版本」走 store 的 restore，
 * 整目录一次检出、再提交一笔恢复记录。两者成功之后旧版本都留在 git 历史里，随时能再回来。
 * 项目里没有的文件无从采纳，那一侧按钮置灰；整目录恢复不看当前文件，所以一直可点。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { buildDiffRows } from '@shared/text-diff'
import { type SkillCompareFile } from '@shared/skills'
import AppDialog from '@/components/AppDialog.vue'
import { confirmAction } from '@/notify'
import { useSkillsStore } from '@/stores/skills'

const props = defineProps<{
  open: boolean
  skillId: string
  skillName: string
  /** 全部文件的对比数据（两侧内容），由父级从扫描 / 历史结果组装 */
  files: SkillCompareFile[]
  /** 打开时选中的文件 */
  initialRel: string
  /**
   * 右边那一份是谁、以及采纳它意味着什么。缺省是项目副本那条路
   * （老调用方只传 projectName，行为一个字不变）。
   */
  mode?: 'project' | 'version'
  /** project 模式：对比的项目显示名（按路径找不到项目时是路径末段） */
  projectName?: string
  /** version 模式：那一版的提交号（右栏徽标写它的短号） */
  versionHash?: string
}>()
const emit = defineEmits<{
  (event: 'update:open', value: boolean): void
  /** 更新成功（project 模式）：父级据此对齐编辑器、刷新检测 */
  (event: 'applied', rel: string, content: string): void
  /** 恢复成功（version 模式）：父级据此把上游那层弹窗一起收掉 */
  (event: 'restored'): void
}>()

const store = useSkillsStore()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

const currentRel = ref(props.initialRel)

watch(
  () => props.open,
  (value) => {
    if (!value) return
    currentRel.value = props.initialRel
    error.value = ''
    applying.value = false
  }
)

/** 切换文件后把差异表滚回顶部：上一个文件看到一半的位置对下一个文件没有意义 */
const scrollRef = ref<HTMLElement | null>(null)

watch(currentRel, async () => {
  await nextTick()
  if (scrollRef.value) scrollRef.value.scrollTop = 0
})

const current = computed(() => props.files.find((file) => file.rel === currentRel.value) ?? null)
const rows = computed(() =>
  buildDiffRows(current.value?.base ?? '', current.value?.incoming ?? '')
)

/** 项目里没有这个文件时无从「采纳」，更新按钮置灰（整目录恢复不看这个，见 actionEnabled） */
const canApply = computed(() => current.value !== null && current.value.incoming !== null)

const isVersion = computed(() => props.mode === 'version')
/** 徽标上的短号：与历史列表里显示的同一口径（7 位） */
const shortHash = computed(() => (props.versionHash ?? '').slice(0, 7))

/*
 * 左右两栏的身份。左边**永远**是「现在库里的那份」（会被换掉的那一份），
 * 右边**永远**是要采纳的那一份 —— 这条不变，两个场景的差异表就是同一套读法。
 * 左栏的徽标两种模式不同：历史版本那一侧两边都是「库里的版本」，写「库中的版本」就分不清了。
 */
const baseBadge = computed(() => (isVersion.value ? '当前版本' : '库中的版本'))
const incomingBadge = computed(() =>
  isVersion.value ? `${shortHash.value} 那一版` : `「${props.projectName}」项目里的版本`
)
const incomingHint = computed(() => (isVersion.value ? '确认后恢复到这一版' : '确认后将更新到库'))
const actionLabel = computed(() => (isVersion.value ? '恢复到这个版本' : '用项目版本更新到库'))

/**
 * 主按钮能不能点。项目那条：项目里没有这个文件就无从采纳；
 * 历史版本那条：恢复是**整目录**的一次检出，与当前看的是哪个文件无关，所以一直可点
 * （那一版里没有的文件会被删掉 —— 那也是「恢复到那一版」的一部分）。
 */
const actionEnabled = computed(() =>
  isVersion.value ? Boolean(props.versionHash) : canApply.value
)
const actionDisabledHint = computed(() =>
  isVersion.value ? '缺少版本号，无法恢复' : '项目里没有这个文件，无从采纳'
)

/** 文件条上的圆点：两侧内容不同（含某一侧没有的）才标 —— 找「动过」的文件全靠它 */
const isDiff = (file: SkillCompareFile): boolean => file.base !== file.incoming

const applying = ref(false)
const error = ref('')

async function apply(): Promise<void> {
  if (applying.value || !actionEnabled.value) return
  if (isVersion.value) {
    await restoreVersion()
    return
  }

  const target = current.value
  if (!target || target.incoming === null) return
  applying.value = true
  error.value = ''

  // version 门槛由适配层按 rel 判定：只有 SKILL.md（清单）有这一关
  const saved = await store.saveContent(props.skillId, currentRel.value, target.incoming)
  applying.value = false
  if (saved) {
    emit('applied', currentRel.value, target.incoming)
    visible.value = false
  } else {
    error.value = store.saveError || '更新到库失败'
  }
}

/**
 * 恢复到所选版本。先确认 —— 它替换的是整个技能目录，不是当前这一个文件。
 * 恢复本身也是一次提交，现在这份内容留在历史里，随时能再恢复回来。
 *
 * 失败原因由 store 弹出来（那边才知道 git 说了什么），这里只管成功之后把这一层收掉。
 */
async function restoreVersion(): Promise<void> {
  const confirmed = await confirmAction(
    '这个技能的文件会变回所选版本的样子。恢复本身也是一次提交，现在的内容留在历史里，随时能再恢复回来。',
    '恢复到这个版本？',
    { confirmButtonText: '恢复' }
  )
  if (!confirmed) return

  applying.value = true
  const done = await store.restore(props.skillId, props.versionHash ?? '')
  applying.value = false
  if (done) emit('restored')
}
</script>

<template>
  <AppDialog
    v-model="visible"
    class="skill-compare-dialog"
    body-class="skill-compare-dialog__body"
    :title="`对比 · ${currentRel} · ${skillName}`"
    width="min(1200px, calc(100vw - 80px))"
    align-center
  >
    <div class="cmp">
      <!-- 文件条：库里全部文件，点哪个看哪个的差异；圆点 = 项目里动过 -->
      <div v-if="files.length > 1" class="cmp__files" role="tablist" aria-label="对比文件">
        <button
          v-for="file in files"
          :key="file.rel"
          class="cmp__file mono"
          :class="{ 'is-active': currentRel === file.rel }"
          type="button"
          role="tab"
          :aria-selected="currentRel === file.rel"
          :title="file.rel"
          @click="currentRel = file.rel"
        >
          <i v-if="isDiff(file)" class="cmp__dot" aria-hidden="true" />
          {{ file.rel }}
        </button>
      </div>

      <!-- 栏头：左右各自醒目标出身份（与下方差异表的红/绿同一语义） -->
      <div class="cmp__heads">
        <div class="cmp__head">
          <span class="cmp__badge cmp__badge--base">{{ baseBadge }}</span>
          <span class="cmp__head-hint">库里现在保存的内容</span>
        </div>
        <div class="cmp__head">
          <span class="cmp__badge cmp__badge--in">{{ incomingBadge }}</span>
          <span class="cmp__head-hint">{{ incomingHint }}</span>
        </div>
      </div>

      <div ref="scrollRef" class="cmp__scroll" role="table" aria-label="内容差异">
        <table class="cmp__table mono">
          <tbody>
            <tr v-for="(row, index) in rows" :key="index" :class="`is-${row.type}`">
              <td class="cmp__no">{{ row.left?.no ?? '' }}</td>
              <td class="cmp__code cmp__code--l" :class="{ 'is-empty': !row.left }">
                <span v-for="(segment, s) in row.left?.segments ?? []" :key="s" :class="{ 'is-chg': segment.changed }">
                  {{ segment.text || ' ' }}
                </span>
              </td>
              <td class="cmp__no">{{ row.right?.no ?? '' }}</td>
              <td class="cmp__code cmp__code--r" :class="{ 'is-empty': !row.right }">
                <span v-for="(segment, s) in row.right?.segments ?? []" :key="s" :class="{ 'is-chg': segment.changed }">
                  {{ segment.text || ' ' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <footer class="cmp__foot">
        <span v-if="error" class="cmp__error">{{ error }}</span>
        <el-button @click="visible = false">取消</el-button>
        <el-tooltip v-if="!actionEnabled" :content="actionDisabledHint" placement="top">
          <span>
            <el-button type="primary" disabled>{{ actionLabel }}</el-button>
          </span>
        </el-tooltip>
        <el-button v-else type="primary" :loading="applying" @click="apply">
          {{ actionLabel }}
        </el-button>
      </footer>
    </div>
  </AppDialog>
</template>

<style scoped>
/* 内容自己带内边距：body 的 padding 已在 global.css 清零（定高与滚动的分工在那边做） */
.cmp {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--sp-4);
}

/* 文件条：横向滚动的一排文件名（与详情弹窗的文件条同一副样子） */
.cmp__files {
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  flex-shrink: 0;
}

.cmp__file {
  position: relative;
  flex-shrink: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 10px 4px 18px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}

.cmp__file:hover {
  background: var(--bg-inset);
  color: var(--ink-2);
}

.cmp__file.is-active {
  background: var(--bg-selected);
  border-color: var(--border);
  color: var(--ink);
}

/* 差异圆点：左上角一枚，标出「项目里动过」的文件 */
.cmp__dot {
  position: absolute;
  top: 7px;
  left: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-run);
}

/* 栏头：与差异表的两栏对齐（表格每侧恰为一半宽），badge 悬在代码列上方；
   左红右绿与行底色同一语义 —— 左边是「将被覆盖的」，右边是「要采纳的」 */
.cmp__heads {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
  flex-shrink: 0;
}

.cmp__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding-left: calc(3.2em + var(--sp-2));
}

.cmp__badge {
  flex-shrink: 0;
  padding: 3px 12px;
  border-radius: var(--r-pill);
  border: 1px solid transparent;
  color: var(--ink);
  font-size: var(--fs-micro);
  font-weight: 600;
  white-space: nowrap;
}

.cmp__badge--base {
  background: color-mix(in srgb, var(--st-fail) 16%, transparent);
  border-color: color-mix(in srgb, var(--st-fail) 38%, transparent);
}

.cmp__badge--in {
  background: color-mix(in srgb, var(--st-ok) 18%, transparent);
  border-color: color-mix(in srgb, var(--st-ok) 42%, transparent);
}

.cmp__head-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 整张差异表住在一个滚动容器里：一个滚动条控制左右两侧 —— 同步滚动天然成立 */
.cmp__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.cmp__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.cmp__table td {
  padding: 0 var(--sp-2);
  vertical-align: top;
}

.cmp__no {
  width: 3.2em;
  text-align: right;
  color: var(--ink-3);
  user-select: none;
  border-right: 1px solid var(--border);
}

.cmp__code {
  width: calc(50% - 3.2em);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--ink);
}

/* 空的那半边（纯删 / 纯增）垫一层灰底，一眼看出这一侧没有内容 */
.cmp__code.is-empty {
  background: var(--bg-subtle);
}

/* 行底色与行内变化段：删（失败色）/ 增（成功色）借状态色的语义，深浅两档由 color-mix 出。
   change 行（一对修改行）左边红右边绿，与 GitHub 的 split 视图同一读法 */
tr.is-del td.cmp__code--l,
tr.is-change td.cmp__code--l {
  background: color-mix(in srgb, var(--st-fail) 13%, transparent);
}

tr.is-add td.cmp__code--r,
tr.is-change td.cmp__code--r {
  background: color-mix(in srgb, var(--st-ok) 13%, transparent);
}

tr.is-del td.cmp__no,
tr.is-change td.cmp__no:not(:nth-of-type(2)) {
  background: color-mix(in srgb, var(--st-fail) 13%, transparent);
}

tr.is-add td.cmp__no,
tr.is-change td.cmp__no:nth-of-type(2) {
  background: color-mix(in srgb, var(--st-ok) 13%, transparent);
}

.is-chg {
  border-radius: 2px;
}

tr.is-del .is-chg,
tr.is-change td.cmp__code--l .is-chg {
  background: color-mix(in srgb, var(--st-fail) 30%, transparent);
}

tr.is-add .is-chg,
tr.is-change td.cmp__code--r .is-chg {
  background: color-mix(in srgb, var(--st-ok) 30%, transparent);
}

/* 按钮行：靠右；出错时原因占在左边（更新失败的原因要就地看见） */
.cmp__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.cmp__error {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--st-fail);
  font-size: var(--fs-micro);
  margin-right: auto;
}
</style>
