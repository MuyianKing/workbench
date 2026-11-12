<script setup lang="ts">
import type { AppSettings } from '@/types'
import { APP_NAME_DEFAULT, APP_NAME_MAX_LENGTH } from '@workbench/appearance'
import { accountLabel } from '@workbench/auth'
import { EDITOR_HOTKEY_ACTIONS, EDITOR_HOTKEY_DEFAULTS, EDITOR_HOTKEY_LABELS, resolveEditorHotkeyConflict } from '@workbench/notes'
import { WEATHER_CITY_MAX } from '@workbench/weather'
import { sanitizeZentaoPollMinutes } from '@workbench/zentao'
import { ElMessage } from 'element-plus'
/**
 * 设置 · 通用：程序（名称 / 快捷键 / 开机自启 / 网速球）、网关（TBuddy / Qoder
 * 各自的随程序启动与共用的福利每天自动）、天气、禅道、笔记（图片仓库）、账号与同步仓库。
 *
 * 四个文本项都是「草稿字段」（useDraftField）：边打边存会把半截内容写进设置，
 * 失焦 / 回车才提交，提交后由 store 收敛、收敛后的值回推草稿。
 *
 * 快捷键那一行是一块共用件（HotkeyField）：录制态自己管、失焦即放弃，
 * 所以这一屏不再需要盯着弹窗开关去复位它。
 */
import { computed, ref, watch } from 'vue'
import AccountDialog from '@/components/AccountDialog.vue'
import HotkeyField from '@/components/HotkeyField.vue'
import { useDraftField } from '@/composables/use-draft-field'
import { useAuthStore } from '@/stores/auth'
import { usePerksAutoStore } from '@/stores/perks-auto'
import { useSettingsStore } from '@/stores/settings'
import { useZentaoStore } from '@/stores/zentao'

// 设置弹窗统一按这个 prop 传；本屏用它来重新读网关的「随程序启动」开关
const props = defineProps<{ open: boolean }>()

const settings = useSettingsStore()
const auth = useAuthStore()
const zentao = useZentaoStore()

const account = computed(() => auth.status?.account ?? null)

/** 「账号」那一行开的弹窗。顶栏也有一颗入口，两处各自开各自的 */
const accountVisible = ref(false)

/**
 * 网关的常驻开关都住在各自网关的目录里（`settings.json` 的 `autoStart`、
 * `perks-auto.json` 的 `enabled`），不走应用设置。每次打开设置弹窗重新读一次，
 * 免得与网关页的旧状态打架。
 *
 * 「福利每天自动」只有一个开关，但两边的自动跑各读自己的 `perks-auto.json`，
 * 所以拨一次要写两份；读的时候任一边开着就算开着（旧版本可能只写过一边）。
 */
const gatewayAutoStart = ref(false)
const gatewayAutoSaving = ref(false)
const qoderAutoStart = ref(false)
const qoderAutoSaving = ref(false)
const perksAutoEnabled = ref(false)
const perksAutoSaving = ref(false)
const perksAuto = usePerksAutoStore()

async function loadGatewaySettings(): Promise<void> {
  const [status, perks, qoder, qoderPerks] = await Promise.all([
    window.workbench.gatewayStatus(),
    window.workbench.gatewayPerksAutoConfig(),
    window.workbench.qoderStatus(),
    window.workbench.qoderPerksAutoConfig(),
  ])
  if (status.ok && status.data)
    gatewayAutoStart.value = status.data.autoStart
  if (qoder.ok && qoder.data)
    qoderAutoStart.value = qoder.data.autoStart
  const gatewayEnabled = perks.ok && perks.data ? perks.data.enabled : false
  const qoderEnabled = qoderPerks.ok && qoderPerks.data ? qoderPerks.data.enabled : false
  const enabled = gatewayEnabled || qoderEnabled
  perksAutoEnabled.value = enabled
  // 两份配置不一致（旧版本只写过一边）：按这个开关对齐，别让 Qoder 那份留在关着
  if (gatewayEnabled !== enabled || qoderEnabled !== enabled)
    void setPerksAuto(enabled)
}

/** 把「福利每天自动」写进两个网关各自的配置；失败时返回给用户看的一句话。 */
async function setPerksAuto(enabled: boolean): Promise<string | null> {
  const [gateway, qoder] = await Promise.all([
    window.workbench.gatewayPerksAutoSet(enabled),
    window.workbench.qoderPerksAutoSet(enabled),
  ])
  if (!gateway.ok || !qoder.ok)
    return gateway.error ?? qoder.error ?? '保存福利每天自动失败'
  return null
}

