<script setup lang="ts">
import type { KbDanglingGroup, KbLibraryRow, KbRawItem } from '@workbench/kb'
import { FolderOpened, MagicStick, Plus, Position, Refresh, RefreshRight } from '@element-plus/icons-vue'
import { kbRawDisplayPath } from '@workbench/kb'
/**
 * 知识库页：看一个**仓库里 raw/ + data/ 两层**的独立项目，添加、清洗也在这里一键完成。
 *
 * 列表数据来自远程仓库：知识库清单住在仓库里的 `raw/kb.json`，打开页面后台拉一次远端
 * （只拉不推），别的设备推上来的知识库这边就有。一个知识库 = raw/ 下一个子目录；本机
 * 关联了源头文件夹的（添加时选的），清洗前应用会把本机改动复制进 raw —— **清洗的硬前置
 * 是把原始文件上传远程仓库**，没连远端 / 上传失败都就地拦下。没有关联的知识库（别的
 * 设备添加的）直接用仓库里的副本，只读。条目（data/ 下的清洗产物）在应用里没有阅读
 * 视图 —— 用户只关心源文件；清洗全程在右栏的清洗面板里看得见。
 *
 * 旧结构（`kb/` 条目 + 库外来源映射）进页面时会提示一次性迁移（搬文件、改写 source
 * 前缀、写清单），确认后才动手。仓库连了远端时再给同步按钮（知识库仓库自己的 git 通道）。
 *
 * 页面有三种整页状态：没选文件夹的引导、目录读不出来的报错、选的文件夹不像知识库的提醒；
 * 正常态是「左清单右查看」两栏，右栏在概览、原始数据与清洗面板之间切换（清洗进行中 /
 * 刚收场时面板优先）。两栏之间那条缝可以左右拖（宽度住 theme.json 的 `kbTreeWidth`，
 * 与笔记 / 视频 / AI 页同一套做法）。数据与动作都在 store 里（见 stores/kb.ts），
 * 组件只编排界面。
 */
import { computed, onMounted, ref } from 'vue'
import AiModelDialog from '@/components/AiModelDialog.vue'
import AppDialog from '@/components/AppDialog.vue'
import KbAddDialog from '@/components/KbAddDialog.vue'
import KbCleanPanel from '@/components/KbCleanPanel.vue'
import KbInfoPanel from '@/components/KbInfoPanel.vue'
import KbList from '@/components/KbList.vue'
import KbRawViewer from '@/components/KbRawViewer.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { notifyError } from '@/notify'
import { useKbStore } from '@/stores/kb'
import { useSettingsStore } from '@/stores/settings'

const store = useKbStore()
const settings = useSettingsStore()

onMounted(() => {
  void store.init()
})

/** 模型管理弹窗（清洗面板缺模型 / 缺密钥时从那里去） */
const modelVisible = ref(false)

/** 添加知识库弹层（表单 → 二次确认 → 复制上传 → 首洗） */
const addVisible = ref(false)
const addWorking = ref(false)

async function submitAdd(payload: { name: string, dir: string }): Promise<void> {
  addWorking.value = true
  try {
    // 本地这几步（复制 / 清单 / 关联）不到一秒；上传与首洗交给清洗面板逐步可见，
    // 所以成了就立刻关弹窗，别让它在上传那几秒里空转
    const done = await store.addLibrary(payload.name, payload.dir)
    if (done)
      addVisible.value = false
  }
  finally {
    addWorking.value = false
  }
}

/** 删除知识库弹层：列出将删的条目，说明源头文件夹不动 */
const destroyVisible = ref(false)
const destroyRow = ref<KbLibraryRow | null>(null)
const destroyRels = computed(() =>
  destroyRow.value ? store.entryRelsOfLibrary(destroyRow.value.name) : [],
)
/** 删除在跑（上传远程是三次出网，得转圈）：进行中不许重复点、也不许关弹层 */
const destroying = ref(false)

function openDestroy(row: KbLibraryRow): void {
  destroyRow.value = row
  destroyVisible.value = true
}

