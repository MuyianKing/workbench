<script setup lang="ts">
import { ArrowDown, Check, FolderOpened, Refresh, Share } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import GitCommitList from '@/components/git/GitCommitList.vue'
import GitDiffPane from '@/components/git/GitDiffPane.vue'
import GitFileTree from '@/components/git/GitFileTree.vue'
import GitRepoMenu from '@/components/git/GitRepoMenu.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { basenameOf } from '@/format'
import { useGitStore } from '@/stores/git'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
/**
 * Git 页：**只读**的本地仓库浏览器。
 *
 * 左栏是所选文件夹的目录树，中栏是提交历史（整个仓库 / 某个文件），右栏是选中提交或
 * 两个提交的差异。头部两颗名字各带一个下拉：
 *  - 仓库名 → 项目页里的项目、最近打开的文件夹与「打开其他文件夹…」；
 *  - 分支名 → 本地分支清单，只换看哪条分支的历史 / 目录树，**不切工作区**。
 *
 * 打开过的文件夹写在设置里，下次进页面直接接上；仓库不在了就照实提示，不悄悄清掉路径
 * （可能是移动硬盘 / 网络盘，下次插上还能用）。还没打开时空态里也有一颗下拉按钮，
 * 和头部共用 GitRepoMenu 那份菜单（项目 / 最近打开 / 打开其他文件夹…）。
 *
 * 这一页不写仓库：没有暂存、提交、切分支、推拉。所有 git 命令都是读命令
 * （见 repo_git.rs），因此它也不是一处新的网络出口。
 */
const store = useGitStore()
const projects = useProjectsStore()
const settings = useSettingsStore()

/** 三栏宽度都住在 theme.json（拖动分隔条改它们），右栏吃掉剩余宽度 */
const layoutStyle = computed(() => ({
  gridTemplateColumns: `${settings.themeConfig.gitTreeWidth}px ${settings.themeConfig.gitHistoryWidth}px minmax(0, 1fr)`,
}))

/** 刷新时换 key，让左栏的懒加载树整棵重建（目录 / 文件可能已经变了） */
const treeKey = ref(0)

onMounted(() => {
  void store.restore()
})

/** 路径比较按 Windows 的口径：不分大小写、`/` 与 `\` 等价 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** 「项目」那一组：顺序跟项目页一致（用户在项目页怎么排，这里就怎么排）；目录不存在的置灰 */
const projectOptions = computed(() =>
  projects.orderedProjects.map(project => ({
    id: project.id,
    name: project.name,
    path: project.path,
    disabled: !projects.isPathValid(project.id),
  })),
)

/** 最近打开里去掉已经在项目里出现过的：同一个文件夹不列两遍 */
const recentOnly = computed(() => {
  const known = new Set(projectOptions.value.map(project => normalizePath(project.path)))
  return store.recentRepos.filter(path => !known.has(normalizePath(path)))
})

/** 空态那颗下拉的名字：没有项目可挑时，菜单里只剩最近打开与文件选择器 */
const repoMenuLabel = computed(() => (projectOptions.value.length ? '选择项目' : '最近打开'))

/** 切到另一条分支 / 另一个子树时树也要重建：key 里带着它们，换了就整棵重来 */
const treeCacheKey = computed(() => `${store.openPath}-${store.viewBranch}-${treeKey.value}`)

/** 头部显示的是「用户打开的那个文件夹」：git 可能在外层，别让仓库根的名字盖住它 */
const repoName = computed(() =>
  store.openPath ? basenameOf(store.openPath) : (store.repo?.name || ''),
)

/** 路径那一格指向选中的文件夹；选中子目录时 tooltip 补一句仓库根在哪 */
const repoTitle = computed(() =>
  store.openPath && store.scope
    ? `${store.openPath}\n仓库根：${store.root}`
    : (store.openPath || store.repo?.root || ''),
)

