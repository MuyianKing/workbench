<script setup lang="ts">
import type { ImageMigrationPlan, NoteImageAsset, NoteTextScan } from '@workbench/notes'
import type { Result } from '@/types'
import { Picture, Refresh } from '@element-plus/icons-vue'
import { buildImageAssets, imageOriginScopeDir, migrationReplacements, planImageMigration, sortImageAssets, totalImageBytes, unusedImages } from '@workbench/notes'
/**
 * 素材管理：当前这个笔记本传过哪些图、谁还在用、把没人用的清掉。
 *
 * 这一页回答的是「我能安全删掉哪些图」：素材（图片）不存在笔记本里，而在用户自己的
 * 图片仓库里（见 packages/notes/src/note-image.ts 的文件头），所以列表来自仓库、引用次数来自笔记本 ——
 * 两边凑起来才知道哪张图已经没人用了。
 *
 * 四件值得说清楚的事：
 *  1. **引用次数是「数出来的」，不是记下来的**。正文就是磁盘上的 `.md` 文件，别处编辑器
 *     随时能改，仓库那边也可能被别人的机器推过 —— 没有一个地方能维护一份「引用表」，
 *     所以口径是「打开面板就重新数一遍」（面板一开就扫，不靠用户记得点刷新），
 *     缓存只用于先把上次的结果显示出来、**不用于决定删不删**；
 *  2. **清单与引用都只限当前这个笔记本**。有 origin 的笔记本按 origin 共享层列（所有设备同一份），
 *     没有的按「本机设备 / 本机路径」那一层列。有 origin 时额外并一列旧层（早年按设备/路径存的图），
 *     让迁移前的老图也看得见；引用次数也只数这个笔记本自己的正文 —— 「未引用」于是真的等于「没人用」。
 *     别的笔记本的图不在这份清单里，也**删不到**：Rust 按允许的目录逐条挡住越界路径；
 *  3. **只放行「未引用」的那些**。引用次数大于 0 的行不给勾（删它一定会裂图），
 *     删除本身是「一次提交 + 一次推送」，与粘贴上传走的是同一套 git 机制；
 *  4. **旧图可显式搬到共享层**。有 origin 且正文还引用着旧层的图时给「迁移」按钮：计划（哪些图、
 *     怎么换 URL）由纯函数算好，上抛给 NotesView 编排（先 flush 编辑器、迁移后重读正文并同步
 *     笔记本仓库）。图片仓库与笔记本仓库各提交一次，做不到原子，确认框里说清楚。
 *
 * 组件自己取数与删除（数据只在面板打开期间存在，用完即弃，不必为它造 store 切片），
 * 配置从设置里现取，笔记本路径与 origin 由上层传进来（origin 是 store 探出来的，现探现传）——
 * **没打开笔记本时这一页什么都不列**：退回上一层目录去列图，等于把别的笔记本的图当成可删的。
 */
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { formatBytes, formatRelative } from '@/format'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{
  /** 当前笔记本：清单与引用次数都只限它（还没选文件夹时是空串，那时这一页什么都不列） */
  root: string
  /** 当前笔记本连着的 origin（有仓库时）：有它就把图片按 origin 共享层管，并提供旧图迁移 */
  origin: string
}>()

const emit = defineEmits<{
  /** 把迁移计划上抛给 NotesView 编排（它才能先 flush 编辑器、迁移后重读与同步） */
  migrate: [plan: ImageMigrationPlan]
}>()

/** 弹层开关:v-model 一条口径(与 AppDialog / el-dialog 相同,全应用的弹层都这么开) */
const open = defineModel<boolean>({ required: true })

const settings = useSettingsStore()

/** 一次扫描的结果（连同这次扫描的时间） */
interface ScanResult {
  at: number
  assets: NoteImageAsset[]
  /** 读不出来的笔记篇数 */
  failed: number
  /** 并集里属于旧层的图（迁移按钮的对象） */
  legacy: { path: string, name: string, size: number }[]
  /** 这次扫描用的旧层目录（仓库相对），生成迁移计划要用 */
  oldDir: string
  /** 当前笔记本所有正文（生成迁移计划时按文件名挑被引用的旧图） */
  texts: string[]
}

