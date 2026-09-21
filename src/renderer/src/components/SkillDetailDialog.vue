<script setup lang="ts">
/**
 * 技能详情弹窗：卡片点开的那一侧 —— 编辑 SKILL.md、安装到项目、版本历史、删除都在这里。
 *
 * 一个 1200px 宽的大编辑框（窄窗口收着 `calc(100vw - 80px)`，不出界）：头部 / 动作行 /
 * 保存行固定，中间的编辑区自己滚 —— 高度与滚动的分工同设置弹窗（global.css 的
 * .skill-dialog 那一组，scoped 样式够不着 EP 生成的 body 元素）。
 * 内容四周留内边距（--sp-4），正文不再顶着弹窗边。
 *
 * 与项目抽屉、设置弹窗同一个做法（AppDialog，见 components/AppDialog.vue）。编辑区就是一份清单原文，
 * 保存 = 记一个版本（见 stores/skills.ts 的 saveActive）。名字与描述是 frontmatter 解析出来的，
 * 改它们就是改正文本身 —— 保存之后列表会重扫一遍，卡片上的字跟着变。
 *
 * 关闭前有一道「放弃修改」的确认：编辑是手动的（没有防抖自动保存），没点保存就关，
 * 刚敲的字会真的丢 —— 问一句比静默丢掉强。保存成功之后 baseline 跟着走，不会误报。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { SKILL_FILE, compareSkillVersions, skillVersionOf, type SkillCompareFile, type SkillInstalledScan } from '@shared/skills'
import { formatTimestamp } from '@/format'
import AppDialog from '@/components/AppDialog.vue'
import { confirmAction, notifySuccess } from '@/notify'
import { useProjectsStore } from '@/stores/projects'
import { useSkillsStore } from '@/stores/skills'
import SkillHistoryDialog from '@/components/SkillHistoryDialog.vue'
import SkillCompareDialog from '@/components/SkillCompareDialog.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (event: 'update:open', value: boolean): void
  /** 「安装到项目」交给页面层处理：安装弹窗是页面上的那一份（卡片上的按钮也开它） */
  (event: 'install'): void
}>()

const store = useSkillsStore()
const projects = useProjectsStore()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

/** 打开那一刻的正文快照：与当前内容一致才算「没有未保存的修改」 */
const baseline = ref('')

/**
 * 项目里被补充优化过的副本（打开详情时检测一次，更新成功后重跑）。
 * 比对基准是 **libraryContent** —— 库里盘上的那份，而不是编辑器的缓冲：
 * 用户改着没保存的草稿不该影响「项目里有没有更新」的判断。
 */
interface ProjectUpdate {
  project: string
  content: string
  /** 项目副本的版本（归一化；高于库版本才会出现在清单里） */
  version: string
}
const libraryContent = ref('')
const updates = ref<ProjectUpdate[]>([])
const checking = ref(false)
let checkJob = 0
/** 最近一次副本扫描缓存：切换文件时判断「项目里有没有这个文件的另一份内容」 */
const scan = ref<SkillInstalledScan | null>(null)

/** 换行归一：项目里的文件可能带着 CRLF，内容没变不该被换行写法误报成更新 */
const normalizeLf = (text: string): string => text.replace(/\r\n/g, '\n')

watch(
  () => props.open,
  (value) => {
    if (!value) return
    checkJob += 1
    updates.value = []
    // 已选中且内容在手上（连点同一张卡片关了再开）时立刻记快照
    if (!store.contentLoading) {
      baseline.value = store.content
      if (store.activeFile === SKILL_FILE) libraryContent.value = store.content
      void checkUpdates()
    }
  }
)

/**
 * 每一次**载入完成**都重新取一次基线。正文除了编辑器里敲的，只会由「打开某个文件」
 * 「恢复到某个版本」「同步后重读」这几条路换掉，而它们全都是「以盘上那份为准」——
 * 基线不跟着走的话，恢复完立刻会显示成有未保存的修改，关弹窗还要问一句「放弃修改？」。
 *
 * 「库版本」的比对基准只认清单那一份（`libraryContent`）：切到附属文件时不能跟着变，
 * 否则「项目里有没有更高的版本」就变成拿附属文件在比了。
 */
