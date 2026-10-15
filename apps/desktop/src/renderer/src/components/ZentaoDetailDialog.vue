<script setup lang="ts">
import type { ZentaoBugDetail } from '@/types'
import { ZENTAO_RESOLUTIONS, zentaoPriorityColor, zentaoResolutionLabel, zentaoSeverityColor, zentaoStatusLabel } from '@workbench/zentao'
import { computed, reactive, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'

/**
 * 禅道 Bug 详情弹窗：左侧信息与正文、右侧历史记录，底部一行是指派 / 解决两个动作。
 *
 * 只负责展示与收集输入 —— 取数、缓存、提交都在 `stores/zentao.ts`；动作结果经 `message`
 * 传回来（写操作不可逆，无论成败都明确回一句话）。正文与历史里的富文本早在域包被
 * `zentaoRichText` 压成了纯文本，这一层只做插值，**不解析 HTML、不注入**。
 *
 * 版式：整窗定高（高度口径在 global.css 的 `.el-dialog.zentao-dialog`），两栏各自滚，
 * 动作按钮钉在最下面那一行，不会被内容挤走。
 */
const props = defineProps<{
  detail: ZentaoBugDetail | null
  loading: boolean
  error: string
  /** 指派候选人（账号 + 姓名） */
  users: Array<{ account: string, realname: string }>
  /** 版本号（解决方案选「已解决」时要选） */
  builds: Array<{ id: number, name: string }>
  /** 提交中：挡重复点击 */
  submitting: boolean
  /** 上一次动作的结果（成功一句话 / 失败原因） */
  message: string
  /** 正文图片：站内路径 → data URL（空串表示取过但失败） */
  images: Record<string, string>
}>()

const emit = defineEmits<{
  assign: [payload: { bugId: number, assignedTo: string, comment: string }]
  resolve: [payload: { bugId: number, resolution: string, resolvedBuild: string, duplicateBug: string, comment: string }]
}>()

/** 弹窗开合由父组件持有（与其它弹层一样走 defineModel） */
const visible = defineModel<boolean>({ required: true })

/** 底部那一行现在是哪个动作（'' = 只摆按钮） */
const panel = ref<'' | 'assign' | 'resolve'>('')
const assignForm = reactive({ assignedTo: '', comment: '' })
const resolveForm = reactive({ resolution: '', resolvedBuild: '', duplicateBug: '', comment: '' })
const formError = ref('')

const statusText = computed(() => (props.detail ? zentaoStatusLabel(props.detail.status) : ''))
/** 已解决 / 已关闭的不再摆「解决」按钮（禅道里要先激活再解决，这里不给错的路） */
const canResolve = computed(() => props.detail?.status === 'active')

/** 换一条 Bug / 关掉弹窗：面板与草稿都复位 */
watch(() => [visible.value, props.detail?.id], () => {
  panel.value = ''
  formError.value = ''
  assignForm.assignedTo = ''
  assignForm.comment = ''
  resolveForm.resolution = ''
  resolveForm.resolvedBuild = ''
  resolveForm.duplicateBug = ''
  resolveForm.comment = ''
})

function openPanel(next: 'assign' | 'resolve'): void {
  panel.value = panel.value === next ? '' : next
  formError.value = ''
}

function submitAssign(): void {
  const bug = props.detail
  if (!bug)
    return
  if (!assignForm.assignedTo) {
    formError.value = '请选择指派对象'
    return
  }
  formError.value = ''
  emit('assign', { bugId: bug.id, assignedTo: assignForm.assignedTo, comment: assignForm.comment })
}

function submitResolve(): void {
  const bug = props.detail
  if (!bug)
    return
  if (!resolveForm.resolution) {
    formError.value = '请选择解决方案'
    return
  }
  if (resolveForm.resolution === 'fixed' && !resolveForm.resolvedBuild) {
    formError.value = '解决方案为「已解决」时必须选择版本号'
    return
  }
  if (resolveForm.resolution === 'duplicate' && !resolveForm.duplicateBug.trim()) {
    formError.value = '解决方案为「重复 Bug」时必须填写重复的 Bug 编号'
    return
  }
  formError.value = ''
  emit('resolve', {
    bugId: bug.id,
    resolution: resolveForm.resolution,
    resolvedBuild: resolveForm.resolvedBuild,
    duplicateBug: resolveForm.duplicateBug.trim(),
    comment: resolveForm.comment,
  })
}
</script>

<template>
  <AppDialog
    v-model="visible"
    class="zentao-dialog"
    :title="detail ? `#${detail.id} ${detail.title}` : 'Bug 详情'"
    width="880px"
    body-class="zentao-dialog__body"
    :close-on-click-modal="false"
  >
    <!-- 头部自绘：编号弱化、标题单行省略（拖动照旧，抓手还是 EP 的标题栏这一行） -->
    <template #header>
      <div class="detail__head">
        <span v-if="detail" class="detail__no mono">#{{ detail.id }}</span>
        <span class="detail__title truncate" :title="detail?.title">{{ detail?.title || 'Bug 详情' }}</span>
      </div>
    </template>
    <div class="detail">
      <p v-if="loading && !detail" class="detail__hint">
        正在读取 Bug 详情…
      </p>
      <p v-else-if="error" class="detail__error" role="alert">
        {{ error }}
      </p>

      <div v-else-if="detail" class="detail__grid">
        <!-- 左：信息 + 正文 -->
        <section class="detail__main">
          <!-- 明细行走项目统一的 .facts / .fact（左标签、右值），别再自己排一套 -->
          <dl class="facts">
            <div class="fact">
              <dt>状态</dt>
              <dd>{{ statusText }}</dd>
            </div>
            <div class="fact">
              <dt>产品</dt>
              <dd :title="detail.productName">
                {{ detail.productName || '—' }}
              </dd>
            </div>
            <div class="fact">
              <dt>严重程度</dt>
              <dd>
                <span class="detail__level">
                  <i
                    v-if="zentaoSeverityColor(detail.severity)"
                    class="detail__dot"
                    :style="{ background: zentaoSeverityColor(detail.severity) ?? 'transparent' }"
                  />{{ detail.severity ?? '—' }}
                </span>
              </dd>
            </div>
            <div class="fact">
              <dt>优先级</dt>
              <dd>
                <span class="detail__level">
                  <i
                    v-if="zentaoPriorityColor(detail.pri)"
                    class="detail__dot"
                    :style="{ background: zentaoPriorityColor(detail.pri) ?? 'transparent' }"
                  />{{ detail.pri ?? '—' }}
                </span>
              </dd>
            </div>
            <div class="fact">
              <dt>指派给</dt>
              <dd :title="detail.assignedTo">
                {{ detail.assignedTo || '—' }}
              </dd>
            </div>
            <div class="fact">
              <dt>创建</dt>
              <dd :title="`${detail.openedBy} · ${detail.openedDate}`">
                {{ detail.openedBy || '—' }} · {{ detail.openedDate || '—' }}
              </dd>
            </div>
            <div v-if="detail.status === 'resolved' || detail.status === 'closed'" class="fact">
              <dt>解决</dt>
              <dd :title="detail.resolvedBy">
                {{ zentaoResolutionLabel(detail.resolution) }} · {{ detail.resolvedBy || '—' }} · {{ detail.resolvedDate || '—' }}
              </dd>
            </div>
          </dl>

          <!-- 正文：域包已切成「文字块 + 图片块」，图片是宿主带会话取回来的 data URL -->
          <div v-if="detail.stepBlocks.length" class="detail__steps">
            <template v-for="(block, index) in detail.stepBlocks" :key="index">
              <pre v-if="block.kind === 'text'" class="detail__text">{{ block.text }}</pre>
              <img
                v-else-if="images[block.src]"
                class="detail__image"
                :src="images[block.src]"
                :alt="block.alt || 'Bug 正文图片'"
              >
              <p v-else class="detail__hint">
                {{ block.src in images ? '图片加载失败' : '正在加载图片…' }}
              </p>
            </template>
          </div>
          <p v-else class="detail__hint">
            没有正文
          </p>
        </section>

        <!-- 右：历史记录（窄栏，文字换行不横溢） -->
        <aside class="detail__side">
          <h4 class="detail__label">
            历史记录
          </h4>
          <p v-if="!detail.actions.length" class="detail__hint">
            暂无记录
          </p>
          <ol v-else class="detail__history">
            <li v-for="action in detail.actions" :key="action.id">
              <div class="detail__history-head">
                <span class="detail__actor">{{ action.actor || '—' }}</span>
                <span class="detail__date">{{ action.date }}</span>
              </div>
              <p v-if="action.desc" class="detail__desc">
                {{ action.desc }}
              </p>
              <p v-if="action.comment" class="detail__comment">
                {{ action.comment }}
              </p>
            </li>
          </ol>
        </aside>
      </div>

      <p v-else class="detail__hint">
        没有可显示的内容
      </p>

      <!-- 底部表单：展开时铺在两栏下面，按钮随之回到脚注那一行 -->
      <div v-if="panel" class="detail__form">
        <el-form v-if="panel === 'assign'" label-position="top" @submit.prevent>
          <el-form-item label="指派给" required>
            <el-select v-model="assignForm.assignedTo" filterable placeholder="选择成员" size="small">
              <el-option
                v-for="user in users"
                :key="user.account"
                :label="`${user.realname}（${user.account}）`"
                :value="user.account"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="assignForm.comment" type="textarea" :rows="2" />
          </el-form-item>
        </el-form>

        <el-form v-else label-position="top" @submit.prevent>
          <el-form-item label="解决方案" required>
            <el-select v-model="resolveForm.resolution" placeholder="选择解决方案" size="small">
              <el-option
                v-for="item in ZENTAO_RESOLUTIONS"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item v-if="resolveForm.resolution === 'fixed'" label="版本号" required>
            <el-select v-model="resolveForm.resolvedBuild" filterable placeholder="选择版本" size="small">
              <el-option
                v-for="build in builds"
                :key="build.id"
                :label="build.name"
                :value="String(build.id)"
              />
            </el-select>
          </el-form-item>
          <el-form-item v-if="resolveForm.resolution === 'duplicate'" label="重复的 Bug 编号" required>
            <el-input v-model="resolveForm.duplicateBug" size="small" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="resolveForm.comment" type="textarea" :rows="2" />
          </el-form-item>
        </el-form>

        <p v-if="formError" class="detail__error" role="alert">
          {{ formError }}
        </p>
      </div>
    </div>

    <template #footer>
      <div class="detail__footer">
        <div class="detail__footer-left">
          <template v-if="panel === ''">
            <el-button size="small" @click="openPanel('assign')">
              指派
            </el-button>
            <el-button v-if="canResolve" size="small" @click="openPanel('resolve')">
              解决
            </el-button>
          </template>
          <template v-else>
            <el-button size="small" :disabled="submitting" @click="panel = ''">
              取消
            </el-button>
            <el-button
              size="small"
              type="primary"
              :loading="submitting"
              :disabled="submitting"
              @click="panel === 'assign' ? submitAssign() : submitResolve()"
            >
              {{ panel === 'assign' ? '确认指派' : '确认解决' }}
            </el-button>
          </template>
        </div>
        <div class="detail__footer-right">
          <span v-if="message" class="detail__message" role="status">{{ message }}</span>
          <el-button size="small" @click="visible = false">
            关闭
          </el-button>
        </div>
      </div>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 头部：编号弱化、标题吃掉剩余宽度并单行省略（EP 的头部这一行仍是拖动抓手） */
.detail__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
  padding-right: var(--sp-3);
}