async function toggleQoderAutoStart(value: unknown): Promise<void> {
  if (qoderAutoSaving.value)
    return
  const enabled = Boolean(value)
  qoderAutoSaving.value = true
  try {
    const result = await window.workbench.qoderAutoStartSet(enabled)
    if (!result.ok) {
      ElMessage.error(result.error ?? '保存随程序启动失败')
      return
    }
    qoderAutoStart.value = enabled
  }
  finally {
    qoderAutoSaving.value = false
  }
}

async function toggleGatewayAutoStart(value: unknown): Promise<void> {
  if (gatewayAutoSaving.value)
    return
  const enabled = Boolean(value)
  gatewayAutoSaving.value = true
  try {
    const result = await window.workbench.gatewayAutoStartSet(enabled)
    if (!result.ok) {
      ElMessage.error(result.error ?? '保存随程序启动失败')
      return
    }
    gatewayAutoStart.value = enabled
  }
  finally {
    gatewayAutoSaving.value = false
  }
}

async function togglePerksAuto(value: unknown): Promise<void> {
  if (perksAutoSaving.value)
    return
  const enabled = Boolean(value)
  perksAutoSaving.value = true
  try {
    const error = await setPerksAuto(enabled)
    if (error) {
      ElMessage.error(error)
      return
    }
    perksAutoEnabled.value = enabled
    // 打开后立刻补跑一次；今天已跑过 / 不在夜间窗口时后端会直接返回
    if (enabled)
      void perksAuto.runNow()
  }
  finally {
    perksAutoSaving.value = false
  }
}

watch(() => props.open, (open) => {
  if (open)
    void loadGatewaySettings()
})

const isPackaged = computed(() => !import.meta.env.DEV)

function save(patch: Partial<AppSettings>): void {
  void settings.updateSettings(patch)
}

/**
 * 程序名称的草稿（useDraftField，见 composables/use-draft-field.ts）：
 * 边打边存会每敲一个字就回推一次设置（还会被主进程收敛后覆盖光标），
 * 所以本地先存着，失焦 / 回车时再提交。
 */
const appNameDraft = useDraftField(() => settings.settings.appName)

function commitAppName(): void {
  if (appNameDraft.value === settings.settings.appName)
    return
  save({ appName: appNameDraft.value })
}

/**
 * 同步仓库地址的草稿：与程序名称同理，边打边存会把半截地址写进设置
 * （每次落盘都会触发一轮注定失败的同步），失焦 / 回车时再提交。
 * 提交后由 store 收敛（去掉空白、认不出的当没填），回推的值会盖掉草稿。
 */
const syncRepoDraft = useDraftField(() => settings.settings.tokenSyncRepo)

function commitSyncRepo(): void {
  if (syncRepoDraft.value === settings.settings.tokenSyncRepo)
    return
  save({ tokenSyncRepo: syncRepoDraft.value })
}

// ---------- 笔记图片 ----------

const imageRepoDraft = useDraftField(() => settings.settings.noteImageRepo)

function commitImageRepo(): void {
  if (imageRepoDraft.value === settings.settings.noteImageRepo)
    return
  save({ noteImageRepo: imageRepoDraft.value })
}

// ---------- 天气 ----------

/**
 * 天气城市的草稿：与程序名称同一套（失焦 / 回车才提交，收敛后的值回推草稿）。
 * 留空提交 = 关闭这条出口 —— 收敛会把空白压成空串。
 */
const weatherCityDraft = useDraftField(() => settings.settings.weatherCity)

function commitWeatherCity(): void {
  if (weatherCityDraft.value === settings.settings.weatherCity)
    return
  save({ weatherCity: weatherCityDraft.value })
}

// ---------- 快捷键 ----------
//
// 录制本身（按键名归一化、Esc 放弃、缺修饰键时的提示）在 components/HotkeyField.vue 与
// composables/use-hotkey-recorder.ts 里 —— 设置·截图那两条快捷键用的是同一套，
// 三处录出来的串必须一模一样。这里只管把录到的值存进设置。

function saveHotkey(accelerator: string): void {
  // 换了组合键要重新注册，所以一定带上启用开关
  save({ hotkey: accelerator, hotkeyEnabled: true })
}

// ---------- 编辑器快捷键 ----------
//
// 笔记正文（NoteEditor）里那套自定义键位：动作清单、撞键腾位、收敛都在
// @workbench/notes 的 editor-hotkeys.ts，这里只管把录到的表存进设置。
// 表只存改过的项：没出现的动作走 Vditor 内置键位；空串 = 禁用。

const editorHotkeys = computed(() => settings.settings.editorHotkeys ?? {})