watch(
  () => store.contentLoading,
  (loading, was) => {
    if (loading || was === loading) return
    baseline.value = store.content
    if (store.activeFile === SKILL_FILE) libraryContent.value = store.content
    void checkUpdates()
  }
)

/** 扫一遍库与各项目副本；「有更新」的提示条**只由 SKILL.md 的 version 判定** */
async function checkUpdates(): Promise<void> {
  const id = store.activeId
  if (!id) {
    updates.value = []
    scan.value = null
    return
  }

  const job = (checkJob += 1)
  checking.value = true
  try {
    const result: { ok: boolean; data?: SkillInstalledScan; error?: string } =
      await window.workbench.scanSkillCopies(
        store.gitRoot,
        store.dir,
        id,
        projects.projects.map((project) => project.path)
      )
    // 期间关了弹窗 / 换了技能：这份结果已经过期
    if (job !== checkJob || !props.open || store.activeId !== id) return

    scan.value = result.ok && result.data ? result.data : null

    const libraryVersion = skillVersionOf(libraryContent.value) || '0.0.0'
    updates.value = !scan.value
      ? []
      : scan.value.projects.flatMap((copy) => {
          const file = copy.files.find((item) => item.rel === SKILL_FILE)
          if (!file || file.content === null) return []
          const text = normalizeLf(file.content)
          const version = skillVersionOf(text)
          if (!version || compareSkillVersions(version, libraryVersion) <= 0) return []
          return [{ project: copy.project, content: text, version }]
        })
  } finally {
    if (job === checkJob) checking.value = false
  }
}

/** 项目显示名：按路径对应不到时显示路径末段 */
function projectNameOf(dir: string): string {
  return projects.projects.find((project) => project.path === dir)?.name ?? dir.split(/[\\/]/).pop() ?? dir
}

// ---------- 对比（差异只在对比弹窗里看） ----------

const compareOpen = ref(false)
const compareRel = ref(SKILL_FILE)
const compareProject = ref('')
const compareFiles = ref<SkillCompareFile[]>([])

/** 组装「某个项目副本 vs 库」的全文件对比数据，从 rel 开始看（换行先归一） */
function openCompareFor(project: string, rel: string): void {
  const copy = scan.value?.projects.find((item) => item.project === project)
  compareFiles.value = (scan.value?.library ?? []).map((file) => {
    const found = copy?.files.find((item) => item.rel === file.rel)
    return {
      rel: file.rel,
      base: normalizeLf(file.content ?? ''),
      incoming: found ? normalizeLf(found.content ?? '') : null
    }
  })
  compareRel.value = rel
  compareProject.value = project
  compareOpen.value = true
}

/** 提示条入口：对比的就是 SKILL.md（更新条只由它的 version 产生） */
function openCompare(update: ProjectUpdate): void {
  openCompareFor(update.project, SKILL_FILE)
}

/** 对比弹窗里更新成功：编辑器对齐到新内容、重跑检测（更新条随之消失），并把成功说出来 */
async function onApplied(rel: string, content: string): Promise<void> {
  if (store.activeFile === rel) {
    store.content = content
    baseline.value = content
    if (rel === SKILL_FILE) libraryContent.value = content
  }
  await checkUpdates()
  notifySuccess('已更新到库，保存成功')
}

/** 正文还在读时不算 dirty：那时 content 里是上一篇的旧文本，比了只会误报 */
const dirty = computed(
  () => !store.contentLoading && Boolean(store.activeId) && store.content !== baseline.value
)

const historyOpen = ref(false)

const savedText = computed(() =>
  store.savedAt ? `已保存 · ${formatTimestamp(store.savedAt)}` : '已保存'
)

/** 想关弹窗的所有入口（自绘的关闭按钮 / 遮罩 / Esc）都走这一道确认 */
async function requestClose(): Promise<void> {
  if (!dirty.value) {
    visible.value = false
    return
  }
  const discard = await confirmAction(
    'SKILL.md 还有没保存的修改，直接关掉就丢了。',
    '放弃修改？',
    { confirmButtonText: '放弃并关闭' }
  )
  if (discard) visible.value = false
}