async function confirmDestroy(): Promise<void> {
  if (!destroyRow.value || destroying.value)
    return
  destroying.value = true
  try {
    const done = await store.deleteLibrary(destroyRow.value.name)
    if (done)
      destroyVisible.value = false
  }
  finally {
    destroying.value = false
  }
}

/** 删除文件弹层：仓库与源头一起删、指向它的条目一并删（确认框写明白） */
const fileVisible = ref(false)
const fileRow = ref<KbRawItem | null>(null)
const fileRels = computed(() =>
  fileRow.value ? store.entryRelsOfRawRel(fileRow.value.rel) : [],
)
/** 删除在跑（同上：出网要几秒，得转圈） */
const deletingFile = ref(false)
/**
 * 本机源头里那份的**文件**路径：有关联时 abs 被本地覆盖、指向源头那份（不以 rel 结尾）；
 * abs 还是仓库里那份（本地没有 / 没关联）时为空 —— 提示就按「只删仓库里的」说。
 */
const fileLocalPath = computed(() => {
  const row = fileRow.value
  if (!row)
    return ''
  const trimmed = row.abs.replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed && !trimmed.endsWith(row.rel) ? row.abs : ''
})

function openFileDelete(item: KbRawItem): void {
  fileRow.value = item
  fileVisible.value = true
}

async function confirmFileDelete(): Promise<void> {
  if (!fileRow.value || deletingFile.value)
    return
  deletingFile.value = true
  try {
    const done = await store.deleteFile(fileRow.value.rel)
    if (done)
      fileVisible.value = false
  }
  finally {
    deletingFile.value = false
  }
}

/** 失联清理弹层：按知识库打开，列出该库下每个被删的 raw 文件与指向它的条目 */
const purgeVisible = ref(false)
const purgeSource = ref('')
const purgeGroups = computed<KbDanglingGroup[]>(() =>
  store.dangling.filter(group => group.source === purgeSource.value),
)
const purgeEntryRels = computed(() => [...new Set(purgeGroups.value.flatMap(group => group.entryRels))])
/** 清理在跑（同上：出网要几秒，得转圈） */
const purging = ref(false)

function openPurge(row: KbLibraryRow): void {
  purgeSource.value = row.name
  purgeVisible.value = true
}

/**
 * 确认清理：**按组删**（一个 raw 文件那一组里的条目一起删），删完重建索引、刷新清单。
 * 不提示入链 —— 删完产生的断链条目自己长着（界面不展示巡检）。
 */
async function confirmPurge(): Promise<void> {
  const groups = purgeGroups.value
  if (!groups.length || purging.value)
    return
  purging.value = true
  try {
    const done = await store.purgeEntries(groups)
    if (done)
      purgeVisible.value = false
  }
  finally {
    purging.value = false
  }
}

/** 迁移确认弹层：把将要做的事列明白，确认后才动手 */
const migrateVisible = ref(false)

async function confirmMigrate(): Promise<void> {
  const done = await store.migrate()
  if (done)
    migrateVisible.value = false
}

/** 挑一个知识库文件夹：**它就是那个仓库的根**。换目录不搬动任何文件 */
async function pickRoot(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择知识库文件夹')
  if (picked)
    await store.setRoot(picked)
}

/**
 * 右键「在资源管理器中打开」：文件直接用它的 abs（有关联指向本机源头那份、没关联指向
 * 仓库副本，都在磁盘上）；目录按关联落位 —— 有关联落本机源头的对应子目录（源头文件夹
 * 就是知识库目录本身），没关联落仓库副本的 raw 下。
 */
function revealNode(target: { id: string, item?: KbRawItem }): void {
  if (target.item) {
    void window.workbench.reveal(target.item.abs)
    return
  }
  const cut = target.id.indexOf('/')
  const name = cut > 0 ? target.id.slice(0, cut) : target.id
  const inner = cut > 0 ? target.id.slice(cut + 1) : ''
  const link = store.sourceLinks.find(item => item.name === name)
  const base = link?.dir
    ? (inner ? `${link.dir}/${inner}` : link.dir)
    : `${store.root}/raw/${target.id}`
  void window.workbench.reveal(base)
}

