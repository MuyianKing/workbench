<script setup lang="ts">
/**
 * 顶栏左侧那一行：**整个界面里唯一一处「认得你」的地方**。
 *
 * 它原来在首页画布顶部、自己带一块卡片底衬；全局搜索移除后挪进顶栏，住进搜索框
 * 空出来的位置 —— 首屏第一眼先是这句，首页画布也少了一层、整块让给卡片。
 * 顶栏本身有实底，这一行不再需要底衬。
 *
 * 它只说两件已经发生的事：现在是什么时候（一句按时间段的称呼，后面跟着**程序名**），
 * 以及你这些机器上目前的状况（几条从本机数据里现取的实话）。
 * 不打招呼、不问好、不鼓励 —— 那些在这个应用的语气里是噪音（见 AGENTS.md 的「如实说明」）。
 *
 * **称呼后面那个名字是设置里的「程序名称」**（`shared/app-name.ts` 收敛，默认 `MUYIAN`，
 * 与标题栏、托盘提示、窗口标题同一个值）：它是**你给这个程序起的名字**，只有你会设它，
 * 所以「晚上好，MUYIAN」读起来是在叫你。取它而不是取账号昵称有两个理由 ——
 * 它**不一定有**（登录是可选的，没登录时昵称无从谈起，而这一行不该因此少半句），
 * 也**不该在这一行**（账号那一层归顶栏右上角，见下）。
 *
 * 数据全在 projects / settings 两个 store 里，**一次 IPC 都不发**：这一行在首屏上，
 * 为它多等一轮往返不值得（工作日志那种要另读一份文件的数字就不放进来）。
 *
 * **这里不放头像 / 昵称**：这一行与顶栏右上角那颗头像在同一行上 ——
 * 同一个账号在一条横线上画两遍，看着像画重了。账号入口归那颗头像，
 * 「认得你」由这句话与这几条事实承担（它们说的都是**你**这台机器上的事）。
 */
import { computed } from 'vue'
import { dayKey, streakOf } from '@shared/activity'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

const store = useProjectsStore()
const settings = useSettingsStore()

/** 称呼后面那个名字：设置里的程序名称，收敛过所以一定有值（空串回落到默认名） */
const name = computed(() => settings.settings.appName)

/**
 * 现在几点。
 *
 * 先取整数再往下传：store.clock 每秒变一次，这个 computed 也就每秒重算一次，
 * 但算出来的值一天只变 6 次 —— Vue 的 computed 按值决定要不要通知下游，
 * 所以依赖它的模板并不会被每秒叫醒（与活跃度图绕开 clock 是同一个考虑）。
 */
const hour = computed(() => new Date(store.clock).getHours())

/**
 * 深夜。与 greeting 的最后一档同一个判据：凌晨四点那句「早上好」是不对的，
 * 就照实说夜深了。
 */
const isNight = computed(() => hour.value < 5 || hour.value >= 23)

/**
 * 按时间段的一句称呼。分档按多数人的作息切，深夜与凌晨合成一档。
 */
const greeting = computed(() => {
  const value = hour.value
  if (value < 5 || value >= 23) return '夜深了'
  if (value < 11) return '早上好'
  if (value < 13) return '中午好'
  if (value < 18) return '下午好'
  return '晚上好'
})

/** 今天跑过几次（命令开跑那天计数，见 shared/activity.ts） */
const todayCount = computed(() => store.activity[dayKey(store.dayStart)] ?? 0)

/** 连着用了多少天：今天还没动手也不算断，从昨天数起 */
const streak = computed(() => streakOf(store.activity, new Date(store.dayStart)))

/**
 * 今天这一行实话：只说非零的那些。
 *
 * 「连续 1 天」刻意不显示 —— 第一次用就是这个数，摆在首页像在自我表扬；
 * 从第 2 天起它才真的是一条「你一直在做」的信息。三条都为零时整段不画，
 * 那一行只剩称呼，也是如实的。
 *
 * 深夜那份多一个「还」字：凌晨两点看到「2 个项目在跑」是陈述，看到「还在跑」
 * 才是你此刻真要知道的那件事 —— 有些东西忘了关。
 */
const facts = computed(() => {
  const parts: string[] = []
  if (store.runningCount) {
    parts.push(isNight.value ? `${store.runningCount} 个项目还在跑` : `${store.runningCount} 个项目在跑`)
  }
  if (todayCount.value) parts.push(`今天 ${todayCount.value} 次执行`)
  if (streak.value > 1) parts.push(`连续 ${streak.value} 天`)
  return parts
})

/** 一个项目都还没有：这一行换成「下一步该做什么」，别让首屏是一句干瘪的称呼 */
const firstRun = computed(() => store.ready && store.projects.length === 0)
</script>

<template>
  <div class="greet">
    <p class="greet__line">
      <span class="greet__hello">{{ greeting }}，{{ name }}</span>
      <span v-if="firstRun" class="greet__facts">
        还没有项目。加一个之后，这里会记下每天的动静。
      </span>
      <span v-else-if="facts.length" class="greet__facts">
        <template v-for="(fact, index) in facts" :key="fact">
          <span v-if="index" class="greet__dot" aria-hidden="true">·</span>{{ fact }}
        </template>
      </span>
    </p>
  </div>
</template>

<style scoped>
.greet {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  /* 顶栏是 flex 行：欢迎语贴左，右上角那排工具按钮 margin-left:auto 归右边 */
  min-width: 0;
}

.greet__line {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  min-width: 0;
  margin: 0;
}

.greet__hello {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
}

.greet__facts {
  font-size: var(--fs-meta);
  color: var(--ink-3);
  /* 窗口窄时先省略这一段 —— 称呼比统计重要 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.greet__dot {
  margin: 0 6px;
  color: var(--border-strong);
}
</style>
