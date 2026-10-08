<script setup lang="ts">
import type { KbRawSourceRow } from '@workbench/kb'
import { DocumentAdd, Folder, FolderOpened, MagicStick, Plus, Refresh, RefreshRight } from '@element-plus/icons-vue'
/**
 * 知识库页：看一个用户在别处维护的独立项目，清洗也在这里一键完成。
 *
 * 知识库就是用户挑的那个文件夹（原始资料在 `data/raw/`、条目在 `kb/`、索引由应用重建，
 * 见 shared/kb.ts），应用在这里做两件事：原始数据管理 —— 列出 raw 文件并算清「未入库 /
 * 有更新 / 已入库」，点开就地预览（文本类）或交给系统默认程序（其余格式）；
 * 知识库信息 —— 条目清单、只读阅读、统计与索引状态。清洗是应用编排的：把待处理清单交给
 * 内置的 Pi（提示词在应用里，用户看不见），跑完自动重建索引、刷新状态 —— 全程都在右栏的
 * 清洗面板里看得见。仓库连了远端时再给一颗同步按钮（与笔记 / 技能同一族通道）。
 *
 * **原始数据的最外层是来源**：`data/raw/<名字>` 那一格可以配到本机一个外部文件夹
 * （左栏那一行行首的齿轮 / 顶部「添加原始数据」；配置只是一层映射，不搬文件），
 * 资料就不必再 copy 进库。检测是**手动**的：工具条那颗「检测更新」= 重扫 + 报一句变化，
 * 没有后台轮询、也不自动清洗（这一页的动作都由用户点出来）。
 *
 * 页面有三种整页状态：没选文件夹的引导、目录读不出来的报错、选的文件夹不像知识库的提醒；
 * 正常态是「左清单右阅读」两栏，左栏在条目与原始数据之间切换（两签都是按目录结构
 * 收成的树），右栏在概览、条目正文、原始数据与清洗面板之间切换（清洗进行中 /
 * 刚收场时面板优先）。概览里的**巡检**清单与条目正文里的**站内链接**都点得到东西：
 * 前者直接开那一条，后者经 store 解析（链到原始资料上也照样跳）。两栏之间那条缝
 * 可以左右拖（宽度住 theme.json 的 `kbTreeWidth`，与笔记 / 视频 / AI 页同一套做法）。
 * 数据与动作都在 store 里（见 stores/kb.ts），组件只编排界面。
 */
import { computed, onMounted, ref } from 'vue'
import AiModelDialog from '@/components/AiModelDialog.vue'
import KbCleanPanel from '@/components/KbCleanPanel.vue'
import KbEntryTree from '@/components/KbEntryTree.vue'
import KbEntryViewer from '@/components/KbEntryViewer.vue'
import KbInfoPanel from '@/components/KbInfoPanel.vue'
import KbRawList from '@/components/KbRawList.vue'
import KbRawSourceDialog from '@/components/KbRawSourceDialog.vue'
import KbRawViewer from '@/components/KbRawViewer.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { notifyError } from '@/notify'
import { useKbStore } from '@/stores/kb'
import { useSettingsStore } from '@/stores/settings'

const store = useKbStore()
const settings = useSettingsStore()

onMounted(() => {
  void store.init()
})

/** 模型管理弹窗（清洗面板缺模型 / 缺密钥时从那里去） */
const modelVisible = ref(false)

/** 来源弹层（新加一个 / 给某个来源指定路径）：开着时这两个值就是它的输入 */
const sourceVisible = ref(false)
const sourceName = ref('')
const sourceDir = ref('')

function addSource(): void {
  sourceName.value = ''
  sourceDir.value = ''
  sourceVisible.value = true
}

function editSource(row: KbRawSourceRow): void {
  sourceName.value = row.name
  // 只有配过外部路径的才回填：库里那份的路径（`<知识库>/data/raw/<名字>`）不是合法的映射
  // （指到知识库文件夹里的会被收敛掉），填进去再一点保存就成了「还没指定路径」
  sourceDir.value = row.kind === 'mapped' ? row.dir : ''
  sourceVisible.value = true
}

/** 这条来源在设置里有没有记录（有记录才谈得上「移除」；库里 data/raw 那份是它自己的目录） */
const sourceConfigured = computed(() =>
  store.sources.some(source => source.name.toLowerCase() === sourceName.value.toLowerCase()),
)

