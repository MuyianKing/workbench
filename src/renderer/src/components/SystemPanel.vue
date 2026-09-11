<script setup lang="ts">
/**
 * 首页「系统状态」卡片：node / 包管理器 / nvm，以及数据目录。
 * 内容顶在上沿、数据目录贴在下沿（panel__foot 的 margin-top: auto），卡片拉高也不会散。
 *
 * 包管理器这一行是本机环境唯一的动作入口：没装的点一下走 npm 全局安装，
 * 安装过程把最后一行输出顶在明细下面，完整日志仍然在底部终端里。
 */
import { computed } from 'vue'
import { FolderOpened, Refresh } from '@element-plus/icons-vue'
import { PACKAGE_MANAGERS, type PackageManagerKey } from '@/managers'
import { useProjectsStore } from '@/stores/projects'
import type { InstallablePackageManager } from '@/types'

const store = useProjectsStore()

const managers = PACKAGE_MANAGERS

const nodeVersion = computed(() => store.packageManagers?.node || '未检测到')
const dataDir = computed(() => store.dataLocation?.dir ?? '')

function available(key: PackageManagerKey): boolean {
  return store.packageManagers?.[key] ?? false
}

function installing(key: PackageManagerKey): boolean {
  return store.pmInstalling === key
}

/** 模板只给 installable 的条目挂按钮，npm 随 Node.js 分发，走不到这里 */
async function install(key: PackageManagerKey): Promise<void> {
  await store.installPackageManager(key as InstallablePackageManager)
}

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

    <!-- 重探入口挂在标题栏右侧，绝对定位不占流：塞进 head 会把标题行撑高，固定高度的卡片就被挤了 -->
    <button
      class="head__refresh"
      type="button"
      :disabled="!!store.pmInstalling"
      title="重新检测包管理器"
      aria-label="重新检测包管理器"
      @click="store.refreshPackageManagers()"
    >
      <el-icon><Refresh /></el-icon>
    </button>

    <dl class="facts">
      <div class="fact">
        <dt>node</dt>
        <dd class="mono">{{ nodeVersion }}</dd>
      </div>
      <div class="fact">
        <dt>包管理器</dt>
        <dd class="pms">
          <template v-for="m in managers" :key="m.key">
            <span v-if="available(m.key)" class="pm" :title="`${m.label} 可用`">
              <i class="pm__dot is-ok" aria-hidden="true" />
              {{ m.label }}
            </span>

            <!-- 未安装且能装：整块就是按钮，末尾那颗「安装」标签是点击提示 -->
            <button
              v-else-if="m.installable"
              class="pm pm--install"
              type="button"
              :disabled="!!store.pmInstalling"
              :title="installing(m.key) ? `正在安装 ${m.label}` : `通过 npm 全局安装 ${m.label}`"
              @click="install(m.key)"
            >
              <i class="pm__dot is-off" aria-hidden="true" />
              {{ m.label }}
              <span class="pm__act">{{ installing(m.key) ? '安装中' : '安装' }}</span>
            </button>

            <span v-else class="pm" title="npm 随 Node.js 分发，请重新安装 Node.js">
              <i class="pm__dot is-off" aria-hidden="true" />
              {{ m.label }}
            </span>
          </template>
        </dd>
      </div>
      <div class="fact">
        <dt>nvm</dt>
        <dd class="mono">{{ nvmLabel }}</dd>
      </div>
    </dl>

    <!-- 把 npm 的最后一行输出顶在这里，不切到终端也能看到进展 -->
    <p v-if="store.pmInstalling" class="pm-log mono truncate" :title="store.pmInstallLog">
      {{ store.pmInstallLog || '正在通过 npm 安装…' }}
    </p>

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

/* ---------- 重新检测 ---------- */
.head__refresh {
  position: absolute;
  /* 与标题那行文字（eyebrow）大致对齐，具体像素不重要，反正不占流 */
  top: 12px;
  right: 12px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.head__refresh:hover:not(:disabled) {
  color: var(--ink);
}

.head__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

/* ---------- 包管理器 ---------- */
/* 栏宽可以拖得很窄，三个放不下就换行，别让最后一个被 dd 的省略号裁掉 */
.pms {
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
  /* 「安装」标签下面要吃进那 0.125em 的光学修正，不能被 .fact dd 的省略号裁掉 */
  overflow: visible;
}

/*
 * 未安装且可安装的那一个：整块做成按钮。
 * 清掉按钮自带的内边距与字形，让它和旁边纯展示的 .pm 长得一样 —
 * 唯一的差别是末尾那颗「安装」标签和指针形状。
 */
.pm--install {
  padding: 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.pm--install:hover:not(:disabled) {
  color: var(--ink);
}

.pm--install:disabled {
  cursor: default;
}

/* 「安装」标签平时低调、hover 才实心，免得整行看着都是按钮 */
.pm__act {
  padding: 1px 5px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  transition: background-color 0.15s ease, color 0.15s ease;
  /* 和圆点同一个道理：按行盒居中会比左边的 yarn 高出一截，往下压到字母的视觉中心 */
  transform: translateY(0.125em);
}

.pm--install:hover:not(:disabled) .pm__act {
  background: var(--ink);
  color: var(--ink-inverse);
}

.pm--install:disabled .pm__act {
  opacity: 0.6;
}

/* 安装过程中的最后一行输出 */
.pm-log {
  flex-shrink: 0;
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
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