/**
 * 上一次的扫描结果。
 *
 * 放在模块里而不是组件里：面板关掉再打开时先把上次的清单显示出来，
 * 免得每次都要对着空面板等一次 git 拉取 —— 它只用于**显示**，
 * 打开面板时照样会在后台重新数一遍（引用次数错了会删错东西）。
 */
let cached: ScanResult | null = null

const scanning = ref(false)
/** 删除进行中：删除是一次提交 + 一次推送，几秒很正常，期间按钮要转圈禁点 */
const deleting = ref(false)
const result = ref<ScanResult | null>(null)
const error = ref('')

/** 只显示没人引用的那些（删除的候选） */
const onlyUnused = ref('all')

const SECTION_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '未引用', value: 'unused' },
]

/** 勾中的图片路径 */
const selected = ref<string[]>([])

const assets = computed(() => result.value?.assets ?? [])
const unused = computed(() => unusedImages(assets.value))
const visible = computed(() =>
  onlyUnused.value === 'unused' ? unused.value : assets.value,
)
const selectedAssets = computed(() =>
  assets.value.filter(asset => selected.value.includes(asset.path)),
)
const selectedBytes = computed(() => totalImageBytes(selectedAssets.value))
const unusedBytes = computed(() => totalImageBytes(unused.value))
const scannedText = computed(() =>
  result.value ? formatRelative(result.value.at, Date.now()) : '',
)

/** 有 origin 才谈得上「迁移旧图到共享层」；本机笔记本来就没有共享层，不显示这个按钮 */
const canMigrate = computed(() => Boolean(props.origin.trim()))

/** 待迁移的旧图（当前笔记本正文还引用着的那些）：生成计划用同一套纯函数，与筛选「未引用」分开 */
const migrationCandidates = computed(() => {
  const scan = result.value
  if (!canMigrate.value || !scan?.oldDir || !scan.legacy.length)
    return []
  const newDir = imageOriginScopeDir('images', props.origin)
  if (!newDir)
    return []
  return planImageMigration({ images: scan.legacy, texts: scan.texts, oldDir: scan.oldDir, newDir })
})

/** 没配图片仓库时，空态里「设置 → 笔记图片」那一下直接开设置并带到那一栏 */
function openImageRepoSetting(): void {
  settings.openSettingsDialog('noteImageRepo')
}

const repoMissing = computed(() => !settings.settings.noteImageRepo)
/** 还没打开笔记本：清单是按笔记本来分的，这一页这时没有什么可管的 */
const rootMissing = computed(() => !props.root.trim())

/**
 * 仓库地址或笔记本换了：上次那份清单已经不是这一层的东西了。
 *
 * 笔记本也必须看着 —— 换了笔记本却把上一个的清单先显示出来，等于把「别的笔记本的图」
 * 说成「没人用的图」（虽然真删会被 Rust 的路径边界挡回来，但那种「删不动」本身就是个错）。
 */
watch(
  () => [settings.settings.noteImageRepo, props.root, props.origin],
  () => {
    cached = null
    result.value = null
    selected.value = []
    // 面板正开着（改设置时走得到这里）就立刻按新的一层重数一遍，别让它停在空清单上
    if (open.value)
      void scan()
  },
)

watch(
  open,
  (value) => {
    if (!value)
      return
    // 先把上次的结果显示出来（有的话），再在后台重新数一遍
    if (cached && !result.value)
      result.value = cached
    void scan()
  },
)

/**
 * 数一遍：这个笔记本在图片仓库里那一层有哪些图（会走一次 git 拉取）+ 它自己所有笔记的正文。
 *
 * 两件事并行：它们互不依赖，串起来等只会让面板多转一会儿。
 * 引用次数按**文件名**数（同一张图在正文里可能写成 raw 地址、带前缀的地址、相对路径），
 * 口径全在 packages/notes/src/note-image.ts 的纯函数里，这里只负责把两边的数据凑到一起。
 */
