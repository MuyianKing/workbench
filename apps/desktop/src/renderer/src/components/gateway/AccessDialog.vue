<script setup lang="ts">
import { CopyDocument, Hide, Refresh, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'
import AppDialog from '@/components/AppDialog.vue'

/**
 * 接入信息弹层：第三方客户端要填的两样 —— 地址与密钥。
 *
 * 它以前是页首那张常驻卡片。改成弹层是因为那张卡**一直**把下面三栏往下推，
 * 而这两样是「配客户端时抄一次」的东西，不是每眼都要看的东西。
 *
 * 弹层里**不放启停**：启停是页首那一格的事（那里一眼就能看见运行状态，点一下就开关）。
 * 这里只管「对着抄」，多一排按钮反而要多想一步「运行中该点哪个」。
 *
 * 模型也不在这儿列：清单在「模型」那一栏（同一份 `SEED_MODELS`），
 * 弹框里再抄一遍只会让同一串 id 在界面上出现两次。
 *
 * 这一层只管展示与复制：换密钥由网关页发起 —— 它持有 `running` / `busy` 与轮询，
 * 这里 emit 出去，免得两个地方各存一份状态、各自 refresh 一次。
 */
const props = defineProps<{
  /** 运行中端口不可改：Rust 侧启动那一下就绑死了 */
  running: boolean
  baseUrl: string
  apiKey: string
}>()

const emit = defineEmits<{
  /** 换一个密钥（确认框与落盘在网关页，这里只把意图递出去） */
  rotate: []
}>()

const open = defineModel<boolean>({ required: true })
/** 端口跟着网关页走：它每次 refresh 都把真值写回来，这里不另存一份 */
const port = defineModel<number>('port', { required: true })

/** 密钥默认遮住：弹层一开就在屏幕上，没必要整串亮着 */
const reveal = ref(false)

const keyText = computed(() => {
  if (!props.apiKey)
    return '尚未生成（启动后自动生成）'
  if (reveal.value)
    return props.apiKey
  return props.apiKey.length <= 12
    ? props.apiKey
    : `${props.apiKey.slice(0, 8)}${'•'.repeat(12)}${props.apiKey.slice(-4)}`
})

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制${label}`)
  }
  catch {
    ElMessage.error('复制失败，手动选中即可')
  }
}

/** 换完密钥顺手亮出来：换的目的多半就是马上粘到别处 */
function rotate(): void {
  reveal.value = true
  emit('rotate')
}
</script>

<template>
  <!-- penetrable：这三样都是抄到别的客户端去用的（见 AppDialog.vue 的「挡不挡背后」） -->
  <AppDialog v-model="open" title="接入信息" width="560" align-center penetrable>
    <div class="access">
      <div class="access__row">
        <span class="access__label">端口</span>
        <el-input-number
          v-model="port"
          class="access__port"
          :min="1024"
          :max="65535"
          size="small"
          controls-position="right"
          :disabled="running"
        />
      </div>

      <div class="access__row">
        <span class="access__label">API 地址</span>
        <code class="access__value">{{ baseUrl }}</code>
        <el-tooltip content="复制地址" placement="top">
          <el-button size="small" text :icon="CopyDocument" aria-label="复制地址" @click="copy(baseUrl, '地址')" />
        </el-tooltip>
      </div>

      <div class="access__row">
        <span class="access__label">API Key</span>
        <code class="access__value">{{ keyText }}</code>
        <el-tooltip :content="reveal ? '隐藏密钥' : '显示密钥'" placement="top">
          <el-button
            size="small"
            text
            :icon="reveal ? Hide : View"
            :aria-label="reveal ? '隐藏密钥' : '显示密钥'"
            :disabled="!apiKey"
            @click="reveal = !reveal"
          />
        </el-tooltip>
        <el-tooltip content="复制密钥" placement="top">
          <el-button size="small" text :icon="CopyDocument" aria-label="复制密钥" :disabled="!apiKey" @click="copy(apiKey, '密钥')" />
        </el-tooltip>
        <el-tooltip content="换一个密钥" placement="top">
          <el-button size="small" text :icon="Refresh" aria-label="换一个密钥" @click="rotate" />
        </el-tooltip>
      </div>
    </div>

    <template #footer>
      <el-button @click="open = false">
        关闭
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.access {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* 一行三件：标签定宽、值吃满、动作靠右 —— 与前身那张卡片同一副排法 */
.access__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.access__label {
  flex: none;
  width: 64px;
  font-size: var(--gw-fs-meta);
  color: var(--ink-3);
}

.access__port {
  flex: none;
  width: 104px;
}

/**
 * 地址与密钥：**不画灰底**，两行等宽字直接排在卡片上。
 * 加了底色反而像输入框（它们只读），还多一层灰度把弹框压得更闷。
 */
.access__value {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--gw-fs-meta);
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
