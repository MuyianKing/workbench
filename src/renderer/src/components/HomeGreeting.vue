<script setup lang="ts">
/**
 * 顶栏左侧那一行：**整个界面里唯一一处「认得你」的地方**。
 *
 * 它原来在首页画布顶部、自己带一块卡片底衬；全局搜索移除后挪进顶栏，住进搜索框
 * 空出来的位置 —— 首屏第一眼先是这句，首页画布也少了一层、整块让给卡片。
 * 顶栏本身有实底，这一行不再需要底衬。
 *
 * 它只说两件已经发生的事：现在是什么时候（一句按时间段的称呼，后面跟着**你是谁**），
 * 以及你这些机器上目前的状况（几条从本机数据里现取的实话）。
 * 不打招呼、不问好、不鼓励 —— 那些在这个应用的语气里是噪音（见 AGENTS.md 的「如实说明」）。
 *
 * **称呼后面那个名字是当前登录账号的用户名**（`AccountProfile.login`，见 `shared/auth.ts`）：
 * 这一行是首屏上唯一一处「认得你」，说出来的就该是**此刻登录的那个 git 账号**，
 * 而不是给程序起的名字。取登录名而不是昵称 —— 昵称是平台上的展示名（可能重名、也可能没填过），
 * 登录名才是「哪个账号」。
 *
 * **没登录时回落到设置里的「程序名称」**（`shared/app-name.ts` 收敛，默认 `MUYIAN`，
 * 与标题栏、托盘提示、窗口标题同一个值）：登录是可选的，而这一行不该因为没登录就少半句。
 *
 * 数据全在 projects / settings / auth 三个 store 里，**一次 IPC 都不发**：账号状态由
 * projects store 初始化时问过一次（`refreshAuth`，只读凭据管理器、不联网），这里只读那个结果；
 * 这一行在首屏上，为它多等一轮往返不值得（工作日志那种要另读一份文件的数字就不放进来）。
 *
 * **这里不放头像**：账号入口归顶栏右上角那颗头像，这一行只说事情、只出一个名字。
 */
import { computed } from 'vue'
import { dayKey, streakOf } from '@shared/activity'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

const store = useProjectsStore()
const settings = useSettingsStore()
const auth = useAuthStore()

/** 当前登录的账号；null 表示没登录，或还没问过后端 —— 两种都回落到程序名称 */
const account = computed(() => auth.status?.account ?? null)

/**
 * 称呼后面那个名字：登录名优先，没登录用设置里的程序名称。
 * 两个来源都收敛过（见 shared/auth.ts / shared/app-name.ts），所以一定有值。
 */
const name = computed(() => account.value?.login ?? settings.settings.appName)

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
