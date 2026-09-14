<script setup lang="ts">
/**
 * 首页「系统状态」卡片：node / 包管理器 / nvm / nrm，以及数据目录。
 * 内容顶在上沿、数据目录贴在下沿（panel__foot 的 margin-top: auto），卡片拉高也不会散。
 *
 * 包管理器与 nrm 这两行是本机环境的动作入口：没装的点一下走 npm 全局安装，
 * 安装过程把最后一行输出顶在明细下面，完整日志仍然在底部终端里；
 * nrm 装好之后那一行还是个镜像源开关 —— 值就是当前用的源，点开换一个。
 */
import { computed } from 'vue'
import { ArrowDown, FolderOpened, Refresh } from '@element-plus/icons-vue'
import { PACKAGE_MANAGERS, type PackageManagerKey } from '@/managers'
import { useProjectsStore } from '@/stores/projects'
import type { InstallablePackageManager, NrmRegistry } from '@/types'

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

// ---------- nrm ----------

/** 正在装 nrm：按钮文字从「未安装」换成「正在安装」 */
const nrmInstalling = computed(() => store.pmInstalling === 'nrm')
const nrmRegistries = computed(() => store.nrm?.registries ?? [])

/**
 * 这一行显示什么：
 * 探测没回来时先占位，装了但清单读不出来时退回「已安装」——
 * 只有真的能切换（有清单）才把值画成下拉。
 */
const nrmLabel = computed(() => {
  const nrm = store.nrm
  if (!nrm) return '检测中…'
  if (!nrm.available) return '未安装'
  if (!nrm.registries.length) return nrm.version ? `已安装 v${nrm.version}` : '已安装'
  return nrm.current ?? '未识别'
})

/** 悬停提示：版本、镜像地址，以及为什么读不出清单 */
const nrmTip = computed(() => {
  const nrm = store.nrm
  if (!nrm) return '正在检测 nrm'
  if (!nrm.available) return '通过 npm 全局安装 nrm（npm 镜像源管理器）'
  const current = nrmRegistries.value.find((item) => item.name === nrm.current)
  return [
    nrm.version ? `nrm v${nrm.version}` : 'nrm',
    current ? `${current.name} · ${current.url}` : '',
    nrm.error ?? '',
    nrm.registries.length ? '点击切换镜像源' : ''
  ]
    .filter(Boolean)
    .join('\n')
})

function registryTip(item: NrmRegistry): string {
  return item.current ? `${item.url}（当前）` : item.url
}

async function switchRegistry(name: unknown): Promise<void> {
  if (typeof name === 'string') await store.useNrmRegistry(name)
}

/** 重新检测本机环境：包管理器与 nrm 各探一次 */
function refresh(): void {
  void store.refreshPackageManagers()
  void store.refreshNrm()
}
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
      title="重新检测本机环境"
      aria-label="重新检测本机环境"
      @click="refresh"
    >
      <el-icon><Refresh /></el-icon>
    </button>

    <dl class="facts panel__scroll">
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

      <!--
        nrm：没装时整行是个安装按钮（与包管理器同款），装好之后这一行就是镜像源开关。
        只有「能切换」时才画成下拉；清单读不出来时退回纯展示，免得给一个点不开的控件。
      -->
      <div class="fact">
        <dt>nrm</dt>
        <dd class="nrm" :title="nrmTip">
          <!-- 探测还没回来：先占位，别把「不知道」画成一个可点的安装按钮 -->
          <span v-if="!store.nrm" class="mono">{{ nrmLabel }}</span>

          <button
            v-else-if="!store.nrm.available"
            class="pm pm--install"
            type="button"
            :disabled="!!store.pmInstalling"
            :title="nrmTip"
            @click="store.installNrm()"
          >
            <i class="pm__dot is-off" aria-hidden="true" />
            {{ nrmInstalling ? '正在安装' : nrmLabel }}
            <!-- 安装期间那颗「安装」标签收起来：旁边已经在说「正在安装」，再来一句是重复 -->
            <span v-if="!nrmInstalling" class="pm__act">安装</span>
          </button>

          <el-dropdown
            v-else-if="nrmRegistries.length"
            trigger="click"
            placement="bottom-end"
            @command="switchRegistry"
          >
            <button
              class="nrm__pick"
              type="button"
              :disabled="!!store.nrmSwitching"
              :title="nrmTip"
            >
              <i class="pm__dot is-ok" aria-hidden="true" />
              <span class="nrm__name mono truncate">{{ nrmLabel }}</span>
              <el-icon class="nrm__caret"><ArrowDown /></el-icon>
            </button>

            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="item in nrmRegistries"
                  :key="item.name"
                  :command="item.current ? '' : item.name"
                  :class="{ 'is-current': item.current }"
                >
                  <span class="reg__name">{{ item.name }}</span>
                  <span class="reg__url mono truncate" :title="registryTip(item)">
                    {{ item.url }}
                  </span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <span v-else class="mono">{{ nrmLabel }}</span>
        </dd>
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

/* ---------- nrm ---------- */
/* 这一行的值本身是镜像源开关，所以整块做成幽灵按钮，与其它行的纯文字等重 */
.nrm {
  display: flex;
  align-items: center;
  /*
   * 值这一列吃掉整行剩下的宽度（靠右对齐），而不是缩到「内容宽度」。
   * 缩到内容宽度时 Chrome 会把嵌套的按钮量少几个像素，而触发器上那个百分比 max-width
   * 又按这个偏小的值去算 —— 两边一凑，像 taobao 这种短名字也会被截成 taob…（实测过）。
   */
  flex: 1;
  justify-content: flex-end;
  min-width: 0;
}

.nrm__pick {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  /* 上限用像素值：百分比上限会跟上面的内容宽度互相套，锁在一个偏小的值上 */
  max-width: 150px;
  /* 负外边距把内边距吃到行外，右边缘才与上面几行的值对齐 */
  margin-right: -4px;
  padding: 1px 4px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.nrm__pick:hover:not(:disabled) {
  background: var(--bg-inset);
}

/* 切换期间只淡下去：箭头跟着转反而像个加载控件，这里没有进度可言 */
.nrm__pick:disabled {
  cursor: default;
  opacity: 0.6;
}

.nrm__name {
  min-width: 0;
}

.nrm__caret {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-3);
}

/* 下拉里的两项：名字在左、地址贴着右边，地址过长就自己截断 */
.reg__name {
  font-weight: 600;
}

.reg__url {
  margin-left: auto;
  padding-left: var(--sp-3);
  max-width: 220px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
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
