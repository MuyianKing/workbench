<script setup lang="ts">
import type { SkillCompareFile, SkillCopyComparison } from '@workbench/skills'
import { Close } from '@element-plus/icons-vue'
import { compareSkillCopy, SKILL_FILE } from '@workbench/skills'
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
import AppDialog from '@/components/AppDialog.vue'
import SkillCompareDialog from '@/components/SkillCompareDialog.vue'
import SkillFileTabs from '@/components/SkillFileTabs.vue'
import SkillHistoryDialog from '@/components/SkillHistoryDialog.vue'
import { basenameOf, formatTimestamp } from '@/format'
import { confirmAction, notifySuccess } from '@/notify'
import { useProjectsStore } from '@/stores/projects'
import { useSkillsStore } from '@/stores/skills'

const emit = defineEmits<{
  /** 「安装到项目」交给页面层处理：安装弹窗是页面上的那一份（卡片上的按钮也开它） */
  (event: 'install'): void
}>()

/** 弹层开关:v-model 一条口径(与 AppDialog / el-dialog 相同,全应用的弹层都这么开) */
const open = defineModel<boolean>({ required: true })

const store = useSkillsStore()
const projects = useProjectsStore()

const visible = computed({
  get: () => open.value,
  set: (value) => {
    open.value = value
  },
})

/** 打开那一刻的正文快照：与当前内容一致才算「没有未保存的修改」 */
const baseline = ref('')

/**
 * 项目里的副本与库的差异（打开详情时检测一次，**每次更新成功后重跑**）。
 *
 * 判定口径在域包 `compareSkillCopy`（带单测），**不只是版本**：项目里多出来的文件、
 * 同版本下内容不同的附属文件都算 —— 新增附属文件本来就不动清单版本，
 * 只看 version 会把它永远漏在项目里；**版本比库低的不摆**（旧快照），所以应用了别处那条
 * 更新、库的版本一涨，那些比它低的副本自己就从这一行上掉下去了。
 * `files` 就是对比弹窗那一份清单，切文件不必再扫。
 */
interface ProjectUpdate extends SkillCopyComparison {
  project: string
}
const updates = ref<ProjectUpdate[]>([])
const checking = ref(false)
let checkJob = 0

watch(open, (value) => {
  if (!value)
    return
  checkJob += 1
  updates.value = []
  // 已选中且内容在手上（连点同一张卡片关了再开）时立刻记快照
  if (!store.contentLoading) {
    baseline.value = store.content
    void checkUpdates()
  }
})

/**
 * 每一次**载入完成**都重新取一次基线。正文除了编辑器里敲的，只会由「打开某个文件」
 * 「恢复到某个版本」「同步后重读」这几条路换掉，而它们全都是「以盘上那份为准」——
 * 基线不跟着走的话，恢复完立刻会显示成有未保存的修改，关弹窗还要问一句「放弃修改？」。
 */
watch(
  () => store.contentLoading,
  (loading, was) => {
    if (loading || was === loading)
      return
    baseline.value = store.content
    void checkUpdates()
  },
)

/**
 * 扫一遍库与各项目副本，挑出「和库不一样」的那些（只读，比对全在域包里做）。
 *
 * 比对基准是**库盘上那份**（扫描回来的），不是编辑器的缓冲：改着没保存的草稿
 * 不该影响「项目里有没有东西可搬回来」的判断。
 */
async function checkUpdates(): Promise<void> {
  const id = store.activeId
  if (!id) {
    updates.value = []
    return
  }

  const job = (checkJob += 1)
  checking.value = true
  try {
    const result = await window.workbench.scanSkillCopies(
      store.gitRoot,
      store.dir,
      id,
      projects.projects.map(project => project.path),
    )
    // 期间关了弹窗 / 换了技能：这份结果已经过期
    if (job !== checkJob || !open.value || store.activeId !== id)
      return

    const scan = result.ok ? result.data : undefined
    updates.value = scan
      ? scan.projects
          .map(copy => ({ project: copy.project, ...compareSkillCopy(scan.library, copy.files) }))
          .filter(update => update.needsAttention)
      : []
  }
  finally {
    if (job === checkJob)
      checking.value = false
  }
}

/** 项目显示名：按路径对应不到时显示路径末段 */
function projectNameOf(dir: string): string {
  return projects.projects.find(project => project.path === dir)?.name ?? basenameOf(dir)
}

/**
 * 提示条上一行的差异摘要：版本关系 + 文件差异，只写盘上的事实，判断留给对比弹窗。
 *
 * 版本只有「更高」与「与库中相同」两档（更低的不摆，见 compareSkillCopy）——
 * 「相同」还能留在页面上，靠的就是后半句：多出了哪些文件、哪些内容不同。
 */
function updateHint(update: ProjectUpdate): string {
  const parts: string[] = [
    update.versionOrder > 0
      ? `版本 v${update.version} 高于库中 v${update.libraryVersion}`
      : `版本与库中相同（v${update.version}）`,
  ]
  if (update.added.length)
    parts.push(`项目里多出 ${fileNames(update.added)}`)
  if (update.changed.length)
    parts.push(`${fileNames(update.changed)} 内容不同`)
  return parts.join(' · ')
}

/** 文件名最多点两个，再多只报个数 —— 一行的位置不够，具体哪些文件在对比弹窗里看 */
function fileNames(rels: string[]): string {
  return rels.length > 2 ? `${rels.length} 个文件` : rels.join('、')
}

// ---------- 对比（差异只在对比弹窗里看） ----------

