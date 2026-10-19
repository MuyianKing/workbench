<script setup lang="ts">
import type { ProjectColor } from '@workbench/core'
import type { WorkLogEntry } from '@/types'
import { CircleCheck, Delete, EditPen, RefreshLeft } from '@element-plus/icons-vue'
import { sanitizeProjectColor } from '@workbench/core'
import { WORK_STATUS_LABELS } from '@workbench/work-log'
/**
 * 时间轴上的一条工作记录。
 *
 * 只负责展示，以及把「编辑 / 删除 / 状态开关」三个动作抛上去 —— 数据从哪来、改完列表怎么变由页面决定。
 * **整条卡片不可点**：改变状态只认右上角那颗开关（点卡片只是看，不顺手动数据）。
 * 内容很长时默认收起，留一个「展开」——一条日志写成一篇长文时，时间轴不该被它整段占满。
 * 左沿那条灰竖条是卡片的「脊」（见样式里那段：为什么不按项目色上色），认项目看那枚标签。
 */
import { computed, ref, watch } from 'vue'
import MarkdownView from '@/components/MarkdownView.vue'
import ProjectTag from '@/components/ProjectTag.vue'
import { formatTimeOfDay, formatTimestamp } from '@/format'

const props = defineProps<{
  entry: WorkLogEntry
  /** 所属项目名；null 表示没有关联项目，或那个项目已经被删掉（见下面 missing） */
  projectName: string | null
  /** 所属项目的标识色；项目已删或没设过色时为 undefined，退回中性灰 */
  projectColor?: ProjectColor
  /**
   * 是否在卡片上带出日期。
   * 按天分组时日期由栏头给（这里只写时刻）；按项目分组时一栏跨好几天，日期得跟着每条走。
   */
  showDate?: boolean
}>()

const emit = defineEmits<{
  edit: [entry: WorkLogEntry]
  remove: [entry: WorkLogEntry]
  /** 右上角那颗状态开关：已完成 ⇄ 待办（真正的落盘由页面负责） */
  toggle: [entry: WorkLogEntry]
}>()

/** 已完成的那条：不挂「待办」标记，右上角那颗开关也翻成「改为待办」 */
const isDone = computed(() => props.entry.status === 'done')

/** 关联的项目已经不在项目列表里了（删项目不会连带删日志，这里把它说出来） */
const projectMissing = computed(() => !!props.entry.projectId && !props.projectName)

/** 收敛后的标识色；没设或写坏时为 undefined */
const color = computed(() => sanitizeProjectColor(props.projectColor))

/** 超过这个体量就默认收起：大概相当于屏幕上四五行 */
const COLLAPSE_AT = 220

const collapsible = computed(
  () => props.entry.content.length > COLLAPSE_AT || props.entry.content.split('\n').length > 6,
)

const expanded = ref(false)

/** 换了一条记录（列表被替换）就把展开状态收回去，免得新条目一进来就是展开的样子 */
watch(
  () => props.entry.id,
  () => {
    expanded.value = false
  },
)
</script>