/** 同步按钮的提示：同步到哪儿先说清楚（它只推这个文件夹自己连着的仓库） */
const syncTitle = computed(() =>
  store.remoteUrl ? `提交改动、拉回别处的改动：同步到 ${store.remoteUrl}` : '这个文件夹还没连 git 远端',
)

/** 清洗按钮的提示：干活的这个引擎在界面上就叫程序名（与导航栏同一口径） */
const cleanTitle = computed(() =>
  `把未入库与有更新的原始文件交给内置的 ${settings.settings.appName} 清洗（清洗前先上传远程），完成后自动同步`,
)

/** 两栏的宽度：左栏是主题里存的那个值（与笔记 / 视频 / AI 页同一套做法） */
const bodyStyle = computed(() => ({
  'gridTemplateColumns': `${settings.themeConfig.kbTreeWidth}px minmax(0, 1fr)`,
  '--tree-w': `${settings.themeConfig.kbTreeWidth}px`,
}))

/**
 * 用系统默认程序打开正在查看的原始数据（预览不了的格式给出去）。
 * 路径用 Rust 扫回来的绝对路径（`abs`）—— 自己拼「根 + rel」会拼错
 */
async function openRawExternally(): Promise<void> {
  if (!store.activeRaw?.abs)
    return
  const result = await window.workbench.openPath(store.activeRaw.abs)
  if (!result.ok)
    notifyError(result.error ?? '打开文件失败')
}
</script>

