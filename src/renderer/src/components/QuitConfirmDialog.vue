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
import { WarningFilled } from '@element-plus/icons-vue'
import type { QuitChoice } from '@/types'

const visible = ref(false)
const count = ref(0)
/** 这一次退出确认是否已经回过后端；Esc 关窗与点选项两条路都要恰好回一次 */
let answered = false
const primaryButton = ref<HTMLButtonElement | null>(null)

let unsubscribe: (() => void) | undefined

onMounted(() => {
  unsubscribe = window.workbench.onQuitConfirm((payload) => {
    count.value = payload.count
    answered = false
    visible.value = true
    void nextTick(() => primaryButton.value?.focus())
  })
})

onBeforeUnmount(() => unsubscribe?.())

/**
 * 选一个。Esc 与右上角关闭按钮都是「取消」—— 两者由 el-dialog 负责触发
 * （Esc 关掉它，`@closed` 落到下面那个处理函数里回一个 cancel）。
 */
function choose(choice: QuitChoice): void {
  if (!visible.value) return
  answered = true
  visible.value = false
  window.workbench.respondQuitConfirm(choice)
}

/** 关掉弹窗而没选过（Esc / 点右上角关闭）：按「取消」处理，应用继续运行 */
function onClosed(): void {
  if (answered) return
  answered = true
  window.workbench.respondQuitConfirm('cancel')
}
</script>

<template>
  <!--
    用 el-dialog 而不是自绘遮罩：遮罩、焦点陷阱、Esc、滚动锁都由它统一处理，
    与设置 / 添加项目那些弹窗走同一条路（应用里只有这一处曾经自带一层压暗的遮罩，
    而别处的遮罩是「从标题栏下沿开始、不压暗背景」—— 见 global.css 的弹层一节）。
    头部与两个选项仍然自绘：那块「警告徽标 + 两个带说明的选项卡」的版式与它的内容绑得紧，
    el-message-box 装不下。
  -->
  <el-dialog
    v-model="visible"
    width="440"
    align-center
    append-to-body
    :show-close="true"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    :title="null"
    aria-label="仍有进程在运行"
    @closed="onClosed"
  >
    <div class="quit__head">
      <span class="quit__badge"><el-icon><WarningFilled /></el-icon></span>
      <div class="quit__head-text">
        <h2 id="quit-title" class="quit__title">仍有进程在运行</h2>
        <p class="quit__subtitle">
          还有 <b>{{ count }}</b> 个进程正在运行
        </p>
      </div>
    </div>

    <p id="quit-desc" class="quit__desc">选择先结束它们，还是让它们继续留在后台。</p>

    <div class="quit__options">
      <button ref="primaryButton" type="button" class="opt opt--primary" @click="choose('stop')">
        <span class="opt__body">
          <span class="opt__label">结束全部进程并退出</span>
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
  </el-dialog>
</template>

<style scoped>
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
</style>
