<script lang="ts">
import type { PoolCreditsShape } from '@/status'
</script>

<script setup lang="ts">
/**
 * 网关页的账号卡列表：头像 / 名称 / 状态 / 查余额 / 启停 / 删除 / 优先级 / 积分条 / 三格用量。
 *
 * TBuddy 与 Qoder 两页**同构**（`docs/modules/gateway.md` 与 `qoder.md`），所以卡片只写这一份；
 * 页面把各自的账号映射成 [`AccountCardView`] 交进来，动作经 emit 带走。
 * 统计卡与右下角浮动键仍归页面：那两处两页长得不一样（Qoder 没有统计卡）。
 */
import { Connection } from '@element-plus/icons-vue'
import EmptyState from '@/components/EmptyState.vue'
import { formatCompactTokens } from '@/format'
import { poolMeterTone as meterClass, poolBalanceText as number, poolRemainPercent as remainPercent } from '@/status'

/**
 * 账号卡要显示的一切，由页面算好交进来 —— 这里不认 TBuddy / Qoder 的账号结构，
 * 只认「这张卡长什么样」。两套网关页共用这一份卡片列表。
 */
export interface AccountCardView {
  /** 账号 id（查余额 / 启停 / 删除都按它回传） */
  uid: string
  label: string
  /** 停着 / 在用：决定「停用 / 启用」那颗按钮的字 */
  enabled: boolean
  priority: number
  /** 状态色（`poolStatusTone` 的结果：is-ok / is-muted / is-warn / is-fail） */
  tone: string
  /** 状态标签（`poolStatusText` 的结果） */
  status: string
  /** 状态标签的 title（失败原因；没有就不给） */
  statusTitle?: string
  /** 额度恢复提示（`poolQuotaHint` 的结果），空串表示没有 */
  quota: string
  /** 余额快照（没查过是 null） */
  credits: PoolCreditsShape | null
  /** 临期提示（`poolExpiryHint` 的结果） */
  expiry: { text: string, title: string } | null
  /** 这一栏的用量：成功 / 失败、总 token、均速；没有流水是 null */
  usage: { requests: number, failed: number, tokens: number, tokensPerSec: number } | null
}

const props = defineProps<{
  accounts: AccountCardView[]
  /** 单个号「查余额」在途 */
  creditsBusy: Record<string, boolean>
  emptyText: string
  emptyHint: string
}>()

const emit = defineEmits<{
  'query': [uid: string]
  'toggle': [uid: string]
  'remove': [uid: string]
  'priority': [uid: string, value: number | undefined]
  'open-credits': [uid: string]
}>()
</script>

<template>
  <div v-if="!props.accounts.length" class="panel">
    <EmptyState compact :icon="Connection" :text="props.emptyText" :hint="props.emptyHint" />
  </div>

  <div v-else class="acct__list">
    <article
      v-for="account in props.accounts"
      :key="account.uid"
      class="panel acct"
      :class="account.tone"
    >
      <div class="acct__head">
        <span class="acct__avatar">{{ account.label.slice(0, 1) }}</span>
        <div class="acct__id">
          <span class="acct__name">{{ account.label }}</span>
          <span class="acct__tag" :class="account.tone" :title="account.statusTitle">{{ account.status }}</span>
        </div>
        <div class="acct__actions">
          <el-button size="small" text :loading="props.creditsBusy[account.uid]" @click="emit('query', account.uid)">
            查余额
          </el-button>
          <el-button size="small" text @click="emit('toggle', account.uid)">
            {{ account.enabled ? '停用' : '启用' }}
          </el-button>
          <el-button size="small" text @click="emit('remove', account.uid)">
            删除
          </el-button>
        </div>
      </div>

      <!-- 额度恢复提示（多数账号平时没有）与优先级并作一排：提示在左、优先级在右，
           省下单独一行；行高由优先级输入框兜着，提示空着（隐藏但占位）也不影响同排卡片对齐 -->
      <div class="acct__meta">
        <span
          class="acct__sub"
          :class="{ 'is-empty': !account.quota }"
          :title="account.quota || undefined"
        >{{ account.quota || '—' }}</span>
        <span class="acct__priority">
          <span class="acct__dim">优先级</span>
          <el-input-number
            :model-value="account.priority"
            :min="1"
            :max="100"
            :step="1"
            size="small"
            controls-position="right"
            @change="(value: number | undefined) => emit('priority', account.uid, value)"
          />
        </span>
      </div>

      <!-- 点这一块看逐包到期：卡片只放得下「剩余 / 总额」，说不出哪天作废 -->
      <div
        class="acct__credits"
        role="button"
        tabindex="0"
        :aria-label="`查看 ${account.label} 的积分明细`"
        @click="emit('open-credits', account.uid)"
        @keydown.enter.prevent="emit('open-credits', account.uid)"
        @keydown.space.prevent="emit('open-credits', account.uid)"
      >
        <div class="acct__credits-line">
          <span class="acct__dim">积分</span>
          <template v-if="account.credits">
            <span class="acct__num">{{ number(account.credits.remain) }}</span>
            <span class="acct__dim">/ {{ number(account.credits.size) }}</span>
            <span v-if="account.credits.size > 0 || account.expiry" class="acct__aside">
              <span v-if="account.credits.size > 0" class="acct__used">
                已用 <span class="acct__used-num">{{ number(Math.max(0, account.credits.size - account.credits.remain)) }}</span>
              </span>
              <span
                v-if="account.expiry"
                class="acct__expiry"
                :title="account.expiry.title"
              >{{ account.expiry.text }}</span>
            </span>
          </template>
          <span v-else class="acct__dim">未查询</span>
        </div>
        <!-- 余额条同样始终占位：没查过余额的卡不能比查过的卡少一截，否则三格又错开 -->
        <span class="acct__meter" :class="{ 'is-empty': !account.credits }">
          <span
            v-if="account.credits"
            class="acct__meter-fill"
            :class="meterClass(account.credits)"
            :style="{ width: `${remainPercent(account.credits)}%` }"
          />
        </span>
      </div>

      <div class="acct__facts">
        <div class="acct__fact">
          <span class="acct__fact-label">成功 / 失败</span>
          <span class="acct__fact-value">
            <template v-if="account.usage">
              {{ account.usage.requests - account.usage.failed }} / {{ account.usage.failed }}
            </template>
            <span v-else class="acct__dim">—</span>
          </span>
        </div>
        <div class="acct__fact">
          <span class="acct__fact-label">用量</span>
          <span class="acct__fact-value">
            {{ account.usage ? formatCompactTokens(account.usage.tokens) : '—' }}
          </span>
        </div>
        <div class="acct__fact">
          <span class="acct__fact-label">均速</span>
          <span class="acct__fact-value">
            {{ account.usage ? `${account.usage.tokensPerSec.toFixed(0)} tok/s` : '—' }}
          </span>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.acct__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: var(--sp-3);
}

