<script setup lang="ts">
import { FolderOpened, Refresh, Share } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import GitCommitList from '@/components/git/GitCommitList.vue'
import GitDiffPane from '@/components/git/GitDiffPane.vue'
import GitFileTree from '@/components/git/GitFileTree.vue'
import { useGitStore } from '@/stores/git'
/**
 * Git 页：**只读**的本地仓库浏览器。
 *
 * 左栏是 HEAD 的目录树，中栏是提交历史（整个仓库 / 某个文件），右栏是选中提交或
 * 两个提交的差异。打开过的仓库根写在设置里，下次进页面直接接上；仓库不在了就照实
 * 提示，不悄悄清掉路径（可能是移动硬盘 / 网络盘，下次插上还能用）。
 *
 * 这一页不写仓库：没有暂存、提交、切分支、推拉。所有 git 命令都是读命令
 * （见 repo_git.rs），因此它也不是一处新的网络出口。
 */
const store = useGitStore()

/** 刷新时换 key，让左栏的懒加载树整棵重建（目录 / 文件可能已经变了） */
const treeKey = ref(0)

onMounted(() => {
  void store.restore()
})

const branchText = computed(() => {
  const repo = store.repo
  if (!repo)
    return ''
  if (repo.empty)
    return '空仓库'
  if (repo.detached)
    return repo.shortHead ? `detached @ ${repo.shortHead}` : 'detached HEAD'
  return repo.branch || 'HEAD'
})

async function chooseRepo(): Promise<void> {
  await store.choose()
}

async function refresh(): Promise<void> {
  treeKey.value += 1
  await store.refresh()
}
</script>

<template>
  <main class="git-view">
    <!-- 还没打开（或上次那个打不开）：空态配图 + 一句事实 + 打开按钮，整块垂直居中 -->
    <div v-if="!store.hasRepo" class="guide">
      <EmptyState
        :icon="FolderOpened"
        :text="store.opening ? '正在打开仓库…' : (store.openError || '还没有打开 Git 仓库')"
        :hint="store.openError ? '换一个文件夹，或者把仓库放回原来的位置' : '选一个本地仓库看提交历史与文件差异'"
        :tone="store.openError && !store.opening ? 'error' : undefined"
      >
        <template #actions>
          <el-button
            type="primary"
            :icon="FolderOpened"
            :loading="store.opening"
            @click="chooseRepo"
          >
            打开仓库
          </el-button>
        </template>
      </EmptyState>
    </div>

    <template v-else>
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">
              Git
            </h2>
            <span class="head__repo" :title="store.repo?.root">{{ store.repo?.name }}</span>
            <span class="head__branch mono" :title="branchText">
              <el-icon><Share /></el-icon>
              {{ branchText }}
            </span>
            <span class="head__path mono" :title="store.repo?.root">{{ store.repo?.root }}</span>
          </div>
        </div>
        <div class="filter__tools">
          <el-tooltip content="刷新仓库" placement="bottom">
            <el-button
              size="small"
              :icon="Refresh"
              :loading="store.opening"
              aria-label="刷新仓库"
              @click="refresh"
            />
          </el-tooltip>
          <el-button size="small" :icon="FolderOpened" @click="chooseRepo">
            换仓库
          </el-button>
        </div>
      </div>

      <p v-if="store.openError" class="git-note git-note--error">
        {{ store.openError }}
      </p>
      <p v-else-if="store.repo?.empty" class="git-note">
        这个仓库还没有第一次提交。
      </p>

      <div class="git-layout">
        <aside class="git-pane panel">
          <GitFileTree :key="`${store.root}-${treeKey}`" />
        </aside>
        <section class="git-pane panel">
          <GitCommitList />
        </section>
        <section class="git-pane panel">
          <GitDiffPane />
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.git-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--card-gap, 10px);
}

/* 空态不要卡片外壳：内容直接坐在壁纸上（与技能 / 视频页同一条） */
.guide {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

/* 工具条上的标题与仓库位置 */
.head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  min-width: 0;
}

.head__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.head__repo {
  flex-shrink: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.head__branch {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.head__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.git-note {
  flex-shrink: 0;
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.git-note--error {
  color: var(--st-fail);
}

.git-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(220px, 300px) minmax(300px, 380px) minmax(0, 1fr);
  gap: var(--card-gap, 10px);
  min-height: 0;
}

.git-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 三栏里各自的内容组件自己带内边距；.panel 的默认 padding 会与它们叠成两层 */
  padding: 0;
  overflow: hidden;
}
</style>