async function save(): Promise<void> {
  if (await store.saveActive()) baseline.value = store.content
}

/** 当前编辑的是不是清单文件（version 门槛只对它） */
const isMainFile = computed(() => store.activeFile === SKILL_FILE)

/**
 * 版本那一句的补充：**「有没有仓库」与「有没有远端」是两件事**，别混成一句。
 *
 * 记不记版本看的是**技能库所在的仓库**（从技能库目录往上找到的那个）；
 * 没有仓库时提交根本没发生（`skills.rs` 的 commit 直接返回 `changed: false`）——
 * 那不是「版本只留本机」，是**没有版本**。
 */
const versionHint = computed(() => {
  if (!store.hasVersions) return '；技能库还不在 git 仓库里：改完没有版本'
  return store.remoteUrl ? '' : '；版本只留本机（它所在的仓库还没连远端）'
})

/** 切换文件后把编辑区滚回顶部：上一个文件看到一半的位置对下一个文件没有意义 */
const editorRef = ref<HTMLTextAreaElement | null>(null)

watch(
  () => store.activeFile,
  async () => {
    await nextTick()
    if (editorRef.value) editorRef.value.scrollTop = 0
  }
)

/**
 * 切换编辑的文件：当前文件有未保存的修改时先问一句（切过去就丢了）。
 * **详情页只看库里的文件** —— 差异与更新都在对比弹窗里（由提示条打开）。
 */
async function switchFile(rel: string): Promise<void> {
  if (rel === store.activeFile) return
  if (dirty.value) {
    const discard = await confirmAction(
      '当前文件还有没保存的修改，直接切过去就丢了。',
      '放弃修改？',
      { confirmButtonText: '放弃并切换' }
    )
    if (!discard) return
  }
  await store.openFile(rel)
  baseline.value = store.content
}

async function removeActive(): Promise<void> {
  const skill = store.activeSkill
  if (!skill) return
  const confirmed = await confirmAction(
    `「${skill.name}」连同它目录里的 ${skill.fileCount} 个文件会一起删掉。删除也会记进版本历史，想找回可以恢复到删除前的版本。`,
    '删除技能？',
    { confirmButtonText: '删除' }
  )
  if (!confirmed) return

  if (await store.remove(skill.id)) visible.value = false
}
</script>

