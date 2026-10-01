<script setup lang="ts">
/**
 * AI 助手页：一个**通用的 agent 控制台** —— 左栏挑一段会话，右栏跟它说下去。
 *
 * 版式是**左树右对话**（与笔记页、视频页同一副分栏，宽度也住 theme.json 的 `aiTreeWidth`）：
 * 左栏能整栏收起（theme.json 的 `aiTreeCollapsed`）：收起的开关平常就在左栏底部那一行，
 * 树收起来之后那一行跟着没了，右栏左上角会浮出一颗「展开」（与视频页同一套做法）。
 *
 *  - **左栏**：项目 → 会话的两层树（`AiSessionTree`）。第一层是项目（一个工作目录），
 *    第二层是这个目录下的会话；行上那两颗按钮是「在这个目录里起一段新的」与「删除」。
 *    顶上那颗「+」也是**起一段新的**（不挑目录，接着最近用过的那个）。
 *    底部那一行是两个不跟会话走的入口：**技能**（装卸与开关的管理弹窗）与**收起整栏**。
 *  - **右栏**：挑中一个会话就是**控制台** —— 上面是这段对话（历史 + 这一轮，自己往下滚），
 *    下面还是那一栏目录与分支 + composer（跑着的时候那颗按钮就是停止）。
 *    没挑中会话时是**起始那一屏**（一段会话都还没有，或者刚点了「+」）：中间就是控制台
 *    那一屏那条 composer，上面是位置那一栏（这一屏由它**挑目录**）——
 *    **一进来就能直接写**，会话在发出第一句时才建（见 stores/ai.ts 的 run）。
 *    **两屏都没有顶部工具条**：标题、目录那些要么与导航栏重复、要么下面那一栏已经说了。
 *
 * **页面不摆提示行**（说明、问候、还差什么）：这个应用是给作者自己用的，页面上把控件本身
 * 已经说清的事再讲一遍就是噪音。缺什么由 `stores/ai.ts` 的 `blocking` 说，而它只出现在
 * 发送按钮的悬停里；问候在顶栏那一行（见 HomeGreeting），这一页只说这件事本身。
 *
 * 页面自己只做编排与状态呈现：会话的增删选、起进程、读历史、停止都在 stores/ai.ts，
 * 模型与档位那两个下拉直接写设置（行为记忆，下次打开还是它）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { Download, Expand, Fold, MagicStick, Plus } from '@element-plus/icons-vue'
import { AI_PREVIEW_MAX_BINARY_CHARS, AI_PREVIEW_MAX_CHARS, htmlImageSrcs, resolveAiPreview, type AiPreviewState, type AiPreviewTarget } from '@workbench/ai'
import { markdownImages } from '@workbench/core'
import AiComposer from '@/components/AiComposer.vue'
import AiPreviewPane from '@/components/AiPreviewPane.vue'
import AiSkillDialog from '@/components/AiSkillDialog.vue'
import AiLocationBar from '@/components/AiLocationBar.vue'
import AiModelDialog from '@/components/AiModelDialog.vue'
import AiRunPanel from '@/components/AiRunPanel.vue'
import AiSessionTree from '@/components/AiSessionTree.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { useAiStore } from '@/stores/ai'
import { useAiSkillsStore } from '@/stores/ai-skills'
import { useSettingsStore } from '@/stores/settings'

const ai = useAiStore()
const skills = useAiSkillsStore()
const settings = useSettingsStore()
const modelVisible = ref(false)
const skillVisible = ref(false)

/** 文件名（Tab 与预览标题上只放它，全路径在链接那行的悬停里） */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * 右侧预览栏：**一个文件一个 Tab**（`previews` 按点开顺序排，`activeKey` 是当前那张）。
 * 一张都不剩时整栏收起，对话占满整行。宽度不落盘，重启回默认。
 */
const previews = ref<AiPreviewState[]>([])
const activeKey = ref('')
const previewWidth = ref(420)

watch(
  () => ai.activeId,
  () => {
    // 文件是相对那段对话的目录解析的：换会话（换目录）就整栏收掉
    previews.value = []
    activeKey.value = ''
  }
)