async function scan(): Promise<void> {
  const repo = settings.settings.noteImageRepo
  if (!repo || rootMissing.value) {
    result.value = null
    cached = null
    error.value = ''
    return
  }

  scanning.value = true
  error.value = ''

  try {
    const root = props.root
    const origin = props.origin
    const textsTask: Promise<Result<NoteTextScan>> = window.workbench.scanNoteTexts(root)

    // 有 origin 时并列列两层：当前共享层 + 旧的设备/本机路径层，合并成并集（迁移前的老图在旧层）。
    // 两批列表 + 正文三者互不依赖，串起来等只会让面板多转一会儿。
    const currentTask = window.workbench.listNoteImages({ repo, root, origin })
    const legacyTask = origin.trim()
      ? window.workbench.listNoteImages({ repo, root, origin, scope: 'legacy' })
      : Promise.resolve(null)
    const [current, legacy, texts] = await Promise.all([currentTask, legacyTask, textsTask])

    if (!current.ok || !current.data) {
      error.value = current.error ?? '读取图片仓库失败'
      return
    }
    // 旧层拉不下来不算整体失败：共享层的图照常能管，只是这一轮迁不了老图（提示一句即可）
    const legacyFiles = legacy?.ok && legacy.data ? legacy.data.files : []
    const legacyDir = legacy?.ok && legacy.data ? legacy.data.dir : ''
    const legacyError = legacy && !legacy.ok ? (legacy.error ?? '') : ''
    // 正文读不出来不算失败：那样一张图都数不出来，界面上会显示成「全都未引用」——
    // 这正是最危险的错法，所以这里当作整体失败，宁可什么都不列
    if (!texts.ok || !texts.data) {
      error.value = texts.error ?? '读取笔记正文失败'
      return
    }

    // 并集去重（按仓库相对路径）：旧层与共享层不会重叠，但同一层被 repeated 扫到时只留一张
    const seen = new Set<string>()
    const merged: typeof current.data.files = []
    for (const file of [...current.data.files, ...legacyFiles]) {
      if (seen.has(file.path))
        continue
      seen.add(file.path)
      merged.push(file)
    }
    const legacyPaths = new Set(legacyFiles.map(file => file.path))

    const list: NoteImageAsset[] = sortImageAssets(
      buildImageAssets({
        images: merged,
        texts: texts.data.files.map(file => file.text),
        repo,
        branch: current.data.branch,
      }),
    )

    const textsOnly = texts.data.files.map(file => file.text)
    cached = {
      at: Date.now(),
      assets: list,
      failed: texts.data.failed,
      legacy: merged.filter(file => legacyPaths.has(file.path)),
      oldDir: legacyDir,
      texts: textsOnly,
    }
    if (legacyError)
      error.value = `旧层图片没读到，这一轮迁不了老图：${legacyError}`
    result.value = cached
    // 勾选跟着新结果走：已经不在清单里、或已经变成「有人引用」的，一律取消勾选
    selected.value = selected.value.filter(path =>
      list.some(asset => asset.path === path && asset.refs === 0),
    )
  }
  finally {
    scanning.value = false
  }
}

function toggle(path: string, checked: boolean): void {
  if (checked) {
    if (!selected.value.includes(path))
      selected.value = [...selected.value, path]
    return
  }
  selected.value = selected.value.filter(item => item !== path)
}

function selectAllUnused(): void {
  selected.value = unused.value.map(asset => asset.path)
}

function clearSelection(): void {
  selected.value = []
}

/**
 * 点缩略图看大图：用 EP 的 el-image 查看器（与 AI 对话里贴的图同一套）——
 * 能在这一列里左右翻、滚轮缩放、Esc / 点外面关掉。缩略图才 40×30，删之前想确认是哪张，
 * 光看缩略图不够。列表只取当前可见、且拼得出地址的那几张（与眼前看到的顺序一致）。
 */
