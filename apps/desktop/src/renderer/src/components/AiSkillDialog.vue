<script setup lang="ts">
import type { AiSkillLevel, AiSkillRow } from '@workbench/ai'
import { Delete, DocumentAdd, EditPen, FolderAdd, FolderOpened, Link, MoreFilled, Reading, Search } from '@element-plus/icons-vue'
import { skillPathOf } from '@workbench/ai'
/**
 * 技能弹窗（AI 助手页 composer 工具行那颗「技能」按钮打开的那个）：**两条技能根各一组**。
 *
 *  - **全局级** `%USERPROFILE%\.agents\skills`：与别的 agent 共用一份（ZCode 这类也读它），
 *    所以在哪儿干活都看得见；
 *  - **项目级** `<这个会话的工作目录>\.agents\skills`：只有在这个目录里干活时才看得见 ——
 *    技能页那颗「安装到项目」写的就是这一份。
 *
 * 排版：顶上一条「全部 / 全局 / 项目」分段筛选（带计数）加搜索框；下面每组一条组头 ——
 * 级名、根路径（全局那份把用户目录段收写成 `~`）、计数徽标与三颗导入按钮
 * （导入 zip / 导入目录 / 粘地址）；行内是图标 + 名字 + 范围标签 + 一行描述，动作收在右侧：
 * 看 SKILL.md（点名字或铅笔）、更多菜单（文件管理器 / 卸掉）、开关。**不内置任何技能**：
 * 这份列表就是用户自己装进来的东西。
 *
 * 界面上**只有控件与数据**（组头、路径与计数、行内的看 / 开 / 卸）：说明句、空态提示、
 * 「装、卸、开关只在下次起进程时生效」那句 —— 一概不放（作者自己用的程序，与
 * constraints/ai.md「这一页不摆提示行」同一条规矩；2026-09-29 两轮收紧后的定局，别再往回加）。
 *
 * 两件只进文档、不进界面的事实：
 *
 *  1. `--skill` 只在起进程时给（见 ai.rs 的 run），一个会话的进程一轮跑完是留着的 ——
 *     装完要让这段会话立刻看到，就结束这段会话的进程再续聊（会话文件不动，下一句按新表重开）。
 *  2. 开关与列表都作用在**用户自己那两个目录**上：全局那份删掉别的 agent 也看不到了；
 *     项目那份多半就在他的仓库里 —— 卸掉要提交才是真的删（应用不替他提交）。
 */
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { useAiSkillsStore } from '@/stores/ai-skills'

const visible = defineModel<boolean>({ required: true })

const store = useAiSkillsStore()

/** 顶上那条分段筛选：全部 / 只看全局 / 只看项目 */
const scope = ref('all')
/** 搜索框：按名字（frontmatter 的 name 与目录名）与描述过滤 */
const query = ref('')

/** 一次只干一件事：装 / 卸 / 覆盖确认都在这一趟里，按钮同进同出 */
const busy = ref(false)
/** 详情（看 SKILL.md）：点某一行的名字或铅笔打开 */
const detail = ref<AiSkillRow | null>(null)
/** 「粘地址」那一栏：独立的小弹窗（要回浏览器抄地址，所以它也不挡背后） */
const urlOpen = ref(false)
/** 粘地址那一栏装的是哪一栏的技能根 */
const urlLevel = ref<AiSkillLevel>('global')
const url = ref('')
const urlProblem = computed(() => {
  const text = url.value.trim()
  if (!text)
    return ''
  return /^https?:\/\/\S+$/i.test(text) ? '' : '地址要以 http:// 或 https:// 开头'
})

watch(
  () => visible.value,
  (value) => {
    if (!value)
      return
    urlOpen.value = false
    url.value = ''
    detail.value = null
    query.value = ''
    void store.refresh()
  },
)

/** 分段筛选的三个选项：计数是两条根各自的总数，不跟搜索走 */
const scopeOptions = computed(() => [
  { label: '全部', value: 'all', count: store.rows.length },
  { label: '全局', value: 'global', count: store.globalRows.length },
  { label: '项目', value: 'project', count: store.projectRows.length },
])

function rowsOf(level: AiSkillLevel): AiSkillRow[] {
  return level === 'global' ? store.globalRows : store.projectRows
}

function readyOf(level: AiSkillLevel): boolean {
  return level === 'global' ? store.globalReady : store.projectReady
}

function rootOf(level: AiSkillLevel): string {
  return level === 'global' ? store.globalRoot : store.projectRoot
}

/** 现在要画哪几组：全部时两条都上（各自能不能用另说），单选时只上那一条 */
const visibleLevels = computed<AiSkillLevel[]>(() => {
  const levels = (['global', 'project'] as AiSkillLevel[]).filter(level => readyOf(level))
  if (scope.value === 'all')
    return levels
  return levels.filter(level => level === scope.value)
})

/** 搜索命中（目录名 / name / 描述，大小写不敏感）；没输入就原样全量 */
function matching(rows: AiSkillRow[]): AiSkillRow[] {
  const q = query.value.trim().toLowerCase()
  if (!q)
    return rows
  return rows.filter(
    row =>
      row.id.toLowerCase().includes(q)
      || row.name.toLowerCase().includes(q)
      || row.description.toLowerCase().includes(q),
  )
}

/** 组头那条路径只服务显示：全局根把用户目录那段收写成 ~，认不出就原样 */
function displayRoot(level: AiSkillLevel): string {
  const root = rootOf(level)
  if (level !== 'global')
    return root
  const matched = /^[a-zA-Z]:\\Users\\[^\\]+\\(.+)$/.exec(root)
  return matched ? `~\\${matched[1]}` : root
}

