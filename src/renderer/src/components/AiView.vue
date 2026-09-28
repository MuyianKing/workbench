<script setup lang="ts">
/**
 * AI 助手页：一个**通用的 agent 控制台** —— 选一个工作目录、写一条指令，让内置的 Pi 去做。
 *
 * 它与知识库**没有关系**：处理知识库只是「把工作目录指到那个仓库、写一条照它规范整理的
 * 指令」的一种用法。页面不内置任何一类任务（提示词由用户写，见 shared/ai.ts 的 taskPrompt），
 * 也不在跑完之后做任何与具体任务绑在一起的事（不重建索引、不刷新谁的列表）。
 *
 * 页面自己只做编排与状态呈现：选目录、探环境、起进程（都在 stores/ai.ts），
 * 事件流画进右边的运行面板。整页状态：没选工作目录的引导、缺环境（Node / Pi / 模型 / 密钥）
 * 的提示、可以跑、跑着。
 */
import { computed, onMounted, ref } from 'vue'
import { Folder, FolderOpened, Setting, VideoPlay } from '@element-plus/icons-vue'
import AiModelDialog from '@/components/AiModelDialog.vue'
import AiRunPanel from '@/components/AiRunPanel.vue'
import { useAiStore } from '@/stores/ai'

const ai = useAiStore()
const modelVisible = ref(false)

onMounted(() => {
  void ai.init()
})

/** 挑一个工作目录：**任意目录**都行 —— 它就是子进程干活的地方 */
async function pickWorkDir(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择工作目录')
  if (picked) await ai.setWorkDir(picked)
}

/** 在资源管理器里打开工作目录 */
function revealWorkDir(): void {
  void window.workbench.reveal(ai.workDir)
}

/** 模型按钮上那行摘要：跑的是清单里第一个启用的那个 */
const modelSummary = computed(() =>
  ai.runModel ? `${ai.providerLabel} · ${ai.runModel}` : '模型'
)

/**
 * 还差什么才能跑。一次只说第一件缺的事 —— 按用户要动手的顺序排：
 * Node → Pi → 模型 → 密钥 → 指令。空串表示都齐了。
 */
const blocking = computed(() => {
  if (!ai.probed) return ''
  if (!ai.nodeOk) return '这台机器的 Node 太旧：跑 Pi 需要 Node ≥ 22.19，先把 Node 升上去。'
  if (!ai.piVersion)
    return '没找到 Pi 运行时：随包内置的那份不在（开发态先跑一次 npm run vendor:pi），PATH 上也没有全局安装的 —— 可以点右边的「安装 Pi」。'
  if (!ai.configured) return '还没配模型：点上面的「模型」，填 Base URL、API 格式与至少一个模型。'
  if (!ai.keyReady) return `${ai.providerLabel} 还没配 API Key：点上面的「模型」。`
  if (!ai.instruction.trim()) return '还没写指令：说说要它在这个目录里做什么。'
  return ''
})
</script>

<template>
  <main class="ai-view">
    <!-- 还没选工作目录：只有说明与那颗按钮 -->
    <div v-if="!ai.workDir" class="guide panel">
      <el-icon class="empty__icon"><VideoPlay /></el-icon>
      <h2 class="guide__title">AI 助手</h2>
      <p class="guide__text">
        选一个工作目录、写一条指令，应用就请内置的 Pi 在那个目录里干活 ——
        它自己读、改文件，把过程留在这块面板上。目录与指令都由你定，这一页不预设任何一类任务。
      </p>
      <el-button type="primary" :icon="FolderOpened" @click="pickWorkDir">选择工作目录</el-button>
    </div>

    <template v-else>
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">AI 助手</h2>
            <span class="head__loc mono" :title="ai.workDir">{{ ai.locationText }}</span>
          </div>
          <span class="head__stats">
            {{ ai.lines.length ? `${ai.lines.length} 行输出` : '还没跑过' }}
          </span>
        </div>
        <div class="filter__tools">
          <el-tooltip content="提供方、模型与 API Key" placement="bottom">
            <el-button size="small" :icon="Setting" @click="modelVisible = true">
              {{ modelSummary }}
            </el-button>
          </el-tooltip>
          <el-button
            type="primary"
            size="small"
            :icon="VideoPlay"
            :loading="ai.running"
            :disabled="!ai.canRun"
            @click="ai.run()"
          >
            开始
          </el-button>
          <el-tooltip content="在资源管理器中打开" placement="bottom">
            <el-button size="small" :icon="Folder" @click="revealWorkDir" />
          </el-tooltip>
          <el-tooltip content="换一个工作目录" placement="bottom">
            <el-button size="small" :icon="FolderOpened" @click="pickWorkDir" />
          </el-tooltip>
        </div>
      </div>

      <p v-if="blocking" class="notice">{{ blocking }}</p>

      <div class="ai-view__body">
        <section class="ai-view__left panel">
          <label class="prompt__label" for="ai-instruction">指令</label>
          <el-input
            id="ai-instruction"
            v-model="ai.instruction"
            class="prompt__input"
            type="textarea"
            resize="none"
            placeholder="要它在这个目录里做什么？写清楚一点 —— 它会自己读目录里的说明、改文件，但不会执行命令。"
          />
          <p class="prompt__hint">
            它在这个目录里读 / 写文件（工具只有 read / write / edit），不会跑任何命令；
            目录里的 AGENTS.md、README 之类它会自己找来看。
          </p>
        </section>

        <section class="ai-view__right panel">
          <AiRunPanel
            :pi-version="ai.piVersion"
            :running="ai.running"
            :installing="ai.installing"
            :install-log="ai.installLog"
            :lines="ai.lines"
            :exit-code="ai.exitCode"
            :run-error="ai.runError"
            :written="ai.written"
            @install="ai.installPi()"
            @stop="ai.stop()"
          />
        </section>
      </div>
    </template>

    <!-- 弹层挂在最外层：上面几种状态里都可能打开它 -->
    <AiModelDialog v-model="modelVisible" />
  </main>
</template>

<style scoped>
.ai-view {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--card-gap, 10px);
}

/* 还没选工作目录时的引导 */
.guide {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  height: 100%;
  padding: var(--sp-6);
  text-align: center;
}

.guide__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.guide__text {
  max-width: 560px;
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}

/* 工具条上的标题、位置与状态（与知识库页同一副样子） */
.head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  min-width: 0;
}

.head__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.head__loc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.head__stats {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 还差什么才能跑：紧跟工具条，不像弹窗那样打断人 */
.notice {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

/* 两栏：左指令固定宽，右运行面板吃剩下的 */
.ai-view__body {
  display: grid;
  grid-template-columns: minmax(300px, 32%) minmax(0, 1fr);
  gap: var(--sp-3);
  min-height: 0;
}

.ai-view__left,
.ai-view__right {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

.prompt__label {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.prompt__input {
  flex: 1;
  min-height: 0;
}

.prompt__input :deep(.el-textarea__inner) {
  height: 100%;
  font-family: inherit;
  line-height: 1.7;
}

.prompt__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}
</style>
