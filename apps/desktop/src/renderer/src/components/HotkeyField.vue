<script setup lang="ts">
/**
 * 全局快捷键的输入件：一块「点一下、然后按组合键」的按钮。
 *
 * 两处在用（设置·通用里的唤起窗口、设置·截图里的截图），口径必须一致：
 * 展示形式、Esc 放弃、缺修饰键时的提示都在这里与 use-hotkey-recorder 里定死。
 *
 * **失焦就当放弃**：不需要谁来通知它「弹窗关了」—— 点别处（包括设置弹窗的关闭按钮）
 * 会自然让按钮失焦，录制态随之退出，下次打开不会停在「请按下新的组合键」上。
 */
import { ElMessage } from 'element-plus'
import { computed } from 'vue'
import { hotkeyLabel, useHotkeyRecorder } from '@/composables/use-hotkey-recorder'

const props = withDefaults(defineProps<{
  disabled?: boolean
  /** 允许单按一个键就录下来（截图那两条要，F1 天生没有修饰键） */
  allowBare?: boolean
  /** 还没录过值时按钮里显示什么（编辑器快捷键用：显示那个动作的内置键位） */
  placeholder?: string
  /**
   * 按钮旁边带不带那句「点击后直接按组合键即可替换」。
   * 全局快捷键那种单行场景带着；编辑器快捷键的网格里传 false，改由 title 兜着。
   */
  hint?: boolean
}>(), {
  disabled: false,
  allowBare: false,
  placeholder: '',
  hint: true,
})

/** 当前快捷键串（`Control+M` 这种写法）。v-model 一条口径，与全应用其余双向绑定一致 */
const model = defineModel<string>({ required: true })

const { recording, start, stop, capture } = useHotkeyRecorder({
  requireModifier: !props.allowBare,
  onReject: message => ElMessage.warning(message),
  onCapture: (value) => {
    model.value = value
  },
})

const label = computed(() => hotkeyLabel(model.value))
const showHint = computed(() => props.hint)
</script>

<template>
  <div class="hotkey-field">
    <button
      class="hotkey"
      :class="{ 'is-recording': recording }"
      type="button"
      :disabled="disabled"
      :title="showHint ? '点击后直接按组合键即可替换（按 Esc 放弃）' : undefined"
      @click="start"
      @keydown="recording && capture($event)"
      @blur="stop"
    >
      <span v-if="recording" class="hotkey__recording">请按下新的组合键…</span>
      <span v-else-if="model" class="hotkey__value mono">{{ label }}</span>
      <span v-else class="hotkey__value hotkey__value--empty">{{ props.placeholder || '未设置' }}</span>
    </button>
    <!--
      那句「点击后直接按组合键即可替换」只给全局快捷键那种单行场景（默认）；
      编辑器快捷键那种网格里 18 行各带一句会把版面挤碎，传 compact 关掉，改由 hover 时看 title。
    -->
    <span v-if="showHint" class="row__hint row__hint--tight">点击后直接按组合键即可替换（按 Esc 放弃）</span>
  </div>
</template>

<style scoped>
.hotkey-field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.hotkey {
  min-width: 168px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink);
  font-size: var(--fs-meta);
  cursor: pointer;
  transition: border-color 0.15s ease;
  /* 键位串再长也不折行（Control + Shift + H 那档）：宁可按钮变宽，不把排好的版挤塌 */
  white-space: nowrap;
}

.hotkey:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.hotkey:disabled {
  color: var(--ink-3);
  cursor: not-allowed;
}

.hotkey.is-recording {
  border-color: var(--st-run);
  color: var(--st-run);
  background: var(--st-run-soft);
}

/* 空值的那一档：与占位同色，别让「未设置」读着像个真键位 */
.hotkey__value--empty {
  color: var(--ink-3);
}

.row__hint--tight {
  margin-top: 0;
  flex-shrink: 0;
}
</style>