/** 预览栏宽度钳位：280 起步，另一头给对话区留出能读的一截 */
function clampPreviewWidth(width: number): number {
  const min = 280
  const max = Math.max(min, window.innerWidth - 640)
  return Math.min(Math.max(Math.round(width), min), max)
}

/** 关掉一张 Tab：关的是当前那张就挪到邻居（右边优先，没有才左边） */
function closePreview(key: string): void {
  const index = previews.value.findIndex((state) => state.key === key)
  if (index < 0) return
  previews.value.splice(index, 1)
  if (activeKey.value !== key) return
  const next = previews.value[index] ?? previews.value[index - 1]
  activeKey.value = next?.key ?? ''
}

/**
 * 点开回答里的一个文件（站内链接或「写下 N 个文件」那行）：相对地址对到会话工作目录
 * （resolveAiPreview，解析口径都在那）。同一个文件已有 Tab 就摊开它并**重读一遍**
 * （内容可能被这轮对话改掉了）；没有就开一张新 Tab 再取内容 —— 取数见 loadInto，
 * 各 Tab 互不干扰，中途关掉的就让它留在半路。
 */
function openPreview(href: string): void {
  const session = ai.activeSession
  if (!session) return

  const target = resolveAiPreview(href, session.dir)
  const key = target.ok ? `${target.kind}:${target.path}` : href

  const existing = previews.value.find((state) => state.key === key)
  if (existing) {
    activeKey.value = key
    if (target.ok) void loadInto(existing, target, session.dir)
    return
  }

  previews.value.push({
    key,
    href,
    name: target.ok ? fileNameOf(target.path) : href,
    kind: target.ok ? target.kind : 'text',
    loading: target.ok,
    error: target.ok ? '' : target.reason,
    text: '',
    binary: '',
    imageUrl: '',
    imageSrcs: {}
  })
  activeKey.value = key
  if (!target.ok) return
  // **从数组里取回响应式代理**再交给 loadInto —— 直接改 push 进去的那个原始对象
  // 一帧都不会触发更新（「正在打开…」就是这么卡死的），响应式数组读出来的代理才会
  const stored = previews.value.find((entry) => entry.key === key)
  if (stored) void loadInto(stored, target, session.dir)
}

/** 取一份文件的内容摊进它的 Tab；每份状态只由自己的 loadInto 写，连点几个文件各走各的 */
async function loadInto(state: AiPreviewState, target: AiPreviewTarget, dir: string): Promise<void> {
  const alive = () => previews.value.includes(state)
  state.loading = true
  state.error = ''

  if (target.kind === 'image') {
    const image = await window.workbench.allowPreviewImage(target.path)
    if (!alive()) return // Tab 已被关掉，过期的不写回
    state.loading = false
    if (image.ok) state.imageUrl = image.data?.url ?? ''
    else state.error = image.error ?? '图片打不开'
    return
  }

  // docx / pptx：zip 容器，文本通道读不了，走 base64 交渲染库解
  if (target.kind === 'docx' || target.kind === 'pptx') {
    const file = await window.workbench.readBinaryFile(target.path)
    if (!alive()) return
    state.loading = false
    if (!file.ok) {
      state.error = file.error ?? '读取失败'
      return
    }
    const binary = file.data ?? ''
    if (binary.length > AI_PREVIEW_MAX_BINARY_CHARS) {
      state.error = '文件太大，打不开预览'
      return
    }
    state.binary = binary
    return
  }

  const file = await window.workbench.readTextFile(target.path)
  if (!alive()) return
  state.loading = false
  if (!file.ok) {
    state.error = file.error ?? '读取失败'
    return
  }
  const text = file.data ?? ''
  if (text.length > AI_PREVIEW_MAX_CHARS) {
    state.error = '文件太大，打不开预览'
    return
  }
  if (target.kind === 'text') {
    state.text = text
    return
  }

  // markdown / html：正文里的相对图片挨个授权再回填地址（与工作区背景图同一条 asset 边界）
  const srcs: Record<string, string> = {}
  for (const src of target.kind === 'markdown' ? markdownImages(text) : htmlImageSrcs(text)) {
    const image = resolveAiPreview(src, dir)
    if (!image.ok || image.kind !== 'image') continue
    const allowed = await window.workbench.allowPreviewImage(image.path)
    if (!alive()) return
    if (allowed.ok) srcs[src] = allowed.data?.url ?? ''
  }
  if (!alive()) return
  state.text = text
  state.imageSrcs = srcs
}

