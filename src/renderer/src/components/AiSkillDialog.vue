<script setup lang="ts">
/**
 * 技能弹窗（AI 助手页 composer 工具行那颗「技能」按钮打开的那个）：**两条技能根各一栏**。
 *
 *  - **全局级** `%USERPROFILE%\.agents\skills`：与别的 agent 共用一份（ZCode 这类也读它），
 *    所以在哪儿干活都看得见；
 *  - **项目级** `<这个会话的工作目录>\.agents\skills`：只有在这个目录里干活时才看得见 ——
 *    技能页那颗「安装到项目」写的就是这一份。
 *
 * 每一栏都能：导入文件（zip）/ 导入目录 / 粘地址装；每一行能开关、看 SKILL.md、在文件管理器里
 * 打开、卸掉。**不内置任何技能**：这份列表就是用户自己装进来的东西。
 *
 * 两件必须说清的事（都画在下面那行提示里）：
 *
 *  1. 装 / 卸 / 开关**对已经起来的进程不生效** —— `--skill` 只在起进程时给（见 ai.rs 的 run），
 *     而一个会话的进程一轮跑完是留着的（连续对话靠它）。要它立刻看到，就把这段会话的进程结束掉，
 *     下一句会按新的技能表重开（历史照旧从会话文件接上）。
 *  2. 开关与列表都作用在**用户自己那两个目录**上：全局那份删掉别的 agent 也看不到了；
 *     项目那份多半就在他的仓库里 —— 卸掉要提交才是真的删（应用不替他提交）。
 */
import { computed, ref, watch } from 'vue'
import { Delete, FolderOpened, Link } from '@element-plus/icons-vue'
import AppDialog from '@/components/AppDialog.vue'
import { skillPathOf, type AiSkillLevel, type AiSkillRow } from '@shared/pi-skills'
import { useAiStore } from '@/stores/ai'
import { useAiSkillsStore } from '@/stores/ai-skills'
import { notifySuccess } from '@/notify'

const visible = defineModel<boolean>({ required: true })

const store = useAiSkillsStore()
const ai = useAiStore()

/** 两栏的顺序（全局在前） */
const LEVELS: AiSkillLevel[] = ['global', 'project']

/** 一次只干一件事：装 / 卸 / 覆盖确认都在这一趟里，按钮同进同出 */
const busy = ref(false)
/** 详情（看 SKILL.md）：点某一行的名字打开 */
const detail = ref<AiSkillRow | null>(null)
/** 「粘地址」那一栏：独立的小弹窗（要回浏览器抄地址，所以它也不挡背后） */
const urlOpen = ref(false)
/** 粘地址那一栏装的是哪一栏的技能根 */
const urlLevel = ref<AiSkillLevel>('global')
const url = ref('')
const urlProblem = computed(() => {
  const text = url.value.trim()
  if (!text) return ''
  return /^https?:\/\/\S+$/i.test(text) ? '' : '地址要以 http:// 或 https:// 开头'
})

watch(
  () => visible.value,
  (value) => {
    if (!value) return
    urlOpen.value = false
    url.value = ''
    detail.value = null
    void store.refresh()
  }
)

/** 这段会话的进程还活着没有：活着时「装完要重启」那句提示才有意义 */
const liveProcess = computed(() => {
  const id = ai.activeId
  return id ? (ai.runs.get(id)?.live ?? false) : false
})

function rowsOf(level: AiSkillLevel): AiSkillRow[] {
  return level === 'global' ? store.globalRows : store.projectRows
}

function rootOf(level: AiSkillLevel): string {
  return level === 'global' ? store.globalRoot : store.projectRoot
}

function readyOf(level: AiSkillLevel): boolean {
  return level === 'global' ? store.globalReady : store.projectReady
}

/** 这一段在哪儿（栏标题下那行的小字）：全局那栏说清「与别的 agent 共用」 */
function hintOf(level: AiSkillLevel): string {
  if (level === 'global') {
    return readyOf(level) ? '所有项目都能用；与别的 agent 共用这一份' : '拿不到用户目录，这一栏用不了'
  }
  if (!readyOf(level)) return '这个会话还没有工作目录'
  return '只有在这个目录里干活时看得见；技能页「安装到项目」装的就是这一份'
}