/**
 * 弹层里点了确认：新加的走 `addSource`，已有的走 `setSourceDir`（名字是条目 source 的
 * 契约，定下来不给改）。两处都只是写设置 —— store 那边盯着映射的形状，落盘后自己重扫。
 * 失败的原因 store 里就地说了（重名 / 保存设置失败），这里不再补一句重复的。
 */
async function submitSource(payload: { name: string, dir: string }): Promise<void> {
  if (sourceName.value)
    await store.setSourceDir(payload.name, payload.dir)
  else
    await store.addSource(payload.name, payload.dir)
}

/** 挑一个知识库文件夹：**它就是那个独立项目的根**。换目录不搬动任何文件 */
async function pickRoot(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择知识库文件夹')
  if (picked)
    await store.setRoot(picked)
}

/** 在资源管理器里打开知识库文件夹（把资料放进库里的 data/raw 就在那儿放） */
function revealRoot(): void {
  void window.workbench.reveal(store.root)
}

/** 同步按钮的提示：同步到哪儿先说清楚（它只推这个文件夹自己连着的仓库） */
const syncTitle = computed(() =>
  store.remoteUrl ? `提交改动、拉回别处的改动：同步到 ${store.remoteUrl}` : '这个文件夹还没连 git 远端',
)

/** 左栏的两个签：条目 / 原始数据 */
const pane = ref<'entries' | 'raw'>('entries')
const PANES = [
  { label: '条目', value: 'entries' as const },
  { label: '原始数据', value: 'raw' as const },
]

/** 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频 / AI 页同一套做法） */
const bodyStyle = computed(() => ({
  'gridTemplateColumns': `${settings.themeConfig.kbTreeWidth}px minmax(0, 1fr)`,
  '--tree-w': `${settings.themeConfig.kbTreeWidth}px`,
}))

/**
 * 用系统默认程序打开正在查看的原始数据（预览不了的格式给出去）。
 * 路径用 Rust 扫回来的绝对路径（`abs`）—— 来源里的资料在库外面，自己拼「根 + rel」会拼错
 */
async function openRawExternally(): Promise<void> {
  if (!store.activeRaw?.abs)
    return
  const result = await window.workbench.openPath(store.activeRaw.abs)
  if (!result.ok)
    notifyError(result.error ?? '打开文件失败')
}

/**
 * 清洗收据里点一条：**收起面板**再去读它（右栏同一时刻只有一份东西，见模板里的先后）。
 * 收面板与「返回概览」是同一条路 —— 收据跟着这一轮的日志走，日志收起来它也就没了。
 */
function openWritten(rel: string): void {
  store.closeClean()
  void store.openEntry(rel)
}
</script>

