<script setup lang="ts">
/**
 * 清洗面板（右栏的第三态）：一键清洗的整个过程都在这里看得见。
 *
 * 版式与页面同族：上面是流程与状态（清洗 → 重建索引 → 完成，三步就地推进），中间是
 * 实时日志 —— 与 AI 助手页同一套事件翻译（parsePiEvent），助手正文走 MarkdownView、
 * 工具与系统行是窄行注脚、想的那一段收成「思考过程」；出错与拦截就地说明，不打断人。
 *
 * 面板只画状态：起跑 / 取消 / 重试 / 关 / 开模型管理都交回 store 与页面（见 stores/kb.ts）。
 *
 * 底部的**收据**说清这一轮动了哪几条（新建的与覆盖的分开，口径在 shared/kb-clean.ts 的
 * splitCleanWrites）：条目名是一颗能点的按钮，点一下收面板、直接去读那一条。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowLeft, Loading, MagicStick } from '@element-plus/icons-vue'
import type { AiLogLine } from '@workbench/ai'
import type { KbCleanPhase } from '@workbench/kb'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{
  /** 页面上只在非 idle 时挂这个面板；类型上收下全集，省一层收窄 */
  phase: KbCleanPhase
  lines: AiLogLine[]
  /** 拦路原因（blocked）或失败原因（failed） */
  error: string
  /** 这一轮新建的条目（相对仓库根） */
  created: string[]
  /** 这一轮覆盖的条目（相对仓库根） */
  updated: string[]
}>()

const emit = defineEmits<{ start: []; stop: []; close: []; 'open-models': []; 'open-entry': [rel: string] }>()

/** 流程的三步：清洗 → 重建索引 → 完成。第几步与各自的状态都从 phase 推 */
const steps = [
  { label: '清洗条目', phase: 'cleaning' },
  { label: '重建索引', phase: 'indexing' },
  { label: '完成', phase: 'done' }
] as const

/** 三步各自的状态：没到的 pending、正在的 run、过了的 ok、栽住的 fail */
function stepState(index: number): 'pending' | 'run' | 'ok' | 'fail' {
  const order: KbCleanPhase[] = [
    'idle',
    'blocked',
    'cleaning',
    'indexing',
    'done',
    'failed',
    'cancelled'
  ]
  const at = order.indexOf(props.phase)
  // blocked / idle 还没上流程；failed 栽在它正跑的那一步；cancelled 停在清洗
  if (props.phase === 'blocked' || props.phase === 'idle') return 'pending'
  if (props.phase === 'failed') return index < at ? 'ok' : index === at ? 'fail' : 'pending'
  if (props.phase === 'cancelled') return index === 0 ? 'fail' : 'pending'
  return index < at ? 'ok' : index === at ? 'run' : 'pending'
}

/** 顶部那行状态说什么：跑着的每一步、收场与拦截各有一句 */
const status = computed<{ text: string; kind: 'run' | 'ok' | 'fail' } | null>(() => {
  switch (props.phase) {
    case 'cleaning':
      return { text: '正在清洗：Pi 在按清单整理条目…', kind: 'run' }
    case 'indexing':
      return { text: '条目已整理，正在重建目录与索引…', kind: 'run' }
    case 'done':
      return { text: '清洗完成，条目状态已刷新', kind: 'ok' }
    case 'failed':
      return { text: '清洗没有走完', kind: 'fail' }
    case 'cancelled':
      return { text: '已停止清洗（已写下的条目保留）', kind: 'fail' }
    default:
      return null
  }
})

/** 拦路那一屏要不要给「模型管理」：缺模型或密钥时去得，Node / Pi 缺了去那儿没用 */
const modelsNeeded = computed(() => /模型|API Key/.test(props.error))

/** 收据里每组先列几条：写入路径多的时候（第一次洗一整批）不至于把注脚铺成一屏 */
const WRITE_LIMIT = 12
const createdShown = computed(() => props.created.slice(0, WRITE_LIMIT))
const updatedShown = computed(() => props.updated.slice(0, WRITE_LIMIT))
const restText = (list: string[]): string =>
  list.length > WRITE_LIMIT ? `还有 ${list.length - WRITE_LIMIT} 条没有列出` : ''

const scroller = ref<HTMLElement | null>(null)

/** 日志长了就滚到底：跟着最新那行走 */
watch(
  () => props.lines.length,
  async () => {
    await nextTick()
    const box = scroller.value
    if (box) box.scrollTop = box.scrollHeight
  }
)
</script>