const previewSrcs = computed(() =>
  visible.value.filter(asset => !!asset.url).map(asset => asset.url as string),
)
function previewIndex(asset: NoteImageAsset): number {
  return previewSrcs.value.indexOf(asset.url ?? '')
}

/**
 * 删除选中的图片。
 *
 * 确认框里把三件事说清楚：删几张、占多少、**删的是哪一份** ——
 * 清单只来自当前这个笔记本（这台机器传上来的那些），所以这里只说这一句就够了：
 * 要是有人把某张图的地址手工抄到别处（另一个笔记本、自己的文档里），那边会跟着裂图。
 * 这是这个功能唯一不可逆的地方，必须在按下去之前说。
 */
async function remove(): Promise<void> {
  const repo = settings.settings.noteImageRepo
  const targets = selectedAssets.value
  if (!repo || !targets.length)
    return

  // 确认框里是纯文本（不走 markdown），别在这里写 `**强调**`，那几个星号会原样显示出来
  const detail = `删除 ${targets.length} 张图片（${formatBytes(selectedBytes.value)}）？删除会提交并推送到图片仓库，不可恢复。`
  const hint
    = '这些图只来自当前笔记本，引用次数也只数了它；要是这个地址被你抄到别处用过，那里会裂图。'
  if (!(await confirmAction(`${detail}${hint}`, '删除', { confirmButtonText: '删除' })))
    return

  deleting.value = true
  try {
    const deleted = await window.workbench.deleteNoteImages({
      repo,
      root: props.root,
      origin: props.origin,
      paths: targets.map(asset => asset.path),
    })
    if (!deleted.ok || !deleted.data) {
      notifyError(deleted.error ?? '删除图片失败')
      return
    }

    selected.value = []
    notifySuccess(
      deleted.data.deleted
        ? `已删除 ${deleted.data.deleted} 张图片`
        : '这些图片已经不在仓库里了',
    )
    // 删完立刻重数一遍：清单与引用次数都要跟着磁盘上真实的样子走
    await scan()
  }
  finally {
    deleting.value = false
  }
}

/**
 * 迁移旧图到共享层：确认后把计划上抛给 NotesView 编排（它先 flush 编辑器、迁移后重读并同步）。
 *
 * 风险在确认框里说全：动**两个仓库**（图片仓库搬图、笔记本仓库改正文 URL），各提交推送一次，
 * 做不到原子；改过的正文会推到笔记本 origin，别的设备 pull 到之前旧链接会临时裂图。
 */
async function migrate(): Promise<void> {
  const scan = result.value
  const repo = settings.settings.noteImageRepo
  const renames = migrationCandidates.value
  if (!repo || !scan?.oldDir || !renames.length)
    return

  const newDir = imageOriginScopeDir('images', props.origin)
  if (!newDir)
    return

  const detail = `把 ${renames.length} 张旧图搬到共享层，并改写笔记本正文里的图片地址？`
  const hint = '这会同时改两个仓库：图片仓库搬文件、笔记本仓库改正文，各提交推送一次（做不到原子）。迁移前请先同步笔记本，期间别在别处编辑；别处 pull 到新正文前旧链接可能临时打不开。'
  if (!(await confirmAction(`${detail}${hint}`, '迁移', { confirmButtonText: '开始迁移' })))
    return

  emit('migrate', {
    repo,
    root: props.root,
    oldDir: scan.oldDir,
    newDir,
    renames,
    replacements: migrationReplacements(scan.oldDir, newDir),
  })
  // 迁移由上层异步执行；面板关掉，等上层完成后用户再打开看最新清单
  open.value = false
}
</script>

