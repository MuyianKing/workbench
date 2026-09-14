<script setup lang="ts">
/**
 * 自定义标题栏：左侧品牌 + 右侧自绘的窗口按钮。
 *
 * 窗口用 decorations: false 建出来（见 src-tauri/src/main.rs），没有原生标题栏也没有叠加层，
 * 系统不会再画右上角那三个按钮，整条标题栏都是我们的画布 —— 这样顶栏的底色、层次
 * 才能跟壁纸方案一起改（叠加层那块区域 DOM 进不去、也模糊不了）。
 *
 * 图标按 Windows 的规格手画（10px 见方、1px 细线）：Element Plus 的图标是观感完全不同的
 * 另一套（更粗的笔画、圆角端点），而且没有「最大化 / 还原」这种方框字形，混着用就不像系统控件了。
 *
 * 拖动与双击最大化都归 Tauri：带 data-tauri-drag-region 的元素由框架注入的脚本接管，
 * 它在 mousedown 里按 e.detail 分流 —— 1 开始拖动，2 最大化 / 还原（源码见 tauri 的
 * window/scripts/drag.js）。所以这里**不要**再写 @dblclick 自己 toggle：两边各切一次正好
 * 抵消，表现成双击标题栏毫无反应。拖动那条命令要 ACL 放行 core:window:allow-start-dragging
 * （见 src-tauri/capabilities/default.json），漏了就变成「按住标题栏没反应、控制台也不报错」。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()
/** 模板里拿不到 window，先把白名单 API 取出来给模板用 */
const api = window.workbench

/** 已最大化时第三个按钮要画成「还原」；状态由主进程推来，按钮自己不去猜 */
const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(() => {
  // 先订阅再问一次当前值：订阅在前，不会漏掉挂载瞬间发生的最大化
  unsubscribe = window.workbench.onWindowState((state) => {
    maximized.value = state.maximized
  })
  void window.workbench.getWindowState().then((state) => {
    maximized.value = state.maximized
  })
})

onUnmounted(() => unsubscribe?.())
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <span class="titlebar__mark mono" aria-hidden="true" data-tauri-drag-region>&rsaquo;_</span>
    <span class="titlebar__name mono" data-tauri-drag-region>{{ store.settings.appName }}</span>

    <div class="wctl">
      <button
        class="wctl__btn"
        type="button"
        title="最小化"
        aria-label="最小化"
        @click="api.minimizeWindow()"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" />
        </svg>
      </button>

      <button
        class="wctl__btn"
        type="button"
        :title="maximized ? '向下还原' : '最大化'"
        :aria-label="maximized ? '向下还原' : '最大化'"
        @click="api.toggleMaximizeWindow()"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <!-- 还原：后窗只画上边与右边，露出被前窗压住的部分 -->
          <template v-if="maximized">
            <path d="M2.5 0.5h7v7" />
            <path d="M0.5 2.5h7v7h-7z" />
          </template>
          <rect v-else x="0.5" y="0.5" width="9" height="9" />
        </svg>
      </button>

      <button
        class="wctl__btn"
        type="button"
        title="关闭（收进托盘）"
        aria-label="关闭"
        @click="api.closeWindow()"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--h-titlebar);
  /* 右侧不留内边距：三个窗口按钮要顶到窗口右上角，和原生控件的位置一致 */
  padding-left: var(--sp-5);
  background: var(--bg-canvas);
  /* 整条都能拖动窗口（拖动标记在模板的 data-tauri-drag-region 上）；
     右上角那三个按钮在 .wctl 里，Tauri 不会给非拖动区元素起拖 */
  user-select: none;
}

.titlebar__mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--ink);
  color: var(--ink-inverse);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -0.06em;
  padding-bottom: 1px;
}

.titlebar__name {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--ink-2);
}

/* ---------- 窗口按钮 ---------- */

.wctl {
  display: flex;
  align-self: stretch;
  margin-left: auto;
}

.wctl__btn {
  display: grid;
  place-items: center;
  /* Windows 11 的窗口按钮就是 46 宽、与标题栏同高 */
  width: 46px;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-2);
  /* 标题栏按钮在系统里是默认箭头，不是手型 */
  cursor: default;
  transition: background 0.12s ease, color 0.12s ease;
}

.wctl__btn:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

.wctl__btn:active {
  background: var(--border-strong);
}

/* 顶到窗口边，全局那圈 outline 会顶出去被裁掉，改成都往内缩 */
.wctl__btn:focus-visible {
  outline-offset: -2px;
}

.wctl__btn svg {
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
}
</style>