/** 头部那颗分支 chip：空仓库 / detached / 正在看的分支各写各的 */
const branchText = computed(() => {
  const repo = store.repo
  if (!repo)
    return ''
  if (repo.empty)
    return '空仓库'
  if (store.viewBranch)
    return store.viewBranch
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

/** 仓库下拉：命令是路径本身（`pick` 留给文件选择器） */
function onRepoCommand(command: string): void {
  if (command === 'pick') {
    void chooseRepo()
    return
  }
  if (command && normalizePath(command) !== normalizePath(store.openPath))
    void store.open(command)
}

function onBranchCommand(name: string): void {
  void store.switchBranch(name)
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
          <!-- 和头部同一份菜单：不用先去系统文件选择器里翻目录，点项目就能进 -->
          <el-dropdown
            v-if="projectOptions.length || recentOnly.length"
            trigger="click"
            placement="bottom"
            popper-class="git-repo-menu"
            :disabled="store.opening"
            @command="onRepoCommand"
          >
            <el-button>
              {{ repoMenuLabel }}
              <el-icon class="el-icon--right">
                <ArrowDown />
              </el-icon>
            </el-button>
            <template #dropdown>
              <GitRepoMenu
                :projects="projectOptions"
                :recent="recentOnly"
                :current-path="store.openPath"
              />
            </template>
          </el-dropdown>
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

            <!-- 仓库：点名字换最近打开的仓库，或去挑一个新文件夹 -->
            <el-dropdown
              trigger="click"
              placement="bottom-start"
              popper-class="git-repo-menu"
              @command="onRepoCommand"
            >
              <button type="button" class="head__repo" :title="repoTitle">
                <span class="head__repo-name">{{ repoName }}</span>
                <el-icon class="head__caret">
                  <ArrowDown />
                </el-icon>
              </button>
              <template #dropdown>
                <GitRepoMenu
                  :projects="projectOptions"
                  :recent="recentOnly"
                  :current-path="store.openPath"
                />
              </template>
            </el-dropdown>

            <!-- 分支：只换看哪条分支的历史 / 目录树，不切工作区 -->
            <el-dropdown
              v-if="!store.repo?.empty"
              trigger="click"
              placement="bottom-start"
              popper-class="git-branch-menu"
              @command="onBranchCommand"
            >
              <button type="button" class="head__branch" :title="branchText">
                <el-icon><Share /></el-icon>
                <span class="head__branch-name mono">{{ branchText }}</span>
                <span v-if="store.viewingOtherBranch" class="head__branch-tag">未切换</span>
                <el-icon class="head__caret">
                  <ArrowDown />
                </el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="store.repo?.detached" disabled>
                    HEAD 处于 detached 状态
                  </el-dropdown-item>
                  <el-dropdown-item
                    v-for="name in store.branches"
                    :key="name"
                    :command="name"
                  >
                    <span class="branch-item__name mono">{{ name }}</span>
                    <span v-if="name === store.repo?.branch" class="branch-item__tag">当前</span>
                    <el-icon v-if="name === store.shownBranch" class="branch-item__mark">
                      <Check />
                    </el-icon>
                  </el-dropdown-item>
                  <el-dropdown-item v-if="store.branchesLoading" disabled>
                    正在读取分支…
                  </el-dropdown-item>
                  <el-dropdown-item v-else-if="!store.branches.length" disabled>
                    没有本地分支
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <span v-else class="head__branch mono" :title="branchText">
              <el-icon><Share /></el-icon>
              {{ branchText }}
            </span>

            <span class="head__path mono" :title="repoTitle">{{ store.openPath || store.repo?.root }}</span>
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

      <div class="git-layout" :style="layoutStyle">
        <aside class="git-pane panel">
          <GitFileTree :key="treeCacheKey" />
        </aside>
        <section class="git-pane panel">
          <GitCommitList />
        </section>
        <section class="git-pane panel">
          <GitDiffPane />
        </section>

        <!-- 两条分隔条：文件树 | 提交列表、提交列表 | 差异。落点按列宽与缝线算 -->
        <PanelResizer
          :width="settings.themeConfig.gitTreeWidth"
          body-class="is-resizing-git-pane"
          title="拖动调整文件树宽度"
          :style="{ '--resizer-inset': '0px', '--tree-w': `${settings.themeConfig.gitTreeWidth}px` }"
          @move="settings.setGitTreeWidth"
          @end="() => void settings.commitGitTreeWidth()"
        />
        <PanelResizer
          :width="settings.themeConfig.gitHistoryWidth"
          body-class="is-resizing-git-pane"
          title="拖动调整提交列表宽度"
          :style="{
            '--resizer-inset': '0px',
            '--tree-w': `calc(${settings.themeConfig.gitTreeWidth}px + var(--card-gap, 10px) + ${settings.themeConfig.gitHistoryWidth}px)`,
          }"
          @move="settings.setGitHistoryWidth"
          @end="() => void settings.commitGitHistoryWidth()"
        />
      </div>
    </template>
  </main>
</template>

<style scoped>
.git-view {
  /*
   * 这一页信息密度高，原先几乎全靠 micro / meta 两档（10.5 / 12px），读起来太小。
   * 只在这一页把字号三档各上调一档 —— 子组件的 scoped 样式都取这些令牌，会一起跟着变。
   */
  --fs-micro: 12px;
  --fs-meta: 13px;
  --fs-body: 14px;
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
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.head__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.head__repo {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-2);
  font-family: inherit;
  font-size: var(--fs-meta);
  font-weight: 600;
  cursor: pointer;
}

.head__repo:hover {
  color: var(--ink);
}

.head__repo-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head__branch {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-family: inherit;
  font-size: var(--fs-micro);
}

button.head__branch {
  cursor: pointer;
}

button.head__branch:hover {
  color: var(--ink-2);
}

.head__branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 18em;
}

/* 正在看的分支不是仓库当前分支（只读浏览，工作区没切） */
.head__branch-tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.head__caret {
  flex-shrink: 0;
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
  position: relative;
  display: grid;
  flex: 1;
  /* 列宽由 layoutStyle 给（theme.json 里的三处宽度，拖动分隔条改） */
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