<template>
  <main class="kb-view">
    <!-- 还没选知识库文件夹：整页只有一块自绘线稿、「知识库」那行标题与那颗按钮，居中浮在画布上、
         不套卡片；文件夹该怎么摆（data/raw 与 kb）与清洗收在按钮的悬停里，不摆在页面上 -->
    <div v-if="!store.root" class="guide">
      <div class="guide__hero">
        <!-- 线稿：三张叠着的纸 —— 后面两张是散页，最前面那张是收好的条目（右上角一枚书签、
             三条正文线），与 AI 助手页那一屏同一副笔法。后面那两张各拿 mask 裁一下：
             线稿只有描边、没有底色，不裁的话它们的边会从前面那张纸里透出来 -->
        <svg class="guide__art" viewBox="0 0 224 148" fill="none" aria-hidden="true">
          <defs>
            <mask id="kb-guide-card">
              <rect width="224" height="148" fill="white" />
              <rect x="86" y="41" width="107" height="95" rx="11" fill="black" />
            </mask>
            <mask id="kb-guide-cards">
              <rect width="224" height="148" fill="white" />
              <rect x="86" y="41" width="107" height="95" rx="11" fill="black" />
              <rect x="58" y="27" width="107" height="95" rx="11" fill="black" />
            </mask>
          </defs>

          <g mask="url(#kb-guide-cards)">
            <rect x="31.5" y="14.5" width="104" height="92" rx="10" stroke="currentColor" stroke-width="1" />
            <path d="M52 22h78" stroke="currentColor" stroke-width="1" />
          </g>

          <g mask="url(#kb-guide-card)">
            <rect x="59.5" y="28.5" width="104" height="92" rx="10" stroke="currentColor" stroke-width="1" />
            <path d="M76 36h74" stroke="currentColor" stroke-width="1" />
          </g>

          <rect x="87.5" y="42.5" width="104" height="92" rx="10" stroke="currentColor" stroke-width="1" />
          <path d="M168 42.5v24l6.5-6.5 6.5 6.5v-24" stroke="currentColor" stroke-width="1" />
          <path d="M104 76h72M104 92h46M104 108h62" stroke="currentColor" stroke-width="1" />
        </svg>

        <h2 class="guide__title">
          知识库
        </h2>
      </div>

      <el-tooltip
        content="选一个独立的知识库项目文件夹：原始资料放 data/raw（或者挂一个外部的来源文件夹），kb 放整理好的条目；清洗由应用一键完成"
        placement="top"
      >
        <el-button type="primary" :icon="FolderOpened" @click="pickRoot">
          选择知识库文件夹
        </el-button>
      </el-tooltip>
    </div>

    <template v-else>
      <!-- 工具条：与技能页那条同款 -->
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">
              知识库
            </h2>
            <span class="head__loc mono" :title="store.root">{{ store.locationText }}</span>
          </div>
          <span v-if="store.loaded && store.looksLikeKb" class="head__stats">
            条目 {{ store.stats.entries }} · 未入库 {{ store.stats.pending }} · 有更新
            {{ store.stats.stale }}
          </span>
        </div>
        <div class="filter__tools">
          <el-tooltip
            content="把未入库与有更新的原始文件交给内置的 Pi 整理成条目，跑完自动重建索引"
            placement="bottom"
          >
            <el-button
              size="small"
              type="primary"
              :icon="MagicStick"
              :loading="store.cleanBusy"
              @click="store.startClean()"
            >
              开始清洗
            </el-button>
          </el-tooltip>
          <el-tooltip content="按 kb/ 下的条目重算 _catalog.md 与 index/index.json" placement="bottom">
            <el-button
              size="small"
              :icon="DocumentAdd"
              :loading="store.rebuilding"
              :disabled="store.cleanBusy"
              @click="store.rebuildIndex()"
            >
              重建索引
            </el-button>
          </el-tooltip>
          <el-tooltip v-if="store.canSync" :content="syncTitle" placement="bottom">
            <el-button
              size="small"
              :icon="RefreshRight"
              :loading="store.syncing"
              :disabled="store.cleanBusy"
              @click="store.syncNow()"
            >
              同步
            </el-button>
          </el-tooltip>
          <el-tooltip content="在资源管理器中打开" placement="bottom">
            <el-button size="small" :icon="Folder" :disabled="store.cleanBusy" @click="revealRoot" />
          </el-tooltip>
          <el-tooltip
            content="重扫一遍知识库与各来源文件夹，算清未入库 / 有更新（只读，不清洗）"
            placement="bottom"
          >
            <el-button
              size="small"
              :icon="Refresh"
              :loading="store.loading"
              :disabled="store.cleanBusy"
              @click="store.detect()"
            >
              检测更新
            </el-button>
          </el-tooltip>
          <el-tooltip content="换一个知识库文件夹" placement="bottom">
            <el-button
              size="small"
              :icon="FolderOpened"
              :disabled="store.cleanBusy"
              @click="pickRoot"
            />
          </el-tooltip>
        </div>
      </div>

      <p v-if="store.syncError" class="sync-error">
        {{ store.syncError }}
      </p>

      <!-- 正常的两栏：左清单右阅读（清洗进行中 / 刚收场时右栏让给清洗面板） -->
      <div v-if="store.loaded && store.looksLikeKb" class="kb-view__body" :style="bodyStyle">
        <section class="kb-view__left panel">
          <!--
            左栏顶上一行：两签在左，添加来源在右（只有原始数据那一签才摆它 —— 条目那一栏
            没有可加的东西）。它是一颗**没有底色**的图标按钮（`text`）：这一栏本来就是一张卡片，
            再嵌一块白底方块，看着像另一张卡压在上面。
          -->
          <div class="kb-view__pane-row">
            <el-segmented v-model="pane" :options="PANES" class="kb-view__pane" />
            <el-tooltip
              v-if="pane === 'raw'"
              content="添加原始数据：把一个外部文件夹挂成来源（不搬动文件）"
              placement="bottom"
            >
              <el-button
                class="kb-view__add"
                text
                size="small"
                :icon="Plus"
                aria-label="添加原始数据"
                @click="addSource"
              />
            </el-tooltip>
          </div>
          <KbEntryTree
            v-show="pane === 'entries'"
            :entries="store.entries"
            :active-rel="store.activeRel"
            @select="store.openEntry($event)"
          />
          <KbRawList
            v-show="pane === 'raw'"
            :items="store.rawItems"
            :sources="store.rawSources"
            @open="store.openRaw($event)"
            @edit-source="editSource"
          />
        </section>

        <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
        <PanelResizer
          :width="settings.themeConfig.kbTreeWidth"
          body-class="is-resizing-kb-tree"
          @move="settings.setKbTreeWidth"
          @end="() => void settings.commitKbTreeWidth()"
        />

        <section class="kb-view__right panel">
          <KbCleanPanel
            v-if="store.cleanPhase !== 'idle'"
            :phase="store.cleanPhase"
            :lines="store.cleanLines"
            :error="store.cleanError"
            :created="store.cleanWrites.created"
            :updated="store.cleanWrites.updated"
            @start="store.startClean()"
            @stop="store.stopClean()"
            @close="store.closeClean()"
            @open-models="modelVisible = true"
            @open-entry="openWritten"
          />
          <KbRawViewer
            v-else-if="store.activeRaw"
            :item="store.activeRaw"
            :kind="store.activeRawKind"
            :content="store.activeRawContent"
            :loading="store.activeRawLoading"
            :error="store.activeRawError"
            @back="store.closeRaw()"
            @open="openRawExternally"
          />
          <KbEntryViewer
            v-else-if="store.activeEntry"
            :entry="store.activeEntry"
            :content="store.activeContent"
            :loading="store.activeLoading"
            @back="store.backToOverview()"
            @internal="store.followLink(store.activeRel, $event)"
          />
          <KbInfoPanel
            v-else
            :stats="store.stats"
            :tag-counts="store.tagCounts"
            :index-info="store.indexInfo"
            :is-repo="store.repoState?.isRepo === true"
            :repo-origin="store.remoteUrl"
            :issues="store.lintIssues"
            @open-entry="store.openEntry($event)"
          />
        </section>
      </div>

      <!-- 读取中 / 读不出来 / 不像知识库：三态各说各的，不挤在一起 -->
      <div v-else class="kb-view__state">
        <div v-if="store.loading && !store.loaded" class="empty panel">
          <PanelLoading text="正在读取知识库…" />
        </div>
        <div v-else-if="store.loadError" class="empty panel">
          <p class="empty__text">
            {{ store.loadError }}
          </p>
          <el-button :icon="FolderOpened" @click="pickRoot">
            换一个知识库文件夹
          </el-button>
        </div>
        <div v-else class="empty panel">
          <p class="empty__text">
            这个文件夹里没有 <span class="mono">kb</span>，也没有
            <span class="mono">data/raw</span>，看起来不是知识库项目的根。
          </p>
          <p class="empty__hint">
            知识库是纯数据的：<span class="mono">kb</span> 放整理好的条目、
            <span class="mono">data/raw</span> 放原始资料（也可以挂外部的来源文件夹）。
          </p>
          <el-button :icon="FolderOpened" @click="pickRoot">
            换一个知识库文件夹
          </el-button>
        </div>
      </div>
    </template>

    <!-- 模型管理：清洗缺模型 / 缺密钥时从面板里去（配置是全局的，与 AI 助手页共用） -->
    <AiModelDialog v-model="modelVisible" />

    <!-- 来源弹层：加一个新来源 / 给某个来源指定文件夹（配置只是一层映射，不搬动文件） -->
    <KbRawSourceDialog
      v-model="sourceVisible"
      :name="sourceName"
      :dir="sourceDir"
      :configured="sourceConfigured"
      @submit="submitSource"
      @remove="store.removeSource($event)"
    />
  </main>