<template>
  <!-- penetrable：对着图片清单删东西时，正文还要看得见（见 AppDialog.vue） -->
  <AppDialog
    v-model="open"
    title="素材管理"
    width="min(780px, calc(100vw - 80px))"
    penetrable
  >
    <!-- 没配仓库：这一页没什么可管的，说清楚去哪儿配 -->
    <div v-if="repoMissing" class="empty asset-empty">
      <el-icon class="empty__icon">
        <Picture />
      </el-icon>
      <p>还没有配置图片仓库。</p>
      <p class="empty__hint">
        笔记里粘贴的图片都推到一个你自己的 git 仓库，这一页管的是这个笔记本传上去的那些：谁还在用、把没人用的清掉。
      </p>
      <button class="empty__action" type="button" @click="openImageRepoSetting">
        去设置 · 笔记图片
      </button>
    </div>

    <!-- 没打开笔记本：素材是按笔记本来分的，这时列不出「这个笔记本的图」，也不该拿上一层去猜 -->
    <div v-else-if="rootMissing" class="empty asset-empty">
      <el-icon class="empty__icon">
        <Picture />
      </el-icon>
      <p>还没有打开笔记本。</p>
      <p class="empty__hint">
        图片仓库是所有笔记本共用的一份，而素材是按笔记本来管的 ——
        先在左栏选一个笔记文件夹（或新建一篇），再回来看它传过哪些图。
      </p>
    </div>

    <template v-else>
      <div class="assets__bar">
        <el-segmented v-model="onlyUnused" :options="SECTION_OPTIONS" size="small" />

        <span class="assets__summary">
          共 {{ assets.length }} 张 · 未引用
          <b :class="{ 'is-warn': unused.length > 0 }">{{ unused.length }}</b>
          张<span v-if="unused.length">（{{ formatBytes(unusedBytes) }}）</span>
        </span>

        <span class="assets__spacer" />

        <span v-if="scannedText" class="assets__time">上次扫描：{{ scannedText }}</span>

        <!-- 有 origin 且有正文还在用的旧图时，才给迁移入口：本机笔记没有共享层，不显示 -->
        <el-tooltip
          v-if="canMigrate && migrationCandidates.length"
          content="把这台机器早年按设备/路径存的图搬到 origin 共享层，跨设备共用；会改正文并推送两个仓库"
          placement="top"
        >
          <el-button size="small" type="primary" plain :disabled="scanning" @click="migrate">
            迁移 {{ migrationCandidates.length }} 张旧图
          </el-button>
        </el-tooltip>

        <el-tooltip content="重新读取仓库并重数引用次数" placement="top">
          <el-button size="small" text :disabled="scanning" @click="scan">
            <el-icon :class="{ 'is-loading': scanning }">
              <Refresh />
            </el-icon>
          </el-button>
        </el-tooltip>
      </div>

      <p v-if="error" class="assets__error">
        {{ error }}
      </p>

      <!-- 有笔记没读到：少读一篇就可能把还在用的图当成没人引用，得说在前面 -->
      <p v-else-if="result?.failed" class="assets__error">
        有 {{ result.failed }} 篇笔记读不出来（编码或权限问题），下面的引用次数可能偏少，
        删之前请自己再看一眼。
      </p>

      <p v-else class="assets__hint">
        列的是这个笔记本的图：连了仓库的按仓库共享（所有设备同一份），没连的按这台机器这一份；
        引用次数按图片文件名数它自己的笔记（正文里写成什么地址都认）。
      </p>

      <div v-loading="scanning" class="assets">
        <div v-if="!assets.length && !scanning" class="empty assets__none">
          <el-icon class="empty__icon">
            <Picture />
          </el-icon>
          <p>{{ onlyUnused === 'unused' ? '没有未引用的图片。' : '这个笔记本还没有传过图片。' }}</p>
        </div>

        <div
          v-for="asset in visible"
          :key="asset.path"
          class="asset"
          :class="{ 'is-unused': asset.refs === 0 }"
        >
          <el-checkbox
            :model-value="selected.includes(asset.path)"
            :disabled="asset.refs > 0"
            :aria-label="`选择 ${asset.name}`"
            @change="(checked: string | number | boolean) => toggle(asset.path, Boolean(checked))"
          />

          <!-- 缩略图直接取仓库里的原图（与正文里显示图片是同一条路）：只在面板打开时、
               且推得出地址时才有；按行懒加载。点一下用 EP 查看器看大图，能在这列里翻、缩放 -->
          <el-image
            v-if="asset.url"
            class="asset__thumb is-clickable"
            :src="asset.url"
            :preview-src-list="previewSrcs"
            :initial-index="previewIndex(asset)"
            fit="contain"
            preview-teleported
            hide-on-click-modal
            :show-progress="previewSrcs.length > 1"
            loading="lazy"
          />
          <span v-else class="asset__thumb" title="拼不出访问地址（去设置里填前缀）">
            <el-icon>
              <Picture />
            </el-icon>
          </span>

          <span class="asset__name truncate" :title="asset.path">{{ asset.name }}</span>

          <span class="asset__size">{{ formatBytes(asset.size) }}</span>
          <span class="asset__refs" :class="{ 'is-zero': asset.refs === 0 }">
            {{ asset.refs ? `被引用 ${asset.refs} 次` : '未引用' }}
          </span>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="assets__foot">
        <el-button size="small" :disabled="!unused.length || scanning" @click="selectAllUnused">
          全选未引用（{{ unused.length }}）
        </el-button>
        <el-button size="small" :disabled="!selected.length" @click="clearSelection">
          清空选择
        </el-button>

        <span class="assets__spacer" />

        <el-button size="small" @click="open = false">
          关闭
        </el-button>
        <el-button
          type="danger"
          size="small"
          :disabled="!selected.length || scanning || deleting"
          :loading="deleting"
          @click="remove"
        >
          {{ selected.length ? `删除 ${selected.length} 张` : '删除' }}
        </el-button>
      </div>
    </template>
  </AppDialog>
