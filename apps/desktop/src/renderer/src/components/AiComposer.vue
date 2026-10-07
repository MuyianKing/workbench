<script setup lang="ts">
/**
 * 写指令的那一条：输入框 + 一行控件（工具权限、这一轮用哪个模型、思考几档、发送 / 停止）。
 *
 * **就是「说一句」**：发出去的那句接在当前这段对话后面（会话见左栏那棵树），上下文由那个
 * 会话的 Pi 进程接着 —— 不是新起一轮。**还没有会话时它就是起始那一屏的正中间那张卡片**：
 * 那一句是这一段对话的第一句，会话在发出时按位置那一栏挑好的目录现建（见 stores/ai.ts 的 run）。
 *
 * **贴进来的图排成一行缩略图，在输入框上面**（截图、复制的图片文件都从粘贴进来）：
 * 收下的那几张随这一句一起发出去（同一行 JSON，见 ai.rs 的 prompt_frame），角上那颗 × 删掉
 * 一张，**点一下看大图**（56px 的缩略图连截图上的字都认不出）。指令与图都归页面（AiView）
 * 持有 —— 这里只把剪贴板里的图读出来、报给页面收（`add-images`）
 * —— **认不出格式的当场说清楚**（Pi 会把认不出的换成一句「图被略去」，那等于白贴）；
 * 模型看不看得见图不归这里管：贴上的图先留着，发不出去时由发送按钮的悬停说（`blocking`）。
 *
 * **底下那一行按「一排 chip」画，不按表单画**（这是这一页最像工具的地方，照通用客户端
 * 那一排的样子）：三个控件**只挂一个图标**（锁 / cpu / 表盘，见下面 template 里那句），
 * 不带「权限」「模型」「思考」这样的文字标签 —— 标签是把控件当输入项，一排箭头看下来
 * 全是重复的字；做成**没有边框的浅底 chip**（与位置栏那颗 `.pick__item` 同一副样子），
 * 发送是一颗**圆形实心**的箭头。**别把文字标签加回来、也别给 chip 描边**。
 *
 * 与 store 的分工：**说一句是报给页面**（`send` 事件，指令与图跟着走，页面转给 store 跑一轮；
 * 「能不能发 / 还差什么」的判断也长在自己身上 —— 那两样是这条输入框自己的事，见 canRun /
 * blocking），换权限、换模型与换档位是会话自己的配置记忆，直接写 store。**模型管理那个弹层
 * **不归它** —— 弹层挂在页面最外层，所以这里只报一声「要开配置」（技能的管理入口在左栏
 * 底部那一行，不在这条输入框上）。
 *
 * **技能**在这条输入框上有一处自己的样子：敲 `/` 出候选那一列，选中就把 `/skill:名字`
 * 放到最前面 —— Pi 只在文本开头认这条命令（见 shared/ai.ts 的 taskPrompt），所以命令必须
 * 是第一个字，候选那一列也就长在输入框正上方。
 *
 * 权限那一栏在下拉里给每一档挂一行小字（这一档到底问不问）—— 下拉挂在 body 上，
 * 那两行字的样式在 global.css（`.composer-permission-pop`）。
 */
import { computed, ref, watch } from 'vue'
import { Close, Cpu, Lock, Odometer, Setting, Top, Unlock, VideoPause } from '@element-plus/icons-vue'
import {
  AI_IMAGE_TYPES,
  AI_PERMISSION_MODES,
  AI_SKILL_COMMAND,
  aiImageAccepted,
  aiThinkingLabel,
  type AiImage
} from '@workbench/ai'
import type { AiSkillRow } from '@workbench/ai'
import { notifyWarning } from '@/notify'
import { useAiStore } from '@/stores/ai'
import { useAiSkillsStore } from '@/stores/ai-skills'

const props = defineProps<{
  /** 输入框里那句话：父级（AiView）持有 —— 换屏不丢（KeepAlive 兜着），重启不保留 */
  instruction: string
  /** 贴上还没发出去的图：与 instruction 同一条口径，归父级持有 */
  images: AiImage[]
}>()

