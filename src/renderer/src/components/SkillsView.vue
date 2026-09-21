<script setup lang="ts">
/**
 * 技能页：卡片网格铺开技能库，点一张卡片打开详情弹窗（编辑 / 安装 / 历史 / 删除都在那里）。
 *
 * 技能库就是**你挑的那个文件夹**（与笔记文件夹互不相干：两边各自挑各自的，可以正好是同一处、
 * 同一个仓库，也可以不是）；它会落在哪个仓库里由磁盘决定 —— 从那个目录开始看有没有 `.git`，
 * 没有就往上找最近的（见 shared/skills.ts 的 `SkillLibraryState`）。
 * 版本管理就是那个仓库的提交历史 —— 每次保存、新建、删除、导入都会记一笔，
 * 「同步」按钮推的也是那个仓库（只提交技能库那一层，再拉、再推），
 * 而它只在这个仓库有远端时出现。
 * 所以这一页有两种空态：
 *   - **还没选技能库目录**（或那个目录已经不在了）：整页只有标题与一颗按钮 ——
 *     说明不写在这儿（要同步就先 clone 之类的在文档里），页面只提醒挑一个文件夹；
 *   - **文件夹里还没有技能**：网格处给「新建 / 导入」两个入口，任何状态下都找得到门。
 *
 * 卡片只负责展示（名字、描述、文件数，全部来自 SKILL.md 的自动解析）与「点开它」，
 * 动作都收在详情弹窗里（SkillDetailDialog）。与其它页面一样是导航栏上的一项
 * （见 shared/views.ts），换页由 App.vue 的 KeepAlive 负责，数据与动作都在 store 里。
 */
import { computed, onMounted, ref } from 'vue'
import { FolderOpened, Plus, Refresh, RefreshRight, Upload } from '@element-plus/icons-vue'
import type { SkillEntry } from '@shared/skills'
import { useSkillsStore } from '@/stores/skills'
import SkillCard from '@/components/SkillCard.vue'
import SkillDetailDialog from '@/components/SkillDetailDialog.vue'
import SkillCreateDialog from '@/components/SkillCreateDialog.vue'
import SkillImportDialog from '@/components/SkillImportDialog.vue'
import SkillInstallDialog from '@/components/SkillInstallDialog.vue'

const store = useSkillsStore()

onMounted(() => {
  void store.init()
})

/**
 * 挑一个技能库目录：**技能库就是它**（里面的每个子目录带一份 SKILL.md 就是一个技能）。
 *
 * 与笔记文件夹互不相干 —— 可以正好是某个笔记本、某个仓库里的一层，也可以是一个专门的技能仓库；
 * 换目录**不搬动任何文件**，只是换个地方看技能。它落在哪个仓库里由磁盘决定
 * （从这里往上找最近的 `.git`），所以这里不需要问「放仓库哪一层」。
 */
async function pickRoot(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择技能文件夹')
  if (picked) await store.setRoot(picked)
}

const createOpen = ref(false)
const importOpen = ref(false)
const detailOpen = ref(false)

/**
 * 安装弹窗是页面上的那一份：卡片上的按钮与详情弹窗里的按钮都开它
 * （详情弹窗自己 emit('install') 上来，谁要装就把谁的 id 记下）。
 */
const installOpen = ref(false)
const installId = ref('')
const installName = computed(() => {
  const skill = store.skills.find((item) => item.id === installId.value)
  return skill?.name ?? installId.value
})

/**
 * 同步按钮的提示：**同步到哪儿先说清楚**。
 *
 * 技能库与笔记是两条互不相干的线（可以正好在同一个仓库里，也可能各有一个），
 * 所以这颗按钮说的一律是「技能库所在的那个仓库」，别提笔记那边。
 */
const syncTitle = computed(() =>
  store.remoteUrl
    ? `提交技能库的改动、拉回别处的改动：同步到 ${store.remoteUrl}`
    : '技能库所在的仓库还没连远端'
)

/**
 * 库位置那行字的悬停提示：**完整路径 + 它的仓库**。
 *
 * 位置是用户自己挑的（技能页那颗「选择技能文件夹」），仓库是从那儿往上找出来的 ——
 * 两样都得摆出来：技能到底在哪儿、版本与同步跟着哪个仓库走。
 */
const locTitle = computed(() => {
  const lines = [store.root]
  if (store.gitRoot && store.dir) lines.push(`在仓库里：${store.gitRoot}`)
  if (store.hasVersions && !store.remoteUrl) lines.push('这个仓库还没连远端：版本只留本机')
  return lines.join('\n')
})

/** 点开一张卡片：先读它的 SKILL.md，再拉开详情弹窗（编辑区读着的时候是「正在读取」） */
function openDetail(skill: SkillEntry): void {
  void store.select(skill.id)
  detailOpen.value = true
}

function openInstall(skill: SkillEntry): void {
  installId.value = skill.id
  installOpen.value = true
}

