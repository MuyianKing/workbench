<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ProjectBasicSection from '@/components/ProjectBasicSection.vue'
import ProjectCommandsSection from '@/components/ProjectCommandsSection.vue'
import ProjectDrawerHeader from '@/components/ProjectDrawerHeader.vue'
import ProjectEnvSection from '@/components/ProjectEnvSection.vue'
import ProjectOutputSection from '@/components/ProjectOutputSection.vue'
import ProjectRunHistorySection from '@/components/ProjectRunHistorySection.vue'
import { useProjectsStore } from '@/stores/projects'

/**
 * 项目详情抽屉的壳：只有开关动画与排版，内容按区块拆在 `Project*Section.vue` 里。
 *
 * 拆分的理由不是复用（这些区块只服务这一个抽屉），而是每块各自持有自己那份小状态：
 * 名称草稿、标识色、命令候选、nvm 版本 —— 原先挤在一个 1200 行的文件里，改一处要读全篇。
 * 共用那几条表单样式仍留在这一层（用 `:deep()` 落进各个区块），避免五份复制。
 */
const store = useProjectsStore()

/** 抽屉关闭动画期间仍需项目数据，因此用本地开关驱动，动画结束后再清空选中项 */
const visible = ref(false)

watch(
  () => store.drawerProjectId,
  (id) => {
    if (id)
      visible.value = true
  },
)

onMounted(() => {
  visible.value = !!store.drawerProjectId
})

const project = computed(() => store.drawerProject)

function close(): void {
  visible.value = false
}

function onClosed(): void {
  store.closeDrawer()
}

async function removeProject(): Promise<void> {
  const current = project.value
  if (!current)
    return

  // 确认框在 store 里（与项目卡上的「移除」共用同一句）
  visible.value = false
  await store.removeProject(current.id)
}
</script>

<template>
  <!-- append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节） -->
  <!-- modal-class：抽屉从窗口顶边铺满，把这条遮罩的样式交给 global.css 的 .overlay-drawer -->
  <el-drawer
    v-model="visible"
    :with-header="false"
    :size="420"
    direction="rtl"
    append-to-body
    modal-class="overlay-drawer"
    @closed="onClosed"
  >
    <div v-if="project" class="drawer">
      <ProjectDrawerHeader @close="close" />

      <div class="drawer__scroll">
        <!-- 基本信息 -->
        <ProjectBasicSection />

        <!-- 命令配置 -->
        <ProjectCommandsSection />

        <!-- 环境 -->
        <ProjectEnvSection />

        <!-- 打包输出 -->
        <ProjectOutputSection />

        <!-- 运行记录 -->
        <ProjectRunHistorySection />

        <!-- 危险操作 -->
        <section class="block">
          <h3 class="section-title">
            危险操作
          </h3>
          <el-button type="danger" size="small" @click="removeProject">
            从列表中移除
          </el-button>
          <p class="field__hint">
            仅从 Workbench 列表移除，不会删除磁盘上的项目文件。
          </p>
        </section>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 底色不在这里画：整只抽屉（.el-drawer）就是那张毛玻璃面，见 global.css 的「浮层的玻璃」——
     这里再铺一层实底就把那层磨砂整个盖住了 */
  background: transparent;
}

/* ---------- 内容区 ---------- */
.drawer__scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-4);
}

/* 各区块是子组件，内部节点不在本组件的 scoped 作用域里 —— 共用表单样式用 :deep 落下去 */
.drawer__scroll :deep(.block + .block) {
  margin-top: var(--sp-6);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--border);
}

/* 区块大标题：15px 正黑，和下面的字段标签拉开层次 */
.drawer__scroll :deep(.section-title) {
  margin-bottom: var(--sp-3);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.drawer__scroll :deep(.field + .field) {
  margin-top: var(--sp-4);
}

.drawer__scroll :deep(.field__label) {
  display: block;
  margin-bottom: 7px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--ink-2);
}

.drawer__scroll :deep(.field__hint) {
  margin-top: 6px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
  line-height: 1.7;
}

.drawer__scroll :deep(.field__hint--warn) {
  color: var(--st-fail);
}

.drawer__scroll :deep(.field--row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.drawer__scroll :deep(.field--row .field__label) {
  margin-bottom: 0;
}
</style>
