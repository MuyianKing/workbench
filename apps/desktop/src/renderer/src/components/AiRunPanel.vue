<script setup lang="ts">
import type { AiConfirm, AiLogLine } from '@workbench/ai'
import { Download, Loading } from '@element-plus/icons-vue'
import { aiTurns, visibleInstruction } from '@workbench/ai'
/**
 * 对话面板：这一段对话（历史 + 这一轮）、收尾与结果。**版式是聊天**：
 *
 *  - **用户自己写的那几句靠右**（浅底气泡、限宽），助手的回话在左 —— 一段对话里
 *    「我说到哪儿了」一眼看得出来；**那句话里贴的图排在文字上面**（`AiLogLine.images`，
 *    缩到一行大小只是「发过哪几张」的记号，点一下开 EP 的查看器看大图）；
 *  - **一轮 = 用户那句 + 一块「过程」+ 最后那段正文 +「用时…」**（切法在 shared/ai.ts 的
 *    `aiTurns`）。**过程整块收着**（`AiProcess.vue`）：模型想的那几段、工具调用、报错、
 *    中途那些旁白都在里面 —— 一段对话要读的是「我说了什么、它最后说了什么」，
 *    那些步骤摊着就是一面墙（一次读文件、一条命令各占一行）。跑着的时候那块是摊开的
 *    （标题上转圈说「正在思考… / {程序名}正在努力探索中....」），跑完自动收起，点标题随时再摊开；
 *    **跑着的那轮还没有「答案」** —— 正文后面随时会跟上工具与思考，先摘出去的话，
 *    新长出来的思考就压在它上面了（时序倒挂），整轮都在块里按时序往下长，收尾才把
 *    最后那段正文弹出去（见 aiTurns 的 live）；
 *  - **答案（收尾时最后那段正文）摊在外面**（走 MarkdownView 渲染，没有气泡框）：它常常几屏长，
 *    套个框只会把阅读面积削掉一圈。过程里那些旁白照常渲染 markdown，只是跟着过程一起收着；
 *    正文里的**站内链接与「写下 N 个文件」都点得动** —— 经 `open` 交给 AiView，在右侧
 *    预览栏里打开（外部 http(s) 地址照旧交系统浏览器，见 MarkdownView）；
 *  - 过程里的工具行与系统行是**浅灰的窄行**（只有工具行里的路径用等宽），报错走 `--st-fail`；
 *    想的那几段是纯文本（草稿里的半截标记不该被当成排版）。
 *    **轮与轮之间的那两条进度行（开始执行 / 执行结束）不画**（见 stores/ai.ts 的 isTurnMarker）——
 *    那种分节放在单次运行的步骤流里合适，放到连续对话里就是每轮插一句的噪音。
 *
 * **对话区没有自己的底色**（既不灰也不描边）：这一块就是那张卡片本身，
 * 底色由 `.panel` 与外层的卡片不透明度决定（踩过：在这里铺一层 `--bg-inset`，
 * 用户看到的就是一大块灰）。分隔靠行与行之间的留白，不靠框。
 *
 * 顶部那一行**只在有事情要说的时候出现**：等你确认命令、正在接历史、正在停、在装 Pi、
 * 出错、或者还缺 Pi 要装。**「还在跑」不归它说** —— 那是模型自己的动静：想的时候在
 * 「思考过程」那一块上转圈、写的时候在正文末尾闪一根竖条，顶部再说一句「运行中…」
 * 只是重复（顺带一提，它从前就在那儿，把思考的 loading 说成了整轮的状态）。
 *
 * **等确认的那条命令**（`confirms`，只有「自动编辑」那一档会有）画在对话的末尾：
 * 它是流程里的一道闸 —— Pi 那边正停在这一句上，答完才往下走（答复见 stores/ai.ts）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import AiProcess from '@/components/AiProcess.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import { basenameOf } from '@/format'

const props = defineProps<{
  /** 程序名（设置里的那个）：跑着那一轮的过程标题拿它当主语（见 processLabel） */
  appName: string
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
   * 它画在跑着那轮的过程块末尾（落地也落进块里，不跳位置），等整段到了（`message_end`）
   * 就换成那一段 —— 开头那半句与最终版可能有极小的差别（块与块之间的换行），换过去时以整段为准。
   */
  streaming: string
  /**
   * 模型正在想的那一段（`thinking_delta` 攒出来的过程版）：画在跑着那一轮的「过程」里
   * （那一块摊着），与顶部那行状态无关 —— 它就是那一刻的 loading（见 AiProcess.vue）。
   */
  thinkingText: string
  /** 这一刻正在思考：光有转圈与「思考中…」，正文还没开始吐 */
  thinking: boolean
  /** 等用户答话的命令（队首那条才画，答完下一条） */
  confirms: AiConfirm[]
  exitCode: number | null
  runError: string
  written: string[]
}>()