/** 详情弹窗里那颗「安装到项目」：装的就是当前打开着的这个 */
function installActive(): void {
  const skill = store.activeSkill
  if (skill) openInstall(skill)
}
</script>

<template>
  <main class="skills-view">
    <!--
      还没选技能库目录（或者它已经不在磁盘上了）：只有标题与那颗按钮 ——
      说明不写在这里（想同步就先自己 clone 之类的在文档里），页面只提醒挑一个文件夹。
      目录不在时那行原因是必须的：不说的话这一页看着就像「技能没了」。
    -->
    <div v-if="!store.root || store.stateError" class="guide panel">
      <h2 class="guide__title">技能</h2>
      <p v-if="store.stateError" class="guide__text">{{ store.stateError }}</p>
      <el-button type="primary" :icon="FolderOpened" @click="pickRoot">
        {{ store.root ? '换一个技能文件夹' : '选择技能文件夹' }}
      </el-button>
    </div>

    <template v-else>
      <!-- 工具条：与项目页 / 工作页那条同款（底色由 global.css 按顶部样式给） -->
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">技能</h2>
            <span class="head__loc mono" :title="locTitle">
              {{ store.locationText }}
            </span>
          </div>
        </div>
        <div class="filter__tools">
          <el-button size="small" :icon="Upload" @click="importOpen = true">导入</el-button>
          <el-tooltip v-if="store.canSync" :content="syncTitle" placement="bottom">
            <el-button
              size="small"
              :icon="RefreshRight"
              :loading="store.syncing"
              @click="store.syncNow()"
            >
              同步
            </el-button>
          </el-tooltip>
          <el-button
            size="small"
            :icon="Refresh"
            :loading="store.loading"
            @click="store.reload()"
          />
          <!-- 换一个技能文件夹：与笔记页左栏底部那颗同一个做法（图标 + 悬停说明） -->
          <el-tooltip content="换一个技能文件夹" placement="bottom">
            <el-button size="small" :icon="FolderOpened" @click="pickRoot" />
          </el-tooltip>
        </div>
      </div>

      <p v-if="store.syncError" class="sync-error">{{ store.syncError }}</p>

      <div class="skills-view__scroll">
        <!-- 还没有技能：入口就在空态里，任何状态下都找得到门 -->
        <div v-if="store.loading && !store.loaded" class="empty panel">
          <p class="empty__text">正在读取技能…</p>
        </div>
        <div v-else-if="store.loadError" class="empty panel">
          <p class="empty__text">{{ store.loadError }}</p>
        </div>
        <div v-else-if="!store.skills.length" class="empty panel">
          <p class="empty__text">技能库里还没有技能。每个技能就是一个文件夹加一份 SKILL.md。</p>
          <div class="empty__actions">
            <el-button type="primary" :icon="Plus" @click="createOpen = true">新建技能</el-button>
            <el-button :icon="Upload" @click="importOpen = true">导入文件夹</el-button>
          </div>
        </div>

        <template v-else>
          <div class="grid">
            <SkillCard
              v-for="skill in store.skills"
              :key="skill.id"
              :skill="skill"
              @open="openDetail(skill)"
              @install="openInstall(skill)"
              @folder="store.reveal(skill.id)"
            />
          </div>
        </template>
      </div>
    </template>

    <SkillCreateDialog v-model:open="createOpen" />
    <SkillImportDialog v-model:open="importOpen" />
    <SkillDetailDialog v-model:open="detailOpen" @install="installActive" />
    <SkillInstallDialog
      v-model:open="installOpen"
      :skill-id="installId"
      :skill-name="installName"
    />
  </main>
</template>

<style scoped>
.skills-view {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  /* 四周留白与卡片间距同源（--card-gap 由 .app 统一给，设置里改「卡片间距」这里跟着变），
     左边留出的这一段正是与导航栏之间的间距 —— 导航栏那张卡片只出自己四周的留白 */
  padding: var(--card-gap, 10px);
}

/* 还没选技能库目录时的引导（只有标题与那颗按钮） */
.guide {
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  height: 100%;
  padding: var(--sp-6);
  text-align: center;
}

.guide__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.guide__text {
  max-width: 520px;
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}

/* 工具条上的标题与库位置 */
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

.head__loc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 同步失败的那行原因：紧跟工具条，不像弹窗那样打断人 */
.sync-error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

/* 网格滚动区：四周留白与卡片间距同源（--card-gap 由 .app 统一给），与项目页同一个做法 */
.skills-view__scroll {
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-1);
  margin: calc(-1 * var(--sp-1));
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--card-gap, 14px);
  align-content: start;
}

/* 空态 / 读取中 */
.empty {
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  padding: var(--sp-6);
  text-align: center;
}

.empty__text {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.empty__actions {
  display: flex;
  gap: var(--sp-2);
}
</style>
