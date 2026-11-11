<!--
  播完接下去的倒计时浮层（压暗层 + 卡片）。

  两处共用：主窗口的播放器（内嵌画布 / 悬浮小窗）与独立视频窗口。卡片按**画布尺寸**
  分两档（`@container` 以最近的 `container-type: size` 祖先为界，两个宿主都把自己
  的画布声明成尺寸容器）：大画布走「大气」那版，窄于 400 或矮于 240 换紧凑版 ——
  默认悬浮窗 320×180 与最小的 240×135 都落在紧凑那档。
-->
<script setup lang="ts">
import { VIDEO_NEXT_SECONDS } from '@workbench/video'

defineProps<{
  /** 下一个视频的显示名 */
  name: string
  /** 倒计时还剩几秒（父级的计时器在动） */
  seconds: number
}>()

const emit = defineEmits<{
  play: []
  cancel: []
}>()
</script>

<template>
  <div class="vplayer__next" role="status">
    <div class="vplayer__next-card">
      <div class="vplayer__next-head">
        <span class="vplayer__next-label">即将进入下一个视频</span>
        <span class="vplayer__next-left">{{ seconds }} 秒后自动播放</span>
      </div>
      <p class="vplayer__next-name" :title="name">
        {{ name }}
      </p>
      <div class="vplayer__next-actions">
        <el-button type="primary" @click="emit('play')">
          立即播放
        </el-button>
        <el-button text @click="emit('cancel')">
          取消
        </el-button>
      </div>
      <span class="vplayer__next-bar" :style="{ animationDuration: `${VIDEO_NEXT_SECONDS}s` }" />
    </div>
  </div>
</template>

<style scoped>
/**
 * 两块：铺满画布的一层压暗 + 居中的卡片。
 *
 * 压暗这一层是「一眼看得见」的来源：视频停在最后一帧时画面往往还亮着，卡片直接贴上去
 * 会糊在画面里；先把画面压下去，卡片才立得起来 —— 一块实底 + 一级阴影在压暗的画面上
 * 是一层清清楚楚的浮层。
 *
 * **这一层不接事件**（pointer-events: none，卡片自己再把事件要回来）：下面的原生控件
 * 照常能点 —— 点重播 / 拖进度条是「用户接手了」的信号（见 `<video>` 上的 play / seeking），
 * 遮罩拦下来的话这两条出口就断了。
 *
 * 居中用「容器 margin: auto」而不是 align-items: center：悬浮小窗最小只有 240×135
 * （画布剩一百来像素高），卡片装不下时 align-items: center 会把上下两头一起切掉；
 * margin: auto 至少把标签与名字留在看得见的上沿。滚动条不画（指针压根进不来）。
 * 四周留出 --sp-4：大画布上卡片不该贴着画面边缘；小窗那一档在 @container 里收回去。
 */
.vplayer__next {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  padding: var(--sp-4);
  background: color-mix(in srgb, var(--term-bg) 68%, transparent);
  overflow: auto;
  scrollbar-width: none;
  pointer-events: none;
  animation: vplayer-next-veil 0.15s ease-out;
}

.vplayer__next::-webkit-scrollbar {
  display: none;
}

/**
 * 卡片本身：三行 + 底缘一条进度线。**分两档疏密**（紧凑那档见下面的 @container）：
 * 大画布上走这一版 —— 460px 宽、四周 20px、名字 19px 可占两行、按钮用 EP 默认尺寸，
 * 一片空画布上要立得住；悬浮小窗（尤其压到 240×135、画布只剩一百来像素高）走紧凑那档，
 * 行距与内边距都卡着最小的小窗给，否则底缘那条进度线会先被切掉。
 * 内容一律左对齐 —— 居中的三行在窄卡片里会显得散（同一句话在宽窄两种窗口下都要收得住）。
 */
.vplayer__next-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: min(460px, 100%);
  margin: auto;
  padding: var(--sp-5);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  pointer-events: auto;
  animation: vplayer-next-in 0.18s ease-out;
}

