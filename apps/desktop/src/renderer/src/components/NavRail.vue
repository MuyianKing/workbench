<script setup lang="ts">
import type { ViewId } from '@workbench/appearance'
import type { Component, CSSProperties } from 'vue'
import { Brush, ChatDotRound, Collection, Connection, Cpu, Document, FolderOpened, Grid, Key, MagicStick, Message, Notebook, TrendCharts, VideoPlay } from '@element-plus/icons-vue'
import { orderedViews } from '@workbench/appearance'
/**
 * 左侧导航栏：应用的一级页面都挂在这里。
 *
 * 换页不用路由（项目不引入 Vue Router）：点一下就是把 store 里的 activeView 换掉，
 * App.vue 用 <KeepAlive><component :is> 渲染对应页面，所以这里没有任何"跳转"逻辑。
 *
 * 它从顶栏（标题栏 + 欢迎语）下沿起，做成一张卡片浮在画布上 —— 和首页那些面板同一副外壳，
 * 四周留出与卡片之间一致的间距。这里不加 data-tauri-drag-region：它和面板一样是画布上的卡片，
 * 拖窗口是标题栏的事（在面板上按空白处也不会拖窗口，两边保持一致）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useNavStore } from '@/stores/nav'
import { useSettingsStore } from '@/stores/settings'

const store = useNavStore()
const settings = useSettingsStore()

/** 每个页面一个图标；新增页面时这里会因缺 key 而报类型错，不会漏配 */
const ICONS: Record<ViewId, Component> = {
  home: Grid,
  projects: FolderOpened,
  work: Notebook,
  notes: Document,
  skills: MagicStick,
  kb: Collection,
  ai: ChatDotRound,
  gateway: Connection,
  qoder: Cpu,
  vault: Key,
  mail: Message,
  styles: Brush,
  video: VideoPlay,
  etf: TrendCharts,
}

const active = computed(() => store.activeView)

/**
 * 显示哪几项、按什么先后，都由设置里的「菜单」决定（关掉的页整项不出现，
 * 顺序是用户在设置里拖出来的，见 packages/appearance/src/views.ts 的 orderedViews）。
 */
const items = computed(() =>
  orderedViews(settings.settings.hiddenViews, settings.settings.viewOrder),
)

const navEl = ref<HTMLElement | null>(null)

/**
 * 当前项那块底由 .nav__pill 一块浮底承担：换页时它滑过去，而不是老项闪一下、新项亮一下。
 *
 * 位置与尺寸按当前项那个盒量出来（横向也量：收起 / 展开动画里内容盒的宽每帧都在变）。
 * 量不到当前项（它被设置关掉了）就先藏起来 —— 那时本来也没有「当前项」。
 * 初值是 opacity 0：首帧量完就位了才显出来，加载时不会从顶上滑下来。
 */
const itemEls = new Map<ViewId, HTMLElement>()
const pillStyle = ref<CSSProperties>({ opacity: 0 })

function bindItem(el: unknown, id: ViewId): void {
  if (el instanceof HTMLElement)
    itemEls.set(id, el)
  else itemEls.delete(id) // 这一项被卸载（关掉 / 换顺序）时把旧的清掉
}

function movePill(): void {
  const el = itemEls.get(active.value)
  if (!el) {
    pillStyle.value = { opacity: 0 }
    return
  }
  pillStyle.value = {
    opacity: 1,
    left: `${el.offsetLeft}px`,
    width: `${el.offsetWidth}px`,
    height: `${el.offsetHeight}px`,
    transform: `translateY(${el.offsetTop}px)`,
  }
}

/**
 * 悬浮滚动条：原生滚动条整个不画（.nav__scroll 的 scrollbar-width: none，槽不占宽），
 * 一条细滑块自己画、盖在卡片内缘 —— 位置与长短按滚动区的盒子量，鼠标进了导航栏才现形。
 */
const scrollEl = ref<HTMLElement | null>(null)
const thumbEl = ref<HTMLElement | null>(null)
const scrollable = ref(false)
const thumbStyle = ref<CSSProperties>({})
const dragging = ref(false)

/** 滑块再短也保 32px：太短捏不住 */
const THUMB_MIN = 32

function measureThumb(): void {
  const sc = scrollEl.value
  if (!sc) {
    scrollable.value = false
    return
  }
  scrollable.value = sc.scrollHeight - sc.clientHeight > 1
  if (!scrollable.value)
    return
  thumbStyle.value = {
    height: `${Math.max((sc.clientHeight / sc.scrollHeight) * sc.clientHeight, THUMB_MIN)}px`,
    transform: `translateY(${(sc.scrollTop / sc.scrollHeight) * sc.clientHeight}px)`,
  }
}