const emit = defineEmits<{
  configure: []
  'update:instruction': [value: string]
  'add-images': [images: AiImage[]]
  'remove-image': [at: number]
  send: [text: string, images: AiImage[]]
}>()

const ai = useAiStore()
const skillsStore = useAiSkillsStore()

/**
 * 模型下拉里那几项：**把服务名顶在前面**（`服务名 · 模型显示名`）——
 * 下拉收起时那一格也只显示这一串，光有「Kimi K2」看不出它挂在哪个服务上
 * （几个服务可能都有同名模型）。挑的是 shared/ai.ts 的 AiModelChoice.key。
 */
const modelOptions = computed(() =>
  ai.choices.map((choice) => ({
    key: choice.key,
    label: `${choice.providerLabel} · ${choice.name}`,
    id: choice.model
  }))
)

/** 下拉挑了什么就记进设置（el-select 的 change 给的是宽联合，这里只可能是字符串） */
function chooseModel(value: unknown): void {
  void ai.setChoice(String(value))
}

function chooseThinking(value: unknown): void {
  void ai.setThinking(String(value))
}

function choosePermission(value: unknown): void {
  void ai.setPermission(String(value))
}

/** 那一颗按钮：没在跑就是「发送」，跑着就是「停止」。发送报给页面（send），由页面转给 store */
function sendOrStop(): void {
  if (ai.running) void ai.stop()
  else emit('send', props.instruction.trim(), [...props.images])
}

/**
 * 这条能不能发：环境那几样（Pi / Node / 模型 / 密钥）与「有没有落处」问 store，
 * 「写没写字、贴没贴图」问自己 —— 那两样归父级持有（见 props），所以这道判断也长在这里。
 */
const canRun = computed(
  () =>
    // 有会话就说在那个会话里；还没有会话（起始那一屏）时，挑好的那个目录就是它的落处
    (!!ai.activeSession || !!ai.newDir) &&
    !ai.running &&
    // 正在建那一个会话的当口不能再发（见 stores/ai.ts 的 creating）
    !ai.creating &&
    // 正在读回历史的那一会儿不让发：这一段的对话还没落地，发出去会把读回来的那段挤掉
    !ai.hydrating &&
    ai.piReady &&
    ai.nodeOk &&
    ai.configured &&
    ai.keyReady &&
    // 贴了图就得是能看图的模型：不然 Pi 会把图换成一句「图被略去」的占位发出去
    (props.images.length === 0 || ai.imageReady) &&
    // 一句话要么有字要么有图 —— 只有图的那句照样发得出去
    (!!props.instruction.trim() || props.images.length > 0)
)

/**
 * 还差什么才能跑。一次只说第一件缺的事 —— 按用户要动手的顺序排：
 * 工作目录 → Node → Pi → 模型 → 密钥 → 指令 → 贴的图。空串表示都齐了。
 *
 * **它只出现在发送按钮的悬停里**：页面不摆提示行（这个工具是作者自己用的，页面上把控件
 * 已经说清的事再讲一遍就是噪音），那颗按钮按不动时才是它该说话的时候。
 */
const blocking = computed(() => {
  if (!ai.probed) return ''
  if (!ai.activeSession && !ai.newDir)
    return '先挑一个工作目录：位置那一栏那个下拉 —— 对话就在它里面干活，一个目录就是一个「项目」。'
  if (ai.hydrating) return '正在接上这段对话…等它读完就能接着说。'
  if (!ai.nodeOk) return '这台机器的 Node 太旧：跑 Pi 需要 Node ≥ 22.19，先把 Node 升上去。'
  if (!ai.piVersion)
    return '没找到 Pi 运行时：随包内置的那份不在（开发态先跑一次 npm run vendor:pi），PATH 上也没有全局安装的 —— 点页面上那颗「安装 Pi」全局装一个。'
  if (!ai.configured)
    return '还没配模型：点「模型」下拉里的「模型管理」，添加一个 AI 服务（预设厂商或自定义端点）并选上模型。'
  if (!ai.keyReady) return `${ai.providerLabel} 还没配 API Key：点「模型」下拉里的「模型管理」。`
  if (!props.instruction.trim() && props.images.length === 0)
    return '还没写指令：接着这段对话说点什么。'
  if (props.images.length > 0 && !ai.imageReady)
    return `贴了 ${props.images.length} 张图，但「${ai.activeChoice?.name ?? '这个模型'}」看不了图：把图删掉，或者在「模型管理」里给它勾上「图片」、换一个能看图的模型。`
  return ''
})