<template>
  <!-- class / body-class：高度与滚动的分工在 global.css（.el-dialog.skill-dialog 那一组，含隐藏 EP 头部） -->
  <AppDialog
    v-model="visible"
    class="skill-dialog"
    body-class="skill-dialog__body"
    width="min(1200px, calc(100vw - 80px))"
    align-center
    :before-close="requestClose"
  >
    <div v-if="store.activeSkill" class="detail">
      <header class="detail__head">
        <div class="detail__identity">
          <h2 class="detail__name">{{ store.activeSkill.name }}</h2>
          <span class="detail__id mono" :title="store.activeSkill.id">
            目录 {{ store.activeSkill.id }}
          </span>
        </div>
        <el-button class="icon-btn" :icon="Close" text aria-label="关闭" @click="requestClose" />
      </header>

      <div class="detail__actions">
        <el-button type="primary" plain size="small" @click="emit('install')">
          安装到项目
        </el-button>
        <el-button size="small" @click="historyOpen = true">版本历史</el-button>
        <el-button size="small" @click="store.reveal(store.activeSkill.id)">文件夹</el-button>
        <el-button size="small" type="danger" plain @click="removeActive">删除</el-button>
      </div>

      <!-- 项目里被优化过的副本：打开详情时检测，查看后可一键更新到库 -->
      <div v-if="checking || updates.length" class="detail__updates">
        <span v-if="checking" class="detail__updates-title">正在检查项目里的副本…</span>
        <template v-else>
          <span class="detail__updates-title">
            有 {{ updates.length }} 个项目里的版本比库中更高（在项目里补充优化过的）：
          </span>
          <div v-for="update in updates" :key="update.project" class="detail__update">
            <span class="detail__update-name" :title="update.project">
              {{ projectNameOf(update.project) }}
            </span>
            <span class="detail__update-hint">项目里的版本 v{{ update.version }} 高于库中</span>
            <el-button size="small" text @click="openCompare(update)">查看新版本内容</el-button>
          </div>
        </template>
      </div>

      <!-- 文件条：一个技能往往不止 SKILL.md（脚本 / 模板 / 子文档），点哪个编辑哪个 -->
      <div v-if="store.files.length > 1" class="detail__files" role="tablist" aria-label="技能文件">
        <button
          v-for="file in store.files"
          :key="file.rel"
          class="detail__file mono"
          :class="{ 'is-active': store.activeFile === file.rel }"
          type="button"
          role="tab"
          :aria-selected="store.activeFile === file.rel"
          :title="file.rel"
          @click="switchFile(file.rel)"
        >
          {{ file.rel }}
        </button>
      </div>

      <div class="detail__editor">
        <div v-if="store.contentLoading" class="detail__state">正在读取…</div>
              <textarea
                v-else
                ref="editorRef"
                v-model="store.content"
                class="detail__textarea mono"
                spellcheck="false"
                :placeholder="isMainFile
                  ? `没有 ${SKILL_FILE}。保存一段带 frontmatter 的 markdown，它就会成为清单。`
                  : '这个文件还没有内容。'"
              ></textarea>
      </div>

      <footer class="detail__foot">
        <span class="detail__hint">
          {{ isMainFile
            ? '保存 = 记一个版本（frontmatter 需带语义化 version，如 1.0.0）'
            : '保存附属文件 = 记一个版本' }}{{ versionHint }}
        </span>
        <span v-if="store.saveError" class="detail__error">{{ store.saveError }}</span>
        <span v-else class="detail__saved">{{ savedText }}</span>
        <el-button
          type="primary"
          size="small"
          :loading="store.saving"
          :disabled="store.contentLoading"
          @click="save"
        >
          保存
        </el-button>
      </footer>
    </div>

    <SkillHistoryDialog
      v-model:open="historyOpen"
      :skill-id="store.activeId"
      :skill-name="store.activeSkill?.name ?? ''"
    />
    <SkillCompareDialog
      v-model:open="compareOpen"
      :skill-id="store.activeId"
      :skill-name="store.activeSkill?.name ?? ''"
      :project-name="projectNameOf(compareProject)"
      :files="compareFiles"
      :initial-rel="compareRel"
      @applied="onApplied"
    />
  </AppDialog>
</template>

<style scoped>
/* 内容自己带内边距：body 的 padding 已在 global.css 清零（高度与滚动的分工在那边做） */
.detail {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--sp-4);
}

.detail__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
}

.detail__identity {
  min-width: 0;
}

.detail__name {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-title);
}

.detail__id {
  display: block;
  margin-top: 2px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.detail__actions {
  display: flex;
  gap: var(--sp-2);
}

/* 文件条：横向滚动的一排文件名（附属文件多时也不撑破弹窗） */
.detail__files {
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  flex-shrink: 0;
}

.detail__file {
  flex-shrink: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}

.detail__file:hover {
  background: var(--bg-inset);
  color: var(--ink-2);
}

.detail__file.is-active {
  background: var(--bg-selected);
  border-color: var(--border);
  color: var(--ink);
}

/* 项目更新的提示条：夹在动作行与编辑区之间，有更新才出现 */
.detail__updates {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail__updates-title {
  color: var(--st-run);
  font-size: var(--fs-micro);
}

.detail__update {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.detail__update-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-micro);
  font-weight: 600;
}

.detail__update-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.detail__update :deep(.el-button + .el-button) {
  margin-left: 0;
}

.detail__editor {
  display: flex;
  flex: 1;
  min-height: 0;
}

.detail__state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.detail__textarea {
  flex: 1;
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
  color: var(--ink);
  font-size: var(--fs-meta);
  line-height: 1.7;
  resize: none;
  outline: none;
}

.detail__textarea:focus {
  border-color: var(--border-strong);
}

.detail__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.detail__hint {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.detail__saved {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.detail__error {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

.detail__foot .el-button {
  margin-left: auto;
}

.icon-btn {
  width: 28px;
  padding: 0;
  flex-shrink: 0;
}
</style>