.panel.acct {
  position: relative;
  gap: var(--sp-2);
  padding: var(--sp-3);
  overflow: hidden;
  /* 卡面也铺一层极淡的状态色：整页才不至于一片灰 */
  background-image: radial-gradient(
    120% 120% at 100% 0%,
    color-mix(in srgb, var(--card-color) 7%, transparent),
    transparent 55%
  );
}

/**
 * 左侧一截状态色标：与用量页的积分总账同一套做法 ——
 * 颜色只表达状态（可用绿 / 待续期灰 / 额度用完琥珀 / 已停用红），不做装饰。
 */
.acct::before {
  content: '';
  position: absolute;
  top: var(--sp-3);
  bottom: var(--sp-3);
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--card-color, transparent);
}

.acct.is-ok {
  --card-color: var(--st-ok);
}

.acct.is-warn {
  --card-color: var(--st-run);
}

.acct.is-fail {
  --card-color: var(--st-fail);
}

.acct.is-muted {
  --card-color: var(--ink-3);
}

.acct__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-2);
}

/* 账号头像：首字 + 账号色（紫，与统计卡的紫同一套），给每张卡一个颜色锚点 */
.acct__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--type-color) 15%, transparent);
  color: var(--type-color);
  font-size: var(--gw-fs-title);
  font-weight: 600;
  --type-color: #7c3aed;
}

.acct__id {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

/* 状态标签跟在名称下面：列方向下不拉伸，保持小标签的形状 */
.acct__id .acct__tag {
  align-self: flex-start;
}

.acct__name {
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acct__tag {
  display: inline-block;
  flex: none;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--gw-fs-micro);
}

.acct__tag.is-ok {
  color: var(--st-ok);
}

/* 待续期是「等一下」：中性灰；额度用完用琥珀，停用才是红 */
.acct__tag.is-muted {
  color: var(--ink-3);
}

.acct__tag.is-warn {
  color: var(--st-run);
}

.acct__tag.is-fail {
  color: var(--st-fail);
}

.acct__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.acct__priority {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.acct__priority :deep(.el-input-number) {
  width: 76px;
}

/* 与优先级同一排的那行小字（目前只有额度恢复时间）。
   空着时也**隐藏而不是删掉**：这一排的高度由优先级输入框兜着，
   它占住左边的位子，同排卡片的积分条与三格才对得齐；太长时截断，完整内容在 title 里。 */
.acct__sub {
  overflow: hidden;
  font-size: var(--gw-fs-micro);
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink-3);
}

.acct__sub.is-empty {
  visibility: hidden;
}

.acct__credits {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  /* 整块可点开积分明细：手型 + 悬停浅底给反馈。
     热区用「内边距 + 等量负外边距」撑开，内容位置不动 */
  padding: var(--sp-1) var(--sp-2);
  margin: calc(var(--sp-1) * -1) calc(var(--sp-2) * -1);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 120ms var(--ease-out);
}

.acct__credits:hover {
  background: color-mix(in srgb, var(--ink-3) 8%, transparent);
}

.acct__credits:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}

.acct__credits-line {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  font-variant-numeric: tabular-nums;
}

/* 已用量与临期天数一起贴着行尾：剩多少、用了多少、哪天作废在同一行读完 */
.acct__aside {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-left: auto;
}

.acct__used {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.acct__used-num {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--ink-2);
}

/* 临期天数：与「已用」用一条细竖线隔开 —— 一个是已经发生的，一个是接下来要来的 */
.acct__expiry {
  padding-left: var(--sp-2);
  border-left: 1px solid var(--border);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.acct__num {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}

.acct__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

/**
 * 余额条：彩色那段是**剩余**（≥50% 绿 / 20–50% 琥珀 / <20% 红），
 * 空出来的灰底是**已用** —— 所以底色取 `--bg-inset` 而不是几乎看不见的 `--bg-subtle`。
 */
.acct__meter {
  display: block;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  overflow: hidden;
}

/* 没查过余额时留出同一条的高度，别让这张卡的三格比旁边高 */
.acct__meter.is-empty {
  visibility: hidden;
}

.acct__meter-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ink-3);
}

.acct__meter-fill.is-ok {
  background: var(--st-ok);
}

.acct__meter-fill.is-warn {
  background: var(--st-run);
}

.acct__meter-fill.is-fail {
  background: var(--st-fail);
}

.acct__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.acct__fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.acct__fact-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.acct__fact-value {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-meta);
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 操作按钮在卡片的右上角 */
.acct__actions {
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--sp-1);
}
</style>
