<script setup lang="ts">
/**
 * 运行面板：这一轮的事件流、收尾与结果。
 *
 * 日志按种类上色（彩色只表达运行状态）：工具调用与提示是灰的、助手正文是正文色、
 * 出错走 `--st-fail`、结束走 `--st-ok`。行随进度往下追加，面板自己滚到底 ——
 * 不然每来一行都得手动拖一次。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Download, VideoPause } from '@element-plus/icons-vue'
import type { AiLogLine } from '@shared/ai'

const props = defineProps<{
  /** 这台机器上探到的 Pi 版本；空串 = 还没装 */
  piVersion: string
  running: boolean
  installing: boolean
  installLog: string[]
  lines: AiLogLine[]
  exitCode: number | null
  runError: string
  written: string[]
}>()

const emit = defineEmits<{ install: []; stop: [] }>()

const scroller = ref<HTMLElement | null>(null)

/** 日志变了就滚到底：跟着最新那行走 */
watch(
  () => [props.lines.length, props.installLog.length],
  async () => {
    await nextTick()
    const box = scroller.value
    if (box) box.scrollTop = box.scrollHeight
  }
)

/** 日志里出现过报错（或 runError 本身）：「跑完了」就不该是一副顺利的样子 */
const hasError = computed(
  () => props.runError !== '' || props.lines.some((line) => line.kind === 'error')
)

const statusText = computed(() => {
  if (props.installing) return '正在安装 Pi…'
  if (props.running) return '运行中…'
  if (props.runError) return props.runError
  if (props.exitCode === 0) return hasError.value ? '跑完了，但有报错（见日志）' : '这一轮跑完了'
  return '还没跑过'
})

/** 状态词的颜色：跑着是进行色、出错是失败色、顺利跑完是成功色 */
const statusKind = computed(() => {
  if (props.installing || props.running) return 'run'
  if (props.runError || (props.exitCode === 0 && hasError.value)) return 'fail'
  return props.exitCode === 0 ? 'ok' : ''
})
</script>

<template>
  <div class="run">
    <div class="run__head">
      <span class="run__status" :class="statusKind ? `is-${statusKind}` : ''">{{ statusText }}</span>
      <span class="run__tools">
        <el-tooltip v-if="!piVersion" content="全局装一个 Pi（npm install -g）" placement="bottom">
          <el-button size="small" :icon="Download" :loading="installing" @click="emit('install')">
            安装 Pi
          </el-button>
        </el-tooltip>
        <el-button v-if="running" size="small" :icon="VideoPause" @click="emit('stop')">
          停止
        </el-button>
      </span>
    </div>

    <div ref="scroller" class="run__log">
      <template v-if="installing || installLog.length">
        <p v-for="(line, index) in installLog" :key="`install-${index}`" class="run__line is-info mono">
          {{ line }}
        </p>
      </template>
      <template v-else-if="lines.length">
        <p v-for="(line, index) in lines" :key="index" class="run__line mono" :class="`is-${line.kind}`">
          {{ line.text }}
        </p>
      </template>
      <p v-else class="run__hint">
        {{ piVersion ? '写好指令，点右上那颗「开始」。' : '没找到 Pi 运行时：点右上「安装 Pi」全局装一个。' }}
      </p>
    </div>

    <div v-if="written.length" class="run__foot">
      <p class="run__written">
        写下 {{ written.length }} 个文件：
        <span class="mono">{{ written.join('、') }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.run {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  height: 100%;
}

.run__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.run__status {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.run__status.is-run {
  color: var(--st-run);
}

.run__status.is-ok {
  color: var(--st-ok);
}

.run__status.is-fail {
  color: var(--st-fail);
}

.run__tools {
  display: flex;
  gap: var(--sp-2);
}

.run__log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.run__line {
  margin: 0 0 2px;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.run__line.is-text {
  color: var(--ink);
}

.run__line.is-info {
  color: var(--ink-3);
}

.run__line.is-error {
  color: var(--st-fail);
}

.run__line.is-done {
  color: var(--st-ok);
}

.run__hint {
  margin: 0;
  padding: var(--sp-4) 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-align: center;
  line-height: 1.7;
}

.run__foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid var(--border);
  padding-top: var(--sp-2);
}

.run__written {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
  word-break: break-word;
}
</style>
