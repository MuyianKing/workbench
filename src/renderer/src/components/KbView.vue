<script setup lang="ts">
/**
 * 知识库页：看一个用户在别处维护的独立项目，清洗也在这里一键完成。
 *
 * 知识库就是用户挑的那个文件夹（`data/raw/` 原始资料 + `kb/` 条目 + 索引，见 shared/kb.ts），
 * 应用在这里做两件事：原始数据管理 —— 列出 raw 文件并算清「未入库 / 有更新 / 已入库」，
 * 点开就地预览（文本类）或交给系统默认程序（其余格式）；
 * 知识库信息 —— 条目清单、只读阅读、统计与索引状态。清洗是应用编排的：把待处理清单交给
 * 内置的 Pi（提示词在应用里，用户看不见），跑完自动重建索引、刷新状态 —— 全程都在右栏的
 * 清洗面板里看得见。仓库连了远端时再给一颗同步按钮（与笔记 / 技能同一族通道）。
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
import {
  Collection,
  DocumentAdd,
  Folder,
  FolderOpened,
  MagicStick,
  Refresh,
  RefreshRight
} from '@element-plus/icons-vue'
import { useKbStore } from '@/stores/kb'
import { useSettingsStore } from '@/stores/settings'
import { notifyError } from '@/notify'
import PanelLoading from '@/components/PanelLoading.vue'
import KbEntryTree from '@/components/KbEntryTree.vue'
import KbRawList from '@/components/KbRawList.vue'
import KbInfoPanel from '@/components/KbInfoPanel.vue'
import KbEntryViewer from '@/components/KbEntryViewer.vue'
import KbRawViewer from '@/components/KbRawViewer.vue'
import KbCleanPanel from '@/components/KbCleanPanel.vue'
import AiModelDialog from '@/components/AiModelDialog.vue'
import PanelResizer from '@/components/PanelResizer.vue'

const store = useKbStore()
const settings = useSettingsStore()

onMounted(() => {
  void store.init()
})

/** 模型管理弹窗（清洗面板缺模型 / 缺密钥时从那里去） */
const modelVisible = ref(false)

/** 挑一个知识库文件夹：**它就是那个独立项目的根**。换目录不搬动任何文件 */
async function pickRoot(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择知识库文件夹')
  if (picked) await store.setRoot(picked)
}

/** 在资源管理器里打开知识库文件夹（往 data/raw 里放资料就在那儿放） */
function revealRoot(): void {
  void window.workbench.reveal(store.root)
}

/** 同步按钮的提示：同步到哪儿先说清楚（它只推这个文件夹自己连着的仓库） */
const syncTitle = computed(() =>
  store.remoteUrl ? `提交改动、拉回别处的改动：同步到 ${store.remoteUrl}` : '这个文件夹还没连 git 远端'
)

/** 左栏的两个签：条目 / 原始数据 */
const pane = ref<'entries' | 'raw'>('entries')
const PANES = [
  { label: '条目', value: 'entries' as const },
  { label: '原始数据', value: 'raw' as const }
]

/** 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频 / AI 页同一套做法） */
const bodyStyle = computed(() => ({
  gridTemplateColumns: `${settings.themeConfig.kbTreeWidth}px minmax(0, 1fr)`,
  '--tree-w': `${settings.themeConfig.kbTreeWidth}px`
}))

/** 用系统默认程序打开正在查看的原始数据（预览不了的格式给出去；路径就是根 + rel） */
async function openRawExternally(): Promise<void> {
  if (!store.activeRaw) return
  const result = await window.workbench.openPath(`${store.root}/${store.activeRaw.rel}`)
  if (!result.ok) notifyError(result.error ?? '打开文件失败')
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
    <!-- 还没选知识库文件夹：只有标题、一句说明与那颗按钮 -->
    <div v-if="!store.root" class="guide panel">
      <el-icon class="empty__icon"><Collection /></el-icon>
      <h2 class="guide__title">知识库</h2>
      <p class="guide__text">
        指向一个独立的知识库项目文件夹：<span class="mono">data/raw</span> 放原始资料，
        <span class="mono">kb</span> 放整理好的条目。哪些还没入库、哪些又更新了一眼可见，
        清洗由应用一键完成。
      </p>
      <el-button type="primary" :icon="FolderOpened" @click="pickRoot">选择知识库文件夹</el-button>
    </div>

    <template v-else>
      <!-- 工具条：与技能页那条同款 -->
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">知识库</h2>
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
          <el-button
            size="small"
            :icon="Refresh"
            :loading="store.loading"
            :disabled="store.cleanBusy"
            @click="store.reload()"
          />
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

      <p v-if="store.syncError" class="sync-error">{{ store.syncError }}</p>

      <!-- 正常的两栏：左清单右阅读（清洗进行中 / 刚收场时右栏让给清洗面板） -->
      <div v-if="store.loaded && store.looksLikeKb" class="kb-view__body" :style="bodyStyle">
        <section class="kb-view__left panel">
          <el-segmented v-model="pane" :options="PANES" class="kb-view__pane" />
          <KbEntryTree
            v-show="pane === 'entries'"
            :entries="store.entries"
            :active-rel="store.activeRel"
            @select="store.openEntry($event)"
          />
          <KbRawList
            v-show="pane === 'raw'"
            :items="store.rawItems"
            @clean="store.startClean()"
            @open="store.openRaw($event)"
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
          <p class="empty__text">{{ store.loadError }}</p>
          <el-button :icon="FolderOpened" @click="pickRoot">换一个知识库文件夹</el-button>
        </div>
        <div v-else class="empty panel">
          <p class="empty__text">
            这个文件夹里没有 <span class="mono">data/raw</span> 也没有
            <span class="mono">kb</span>，看起来不是知识库项目的根。
          </p>
          <p class="empty__hint">
            知识库是纯数据的：<span class="mono">data/raw</span> 放原始资料、
            <span class="mono">kb</span> 放整理好的条目，这里只认这两块布局。
          </p>
          <el-button :icon="FolderOpened" @click="pickRoot">换一个知识库文件夹</el-button>
        </div>
      </div>
    </template>

    <!-- 模型管理：清洗缺模型 / 缺密钥时从面板里去（配置是全局的，与 AI 助手页共用） -->
    <AiModelDialog v-model="modelVisible" />
  </main>
</template>

<style scoped>
.kb-view {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  /**
   * 左右下三边与卡片间距同源；**上边一份不给自己加** —— 顶栏下面那条缝归 .shell 管
   * （见 global.css「顶栏与内容之间那条缝」），这里再补一份，正常 / 毛玻璃两档就成了两倍，
   * 工具条也会比导航栏那张卡片低一截。
   */
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/* 还没选文件夹时的引导：整页只有它，占满三行（height: 100% 要对着行跨才有得算） */
.guide {
  grid-row: 1 / -1;
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
   它是 v-if 的：不显式钉在第二行，它不渲染时后面那行会顺次上移、落进 auto 行里，
   两栏就只剩内容那么高 —— 三行各归各位，谁在谁不在都不挪窝 */
.sync-error {
  grid-row: 2;
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
  grid-row: 3;
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

.kb-view__pane {
  align-self: flex-start;
}

.kb-view__right {
  min-height: 0;
  overflow: hidden;
}

/* 整页状态的容器（读取中 / 报错 / 不像知识库）：与两栏同占第三行，吃满剩下的高度 */
.kb-view__state {
  grid-row: 3;
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
