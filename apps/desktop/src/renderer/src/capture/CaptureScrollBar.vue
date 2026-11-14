<script setup lang="ts">
/**
 * 滚动模式的控制条：两相各换一副脸（见 docs/modules/screenshot.md 的「滚动截图」）。
 *
 * - run：滚着呢 —— 只有进度文案，没有按钮：这一相遮罩对鼠标穿透，按钮本来也点不到，
 *   停止靠再按一次截图热键（点「滚动」直接开滚，没有「开始」确认步）；
 * - result：拼完了 —— 「复制」「保存」「取消」加尺寸读数（拼不上的原因挂在尺寸前面）。
 *
 * 只管摆和收（点哪项往上报），动作与长图都在 CaptureApp 里 —— 与 CaptureOcrBar 同一条口径。
 */
defineProps<{
  phase: 'run' | 'result'
  /** 长图的尺寸读数（宽 × 高；run 相是已拼到的高度） */
  size: string
  /** 提示文案（没滚到内容 / 画面变化太快 / 到了上限），空 = 没有话要说 */
  note: string
}>()
const emit = defineEmits<{
  cancel: []
  copy: []
  save: []
}>()
</script>

<template>
  <div class="overlay-bar capture-scroll-bar">
    <template v-if="phase === 'run'">
      <span class="capture-scroll-bar__hint">拼接中 {{ size }} · 再按截图键停止</span>
    </template>

    <template v-else>
      <span v-if="note" class="capture-scroll-bar__note">{{ note }}</span>
      <span class="capture-scroll-bar__hint">{{ size }}</span>
      <span class="overlay-bar__sep" />
      <button type="button" class="overlay-step capture-scroll-bar__primary" @click="emit('copy')">
        复制
      </button>
      <button type="button" class="overlay-step" @click="emit('save')">
        保存
      </button>
      <button type="button" class="overlay-step" @click="emit('cancel')">
        取消
      </button>
    </template>
  </div>
</template>

<style scoped>
.capture-scroll-bar__primary {
  border-color: var(--accent, #409eff);
  background: var(--accent, #409eff);
  color: #fff;
}

.capture-scroll-bar__primary:hover {
  filter: brightness(1.1);
}

.capture-scroll-bar__hint {
  opacity: 0.72;
}

/* 拼不上的原因要说清楚：比普通文案显一点，但不是错误卡片那一档 */
.capture-scroll-bar__note {
  color: var(--el-color-warning, #e6a23c);
}
</style>