/* 进度线的底槽：极淡的一条痕，让那条进行色的线读起来是「走了多久」而不是一条下划线 */
.vplayer__next-card::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--st-run-soft);
}

/* 头一行：左边说「接下来是什么事」，右边那枚小徽章是那个一直在动的数字 ——
   秒数靠右单成一块（margin-left: auto），两句话不再挤在一起，窄卡片上先让左边截断 */
.vplayer__next-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.vplayer__next-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

/* 秒数：倒计时是这个浮层里唯一「在动」的东西，用进行色（--st-run）标出来 */
.vplayer__next-left {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px var(--sp-2);
  font-size: var(--fs-meta);
  font-weight: 600;
  line-height: 1.5;
  color: var(--st-run);
  background: var(--st-run-soft);
  border-radius: var(--r-pill);
  font-variant-numeric: tabular-nums;
}

/**
 * 名字：大画布上最多两行 —— 视频名常常一长串，单行截断在大卡片里只剩半句话；
 * 紧凑那一档回到单行（那里高度经不起两行，见下面的 @container）。
 */
.vplayer__next-name {
  margin: 0;
  max-width: 100%;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  line-height: 1.4;
  font-size: var(--fs-display);
  font-weight: 600;
  color: var(--ink);
}

/* 两颗按钮：主动作是实底那颗，「取消」退成纯文字（同 MailView 挑信那一排）——
   两个同重的方框并排会显得吵。大画布上按钮用 EP 默认尺寸（32px 高、13px 字），
   「立即播放」再宽一档，它才是这张卡片的重心 */
.vplayer__next-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.vplayer__next-actions .el-button--primary {
  min-width: 104px;
}

/* EP 会在相邻按钮之间再垫 12px 的 margin-left，与上面那道 gap 叠起来把两颗推得太开；
   间距统一交给 gap —— 「取消」自带内边距，加起来正好是看得惯的一段留白 */
.vplayer__next-actions .el-button + .el-button {
  margin-left: 0;
}

/**
 * 小窗那一档：画布窄于 400 或矮于 240 时换回紧凑版 —— 默认悬浮窗 320×180 与最小的
 * 240×135 都落在这里，只有内嵌页那种大画布才走上面那一版。标签与秒数回到 micro、
 * 名字收成单行、按钮回到 24px 高；这组数是照「画布最矮只剩一百来像素」配的。
 */
@container (max-width: 399px) or (max-height: 239px) {
  .vplayer__next {
    padding: var(--sp-1);
  }

  .vplayer__next-card {
    gap: var(--sp-2);
    width: min(340px, 100%);
    padding: var(--sp-2) var(--sp-3) var(--sp-3);
    border-radius: var(--r-md);
  }

  .vplayer__next-label,
  .vplayer__next-left {
    font-size: var(--fs-micro);
  }

  .vplayer__next-left {
    padding: 0 var(--sp-1);
    line-height: normal;
  }

  .vplayer__next-name {
    display: block;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-title);
    line-height: 1.35;
  }

  .vplayer__next-actions {
    gap: var(--sp-2);
  }

  .vplayer__next-actions .el-button {
    height: 24px;
    padding: 0 11px;
    font-size: var(--fs-meta);
  }

  .vplayer__next-actions .el-button--primary {
    min-width: 0;
  }
}

/**
 * 底缘那条进度线：照 VIDEO_NEXT_SECONDS 秒**从左往右拉满**（时长由模板按常量绑定）——
 * 进度就是「离自动播放还有多久」，走完就切下一个。底下压着卡片 ::before 那一条底槽。
 */
.vplayer__next-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--st-run);
  transform-origin: left;
  animation-name: vplayer-next-fill;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes vplayer-next-fill {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}

/* 压暗层淡入、卡片轻轻上浮一下：这一下是用来把视线叫过来的 */
@keyframes vplayer-next-veil {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes vplayer-next-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