.detail__no {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.detail__title {
  min-width: 0;
  color: var(--ink);
  font-size: var(--fs-title);
  font-weight: 600;
}

/*
 * 整窗竖排。**用 flex 项而不是 height: 100%**：弹窗高度是自适应的（内容短就矮、超上限才封顶），
 * 百分比高度在 auto 父级上等于 auto，两栏就拿不到高度、长正文会被裁掉而不是自己滚。
 * 正文里 `.detail__grid { flex: 1; min-height: 0 }` 靠这一条才封得住。
 */
.detail {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  min-height: 0;
  padding: var(--sp-4);
}

.detail__grid {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: var(--sp-4);
  min-height: 0;
}

.detail__main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  overflow-y: auto;
}

.detail__side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
  padding-left: var(--sp-3);
  border-left: 1px solid var(--border);
  overflow: hidden;
}

.detail__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.detail__error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-meta);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.detail__label {
  flex-shrink: 0;
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-weight: 500;
}

/* 正文：块序列（文字 / 图片）。用一条左线分隔而不是大片灰底 —— 灰底在宽栏里显得空 */
.detail__steps {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-left: var(--sp-3);
  border-left: 2px solid var(--border);
}

.detail__text {
  margin: 0;
  color: var(--ink-2);
  font-family: inherit;
  font-size: var(--fs-meta);
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.detail__image {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
}

/* 等级色点：与列表同一口径（颜色来自域包） */
.detail__level {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}

.detail__dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

/*
 * 信息区借用全局 `.facts` / `.fact` 的行结构，但不沿用它那套 space-between ——
 * 那是给窄面板（标签值各顶一边）用的，放到 700px 宽的弹窗里会把标签与值拉得老远。
 * 这里改成「固定标签列 + 值跟在后面」，两列并排，紧凑也整齐。
 */
.detail__main :deep(.facts) {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.detail__main :deep(.fact) {
  justify-content: flex-start;
  gap: var(--sp-2);
}

.detail__main :deep(.fact dt) {
  flex: 0 0 60px;
  text-align: left;
}

.detail__main :deep(.fact dd) {
  flex: 1;
  font-weight: 500;
  /* 全局 .fact dd 是「单行 + 省略号」（窄面板里合适），这里放得下就该让值自己换行，
     否则产品名、创建时间会被截成「巩留县人民医院重…」这种半截话 */
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  overflow-wrap: anywhere;
}

.detail__history {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 0;
  margin: 0;
  padding-right: var(--sp-1);
  overflow-y: auto;
  list-style: none;
}

/* 时间轴：一根竖线 + 圆点；最后一条不再往下画线 */
.detail__history li {
  position: relative;
  padding-left: var(--sp-3);
  font-size: var(--fs-meta);
}

.detail__history li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
}

.detail__history li::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 15px;
  bottom: calc(-1 * var(--sp-3));
  width: 1px;
  background: var(--border);
}

.detail__history li:last-child::after {
  display: none;
}

.detail__history-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-1) var(--sp-2);
}

.detail__actor {
  color: var(--ink);
}

.detail__date {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.detail__desc,
.detail__comment {
  margin: 2px 0 0;
  color: var(--ink-2);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.detail__comment {
  padding-left: var(--sp-2);
  border-left: 2px solid var(--border);
  color: var(--ink-3);
}

.detail__form {
  flex-shrink: 0;
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
}

.detail__form :deep(.el-form-item) {
  margin-bottom: var(--sp-2);
}

/* 脚注：左边动作、右边关闭；动作结果那句话贴在关闭按钮左边 */
.detail__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  width: 100%;
}

.detail__footer-left,
.detail__footer-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.detail__message {
  color: var(--st-ok);
  font-size: var(--fs-meta);
}
</style>
