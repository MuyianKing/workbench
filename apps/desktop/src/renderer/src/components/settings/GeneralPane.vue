<script setup lang="ts">
import type { AppSettings } from '@/types'
import { APP_NAME_DEFAULT, APP_NAME_MAX_LENGTH } from '@workbench/appearance'
import { accountLabel } from '@workbench/auth'
import { WEATHER_CITY_MAX } from '@workbench/weather'
import { sanitizeZentaoPollMinutes } from '@workbench/zentao'
/**
 * 设置 · 通用：程序（名称 / 快捷键 / 开机自启）、天气、禅道、笔记（图片仓库）、账号与同步仓库。
 *
 * 四个文本项都是「草稿字段」（useDraftField）：边打边存会把半截内容写进设置，
 * 失焦 / 回车才提交，提交后由 store 收敛、收敛后的值回推草稿。
 *
 * 快捷键那一行是一块共用件（HotkeyField）：录制态自己管、失焦即放弃，
 * 所以这一屏不再需要盯着弹窗开关去复位它。
 */
import { computed, ref } from 'vue'
import AccountDialog from '@/components/AccountDialog.vue'
import HotkeyField from '@/components/HotkeyField.vue'
import { useDraftField } from '@/composables/use-draft-field'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { useZentaoStore } from '@/stores/zentao'

// 这一屏不再需要 open，但设置弹窗统一按这个 prop 传；声明着免得被当成未声明属性透到根元素上
defineProps<{ open: boolean }>()

const settings = useSettingsStore()
const auth = useAuthStore()
const zentao = useZentaoStore()

const account = computed(() => auth.status?.account ?? null)

/** 「账号」那一行开的弹窗。顶栏也有一颗入口，两处各自开各自的 */
const accountVisible = ref(false)

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
        后台检查 / 通知失败时的原因。禅道窗口是远程页面，应用自己的话没地方贴在它上面，
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
</style>