// ---------- 技能（输入框里那条 `/skill:名字`） ----------

/**
 * **正在写的技能命令**：输入框里只剩一条 `/skill:名字`（或刚敲下的那一个 `/`）时，
 * 它就是「名字那一段」（空串 = 还没开始打字）；已经在命令后面写正文了（出现了空格）、
 * 或者根本不是命令，就是 null（这时不出候选那一列）。
 *
 * 候选**长在输入框上方**（一条内嵌的面板），不用浮层：它跟着输入框一起排，光标在哪儿、
 * 面板就在哪儿，没有定位那一套。（浮层那套见 AiLocationBar 的下拉 —— 那里是点出来的。）
 */
const skillQuery = computed<string | null>(() => {
  const text = props.instruction.trimStart()
  if (text === '/') return ''
  if (!text.startsWith(AI_SKILL_COMMAND)) return null
  const rest = text.slice(AI_SKILL_COMMAND.length)
  return /^\S*$/.test(rest) ? rest : null
})

/** 候选：装好且**开着**的技能（关掉的不该出现在这儿），按名字 / 描述筛一下，最多 8 条 */
const skillCandidates = computed(() => {
  const query = skillQuery.value
  if (query === null) return []
  const text = query.trim().toLowerCase()
  return skillsStore.pickable
    .filter((row) =>
      text ? `${row.name} ${row.id} ${row.description}`.toLowerCase().includes(text) : true
    )
    .slice(0, 8)
})

/** 候选那一列这会儿该不该在 */
const skillPickerOpen = computed(() => skillQuery.value !== null && skillCandidates.value.length > 0)

/** 高亮第几条（上下键走、Enter 用它）：换了个字就回到第一条 */
const skillIndex = ref(0)
watch(skillQuery, () => {
  skillIndex.value = 0
})

const inputRef = ref<{ focus: () => void } | null>(null)

/** 选一个：命令插到**最前面**（Pi 只在开头认它），后面留一个空格，接着写要它干什么 */
function insertSkill(row: AiSkillRow): void {
  emit('update:instruction', `${AI_SKILL_COMMAND}${row.name || row.id} `)
  skillIndex.value = 0
  inputRef.value?.focus()
}

/** 上下键在候选里走（首尾相接） */
function moveSkill(step: number): void {
  if (!skillPickerOpen.value) return
  const count = skillCandidates.value.length
  skillIndex.value = (skillIndex.value + step + count) % count
}

/**
 * Enter 发送、Shift + Enter 换行；中文输入法选字时敲的 Enter 不算（isComposing）。
 * 发不了的时候不拦它 —— 那时 Enter 就是普通的换行，别把输入框锁住。
 * **候选那一列开着时 Enter 是「选这一条」**（敲命令的当口，用户要的是挑技能而不是发出去）。
 */
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (skillPickerOpen.value) {
    event.preventDefault()
    insertSkill(skillCandidates.value[skillIndex.value] ?? skillCandidates.value[0])
    return
  }
  if (ai.running || !canRun.value) return
  event.preventDefault()
  emit('send', props.instruction.trim(), [...props.images])
}

