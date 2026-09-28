<script setup lang="ts">
/**
 * 对话面板：这一段对话（历史 + 这一轮）、收尾与结果。**版式是聊天**：
 *
 *  - **用户自己写的那几句靠右**（浅底气泡、限宽），助手的回话在左 —— 一段对话里
 *    「我说到哪儿了」一眼看得出来；
 *  - **助手的正文就是正文**（走 MarkdownView 渲染，没有气泡框）：它常常几屏长，
 *    套个框只会把阅读面积削掉一圈；
 *  - 工具调用与系统那几行是**浅灰的窄行**（只有工具行里的路径用等宽）：它们不是对话内容，
 *    是这一轮干了什么的注脚；
 *  - 一轮跑完在末尾补一行「用时 …」（`duration`）：回复长的时候这是量级。
 *    **轮与轮之间的那两条进度行（开始执行 / 执行结束）不画**（见 stores/ai.ts 的 isTurnMarker）——
 *    那种分节放在单次运行的步骤流里合适，放到连续对话里就是每轮插一句的噪音。
 *  - 出错走 `--st-fail`、结束走 `--st-ok`，彩色仍然只表达运行状态。
 *
 * **对话区没有自己的底色**（既不灰也不描边）：这一块就是那张卡片本身，
 * 底色由 `.panel` 与外层的卡片不透明度决定（踩过：在这里铺一层 `--bg-inset`，
 * 用户看到的就是一大块灰）。分隔靠行与行之间的留白，不靠框。
 *
 * 顶部那一行**只在有事情要说的时候出现**：等你确认命令、正在接历史、正在停、正在跑、
 * 在装 Pi、出错、或者还缺 Pi 要装。跑得顺利时它整条不画 —— 「这一轮跑完了」对用户没有
 * 信息量，白占一行。
 *
 * **等确认的那条命令**（`confirms`，只有「自动编辑」那一档会有）画在对话的末尾：
 * 它是流程里的一道闸 —— Pi 那边正停在这一句上，答完才往下走（答复见 stores/ai.ts）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Download, Loading } from '@element-plus/icons-vue'
import MarkdownView from '@/components/MarkdownView.vue'
import { visibleInstruction, type AiConfirm, type AiLogLine } from '@shared/ai'

const props = defineProps<{
  /** 这台机器上探到的 Pi 版本；空串 = 还没装 */
  piVersion: string
  running: boolean
  /** 正在把这一段的历史接上（打开会话时读一次） */
  hydrating: boolean
  /** 用户刚点了停止（`abort` 发出去了，等它收尾） */
  stopping: boolean
  installing: boolean
  installLog: string[]
  lines: AiLogLine[]
  /**
   * 助手正在流式吐出来的那段文字（增量攒到一定间隔才发布一次，见 stores/ai.ts 的 STREAM_TICK）：
   * 它接在已落地的那几行后面，等整段到了（`message_end`）就换成那一段 —— 开头那半句
   * 与最终版可能有极小的差别（块与块之间的换行），换过去时以整段为准。
   */
  streaming: string
  /** 等用户答话的命令（队首那条才画，答完下一条） */
  confirms: AiConfirm[]
  exitCode: number | null
  runError: string
  written: string[]
}>()

const emit = defineEmits<{ install: []; answer: [id: string, allowed: boolean] }>()

const scroller = ref<HTMLElement | null>(null)

/**
 * 画之前过一道：**用户那句剥掉提示词脚手架**（`你在下面这个目录里工作：…` 那行是给模型看的，
 * 用户自己没写过它，见 shared/ai.ts 的 visibleInstruction）。读历史那条路已经剥过一次，
 * 这里再兜一道不是多余：内存里可能还留着修复之前读进来的老行，剥两遍是幂等的。
 * 剥完空掉的行（只有脚手架、没有正文）不画。
 */
const shown = computed(() =>
  props.lines
    .map((line) =>
      line.kind === 'user' ? { ...line, text: visibleInstruction(line.text).trim() } : line
    )
    .filter((line) => !(line.kind === 'user' && !line.text))
)

/** 正在画的那一条（没有就是 null） */
const confirm = computed(() => props.confirms[0] ?? null)