onMounted(() => {
  void ai.init()
  // 技能那两条根在页面一进来就扫一遍：composer 那颗 chip 与候选那一列都要有东西可挑
  void skills.ensure()
})

/**
 * 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频页同一套做法）。列宽用 auto ——
 * 宽度长在左栏自己身上（见样式），收起时它过渡到 0，auto 这一行跟着缩。
 */
const bodyStyle = computed(() => ({
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  '--tree-w': `${settings.themeConfig.aiTreeWidth}px`
}))

/**
 * 左栏（会话树）收起没有：落在 theme.json（与视频页左栏的收起同一套做法）。
 * 收起**不是卸载**：宽度与树的展开态都还在，展开回来原样。
 */
const treeCollapsed = computed(() => settings.themeConfig.aiTreeCollapsed)

function toggleTree(): void {
  void settings.setAiTreeCollapsed(!treeCollapsed.value)
}

/** 哪几个会话在跑：左栏在那些行上点一颗小圆点（几个会话可以同时在跑） */
const runningIds = computed(() =>
  [...ai.runs.entries()].filter(([, run]) => run.running).map(([id]) => id)
)
</script>

<template>
  <main class="ai-view" :style="bodyStyle">
    <!-- 左栏：项目 → 会话 -->
    <aside class="ai-view__side panel" :class="{ 'is-collapsed': treeCollapsed }">
      <header class="side__head">
        <span class="side__title">会话</span>
        <!-- 起一段新的：**只是把右栏切到起始那一屏**（挑目录、写第一句都在那儿），
             不在这儿先建一个空会话 —— 这儿没有菜单，那颗「+」点下去就是那件事本身 -->
        <el-tooltip content="开一段新的（挑目录、写第一句）" placement="bottom">
          <el-button
            class="side__new"
            text
            :icon="Plus"
            aria-label="开一段新的"
            @click="ai.startNew()"
          />
        </el-tooltip>
      </header>

      <AiSessionTree
        :groups="ai.groups"
        :active-id="ai.activeId"
        :running-ids="runningIds"
        @select="ai.selectSession"
        @start="ai.startNew"
        @remove="ai.deleteSession"
      />

      <!-- 左栏底部那一行：两个不跟会话走的入口。树自己 flex:1 吃掉剩余高度，这一行永远钉在底下 -->
      <footer class="side__foot">
        <el-button class="side__skills" text :icon="MagicStick" @click="skillVisible = true">
          技能
        </el-button>
        <el-tooltip content="收起会话列表" placement="top">
          <el-button
            class="side__fold"
            text
            :icon="Fold"
            aria-label="收起会话列表"
            @click="toggleTree"
          />
        </el-tooltip>
      </footer>
    </aside>

    <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
    <PanelResizer
      v-show="!treeCollapsed"
      :width="settings.themeConfig.aiTreeWidth"
      body-class="is-resizing-ai-tree"
      @move="settings.setAiTreeWidth"
      @end="() => void settings.commitAiTreeWidth()"
    />

    <section class="ai-view__main">
      <!-- 树收起来之后左栏底部那行跟着没了，这颗浮出的「展开」是唯一的开关（两屏都看得见；
           树摊开时它不画 —— 收起的开关在左栏底部那一行） -->
      <el-tooltip v-if="treeCollapsed" content="展开会话列表" placement="bottom">
        <el-button
          class="ai-view__tree-toggle"
          :icon="Expand"
          :aria-label="treeCollapsed ? '展开会话列表' : '收起会话列表'"
          @click="toggleTree"
        />
      </el-tooltip>

      <!-- 控制台：这段对话 + 底部那一栏目录与同一条 composer。
           点开回答里的文件链接时对话让位：右边并排摊开预览栏（页内分栏，不是弹层） -->
      <template v-if="ai.activeSession">
        <div class="ai-view__console">
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
              :thinking-text="ai.thinkingText"
              :thinking="ai.thinkingLive"
              :confirms="ai.confirms"
              :exit-code="ai.exitCode"
              :run-error="ai.runError"
              :written="ai.written"
              @install="ai.installPi()"
              @answer="(id, allowed) => ai.answerConfirm(id, allowed)"
              @open="openPreview"
            />
          </section>

          <AiPreviewPane
            v-if="previews.length"
            :previews="previews"
            :active-key="activeKey"
            :width="previewWidth"
            @activate="activeKey = $event"
            @close="closePreview"
            @resize="previewWidth = clampPreviewWidth($event)"
          />
        </div>

        <AiLocationBar />
        <AiComposer @configure="modelVisible = true" />
      </template>

      <!-- 起始那一屏：没挑中会话（一段都还没有 / 都删光了 / 刚点了左栏那颗「+」）——
           中间就是那条 composer，一进来就能直接写；**会话在发出第一句时才建**
           （见 stores/ai.ts 的 run），所以上面那条从「挑目录」说起：下一个在哪个目录里干活。 -->
      <div v-else class="landing">
        <div class="landing__box">
          <AiLocationBar />
          <AiComposer @configure="modelVisible = true" />

          <!-- 只在没探到 Pi 时才有东西的一行（它随包内置，正常看不到）。控制台那一屏那颗
               长在运行面板的顶部通知条上（见 AiRunPanel），这一屏没有那一条，所以在这儿
               补一颗；发送那颗按钮按不动时说的就是它（见 stores/ai.ts 的 blocking） -->
          <div v-if="!ai.piVersion" class="landing__foot">
            <el-button
              size="small"
              :icon="Download"
              :loading="ai.installing"
              @click="ai.installPi()"
            >
              安装 Pi
            </el-button>
          </div>
        </div>
      </div>
    </section>

    <!-- 弹层挂在最外层：两屏都开得出它们 -->
    <AiModelDialog v-model="modelVisible" />
    <AiSkillDialog v-model="skillVisible" />
  </main>