/** 一个动作当前的键串；不在表里 = 没配过 —— 按钮里垫的显示值就是编辑器的内置键位 */
function editorHotkeyOf(name: string): string {
  return editorHotkeys.value[name] ?? EDITOR_HOTKEY_DEFAULTS[name] ?? ''
}

/** 这个动作有没有被用户改过（决定「恢复默认」那颗出不出） */
function isEditorHotkeyCustomized(action: string): boolean {
  return action in editorHotkeys.value
}

/** 录完一个组合键：撞了别的动作的键先腾位（提示一声），再整表存进设置 */
function saveEditorHotkey(action: string, accelerator: string): void {
  const { next, cleared } = resolveEditorHotkeyConflict(editorHotkeys.value, action, accelerator)
  if (cleared.length) {
    const labels = cleared.map(name => EDITOR_HOTKEY_LABELS[name] ?? name)
    ElMessage.warning(`该组合键已从「${labels.join('、')}」上腾出（原来那个动作改回内置键位）`)
  }
  save({ editorHotkeys: next })
}

/** 恢复默认 = 把这一项从表里删掉（回到编辑器内置键位） */
function resetEditorHotkey(action: string): void {
  if (!isEditorHotkeyCustomized(action))
    return
  const next = { ...editorHotkeys.value }
  delete next[action]
  save({ editorHotkeys: next })
}
</script>