</template>

<style scoped>
.kb-view {
  display: flex;
  flex-direction: column;
  /**
   * 行距就是设置里那一档「卡片间距」（--card-gap）：工具带与两栏之间、两栏之间、报错那行上下，
   * 全都是同一个数 —— 与项目页 / 工作页 / 密码页工具带下沿那条缝同源（那几页是滚动体自己带
   * `padding: var(--card-gap)`）。
   *
   * 这一层原来是三行网格（工具带 / 报错 / 两栏），报错那行是 v-if 的、又钉死在第二行：
   * 它不渲染时那一条行距照旧占着，于是工具带与两栏之间成了**两条**间距（别的页都只有一条，
   * 看着就是「这一页空得莫名其妙」）。换纵向 flex 之后不渲染的节点不占位，也就没有多出来那条。
   */
  gap: var(--card-gap, 10px);
  height: 100%;
  min-height: 0;
  /**
   * 左右下三边与卡片间距同源；**上边一份不给自己加** —— 顶栏下面那条缝归 .shell 管
   * （见 global.css「顶栏与内容之间那条缝」），这里再补一份，正常 / 毛玻璃两档就成了两倍，
   * 工具条也会比导航栏那张卡片低一截。
   */
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/* 还没选文件夹时的引导：没有卡片底，居中浮在画布上。
   它得吃掉整页高度，居中才有参照（纵向 flex 里就是这一句 flex，网格那版靠 is-intro 换行模板） */
.guide {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  min-height: 0;
  padding: var(--sp-6);
  text-align: center;
}

/* 线稿与标题贴成一团，到按钮那一步松一档 —— 与 AI 助手页那一屏同一套节奏 */
.guide__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
}