const emit = defineEmits<{ install: [], answer: [id: string, allowed: boolean], open: [href: string] }>()

/** 正文里的站内链接与「写下 N 个文件」都从这儿出去：AiView 对到工作目录、开右侧预览栏 */
function openLink(href: string): void {
  emit('open', href)
}

/** 「写下 N 个文件」那行只显示文件名，全路径在悬停里 */
function fileNameOf(path: string): string {
  return basenameOf(path)
}

const scroller = ref<HTMLElement | null>(null)

/**
 * 画之前过一道：**用户那句剥掉提示词脚手架**（`你在下面这个目录里工作：…` 那行是给模型看的，
 * 用户自己没写过它，见 shared/ai.ts 的 visibleInstruction）。读历史那条路已经剥过一次，
 * 这里再兜一道不是多余：内存里可能还留着修复之前读进来的老行，剥两遍是幂等的。
 * 剥完空掉的行不画 —— 但**只贴了图没写字的那句要留下**（图就是那句话的内容）。
 */
const shown = computed(() =>
  props.lines
    .map(line =>
      line.kind === 'user' ? { ...line, text: visibleInstruction(line.text).trim() } : line,
    )
    .filter(line => !(line.kind === 'user' && !line.text && !line.images?.length)),
)

/** 正在画的那一条（没有就是 null） */
const confirm = computed(() => props.confirms[0] ?? null)

/** 整条日志按「轮」切开（用户那句 + 过程 + 答案 + 收据；跑着的那轮不摘答案，见 shared/ai.ts 的 aiTurns） */
const turns = computed(() => aiTurns(shown.value, props.running))

/** 还在跑的那一轮是哪一个（它那块「过程」摊着、转着；跑完自动收起） */
const liveIndex = computed(() => (props.running ? (turns.value[turns.value.length - 1]?.index ?? -1) : -1))

/** 这一条带了好几张图没有（查看器里那个「第几张 / 共几张」只在多于一张时才画：单张时的「1 / 1」是噪音） */
function manyShots(images?: string[]): boolean {
  return (images?.length ?? 0) > 1
}

/** 那一块「过程」的标题：跑着说在干什么（主语是程序名，智能体跟程序同一个名字），跑完报这一步有多少条 */
function processLabel(turn: { process: AiLogLine[], index: number }): string {
  if (turn.index === liveIndex.value) {
    return props.thinking ? '正在思考…' : `${props.appName}正在努力探索中....`
  }
  return turn.process.length ? `过程 · ${turn.process.length} 步` : '过程'
}

/**
 * 对话变了就滚到底：跟着最新那行走（确认条也长在末尾，它出现时同样要滚过去；
 * 流式那两段（正文与思考）的长度也要算上，不然字在长、视图不动）
 */
watch(
  () => [
    props.lines.length,
    props.installLog.length,
    props.confirms.length,
    props.streaming.length,
    props.thinkingText.length,
    props.thinking,
  ],
  async () => {
    await nextTick()
    const box = scroller.value
    if (box)
      box.scrollTop = box.scrollHeight
  },
)

/** 对话里出现过报错（或 runError 本身）：这种「跑完了」不能装作顺利 */
const hasError = computed(
  () => props.runError !== '' || props.lines.some(line => line.kind === 'error'),
)

