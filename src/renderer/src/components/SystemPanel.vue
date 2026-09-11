<script setup lang="ts">
/**
 * 首页「系统状态」卡片：node / 包管理器 / nvm，以及数据目录。
 * 内容顶在上沿、数据目录贴在下沿（panel__foot 的 margin-top: auto），卡片拉高也不会散。
 */
import { computed } from 'vue'
import { FolderOpened } from '@element-plus/icons-vue'
import { PACKAGE_MANAGERS } from '@/managers'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

const managers = PACKAGE_MANAGERS

const nodeVersion = computed(() => store.packageManagers?.node || '未检测到')
const dataDir = computed(() => store.dataLocation?.dir ?? '')

const nvmLabel = computed(() => {
  const nvm = store.nvm
  if (!nvm?.available) return '未检测到'
  return nvm.current
    ? `已装 ${nvm.versions.length} 个 · 当前 ${nvm.current}`
    : `已装 ${nvm.versions.length} 个版本`
})
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">系统状态</span>
    </header>

    <dl class="facts">
      <div class="fact">
        <dt>node</dt>
        <dd class="mono">{{ nodeVersion }}</dd>
      </div>
      <div class="fact">
        <dt>包管理器</dt>
        <dd class="pms">
          <span
            v-for="m in managers"
            :key="m.key"
            class="pm"
            :title="store.packageManagers?.[m.key] ? `${m.label} 可用` : `${m.label} 未安装`"
          >
            <i
              class="pm__dot"
              :class="store.packageManagers?.[m.key] ? 'is-ok' : 'is-off'"
              aria-hidden="true"
            />
            {{ m.label }}
          </span>
        </dd>
      </div>
      <div class="fact">
        <dt>nvm</dt>
        <dd class="mono">{{ nvmLabel }}</dd>
      </div>
    </dl>

    <div class="panel__foot">
      <el-icon class="foot__icon"><FolderOpened /></el-icon>
      <span class="foot__path mono truncate" :title="dataDir">{{ dataDir || '—' }}</span>
      <button v-if="dataDir" class="panel__link" type="button" @click="store.reveal(dataDir)">
        打开
      </button>
    </div>
  </article>
</template>

<style scoped>
/* 卡片被拖矮时明细行自己滚，数据目录那一行始终贴在卡片底部 */
.facts {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.foot__icon {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
}

.foot__path {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