<template>
  <main class="kb-view">
    <!-- 还没选知识库文件夹：整页只有一块自绘线稿、「知识库」那行标题与那颗按钮，居中浮在画布上、
         不套卡片；仓库该怎么摆与清洗收在按钮的悬停里，不摆在页面上 -->
    <div v-if="!store.root" class="guide">
      <div class="guide__hero">
        <!-- 线稿：三张叠着的纸 —— 后面两张是散页，最前面那张是收好的条目（右上角一枚书签、
             三条正文线），与 AI 助手页那一屏同一副笔法。后面那两张各拿 mask 裁一下：
             线稿只有描边、没有底色，不裁的话它们的边会从前面那张纸里透出来 -->
        <svg class="guide__art" viewBox="0 0 224 148" fill="none" aria-hidden="true">
          <defs>
            <mask id="kb-guide-card">
              <rect width="224" height="148" fill="white" />
              <rect x="86" y="41" width="107" height="95" rx="11" fill="black" />
            </mask>
            <mask id="kb-guide-cards">
              <rect width="224" height="148" fill="white" />
              <rect x="86" y="41" width="107" height="95" rx="11" fill="black" />
              <rect x="58" y="27" width="107" height="95" rx="11" fill="black" />
            </mask>
          </defs>

          <g mask="url(#kb-guide-cards)">
            <rect x="31.5" y="14.5" width="104" height="92" rx="10" stroke="currentColor" stroke-width="1" />
            <path d="M52 22h78" stroke="currentColor" stroke-width="1" />
          </g>

          <g mask="url(#kb-guide-card)">
            <rect x="59.5" y="28.5" width="104" height="92" rx="10" stroke="currentColor" stroke-width="1" />
            <path d="M76 36h74" stroke="currentColor" stroke-width="1" />
          </g>

          <rect x="87.5" y="42.5" width="104" height="92" rx="10" stroke="currentColor" stroke-width="1" />
          <path d="M168 42.5v24l6.5-6.5 6.5 6.5v-24" stroke="currentColor" stroke-width="1" />
          <path d="M104 76h72M104 92h46M104 108h62" stroke="currentColor" stroke-width="1" />
        </svg>

        <h2 class="guide__title">
          知识库
        </h2>
      </div>

      <el-tooltip
        content="选一个 git 仓库文件夹（空文件夹也行）；添加知识库时选一个本机文件夹作源头，复制上传后立即清洗"
        placement="top"
      >
        <el-button type="primary" :icon="FolderOpened" @click="pickRoot">
          选择知识库文件夹
        </el-button>
      </el-tooltip>
    </div>

    <template v-else>
      <!-- 工具条：与技能页那条同款 -->
      <div class="filter">
        <div class="filter__head">
          <div class="head">
            <h2 class="head__title">
              知识库
            </h2>
            <span class="head__loc mono" :title="store.root">{{ store.locationText }}</span>
          </div>
        </div>
        <div class="filter__tools">
          <el-tooltip content="添加知识库：选一个本机文件夹作源头，复制上传后立即清洗" placement="bottom">
            <el-button
              size="small"
              type="primary"
              :icon="Plus"
              :disabled="store.cleanBusy"
              @click="addVisible = true"
            >
              添加知识库
            </el-button>
          </el-tooltip>
          <el-tooltip
            :content="cleanTitle"
            placement="bottom"
          >
            <el-button
              size="small"
              :icon="MagicStick"
              :loading="store.cleanBusy"
              @click="store.startClean()"
            >
              开始清洗
            </el-button>
          </el-tooltip>
          <el-tooltip v-if="store.canSync" :content="syncTitle" placement="bottom">
            <el-button
              size="small"
              :icon="RefreshRight"
              :loading="store.syncing"
              :disabled="store.cleanBusy"
              @click="store.syncNow()"
            >
              同步
            </el-button>
          </el-tooltip>
          <el-tooltip
            content="重扫一遍知识库，算清未入库 / 有更新（只读，不清洗）"
            placement="bottom"
          >
            <el-button
              size="small"
              :icon="Refresh"
              :loading="store.loading"
              :disabled="store.cleanBusy"
              @click="store.detect()"
            >
              检测更新
            </el-button>
          </el-tooltip>
          <el-tooltip
            v-if="store.migrateNeeded"
            content="旧结构（kb/ 条目 + 库外来源）一次性迁移到 raw/ + data/ 新结构"
            placement="bottom"
          >
            <el-button
              size="small"
              type="warning"
              :icon="Position"
              :loading="store.migrating"
              :disabled="store.cleanBusy"
              @click="migrateVisible = true"
            >
              迁移
            </el-button>
          </el-tooltip>
          <el-tooltip content="换一个知识库文件夹" placement="bottom">
            <el-button
              size="small"
              :icon="FolderOpened"
              :disabled="store.cleanBusy"
              @click="pickRoot"
            />
          </el-tooltip>
        </div>
      </div>

      <p v-if="store.syncError" class="sync-error">
        {{ store.syncError }}
      </p>

      <!-- 正常的两栏：左清单右查看（清洗进行中 / 刚收场时右栏让给清洗面板） -->
      <div v-if="store.loaded && store.looksLikeKb" class="kb-view__body" :style="bodyStyle">
        <section class="kb-view__left panel">
          <KbList
            :items="store.rawItems"
            :libraries="store.libraries"
            @open="store.openRaw($event)"
            @clean-kb="store.startClean({ kind: 'kb', name: $event.name })"
            @delete-kb="openDestroy"
            @clean-file="store.startClean({ kind: 'file', rel: $event.rel })"
            @delete-file="openFileDelete"
            @purge-kb="openPurge"
            @reveal="revealNode"
          />
        </section>

        <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
        <PanelResizer
          :width="settings.themeConfig.kbTreeWidth"
          body-class="is-resizing-kb-tree"
          @move="width => settings.setThemeWidth('kbTreeWidth', width)"
          @end="() => void settings.commitThemeWidth('kbTreeWidth')"
        />

        <section class="kb-view__right panel">
          <KbCleanPanel
            v-if="store.cleanPhase !== 'idle'"
            :phase="store.cleanPhase"
            :lines="store.cleanLines"
            :error="store.cleanError"
            :created="store.cleanWrites.created"
            :updated="store.cleanWrites.updated"
            @start="store.startClean()"
            @stop="store.stopClean()"
            @close="store.closeClean()"
            @open-models="modelVisible = true"
          />
          <KbRawViewer
            v-else-if="store.activeRaw"
            :item="store.activeRaw"
            :kind="store.activeRawKind"
            :content="store.activeRawContent"
            :loading="store.activeRawLoading"
            :error="store.activeRawError"
            @back="store.closeRaw()"
            @open="openRawExternally"
          />
          <KbInfoPanel
            v-else
            :stats="store.stats"
            :is-repo="store.repoState?.isRepo === true"
            :repo-origin="store.remoteUrl"
          />
        </section>
      </div>

      <!-- 读取中 / 读不出来 / 不像知识库：三态各说各的，不挤在一起 -->
      <div v-else class="kb-view__state">
        <div v-if="store.loading && !store.loaded" class="empty panel">
          <PanelLoading text="正在读取知识库…" />
        </div>
        <div v-else-if="store.loadError" class="empty panel">
          <p class="empty__text">
            {{ store.loadError }}
          </p>
          <el-button :icon="FolderOpened" @click="pickRoot">
            换一个知识库文件夹
          </el-button>
        </div>
        <div v-else class="empty panel">
          <p class="empty__text">
            这个文件夹不是空的，也没有 <span class="mono">raw</span>，看起来不是知识库项目的根。
          </p>
          <p class="empty__hint">
            知识库是纯数据的：<span class="mono">raw</span> 放原始文件；
            旧结构（<span class="mono">kb</span> + 库外来源）选进来会给出迁移入口。
          </p>
          <el-button :icon="FolderOpened" @click="pickRoot">
            换一个知识库文件夹
          </el-button>
        </div>
      </div>
    </template>

    <!-- 模型管理：清洗缺模型 / 缺密钥时从面板里去（配置是全局的，与 AI 助手页共用） -->
    <AiModelDialog v-model="modelVisible" />

    <!-- 添加知识库：表单 → 二次确认（复制上传 + 立即清洗），不确认就当不添加 -->
    <KbAddDialog
      v-model="addVisible"
      :referenced="store.manifest.map(item => item.name)"
      :existing="store.sourceLinks"
      :working="addWorking"
      @submit="submitAdd"
    />

    <!-- 删除知识库：仓库里的内容 + 名下条目一起没了；源头文件夹不动。挡住（永久删除，不给穿透） -->
    <AppDialog
      v-if="destroyRow"
      v-model="destroyVisible"
      title="删除知识库"
      width="560"
      align-center
    >
      <p class="purge__lead">
        知识库「{{ destroyRow.name }}」将被删除：仓库里它的全部内容（原始文件与
        {{ destroyRels.length }} 个整理产物）一并删除。
      </p>
      <p class="purge__note">
        永久删除；只有提交过 git 的才能从历史恢复。
        本机源头文件夹 {{ destroyRow.dir ? `「${destroyRow.dir}」` : '' }}与里面的文件一个都不动。
      </p>

      <template #footer>
        <el-button :disabled="destroying" @click="destroyVisible = false">
          取消
        </el-button>
        <el-button type="danger" :loading="destroying" @click="confirmDestroy">
          删除知识库
        </el-button>
      </template>
    </AppDialog>

    <!-- 删除文件：仓库与源头一起删、名下整理产物一并删。挡住（永久删除，不给穿透） -->
    <AppDialog
      v-if="fileRow"
      v-model="fileVisible"
      title="删除文件"
      width="560"
      align-center
    >
      <p class="purge__lead">
        <span class="mono">{{ kbRawDisplayPath(fileRow.rel) }}</span> 将被删除；
        <template v-if="fileLocalPath">
          本机源头里的这一份（<span class="mono">{{ fileLocalPath }}</span>）也一并删除。
        </template>
        <template v-else>
          本机源头里没有这一份，只删仓库里的这一份。
        </template>
      </p>
      <p v-if="fileRels.length" class="purge__note">
        由它整理出的 {{ fileRels.length }} 个产物会一并删除（永久删除；只有提交过 git 的才能从历史恢复）。
      </p>

      <template #footer>
        <el-button :disabled="deletingFile" @click="fileVisible = false">
          取消
        </el-button>
        <el-button type="danger" :loading="deletingFile" @click="confirmFileDelete">
          删除文件
        </el-button>
      </template>
    </AppDialog>

    <!-- 失联清理：原始文件不在了，名下的整理产物一起清掉；挡住（永久删除，不给穿透） -->
    <AppDialog
      v-model="purgeVisible"
      title="清理失联的原始文件"
      width="560"
      align-center
    >
      <p class="purge__lead">
        知识库「{{ purgeSource }}」里这些原始文件已经不在了：
      </p>
      <div class="purge__groups scrollbar">
        <div v-for="group in purgeGroups" :key="group.rel" class="purge__group">
          <p class="purge__file mono" :title="group.rel">
            {{ kbRawDisplayPath(group.rel) }}
          </p>
          <p class="purge__entries">
            由它整理出的 {{ group.entryRels.length }} 个产物会一并删除
          </p>
        </div>
      </div>
      <p class="purge__note">
        将删除 {{ purgeEntryRels.length }} 个整理产物（永久删除；只有提交过 git 的才能从历史恢复）。
      </p>

      <template #footer>
        <el-button :disabled="purging" @click="purgeVisible = false">
          取消
        </el-button>
        <el-button type="danger" :disabled="!purgeEntryRels.length" :loading="purging" @click="confirmPurge">
          清理
        </el-button>
      </template>
    </AppDialog>

    <!-- 迁移确认：把将做的事列明白；挡住（搬文件 + 改写条目，不给穿透） -->
    <AppDialog
      v-model="migrateVisible"
      title="迁移到新结构"
      width="560"
      align-center
    >
      <p class="purge__lead">
        旧结构（<span class="mono">kb/</span> 条目 + 库外来源）将一次性迁移到
        <span class="mono">raw/</span> + <span class="mono">data/</span>：
      </p>
      <ol class="migrate__steps">
        <li>本机关联的各来源文件夹复制进 <span class="mono">raw/&lt;名字&gt;/</span></li>
        <li><span class="mono">kb/</span> 整体搬进 <span class="mono">data/</span>（内层结构不变）</li>
        <li>条目里的 <span class="mono">data/raw/</span> 前缀改写成 <span class="mono">raw/</span></li>
        <li>写清单（<span class="mono">raw/kb.json</span>）、删旧的 <span class="mono">index/</span>、重建索引</li>
      </ol>
      <p class="purge__note">
        库里遗留的 <span class="mono">data/raw</span> 原始副本一个字不动（不算条目也不算原始数据）；
        迁移只能做一次。
      </p>

      <template #footer>
        <el-button @click="migrateVisible = false">
          取消
        </el-button>
        <el-button type="primary" :loading="store.migrating" @click="confirmMigrate">
          开始迁移
        </el-button>
      </template>
    </AppDialog>
  </main>