/* 线稿是背景性的：只比画布深一点，别抢按钮的视线（与 AiView 的 hero 同一条口径） */
.guide__art {
  width: 200px;
  height: auto;
  color: var(--ink-3);
  opacity: 0.55;
}

.guide__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-display);
  font-weight: 600;
}

/* 工具条上的标题、位置与统计 */
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

/* 同步失败的那行原因：紧跟工具条，不像弹窗那样打断人。
   它是 v-if 的 —— 纵向 flex 里这不成问题：不渲染的节点既不占高度也不占行距，
   两栏照旧吃满剩下的空间（网格那版得把它显式钉在第二行，否则它一缺席、两栏就落进 auto 行
   只剩内容那么高） */
.sync-error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

/**
 * 两栏主体：左清单（宽度跟 theme.json 里的 kbTreeWidth 走，拖动分隔条改它）、
 * 右阅读吃剩下的。间距取 --card-gap：分隔条把手落点的算式里写的是它
 * （与笔记 / 视频 / AI 页同一条缝）。把手挂在**这一层**（position: relative 在这里），
 * 这层没有外边距，所以给把手 `--resizer-inset: 0px` —— 外框那圈内边距归 .kb-view。
 */
.kb-view__body {
  flex: 1 1 auto;
  position: relative;
  --resizer-inset: 0px;
  display: grid;
  /* 两栏的列宽由模板上的内联样式给（kbTreeWidth，拖动分隔条改它） */
  gap: var(--card-gap, 10px);
  min-height: 0;
}

.kb-view__left {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

/*
 * 左栏顶上一行：两签在左、添加来源贴右。它是左栏那一列的第一个子项，
 * 与下面那棵树之间隔的就是 .kb-view__left 的 gap（与两签下面是同一个间距）。
 */
.kb-view__pane-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex-shrink: 0;
  min-width: 0;
}

.kb-view__pane {
  align-self: flex-start;
}

/*
 * 添加来源：一颗没有底色的图标按钮（`el-button text`）—— 左栏本身就是一张卡片，
 * 再嵌一块白底方块看着像另一张卡压在上面。压暗一档、悬停才亮，与树里那颗齿轮同一副脾气。
 */
.kb-view__add {
  flex-shrink: 0;
  color: var(--ink-3);
}

.kb-view__add:hover {
  color: var(--ink);
}

.kb-view__right {
  min-height: 0;
  overflow: hidden;
}

/* 整页状态的容器（读取中 / 报错 / 不像知识库）：与两栏同占一块地方，吃满剩下的高度 */
.kb-view__state {
  flex: 1 1 auto;
  min-height: 0;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  height: 100%;
  padding: var(--sp-6);
  text-align: center;
}

.empty__text {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}

.empty__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}
</style>