async function importZip(level: AiSkillLevel): Promise<void> {
  if (busy.value)
    return
  const file = await window.workbench.pickFile('选择技能包', [
    { name: '技能包（zip）', extensions: ['zip'] },
  ])
  if (!file)
    return
  busy.value = true
  await store.install(level, { kind: 'zip', value: file })
  busy.value = false
}

async function importDir(level: AiSkillLevel): Promise<void> {
  if (busy.value)
    return
  const dir = await window.workbench.pickDirectory('选择技能文件夹（根上要有 SKILL.md）')
  if (!dir)
    return
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
  if (busy.value || urlProblem.value || !url.value.trim())
    return
  busy.value = true
  const id = await store.install(urlLevel.value, { kind: 'url', value: url.value.trim() })
  busy.value = false
  if (id)
    urlOpen.value = false
}

async function toggle(row: AiSkillRow): Promise<void> {
  if (busy.value)
    return
  await store.toggle(row)
}

async function remove(row: AiSkillRow): Promise<void> {
  if (busy.value)
    return
  busy.value = true
  const done = await store.remove(row)
  busy.value = false
  if (done && detail.value?.key === row.key)
    detail.value = null
}

function reveal(row: AiSkillRow): void {
  void window.workbench.reveal(skillPathOf(row.root, row.id))
}

/** 行内「更多」菜单：在文件管理器里打开 / 卸掉 */
function onRowCommand(command: unknown, row: AiSkillRow): void {
  if (command === 'reveal')
    reveal(row)
  if (command === 'remove')
    void remove(row)
}
</script>

<template>
  <AppDialog v-model="visible" title="技能" width="760px" penetrable>
    <div v-loading="store.loading" class="skills">
      <div class="bar">
        <el-segmented
          v-model="scope"
          class="bar__scope"
          :options="scopeOptions"
          aria-label="技能范围"
        >
          <template #default="{ item }">
            <span class="bar__opt">{{ item.label }}<span class="bar__num">{{ item.count }}</span></span>
          </template>
        </el-segmented>
        <el-input
          v-model="query"
          class="bar__search"
          :prefix-icon="Search"
          placeholder="搜索技能"
          clearable
        />
      </div>

      <section v-for="level in visibleLevels" :key="level" class="group">
        <header class="group__head">
          <span class="group__label">{{ level === 'global' ? '全局级' : '项目级' }}</span>
          <span class="group__path" :title="rootOf(level)">{{ displayRoot(level) }}</span>
          <span class="group__count">{{ matching(rowsOf(level)).length }}</span>
          <div class="group__tools">
            <el-button
              size="small"
              :icon="DocumentAdd"
              :disabled="!readyOf(level) || busy"
              @click="importZip(level)"
            >
              导入文件
            </el-button>
            <el-button
              size="small"
              :icon="FolderAdd"
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

        <ul v-if="matching(rowsOf(level)).length" class="list">
          <li v-for="row in matching(rowsOf(level))" :key="row.key" class="row">
            <el-icon class="row__icon">
              <Reading />
            </el-icon>
            <div class="row__main">
              <div class="row__title">
                <button class="row__name" type="button" :title="row.name || row.id" @click="detail = row">
                  {{ row.name || row.id }}
                </button>
                <span class="row__tag">{{ row.level === 'global' ? '全局' : '项目' }}</span>
                <span v-if="row.version" class="row__version">v{{ row.version }}</span>
              </div>
              <p class="row__desc" :title="row.description">
                {{ row.description || '（没有写描述）' }}
              </p>
            </div>
            <div class="row__side">
              <el-tooltip content="看 SKILL.md" placement="top">
                <el-button link :icon="EditPen" @click="detail = row" />
              </el-tooltip>
              <el-dropdown
                trigger="click"
                :disabled="busy"
                @command="(command: string) => onRowCommand(command, row)"
              >
                <span class="row__more"><el-icon><MoreFilled /></el-icon></span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="reveal" :icon="FolderOpened">
                      在文件管理器里打开
                    </el-dropdown-item>
                    <el-dropdown-item command="remove" :icon="Delete" divided>
                      卸掉…
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
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
        <el-button @click="urlOpen = false">
          取消
        </el-button>
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
  gap: var(--sp-4);
  max-height: min(64vh, 620px);
  overflow-y: auto;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.bar__scope {
  flex: none;
}

.bar__opt {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}

.bar__num {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.bar__search {
  flex: none;
  width: 340px;
  margin-left: auto;
}

.group {
  display: flex;
  flex-direction: column;
}

.group__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.group__label {
  flex: none;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
}

.group__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.group__count {
  flex: none;
  min-width: 22px;
  padding: 0 7px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 18px;
  text-align: center;
}

.group__tools {
  flex: none;
  display: flex;
  gap: var(--sp-1);
}

.list {
  margin: var(--sp-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
}

.row:hover {
  background: var(--bg-inset);
}

.row__icon {
  flex: none;
  color: var(--ink-3);
  font-size: 20px;
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
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  border: none;
  background: none;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
  cursor: pointer;
}

.row__name:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.row__tag {
  flex: none;
  padding: 0 7px;
  border-radius: var(--r-pill);
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 17px;
}

.row__version {
  flex: none;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.row__desc {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.row__side {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.row__more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
  color: var(--ink-3);
  cursor: pointer;
}

.row__more:hover {
  color: var(--ink);
  background: var(--bg-surface);
}

.skills__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.md {
  max-height: min(56vh, 520px);
  overflow: auto;
  margin: 0;
  padding: var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink);
  font-size: var(--fs-body);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.md__foot {
  margin: var(--sp-2) 0 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}
</style>
