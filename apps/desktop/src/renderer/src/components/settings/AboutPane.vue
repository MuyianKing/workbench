<script setup lang="ts">
import { FolderOpened } from '@element-plus/icons-vue'
import { accountLabel } from '@workbench/auth'
import { ElMessage } from 'element-plus'
/**
 * 设置 · 关于：这个应用是什么、数据住在哪。
 *
 * 全是「如实说明」那一套 —— 没有宣传语，也没有一个数字是编出来的。
 * 这里不做第二份可编辑入口：账号与同步仓库都在「通用」那一屏，这一屏只读地摆出当前值。
 *
 * 版本号在第一次切到这一屏时向后端要一次（它不会变，取到就不再问）；
 * 数据目录那一行显示的是环境探测的结果。
 */
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useEnvironmentStore } from '@/stores/environment'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{ open: boolean, active: boolean }>()

const settings = useSettingsStore()
const environment = useEnvironmentStore()
const auth = useAuthStore()

const account = computed(() => auth.status?.account ?? null)

/** 版本号的占位：取不到时如实显示，而不是编一个号出来 */
const APP_VERSION_PENDING = '读取中…'

const appVersion = ref(APP_VERSION_PENDING)

async function loadAppVersion(): Promise<void> {
  try {
    appVersion.value = await window.workbench.getAppVersion()
  }
  catch {
    // 拿不到版本不该让这一屏打不开，如实说明即可
    appVersion.value = '未知'
  }
}

// 第一次切到这一屏时取版本号；取到一次就够（它不会变），之后不再问
watch(
  () => props.open && props.active,
  (current) => {
    if (current && appVersion.value === APP_VERSION_PENDING)
      void loadAppVersion()
  },
)

/** 打开数据目录：与项目卡那颗「打开目录」同一条通道，失败时把原因说出来 */
async function openDataDir(): Promise<void> {
  const dir = environment.dataDir
  if (!dir)
    return

  const result = await window.workbench.reveal(dir)
  if (!result.ok)
    ElMessage.error(result.error ?? '打开目录失败')
}
</script>

<template>
  <section class="pane">
    <div class="block">
      <h3 class="block__title">
        程序
      </h3>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">{{ settings.settings.appName }}</span>
          <span class="row__hint">
            版本 <span class="mono">{{ appVersion }}</span> ·
            Windows 桌面应用（Tauri 2 + WebView2）
          </span>
        </div>
      </div>
    </div>

    <div class="block">
      <h3 class="block__title">
        这台机器上的数据
      </h3>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">数据目录</span>
          <span class="row__hint">
            项目列表、设置、用量快照、工作日志与密码保险库都在这里；位置固定，不跟着任何设置走。
            保险库那份 <span class="mono">vault.json</span> 里只有密文，密钥在 Windows 凭据管理器里。
          </span>
        </div>
        <div class="path__actions">
          <p class="path mono truncate" :title="environment.dataDir">
            {{ environment.dataDir || '读取中…' }}
          </p>
          <el-button
            size="small"
            :icon="FolderOpened"
            :disabled="!environment.dataDir"
            @click="openDataDir"
          >
            打开目录
          </el-button>
        </div>
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">登录状态</span>
          <span class="row__hint">
            登录只为授权同步私有仓库；access_token 存在 Windows 凭据管理器里，不落数据文件。
          </span>
        </div>
        <span v-if="account" class="about__account">
          <el-avatar :size="22" :src="account.avatar ?? undefined" />
          <span class="truncate">{{ accountLabel(account) }}</span>
        </span>
        <span v-else class="row__hint">未登录</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ---------- 数据位置 ---------- */
/* 路径与旁边那颗按钮同一行：路径占满剩下的宽度并自己截断，min-width 是截断生效的前提 */
.path {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.path__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

/* ---------- 关于 ---------- */
.about__account {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
  max-width: 180px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}
</style>
