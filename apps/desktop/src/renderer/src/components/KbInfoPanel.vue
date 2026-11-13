<script setup lang="ts">
import type { KbStats } from '@workbench/kb'
/**
 * 知识库概览（右栏的默认内容）：原始数据的几个数与仓库归属。
 *
 * **界面只说原始文件的事**：清洗出来的条目、索引这些产物用户不关心也不展示 ——
 * 这里只有「多少原始文件、多少等着洗」与「仓库连没连远端」两块。
 * 全是父层算好的数字（props 只读）。
 */
import { computed } from 'vue'

const props = defineProps<{
  stats: KbStats
  /** 知识库文件夹在不在 git 仓库里 */
  isRepo: boolean
  /** origin 地址；空串 = 没连远端 */
  repoOrigin: string
}>()

const repoText = computed(() => {
  if (!props.isRepo)
    return '不在 git 仓库里：没有版本记录，也没法在这里同步'
  if (!props.repoOrigin)
    return '在 git 仓库里，但还没连远端：版本只留本机'
  return `已连远端：${props.repoOrigin}`
})
</script>

<template>
  <div class="kb-info">
    <div class="kb-info__scroll">
      <section class="kb-info__block">
        <h3 class="kb-info__title">
          概览
        </h3>
        <dl class="kb-info__facts">
          <div class="kb-info__fact">
            <dt>原始数据</dt>
            <dd>
              {{ stats.raws }}<template v-if="stats.pending + stats.stale > 0">
                （未入库 {{ stats.pending }} · 有更新 {{ stats.stale }}）
              </template>
            </dd>
          </div>
        </dl>
      </section>

      <section class="kb-info__block">
        <h3 class="kb-info__title">
          仓库
        </h3>
        <p class="kb-info__note" :class="{ 'kb-info__warn': !isRepo || !repoOrigin }">
          {{ repoText }}
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.kb-info {
  min-height: 0;
  height: 100%;
}

.kb-info__scroll {
  height: 100%;
  overflow-y: auto;
  padding: var(--sp-3);
}

.kb-info__block + .kb-info__block {
  margin-top: var(--sp-4);
}

.kb-info__title {
  margin: 0 0 var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  font-weight: 600;
}

/* 事实清单：与首页那套 .facts 同一种「名 + 值」的读法，但这是本组件私有的摆法 */
.kb-info__facts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0;
}

.kb-info__fact {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

.kb-info__fact dt {
  flex-shrink: 0;
  min-width: 64px;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.kb-info__fact dd {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-body);
}

.kb-info__note {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.7;
  word-break: break-all;
}

.kb-info__warn {
  color: var(--ink);
}

.kb-info__warn .mono {
  color: var(--ink-2);
}
</style>