/** 对话变了就滚到底：跟着最新那行走（确认条也长在末尾，它出现时同样要滚过去；
    流式那段的长度也要算上，不然字在长、视图不动） */
watch(
  () => [props.lines.length, props.installLog.length, props.confirms.length, props.streaming.length],
  async () => {
    await nextTick()
    const box = scroller.value
    if (box) box.scrollTop = box.scrollHeight
  }
)

/** 对话里出现过报错（或 runError 本身）：这种「跑完了」不能装作顺利 */
const hasError = computed(
  () => props.runError !== '' || props.lines.some((line) => line.kind === 'error')
)

/**
 * 顶部那一行说什么：等你确认 / 接历史 / 停 / 跑着 / 在装 / 出错这几种要占它，
 * 其余时候是空的（整条不画）。顺利跑完不报信，出错的那次必须报 —— 见 docs/constraints/ai.md。
 * 「等你确认」排在最前：那会儿进程正停在命令上，说「运行中」等于没说。
 */
const notice = computed<{ text: string; kind: 'run' | 'fail' } | null>(() => {
  if (props.installing) return { text: '正在安装 Pi…', kind: 'run' }
  if (confirm.value) return { text: '等你确认这条命令…', kind: 'run' }
  if (props.stopping) return { text: '正在停下这一轮…', kind: 'run' }
  if (props.running) return { text: '运行中…', kind: 'run' }
  // 接历史那一下：它是这一屏自己的事，不是对话里的一句（从前那行画在对话区里，挪到这儿了）
  if (props.hydrating) return { text: '正在接上这段对话…', kind: 'run' }
  if (props.runError) return { text: props.runError, kind: 'fail' }
  if (props.exitCode === 0 && hasError.value) return { text: '跑完了，但日志里有报错', kind: 'fail' }
  return null
})

/** 那一行出现不出现：有话说、或者还缺 Pi（那颗「安装 Pi」挂在这一行上） */
const hasHead = computed(() => notice.value !== null || !props.piVersion)
</script>

<template>
  <div class="run">
    <div v-if="hasHead" class="run__head">
      <span v-if="notice" class="run__status" :class="`is-${notice.kind}`">
        <el-icon v-if="notice.kind === 'run'" class="run__spin"><Loading /></el-icon>
        {{ notice.text }}
      </span>
      <span class="run__tools">
        <el-tooltip v-if="!piVersion" content="全局装一个 Pi（npm install -g）" placement="bottom">
          <el-button size="small" :icon="Download" :loading="installing" @click="emit('install')">
            安装 Pi
          </el-button>
        </el-tooltip>
      </span>
    </div>

    <div ref="scroller" class="run__log">
      <template v-if="installing || installLog.length">
        <p v-for="(line, index) in installLog" :key="`install-${index}`" class="run__meta mono">
          {{ line }}
        </p>
      </template>
      <template v-else-if="lines.length || confirm || streaming">
        <div
          v-for="(line, index) in shown"
          :key="index"
          class="msg"
          :class="`is-${line.kind}`"
        >
          <!-- 助手说的话：正文（没有气泡框 —— 它常常几屏长，框住只会少一圈阅读面积） -->
          <MarkdownView v-if="line.kind === 'text'" :source="line.text" />
          <!-- 用户自己写的那几句：靠右的气泡 -->
          <p v-else-if="line.kind === 'user'" class="msg__bubble">{{ line.text }}</p>
          <!-- 一轮跑完的收据 / 窄行注脚：鼠标停一下才出 detail（那条命令行收在这上面） -->
          <p
            v-else
            class="run__meta"
            :class="{ 'has-detail': line.detail }"
            :title="line.detail"
          >
            {{ line.text }}
          </p>
        </div>

        <!-- 正在长出来的那段回话：就是正文，末尾一根小竖条表示它还在写 -->
        <div v-if="streaming" class="msg is-text is-streaming">
          <MarkdownView :source="streaming" />
          <span class="msg__caret" aria-hidden="true" />
        </div>

        <!-- 等确认的那条命令：流程停在这儿，答完 Pi 才往下走（只有「自动编辑」那一档会有） -->
        <div v-if="confirm" class="run__confirm">
          <p class="run__confirm-title">{{ confirm.title }}</p>
          <pre class="run__confirm-cmd">{{ confirm.message }}</pre>
          <div class="run__confirm-actions">
            <el-button type="primary" size="small" @click="emit('answer', confirm.id, true)">
              允许执行
            </el-button>
            <el-button size="small" @click="emit('answer', confirm.id, false)">拒绝</el-button>
            <span v-if="confirms.length > 1" class="run__confirm-more">
              后面还有 {{ confirms.length - 1 }} 条在等
            </span>
          </div>
        </div>
      </template>

      <!-- 这段对话还没开始：说一句就开始（composer 就在下面）。接历史那一会儿不写这句，
           否则会同时出现「正在接上这段对话…」与「还没有开始」两句相反的说明 -->
      <p v-else-if="!installing && !hydrating" class="run__meta is-quiet">
        这段对话还没有开始 —— 在下面写点什么。
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
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

