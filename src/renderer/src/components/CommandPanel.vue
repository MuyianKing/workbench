<script setup lang="ts">
/**
 * 首页「命令」卡片：一批独立于项目的命令，点一下就跑。
 *
 * 一条命令就是「名称 + 一行命令原文 + 一个可选的监听端口」，没有项目那种目录与脚本配置；
 * 但进程仍由 Workbench 接管 —— 有日志、能停止，输出进底部终端。
 * 端口是「它是不是已经在跑了」的判据：配了端口才能认出在应用之外启动的那种。
 *
 * 条目沿用项目卡那套视觉语言：左边一条状态色带，卡上是「名称 + 端口」与命令行原文两行，
 * 启停 / 检测 / 更多三个按钮悬停时从右上角浮出来（顺带把端口让开，免得遮住名称）。
 * 状态文字、外部启动这类说明在悬停提示里。
 */
import { computed, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  Loading,
  MoreFilled,
  Plus,
  Search,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue'
import { commandStatusLabel, statusTone } from '@/status'
import { useProjectsStore } from '@/stores/projects'
import type { CommandEntry, ProjectStatus } from '@/types'

const store = useProjectsStore()

const commands = computed(() => store.commands)

/** 正在检测运行状态的命令 id：按钮转圈，避免连点重复探测 */
const detectingId = ref<string | null>(null)

function statusOf(item: CommandEntry): ProjectStatus {
  return store.runtimeOf(item.id).status
}

function isRunning(item: CommandEntry): boolean {
  return statusOf(item) === 'running'
}

/** 端口：优先取配置的那个，其次用从启动日志里认出来的 */
function portOf(item: CommandEntry): number | undefined {
  return item.port ?? store.runtimeOf(item.id).port
}

/** 悬停提示：卡上放不下的信息都在这儿 —— 状态、端口、以及按端口认出来时的那句说明 */
function tipOf(item: CommandEntry): string {
  const rt = store.runtimeOf(item.id)
  const state = commandStatusLabel(statusOf(item)) + (rt.external ? '（由 Workbench 之外启动）' : '')
  const port = portOf(item)
  return [item.name, state, port ? `端口 ${port}` : ''].filter(Boolean).join('\n')
}

function detectTip(item: CommandEntry): string {
  return portOf(item) ? '检测运行状态（按监听端口判断）' : '没有配置监听端口，无法检测'
}

async function detect(item: CommandEntry): Promise<void> {
  detectingId.value = item.id
  try {
    await store.detectCommand(item.id)
  } finally {
    detectingId.value = null
  }
}

function toggle(item: CommandEntry): void {
  if (isRunning(item)) void store.stopCommand(item.id)
  else void store.startCommand(item.id)
}

function onMore(item: CommandEntry, command: string): void {
  if (command === 'edit') store.openCommandDialog(item.id)
  else if (command === 'remove') void remove(item)
}

async function remove(item: CommandEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(
      isRunning(item)
        ? `「${item.name}」正在运行，删除会先停止它。确定删除？`
        : `确定删除「${item.name}」？只是从这里移除配置，命令本身不会被卸载。`,
      '删除命令',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await store.removeCommand(item.id)
}
</script>

<template>
  <section class="panel commands">
    <!-- 标题固定：它不在下面那块滚动区里，命令再多也不会被滚走 -->
    <header class="panel__head">
      <span class="eyebrow">命令</span>
    </header>

    <!--
      添加入口挂在卡片右上角，绝对定位：放进标题栏的话按钮会比文字行高，
      标题栏被撑高几像素，固定高度的卡片就会把列表挤下去（与「快捷启动」同一处理）。
    -->
    <el-tooltip content="添加命令" placement="bottom-end" :show-after="250">
      <button
        class="commands__add"
        type="button"
        aria-label="添加命令"
        @click="store.openCommandDialog()"
      >
        <el-icon><Plus /></el-icon>
      </button>
    </el-tooltip>

    <div class="commands__body panel__scroll">
      <p v-if="!commands.length" class="panel__empty">还没有命令<br />点右上角的 + 添加</p>

      <ul v-else class="commands__list">
        <li
          v-for="item in commands"
          :key="item.id"
          class="cmd"
          :class="`tone-${statusTone(statusOf(item))}`"
          :title="tipOf(item)"
        >
          <div class="cmd__row">
            <i class="cmd__dot" aria-hidden="true" />
            <span class="cmd__name truncate">{{ item.name }}</span>
            <span v-if="portOf(item)" class="cmd__port mono">:{{ portOf(item) }}</span>
          </div>

          <p class="cmd__text mono truncate">{{ item.command }}</p>

          <div class="cmd__acts">
            <button
              class="cmd__btn"
              type="button"
              :class="{ 'is-stop': isRunning(item) }"
              :title="isRunning(item) ? `停止 ${item.name}` : `启动 ${item.name}`"
              :aria-label="isRunning(item) ? '停止' : '启动'"
              @click="toggle(item)"
            >
              <el-icon>
                <VideoPause v-if="isRunning(item)" />
                <VideoPlay v-else />
              </el-icon>
            </button>

            <button
              class="cmd__btn"
              type="button"
              :disabled="!portOf(item)"
              :title="detectTip(item)"
              aria-label="检测运行状态"
              @click="detect(item)"
            >
              <el-icon :class="{ 'is-loading': detectingId === item.id }">
                <Loading v-if="detectingId === item.id" />
                <Search v-else />
              </el-icon>
            </button>

            <el-dropdown
              class="cmd__more"
              trigger="click"
              placement="bottom-end"
              @command="onMore(item, $event)"
            >
              <button
                class="cmd__btn"
                type="button"
                :title="`${item.name} 的更多操作`"
                aria-label="更多操作"
                @click.stop
              >
                <el-icon><MoreFilled /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit">编辑…</el-dropdown-item>
                  <el-dropdown-item command="remove" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* 下沿不留白：内容本来就挤，底部再垫一层内边距会白占一截 */
.panel {
  padding-bottom: 0;
}

/**
 * 滚动区：标题在它外面所以固定不动，这里只放命令卡。
 * 高度跟着卡片走（卡片是用户拖出来的尺寸），命令多到放不下就自己滚。
 */
.commands__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/**
 * 命令卡：一行排几个，列数按可用宽度自适应 —— 卡片越宽一排放得越多，
 * 拖到中间栏（约 700px）时一排三个。196px 是「名称 + 端口 + 三个悬停按钮」放得住的最小宽度。
 */
.commands__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 6px;
  align-content: start;
}

/* ---------- 单条命令 ---------- */
.cmd {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  /*
   * 左边留出状态色带的位置。上下 5px、两行各自写明行高，整卡压到 42px ——
   * 卡片拖到最小高度（90px）时，标题下面正好完整放得下一排，不留半截被裁的卡。
   */
  padding: 5px 8px 5px 12px;
  border-radius: var(--r-md);
  /* 面板本身是白的，卡用一层浅底而不是白底：靠底色而不是边框分层 */
  background: var(--bg-subtle);
  transition: background 0.15s ease;
}

/*
 * 状态色带：与项目卡左下那条同源，颜色即状态。
 * 不跑到上下边缘，做成一小段圆头，比整条通栏更轻、也更像项目卡的语汇。
 */
.cmd::before {
  content: '';
  position: absolute;
  inset: 5px auto 5px 0;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--st-idle);
  opacity: 0.5;
}

