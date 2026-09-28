<script setup lang="ts">
/**
 * AI 助手页：一个**通用的 agent 控制台** —— 左栏挑一段会话，右栏跟它说下去。
 *
 * 版式是**左树右对话**（与笔记页、视频页同一副分栏，宽度也住 theme.json 的 `aiTreeWidth`）：
 *
 *  - **左栏**：项目 → 会话的两层树（`AiSessionTree`）。第一层是项目（一个工作目录），
 *    第二层是那个目录下的会话；行上那两颗按钮是「新建会话」与「删除」。顶上那颗
 *    「新建会话」是给「还没有这个项目」用的：挑一个目录就多一个项目。
 *  - **右栏**：挑中一个会话就是**控制台** —— 上面是这段对话（历史 + 这一轮，自己往下滚），
 *    下面还是那一栏目录与分支 + composer（跑着的时候那颗按钮就是停止）。
 *    一个会话都没挑中时是**新任务那一屏**：一块线稿 + 一句「新任务」+ 新建会话 + 用过的指令。
 *    **这一屏没有顶部工具条**：标题、目录那些要么与导航栏重复、要么下面这一栏已经说了。
 *
 * **页面不摆提示行**（说明、问候、还差什么）：这个应用是给作者自己用的，页面上把控件本身
 * 已经说清的事再讲一遍就是噪音。缺什么由 `stores/ai.ts` 的 `blocking` 说，而它只出现在
 * 发送按钮的悬停里；问候在顶栏那一行（见 HomeGreeting），这一页只说这件事本身。
 *
 * 页面自己只做编排与状态呈现：会话的增删选、起进程、读历史、停止都在 stores/ai.ts，
 * 模型与档位那两个下拉直接写设置（行为记忆，下次打开还是它）。
 */
import { computed, onMounted, ref } from 'vue'
import { Download, FolderAdd, Plus } from '@element-plus/icons-vue'
import AiComposer from '@/components/AiComposer.vue'
import AiLocationBar from '@/components/AiLocationBar.vue'
import AiModelDialog from '@/components/AiModelDialog.vue'
import AiRunPanel from '@/components/AiRunPanel.vue'
import AiSessionTree from '@/components/AiSessionTree.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { useAiStore } from '@/stores/ai'
import { useSettingsStore } from '@/stores/settings'

const ai = useAiStore()
const settings = useSettingsStore()
const modelVisible = ref(false)

onMounted(() => {
  void ai.init()
})

/** 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频页同一套做法） */
const bodyStyle = computed(() => ({
  gridTemplateColumns: `${settings.themeConfig.aiTreeWidth}px minmax(0, 1fr)`,
  '--tree-w': `${settings.themeConfig.aiTreeWidth}px`
}))

/** 哪几个会话在跑：左栏在那些行上点一颗小圆点（几个会话可以同时在跑） */
const runningIds = computed(() =>
  [...ai.runs.entries()].filter(([, run]) => run.running).map(([id]) => id)
)

/** 顶上那颗「新建会话」：最近用过的目录直接建，其余走文件夹对话框 */
function onNewSession(command: string): void {
  if (command === 'pick') void ai.pickSessionDir('新建会话：挑一个工作目录')
  else void ai.createSession(command)
}

/** 历史里那一条在 chip 上怎么显示：压成一行、长了就截断（全文在 tooltip 里，点一下填回去） */
function chipLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 12 ? `${oneLine.slice(0, 12)}…` : oneLine
}

/** 下拉里那一项怎么叫：目录名（完整路径在 title 上） */
function dirName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}
</script>

