<script setup lang="ts">
import type { RunRecord } from '@/types'
import { computed } from 'vue'
import { formatDurationOrDash, formatTimestamp } from '@/format'
import { useProjectsStore } from '@/stores/projects'

/**
 * 项目详情抽屉的「运行记录」：最近几次执行的结果、命令与耗时。
 *
 * 从 `ProjectDrawer.vue` 拆出来的整块。
 */
const store = useProjectsStore()

const history = computed<RunRecord[]>(() => store.drawerProject?.history ?? [])

const RESULT_META: Record<RunRecord['result'], { label: string, tone: string }> = {
  success: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'fail' },
  stopped: { label: '已停止', tone: 'idle' },
}
</script>

<template>
  <section class="block">
    <h3 class="section-title">
      运行记录
    </h3>

    <ul v-if="history.length" class="history">
      <li v-for="record in history" :key="record.id" class="history__row">
        <span class="history__result" :class="`tone-${RESULT_META[record.result].tone}`">
          {{ RESULT_META[record.result].label }}
        </span>
        <span class="history__cmd mono truncate" :title="record.command">
          {{ record.command }}
        </span>
        <span class="history__meta mono">
          {{ formatTimestamp(record.startedAt) }} · {{ formatDurationOrDash(record.durationMs) }}
        </span>
      </li>
    </ul>
    <p v-else class="field__hint">
      还没有执行记录。
    </p>
  </section>
</template>

<style scoped>
/* ---------- 运行记录 ---------- */
.history {
  display: flex;
  flex-direction: column;
}

.history__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 9px 0;
  font-size: var(--fs-body);
}

.history__row + .history__row {
  border-top: 1px solid var(--border);
}

.history__result {
  flex-shrink: 0;
  width: 46px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.history__result.tone-ok {
  color: var(--st-ok);
}

.history__result.tone-fail {
  color: var(--st-fail);
}

.history__cmd {
  flex: 1;
  min-width: 0;
  color: var(--ink-2);
}

.history__meta {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}
</style>