<template>
  <article class="log">
    <header class="log__head">
      <span class="log__time mono">
        {{ props.showDate ? formatTimestamp(entry.createdAt) : formatTimeOfDay(entry.createdAt) }}
      </span>

      <!-- 项目标签：实心标识色（effect="dark"）。项目被删掉时退成一枚中性描边标签，不冒充某个项目 -->
      <ProjectTag
        v-if="entry.projectId"
        class="log__project"
        :name="projectMissing ? '项目已删除' : projectName ?? ''"
        :color="color"
        :missing="projectMissing"
      />

      <!--
        待办标识：跟在项目标签后面（左上角这一块）的一枚 el-tag，直接把状态写出来。
        **已完成的一条什么都不显示** —— 做完了就是正常记过一笔，只有还欠着的才需要被看见。
      -->
      <el-tag
        v-if="!isDone"
        class="log__todo"
        size="small"
        type="info"
        effect="plain"
        disable-transitions
      >
        {{ WORK_STATUS_LABELS.todo }}
      </el-tag>

      <!--
        三个动作统一：平时不占视觉重量，鼠标落在这一条上才显形。
        最右那颗状态开关是个例外，它**常显**：整条卡片不可点之后，它是改变状态唯一的入口，
        跟着藏起来就没人找得着了。
      -->
      <span class="log__actions">
        <button
          class="log__action log__action--hover"
          type="button"
          title="编辑"
          @click="emit('edit', entry)"
        >
          <el-icon><EditPen /></el-icon>
        </button>
        <button
          class="log__action log__action--hover log__action--danger"
          type="button"
          title="删除"
          @click="emit('remove', entry)"
        >
          <el-icon><Delete /></el-icon>
        </button>

        <!--
          状态开关：待办时点它即完成，已完成时点它改回待办。
          两态共用这一颗，只换图标与提示语 —— 改回待办那条路也得有个看得见的入口。
        -->
        <button
          class="log__action"
          type="button"
          :title="isDone ? '改为待办' : '标记为已完成'"
          :aria-label="isDone ? '改为待办' : '标记为已完成'"
          @click="emit('toggle', entry)"
        >
          <el-icon>
            <RefreshLeft v-if="isDone" />
            <CircleCheck v-else />
          </el-icon>
        </button>
      </span>
    </header>

    <div class="log__body" :class="{ 'is-collapsed': collapsible && !expanded }">
      <MarkdownView :source="entry.content" />
    </div>

    <button
      v-if="collapsible"
      class="log__more"
      type="button"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : '展开' }}
    </button>
  </article>
</template>

<style scoped>
/**
 * 一条记录是一张小卡片：比时间轴所在的页面底色高一档，让「一天里的多条」分得清边界。
 * 半透明底与面板同源（--card-alpha 由 App.vue 按设置写在 .app 上），底下同样有一道毛玻璃
 * （--glass-filter，配方见 tokens.css）—— 记录压在时间轴所在的页面上，磨过之后底下的字不会透上来。
 */
.log {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: var(--sp-3) var(--sp-4);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
  /* 四周那条线归设置里的「毛玻璃描边」（默认不画） */
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-md);
}

/* 待办 / 已完成只是状态标签上的差别，卡片本身与其它记录长得一样（底色不动） */
.log__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/**
 * 待办标识：项目名旁边的一枚 el-tag（与项目标签同一套形态，一眼看得出是同一类记号）。
 * 外形由调用方这里定 —— 不参与收缩、长名字截断交给 el-tag 自己的内容层。
 */
.log__todo {
  flex-shrink: 0;
}

.log__time {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/*
 * 项目标签是一枚 el-tag（effect="dark"），颜色由组件按项目的标识色给。
 * 这里只管它在行里的行为：不参与收缩、长项目名自己截断 —— 标签宽度不该把时间与动作挤走。
 */
.log__project {
  flex-shrink: 0;
  max-width: 180px;
}

/* 长项目名在这里截断（行盒高度那条由 ProjectTag 自己兜着，见它的样式注释） */
.log__project :deep(.el-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * 动作推到最右。淡化的是编辑 / 删除这两个 —— 平时不占视觉重量，鼠标落在这一条上才显形；
 * **状态开关（最右那颗）常显** —— 整条卡片不可点，它是改变状态唯一的路，不能跟着淡掉。
 */
.log__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.log__action--hover {
  opacity: 0;
}

.log:hover .log__action--hover,
.log:focus-within .log__action--hover {
  opacity: 1;
}

.log__action {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.log__action:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

.log__action--danger:hover {
  color: var(--st-fail);
}

/* 收起时从底部渐隐，而不是硬切一刀 —— 让人看得出「下面还有」 */
.log__body.is-collapsed {
  max-height: 120px;
  overflow: hidden;
  mask-image: linear-gradient(180deg, #000 62%, transparent);
}

.log__more {
  align-self: flex-start;
  padding: 1px 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  cursor: pointer;
}

.log__more:hover {
  background: var(--bg-inset);
  color: var(--ink);
}
</style>
