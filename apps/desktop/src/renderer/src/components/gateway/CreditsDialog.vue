<script setup lang="ts">
import type { CreditExpiryTier } from '@workbench/usage'
import type { GatewayCredits, GatewayPackage } from '@/workbench/gateway'
import { Coin } from '@element-plus/icons-vue'
import { creditExpiry, creditExpiryDate } from '@workbench/usage'
import { computed } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import EmptyState from '@/components/EmptyState.vue'

/**
 * 积分明细弹层：账号卡上的「积分」点开就是它。
 *
 * 上游是**逐包记账**（签到包、成长包、裂变包各有各的到期时刻），账号卡那一行只能给
 * 「剩余 / 总额」，说不出「哪天作废」。这里按包列出来、按到期时间从近到远排 ——
 * 先花快过期的，别让积分烂在包里。
 *
 * 到期档位是这一层唯一的彩色：≤10 天琥珀、≤5 天橙、≤3 天红、今日红实心；
 * 已过期 / 无期限 / 未知一律灰的 —— 它们不催你做任何事。
 * **只列还有剩余的包**：花光的包没有「什么时候作废」可言。
 *
 * 这一层不碰网络：查余额由网关页发起（弹层只 emit `refresh`），
 * 所以快照永远只有一份，弹层与账号卡读的是同一个 `credits`。
 */
const props = defineProps<{
  /** 账号名（弹层标题用） */
  label: string
  /** 这个号的余额快照；null = 还没查过 */
  credits: GatewayCredits | null
  /** 正在向上游查询（只在没有快照时铺遮罩，有快照就静默刷） */
  loading?: boolean
}>()

const emit = defineEmits<{
  /** 让网关页去查一次余额 */
  refresh: []
}>()

const open = defineModel<boolean>({ required: true })

/** 一行 = 一个包 + 它落在哪一档 */
interface Row {
  key: string
  name: string
  remain: number
  size: number
  /** 到期日 `YYYY-MM-DD`；无期限 / 未知是空串 */
  date: string
  /** 排序用：无期限 / 未知沉底 */
  sortAt: number
  tier: CreditExpiryTier
  hint: string
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function rowOf(item: GatewayPackage, index: number, enterprise: boolean, now: number): Row {
  const verdict = creditExpiry(item, now, { enterprise })
  const at = item.expiresAt
  // 个人号的无期限包没有「哪天」可说；企业额度把周期结束日给出来
  const date = at !== null && (!item.noExpiry || enterprise) ? creditExpiryDate(at) : ''
  return {
    key: `${item.code || item.name}-${at ?? 'none'}-${index}`,
    name: item.name,
    remain: item.remain,
    size: item.size,
    date,
    sortAt: at ?? Number.POSITIVE_INFINITY,
    tier: verdict.tier,
    hint: verdict.hint,
  }
}

const rows = computed<Row[]>(() => {
  const now = Math.floor(Date.now() / 1000)
  const enterprise = props.credits?.enterprise === true
  return (props.credits?.packages ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.remain > 0)
    .map(({ item, index }) => rowOf(item, index, enterprise, now))
    .sort((left, right) => {
      // 无期限 / 到期未知沉底；两者之间保持上传顺序（sort 是稳定的）
      if (left.sortAt === right.sortAt)
        return 0
      return left.sortAt - right.sortAt
    })
})

const used = computed(() => {
  const credits = props.credits
  if (!credits)
    return 0
  return Math.max(0, credits.size - credits.remain)
})
</script>

<template>
  <AppDialog
    v-model="open"
    :title="label ? `积分明细 · ${label}` : '积分明细'"
    width="520"
    align-center
  >
    <div v-loading="loading && !credits" class="credits">
      <template v-if="credits && rows.length">
        <div class="credits__summary">
          <span class="credits__sum-main">
            <span class="credits__sum-num">{{ number(credits.remain) }}</span>
            <span class="credits__dim">/ {{ number(credits.size) }}</span>
          </span>
          <span class="credits__sum-side">
            已用 <span class="credits__sum-used">{{ number(used) }}</span>
          </span>
          <span class="credits__sum-side">
            {{ rows.length }} 个包
          </span>
        </div>

        <ul class="credits__list">
          <li
            v-for="row in rows"
            :key="row.key"
            class="credits__row"
            :class="`is-${row.tier}`"
          >
            <div class="credits__pack">
              <span class="credits__name" :title="row.name">{{ row.name }}</span>
              <span class="credits__amount">
                {{ number(row.remain) }}<span v-if="row.size > 0" class="credits__dim"> / {{ number(row.size) }}</span>
              </span>
            </div>
            <div class="credits__due">
              <span class="credits__date">{{ row.date || '—' }}</span>
              <span class="credits__chip">{{ row.hint }}</span>
            </div>
          </li>
        </ul>
      </template>

      <EmptyState
        v-else-if="credits"
        compact
        :icon="Coin"
        text="没有还有剩余的包"
        hint="已经花完或已过期"
      />

      <EmptyState
        v-else
        compact
        :icon="Coin"
        text="还没查过余额"
      >
        <template #actions>
          <el-button size="small" :loading="loading" @click="emit('refresh')">
            查余额
          </el-button>
        </template>
      </EmptyState>
    </div>

    <template #footer>
      <el-button size="small" :loading="loading" @click="emit('refresh')">
        刷新
      </el-button>
      <el-button size="small" type="primary" @click="open = false">
        关闭
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.credits {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 168px;
  font-size: var(--gw-fs-body);
}

.credits__summary {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border);
}

.credits__sum-main {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  margin-right: auto;
}

.credits__sum-num {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.credits__sum-side {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.credits__sum-used {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--ink-2);
}

.credits__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.credits__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.credits__row:last-child {
  border-bottom: none;
}

.credits__pack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.credits__name {
  overflow: hidden;
  font-size: var(--gw-fs-meta);
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.credits__amount {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}

.credits__due {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--sp-2);
}

.credits__date {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--ink-3);
}

.credits__chip {
  min-width: 68px;
  padding: 1px var(--sp-2);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--gw-fs-micro);
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}

/* 四档倒计时：≤10 琥珀、≤5 橙、≤3 红、今日红实心；
   已过期 / 无期限 / 未知不催动作，保持灰的 */
.credits__row.is-d10 .credits__chip {
  background: var(--st-run-soft);
  color: var(--st-run);
}

.credits__row.is-d5 .credits__chip {
  --tier-ink: color-mix(in srgb, var(--st-run) 55%, var(--st-fail));
  border-color: color-mix(in srgb, var(--tier-ink) 35%, transparent);
  background: color-mix(in srgb, var(--st-run-soft) 55%, var(--st-fail-soft));
  color: var(--tier-ink);
}

.credits__row.is-d3 .credits__chip {
  border-color: color-mix(in srgb, var(--st-fail) 35%, transparent);
  background: var(--st-fail-soft);
  color: var(--st-fail);
}

.credits__row.is-today .credits__chip {
  border-color: var(--st-fail);
  background: var(--st-fail);
  color: var(--bg-surface);
}
</style>
