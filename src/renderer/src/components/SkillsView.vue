<script setup lang="ts">
/**
 * 技能页：卡片网格铺开技能库，点一张卡片打开详情弹窗（编辑 / 安装 / 历史 / 删除都在那里）。
 *
 * 技能库住在**笔记文件夹**下的一个子目录里（设置里的 `skillSyncDir`，默认 `skills`），
 * 版本管理就是那个仓库的提交历史 —— 每次保存、新建、删除、导入都会记一笔，
 * 「同步」按钮走的也是笔记同步那颗按钮的同一条通道（同一个仓库，一次带上两者）。
 * 所以这一页有两种空态：
 *   - **还没选笔记文件夹**：整页只有一句引导与那颗按钮 —— 没有文件夹技能就没地方放；
 *   - **文件夹里还没有技能**：网格处给「新建 / 导入」两个入口，任何状态下都找得到门。
 *
 * 卡片只负责展示（名字、描述、文件数，全部来自 SKILL.md 的自动解析）与「点开它」，
 * 动作都收在详情弹窗里（SkillDetailDialog）。与其它页面一样是导航栏上的一项
 * （见 shared/views.ts），换页由 App.vue 的 KeepAlive 负责，数据与动作都在 store 里。
 */
import { computed, onMounted, ref } from 'vue'
import { FolderOpened, Plus, Refresh, RefreshRight, Upload } from '@element-plus/icons-vue'
import type { SkillEntry } from '@shared/skills'
import { useNotesStore } from '@/stores/notes'
import { useSkillsStore } from '@/stores/skills'
import SkillCard from '@/components/SkillCard.vue'
import SkillDetailDialog from '@/components/SkillDetailDialog.vue'
import SkillCreateDialog from '@/components/SkillCreateDialog.vue'
import SkillImportDialog from '@/components/SkillImportDialog.vue'
import SkillInstallDialog from '@/components/SkillInstallDialog.vue'

const store = useSkillsStore()
const notes = useNotesStore()

onMounted(() => {
  void store.init()
})

/** 还没选笔记文件夹时的引导：选好它技能就有了安身之处（与笔记页选的是同一个文件夹） */
async function pickRoot(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择笔记文件夹')
  if (picked) await notes.setRoot(picked)
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
    <!-- 还没选笔记文件夹：整页引导，不给任何操作入口 -->
    <div v-if="!store.root" class="guide panel">
      <h2 class="guide__title">技能</h2>
      <p class="guide__text">
        技能库住在你的笔记文件夹里（笔记仓库的一个子目录）：改动的每一版都由 git 记着，
        配好笔记仓库就能同步到别的机器，还能一键安装到各个项目下。
        先选好笔记文件夹，技能就有了安身之处。
      </p>
      <el-button type="primary" :icon="FolderOpened" @click="pickRoot">选择笔记文件夹</el-button>
    </div>

    <template v-else>
      <!-- 工具条：与项目页 / 工作页那条同款（底色由 global.css 按顶部样式给） -->
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">技能</h2>
            <span class="head__loc mono" :title="`${store.root}\\${store.dir}`">
              {{ store.locationText }}
            </span>
          </div>
        </div>
        <div class="filter__tools">
          <el-button size="small" :icon="Upload" @click="importOpen = true">导入</el-button>
          <el-tooltip
            content="提交本机改动、拉回别处的改动（与笔记同步是同一个仓库）"
            placement="bottom"
          >
            <el-button
              size="small"
              :icon="RefreshRight"
              :loading="store.syncing"
              :disabled="!store.repoConfigured"
              @click="store.syncNow()"
            >
              同步
            </el-button>
          </el-tooltip>
          <el-button size="small" :icon="Refresh" :loading="store.loading" @click="store.reload()" />
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

/* 没选笔记文件夹时的引导 */
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
