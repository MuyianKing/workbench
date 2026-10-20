<script setup lang="ts">
import type { ViewId } from '@workbench/appearance'
import type { Component, CSSProperties } from 'vue'
import { Brush, ChatDotRound, Collection, Connection, Document, FolderOpened, Grid, Key, MagicStick, Message, Notebook, VideoPlay } from '@element-plus/icons-vue'
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
  vault: Key,
  mail: Message,
  styles: Brush,
  video: VideoPlay,
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
 * 位置与尺寸按当前项那个盒量出来（横向也量）：菜单长到出滚动条时内容盒会窄一点，
 * 写死内边距就对不上了。量不到当前项（它被设置关掉了）就先藏起来 —— 那时本来也没有「当前项」。
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
 * 收起 / 展开那 0.2s 里内容盒每帧都在变，窗口尺寸变了也可能冒出一条滚动条 ——
 * 让 ResizeObserver 盯着导航栏自己重算，比在几个入口各算一次稳。
 */
let resizeObserver: ResizeObserver | undefined

onMounted(() => {
  movePill()
  resizeObserver = new ResizeObserver(movePill)
  if (navEl.value)
    resizeObserver.observe(navEl.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

/** 换页、以及菜单本身被改（关掉一页 / 拖动换序）都要重新对位：等 DOM 落定再量 */
watch([active, items], movePill, { flush: 'post' })

function select(id: ViewId): void {
  // 换页不动弹层：开着的弹框留在原地，切走再切回来还是它，填到一半的输入不丢。
  // 所以导航栏必须浮在遮罩之上（见样式里那个 z-index）—— 否则弹层开着时这一列点不着，
  // 用户只能先关掉弹框才能换页。
  void store.setActiveView(id)
}
</script>

<template>
  <nav ref="navEl" class="nav" :class="{ 'is-hidden': settings.settings.navHidden }">
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
  gap: 2px;
  width: var(--w-nav);
  min-height: 0;
  /* 收起动画期间按钮比内容盒宽：横向一律裁掉，竖向照旧在卡片内滚动 */
  overflow-y: auto;
  overflow-x: hidden;
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
 * 当前项那块底：一块浮底，位置与尺寸由脚本按当前项的盒给（见 movePill），
 * 换页时靠 transform 滑过去 —— 位移只走合成，滑的过程中不触发布局。
 * 它比按钮低一层（按钮 position: relative + z-index 1），滑过中间几项时压在图标与文字下面；
 * 高度理论上一直不变，留一条过渡是防着将来项高变了它跟不上。
 */
.nav__pill {
  position: absolute;
  top: 0;
  z-index: 0;
  border-radius: var(--r-md);
  background: var(--bg-selected);
  pointer-events: none;
  transition:
    transform 0.24s var(--ease-out),
    height 0.24s var(--ease-out);
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
   图标与文字取 --ink-accent：主色按对比度推到 4.5:1 的那一档（没配主题色时就是 --ink）。
   只靠那块底不够 —— 导航栏是半透的毛玻璃，浅色壁纸透上来时底色的明暗差会被吃得很薄，
   字与图标的颜色差才是「现在在哪一屏」最稳的那条线索（与邮箱清单里正在读的那封同一套）。 */
.nav__item.is-active {
  background: transparent;
  color: var(--ink-accent);
  font-weight: 600;
}

.nav__icon {
  font-size: 17px;
}

.nav__label {
  line-height: 1;
}

@media (prefers-reduced-motion: reduce) {
  .nav__pill {
    transition: none;
  }
}
</style>
