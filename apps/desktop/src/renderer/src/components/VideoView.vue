<script setup lang="ts">
/**
 * 视频页：左边目录树，右边播放器。
 *
 * 它就是一个**本地 MP4 播放器**的「页面」：目录树、头部与空态在这里，
 * **播放器本体不在** —— `<video>` 与它周围那一圈（速率、快捷键、播完自动接续）
 * 住在全局单例 VideoPlayer（挂在 App.vue 上）：在视频页时它经 Teleport 落进
 * `.video__stage` 那个宿主里，切到别的页就缩成悬浮小窗继续播（画中画），
 * 元素不重建，播放一秒不断。所以这一页管的是「这一页长什么样」：
 *   - **还没选文件夹**：整页只有一句引导与那颗「选择文件夹」按钮；
 *   - **选好了**：左树右播放器，点树上的视频立刻开播（走 store.select），
 *     左栏底部是目录本身与「最近打开」那一份历史记录；
 *   - **没有正播的视频时**：画布上是一块空态提示（读不出 / 正在读取 / 打不开 /
 *     是文件夹 / 没有视频 / 还没挑），宿主空着、不接事件，按钮照常点得到。
 *
 * 换页由 App.vue 的 KeepAlive 负责 —— 切走的页面留在内存里，播放器也在全局
 * 单例里接着播。数据与动作都在 store 里，这一层负责编排：谁被选中、什么时候弹
 * 「最近打开」。左栏底部那一行与分隔条是 RecentRoots / PanelResizer（与笔记页共用）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CaretBottom, Check, Expand, Fold, FolderOpened, Refresh, VideoPlay } from '@element-plus/icons-vue'
import { findVideoNode, videoRootName, VIDEO_RATES, VIDEO_SEEK_SECONDS } from '@workbench/video'
import { useVideoStore } from '@/stores/video'
import { useSettingsStore } from '@/stores/settings'
import { setVideoStageHost } from '@/composables/use-video-stage'
import VideoTree from '@/components/VideoTree.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import RecentRoots from '@/components/RecentRoots.vue'
import PanelResizer from '@/components/PanelResizer.vue'

const store = useVideoStore()
const settings = useSettingsStore()

/**
 * 目录树的展开态（行为记忆）：状态住在设置里，这一层只做「读出来 / 写回去」。
 * 只对当前这个目录成立 —— 换目录时由 video store 的 setRoot 清空。
 */
const expandedKeys = computed<string[]>({
  get: () => settings.settings.videoTreeExpanded,
  set: (value) => {
    void settings.updateSettings({ videoTreeExpanded: value })
  }
})

/**
 * 左栏（目录树）收起没有：落在 theme.json（与笔记树宽度同属「这一页长什么样」）。
 * 收起**不是卸载**：这一栏只是过渡到 0 宽（见样式里的 is-collapsed），摊开的那几层
 * 与「上次打开的视频」都在盘上，展开回来原样还在。
 */
const treeCollapsed = computed(() => settings.themeConfig.videoTreeCollapsed)

function toggleTree(): void {
  void settings.setVideoTreeCollapsed(!treeCollapsed.value)
}

/**
 * 左栏（目录树）宽度：住在 theme.json（与笔记树宽度同属「这一页长什么样」），
 * 两栏之间那条缝可以左右拖 —— 拖动时只改本地让界面跟手，松手才落盘（settings 的
 * setVideoTreeWidth / commitVideoTreeWidth，与笔记页同一套做法）。这里只把值挂成
 * CSS 变量：左栏宽度、分隔条落点都从它取。
 */
const treeWidthStyle = computed(() => ({
  '--tree-w': `${settings.themeConfig.videoTreeWidth}px`
}))

/** 正在扫描：右栏据此说一句「正在读取」，而不是显示成「这个文件夹里什么都没有」 */
const scanning = computed(() => store.loading && !store.loaded)