.tone-run .cmd::before {
  background: var(--st-run);
  opacity: 1;
}

.tone-fail .cmd::before {
  background: var(--st-fail);
  opacity: 1;
}

.cmd:hover {
  background: var(--bg-inset);
}

.cmd__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  line-height: 16px;
}

/* 状态灯：色带是主信号，这里补一枚小点，让名称那行自己也带状态 */
.cmd__dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-idle);
  opacity: 0.45;
}

.tone-run .cmd__dot {
  background: var(--st-run);
  opacity: 1;
  animation: cmd-pulse 1.4s ease-in-out infinite;
}

.tone-fail .cmd__dot {
  background: var(--st-fail);
  opacity: 1;
}

@keyframes cmd-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.cmd__name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.cmd__port {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
  transition: opacity 0.15s ease;
}

/* 命令行原文：卡上第二行，缩成一行显示，完整内容在悬停提示里 */
.cmd__text {
  font-size: var(--fs-micro);
  line-height: 14px;
  color: var(--ink-3);
}

/* ---------- 悬停才浮出的三个按钮 ---------- */
.cmd__acts {
  position: absolute;
  top: 4px;
  right: 5px;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.cmd:hover .cmd__acts,
.cmd:focus-within .cmd__acts {
  opacity: 1;
}

/* 按钮浮出来时把端口让开：一排按钮正好压在它上面，留着会互相叠字 */
.cmd:hover .cmd__port,
.cmd:focus-within .cmd__port {
  opacity: 0;
}

/**
 * 图标按钮自己画：Element Plus 的 size="small" 是 24px 带描边的小方块，
 * 一排三个压在卡片角上会显得很碎 —— 这里做成无边框的幽灵按钮，常态只是灰色图标，
 * 悬停才浮出底色（比卡片再深一档，两种主题下都是「抬起来」的方向）。
 */
.cmd__btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.cmd__btn:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

.cmd__btn:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}

/* 没配端口就无从检测：按钮只是淡下去，不画成一块死掉的灰方块 */
.cmd__btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.cmd__btn:disabled:hover {
  background: transparent;
  color: var(--ink-2);
}

/* 运行中：启动按钮变成停止，并点亮状态色 */
.cmd__btn.is-stop {
  color: var(--st-run);
}

.cmd__btn.is-stop:hover {
  background: var(--st-run-soft);
  color: var(--st-run);
}

.cmd__more {
  display: inline-flex;
}

/* ---------- 卡片右上角的添加入口 ---------- */
.commands__add {
  position: absolute;
  /* 与标题那行文字（eyebrow）大致对齐，具体像素不重要，反正不占流 */
  top: 12px;
  right: 12px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  /* 只要一个 +：这块是标题栏上的外挂入口，画成描边小方块会跟下面的按钮抢视线 */
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.commands__add:hover {
  color: var(--ink);
}
</style>