async function importZip(level: AiSkillLevel): Promise<void> {
  if (busy.value) return
  const file = await window.workbench.pickFile('选择技能包', [
    { name: '技能包（zip）', extensions: ['zip'] }
  ])
  if (!file) return
  busy.value = true
  await store.install(level, { kind: 'zip', value: file })
  busy.value = false
}

async function importDir(level: AiSkillLevel): Promise<void> {
  if (busy.value) return
  const dir = await window.workbench.pickDirectory('选择技能文件夹（根上要有 SKILL.md）')
  if (!dir) return
  busy.value = true
  await store.install(level, { kind: 'dir', value: dir })
  busy.value = false
}

function openUrl(level: AiSkillLevel): void {
  urlLevel.value = level
  url.value = ''
  urlOpen.value = true
}

async function submitUrl(): Promise<void> {
  if (busy.value || urlProblem.value || !url.value.trim()) return
  busy.value = true
  const id = await store.install(urlLevel.value, { kind: 'url', value: url.value.trim() })
  busy.value = false
  if (id) urlOpen.value = false
}

async function toggle(row: AiSkillRow): Promise<void> {
  if (busy.value) return
  await store.toggle(row)
}

async function remove(row: AiSkillRow): Promise<void> {
  if (busy.value) return
  busy.value = true
  const done = await store.remove(row)
  busy.value = false
  if (done && detail.value?.key === row.key) detail.value = null
}

function reveal(row: AiSkillRow): void {
  void window.workbench.reveal(skillPathOf(row.root, row.id))
}

/** 立刻让这段会话看到新的技能表：把它的进程结束掉（会话文件不动，下一句按新的重开） */
async function restart(): Promise<void> {
  const id = ai.activeId
  if (!id) return
  await ai.recycle(id)
  notifySuccess('已经结束这段会话的进程，下一句会按新的技能表重开')
}
</script>