/** 「它在哪一层」：选中项所在的那几层文件夹，从最外层排下来（末尾是它自己，摘掉） */
const locationText = computed(() =>
  store.activeChain
    .slice(0, -1)
    .map((node) => node.name)
    .join(' / ')
)

/**
 * 选中项的节点：空态提示拿它分辨「它是文件夹」与「它是视频但没在播」——
 * 不能见 activeRel 非空就说是文件夹（画中画上点「停止」后回来，选中项还是那个视频）。
 */
const activeNode = computed(() => (store.activeRel ? findVideoNode(store.nodes, store.activeRel) : null))

// ---------- 播放器画布的传送宿主 ----------

/**
 * 播放器本体（VideoPlayer）在视频页时的落位元素：铺满画布、平时不接事件
 * （空态提示的按钮在它下面照常点得到），播放器传送进来后再把事件要回去。
 * 挂载后注册；页面被 KeepAlive 包着，注册只发生这一次，切走也不注销 ——
 * 元素只是脱离文档，回来还在原地。
 */
const stageRef = ref<HTMLElement | null>(null)

onMounted(() => {
  // 宿主先注册（模板 ref 这时已就位），再让 store 扫描并接上「上次打开的视频」
  setVideoStageHost(stageRef.value)
  void store.init()
})

// ---------- 目录与「最近打开」 ----------

/** 第一次进来（或想换一个目录）时挑文件夹；取消就什么都不做 */
async function chooseFolder(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择视频文件夹')
  if (!picked) return

  if (await store.setRoot(picked)) ElMessage.success('视频目录已切换')
}

/** 从「最近打开」里换一个目录（当前的那条 RecentRoots 自己拦下了） */
function openRecentRoot(dir: string): void {
  void store.setRoot(dir)
}
</script>