/* 跑着的那点动静：转圈 + 状态词，与首页「系统状态」那些运行态同一套意思 */
.run__spin {
  font-size: var(--fs-meta);
  animation: run-spin 1.2s linear infinite;
}

@keyframes run-spin {
  to {
    transform: rotate(360deg);
  }
}

.run__status.is-run {
  color: var(--st-run);
}

.run__status.is-fail {
  color: var(--st-fail);
}

.run__tools {
  display: flex;
  gap: var(--sp-2);
}

/**
 * 对话区：**没有自己的底色、也不描边** —— 这块就是那张卡片本身（踩过：在这里铺一层
 * `--bg-inset`，用户看到的就是一大块灰）。里面按聊天排：用户的话靠右、助手的在左。
 */
.run__log {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.msg {
  display: flex;
  flex-direction: column;
}

/* 助手的正文：段与段之间留一口气，别贴着上面那一条窄行 */
.msg.is-text {
  margin: var(--sp-2) 0;
}

/**
 * 正在长出来的那段：末尾一根小竖条（轻轻闪一下）—— 它是「还在写」的记号。
 * 与已落地的那几行同一套排版，所以整段到齐时只是竖条消失，字不会跳。
 */
.msg.is-streaming {
  position: relative;
}

.msg__caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-top: 2px;
  background: var(--ink-3);
  animation: msg-caret 1s steps(2, start) infinite;
}

@keyframes msg-caret {
  50% {
    opacity: 0;
  }
}

/* 用户那一句：贴着右边，靠留白与它上面的内容分开 */
.msg.is-user {
  align-items: flex-end;
  margin: var(--sp-3) 0 var(--sp-1);
}

/**
 * 用户的气泡：**浅底 + 一档边框**，限宽（一句话不该拉满整个对话区）。
 * 底色用卡片面那一档而不是 `--bg-inset` —— 后者发灰，与这一屏「不要灰底」的取向相反；
 * 暗色下它与面板同色，靠边框也读得出是一个气泡。
 */
.msg__bubble {
  max-width: 72%;
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg) var(--r-lg) var(--r-sm) var(--r-lg);
  background: var(--bg-surface);
  color: var(--ink);
  font-size: var(--fs-body);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 系统行与工具行：比正文轻得多（工具行稍深一点，路径走等宽） */
.run__meta {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.is-tool .run__meta {
  color: var(--ink-2);
  font-family: var(--font-mono);
}

.msg.is-error .run__meta {
  color: var(--st-fail);
}

.msg.is-done .run__meta {
  color: var(--st-ok);
}

/* 一轮的用时：这一轮的句号，比注脚还要轻 */
.msg.is-duration .run__meta {
  margin-top: var(--sp-1);
  color: var(--ink-3);
}

/* 有 detail 的行：光标变问号，提示「停一下有更多」 */
.run__meta.has-detail {
  cursor: help;
}

/* 空对话那一句 */
.run__meta.is-quiet {
  color: var(--ink-3);
}

/**
 * 等确认的那一条：**流程里的一道闸**（Pi 正停在这次命令上），画得比窄行重一档 ——
 * 卡片底 + 边框，命令原文走等宽、整条看得全（多行也不截）。
 */
.run__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
}

.run__confirm-title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-meta);
}

.run__confirm-cmd {
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.run__confirm-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.run__confirm-more {
  color: var(--ink-3);
  font-size: var(--fs-micro);
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