<template>
  <main class="ai-view" :style="bodyStyle">
    <!-- 左栏：项目 → 会话 -->
    <aside class="ai-view__side panel">
      <header class="side__head">
        <span class="side__title">会话</span>
        <!-- 图标那颗不套 el-tooltip：它的菜单本身就是说明（与项目卡 / 保险库的「⋯」同一副写法） -->
        <el-dropdown trigger="click" @command="onNewSession">
          <el-button class="side__new" text :icon="Plus" aria-label="新建会话" @click.stop />
          <template #dropdown>
            <el-dropdown-menu>
              <!-- 最近用过的目录：接着那几段对话在的地方再开一段 -->
              <el-dropdown-item v-for="dir in ai.recentDirs" :key="dir" :command="dir">
                {{ dirName(dir) }}
              </el-dropdown-item>
              <el-dropdown-item command="pick" :divided="ai.recentDirs.length > 0" :icon="FolderAdd">
                选择其他目录…
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </header>

      <AiSessionTree
        :groups="ai.groups"
        :active-id="ai.activeId"
        :running-ids="runningIds"
        @select="ai.selectSession"
        @create="ai.createSession"
        @remove="ai.deleteSession"
        @pick="ai.pickSessionDir('新建会话：挑一个工作目录')"
      />
    </aside>

    <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
    <PanelResizer
      :width="settings.themeConfig.aiTreeWidth"
      body-class="is-resizing-ai-tree"
      @move="settings.setAiTreeWidth"
      @end="() => void settings.commitAiTreeWidth()"
    />

    <section class="ai-view__main">
      <!-- 控制台：这段对话 + 底部那一栏目录与同一条 composer -->
      <template v-if="ai.activeSession">
        <section class="ai-view__log panel">
          <AiRunPanel
            :pi-version="ai.piVersion"
            :running="ai.running"
            :hydrating="ai.hydrating"
            :stopping="ai.stopping"
            :installing="ai.installing"
            :install-log="ai.installLog"
            :lines="ai.lines"
            :streaming="ai.streaming"
            :confirms="ai.confirms"
            :exit-code="ai.exitCode"
            :run-error="ai.runError"
            :written="ai.written"
            @install="ai.installPi()"
            @answer="(id, allowed) => ai.answerConfirm(id, allowed)"
          />
        </section>

        <AiLocationBar />
        <AiComposer @configure="modelVisible = true" />
      </template>

      <!-- 新任务：一个会话都没挑中（还没有会话，或者左栏都删光了） -->
      <div v-else class="landing">
        <!-- 这一块是自绘的线稿：两张叠着的「纸」，前面那张上有一个提示符 ——
             只说「这儿是要写指令的地方」，不落实指什么。后面那张拿 mask 裁一下：
             线稿只有描边、没有底色，不裁的话它的边会从前面那张纸里透出来 -->
        <div class="hero">
          <svg class="hero__art" viewBox="0 0 224 148" fill="none" aria-hidden="true">
            <defs>
              <mask id="ai-hero-front">
                <rect width="224" height="148" fill="white" />
                <rect x="65" y="11" width="149" height="112" rx="12" fill="black" />
              </mask>
            </defs>

            <g mask="url(#ai-hero-front)">
              <rect x="10.5" y="30.5" width="118" height="86" rx="10" stroke="currentColor" stroke-width="1" />
              <path d="M28 52h74M28 68h92M28 84h56" stroke="currentColor" stroke-width="1" />
            </g>

            <rect x="66.5" y="12.5" width="147" height="110" rx="12" stroke="currentColor" stroke-width="1" />
            <path d="M86 34h96M86 50h64" stroke="currentColor" stroke-width="1" />
            <path d="M86 92l10 8-10 8" stroke="currentColor" stroke-width="1" />
            <path d="M106 108h22" stroke="currentColor" stroke-width="1" />
          </svg>

          <h1 class="hero__title">新任务</h1>
        </div>

        <!-- 起一段对话：挑一个目录（最近用过的先列出来） -->
        <el-dropdown trigger="click" @command="onNewSession">
          <el-button type="primary" :icon="Plus">新建会话</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="dir in ai.recentDirs" :key="dir" :command="dir">
                {{ dirName(dir) }}
              </el-dropdown-item>
              <el-dropdown-item command="pick" :divided="ai.recentDirs.length > 0" :icon="FolderAdd">
                选择其他目录…
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <!-- 只在没探到 Pi 时才摆这一颗：它随包内置，正常看不到；缺什么不在页面上说，
             都收在发送按钮的悬停里（见 stores/ai.ts 的 blocking） -->
        <el-button
          v-if="!ai.piVersion"
          size="small"
          :icon="Download"
          :loading="ai.installing"
          @click="ai.installPi()"
        >
          安装 Pi
        </el-button>

        <!-- 用户自己写过的指令：点一下填回输入框（页面不内置任何预设） -->
        <div v-if="ai.recentInstructions.length" class="history">
          <el-tooltip
            v-for="text in ai.recentInstructions"
            :key="text"
            :content="text"
            placement="top"
          >
            <el-button size="small" class="history__chip" @click="ai.instruction = text">
              {{ chipLabel(text) }}
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </section>

    <!-- 弹层挂在最外层：两屏都开得出它 -->
    <AiModelDialog v-model="modelVisible" />
  </main>
</template>

<style scoped>
/**
 * 左树右对话。两栏各是一张卡片（.panel 那副外壳，写在 global.css），间距与别处同源 ——
 * 左栏宽度跟着 theme.json 里的 aiTreeWidth 走（拖动分隔条改它）、右栏吃掉剩余宽度，
 * 两栏各自滚。外框的留白与笔记 / 视频页同一套（左右与下边距取卡片间距，顶边归 .shell 管）。
 */
.ai-view {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  gap: var(--card-gap, 10px);
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

.ai-view__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-3);
}

.side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex-shrink: 0;
  margin-bottom: var(--sp-2);
}

.side__title {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

/* 那颗「+」与标题同高就够：它是这一栏的入口，不是页面的主操作 */
.side__new {
  width: 24px;
  height: 24px;
  padding: 0;
}

/* 右栏：上面吃剩余高度（对话），下面两行定高（目录栏与 composer） */
.ai-view__main {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  gap: var(--sp-3);
  min-width: 0;
  min-height: 0;
}

.ai-view__log {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

/* ---------- 新任务那一屏 ---------- */

/**
 * 居中的一屏：线稿 + 一句话 + 新建会话 + 用过的指令。
 * 内容比一屏高时（窗口拉得很矮）从顶上开始排，别把线稿裁掉一半。
 */
.landing {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4) 0;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 560px;
  text-align: center;
}

.hero__art {
  width: 200px;
  height: auto;
  /* 线稿是背景性的：只比画布深一点，别抢正文的视线 */
  color: var(--ink-3);
  opacity: 0.55;
}

.hero__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-display);
  font-weight: 600;
}

.history {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  justify-content: center;
  max-width: 720px;
}

/* 用过的指令：药丸形，比按钮本身矮一档，免得跟新建会话那颗抢注意力 */
.history__chip {
  border-radius: var(--r-pill);
  color: var(--ink-2);
}
</style>