</template>

<style scoped>
.kb-view {
  display: flex;
  flex-direction: column;
  /**
   * 行距就是设置里那一档「卡片间距」（--card-gap）：工具带与两栏之间、两栏之间、报错那行上下，
   * 全都是同一个数 —— 与项目页 / 工作页 / 密码页工具带下沿那条缝同源（那几页是滚动体自己带
   * `padding: var(--card-gap)`）。
   *
   * 这一层原来是三行网格（工具带 / 报错 / 两栏），报错那行是 v-if 的、又钉死在第二行：
   * 它不渲染时那一条行距照旧占着，于是工具带与两栏之间成了**两条**间距（别的页都只有一条，
   * 看着就是「这一页空得莫名其妙」）。换纵向 flex 之后不渲染的节点不占位，也就没有多出来那条。
   */
  gap: var(--card-gap, 10px);
  height: 100%;
  min-height: 0;
  /**
   * 左右下三边与卡片间距同源；**上边一份不给自己加** —— 顶栏下面那条缝归 .shell 管
   * （见 global.css「顶栏与内容之间那条缝」），这里再补一份，正常 / 毛玻璃两档就成了两倍，
   * 工具条也会比导航栏那张卡片低一截。
   */
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/* 还没选文件夹时的引导：没有卡片底，居中浮在画布上。
   它得吃掉整页高度，居中才有参照（纵向 flex 里就是这一句 flex，网格那版靠 is-intro 换行模板） */
.guide {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  min-height: 0;
  padding: var(--sp-6);
  text-align: center;
}

/* 线稿与标题贴成一团，到按钮那一步松一档 —— 与 AI 助手页那一屏同一套节奏 */
.guide__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
}

