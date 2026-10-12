<script setup lang="ts">
import type { AppSettings } from '@/types'
import { CAPTURE_SAVE_DIR_DEFAULT, PIN_OPACITY_MAX, PIN_OPACITY_MIN } from '@workbench/capture'
import { ElMessage } from 'element-plus'
/**
 * 设置 · 截图：快捷键、保存位置、钉图与放大镜，外加一颗「立即截图」。
 *
 * 两项快捷键（唤起窗口在通用那一屏、这里是截图）由 Rust **一次性整批装**，
 * 所以这里改完必须再调一次 `applyHotkeys` —— 插件注册是「先全清再逐条注册」，
 * 少调一次就会留下「改了没生效」或者「旧的那条还活着」。注册失败（被别的程序占用）
 * 在这一屏用 ElMessage 如实报出来，不吞掉。
 *
 * 保存目录留空 = 每次保存弹「另存为」。只对本机成立，不进外观同步。
 */
import { computed } from 'vue'
import HotkeyField from '@/components/HotkeyField.vue'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()

function save(patch: Partial<AppSettings>): void {
  void settings.updateSettings(patch)
}

/** 改快捷键：存下之后立刻整批重装一遍，把失败原因报出来 */
async function saveHotkeys(patch: Partial<AppSettings>): Promise<void> {
  await settings.updateSettings(patch)
  const result = await window.workbench.applyHotkeys()
  if (!result.ok)
    ElMessage.warning(result.error)
}

const saveDir = computed(() => settings.settings.captureSaveDir)

async function pickSaveDir(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择截图的保存位置')
  if (picked)
    save({ captureSaveDir: picked })
}
</script>

<template>
  <section class="pane">
    <div class="block">
      <h3 class="block__title">
        截图
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">启用截图</span>
          <span class="row__hint">关掉之后快捷键与托盘菜单里的「截图」都不再响应。</span>
        </div>
        <el-switch
          :model-value="settings.settings.captureEnabled"
          size="small"
          @update:model-value="(value: unknown) => saveHotkeys({ captureEnabled: Boolean(value) })"
        />
      </div>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">截图快捷键</span>
          <span class="row__hint">按下去就在光标所在那块屏上拉出选区，默认 F1。</span>
        </div>
        <HotkeyField
          :model-value="settings.settings.captureHotkey"
          :disabled="!settings.settings.captureEnabled"
          allow-bare
          @update:model-value="(value: string) => saveHotkeys({ captureHotkey: value })"
        />
      </div>
    </div>

    <div class="block">
      <h3 class="block__title">
        保存
      </h3>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">自动保存位置</span>
          <span class="row__hint">
            截图里点「保存」直接落进这个目录（同名自动加序号）；留空则每次都弹「另存为」。
          </span>
        </div>
        <div class="row__pick">
          <span class="pick__value mono" :class="{ 'is-empty': !saveDir }">
            {{ saveDir || '未设置' }}
          </span>
          <el-button size="small" @click="pickSaveDir">
            选择目录
          </el-button>
          <el-button v-if="saveDir" size="small" text @click="save({ captureSaveDir: CAPTURE_SAVE_DIR_DEFAULT })">
            清空
          </el-button>
        </div>
      </div>
    </div>

    <div class="block">
      <h3 class="block__title">
        钉图与放大镜
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">新钉图的初始透明度</span>
          <span class="row__hint">
            钉到屏幕上时的初始值，之后在钉图上用 Ctrl + 滚轮随时可调（{{ PIN_OPACITY_MIN }}~{{ PIN_OPACITY_MAX }}%）。
          </span>
        </div>
        <el-input-number
          :model-value="settings.settings.capturePinOpacity"
          size="small"
          :min="PIN_OPACITY_MIN"
          :max="PIN_OPACITY_MAX"
          :step="5"
          controls-position="right"
          @update:model-value="(value: number | undefined) => save({ capturePinOpacity: value ?? 100 })"
        />
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">放大镜与取色</span>
          <span class="row__hint">选区块时在光标旁显示放大的像素与颜色读数；挡视线时可以关掉。</span>
        </div>
        <el-switch
          :model-value="settings.settings.captureMagnifier"
          size="small"
          @update:model-value="(value: unknown) => save({ captureMagnifier: Boolean(value) })"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.row__pick {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.pick__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick__value.is-empty {
  color: var(--ink-3);
}
</style>