/** 拖滑块 ≈ 拖内容：滑块在轨道里的行程对上滚动全程，按比例折算 */
let dragStartY = 0
let dragStartScroll = 0
let dragScale = 1

function onThumbDown(e: PointerEvent): void {
  const sc = scrollEl.value
  const thumb = thumbEl.value
  if (!sc || !thumb)
    return
  e.preventDefault()
  dragStartY = e.clientY
  dragStartScroll = sc.scrollTop
  dragScale = (sc.scrollHeight - sc.clientHeight) / Math.max(sc.clientHeight - thumb.offsetHeight, 1)
  dragging.value = true
  thumb.setPointerCapture(e.pointerId)
}

function onThumbMove(e: PointerEvent): void {
  const sc = scrollEl.value
  if (!sc || !dragging.value)
    return
  sc.scrollTop = dragStartScroll + (e.clientY - dragStartY) * dragScale
}

function onThumbUp(e: PointerEvent): void {
  if (!dragging.value)
    return
  dragging.value = false
  thumbEl.value?.releasePointerCapture(e.pointerId)
}

/**
 * 收起 / 展开那 0.2s 里内容盒每帧都在变，窗口拉高拉矮也会改滚动区的盒子 ——
 * 让 ResizeObserver 盯着导航栏自己，浮底与悬浮滑块一起重算，比在几个入口各算一次稳。
 */
let resizeObserver: ResizeObserver | undefined

