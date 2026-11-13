<script setup lang="ts">
import { Finished, Warning } from '@element-plus/icons-vue'

import { dayKey, markdownToPlainText, sanitizeProjectColor } from '@workbench/core'
import { completedEntriesOn, entriesOfDevice } from '@workbench/work-log'
/**
 * 首页「今日完成」卡片：今天**标记为已完成**的工作记录，一条一行（项目标签 + 内容）。
 *
 * 只读不写：记一条、改内容都在「工作」页，这张卡片回答的是「今天做完了几件事」。
 * 数据与工作页是**同一份 store**（[stores/work-log.ts](../stores/work-log.ts)）——
 * 两边看到的是同一份内容，「工作」页记完一条，切回首页就是新的，不必等下一次读盘。
 * **只数本机的**（按条目的 `by` 筛，与工作页默认看的那台一致）：卡片上没有设备切换，
 * 别把几台机器的事混成一行行看起来像自己做的；要看别的设备去「工作」页切。
 *
 * 正文按 markdown 原文存着，这里**不渲染它**（一行装不下，一张卡片里堆十几段富文本也读不出重点）：
 * 去掉标记后一行显示，悬停给全文，要读全貌就点进去。
 */
import { storeToRefs } from 'pinia'
import { computed, onActivated, onMounted } from 'vue'
import PanelLoading from '@/components/PanelLoading.vue'
import ProjectTag from '@/components/ProjectTag.vue'
import { useWallClock } from '@/composables/use-wall-clock'
import { useNavStore } from '@/stores/nav'
import { useProjectsStore } from '@/stores/projects'
import { useWorkLogStore } from '@/stores/work-log'

const store = useProjectsStore()
const nav = useNavStore()
const workLog = useWorkLogStore()
const { entries, loading, error, localDevice } = storeToRefs(workLog)
const { dayStart } = useWallClock()

/** 本机设备 id：只留本机条目（拿不到时 entriesOfDevice 不筛，退化成原来的样子） */
const localDeviceId = computed(() => localDevice.value.id)

onMounted(() => void Promise.all([workLog.loadDevice(), workLog.load()]))

/**
 * 切回首页时确认一次：首页整页留在内存里（KeepAlive），卡片不会重新挂载。
 * 数据已经在共享 store 里（工作页的增删改与同步都直接改它），这里只是兜住
 * 「首挂时卡片先于工作页读、而工作页还没挂过」的那一拍。
 */
let activatedOnce = false

onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  void workLog.load()
})

/**
 * 「今天」的日期键。取 dayStart（跨过午夜时才变一次）而不是 Date.now()：
 * 依赖每秒跳动的时钟会让这一列每秒重算一遍，而它一天只可能变一次。
 */
const today = computed(() => dayKey(dayStart.value))

const projects = computed(() => new Map(store.projects.map(item => [item.id, item])))

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
  completedEntriesOn(
    entriesOfDevice(entries.value, localDeviceId.value, localDeviceId.value),
    today.value,
  ).map((entry) => {
    const project = entry.projectId ? projects.value.get(entry.projectId) : undefined
    return {
      id: entry.id,
      text: markdownToPlainText(entry.content),
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      projectName: project?.name ?? null,
      projectColor: sanitizeProjectColor(project?.color),
      missing: !!entry.projectId && !project,
    }
  }),
)

/** 点一行 = 去「工作」页看全貌（时间、正文与编辑都在那边） */
function openWorkView(): void {
  void nav.setActiveView('work')
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
      <el-icon class="empty__icon">
        <Warning />
      </el-icon>
      <p>{{ error }}</p>
      <button class="panel__link" type="button" @click="workLog.refresh">
        重试
      </button>
    </div>

    <PanelLoading v-else-if="loading" text="正在读取工作日志…" />

    <p v-else-if="!rows.length" class="panel__empty">
      <el-icon class="empty__icon">
        <Finished />
      </el-icon>
      今天还没有完成的记录<br>在「工作」页记一条，做完的会出现在这里。
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
 * 行距因此只能靠上下 padding 给。
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