</template>

<style scoped>
/**
 * 左树右对话。两栏各是一张卡片（.panel 那副外壳，写在 global.css），间距与别处同源 ——
 * 左栏宽度跟着 theme.json 里的 aiTreeWidth 走（拖动分隔条改它，那颗收起按钮收它）、
 * 右栏吃掉剩余宽度，两栏各自滚。外框的留白与笔记 / 视频页同一套（左右与下边距取卡片间距，
 * 顶边归 .shell 管）。栏间留白挪到左栏的 margin-right 上，不用 grid 的 gap ——
 * 收起时留白也要跟着收到 0，gap 做不到（与视频页同一套做法）。
 */
.ai-view {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

.ai-view__side {
  display: flex;
  flex-direction: column;
  /* .panel 自带的 12px gap 对这一栏太松（用户拍板去掉）：表头与树贴着排，
     树与底部那一行的间隔由 .side__foot 自己的 margin 给 */
  gap: 0;
  /* 宽度住在 theme.json（拖两栏之间那条缝改它）；收起收到 0 —— 见 is-collapsed */
  width: var(--tree-w, 232px);
  min-height: 0;
  margin-right: var(--card-gap, 10px);
  padding: var(--sp-3);
  /**
   * 收起 / 展开的过渡（右栏左上角那颗按钮 → theme.json 的 aiTreeCollapsed，见 is-collapsed）：
   * 宽、右留白、左右内边距与边框一起动。visibility 不占时长：展开方向立即生效，
   * 收起方向由 is-collapsed 里那条带延时的声明接管。
   */
  transition:
    width 0.2s ease,
    margin-right 0.2s ease,
    padding-left 0.2s ease,
    padding-right 0.2s ease,
    border-left-width 0.2s ease,
    border-right-width 0.2s ease,
    opacity 0.2s ease,
    visibility 0s;
}

/** 收起不是卸载：这一栏过渡到 0 宽、淡出，树与展开态原样留在内存里，展开回来还在 */
.ai-view__side.is-collapsed {
  width: 0;
  margin-right: 0;
  padding-left: 0;
  padding-right: 0;
  border-left-width: 0;
  border-right-width: 0;
  opacity: 0;
  /* .panel 自带 overflow: hidden，收的过程中树被裁掉，不会挤出来 */
  visibility: hidden;
  pointer-events: none;
  /* visibility 拖到动画走完再生效：淡出全程可见，收完之后里面的东西也不进 Tab 序 */
  transition:
    width 0.2s ease,
    margin-right 0.2s ease,
    padding-left 0.2s ease,
    padding-right 0.2s ease,
    border-left-width 0.2s ease,
    border-right-width 0.2s ease,
    opacity 0.2s ease,
    visibility 0s 0.2s;
}

/* 拖动期间别让 0.2s 的宽度过渡跟手作对：每一帧都在改目标值，过渡只会让它拖泥带水 */
body.is-resizing-ai-tree .ai-view__side {
  transition: none;
}

/* 与树的间隔不在 .panel 的 gap 里给（那一层已归零）—— 这一栏的表头直接贴着树 */
.side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex-shrink: 0;
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

/**
 * 左栏底部那一行：技能的管理入口与收起整栏的开关（右栏的 composer 工具行不再放它们）。
 * 一条上边线把树与这一行分开 —— 树多矮它都钉在栏底。
 */
.side__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex-shrink: 0;
  /* .panel 的 gap 已在这一栏归零，树与这一行的间隔由这条 margin 给 */
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.side__skills {
  height: 24px;
  padding: 0 var(--sp-1);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.side__fold {
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--ink-2);
}

/* 右栏：上面吃剩余高度（对话），下面两行定高（目录栏与 composer）。
   收起左栏的那颗按钮浮在它的左上角，得有定位当参照 */
.ai-view__main {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  gap: var(--sp-3);
  min-width: 0;
  min-height: 0;
}

/**
 * 树收起之后浮出的那颗「展开」：右栏（两屏都是它）的左上角 —— 那会儿左栏底部那行已经
 * 跟着整栏收到 0 宽里去了，它是唯一的开关。滚动的内容会从它底下过：默认变体自带一块
 * 实底与一圈边，压着的字不至于读不成行；比正文略抬一层，别被流式那几行的 relative 抢了点击。
 */
.ai-view__tree-toggle {
  position: absolute;
  top: var(--sp-2);
  left: var(--sp-2);
  z-index: 1;
  width: 24px;
  height: 24px;
  padding: 0;
}

/**
 * 控制台那一行：对话与预览栏并排。预览栏的宽度长在它自己身上（AiView 里钳位，
 * 拖它左缘那条缝改），一张 Tab 都没有的时候这行只剩对话 —— 占满整行。
 */
.ai-view__console {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--sp-3);
  min-height: 0;
}

.ai-view__log {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

/* ---------- 起始那一屏 ---------- */

/**
 * 居中的一屏：位置那一栏 + composer —— **中间那条 composer 就是主角**
 * （与 ZCode 的起始屏同一副样子：一进来就能写），它自己不套卡片，那条输入框本身就是卡片。
 *
 * 竖着居中靠 `.landing__box` 的 `margin: auto 0`，不靠 `justify-content`：窗口拉得很矮、
 * 内容比一屏高时，`justify-content: center` 会把顶上那半截永远推出可视区（滚不到），
 * auto 边距这会儿自动归零，从顶上开始排。
 */
.landing {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4) 0;
}

.landing__box {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: min(100%, 720px);
  margin: auto 0;
}

/* 输入框底下那一行：只在没探到 Pi 时才出现（那颗「安装 Pi」，居中） */
.landing__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
</style>