<template>
  <section class="pane">
    <div class="block">
      <h3 class="block__title">
        程序
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">程序名称</span>
          <span class="row__hint">
            显示在标题栏、托盘提示与窗口标题上；留空恢复为 {{ APP_NAME_DEFAULT }}，
            最多 {{ APP_NAME_MAX_LENGTH }} 个字符。
          </span>
        </div>
        <el-input
          v-model="appNameDraft"
          class="name-input"
          size="small"
          :maxlength="APP_NAME_MAX_LENGTH"
          spellcheck="false"
          :placeholder="APP_NAME_DEFAULT"
          @change="commitAppName"
        />
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">全局快捷键</span>
          <span class="row__hint">在任何窗口下唤起 / 隐藏 {{ settings.settings.appName }}。</span>
        </div>
        <el-switch
          :model-value="settings.settings.hotkeyEnabled"
          size="small"
          @update:model-value="(value: unknown) => save({ hotkeyEnabled: Boolean(value) })"
        />
      </div>

      <div class="row row--hotkey">
        <HotkeyField
          :model-value="settings.settings.hotkey"
          :disabled="!settings.settings.hotkeyEnabled"
          @update:model-value="saveHotkey"
        />
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">开机自启</span>
          <span class="row__hint">
            {{ isPackaged ? '登录系统后自动在后台启动，只在托盘显示图标，点击图标即可打开界面。' : '开发模式下不会写入系统自启项。' }}
          </span>
        </div>
        <el-switch
          :model-value="settings.settings.launchAtLogin"
          size="small"
          :disabled="!isPackaged"
          @update:model-value="(value: unknown) => save({ launchAtLogin: Boolean(value) })"
        />
      </div>

      <!--
        网速球：一扇独立的置顶窗口，在桌面上随便摆，显示实时上下行速率。
        它与主窗口互不相干（主窗口收进托盘也照样在），所以位置只对本机成立 ——
        进数据文件、不参与外观同步（见 docs/modules/float-ball.md）。
      -->
      <div class="row">
        <div class="row__text">
          <span class="row__label">网速球</span>
          <span class="row__hint">
            在桌面上随便摆，显示实时下载 / 上传速度；拖到屏幕左或右边缘会收成贴边的一条竖条，
            鼠标移开收回去、移上来再摊开。
          </span>
        </div>
        <el-switch
          :model-value="settings.settings.ballEnabled"
          size="small"
          @update:model-value="(value: unknown) => save({ ballEnabled: Boolean(value) })"
        />
      </div>
    </div>

    <!--
      网关：TBuddy 与 Qoder 各有各的端口、密钥与「随程序启动」，可以同时跑。
      开关都住在各自网关的配置里，不走应用设置。
    -->
    <div class="block">
      <h3 class="block__title">
        网关（TBuddy / Qoder）
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">TBuddy 随程序启动</span>
          <span class="row__hint">
            应用启动时自动在 127.0.0.1 监听（端口在 TBuddy 页的接入信息里改）；关掉后需要手动点「启动」。
          </span>
        </div>
        <el-switch
          :model-value="gatewayAutoStart"
          size="small"
          :loading="gatewayAutoSaving"
          @update:model-value="toggleGatewayAutoStart"
        />
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">Qoder 随程序启动</span>
          <span class="row__hint">
            同上，但用的是 Qoder 自己的端口与密钥（两个代理互不相干，可以同时跑）。
          </span>
        </div>
        <el-switch
          :model-value="qoderAutoStart"
          size="small"
          :loading="qoderAutoSaving"
          @update:model-value="toggleQoderAutoStart"
        />
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">福利每天自动</span>
          <span class="row__hint">
            TBuddy 与 Qoder 一起：启动后补跑签到与一键做任务；夜猫子任务在 23:00–08:00 单独跑一次。
            成长连登与抽奖不自动。
          </span>
        </div>
        <el-switch
          :model-value="perksAutoEnabled"
          size="small"
          :loading="perksAutoSaving"
          @update:model-value="togglePerksAuto"
        />
      </div>
    </div>

    <!--
      天气：顶栏问候语旁那一小段实况（`多云 19°`）。只有一个配置项：城市名 ——
      留空就是整条出口关闭，与两个同步仓库「留空即关闭」同一条规矩。
    -->
    <div class="block">
      <h3 class="block__title">
        天气
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">城市</span>
          <span class="row__hint">
            顶栏问候语旁显示当地的实时天气，每半小时更新一次；留空则不显示、也不联网。
            城市名会作为查询串发出去：查经纬度走 OpenStreetMap 的公开检索，取实况走
            Open-Meteo 的免费接口 —— 两处都免费、不需要凭据（如「上海」「常州」）。
          </span>
        </div>
        <el-input
          v-model="weatherCityDraft"
          class="name-input"
          size="small"
          :maxlength="WEATHER_CITY_MAX"
          spellcheck="false"
          placeholder="城市名，如 上海"
          @change="commitWeatherCity"
        />
      </div>
    </div>

    <div class="block">
      <h3 class="block__title">
        禅道
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">检查间隔（分钟）</span>
          <span class="row__hint">0 = 关闭</span>
        </div>
        <el-input-number
          :model-value="settings.settings.zentaoPollMinutes"
          size="small"
          :min="0"
          :max="1440"
          :step="1"
          :precision="0"
          @change="(value: number | undefined) => save({ zentaoPollMinutes: sanitizeZentaoPollMinutes(value) })"
        />
      </div>

      <!--
        后台检查 / 通知失败时的原因。禅道页面在系统浏览器里，应用自己的话没地方贴在它上面，
        所以这句话落在配置检查间隔的同一块里 —— 通知突然不响了，来这里看。
      -->
      <p v-if="zentao.error" class="row__error" role="alert">
        {{ zentao.error }}
      </p>
    </div>

    <!--
      笔记这一块管两件事：图片往哪儿推、技能库在仓库里的哪一层。
      笔记**本身**那个 git 仓库不在这里，也没有这个地方：同步到哪儿由那个文件夹自己连着的
      远端决定（见 packages/notes/src/note.ts 的 NoteRepoState），没仓库的文件夹就是本机的笔记 ——
      应用既不替用户 init、也不替他接远端。笔记文件夹本身在笔记页左栏底部挑，这里不重复显示。
    -->
    <div class="block">
      <h3 class="block__title">
        笔记
      </h3>

      <!--
        笔记里的图片：粘贴的图片推到用户自己的一个 git 仓库里，正文里只留一个外链。
        地址由仓库地址推导（GitHub / Gitee / GitLab 三家自动认，其余推不出来），
        而落在仓库的哪一层是定死的（`images/<设备>/<笔记本>`，见 packages/notes/src/note-image.ts），
        所以这一项要填的只有一样：往哪个仓库推。
      -->
      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">图片仓库</span>
          <span class="row__hint">
            往笔记里粘贴图片时推进这个仓库，正文里只留一个链接（留空则粘贴时提示）。
            图片落在仓库的 images/&lt;本机设备&gt;/&lt;笔记本&gt; 下；
            凭据跟着账号走：登录过就用账号的 token，没登录就用系统里 git 配好的。
          </span>
        </div>
        <el-input
          v-model="imageRepoDraft"
          size="small"
          spellcheck="false"
          placeholder="git@github.com:you/notes-images.git"
          @change="commitImageRepo"
        />
      </div>

      <!--
        编辑器快捷键：给右键菜单里那组常用动作各配一个组合键（Ctrl+3 → 三级标题这种）。
        录制件与全局快捷键共用 HotkeyField（同一种按法录出的串一致）；
        表只存改过的项 —— 没配的动作按编辑器内置键位走（按钮里垫显示的就是内置键），
        「恢复默认」就是把这一项删掉。
      -->
      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">编辑器快捷键</span>
          <span class="row__hint">只对笔记正文生效；两个动作撞了同一个键时，先配的那个自动腾出。</span>
        </div>
        <div class="hotkey-grid">
          <div v-for="action in EDITOR_HOTKEY_ACTIONS" :key="action.name" class="hotkey-grid__row">
            <span class="hotkey-grid__name">{{ action.label }}</span>
            <HotkeyField
              :model-value="editorHotkeyOf(action.name)"
              :hint="false"
              @update:model-value="(value: string) => saveEditorHotkey(action.name, value)"
            />
            <!--
              恢复默认只在改过的行出现，但它的**位置恒定占着**（没改的行渲染等宽占位）：
              不然配过的行比没配的行宽出一截，同一列的键位按钮左右各挪，竖向对不齐。
            -->
            <button
              v-if="isEditorHotkeyCustomized(action.name)"
              class="hotkey-grid__reset"
              type="button"
              title="恢复默认（回到编辑器内置键位）"
              aria-label="恢复默认"
              @click="resetEditorHotkey(action.name)"
            >
              恢复默认
            </button>
            <span v-else class="hotkey-grid__reset" aria-hidden="true" />
          </div>
        </div>
      </div>

      <!--
        技能（skill）没有设置项：技能库是**它自己的一个目录**（技能页那颗「选择技能文件夹」挑的），
        与上面那个笔记文件夹互不相干 —— 可以正好是同一处，也可以各有各的仓库。
        所以这里既没有「技能目录」也没有「它在仓库哪一层」：那一层由磁盘决定
        （从技能库目录往上找最近的 `.git`，见 packages/skills/src/skills.ts 的 SkillLibraryState）。
      -->
    </div>

    <!--
      账号这一块只剩登录状态与同步仓库地址（从别的机器取外观已挪到「外观」那一屏）。
      没登录时地址那一行不出现 —— 数据全部留在本机，登录回来接着用。
    -->
    <div class="block">
      <h3 class="block__title">
        账号
      </h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">登录状态</span>
          <span class="row__hint">
            登录后同步就用这个账号的 token 授权（私有仓库省掉先配 git 凭据）；
            不登录也能同步，走系统里 git 配好的那一套。
          </span>
        </div>
        <el-button size="small" @click="accountVisible = true">
          {{ account ? accountLabel(account) : '登录…' }}
        </el-button>
      </div>

      <template v-if="account">
        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">同步仓库</span>
            <span class="row__hint">
              填一个 git 仓库地址（建议私有仓库），留空即不同步；失焦或回车生效。
            </span>
          </div>
          <el-input
            v-model="syncRepoDraft"
            size="small"
            spellcheck="false"
            placeholder="git@github.com:you/workbench-token.git"
            @change="commitSyncRepo"
          />
        </div>
      </template>
    </div>

    <AccountDialog v-model="accountVisible" />
  </section>