</template>

<style scoped>
.asset-empty {
  min-height: 160px;
}

/* 空态里直达设置的按钮：文字按钮的样，主题色只用在交互态 */
.empty__action {
  margin-top: var(--sp-1);
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-accent);
  font-size: var(--fs-body);
  cursor: pointer;
}

.empty__action:hover {
  text-decoration: underline;
}

.assets__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.assets__summary {
  font-size: var(--fs-meta);
  color: var(--ink-2);
  flex-shrink: 0;
}

.assets__summary b {
  color: var(--ink);
}

.assets__summary b.is-warn {
  color: var(--st-fail);
}

.assets__spacer {
  flex: 1 1 auto;
}

.assets__time {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  flex-shrink: 0;
}

.assets__hint,
.assets__error {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
}

.assets__error {
  color: var(--st-fail);
}

/* 清单自己滚：素材可能有几百张，弹窗高度得稳住 */
.assets {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 180px;
  max-height: min(52vh, 460px);
  margin-top: var(--sp-2);
  overflow-y: auto;
}

/* 列表区里那格空态：沿用全局 .empty（居中 + 图标），只收 paddings 与图标的尺寸 */
.assets__none {
  padding: var(--sp-4) 0;
}

.assets__none .empty__icon {
  font-size: 32px;
}

.asset {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
}

.asset:hover {
  background: var(--bg-inset);
}

/* 未引用的那一批给一点提示色：要删的就是它们 */
.asset.is-unused .asset__refs {
  color: var(--st-fail);
}

/* 缩略图：el-image 的外框收成一小块，里面的图按 contain 缩进去（不裁、不放大） */
.asset__thumb {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 30px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--ink-3);
  overflow: hidden;
}

.asset__thumb.is-clickable {
  cursor: pointer;
}

.asset__thumb.is-clickable:hover {
  border-color: var(--border-strong);
}

/* el-image 的 inner 默认 width/height 100%，配上 fit=contain 正好缩在框里 */
.asset__thumb :deep(.el-image__inner) {
  display: block;
}

/* 拼不出地址时的占位图标（不是 el-image，是一枚 span） */
.asset__thumb > .el-icon {
  font-size: 18px;
}

.asset__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.asset__size,
.asset__refs {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.asset__refs {
  min-width: 72px;
  text-align: right;
}

.assets__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
</style>
