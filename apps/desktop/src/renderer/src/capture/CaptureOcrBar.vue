<script setup lang="ts">
/**
 * 取字模式的小工具条：全选 / 复制 / 退出三件事。
 *
 * 只管摆和收（点哪一项就往上报），动作与选区都在 CaptureApp 里 ——
 * 与 CaptureToolbar 同一条口径。替换同一块工具条的位置出现（贴着选区）。
 */
const emit = defineEmits<{
  'select-all': []
  'copy': []
  'exit': []
}>()
</script>

<template>
  <div class="overlay-bar capture-ocr-bar">
    <button type="button" class="overlay-step" @click="emit('select-all')">
      全选
    </button>
    <!-- 主操作：与「复制图片」那颗同一档次，给一层底色 -->
    <button type="button" class="overlay-step capture-ocr-bar__copy" @click="emit('copy')">
      复制
    </button>
    <span class="overlay-bar__sep" />
    <button type="button" class="overlay-step" @click="emit('exit')">
      退出
    </button>
  </div>
</template>

<style scoped>
.capture-ocr-bar__copy {
  border-color: var(--accent, #409eff);
  background: var(--accent, #409eff);
  color: #fff;
}

.capture-ocr-bar__copy:hover {
  filter: brightness(1.1);
}
</style>
