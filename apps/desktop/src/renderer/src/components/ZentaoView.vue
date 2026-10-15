<script setup lang="ts">
import type { ZentaoAssignInput, ZentaoBrowse, ZentaoBug, ZentaoResolveInput } from '@/types'
import { Link, Refresh } from '@element-plus/icons-vue'
import { ZENTAO_BROWSE_OPTIONS, zentaoPriorityColor, zentaoSeverityColor, zentaoStatusLabel } from '@workbench/zentao'
import { computed, onMounted, ref } from 'vue'
import PanelLoading from '@/components/PanelLoading.vue'
import ZentaoDetailDialog from '@/components/ZentaoDetailDialog.vue'
import { useZentaoStore } from '@/stores/zentao'

/**
 * 禅道页：会话、取数、详情与写操作都在 store 里（它同时服务后台检查与通知点击），
 * 这一层只管展示与把用户的操作转成 store 调用。
 */
const store = useZentaoStore()
const session = computed(() => store.session)
const bugList = computed(() => store.bugList)
const loading = computed(() => store.loading)
const error = computed(() => store.error)
const checkedAtText = computed(() => {
  if (!bugList.value)
    return ''
  const date = new Date(bugList.value.checkedAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
})

/** 详情弹窗的开合：store 里的 activeBugId 是「看哪条」，这里是「开没开」 */
const detailOpen = ref(false)

function openZentao(bug?: ZentaoBug): void {
  void store.openBug(bug)
}

function openDetail(bug: ZentaoBug): void {
  detailOpen.value = true
  void store.openDetail(bug.id)
}

function onDetailVisible(value: boolean): void {
  detailOpen.value = value
  if (!value)
    store.closeDetail()
}

function onAssign(input: ZentaoAssignInput): void {
  void store.assign(input)
}

function onResolve(input: ZentaoResolveInput): void {
  void store.resolve(input)
}

onMounted(() => {
  store.ensureLoaded()
})
</script>

<template>
  <main class="zentao-view">
    <section class="panel zentao-view__panel">
      <header class="filter panel__head">
        <div class="filter__head head">
          <h2 class="head__title">
            禅道
          </h2>
          <span v-if="session" class="head__account mono truncate" :title="session.account">
            {{ session.account }}
          </span>
        </div>
        <div class="filter__tools">
          <el-tooltip content="刷新" placement="bottom">
            <el-button
              text
              size="small"
              :icon="Refresh"
              :loading="loading"
              :disabled="loading"
              aria-label="刷新"
              @click="store.refresh()"
            />
          </el-tooltip>
          <template v-if="session">
            <el-tooltip content="打开禅道" placement="bottom">
              <el-button
                text
                size="small"
                :icon="Link"
                aria-label="打开禅道"
                @click="openZentao()"
              />
            </el-tooltip>
          </template>
        </div>
      </header>

      <div class="zentao-view__summary">
        <el-segmented
          :model-value="store.browse"
          :options="ZENTAO_BROWSE_OPTIONS"
          size="small"
          @change="(value: ZentaoBrowse) => store.setBrowse(value)"
        />
        <span v-if="bugList" class="zentao-view__stats">
          {{ bugList.bugs.length }} 条 · {{ bugList.productCount }} 个产品
        </span>
      </div>
      <p v-if="error" class="zentao-view__error" role="alert">
        {{ error }}
      </p>
      <PanelLoading v-if="loading && !bugList" text="正在读取禅道列表…" />
      <el-table
        v-else-if="bugList && bugList.bugs.length"
        class="zentao-view__table"
        :data="bugList.bugs"
        row-key="id"
        height="100%"
      >
        <el-table-column prop="id" label="编号" width="88">
          <template #default="{ row }">
            <span class="mono">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="260">
          <template #default="{ row }">
            <button
              class="zentao-view__bug-title truncate"
              type="button"
              :title="row.title"
              @click="openDetail(row)"
            >
              {{ row.title }}
            </button>
          </template>
        </el-table-column>
        <el-table-column prop="productName" label="产品" min-width="150" show-overflow-tooltip />
        <el-table-column prop="assignedTo" label="指派给" width="110" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.assignedTo || '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="openedBy" label="创建者" width="110" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.openedBy || '—' }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            {{ zentaoStatusLabel(row.status) }}
          </template>
        </el-table-column>
        <el-table-column label="严重程度" width="96" align="center">
          <template #default="{ row }">
            <span class="zentao-view__level">
              <!-- 等级色点：颜色口径只在域包 zentaoSeverityColor 里定义 -->
              <i
                v-if="zentaoSeverityColor(row.severity)"
                class="zentao-view__level-dot"
                :style="{ background: zentaoSeverityColor(row.severity) ?? 'transparent' }"
              />
              <span class="mono">{{ row.severity ?? '—' }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="96" align="center">
          <template #default="{ row }">
            <span class="zentao-view__level">
              <i
                v-if="zentaoPriorityColor(row.pri)"
                class="zentao-view__level-dot"
                :style="{ background: zentaoPriorityColor(row.pri) ?? 'transparent' }"
              />
              <span class="mono">{{ row.pri ?? '—' }}</span>
            </span>
          </template>
        </el-table-column>
      </el-table>
      <div v-else-if="error" class="zentao-view__retry">
        <el-button size="small" :disabled="loading" @click="store.refresh()">
          重试
        </el-button>
      </div>
      <div v-else-if="bugList" class="empty">
        <p>没有符合条件的 Bug</p>
      </div>
      <p v-if="store.notifyError" class="zentao-view__error" role="alert">
        {{ store.notifyError }}
      </p>
      <footer v-if="bugList && checkedAtText" class="panel__foot zentao-view__foot">
        <span>更新于 {{ checkedAtText }}</span>
      </footer>
    </section>

    <!-- 详情与它的两个写操作（指派 / 解决）都在弹窗里；AppDialog 负责遮罩与拖动 -->
    <ZentaoDetailDialog
      :model-value="detailOpen"
      :detail="store.detail"
      :loading="store.detailLoading"
      :error="store.detailError"
      :users="store.users"
      :builds="store.builds"
      :submitting="store.submitting"
      :message="store.actionMessage"
      :images="store.images"
      @update:model-value="onDetailVisible"
      @assign="onAssign"
      @resolve="onResolve"
    />
  </main>
</template>

<style scoped>
.zentao-view {
  display: flex;
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, var(--sp-3)) var(--card-gap, var(--sp-3));
}

.zentao-view__panel {
  flex: 1;
  min-height: 0;
}

.zentao-view__panel > .filter {
  min-height: var(--h-filter);
  padding-bottom: var(--sp-2);
  background: transparent;
}

.head {
  align-items: baseline;
}

.head__title {
  flex-shrink: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.head__account {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.zentao-view__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-3);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.zentao-view__stats,
.zentao-view__foot {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.zentao-view__error {
  flex-shrink: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.zentao-view__table {
  flex: 1;
  min-height: 0;
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: var(--bg-subtle);
  --el-table-header-text-color: var(--ink-3);
  --el-table-text-color: var(--ink-2);
  --el-table-border-color: var(--border);
  --el-table-row-hover-bg-color: var(--bg-subtle);
}

.zentao-view__bug-title {
  display: block;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.zentao-view__bug-title:hover {
  text-decoration: underline;
}

.zentao-view__retry {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
}

/* 严重程度 / 优先级：用色点区分等级，数字仍走常规字色（黄绿在白底上做文字会糊） */
.zentao-view__level {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}

.zentao-view__level-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
</style>
