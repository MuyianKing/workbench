<script setup lang="ts">
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
import { computed } from 'vue'
import type { Component } from 'vue'
import { Notebook, FolderOpened, Grid, Document, MagicStick, Key, Brush } from '@element-plus/icons-vue'
import { VIEW_LABELS, visibleViews, type ViewId } from '@shared/views'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

const store = useProjectsStore()
const settings = useSettingsStore()

/** 每个页面一个图标；新增页面时这里会因缺 key 而报类型错，不会漏配 */
const ICONS: Record<ViewId, Component> = {
  home: Grid,
  projects: FolderOpened,
  work: Notebook,
  notes: Document,
  skills: MagicStick,
  vault: Key,
  styles: Brush
}

const active = computed(() => store.activeView)

/**
 * 显示哪几项由设置里的「导航菜单」决定（关掉的页整项不出现，见 shared/views.ts）。
 * 顺序永远是 VIEW_IDS 的顺序：关掉哪几项不影响剩下几项的先后。
 */
const items = computed(() => visibleViews(settings.settings.hiddenViews))

function select(id: ViewId): void {
  // 换页不动弹层：开着的弹框留在原地，切走再切回来还是它，填到一半的输入不丢。
  // 所以导航栏必须浮在遮罩之上（见样式里那个 z-index）—— 否则弹层开着时这一列点不着，
  // 用户只能先关掉弹框才能换页。
  void store.setActiveView(id)
}
</script>

<template>
  <nav class="nav">
    <button
      v-for="id in items"
      :key="id"
      class="nav__item"
      :class="{ 'is-active': active === id }"
      type="button"
      :title="VIEW_LABELS[id]"
      :aria-current="active === id ? 'page' : undefined"
      @click="select(id)"
    >
      <el-icon class="nav__icon"><component :is="ICONS[id]" /></el-icon>
      <span class="nav__label">{{ VIEW_LABELS[id] }}</span>
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
  overflow-y: auto;
  /**
   * 抬到所有弹层之上：弹层（el-dialog / el-drawer）的遮罩铺满整窗，弹层开着时
   * 这一列原本点不着 —— 而换页是最常用的动作，不该被一个开着的弹框锁住
   * （换页不会收掉弹层，见 select()）。
   *
   * 层级取 int32 的上限：Element Plus 弹层的 z-index 是 2000 起步、每开一个弹层 +1 的
   * 动态值（hooks/use-z-index），写一个「比 2000 大」的常数迟早会被它追平，只有上限追不上。
   * 代价是弹层宽到压住这一列时（窄窗口下的技能详情弹窗）导航栏盖在它上面 —— 那一列本来
   * 就是导航栏的地盘，比反过来（点不到菜单）好。
   */
  position: relative;
  z-index: 2147483647;
  /* 左 / 下留白与卡片间距同源（顶边那一份由 .shell 按顶部样式给，见 global.css），右边靠内容列自己的内边距让开 */
  margin: 0 0 var(--card-gap, 10px) var(--card-gap, 10px);
  padding: 8px;
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  user-select: none;
}

.nav__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 54px;
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

/* 当前项用 --bg-selected：它比面底色明确高一档，一眼看得出现在在哪一屏 */
.nav__item.is-active {
  background: var(--bg-selected);
  color: var(--ink);
  font-weight: 600;
}

.nav__icon {
  font-size: 17px;
}

.nav__label {
  line-height: 1;
}
</style>
