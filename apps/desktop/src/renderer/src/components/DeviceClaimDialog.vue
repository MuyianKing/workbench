<script setup lang="ts">
/**
 * 设备认领向导：重装 / 清数据目录后检测到本机是新 id、仓库里还有旧设备时弹出。
 * 让用户把其中一台旧设备认回来 —— 回灌历史、改回 id、清理误生成的新设备分片。
 * 只在安装版弹（检测门槛在 composable 里），忽略一次后不再打扰。
 */
import type { SyncDeviceInfo } from '@/types'
import { computed } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { useDeviceClaim } from '@/composables/use-device-claim'
import { confirmAction } from '@/notify'

const claim = useDeviceClaim()
const open = computed({
  get: () => claim.open.value,
  // 点 X / 遮罩关闭也算「暂不处理」：落 flag，否则下次启动又弹一遍
  set: (value) => {
    if (!value)
      void claim.dismiss()
  },
})

function formatTime(ts: number): string {
  if (!ts)
    return ''
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

async function onClaim(device: SyncDeviceInfo): Promise<void> {
  const yes = await confirmAction(
    `认领「${device.name || device.id}」？本机现有数据会换成这台设备的历史，完成后需要重启应用。`,
    '认领旧设备',
    { confirmButtonText: '认领', cancelButtonText: '取消', type: 'warning' },
  )
  if (yes)
    await claim.claim(device)
}
</script>

<template>
  <AppDialog
    v-model="open"
    title="找回设备历史"
    width="520px"
    :show-close="!claim.claiming.value"
    :close-on-click-modal="!claim.claiming.value"
    :close-on-press-escape="!claim.claiming.value"
  >
    <p class="lead">
      这台机器是重新安装后新生成的标识，同步仓库里还留着下面这些设备的历史。认领其中一台，把它的用量、日志与设置找回来。
    </p>
    <p class="sub">
      网关流水与 Qoder 领取记录是脱敏副本，能恢复条数与花费估算，但密钥尾号找不回来。
    </p>
    <div class="devices">
      <div v-for="device in claim.candidates.value" :key="device.id" class="device">
        <div class="device-info">
          <span class="device-name">{{ device.name || device.id }}</span>
          <span v-if="formatTime(device.updatedAt)" class="device-time">{{ formatTime(device.updatedAt) }}</span>
        </div>
        <el-button
          size="small"
          type="primary"
          :loading="claim.claiming.value"
          @click="onClaim(device)"
        >
          认领
        </el-button>
      </div>
    </div>
    <template #footer>
      <el-button :disabled="claim.claiming.value" @click="claim.dismiss()">
        暂不处理
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.lead {
  margin: 0 0 var(--sp-2);
  line-height: 1.6;
}
.sub {
  margin: 0 0 var(--sp-3);
  color: var(--text-muted);
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.devices {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 320px;
  overflow-y: auto;
}
.device {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.device-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.device-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-time {
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
</style>
