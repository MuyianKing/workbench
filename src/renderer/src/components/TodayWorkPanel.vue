<script setup lang="ts">
/**
 * 首页「今日完成」卡片：今天**标记为已完成**的工作记录，一条一行（项目标签 + 内容）。
 *
 * 只读不写：记一条、改内容都在「工作」页，这张卡片回答的是「今天做完了几件事」。
 * 数据住在本机的 `work-log.json`（**不进同步仓库**，见 shared/work-log.ts）——
 * 与工作页是两次独立读取，但适配层把整份文件缓存在内存里，第二次只是取一份快照，
 * 所以两边看到的是同一份内容，不会各自去读一遍磁盘。
 *
 * 正文按 markdown 原文存着，这里**不渲染它**（一行装不下，一张卡片里堆十几段富文本也读不出重点）：
 * 去掉标记后一行显示，悬停给全文，要读全貌就点进去。
 */
import { computed, onActivated, onMounted, ref } from 'vue'
import { dayKey } from '@shared/activity'
import { markdownToPlainText } from '@shared/markdown'
import { sanitizeProjectColor } from '@shared/project-color'
import { completedEntriesOn, type WorkLogEntry } from '@shared/work-log'
import { useProjectsStore } from '@/stores/projects'
import ProjectTag from '@/components/ProjectTag.vue'

const store = useProjectsStore()

const entries = ref<WorkLogEntry[]>([])
const loading = ref(true)
/** 读盘失败与「今天还没做完什么」是两回事，不能都显示成空列表 */
const error = ref('')

async function load(): Promise<void> {
  error.value = ''
  try {
    const result = await window.workbench.listWorkLogs()
    if (result.ok && result.data) entries.value = result.data
    else error.value = result.error ?? '读取工作日志失败'
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取工作日志失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

/**
 * 切回首页时重读一次：首页整页留在内存里（KeepAlive），卡片不会重新挂载，
 * 而这段时间里刚在「工作」页记过一条是常态。
 * 首次挂载时 activated 也会触发，用这个标志把那次免掉，免得启动时连着读两遍。
 */
let activatedOnce = false

onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  void load()
})

/**
 * 「今天」的日期键。取 store.dayStart（跨过午夜时才变一次）而不是 Date.now()：
 * 依赖每秒跳动的时钟会让这一列每秒重算一遍，而它一天只可能变一次。
 */
const today = computed(() => dayKey(store.dayStart))

const projects = computed(() => new Map(store.projects.map((item) => [item.id, item])))

// ---------- 要渲染的行 ----------

interface PanelRow {
  id: string
  /** 正文去掉 markdown 标记后的一行文本 */
  text: string
  /** 有值表示这条关联了项目（项目可能已被删掉，见 missing） */
  projectId?: string
  projectName: string | null
  /** 项目的标识色；没设过色时为 undefined，标签退回中性的主题色 */
  projectColor?: ReturnType<typeof sanitizeProjectColor>
  /** 关联的项目已经不在项目列表里了 */
  missing: boolean
}

/** 项目名 / 标识色 / 纯文本都在这里算一次，模板里不再逐帧转换 */
const rows = computed<PanelRow[]>(() =>
  completedEntriesOn(entries.value, today.value).map((entry) => {
    const project = entry.projectId ? projects.value.get(entry.projectId) : undefined
    return {
      id: entry.id,
      text: markdownToPlainText(entry.content),
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      projectName: project?.name ?? null,
      projectColor: sanitizeProjectColor(project?.color),
      missing: !!entry.projectId && !project
    }
  })
)

/** 点一行 = 去「工作」页看全貌（时间、正文与编辑都在那边） */
function openWorkView(): void {
  void store.setActiveView('work')
}
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">今日完成</span>
      <span class="panel__count mono">{{ rows.length }}</span>
    </header>

    <!-- 读盘失败：把原因说出来并给一次重试，不能显示成「今天什么也没做」 -->
    <div v-if="error" class="panel__empty">
      <p>{{ error }}</p>
      <button class="panel__link" type="button" @click="load">重试</button>
    </div>

    <p v-else-if="loading" class="panel__empty">正在读取工作日志…</p>

    <p v-else-if="!rows.length" class="panel__empty">
      今天还没有完成的记录<br />在「工作」页记一条，做完的会出现在这里。
    </p>

    <ul v-else class="rows panel__scroll">
      <li v-for="row in rows" :key="row.id">
        <!-- 整行是一个按钮：鼠标与键盘都能去「工作」页 -->
        <button class="row" type="button" :title="row.text" @click="openWorkView">
          <ProjectTag
            v-if="row.projectId"
            class="row__tag"
            :name="row.missing ? '项目已删除' : row.projectName ?? ''"
            :color="row.projectColor"
            :missing="row.missing"
          />
          <span class="row__text truncate">{{ row.text }}</span>
        </button>
      </li>
    </ul>
  </article>
</template>

<style scoped>
.panel__count {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/**
 * 一行：项目标签 + 正文。左右不留内边距 —— 标签的左沿与面板标题对齐，
 * 行距靠上下 padding 给（与「最近使用」那张卡片同一套）。
 */
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--bg-subtle);
}

/* 标签固定不缩，长了自己截断：项目名不该把正文挤走 */
.row__tag {
  flex-shrink: 0;
  max-width: 96px;
}

.row__tag :deep(.el-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
}

.row__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}
</style>