/* 线稿是背景性的：只比画布深一点，别抢按钮的视线（与 AiView 的 hero 同一条口径） */
.guide__art {
  width: 200px;
  height: auto;
  color: var(--ink-3);
  opacity: 0.55;
}

.guide__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-display);
  font-weight: 600;
}

/* 工具条上的标题、位置与统计 */
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

/* 同步失败的那行原因：紧跟工具条，不像弹窗那样打断人。
   它是 v-if 的 —— 纵向 flex 里这不成问题：不渲染的节点既不占高度也不占行距，
   两栏照旧吃满剩下的空间（网格那版得把它显式钉在第二行，否则它一缺席、两栏就落进 auto 行
   只剩内容那么高） */
.sync-error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

/**
 * 两栏主体：左清单（宽度跟 theme.json 里的 kbTreeWidth 走，拖动分隔条改它）、
 * 右查看吃剩下的。间距取 --card-gap：分隔条把手落点的算式里写的是它
 * （与笔记 / 视频 / AI 页同一条缝）。把手挂在**这一层**（position: relative 在这里），
 * 这层没有外边距，所以给把手 `--resizer-inset: 0px` —— 外框那圈内边距归 .kb-view。
 */
.kb-view__body {
  flex: 1 1 auto;
  position: relative;
  --resizer-inset: 0px;
  display: grid;
  /* 两栏的列宽由模板上的内联样式给（kbTreeWidth，拖动分隔条改它） */
  gap: var(--card-gap, 10px);
  min-height: 0;
}

