<!--
  视频的深色手柄栏：视频名 + 倍速 + 置顶（仅独立窗口）+ 回到视频页 + 停止。

  两处共用（悬浮小窗与独立视频窗口）：
    - 悬浮小窗：父级挂 `@pointerdown` 自己搬元素（use-pointer-drag），不传 nativeDrag；
    - 独立窗口：传 nativeDrag，栏与名字上挂 `data-tauri-drag-region`，由系统搬整扇窗口
      （双击最大化、拖边贴靠也走系统那一套）。

  栏上的按钮都 `pointerdown.stop`：别让按按钮变成拖窗口。置顶只有独立窗口给
  （悬浮小窗本来就浮在应用里，没有「置顶」这回事）。
-->
<script setup lang="ts">
import { Close, Monitor } from '@element-plus/icons-vue'
import { nextTick, ref } from 'vue'
import VideoRateMenu from '@/components/VideoRateMenu.vue'

defineProps<{
  name: string
  rate: number
  /** 原生拖动（独立窗口）：给手柄条与名字挂 data-tauri-drag-region */
  nativeDrag?: boolean
  /** 显示置顶开关（只有独立窗口用） */
  showPin?: boolean
  /** 当前置顶状态 */
  pinned?: boolean
}>()

const emit = defineEmits<{
  'rate': [value: number]
  'dock': []
  'close': []
  'toggle-pin': []
}>()

/** 点置顶时图钉转一整圈：状态由父级切，这里只管转完停在原朝向 */
const pinSpinning = ref(false)

async function togglePin(): Promise<void> {
  emit('toggle-pin')
  // 先摘掉再下一帧挂上：连点也能重新起一次动画
  pinSpinning.value = false
  await nextTick()
  pinSpinning.value = true
}

function onPinSpinEnd(): void {
  pinSpinning.value = false
}

/**
 * 图钉（Phosphor `push-pin`，MIT）：Element Plus 没有图钉图标，置顶按钮用它。
 * 未置顶是空心、已置顶是实心（同形状的 fill 版）；颜色由 currentColor（--term-ink）带进去。
 */
const PUSH_PIN_PATH = 'M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z'
const PUSH_PIN_FILL_PATH = 'M235.33,104l-53.47,53.65c4.56,12.67,6.45,33.89-13.19,60A15.93,15.93,0,0,1,157,224c-.38,0-.75,0-1.13,0a16,16,0,0,1-11.32-4.69L96.29,171,53.66,213.66a8,8,0,0,1-11.32-11.32L85,159.71l-48.3-48.3A16,16,0,0,1,38,87.63c25.42-20.51,49.75-16.48,60.4-13.14L152,20.7a16,16,0,0,1,22.63,0l60.69,60.68A16,16,0,0,1,235.33,104Z'
</script>

<template>
  <header class="vplayer__bar" :data-tauri-drag-region="nativeDrag ? '' : undefined">
    <!-- 名字截断给原生 title；独立窗口里它也是拖动区（子元素不继承裸属性） -->
    <span
      class="vplayer__name"
      :title="name"
      :data-tauri-drag-region="nativeDrag ? '' : undefined"
    >{{ name }}</span>

    <!-- pointerdown 别冒泡到手柄条（那是拖窗口的入口），徽章自己要点得动 -->
    <span @pointerdown.stop>
      <VideoRateMenu :rate="rate" @change="(value: number) => emit('rate', value)" />
    </span>

    <el-tooltip
      v-if="showPin"
      :content="pinned ? '取消置顶' : '置顶'"
      placement="bottom"
    >
      <button
        class="vplayer__act is-pin"
        :class="{ 'is-on': pinned }"
        type="button"
        :aria-label="pinned ? '取消置顶' : '置顶'"
        @pointerdown.stop
        @click="togglePin"
      >
        <el-icon
          :class="{ 'is-spinning': pinSpinning }"
          @animationend="onPinSpinEnd"
        >
          <svg viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor" aria-hidden="true">
            <path :d="pinned ? PUSH_PIN_FILL_PATH : PUSH_PIN_PATH" />
          </svg>
        </el-icon>
      </button>
    </el-tooltip>

    <el-tooltip content="回到视频页" placement="bottom">
      <button class="vplayer__act" type="button" aria-label="回到视频页" @pointerdown.stop @click="emit('dock')">
        <el-icon><Monitor /></el-icon>
      </button>
    </el-tooltip>
    <el-tooltip content="停止播放" placement="bottom">
      <button class="vplayer__act" type="button" aria-label="停止播放" @pointerdown.stop @click="emit('close')">
        <el-icon><Close /></el-icon>
      </button>
    </el-tooltip>
  </header>
</template>

<style scoped>
.vplayer__bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 32px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  /* 手柄条是深色窗的一部分，底色比画布浮一档，看着是「窗的标题栏」而不是一块黑 */
  background: color-mix(in srgb, var(--term-ink) 8%, var(--term-bg));
  border-bottom: 1px solid var(--term-border);
  cursor: move;
  user-select: none;
  /* 速率徽章（VideoRateMenu）在这里换深色窗的这一族配色 */
  --rate-badge-border: var(--term-border);
  --rate-badge-ink: var(--term-ink);
  --rate-badge-hover-ink: var(--term-ink);
  --rate-badge-hover-bg: color-mix(in srgb, var(--term-ink) 12%, var(--term-bg));
}

.vplayer__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-meta);
  color: var(--term-ink);
}

/* 手柄条上的图标按钮：tooltip 已给出名字，按钮本体保持安静 */
.vplayer__act {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  color: var(--term-ink);
  cursor: pointer;
}

.vplayer__act:hover {
  background: color-mix(in srgb, var(--term-ink) 12%, var(--term-bg));
}

/* 置顶开着的状态：与 hover 同一档底色，但常驻 —— 灰度里只有「按下了没有」这一层 */
.vplayer__act.is-on {
  background: color-mix(in srgb, var(--term-ink) 14%, var(--term-bg));
}

/* 图钉的笔画比 EP 的线性图标细一档：在 24px 按钮里放大 2px，缩小后还认得出来 */
.vplayer__act.is-pin .el-icon {
  font-size: 15px;
}

/* 置顶 / 取消置顶：转一整圈再停回原朝向（状态切换的确认感，不靠位移） */
.vplayer__act.is-pin .el-icon.is-spinning {
  animation: vplayer-pin-spin 0.45s var(--ease-out);
}

@keyframes vplayer-pin-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .vplayer__act.is-pin .el-icon.is-spinning {
    animation: none;
  }
}
</style>
