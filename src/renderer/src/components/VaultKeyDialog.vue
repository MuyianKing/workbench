<script setup lang="ts">
/**
 * 密钥与同步：保险库那把密钥怎么管，以及它跟哪个仓库对。
 *
 * 这一屏解释的是**这套东西的保护来自哪里** —— 密钥只在本机、仓库里只有密文、
 * 另一台机器要靠同一个密钥文件才读得出来。三件事都在这里：导出给另一台机器、
 * 从另一台机器导入、以及两件不可逆的操作（换密钥 / 清除本机密钥），后者各要确认一次。
 *
 * 公钥指纹是这一屏唯一一件能公开的东西：它由公钥算出来，反过来推不出私钥，
 * 用来核对两台机器拿的是不是同一把。**密钥本身永远不上屏、不进剪贴板** ——
 * 它只走文件（导出一份，拿到另一台机器导入）。
 */
import { computed } from 'vue'
import { CopyDocument, Delete, Download, Upload } from '@element-plus/icons-vue'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { useVaultStore } from '@/stores/vault'

const visible = defineModel<boolean>('visible', { required: true })

const emit = defineEmits<{ changed: [] }>()

const store = useVaultStore()
const settings = useSettingsStore()
const auth = useAuthStore()

const fingerprintText = computed(() => store.fingerprint || '—')
const repo = computed(() => settings.settings.tokenSyncRepo.trim())

/** 同步仓库那一行说什么：与其余几条同步同一个判据（没登录就没有同步） */
const repoHint = computed(() => {
  if (!auth.status?.account) return '登录账号之后才能同步：凭据来自账号，见设置 → 通用 → 账号。'
  if (!repo) return '还没填同步仓库地址（设置 → 通用 → 账号 → 同步仓库）。'
  return repo
})

async function copyFingerprint(): Promise<void> {
  try {
    await navigator.clipboard.writeText(store.fingerprint)
    notifySuccess('公钥指纹已复制')
  } catch {
    notifyError('复制失败，可以手动选中再复制')
  }
}

/**
 * 换密钥：现有条目会用新密钥重新加密一遍（不丢），代价是**别的机器要重新导入这份新密钥**。
 * 这句话必须说全 —— 只说「换一把新密钥」的话，用户不会想到另一台机器第二天打开是一片解不开。
 */
async function replaceKey(): Promise<void> {
  const ok = await confirmAction(
    '全部条目会用新密钥重新加密一遍（不会丢）。但旧密钥从此解不开这个保险库，' +
      '别的机器要重新导入这份新密钥，否则它们那边只会显示一堆解不开的条目 —— ' +
      '所以换完请先把密钥导出一次。',
    '换一把新密钥？',
    { confirmButtonText: '换新密钥', type: 'warning' }
  )
  if (!ok) return

  await store.createKey(true)
  emit('changed')
}

/** 清除本机密钥：本机从此解不开任何东西，但仓库里那份数据不动 */
async function forgetKey(): Promise<void> {
  const ok = await confirmAction(
    '本机密钥会被删掉，这台机器从此解不开保险库（仓库里那份数据不动，别的机器也不受影响）。' +
      '只要手里还有导出过的那份密钥文件，之后还能导入回来。',
    '清除本机密钥？',
    { confirmButtonText: '清除', type: 'warning' }
  )
  if (!ok) return

  await store.forgetKey()
  emit('changed')
}

function exportKey(): void {
  void store.exportKey()
}

function importKey(): void {
  void store.importKeyFile().then(() => emit('changed'))
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="保险库密钥"
    width="560"
    append-to-body
    :close-on-click-modal="false"
  >
    <div class="keys">
      <!-- 保护来自哪里：这一屏存在的理由就是把这句说清楚 -->
      <p class="keys__lead">
        密钥只存在这台机器上（Windows 凭据管理器里，按当前 Windows 用户加密）。
        仓库里那份 <span class="mono">vault/vault.json</span> 从头到尾都是密文 ——
        有公钥就能往里写，没有私钥谁也读不出来。另一台机器要用同一个保险库，
        把密钥导出成文件带过去导入一次即可。
      </p>

      <div class="keys__row">
        <div class="keys__text">
          <span class="keys__label">公钥指纹</span>
          <span class="keys__hint">
            两台机器上显示的应当是同一串。对不上说明它们用的不是同一把密钥，
            同步过去的东西在对面解不开。
          </span>
        </div>
        <div class="keys__value">
          <span class="mono">{{ fingerprintText }}</span>
          <el-button
            size="small"
            :icon="CopyDocument"
            :disabled="!store.fingerprint"
            @click="copyFingerprint"
          />
        </div>
      </div>

      <div class="keys__row">
        <div class="keys__text">
          <span class="keys__label">同步仓库</span>
          <span class="keys__hint">{{ repoHint }}</span>
        </div>
      </div>

      <div class="keys__row">
        <div class="keys__text">
          <span class="keys__label">导出 / 导入</span>
          <span class="keys__hint">
            导出的是一个纯文本文件，里面就是这把密钥 —— 它等于保险库本身，
            搬到另一台机器时别经过任何第三方服务。
          </span>
        </div>
        <div class="keys__value">
          <el-button size="small" :icon="Download" @click="exportKey">导出</el-button>
          <el-button size="small" :icon="Upload" @click="importKey">导入</el-button>
        </div>
      </div>

      <!-- 两件不可逆的事收在最下面：它们不该跟上面那几颗按钮混在一起 -->
      <div class="keys__danger">
        <el-button size="small" @click="replaceKey">换一把新密钥</el-button>
        <el-button size="small" type="danger" plain @click="forgetKey">
          <el-icon><Delete /></el-icon>
          清除本机密钥
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.keys {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.keys__lead {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.keys__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}

.keys__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.keys__label {
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 500;
}

.keys__hint {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.6;
}

.keys__value {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--sp-2);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.keys__danger {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
</style>