.kb-view__left {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

.kb-view__right {
  min-height: 0;
  overflow: hidden;
  /*
   * 内边距收到与左栏同一档（.kb-view__left 也是 sp-3）：两栏的第一行内容落在同一条竖线上。
   * 右栏里那个阅读视图（原始数据）自己不再补左边距，内容就直接落在这一档上。
   */
  padding: var(--sp-3);
}

/* 整页状态的容器（读取中 / 报错 / 不像知识库）：与两栏同占一块地方，吃满剩下的高度 */
.kb-view__state {
  flex: 1 1 auto;
  min-height: 0;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  height: 100%;
  padding: var(--sp-6);
  text-align: center;
}

.empty__text {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}

.empty__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

/* 删除确认 / 迁移确认弹层：分组的清单，限高滚动；路径等宽、可换行 */
.purge__lead,
.purge__note {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}

.purge__groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: 320px;
  margin: var(--sp-3) 0;
  overflow-y: auto;
}

.purge__group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.purge__file {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-meta);
  word-break: break-all;
}

.purge__entries {
  margin: 0;
  padding-left: var(--sp-4);
  color: var(--ink-2);
  font-size: var(--fs-micro);
  word-break: break-all;
}

/* 删除是不可逆的：那一句说明按「要催」的颜色摆出来，不和正文一样灰 */
.purge__note {
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

/* 迁移确认的步骤清单：编号列表，与弹层正文同一档 */
.migrate__steps {
  margin: var(--sp-3) 0;
  padding-left: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  color: var(--ink);
  font-size: var(--fs-body);
  line-height: 1.7;
}
</style>