<template>
  <main class="video" :class="{ 'is-intro': !store.root }">
    <!-- 还没选文件夹：整页只说一件事 —— 先挑一个文件夹当视频库 -->
    <div v-if="!store.root" class="video__intro panel">
      <div class="empty">
        <el-icon class="empty__icon"><VideoPlay /></el-icon>
        <p>看存在本机的 MP4 视频。</p>
        <p class="empty__hint">
          选一个文件夹当视频库：里面的目录结构会变成左边的目录树（只到 MP4 文件），
          支持空格播放暂停、方向键快进快退与倍速。
        </p>
        <el-button type="primary" @click="chooseFolder">
          <el-icon><FolderOpened /></el-icon>
          选择文件夹
        </el-button>
      </div>
    </div>

    <div v-else class="video__body" :style="treeWidthStyle">
      <aside class="video__side panel" :class="{ 'is-collapsed': treeCollapsed }">
        <!-- 读不出来：把原因说出来并给一次重试，不能显示成「这个文件夹里什么都没有」 -->
        <template v-if="store.loadError">
          <p class="video__error">{{ store.loadError }}</p>
          <div class="video__error-actions">
            <el-button size="small" @click="store.reload()">重试</el-button>
            <el-button size="small" @click="chooseFolder">换一个文件夹</el-button>
          </div>
        </template>

        <VideoTree
          v-else
          v-model:expanded="expandedKeys"
          :nodes="store.nodes"
          :active-rel="store.activeRel"
          :loaded="store.loaded && !store.loading"
          @select="store.select"
        />

        <!--
          底部：目录是哪个 + 最近打开的那几个（与笔记页同一副布局）。
          放在树的下面而不是顶上：进这一页要做的第一件事是找视频，不是找设置。
        -->
        <RecentRoots
          :root="store.root"
          :root-name="store.rootName"
          :count-text="`${store.videoCount} 个视频`"
          :roots="store.recentRoots"
          :tree-width="settings.themeConfig.videoTreeWidth"
          :name-of="videoRootName"
          @open="openRecentRoot"
          @forget="(dir: string) => store.forgetRoot(dir)"
        >
          <template #tools>
            <el-tooltip content="重新读取文件夹" placement="top">
              <el-button size="small" text :disabled="store.loading" @click="store.reload()">
                <el-icon><Refresh /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="换一个文件夹" placement="top">
              <el-button size="small" text @click="chooseFolder">
                <el-icon><FolderOpened /></el-icon>
              </el-button>
            </el-tooltip>
          </template>
        </RecentRoots>
      </aside>

      <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条（与笔记页同款） -->
      <PanelResizer
        v-show="!treeCollapsed"
        :width="settings.themeConfig.videoTreeWidth"
        body-class="is-resizing-video-tree"
        @move="settings.setVideoTreeWidth"
        @end="() => void settings.commitVideoTreeWidth()"
      />

      <section class="video__player panel">
        <header class="video__head">
          <!-- 左栏的收起 / 展开入口：树收起来之后这颗按钮是唯一的开关，所以留在播放器头部 -->
          <el-tooltip :content="treeCollapsed ? '展开目录' : '收起目录'" placement="bottom">
            <el-button
              class="video__tree-toggle"
              size="small"
              text
              :icon="treeCollapsed ? Expand : Fold"
              :aria-label="treeCollapsed ? '展开目录' : '收起目录'"
              @click="toggleTree"
            />
          </el-tooltip>

          <template v-if="store.active">
            <span class="video__title" :title="store.active.rel">{{ store.active.name }}</span>
            <span v-if="locationText" class="video__location truncate">{{ locationText }}</span>
          </template>
          <span v-else class="video__location">未选中</span>

          <span class="video__spacer" />

          <!-- 速率：与快捷键 ↑↓ 共用同一份档位表（shared/video.ts 的 VIDEO_RATES）；
               值住在 store 里 —— 悬浮小窗（VideoPlayer）与这里是同一份，两处改的是同一个 -->
          <el-dropdown
            v-if="store.active"
            trigger="click"
            placement="bottom-end"
            @command="(value: number) => (store.rate = value)"
          >
            <button class="video__rate" type="button" title="播放速率（快捷键 ↑ / ↓）">
              {{ store.rate }}x
              <el-icon class="video__rate-caret"><CaretBottom /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="value in VIDEO_RATES"
                  :key="value"
                  :command="value"
                  :class="{ 'is-current': value === store.rate }"
                >
                  <span class="video__rate-item">
                    <el-icon v-if="value === store.rate" class="video__rate-check"><Check /></el-icon>
                    {{ value }}x
                  </span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </header>

        <!-- 播放画布：始终深色（与终端面板同一族令牌），视频居中、按比例缩进画布里 -->
        <div class="video__canvas">
          <!--
            传送宿主：播放器本体（VideoPlayer，全局单例）在视频页时落到这里。
            宿主铺满画布、平时**不接事件**（pointer-events: none，见样式）—— 下面的空态
            提示与它的按钮照常点得到；播放器传送进来后由自己把事件要回去。
          -->
          <div ref="stageRef" class="video__stage" />

          <!-- 空态与错误：只在「没有正播的视频」时摊开（播放器来了就该让位给它） -->
          <div v-if="!store.active" class="empty video__hint">
            <template v-if="store.loadError">
              <p>读不出这个文件夹。</p>
              <p class="empty__hint">{{ store.loadError }}</p>
            </template>
            <PanelLoading v-else-if="scanning" text="正在读取视频…" />
            <template v-else-if="store.openError">
              <p>这个视频打不开。</p>
              <p class="empty__hint">{{ store.openError }}</p>
              <el-button size="small" @click="store.select(store.activeRel)">重试</el-button>
            </template>
            <template v-else-if="activeNode?.kind === 'folder'">
              <p>「{{ activeNode.name }}」是文件夹。</p>
              <p class="empty__hint">在左栏里选中一个视频开始播放。</p>
            </template>
            <template v-else-if="activeNode">
              <!-- 选中的是视频却没在播：在画中画上点了「停止」回来就是这个样子 —— 给一次原地重播 -->
              <p>「{{ activeNode.name }}」没有在播放。</p>
              <el-button size="small" @click="store.select(store.activeRel)">播放</el-button>
            </template>
            <template v-else-if="!store.videoCount">
              <el-icon class="empty__icon"><VideoPlay /></el-icon>
              <p>这个文件夹里还没有 MP4 视频。</p>
              <p class="empty__hint">把视频放进来，点左栏底部那颗刷新。</p>
            </template>
            <template v-else>
              <el-icon class="empty__icon"><VideoPlay /></el-icon>
              <p>从左边选一个视频开始播放。</p>
              <p class="empty__hint">空格控制播放暂停，方向键快进快退与调倍速。</p>
            </template>
          </div>
        </div>

        <!-- 快捷键提示：只挂在「正播着」的时候 —— 没播视频时这些键一个都不生效 -->
        <footer v-if="store.active" class="video__keys">
          <span class="video__key"><kbd>空格</kbd>播放 / 暂停</span>
          <span class="video__key"
            ><kbd>←</kbd><kbd>→</kbd>快退 / 快进 {{ VIDEO_SEEK_SECONDS }} 秒</span
          >
          <span class="video__key"><kbd>↑</kbd><kbd>↓</kbd>播放速率</span>
        </footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.video {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

/**
 * 还没选文件夹时的整页引导：它同样是一张卡片，四周留白与别处同源 —— 左右与下边距取
 * `--card-gap`（设置里的「卡片间距」，与卡片墙、导航栏那张卡同一口径）。少了这一圈，
 * 这张卡会一直通到导航栏右缘与窗口底边，「没留白」就是这么来的。
 * **上边距必须是 0**：顶栏下面那条缝归 .shell 管（见 global.css），这里再补一份就比导航栏低一截。
 */
.video__intro {
  min-height: 0;
  margin: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/**
 * 左树右播放器。左栏宽度是 theme.json 里的 videoTreeWidth（经 --tree-w 挂进来，见
 * .video__side），两栏之间那条缝可以左右拖（分隔条因此需要 relative 定位）；
 * 播放器那一边吃掉剩余宽度。两栏各是一张卡片（.panel 那副外壳）；
 * **顶边一份不给自己加**：顶栏下面那条缝归 .shell 管（见 global.css），与首页同款。
 */
.video__body {
  position: relative;
  display: grid;
  /**
   * auto 列由左栏自己撑出宽度：拖缝改宽度与收起动画期间网格跟着每一帧重排，播放器
   * 就是在这 0.2s 里被让出来 / 收回去的（与 .shell 托管导航栏是同一套做法）。
   */
  grid-template-columns: auto minmax(0, 1fr);
  /**
   * 栏间留白挪到左栏的 margin-right 上，不用 grid 的 gap —— 收起时留白也要跟着收到 0，
   * gap 做不到（它不是左栏自己的属性，收成 0 宽后会剩一道 10px 的缝）。
   */
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

.video__side {
  display: flex;
  flex-direction: column;
  /* 宽度住在 theme.json（拖两栏之间那条缝改它）；收起收到 0 —— 见 is-collapsed */
  width: var(--tree-w, 264px);
  min-height: 0;
  margin-right: var(--card-gap, 10px);
  /**
   * 收起 / 展开的过渡（播放器头部那颗按钮 → theme.json 的 videoTreeCollapsed，见 is-collapsed）：
   * 宽、右留白、左右内边距与边框一起动。visibility 不占时长：展开方向立即生效，
   * 收起方向由 is-collapsed 里那条带延时的声明接管。
   */
  transition:
    width 0.2s var(--ease-out),
    margin-right 0.2s var(--ease-out),
    padding-left 0.2s var(--ease-out),
    padding-right 0.2s var(--ease-out),
    border-left-width 0.2s var(--ease-out),
    border-right-width 0.2s var(--ease-out),
    opacity 0.2s var(--ease-out),
    visibility 0s;
}

/** 收起不是卸载：这一栏过渡到 0 宽、淡出，内容原样留在内存里（展开态还在盘上） */
.video__side.is-collapsed {
  width: 0;
  margin-right: 0;
  padding-left: 0;
  padding-right: 0;
  border-left-width: 0;
  border-right-width: 0;
  opacity: 0;
  /* .panel 自带 overflow: hidden，收的过程中树与底部那行一起被裁掉，不会挤出来 */
  visibility: hidden;
  pointer-events: none;
  /* visibility 拖到动画走完再生效：淡出全程可见，收完之后里面的东西也不进 Tab 序 */
  transition:
    width 0.2s var(--ease-out),
    margin-right 0.2s var(--ease-out),
    padding-left 0.2s var(--ease-out),
    padding-right 0.2s var(--ease-out),
    border-left-width 0.2s var(--ease-out),
    border-right-width 0.2s var(--ease-out),
    opacity 0.2s var(--ease-out),
    visibility 0s 0.2s;
}

.video__error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

/* 拖动期间别让 0.2s 的宽度过渡跟手作对：每一帧都在改目标值，过渡只会让它拖泥带水 */
body.is-resizing-video-tree .video__side {
  transition: none;
}

.video__error-actions {
  display: flex;
  gap: var(--sp-2);
}

/* ---------- 右栏：播放器 ---------- */

.video__player {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/**
 * 标题行：名字 + 位置 + 速率，右栏的「页头」。
 *
 * 整行取**中线**对齐而不是 baseline：收起按钮与速率按钮是纯图标件，没有文字基线可依，
 * baseline 行里它们只能悬在文字下半空 —— 中线对齐一行里所有件（含两颗按钮）同心。
 */
.video__head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-shrink: 0;
  min-width: 0;
}

.video__title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.video__location {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  min-width: 0;
}

.video__spacer {
  flex: 1 1 auto;
}

/* 左栏收起 / 展开那颗按钮：头部已是中线对齐，跟着走即可 */
.video__tree-toggle {
  flex-shrink: 0;
  height: 24px;
  padding: 0 4px;
  margin-right: var(--sp-1);
}

/* 速率按钮：一枚安静的小徽章，不与标题抢注意力 */
.video__rate {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px var(--sp-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  font: inherit;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
  cursor: pointer;
}

.video__rate:hover {
  color: var(--ink);
  background: var(--bg-subtle);
}

.video__rate-caret {
  font-size: 10px;
}

.video__rate-item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-variant-numeric: tabular-nums;
}

.video__rate-check {
  font-size: 12px;
  color: var(--st-ok);
}

/**
 * 播放画布：始终深色（--term-* 那一族，与终端面板同一口径 —— 画布上只有它俩不跟明暗走）。
 * position: relative 是给视频的绝对定位当锚 —— 不依赖百分比高度的解析链路。
 */
.video__canvas {
  flex: 1 1 auto;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  margin-top: var(--sp-2);
  border-radius: var(--r-md);
  background: var(--term-bg);
  overflow: hidden;
}

/**
 * 传送宿主：播放器本体（VideoPlayer）在视频页时的落位。
 * 铺满画布、平时**不接事件** —— 空态提示与它的按钮都在同一层画布上，
 * 宿主空着时不能把点击挡掉；播放器传送进来后由它自己把 pointer-events 要回去。
 */
.video__stage {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 空态与提示：居中占满画布，与别处的 .empty 同一副样子（字色用终端那族的浅灰，画布是深色的） */
.video__hint {
  color: var(--term-ink);
}

.video__hint .empty__icon,
.video__hint .empty__hint {
  color: var(--term-dim);
}

/* 快捷键提示：一行小字钉在画布下面，正播着的时候才出现 */
.video__keys {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding-top: var(--sp-2);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.video__key {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.video__key kbd {
  display: inline-block;
  min-width: 18px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  font-family: inherit;
  font-size: var(--fs-micro);
  line-height: 16px;
  text-align: center;
  color: var(--ink-2);
}
</style>