/**
 * 顶部那一行说什么：等你确认 / 接历史 / 停 / 在装 / 出错这几种要占它，其余时候是空的
 * （整条不画）。**「运行中…」不在这儿** —— 跑着的动静长在对话里（思考那一块转圈、
 * 正文末尾闪竖条），顶部再说一遍只是重复；顺利跑完也不报信，出错的那次必须报
 * —— 见 docs/constraints/ai.md。「等你确认」排在最前：那会儿进程正停在命令上。
 */
const notice = computed<{ text: string, kind: 'run' | 'fail' } | null>(() => {
  if (props.installing)
    return { text: '正在安装 Pi…', kind: 'run' }
  if (confirm.value)
    return { text: '等你确认这条命令…', kind: 'run' }
  if (props.stopping)
    return { text: '正在停下这一轮…', kind: 'run' }
  // 接历史那一下：它是这一屏自己的事，不是对话里的一句（从前那行画在对话区里，挪到这儿了）
  if (props.hydrating)
    return { text: '正在接上这段对话…', kind: 'run' }
  if (props.runError)
    return { text: props.runError, kind: 'fail' }
  if (props.exitCode === 0 && hasError.value)
    return { text: '跑完了，但日志里有报错', kind: 'fail' }
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
      <template v-else-if="lines.length || confirm || streaming || thinking">
        <template v-for="turn in turns" :key="turn.index">
          <!-- 用户自己写的那句：靠右的气泡（贴的图在文字上面，一起算这条消息） -->
          <div v-if="turn.user" class="msg is-user">
            <div class="msg__bubble">
              <!-- 贴的图：点一下看大图（EP 的查看器，多张之间左右切、Esc 关掉）——
                   这里缩到一行大小只是「发过哪几张」的记号，截图本身得点开才看得清 -->
              <div v-if="turn.user.images?.length" class="msg__shots">
                <el-image
                  v-for="(shot, index) in turn.user.images"
                  :key="index"
                  class="msg__shot"
                  :src="shot"
                  :preview-src-list="turn.user.images"
                  :initial-index="index"
                  preview-teleported
                  hide-on-click-modal
                  :show-progress="manyShots(turn.user.images)"
                />
              </div>
              <p v-if="turn.user.text" class="msg__said">
                {{ turn.user.text }}
              </p>
            </div>
          </div>

          <!-- 这一轮的过程（想的那几段、工具调用、报错、中途的旁白）：收成一块，
               跑着的时候摊开、跑完自动收起 -->
          <AiProcess
            v-if="turn.process.length || turn.index === liveIndex"
            :label="processLabel(turn)"
            :active="turn.index === liveIndex"
          >
            <div
              v-for="(line, index) in turn.process"
              :key="index"
              class="msg"
              :class="`is-${line.kind}`"
            >
              <!-- 想的那一段：草稿，纯文本（半截标记不该被当成排版） -->
              <p v-if="line.kind === 'thinking'" class="msg__think">
                {{ line.text }}
              </p>
              <!-- 中途那些还没成答案的正文：照常渲染 markdown；站内链接开进右侧预览栏 -->
              <MarkdownView
                v-else-if="line.kind === 'text'"
                :source="line.text"
                internal-links
                @internal="openLink"
              />
              <!-- 工具行、系统行、报错：窄行注脚（鼠标停一下才出 detail） -->
              <p
                v-else
                class="run__meta"
                :class="{ 'has-detail': line.detail }"
                :title="line.detail"
              >
                {{ line.text }}
              </p>
            </div>

            <!-- 正在想的那一段：**loading 就在这一块里**（这一轮的过程摊开着） -->
            <div v-if="turn.index === liveIndex" class="msg is-thinking">
              <p v-if="thinkingText" class="msg__think is-live">
                {{ thinkingText }}
              </p>
            </div>

            <!-- 正在长出来的那段回话：跑着的时候它也是过程的一部分（收尾才定答案），
                 落地就落在原地不跳；末尾一根小竖条表示它还在写 -->
            <div v-if="turn.index === liveIndex && streaming" class="msg is-text is-streaming">
              <MarkdownView :source="streaming" internal-links @internal="openLink" />
              <span class="msg__caret" aria-hidden="true" />
            </div>
          </AiProcess>

          <!-- 这一轮最后那段正文：这就是答案，摊在外面 -->
          <div v-if="turn.answer" class="msg is-text">
            <MarkdownView :source="turn.answer.text" internal-links @internal="openLink" />
          </div>

          <!-- 答案之后那几行（「用时 …」）：一轮的句号 -->
          <div v-for="(line, index) in turn.tail" :key="`tail-${index}`" class="msg is-duration">
            <p class="run__meta" :title="line.detail">
              {{ line.text }}
            </p>
          </div>
        </template>

        <!-- 等确认的那条命令：流程停在这儿，答完 Pi 才往下走（只有「自动编辑」那一档会有） -->
        <div v-if="confirm" class="run__confirm">
          <p class="run__confirm-title">
            {{ confirm.title }}
          </p>
          <pre class="run__confirm-cmd">{{ confirm.message }}</pre>
          <div class="run__confirm-actions">
            <el-button type="primary" size="small" @click="emit('answer', confirm.id, true)">
              允许执行
            </el-button>
            <el-button size="small" @click="emit('answer', confirm.id, false)">
              拒绝
            </el-button>
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
        <template v-for="(path, index) in written" :key="path">
          <button type="button" class="run__written-file mono" :title="path" @click="openLink(path)">
            {{ fileNameOf(path) }}
          </button><span v-if="index < written.length - 1">、</span>
        </template>
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
  /* 右栏左上角浮着那颗收起左栏的按钮（见 AiView），这一行常驻角落，让开它 */
  padding-left: var(--sp-6);
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

/* 第一条贴着顶：面板的内边距就是它的呼吸位，第一条上面不再垫自己的 margin。
   选择器要比 .msg.is-user 高一级 —— 同为两级时按源序它排在前头，margin 会把这条盖掉 */
.run__log .msg:first-child {
  margin-top: 0;
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
 * 暗色下它与面板同色，靠边框也读得出是一个气泡。**贴的图排在文字上面**（同一句话的两半）。
 */
.msg__bubble {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-width: 72%;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg) var(--r-lg) var(--r-sm) var(--r-lg);
  background: var(--bg-surface);
  color: var(--ink);
}

/* 那句话本身（与从前同一个排版：贴了图时它在图的下面） */
.msg__said {
  margin: 0;
  font-size: var(--fs-body);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 贴在这句话里的图：一行缩略图（原图按它自己的比例缩到这个框里，不裁也不放大） */
.msg__shots {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/**
 * 一张图就是 EP 的 el-image：**外框收着原图的尺寸，只把上限压住** ——
 * el-image 自带的 `.el-image__inner` 是 width/height 100%（它会撑满外框），
 * 那样方块里的截图会被裁掉一半，所以这里把它改回 auto，靠 max-* 封顶；
 * 外框（shrink-to-fit 的行内块）跟着就是图自己的大小。
 * 点一下看大图（`preview-src-list` 那一串就是这一条的图，手型光标是 EP 自己加的）。
 */
.msg__shot {
  display: block;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
}

.msg__shot :deep(.el-image__inner) {
  width: auto;
  height: auto;
  max-width: 240px;
  max-height: 180px;
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

/* 模型想的那一段（过程里的一块）：草稿，比工具行稍亮一点点（它是话，不是路径），
   **纯文本** —— 草稿里那些半截标记不该被当成排版 */
.msg__think {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 正在想的那一段：稍亮一档，让它与上面已经想完的区分开 */
.msg__think.is-live {
  color: var(--ink-2);
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

/* 写下的文件是颗长成链接样子的按钮：点开进右侧预览栏。配色与对话里的 markdown 链接
   同一副（--el-color-primary），常驻细下划线 —— 不用悬停就知道点得开 */
.run__written-file {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--el-color-primary);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

.run__written-file:hover {
  color: var(--el-color-primary-dark-2);
  text-decoration-thickness: 2px;
}
</style>