onMounted(() => {
  movePill()
  measureThumb()
  resizeObserver = new ResizeObserver(() => {
    movePill()
    measureThumb()
  })
  if (navEl.value)
    resizeObserver.observe(navEl.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

/** 换页、以及菜单本身被改（关掉一页 / 拖动换序）都要重新对位、重估能否滚动：等 DOM 落定再量 */
watch([active, items], () => {
  movePill()
  measureThumb()
}, { flush: 'post' })

function select(id: ViewId): void {
  // 换页不动弹层：开着的弹框留在原地，切走再切回来还是它，填到一半的输入不丢。
  // 所以导航栏必须浮在遮罩之上（见样式里那个 z-index）—— 否则弹层开着时这一列点不着，
  // 用户只能先关掉弹框才能换页。
  void store.setActiveView(id)
}
</script>

<template>
  <nav ref="navEl" class="nav" :class="{ 'is-hidden': settings.settings.navHidden }">
    <!-- 滚动区：菜单比卡片高时在这一层滚；浮底的定位基准就是它，跟着内容一起滚 -->
    <div ref="scrollEl" class="nav__scroll" @scroll.passive="measureThumb">
      <!-- 当前项那块底：绝对定位的一块浮底，换页时滑到下一项去。它排在按钮前面、又比按钮低一层
           （见样式），滑过中间几项时不会盖住图标与文字 -->
      <span class="nav__pill" aria-hidden="true" :style="pillStyle" />
      <button
        v-for="id in items"
        :key="id"
        :ref="(el) => bindItem(el, id)"
        class="nav__item"
        :class="{ 'is-active': active === id }"
        type="button"
        :title="settings.viewLabelOf(id)"
        :aria-current="active === id ? 'page' : undefined"
        @click="select(id)"
      >
        <el-icon class="nav__icon">
          <component :is="ICONS[id]" />
        </el-icon>
        <span class="nav__label">{{ settings.viewLabelOf(id) }}</span>
      </button>
    </div>
    <!-- 悬浮滚动条：画在卡片内缘的 8px 内边距里，不占内容宽度、碰不到按钮的点击区；
         平时藏起来，鼠标进了导航栏才现形（样式），拖拽期间指针滑出去也保持可见 -->
    <span
      v-show="scrollable"
      ref="thumbEl"
      class="nav__thumb"
      :class="{ 'is-dragging': dragging }"
      aria-hidden="true"
      :style="thumbStyle"
      @pointerdown="onThumbDown"
      @pointermove="onThumbMove"
      @pointerup="onThumbUp"
      @pointercancel="onThumbUp"
    />
  </nav>
</template>

<style scoped>
/**
 * 导航栏是一张卡片，和首页那些面板同一副外壳：底色浓度跟着设置里的「卡片不透明度」走、
 * 同样的圆角与投影，四周留出与卡片之间一致的间距，浮在壁纸上。
 * 纵向铺满可用高度（顶栏下沿 → 窗口底），菜单多起来时在卡片内部滚动。
 */
.nav {
  display: flex;
  flex-direction: column;
  width: var(--w-nav);
  min-height: 0;
  /* 滚动职责在 .nav__scroll：这一层只管把超出圆角的部分裁掉 */
  overflow: hidden;
  /**
   * 抬到所有弹层之上：弹层（el-dialog / el-drawer）的遮罩铺满整窗，弹层开着时
   * 这一列原本点不着 —— 而换页是最常用的动作，不该被一个开着的弹框锁住
   * （换页不会收掉弹层，见 select()）。
   *
   * 层级取 int32 的上限：Element Plus 弹层的 z-index 是 2000 起步、每开一个弹层 +1 的
   * 动态值（hooks/use-z-index），写一个「比 2000 大」的常数迟早会被它追平，只有上限追不上。
   * **盖住的只是遮罩，不是弹框**：弹框那边按 --dialog-inset 让开了这一列
   * （global.css 的 .el-dialog 封了最大宽度）—— 那一列是导航栏的地盘，弹框不许爬进来。
   */
  position: relative;
  z-index: 2147483647;
  /* 左 / 下留白与卡片间距同源（顶边那一份由 .shell 按顶部样式给，见 global.css），右边靠内容列自己的内边距让开 */
  margin: 0 0 var(--card-gap, 10px) var(--card-gap, 10px);
  padding: 8px;
  /* 底色跟「卡片不透明度」、磨砂与上沿高光取 tokens 那一套玻璃（与 .panel / 项目卡同一条规矩） */
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
  /* 四周那条线归设置里的「毛玻璃描边」（默认不画） */
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  user-select: none;
  /**
   * 收起 / 展开的过渡（顶栏折叠按钮 → 设置里的 navHidden，见 is-hidden）：
   * 宽、左留白、左右内边距与边框一起动，.shell 的 auto 列跟着每一帧重排，
   * 内容列就是在这 0.2s 里被让出来 / 收回去的。visibility 不占时长：
   * 展开方向立即生效，收起方向由 is-hidden 里那条带延时的声明接管。
   */
  --nav-inner: calc(var(--w-nav) - 16px - 2px); /* 内容盒宽：减去左右 padding(8×2) 与边框(1×2) */
  transition:
    width 0.2s var(--ease-out),
    margin-left 0.2s var(--ease-out),
    padding-left 0.2s var(--ease-out),
    padding-right 0.2s var(--ease-out),
    border-left-width 0.2s var(--ease-out),
    border-right-width 0.2s var(--ease-out),
    opacity 0.2s var(--ease-out),
    visibility 0s;
}

/**
 * 收起态：全部盒子尺寸归零（border-box 下宽 < padding + 边框时外尺寸由后者兜底，
 * 所以四项一起过渡才不会在收尾时蹦一下），到最后外壳一点不占 —— 不用卸载、没有跳变。
 */
.nav.is-hidden {
  width: 0;
  margin-left: 0;
  padding-left: 0;
  padding-right: 0;
  border-left-width: 0;
  border-right-width: 0;
  opacity: 0;
  /* 收的过程连纵向滚动条一起去掉；展开时回到 auto，菜单长出来才滚 */
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
  /* visibility 拖到动画走完再生效：淡出全程可见，收完之后按钮也不进 Tab 序 */
  transition:
    width 0.2s var(--ease-out),
    margin-left 0.2s var(--ease-out),
    padding-left 0.2s var(--ease-out),
    padding-right 0.2s var(--ease-out),
    border-left-width 0.2s var(--ease-out),
    border-right-width 0.2s var(--ease-out),
    opacity 0.2s var(--ease-out),
    visibility 0s 0.2s;
}

/**
 * 滚动区：真正的滚动发生在这一层。min-height: 0 是可滚的关键 —— flex 列的子元素默认
 * 不肯矮过自己的内容，不减这条整个卡片会被菜单顶出窗外。原生滚动条整个不画
 * （scrollbar-width: none）：槽不占宽（与首页项目卡同一条规矩），滚动条由 .nav__thumb 自己画。
 * position: relative 给 .nav__pill 当定位基准：浮底随内容一起滚，才一直贴在当前项上。
 */
.nav__scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  /* 收起动画期间按钮比内容盒宽：横向一律裁掉 */
  overflow-x: hidden;
  scrollbar-width: none;
}

.nav__scroll::-webkit-scrollbar {
  display: none;
}

/**
 * 当前项那块底：一块浮底，位置与尺寸由脚本按当前项的盒给（见 movePill），
 * 换页时靠 transform 滑过去 —— 位移只走合成，滑的过程中不触发布局。
 * 它比按钮低一层（按钮 position: relative + z-index 1），滑过中间几项时压在图标与文字下面；
 * 高度理论上一直不变，留一条过渡是防着将来项高变了它跟不上。
 *
 * 底色取主色的**浅底**（`--el-color-primary-light-7`：亮色往白里混七成、暗色往画布色里混七成），
 * 比列表选中行那档（`--bg-selected`，五成）更淡一档 —— 导航栏是一列紧凑的方块，
 * 深一档会整块盖过图标与文字本身。**不铺主色实心**：那档要配白字才读得清，
 * 而实心块在这条竖列里比分段控件里的小药丸重得多。
 * 字与图标取 `--ink`（见 .nav__item.is-active）：浅底上压白字读不清（半亮的那档绿上白字只剩 2.6:1），
 * 也不跟主色走 —— 同色系浅底配同色系深字，整块会糊成一片（项目标签那边同一条规矩）。
 */
.nav__pill {
  position: absolute;
  top: 0;
  z-index: 0;
  border-radius: var(--r-md);
  background: var(--el-color-primary-light-7);
  pointer-events: none;
  transition:
    transform 0.24s var(--ease-out),
    height 0.24s var(--ease-out);
}

/**
 * 悬浮滚动条：一条细滑块画在卡片内缘的 8px 内边距里（不占内容宽度、碰不到按钮的点击区），
 * 位置与长短由脚本按滚动区量（见 measureThumb）。平时藏起来、鼠标进了导航栏才现形，
 * 拖拽期间指针滑出也保持可见。颜色与全局滚动条同一档（global.css「滚动条」一节）。
 */
.nav__thumb {
  position: absolute;
  top: 0;
  right: 3px;
  z-index: 1;
  width: 4px;
  border-radius: var(--r-pill);
  background: rgba(17, 21, 27, 0.16);
  opacity: 0;
  transition: opacity 0.15s var(--ease-out);
}

.nav:hover .nav__thumb,
.nav__thumb.is-dragging {
  opacity: 1;
}

/* 拖着走的时候颜色再深一档，对齐全局滚动条「直接停在滑块上」那一档 */
.nav__thumb.is-dragging {
  background: rgba(17, 21, 27, 0.3);
}

/* 暗色主题反色，否则深底上看不见（与 global.css 同一档） */
:root[data-theme='dark'] .nav__thumb {
  background: rgba(232, 237, 244, 0.18);
}

:root[data-theme='dark'] .nav__thumb.is-dragging {
  background: rgba(232, 237, 244, 0.32);
}

.nav__item {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 54px;
  /* 菜单比卡片高时按钮不许被压矮：超出的交给 .nav__scroll 滚（默认的 flex-shrink 会压扁它） */
  flex-shrink: 0;
  /* 平时被拉伸撑满内容盒；收起动画里内容盒一路缩到 0，钉住下限按钮才不会被挤到换行
     （超出部分由 .nav 的 overflow-x 裁掉） */
  min-width: var(--nav-inner);
  padding: 0;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink-2);
  font-size: 11.5px;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

/* 悬停用 --bg-inset：卡片上的悬停，项目里其余卡片上的按钮也是这一档 */
.nav__item:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

/* 当前项不用自己画底 —— 那块底在 .nav__pill 上（同一颜色，只是会滑）；
   这里留着 background: transparent 是为了压住上面那条 :hover：悬停当前项不该换成悬停色。
   图标与文字取 --ink（不取 --el-color-white，也不取 --ink-accent）：
   那块底是主色的浅底，压白字读不清，跟主色走又会与底色同色系、整块糊成一片。
   加粗那一档负责「现在在哪一屏」的第二条线索（与底色一起，壁纸再亮也认得出）。 */
.nav__item.is-active {
  background: transparent;
  color: var(--ink);
  font-weight: 600;
}

.nav__icon {
  font-size: 17px;
}

.nav__label {
  line-height: 1;
}

@media (prefers-reduced-motion: reduce) {
  .nav__pill,
  .nav__thumb {
    transition: none;
  }
}
</style>
