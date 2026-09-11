<script setup lang="ts">
/**
 * 退出确认框（应用内）。
 *
 * 托盘「退出」时若还有项目在跑，主进程推事件过来，由这里弹窗并把选择回传。
 * 用应用内的样式而不是系统原生消息框，视觉才跟界面一致；窗口不可用时主进程会退回原生框。
 *
 * 右上角关闭按钮与 Esc 都是「取消」：关掉弹窗、什么都不做，应用继续运行。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Close, WarningFilled } from '@element-plus/icons-vue'
import type { QuitChoice } from '@/types'

const visible = ref(false)
const count = ref(0)
const primaryButton = ref<HTMLButtonElement | null>(null)

let unsubscribe: (() => void) | undefined

onMounted(() => {
  unsubscribe = window.workbench.onQuitConfirm((payload) => {
    count.value = payload.count
    visible.value = true
    void nextTick(() => primaryButton.value?.focus())
  })
})

onBeforeUnmount(() => unsubscribe?.())

function choose(choice: QuitChoice): void {
  if (!visible.value) return
  visible.value = false
  window.workbench.respondQuitConfirm(choice)
}

/** Esc = 取消，与右上角关闭按钮一致 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  choose('cancel')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="quit">
      <div v-if="visible" class="quit" @keydown="onKeydown">
        <div class="quit__scrim" />
        <div
          class="quit__card"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="quit-title"
          aria-describedby="quit-desc"
        >
          <button type="button" class="quit__close" aria-label="关闭" @click="choose('cancel')">
            <el-icon><Close /></el-icon>
          </button>

          <div class="quit__head">
            <span class="quit__badge"><el-icon><WarningFilled /></el-icon></span>
            <div class="quit__head-text">
              <h2 id="quit-title" class="quit__title">仍有项目在运行</h2>
              <p class="quit__subtitle">
                还有 <b>{{ count }}</b> 个项目的进程正在运行
              </p>
            </div>
          </div>

          <p id="quit-desc" class="quit__desc">选择先结束它们，还是让它们继续留在后台。</p>

          <div class="quit__options">
            <button
              ref="primaryButton"
              type="button"
              class="opt opt--primary"
              @click="choose('stop')"
            >
              <span class="opt__body">
                <span class="opt__label">关闭所有项目并退出</span>
                <span class="opt__hint">结束进程树，未保存的命令输出将丢失</span>
              </span>
            </button>

            <button type="button" class="opt" @click="choose('direct')">
              <span class="opt__body">
                <span class="opt__label">直接退出</span>
                <span class="opt__hint">保留后台运行，下次启动时自动检测并清理</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.quit {
  position: fixed;
  /* 让开系统绘制的窗口按钮（titleBarStyle: 'hidden'），与其它弹层一致 */
  inset: var(--h-titlebar) 0 0 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-6);
}

.quit__scrim {
  position: absolute;
  inset: 0;
  background: rgba(17, 21, 27, 0.28);
}

.quit__card {
  position: relative;
  width: min(440px, 100%);
  padding: var(--sp-5);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-pop);
}

.quit__close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 14px;
  color: var(--ink-3);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.quit__close:hover {
  color: var(--ink);
  background: var(--bg-subtle);
}

.quit__close:focus-visible {
  outline: 2px solid var(--st-run);
  outline-offset: 1px;
}

.quit__head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  /* 给右上角关闭按钮让出位置，标题不会钻到它下面 */
  padding-right: 28px;
}

.quit__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  font-size: 20px;
  color: var(--st-run);
  background: var(--st-run-soft);
  border-radius: var(--r-md);
}

.quit__head-text {
  min-width: 0;
}

.quit__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
}

.quit__subtitle {
  margin: 2px 0 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.quit__subtitle b {
  font-weight: 600;
  color: var(--ink);
}

.quit__desc {
  margin: var(--sp-4) 0;
  font-size: var(--fs-body);
  line-height: 1.6;
  color: var(--ink-2);
}

.quit__options {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.opt {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: 10px var(--sp-3);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.opt:hover {
  background: var(--bg-subtle);
  border-color: var(--border-strong);
}

.opt:focus-visible {
  outline: 2px solid var(--st-run);
  outline-offset: 1px;
}

.opt--primary {
  border-color: var(--border-strong);
}

.opt--primary:hover {
  border-color: var(--ink);
}

.opt__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.opt__label {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.opt__hint {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.quit-enter-active,
.quit-leave-active {
  transition: opacity 0.16s ease;
}

.quit-enter-active .quit__card,
.quit-leave-active .quit__card {
  transition: transform 0.18s ease;
}

.quit-enter-from,
.quit-leave-to {
  opacity: 0;
}

.quit-enter-from .quit__card,
.quit-leave-to .quit__card {
  transform: translateY(6px) scale(0.98);
}
</style>