<template>
  <div class="clean">
    <header class="clean__head">
      <div class="clean__bar">
        <h3 class="clean__title">清洗</h3>
        <span v-if="status" class="clean__status" :class="`is-${status.kind}`">
          <el-icon v-if="status.kind === 'run'" class="clean__spin"><Loading /></el-icon>
          {{ status.text }}
        </span>
        <span class="clean__tools">
          <el-button v-if="phase === 'cleaning'" size="small" @click="emit('stop')">
            停止清洗
          </el-button>
          <template v-else-if="phase !== 'indexing'">
            <el-button size="small" type="primary" :icon="MagicStick" @click="emit('start')">
              {{ phase === 'done' ? '再洗一轮' : '重新清洗' }}
            </el-button>
            <el-button size="small" :icon="ArrowLeft" @click="emit('close')">返回概览</el-button>
          </template>
        </span>
      </div>

      <!-- 拦路那一屏：缺什么就地说明，能去的去处给到位 -->
      <div v-if="phase === 'blocked'" class="clean__blocked">
        <p class="clean__blocked-text">{{ error }}</p>
        <el-button v-if="modelsNeeded" size="small" @click="emit('open-models')">
          打开模型管理
        </el-button>
      </div>
      <p v-else-if="phase === 'failed' && error" class="clean__fail">{{ error }}</p>

      <!-- 流程三步：清洗 → 重建索引 → 完成 -->
      <ol v-else class="clean__steps">
        <li
          v-for="(step, index) in steps"
          :key="step.phase"
          class="clean__step"
          :class="`is-${stepState(index)}`"
        >
          {{ step.label }}
        </li>
      </ol>
    </header>

    <div ref="scroller" class="clean__log">
      <template v-if="lines.length">
        <div v-for="(line, index) in lines" :key="index" class="msg" :class="`is-${line.kind}`">
          <MarkdownView v-if="line.kind === 'text'" :source="line.text" />
          <!-- 想的那几段是纯文本（草稿里的半截标记不该被当成排版），与 AiProcess 同一条 -->
          <p v-else-if="line.kind === 'thinking'" class="clean__think">{{ line.text }}</p>
          <p v-else class="clean__meta" :class="{ 'has-detail': line.detail }" :title="line.detail">
            {{ line.text }}
          </p>
        </div>
      </template>
      <p v-else-if="phase === 'cleaning'" class="clean__meta">正在把清洗清单交给 Pi…</p>
      <p v-else-if="phase !== 'blocked'" class="clean__meta">还没有日志。</p>
    </div>

    <footer v-if="created.length || updated.length" class="clean__foot">
      <div v-if="created.length" class="clean__write">
        <p class="clean__written">新建 {{ created.length }} 条</p>
        <ul class="clean__rels">
          <li v-for="rel in createdShown" :key="rel">
            <button type="button" class="clean__rel" @click="emit('open-entry', rel)">{{ rel }}</button>
          </li>
        </ul>
        <p v-if="restText(created)" class="clean__written">{{ restText(created) }}</p>
      </div>
      <div v-if="updated.length" class="clean__write">
        <p class="clean__written">覆盖 {{ updated.length }} 条</p>
        <ul class="clean__rels">
          <li v-for="rel in updatedShown" :key="rel">
            <button type="button" class="clean__rel" @click="emit('open-entry', rel)">{{ rel }}</button>
          </li>
        </ul>
        <p v-if="restText(updated)" class="clean__written">{{ restText(updated) }}</p>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.clean {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  height: 100%;
  min-height: 0;
}

.clean__head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.clean__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.clean__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.clean__status {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.clean__status.is-run {
  color: var(--st-run);
}

.clean__status.is-ok {
  color: var(--st-ok);
}

.clean__status.is-fail {
  color: var(--st-fail);
}

.clean__spin {
  font-size: var(--fs-meta);
  animation: clean-spin 1.2s linear infinite;
}

@keyframes clean-spin {
  to {
    transform: rotate(360deg);
  }
}

.clean__tools {
  display: flex;
  gap: var(--sp-2);
  margin-left: auto;
}

/* 拦路与失败的就地说明：跟在标题下，不弹窗打断人 */
.clean__blocked {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.clean__blocked-text {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.clean__fail {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

/* 流程三步：灰度说话 —— 没到的最淡、正在的浓、过了的打钩色、栽住的失败色 */
.clean__steps {
  display: flex;
  gap: var(--sp-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.clean__step {
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.clean__step.is-run {
  color: var(--st-run);
}

.clean__step.is-ok {
  color: var(--st-ok);
}

.clean__step.is-fail {
  color: var(--st-fail);
}

/* 日志区：与 AI 助手页的对话区同一条路数 —— 没有自己的底色，靠行间留白分节 */
.clean__log {
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

.msg.is-text {
  margin: var(--sp-2) 0;
}

.clean__meta {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.is-tool .clean__meta {
  color: var(--ink-2);
  font-family: var(--font-mono);
}

.msg.is-error .clean__meta {
  color: var(--st-fail);
}

.msg.is-done .clean__meta {
  color: var(--st-ok);
}

/* 想的那几段：纯文本草稿，比工具行再轻一点 */
.clean__think {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.clean__meta.has-detail {
  cursor: help;
}

.clean__foot {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-top: 1px solid var(--border);
  padding-top: var(--sp-2);
}

.clean__write {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.clean__written {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
  word-break: break-word;
}

/* 条目名排成一行小片：点一下就去看那一条（收起面板，见父层的 openWritten） */
.clean__rels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.clean__rel {
  max-width: 100%;
  padding: 0 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.clean__rel:hover {
  background: var(--border);
  color: var(--ink);
}
</style>