<template>
  <AppDialog v-model="visible" title="技能" width="720px" penetrable>
    <div class="skills">
      <p class="skills__lead">
        技能是「一个目录 + 一份 SKILL.md」：按描述自动进模型的技能清单，也能在输入框里用
        <code>/skill:名字</code> 直接调起来。<strong>应用不内置任何技能</strong>，下面这两份都是你自己装进来的。
        起进程时只把这份表里<strong>开着</strong>的交给 Pi（Pi 自己那套技能发现在这条路上是关的），
        所以在别处给 Pi 装的技能这儿看不到 —— 要用就在这儿装一份。
      </p>

      <section v-for="level in LEVELS" :key="level" class="group">
        <header class="group__head">
          <div class="group__title">
            <span class="group__label">{{ level === 'global' ? '全局级' : '项目级' }}</span>
            <span class="group__path" :title="rootOf(level)">{{ rootOf(level) || '—' }}</span>
            <span class="group__count">{{ rowsOf(level).length }}</span>
          </div>
          <div class="group__tools">
            <el-button
              size="small"
              :icon="FolderOpened"
              :disabled="!readyOf(level) || busy"
              @click="importZip(level)"
            >
              导入文件
            </el-button>
            <el-button
              size="small"
              :icon="FolderOpened"
              :disabled="!readyOf(level) || busy"
              @click="importDir(level)"
            >
              导入目录
            </el-button>
            <el-button
              size="small"
              :icon="Link"
              :disabled="!readyOf(level) || busy"
              @click="openUrl(level)"
            >
              粘地址
            </el-button>
          </div>
        </header>
        <p class="group__hint">{{ hintOf(level) }}</p>

        <p v-if="!readyOf(level)" class="group__empty">这一栏这会儿用不了</p>
        <p v-else-if="!rowsOf(level).length" class="group__empty">
          还没有技能。上面三颗按钮，或者把技能目录直接放进这个文件夹。
        </p>

        <ul v-else class="list">
          <li v-for="row in rowsOf(level)" :key="row.key" class="row">
            <div class="row__main">
              <div class="row__title">
                <button class="row__name" type="button" @click="detail = row">
                  {{ row.name || row.id }}
                </button>
                <span class="row__tag">{{ row.level === 'global' ? '全局' : '项目' }}</span>
                <span v-if="row.version" class="row__version">v{{ row.version }}</span>
              </div>
              <p class="row__desc" :title="row.description">{{ row.description || '（没有写描述）' }}</p>
            </div>
            <div class="row__side">
              <el-tooltip content="在文件管理器里打开" placement="top">
                <el-button link :icon="FolderOpened" @click="reveal(row)" />
              </el-tooltip>
              <el-tooltip content="卸掉（删掉这个技能目录）" placement="top">
                <el-button link :icon="Delete" :disabled="busy" @click="remove(row)" />
              </el-tooltip>
              <el-switch
                :model-value="row.enabled"
                :disabled="busy"
                :title="row.enabled ? '这一轮交给 Pi' : '不交给 Pi（下一段会话起效）'"
                @change="toggle(row)"
              />
            </div>
          </li>
        </ul>
      </section>

      <p class="skills__note">
        装、卸、开关都只在<strong>下次起进程</strong>时生效：一个会话的进程一轮跑完是留着的（连续对话靠它）。
        <template v-if="liveProcess">
          这一段会话的进程正活着，
          <el-button link type="primary" size="small" @click="restart">结束它</el-button>
          之后下一句就会按上面这份表重开。
        </template>
      </p>
    </div>

    <!-- 详情：SKILL.md 的原文（只读，改它去编辑器 / 技能页） -->
    <AppDialog
      :model-value="detail !== null"
      :title="detail ? `SKILL.md · ${detail.name || detail.id}` : 'SKILL.md'"
      width="640px"
      @update:model-value="detail = null"
    >
      <pre class="md">{{ detail?.md || '' }}</pre>
      <p v-if="detail" class="md__foot">
        {{ detail.root }}\{{ detail.id }} · {{ detail.fileCount }} 个文件
      </p>
    </AppDialog>

    <!-- 粘地址：要回浏览器抄一段，所以这一栏也不挡背后（AppDialog 的 penetrable） -->
    <AppDialog v-model="urlOpen" title="从地址装技能" width="520px" penetrable>
      <el-form label-position="top" @submit.prevent>
        <el-form-item
          label="技能包地址（http / https，能直接下到 zip）"
          :error="urlProblem"
          :required="true"
        >
          <el-input
            v-model="url"
            placeholder="https://…/skill.zip"
            clearable
            @keydown.enter.prevent="submitUrl"
          />
        </el-form-item>
      </el-form>
      <p class="skills__note">
        点「装上」才走这一趟 GET：地址由你给，跟着跳转最多 5 跳，超过 64 MB 就停。
        技能市场那种「页面地址」不行 —— 要给能直接下到 zip 的那个。
      </p>
      <template #footer>
        <el-button @click="urlOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!url.trim() || !!urlProblem"
          @click="submitUrl"
        >
          装上
        </el-button>
      </template>
    </AppDialog>
  </AppDialog>
</template>

<style scoped>
.skills {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: min(64vh, 620px);
  overflow-y: auto;
}

.skills__lead,
.skills__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-sm);
  line-height: 1.7;
}

.skills__lead code {
  padding: 0 4px;
  border-radius: var(--r-xs);
  background: var(--bg-soft);
  color: var(--ink-2);
}

.group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.group__title {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.group__label {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--ink-1);
}

.group__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: var(--ink-3);
}

.group__count {
  flex: none;
  padding: 0 6px;
  border-radius: var(--r-xs);
  background: var(--bg-soft);
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

.group__tools {
  flex: none;
  display: flex;
  gap: var(--sp-1);
}

.group__hint,
.group__empty {
  margin: 2px 0 0;
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

.list {
  margin: var(--sp-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-sm);
  background: var(--bg-1);
}

.row__main {
  min-width: 0;
  flex: 1;
}

.row__title {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.row__name {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  border: none;
  background: none;
  color: var(--ink-1);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
}

.row__name:hover {
  color: var(--st-run);
}

.row__tag {
  flex: none;
  padding: 0 6px;
  border-radius: var(--r-xs);
  background: var(--bg-soft);
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

.row__version {
  flex: none;
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

.row__desc {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

.row__side {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.md {
  max-height: min(56vh, 520px);
  overflow: auto;
  margin: 0;
  padding: var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  color: var(--ink-1);
  font-size: var(--fs-sm);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.md__foot {
  margin: var(--sp-2) 0 0;
  color: var(--ink-3);
  font-size: var(--fs-xs);
}
</style>