const compareOpen = ref(false)
const compareRel = ref(SKILL_FILE)
const compareProject = ref('')
const compareFiles = ref<SkillCompareFile[]>([])

/**
 * 提示条入口：清单那份没差异就跳到第一个有差异的文件。
 *
 * 项目里新增的往往是附属文件（清单一个字没动，只有版本号动过或干脆没动），
 * 停在 SKILL.md 上会先给人看一张「什么都没变」的表。
 */
function openCompare(update: ProjectUpdate): void {
  compareFiles.value = update.files
  compareRel.value = update.files.find(file => file.base !== file.incoming)?.rel ?? SKILL_FILE
  compareProject.value = update.project
  compareOpen.value = true
}

/** 对比弹窗里更新成功：编辑器对齐到新内容、重跑检测（提示条随之消失），并把成功说出来 */
async function onApplied(rel: string, content: string): Promise<void> {
  if (store.activeFile === rel) {
    store.content = content
    baseline.value = content
  }
  await checkUpdates()
  notifySuccess('已更新到库，保存成功')
}

/** 正文还在读时不算 dirty：那时 content 里是上一篇的旧文本，比了只会误报 */
const dirty = computed(
  () => !store.contentLoading && Boolean(store.activeId) && store.content !== baseline.value,
)

const historyOpen = ref(false)

const savedText = computed(() =>
  store.savedAt ? `已保存 · ${formatTimestamp(store.savedAt)}` : '已保存',
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
    { confirmButtonText: '放弃并关闭' },
  )
  if (discard)
    visible.value = false
}

async function save(): Promise<void> {
  if (await store.saveActive())
    baseline.value = store.content
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
  if (!store.hasVersions)
    return '；技能库还不在 git 仓库里：改完没有版本'
  return store.remoteUrl ? '' : '；版本只留本机（它所在的仓库还没连远端）'
})

/** 切换文件后把编辑区滚回顶部：上一个文件看到一半的位置对下一个文件没有意义 */
const editorRef = ref<HTMLTextAreaElement | null>(null)

watch(
  () => store.activeFile,
  async () => {
    await nextTick()
    if (editorRef.value)
      editorRef.value.scrollTop = 0
  },
)

/**
 * 切换编辑的文件：当前文件有未保存的修改时先问一句（切过去就丢了）。
 * **详情页只看库里的文件** —— 差异与更新都在对比弹窗里（由提示条打开）。
 */
async function switchFile(rel: string): Promise<void> {
  if (rel === store.activeFile)
    return
  if (dirty.value) {
    const discard = await confirmAction(
      '当前文件还有没保存的修改，直接切过去就丢了。',
      '放弃修改？',
      { confirmButtonText: '放弃并切换' },
    )
    if (!discard)
      return
  }
  await store.openFile(rel)
  baseline.value = store.content
}

async function removeActive(): Promise<void> {
  const skill = store.activeSkill
  if (!skill)
    return
  const confirmed = await confirmAction(
    `「${skill.name}」连同它目录里的 ${skill.fileCount} 个文件会一起删掉。删除也会记进版本历史，想找回可以恢复到删除前的版本。`,
    '删除技能？',
    { confirmButtonText: '删除' },
  )
  if (!confirmed)
    return

  if (await store.remove(skill.id))
    visible.value = false
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
          <h2 class="detail__name">
            {{ store.activeSkill.name }}
          </h2>
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
        <el-button size="small" @click="historyOpen = true">
          版本历史
        </el-button>
        <el-button size="small" @click="store.reveal(store.activeSkill.id)">
          文件夹
        </el-button>
        <el-button size="small" type="danger" plain @click="removeActive">
          删除
        </el-button>
      </div>

      <!-- 项目里的副本和库不一样（版本 / 新增文件 / 内容差异）：查看后可逐文件更新到库 -->
      <div v-if="checking || updates.length" class="detail__updates">
        <span v-if="checking" class="detail__updates-title">正在检查项目里的副本…</span>
        <template v-else>
          <span class="detail__updates-title">
            有 {{ updates.length }} 个项目里的副本和库不一样：
          </span>
          <div v-for="update in updates" :key="update.project" class="detail__update">
            <span class="detail__update-name" :title="update.project">
              {{ projectNameOf(update.project) }}
            </span>
            <!-- 摘要是「版本 + 差异」拼出来的一句，窄窗下会被截断：全名挂在原生 title 上 -->
            <span class="detail__update-hint" :title="updateHint(update)">{{ updateHint(update) }}</span>
            <el-button size="small" text @click="openCompare(update)">
              查看差异
            </el-button>
          </div>
        </template>
      </div>

      <!-- 文件条：一个技能往往不止 SKILL.md（脚本 / 模板 / 子文档），点哪个编辑哪个 -->
      <SkillFileTabs
        v-if="store.files.length > 1"
        :files="store.files"
        :active-rel="store.activeFile"
        label="技能文件"
        @select="switchFile"
      />

      <div class="detail__editor">
        <div v-if="store.contentLoading" class="detail__state">
          正在读取…
        </div>
        <textarea
          v-else
          ref="editorRef"
          v-model="store.content"
          class="detail__textarea mono"
          spellcheck="false"
          :placeholder="isMainFile
            ? `没有 ${SKILL_FILE}。保存一段带 frontmatter 的 markdown，它就会成为清单。`
            : '这个文件还没有内容。'"
        />
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
      v-model="historyOpen"
      :skill-id="store.activeId"
      :skill-name="store.activeSkill?.name ?? ''"
    />
    <SkillCompareDialog
      v-model="compareOpen"
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
