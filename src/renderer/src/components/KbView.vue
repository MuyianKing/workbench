<script setup lang="ts">
/**
 * 知识库页：**只读地看**一个用户在别处维护的独立项目。
 *
 * 知识库就是用户挑的那个文件夹（`data/raw/` 原始资料 + `kb/` 条目 + 索引，见 shared/kb.ts），
 * 应用在这里做两件事：原始数据管理 —— 列出 raw 文件并算清「未入库 / 有更新 / 已入库」，
 * 把整理这件事用一段指令交还给 Agent（应用不生成、不改写）；知识库信息 —— 条目清单、
 * 只读阅读、统计与索引状态。仓库连了远端时再给一颗同步按钮（与笔记 / 技能同一族通道）。
 *
 * 页面有三种整页状态：没选文件夹的引导、目录读不出来的报错、选的文件夹不像知识库的提醒；
 * 正常态是「左清单右阅读」两栏，左栏在条目与原始数据之间切换，右栏在概览与条目正文之间切换。
 * 数据与动作都在 store 里（见 stores/kb.ts），组件只编排界面。
 */
import { computed, onMounted, ref } from 'vue'
import { DocumentAdd, Folder, FolderOpened, Refresh, RefreshRight, Tickets } from '@element-plus/icons-vue'
import { useKbStore } from '@/stores/kb'
import PanelLoading from '@/components/PanelLoading.vue'
import KbEntryList from '@/components/KbEntryList.vue'
import KbRawList from '@/components/KbRawList.vue'
import KbInfoPanel from '@/components/KbInfoPanel.vue'
import KbEntryViewer from '@/components/KbEntryViewer.vue'

const store = useKbStore()

onMounted(() => {
  void store.init()
})

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
</script>

<template>
  <main class="kb-view" :class="{ 'is-intro': !store.root }">
    <!-- 还没选知识库文件夹：整页只有一块自绘线稿、「知识库」那行标题与那颗按钮，居中浮在画布上、
         不套卡片；文件夹该怎么摆（data/raw 与 kb）收在按钮的悬停里，不摆在页面上 -->
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

        <h2 class="guide__title">知识库</h2>
      </div>

      <el-tooltip content="选一个独立的知识库项目文件夹：data/raw 放原始资料，kb 放整理好的条目" placement="top">
        <el-button type="primary" :icon="FolderOpened" @click="pickRoot">选择知识库文件夹</el-button>
      </el-tooltip>
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
          <el-tooltip content="把「哪些待整理」与整理要求复制成一段指令，粘贴给 Agent 执行" placement="bottom">
            <el-button size="small" :icon="Tickets" @click="store.copyInstruction()">
              复制整理指令
            </el-button>
          </el-tooltip>
          <el-tooltip
            content="按 kb/ 下的条目重算 _catalog.md 与 index.json（与仓库脚本的输出一致）"
            placement="bottom"
          >
            <el-button
              size="small"
              :icon="DocumentAdd"
              :loading="store.rebuilding"
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
              @click="store.syncNow()"
            >
              同步
            </el-button>
          </el-tooltip>
          <el-tooltip content="在资源管理器中打开" placement="bottom">
            <el-button size="small" :icon="Folder" @click="revealRoot" />
          </el-tooltip>
          <el-button size="small" :icon="Refresh" :loading="store.loading" @click="store.reload()" />
          <el-tooltip content="换一个知识库文件夹" placement="bottom">
            <el-button size="small" :icon="FolderOpened" @click="pickRoot" />
          </el-tooltip>
        </div>
      </div>

      <p v-if="store.syncError" class="sync-error">{{ store.syncError }}</p>

      <!-- 正常的两栏：左清单右阅读 -->
      <div v-if="store.loaded && store.looksLikeKb" class="kb-view__body">
        <section class="kb-view__left panel">
          <el-segmented v-model="pane" :options="PANES" class="kb-view__pane" />
          <KbEntryList
            v-show="pane === 'entries'"
            :entries="store.entries"
            :active-rel="store.activeRel"
            @select="store.openEntry($event)"
          />
          <KbRawList
            v-show="pane === 'raw'"
            :items="store.rawItems"
            @copy-instruction="store.copyInstruction()"
          />
        </section>

        <section class="kb-view__right panel">
          <KbEntryViewer
            v-if="store.activeEntry"
            :entry="store.activeEntry"
            :content="store.activeContent"
            :loading="store.activeLoading"
            @back="store.backToOverview()"
            @copy-instruction="store.copyInstruction()"
          />
          <KbInfoPanel
            v-else
            :stats="store.stats"
            :tag-counts="store.tagCounts"
            :index-info="store.indexInfo"
            :is-repo="store.repoState?.isRepo === true"
            :repo-origin="store.remoteUrl"
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
            知识库的布局由它自己的脚本与 Agent 说明约定（见那个仓库的 README），这里只认这两块。
          </p>
          <el-button :icon="FolderOpened" @click="pickRoot">换一个知识库文件夹</el-button>
        </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
.kb-view {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--card-gap, 10px);
}

/* 整页只剩引导这一块时把三行收成一行：它要吃掉整页高度，居中才有参照。
   留着三行的话它只占第一行（auto），盒子就内容那么高，看着是「顶在上沿」 */
.kb-view.is-intro {
  grid-template-rows: minmax(0, 1fr);
}

/* 还没选文件夹时的引导：没有卡片底，居中浮在画布上 */
.guide {
  display: flex;
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

/* 同步失败的那行原因：紧跟工具条，不像弹窗那样打断人 */
.sync-error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

/* 两栏主体：左清单固定宽，右阅读吃剩下的 */
.kb-view__body {
  display: grid;
  grid-template-columns: minmax(320px, 30%) minmax(0, 1fr);
  gap: var(--sp-3);
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

/* 整页状态的容器（读取中 / 报错 / 不像知识库） */
.kb-view__state {
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