</template>

<style scoped>
/* 程序名称输入框：定宽，别把右边这列的宽度让给长名字 */
.name-input {
  width: 220px;
  flex-shrink: 0;
}

.row--hotkey {
  align-items: center;
}

/*
 * 编辑器快捷键：两列小网格（动作名 + 录制件），不用把 18 行铺成 18 个大条。
 * 三列网格用**固定的列模板**而不是自由 flex：动作名列 + 键位列 + 恢复默认列都各有定宽，
 * 同一列的按钮才落在同一条竖线上（恢复默认那格恒定占位，见模板里的说明）。
 */
.hotkey-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--sp-2) var(--sp-4);
  width: 100%;
}

.hotkey-grid__row {
  display: grid;
  grid-template-columns: 1fr auto 44px;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.hotkey-grid__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 键位按钮定宽：取装得下最长那串（Control + Shift + H ≈ 168px）的值，全列落在同一条竖线 */
.hotkey-grid__row :deep(.hotkey) {
  width: 168px;
  min-width: 0;
  justify-content: center;
}

/* 键位定宽后按钮占 168，恢复默认那列相应放宽，保持同一列的按钮都在一条竖线上 */
.hotkey-grid__row {
  grid-template-columns: 1fr auto 48px;
}

.hotkey-grid__reset {
  flex: 0 0 auto;
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  cursor: pointer;
  transition: color 0.15s ease;
}

/* 空占位（没改过的行）：不响应任何指针动作，只把「恢复默认」那格的位置占住 */
span.hotkey-grid__reset {
  cursor: default;
}

.hotkey-grid__reset:hover {
  color: var(--st-fail);
}
</style>