/** 一个 File 读成数据 URL（读不出来、或看不出类型的回 null） */
function readImage(file: File): Promise<AiImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      // 类型从数据 URL 的头部取（浏览器自己按文件内容写的那个），取不到再退给剪贴板报的
      const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1]?.trim() || file.type
      resolve(dataUrl && mimeType ? { dataUrl, mimeType } : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/**
 * 往输入框里贴图（截图、复制的图片文件都走这儿）：**剪贴板里有图就只收图** ——
 * 从网页上复制时它常常同时带着一段文字，用户要的是那张图。
 *
 * 文件要**当场**取出来（`getAsFile` 只在这一次粘贴里有效），读成数据 URL 是异步的。
 * 一件都没有（普通文字粘贴）就不拦，交给输入框自己粘。
 */
async function onPaste(event: ClipboardEvent): Promise<void> {
  const items = [...(event.clipboardData?.items ?? [])].filter(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  )
  if (!items.length) return
  event.preventDefault()

  const files = items
    .filter((item) => aiImageAccepted(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file)
  if (!files.length) {
    // 收哪几种由 shared/ai.ts 那张表说了算（它对的是 Pi 能直接内联给模型的那几种）
    const types = AI_IMAGE_TYPES.map((type) => type.replace('image/', '')).join(' / ')
    return notifyWarning(`这种图发不出去：只认 ${types}`)
  }

  const read = (await Promise.all(files.map(readImage))).filter((image): image is AiImage => !!image)
  if (!read.length) return notifyWarning('这张图读不出来，换一张试试')
  emit('add-images', read)
}

/** 贴上的那几张的数据 URL（点开看大图时左右切换用的就是这一串，顺序与缩略图一致） */
const shotSrcs = computed(() => props.images.map((image) => image.dataUrl))

/**
 * 输入框里那句话：还没有会话时不能是「接着这段对话」—— 那会儿对话还没开始，
 * 这一句就是它的第一句（会话在发出时按位置那一栏挑好的目录现建）。
 */
const placeholder = computed(() =>
  ai.activeSession
    ? '接着这段对话说点什么 —— 它会自己读目录里的说明、改文件，也可能执行命令。'
    : '说点什么 —— 它会在这个目录里干活：读目录里的说明、改文件，也可能执行命令。'
)

/** 发送按钮的提示：跑着时它是停止，其余时候把还差什么说清楚 */
const sendTitle = computed(() => {
  if (ai.running) return '停掉这一轮（先让它自己停，卡住了才按进程树杀）'
  if (!canRun.value) return blocking.value || '还跑不起来'
  return '发送：接着这段对话说下去（Enter）'
})
</script>

<template>
  <section class="composer">
    <!-- 贴进来的图：排在输入框上面，一行缩略图（角上那颗 × 删掉一张；发出去时跟着那句走）。
         **点一下看大图**（EP 的查看器：多张之间左右切、滚轮缩放、Esc 或点外面关掉）——
         缩略图只有 56px，一张截图缩到这儿是看不清的 -->
    <div v-if="images.length" class="composer__shots">
      <div v-for="(image, index) in images" :key="index" class="shot">
        <el-image
          class="shot__img"
          :src="image.dataUrl"
          :preview-src-list="shotSrcs"
          :initial-index="index"
          fit="cover"
          preview-teleported
          hide-on-click-modal
          :show-progress="shotSrcs.length > 1"
        />
        <button
          class="shot__x"
          type="button"
          aria-label="移除这张图"
          @click="emit('remove-image', index)"
        >
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>

    <!--
      技能候选：输入框里正在写 `/skill:名字` 时排在它上方（一条内嵌的面板，不是浮层）。
      上下键走、Enter 选、点一下也选；选中之后命令留在最前面，光标接在空格后面写正文。
      「全局 / 项目」那枚小字说的是这个技能从哪条根来的（见 shared/pi-skills.ts）。
    -->
    <div v-if="skillPickerOpen" class="skills" role="listbox" aria-label="选择技能">
      <button
        v-for="(row, index) in skillCandidates"
        :key="row.key"
        class="skills__item"
        :class="{ 'is-active': index === skillIndex }"
        type="button"
        role="option"
        :aria-selected="index === skillIndex"
        @mousedown.prevent="insertSkill(row)"
      >
        <span class="skills__name">{{ row.name || row.id }}</span>
        <span class="skills__tag">{{ row.level === 'global' ? '全局' : '项目' }}</span>
        <span class="skills__desc" :title="row.description">{{ row.description }}</span>
      </button>
    </div>

    <el-input
      ref="inputRef"
      :model-value="instruction"
      class="composer__input"
      type="textarea"
      resize="none"
      :autosize="{ minRows: 2, maxRows: 8 }"
      :placeholder="placeholder"
      @paste="onPaste"
      @keydown.enter.exact="onEnter"
      @keydown.down.prevent="moveSkill(1)"
      @keydown.up.prevent="moveSkill(-1)"
      @update:model-value="(value: string) => emit('update:instruction', value)"
    />

    <div class="composer__row">
      <!--
        工具权限：**左边这一栏**。两档的差别只有一个 —— 执行命令问不问（读写文件都不问）；
        它交给 Rust 决定加不加载那份确认扩展（见 shared/ai.ts 的 AI_PERMISSION_MODES）。
        下拉里每一条底下那行小字说的就是这个（样式在 global.css）。
        图标跟着这一档走：要问 = 锁着，不问 = 开着 —— 两档的差别一眼看得出来。
      -->
      <el-select
        class="composer__permission"
        popper-class="composer-permission-pop"
        :fit-input-width="false"
        :model-value="ai.permission"
        @change="choosePermission"
      >
        <template #prefix>
          <el-icon><Unlock v-if="ai.permission === 'full'" /><Lock v-else /></el-icon>
        </template>
        <el-option
          v-for="mode in AI_PERMISSION_MODES"
          :key="mode.id"
          :label="mode.label"
          :value="mode.id"
        >
          <span class="composer-permission-label">{{ mode.label }}</span>
          <span class="composer-permission-hint">{{ mode.hint }}</span>
        </el-option>
      </el-select>

      <div class="composer__tools">
        <!--
          三个控件都不带 size：一行里得同高。EP 的默认尺寸是 32px（按钮与下拉各有一份
          「小」尺寸实现，下拉那边是写死的 24px，调不成同一个高度），所以统一走默认。
        -->
        <el-select
          class="composer__model"
          :model-value="ai.activeChoiceKey"
          placeholder="还没配模型"
          @change="chooseModel"
        >
          <template #prefix>
            <el-icon><Cpu /></el-icon>
          </template>
          <el-option
            v-for="option in modelOptions"
            :key="option.key"
            :label="option.label"
            :value="option.key"
          />
          <template #empty>
            <p class="composer__empty">还没有能挑的模型：先在模型管理里加一个服务</p>
          </template>
          <template #footer>
            <el-button link size="small" :icon="Setting" @click="emit('configure')">
              模型管理…
            </el-button>
          </template>
        </el-select>

        <el-select
          class="composer__thinking"
          :model-value="ai.thinking"
          @change="chooseThinking"
        >
          <template #prefix>
            <el-icon><Odometer /></el-icon>
          </template>
          <!-- 只列**这个模型支持的档位**（Pi 也照 models.json 里那份收敛）：
               不支持思考的模型只剩「关闭」一档 -->
          <el-option
            v-for="level in ai.thinkingLevels"
            :key="level"
            :label="aiThinkingLabel(level)"
            :value="level"
          />
        </el-select>

        <el-tooltip :content="sendTitle" placement="top">
          <el-button
            class="composer__send"
            :type="ai.running ? 'danger' : 'primary'"
            :icon="ai.running ? VideoPause : Top"
            :disabled="!ai.running && !canRun"
            @click="sendOrStop"
          />
        </el-tooltip>
      </div>
    </div>
  </section>
</template>

<style scoped>
/**
 * composer 自己就是一张卡片：底色与边框照 .panel 那一套（卡片的写法见 global.css）——
 * 它比内容面板矮一档，所以圆角与内边距自己定。
 */
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  box-shadow: var(--shadow-card);
}

/* 输入框长在卡片里：边框与底色都归卡片，它自己只剩文字（悬停 / 聚焦也不画框） */
.composer__input :deep(.el-textarea__inner) {
  padding: 0;
  font-family: inherit;
  line-height: 1.7;
  background: transparent;
  box-shadow: none;
}

/**
 * 贴进来的图：一行缩略图（用户自己贴的那几张，见 onPaste）。空着时整块不画 ——
 * 卡片的高度只跟内容走，没贴图时与从前一样。
 */
.composer__shots {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.shot {
  position: relative;
}

/* 缩略图：方的一小块，图裁满（截图缩下去仍认得出是哪一张）。点一下看大图（见 template 里
   那几个属性；EP 自己会给预览态加手型光标），所以这一块要 `display: block` ——
   el-image 默认是行内块，留出 baseline 那点缝会让这一行高一个像素 */
.shot__img {
  display: block;
  width: 56px;
  height: 56px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

/**
 * 角上那颗 ×：压在缩略图的右上角（一半在图上、一半在外面）。**底色不取令牌** ——
 * 它画在图上而不是画在底色上，深色圆底配白叉两档主题都读得清（取 --ink-* 会在暗图上看不见）。
 */
.shot__x {
  position: absolute;
  top: -6px;
  right: -6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}

.shot__x:hover {
  background: rgba(0, 0, 0, 0.85);
}

.composer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

/**
 * 三个下拉都画成**没有边框的浅底 chip**（与位置栏那颗 `.pick__item` 同一副样子）：
 * EP 的默认外观是「一个描了边的输入框」，一排三个摆在一起就成了表单 —— 这一行要的是
 * 一排工具。**只改外观，不动它自己的行为**（悬停 / 聚焦、下拉面板都照旧）：
 * 边框是 `box-shadow: 0 0 0 1px … inset` 画的、底色是 `background-color`，把这两条按住即可。
 * 悬停 / 聚焦时 EP 会各加一道 `--el-color-primary` 的描边（黑框），一并换成「底色深一档」。
 */
.composer__row :deep(.el-select__wrapper) {
  padding: 0 var(--sp-2);
  background: var(--bg-inset);
  box-shadow: none;
}

.composer__row :deep(.el-select__wrapper.is-hovering:not(.is-focused)),
.composer__row :deep(.el-select__wrapper.is-focused),
.composer__row :deep(.el-select__wrapper.is-focus) {
  background: var(--bg-selected);
  box-shadow: none;
}

/* 图标那一格（每颗 chip 都有的那个图标）：比选中的值浅一档，压在值的左缘 */
.composer__row :deep(.el-select__prefix) {
  color: var(--ink-3);
}

/* 权限那一栏在左边这一格：宽度放得下「完全访问」四个字 + 那颗图标（下拉本身比它宽，
   选项里那两行小字的样式在 global.css —— 下拉挂在 body 上，作用域样式够不着） */
.composer__permission {
  width: 124px;
}

.composer__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: auto;
}

/**
 * 技能候选那一列：排在输入框上方的一条内嵌面板（不是浮层，见 template 里的说明）。
 * 每行是「名字 + 全局/项目 + 描述」，描述压一行截断。
 */
.skills {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
}

.skills__item {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  padding: 4px var(--sp-2);
  border: none;
  border-radius: var(--r-sm);
  background: none;
  text-align: left;
  cursor: pointer;
}

/* 高亮跟着上下键走；鼠标划过也高亮（键盘与鼠标共用一个高亮位，不各画一份） */
.skills__item.is-active,
.skills__item:hover {
  background: var(--bg-selected);
}

.skills__name {
  flex: none;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
}

.skills__tag {
  flex: none;
  padding: 0 6px;
  border-radius: var(--r-sm);
  background: var(--bg-surface);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.skills__desc {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 模型那一栏要能放下「提供方/模型 id」，思考那一栏只要放得下「极高」两个字。
   字号随默认尺寸涨到 14px 了，宽度跟着放宽一点，不然模型名比原来还早被截断 */
.composer__model {
  width: 280px;
  max-width: 100%;
}

.composer__thinking {
  width: 92px;
}

/* 下拉底部的「模型管理…」：挨着最后一条模型，点开就是那个弹层 */
.composer__tools :deep(.el-select-dropdown__footer) {
  padding: var(--sp-1) var(--sp-2);
  border-top: 1px solid var(--border);
}

.composer__empty {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 发送那颗：**圆的实心箭头**（primary 就是那个近黑，两档主题各自有值）——
   与旁边几颗 chip 同高（32px），只是形状不同，一眼认得出「这一行里就它是动作」 */
.composer__send {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
}
</style>
