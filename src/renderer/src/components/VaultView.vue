<script setup lang="ts">
/**
 * 密码页：一张卡片墙。
 *
 * **它是备忘，不是密码管理器**：一条记录就是「名字 + 密码 + 备注 + 分组」四样，
 * 卡片上摆出来的就是这些 —— 没有用户名 / 网址那些字段，也不生成口令
 * （见 shared/vault.ts 的 VaultEntry）。卡片是**用**的地方：看一眼、复制一下；
 * 改是偶尔才做一次的事，收在悬停才显形的那两颗按钮里，添加与编辑都走弹框。
 *
 * 三种样子，按密钥状态走：
 *   - **还没有密钥**：整页只说一件事 —— 先建一把，或者从另一台机器导入；
 *   - **收起来了**：一颗解锁按钮（这一步不需要口令，界面上直说）；
 *   - **开着**：筛选工具带 + 卡片墙。
 *
 * **密码默认是遮住的**，按卡片上那颗眼睛才现形；遮罩是**固定长度**的，不按真实长度铺点 ——
 * 长度也是信息，没必要替用户说出去。复制与查看是两颗独立按钮（用户要的就是这两个动作）。
 *
 * 明文只活在内存里：磁盘上那份与仓库里那份都只有密文（见 workbench/vault.ts）。
 */
import { computed, onMounted, ref } from 'vue'
import {
  CopyDocument,
  Document,
  Hide,
  Key,
  Lock,
  MoreFilled,
  Plus,
  Refresh,
  Search,
  Unlock,
  View
} from '@element-plus/icons-vue'
import type { VaultEntry, VaultRecord } from '@shared/vault'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useVaultStore } from '@/stores/vault'
import VaultEntryDialog from '@/components/VaultEntryDialog.vue'
import VaultKeyDialog from '@/components/VaultKeyDialog.vue'

const store = useVaultStore()

/** 遮罩固定八颗点：不按真实长度铺，长度本身也是信息 */
const MASK = '••••••••'

/** 哪几张卡片正把密码亮着。按 id 记，换一档筛选也留着（比较两条记录时用得上） */
const revealed = ref<string[]>([])

const keyDialog = ref(false)
const entryDialog = ref(false)
const entryDialogRef = ref<InstanceType<typeof VaultEntryDialog>>()
/** 弹框正在编辑哪一条：null = 添加 */
const editing = ref<VaultRecord | null>(null)
/**
 * 哪张卡片的「⋯」菜单正开着。
 *
 * 那颗按钮平时不显形（悬停才出来），而菜单是 Teleport 到 body 上的 —— 指针一进菜单，
 * 卡片就不算被悬停了，按钮会在菜单还开着的时候淡掉。所以开着的这张要单独记住。
 */
const openMenu = ref('')
/** 添加时先把 id 定下来（见下面的 startAdd） */
const draftId = ref('')

const fingerprintText = computed(() => store.fingerprint || '—')

/** 弹框里分组那一栏的候选项：已经有的那些分组名（选一下省得打字，也能直接敲一个新的） */
const groupOptions = computed(() => store.groups)

onMounted(() => {
  void store.init()
})

function isRevealed(id: string): boolean {
  return revealed.value.includes(id)
}

function toggleReveal(id: string): void {
  revealed.value = isRevealed(id)
    ? revealed.value.filter((item) => item !== id)
    : [...revealed.value, id]
}

/** 复制。WebView 里 `navigator.clipboard` 在安全上下文下可用，失败时如实说一句 */
async function copy(text: string, what: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    notifySuccess(`${what}已复制`)
  } catch {
    notifyError('复制失败，可以手动选中再复制')
  }
}

/**
 * 添加：**id 在这儿就定下来**（一个现生成的 uuid）。
 *
 * 条目的身份必须在落盘之前就存在 —— 它是跨设备合并时唯一认得出「这是同一条」的东西
 * （见 shared/vault.ts 的 mergeVaultItems），保存时才现编一个的话，两台机器各存一份就成了两条。
 */
function startAdd(): void {
  draftId.value = crypto.randomUUID()
  editing.value = null
  entryDialog.value = true
}

function startEdit(record: VaultRecord): void {
  draftId.value = record.id
  editing.value = record
  entryDialog.value = true
}

/**
 * 弹框交了内容过来：落盘成功才关弹框（失败时留着，填过的字不动）。
 *
 * 失败那一支**必须告诉弹框一声**：它按下提交时把自己那颗按钮置成了 loading，
 * 不回调就永远转下去、再也点不动 —— 填过的内容还在，但用户没法重试。
 */
async function save(entry: VaultEntry): Promise<void> {
  const saved = await store.saveEntry(draftId.value, entry)
  if (!saved) {
    entryDialogRef.value?.done()
    return
  }
  entryDialog.value = false
  editing.value = null
}

function onMore(command: string, record: VaultRecord): void {
  if (command === 'edit') startEdit(record)
  else void remove(record)
}

async function remove(record: VaultRecord): Promise<void> {
  const ok = await confirmAction(
    `「${record.name}」会从这台机器和仓库里一起删掉。`,
    '删除这条记录？',
    { confirmButtonText: '删除', type: 'warning' }
  )
  if (!ok) return

  await store.removeEntry(record.id)
  revealed.value = revealed.value.filter((id) => id !== record.id)
}

async function sync(): Promise<void> {
  await store.sync()
}

async function lock(): Promise<void> {
  await store.lock()
}
</script>

<template>
  <main class="vault">
    <!-- 还没有密钥：这一页的入口只有两条 —— 建一把，或从另一台机器导入 -->
    <div v-if="!store.keyExists" class="vault__intro panel">
      <div class="empty">
        <el-icon class="empty__icon"><Key /></el-icon>
        <p>保险库要用一把密钥才能建起来。</p>
        <p class="empty__hint">
          密钥只存在这台机器上（Windows 凭据管理器里）；仓库里那份文件从头到尾都是密文 ——
          有公钥就能往里写，没有私钥谁也读不出来。
        </p>
        <p class="empty__hint">
          另一台机器要用同一个保险库，把密钥导出成文件带过去导入一次即可。
        </p>
        <div class="vault__intro-actions">
          <el-button type="primary" @click="store.createKey(false)">
            <el-icon><Plus /></el-icon>
            创建保险库
          </el-button>
          <el-button @click="store.importKeyFile()">
            <el-icon><Document /></el-icon>
            导入密钥文件
          </el-button>
        </div>
      </div>
    </div>

    <!-- 收起来了：讲清楚这一步挡得住什么、挡不住什么 -->
    <div v-else-if="!store.unlocked" class="vault__intro panel">
      <div class="empty">
        <el-icon class="empty__icon"><Lock /></el-icon>
        <p>密码已经从屏幕上和内存里收起来了。</p>
        <p class="empty__hint">
          解锁<strong>不需要口令</strong>：密钥就在这台机器上（Windows 凭据管理器里），
          能打开这个程序就说明已经过了 Windows 登录。
        </p>
        <p class="empty__hint">
          所以它挡不住别人。它做的事只有一件 —— 离开座位时，别把密码摊在屏幕上。
        </p>
        <p class="empty__hint">
          公钥指纹 <span class="mono">{{ fingerprintText }}</span>，
          另一台机器上显示的应当是同一串。
        </p>
        <el-button type="primary" :loading="store.loading" @click="store.unlock()">
          <el-icon><Unlock /></el-icon>
          解锁
        </el-button>
      </div>
    </div>

    <template v-else>
      <div class="filter">
        <!--
          工具带上只留搜索：**分组不在这一行做筛选**。上一版有一排分组标签，与卡片墙上的段头
          把那几个数摆了两遍（同一屏里「测试 1」出现两次），整条带子也被它撑得没有重心。
          找某一条用搜索，看某一组用分段 —— 两条路都够了。
        -->
        <div class="filter__head">
          <el-input
            v-model="store.query"
            class="vault__search"
            size="small"
            clearable
            spellcheck="false"
            placeholder="搜索名字、备注、分组"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <span v-if="store.records.length" class="vault__count">{{ store.summary }}</span>
        </div>

        <div class="filter__tools">
          <span v-if="store.syncNote" class="vault__note" :class="{ 'is-fail': store.syncFailed }">
            {{ store.syncNote }}
          </span>
          <el-tooltip content="同步（推本机改动、拉回别的机器的）" placement="bottom">
            <el-button size="small" :loading="store.syncing" @click="sync">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="密钥与同步" placement="bottom">
            <el-button size="small" @click="keyDialog = true">
              <el-icon><Key /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="收起密码（清掉屏幕与内存里的明文；解锁不需要口令）" placement="bottom">
            <el-button size="small" @click="lock">
              <el-icon><Lock /></el-icon>
            </el-button>
          </el-tooltip>
          <el-button type="primary" size="small" @click="startAdd">
            <el-icon><Plus /></el-icon>
            添加
          </el-button>
        </div>
      </div>

      <div class="vault__body">
        <!--
          这几条都必须如实说出来：解不开的记录不会出现在卡片墙上，
          不说的话用户只会以为密码丢了，或者以为同步没生效。
        -->
        <p v-if="store.unreadable" class="vault__warn">
          有 {{ store.unreadable }} 条解不开 —— 它们是用别的密钥加的密。
        </p>
        <p v-if="store.dropped" class="vault__warn">
          有 {{ store.dropped }} 条读不出来（内容坏了，或来自更新的版本）。
        </p>
        <p v-if="store.keyMismatch" class="vault__warn">
          仓库里那份是用别的密钥加的密，那些记录在这台机器上解不开。核对一下两边的公钥指纹。
        </p>

        <!--
          按分组分段：每段一个标题 + 一段卡片。分组名不写在卡片上 ——
          标题已经说了，一张卡再重复一遍只是占地方（那是这一版之前的样子）。
          `v-if` 挂在外层 template 上：下面那个空态是它的 `v-else`，
          直接把 v-if 写在 v-for 那一行上会让 v-else 找不到配对（v-for 与 v-if 同处一个元素时
          v-if 的优先级更高，语义也完全不同）。
        -->
        <template v-if="store.visibleRecords.length">
          <section v-for="section in store.sections" :key="section.key" class="group">
            <header class="group__head">
              <span class="group__title">{{ section.label }}</span>
              <span class="group__count mono">{{ section.records.length }}</span>
            </header>

            <div class="grid">
              <article v-for="record in section.records" :key="record.id" class="card">
                <header class="card__head">
                  <h3 class="card__name" :title="record.name">{{ record.name }}</h3>

                  <!-- 改与删收在「⋯」里：悬停 / 键盘聚焦才显形（这是偶尔才做一次的事） -->
                  <el-dropdown
                    class="card__more"
                    :class="{ 'is-open': openMenu === record.id }"
                    trigger="click"
                    placement="bottom-end"
                    @command="(command: string) => onMore(command, record)"
                    @visible-change="(open: boolean) => (openMenu = open ? record.id : '')"
                  >
                    <el-button text size="small" :icon="MoreFilled" aria-label="更多" />
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="edit">编辑</el-dropdown-item>
                        <el-dropdown-item command="remove" divided>删除</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </header>

                <!--
                  两行「标签 + 值」：`密码` / `备注` 两个灰字标签把内容锚住，值那一列左边对齐。
                  没有标签的话，卡片上就是几段各自飘着的字（那是上一版的样子）。
                -->
                <dl class="rows">
                  <div class="row">
                    <dt class="row__label">密码</dt>
                    <dd class="row__secret">
                      <span class="row__value">{{
                        isRevealed(record.id) ? record.password || '—' : MASK
                      }}</span>

                      <!--
                        每颗按钮外面套一层 span：**禁用的 el-button 不吃鼠标事件**，
                        tooltip 于是弹不出来 —— 而「这颗按钮为什么点不动」正是那时候唯一要知道的事
                        （这条记录没记密码）。事件落在 span 上，提示才到得了。
                      -->
                      <span class="row__ops">
                        <el-tooltip :content="record.password ? '复制密码' : '这条没记密码'" placement="top">
                          <span class="row__op">
                            <el-button
                              text
                              size="small"
                              :icon="CopyDocument"
                              :disabled="!record.password"
                              aria-label="复制密码"
                              @click="copy(record.password, '密码')"
                            />
                          </span>
                        </el-tooltip>
                        <el-tooltip
                          :content="isRevealed(record.id) ? '藏起来' : '查看密码'"
                          placement="top"
                        >
                          <span class="row__op">
                            <el-button
                              text
                              size="small"
                              :icon="isRevealed(record.id) ? Hide : View"
                              :disabled="!record.password"
                              :aria-label="isRevealed(record.id) ? '藏起来' : '查看密码'"
                              @click="toggleReveal(record.id)"
                            />
                          </span>
                        </el-tooltip>
                      </span>
                    </dd>
                  </div>

                  <!-- 备注最多两行：这是「备忘」，那句话往往就是这条记录最要紧的部分 -->
                  <div v-if="record.notes" class="row">
                    <dt class="row__label">备注</dt>
                    <dd class="row__notes" :title="record.notes">{{ record.notes }}</dd>
                  </div>
                </dl>
              </article>
            </div>
          </section>
        </template>

        <!-- 一条都没有 vs 筛没了：两回事，空态说清楚是哪一种 -->
        <div v-else class="nomatch">
          <template v-if="store.records.length">
            <p class="nomatch__title">没有匹配「{{ store.query }}」的记录</p>
          </template>
          <template v-else>
            <p class="nomatch__title">还没有一条记录</p>
            <p class="nomatch__desc">点右上角「添加」记第一条。</p>
            <el-button type="primary" @click="startAdd">
              <el-icon><Plus /></el-icon>
              添加
            </el-button>
          </template>
        </div>
      </div>
    </template>

    <VaultKeyDialog v-model:visible="keyDialog" @changed="store.refreshKey()" />
    <VaultEntryDialog
      ref="entryDialogRef"
      v-model:visible="entryDialog"
      :record="editing"
      :groups="groupOptions"
      @save="save"
    />
  </main>
</template>

<style scoped>
.vault {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* ---------- 两种引导态 ---------- */

.vault__intro {
  flex: 1 1 auto;
  justify-content: center;
  /*
   * **上边距必须是 0**：导航栏那张卡片与每一页的第一个元素（工具带）都是紧贴顶栏下沿的
   * （量过：`.nav` 与 `.filter` 的 top 都是 0），这里再补一圈 10px 就会比导航栏低一截 ——
   * 「顶部没对齐」就是这 10px。左右与下边距仍然取 --card-gap：那两处要和卡片墙、工具带对齐。
   */
  margin: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/**
 * 引导屏的文字收在一个可读的宽度里，并**左对齐**。
 *
 * 这些段落原来没有任何宽度约束，于是各自铺成一行一千来像素的居中长句 ——
 * 左缘右缘都参差，既读不了，整屏也看着散。`.empty` 那套（居中 + 无宽度上限）
 * 是给「一句话 + 一颗按钮」准备的，句子一长就不成立。
 *
 * 宽度写在**段落自己**身上（`width` 而不是 `max-width`）：`.empty` 是 `align-items: center`，
 * 每段都会收缩到刚好包住文字 —— 只给上限的话，短句仍然比长句窄，左缘照样不齐。
 * 统一成一个宽度，几段的左缘才是同一条竖线（`max-width: 100%` 兜着窄窗口）。
 * 图标与按钮仍然居中（空状态的惯例），只把文字那一段的左缘拉直。
 */
.vault__intro .empty > p {
  width: 32em;
  max-width: 100%;
  font-size: var(--fs-meta);
  line-height: 1.7;
  text-align: left;
}

/*
 * 按钮那一排与上面那段文字**等宽并左对齐**：宽度取同一个 32em，两段的左缘才是同一条竖线。
 * 各自居中时图标、文字、按钮三条左缘各不相同 —— 一排按钮缩在中间看着像另一块东西。
 * （量过：文字块 577→961、按钮排 648.5→889.5，改完两者左缘都是 577。）
 */
.vault__intro-actions {
  display: flex;
  width: 32em;
  max-width: 100%;
  gap: var(--sp-2);
}

/* ---------- 工具带 ---------- */

/**
 * **整页一条左基准线**：工具带、段头、卡片墙都从 `--card-gap` 起。
 *
 * `.filter` 这个外壳（global.css）本身是 `padding: 0 var(--sp-5)`，也就是 20px，
 * 而卡片墙的四周留白是 `--card-gap`（默认 10px，用户可调）—— 差这 10px 在项目页看不出来
 * （那边的筛选标签是无边框的药丸，没有可见的左缘），但这一页工具带左边是一个**有硬边的输入框**，
 * 差 10px 就明摆着没对齐。
 * 所以这一页把外壳的内边距压成与卡片墙同源 —— 页面之内的对齐比跨页面统一更要紧。
 * 带 `:deep()` 是因为这条要盖过全局那条同样选择器的规则（scoped 属性选择器特异性更高）。
 */
.filter {
  padding-left: var(--card-gap, 10px);
  padding-right: var(--card-gap, 10px);
}

/*
 * 搜索框对齐 .sort 那套控件规范（28px 高、--r-sm 圆角、--bg-surface 底 + --border 边）：
 * 工具带上的东西尺寸与圆角一致，这一行才像排过版的，而不是几个各长各的控件凑在一起。
 */
.vault__search {
  width: 240px;
  flex-shrink: 0;
}

.vault__search :deep(.el-input__wrapper) {
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--bg-surface);
  box-shadow: 0 0 0 1px var(--border) inset;
}

.vault__search :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px var(--border-strong) inset;
}

.vault__search :deep(.el-input__inner) {
  font-size: var(--fs-meta);
}

/* 条数跟着搜索框，用灰字小一号 —— 它是注解，不是这一行的主角 */
.vault__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 同步结果那句话：成功用灰字（它是常态），失败才用状态色 —— 彩色只表达运行状态 */
.vault__note {
  max-width: 320px;
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vault__note.is-fail {
  color: var(--st-fail);
}

/* ---------- 卡片墙 ---------- */

.vault__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  overflow-y: auto;
  /* 四周留白与卡片间距同源（--card-gap 由 .app 统一给），与项目页同一个口径 */
  padding: var(--card-gap, 10px);
}

.vault__warn {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--st-fail-soft);
  color: var(--st-fail);
  font-size: var(--fs-meta);
  line-height: 1.5;
}

/* ---------- 分组分段 ---------- */

/*
 * 段与段之间空得比段内大：一眼看得出这是两段，而不是一段里多了一行标题。
 * 24 : 12 的比例（上 : 下）是有意的 —— 相等的话段头看着「两头都沾」，
 * 归不到上面那段、也归不到下面那段。
 */
.group + .group {
  margin-top: var(--sp-6);
}

/*
 * 段头 = 分组名 + 条数。**不画那条拉到右缘的细线**。
 *
 * 加过一版：它把段头变成一处分隔，看着确实「有设计感」—— 但那是在**内容稀疏**的页面上
 * 露馅的：一组只有一张卡时，那条线仍然拉满一千三百像素，整页就成了几道横线夹着几张小卡，
 * 像一张没填完的表。这个应用里带标题的分组（工作页那天一天）本来就没有线，靠字号与留白分层。
 */
.group__head {
  display: flex;
  /*
   * **按基线对齐**，不是按盒子居中：段头是 15px 的名字配 10.5px 的条数，
   * 两个盒子居中的话小字会矮下去两三像素（同一行里字号不同时，居中和基线对齐不是一回事）。
   */
  align-items: baseline;
  gap: var(--sp-2);
  /* 左右不留内边距：段头的字与下面卡片的左缘要在同一条竖线上（那 2px 曾经把它顶偏过） */
  padding: 0 0 var(--sp-3);
}

.group__title {
  color: var(--ink);
  font-size: var(--fs-title);
  font-weight: 600;
  line-height: 1.4;
}

.group__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.4;
}

/*
 * 一行四张（1200px 上下正好四列）。下限取 240px 而不是项目卡那个 302px：
 * 一张卡只有名字、两行「标签 + 值」，302 会空出一大片 ——
 * 那个宽度是为项目卡的名字 + 路径 + 元信息 + 操作行定的。
 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--card-gap, 14px);
  align-content: start;
}

/* ---------- 卡片 ---------- */

/*
 * 与技能卡同一副外壳（悬停抬一档）。卡里**不套第二层框**：
 * 密码那一行曾经是「框里一个带边框的输入框」，盒子套盒子看着就笨重 ——
 * 现在它就是一行字加两颗图标。
 */
.card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  transition: box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-hover);
  transform: translateY(-1px);
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-1);
  /*
   * 名字那一行的高度由那颗「⋯」兜着（28px，见全局的 .el-button--small）。
   * 它虽然平时是透明的，但**一直占着位置** —— 于是悬停让它显形时整行不会跳一下。
   */
  min-height: 28px;
}

.card__name {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右上角那颗「⋯」：悬停 / 键盘聚焦时显形，菜单开着时也显形（见 openMenu 的说明） */
.card__more {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.card:hover .card__more,
.card:focus-within .card__more,
.card__more.is-open {
  opacity: 1;
}

/* ---------- 卡片里的「标签 + 值」两行 ---------- */

/*
 * **一行就是一条 22px 的带子**：标签、值、图标都落在它上面，各自的中线因此是同一条。
 *
 * 上一版这里有三样高度不同的东西 —— 标签是 20px 的行盒、值也是、而图标按钮是全局
 * `.el-button--small` 的 **28px** —— 三者各自居中，于是标签偏高、图标偏低，
 * 一行里三条中线，看着就是没对齐（而且越看越别扭）。
 * 所以图标按钮在这一页被压到 22px，文字的行高也写成同一个值：**改任何一个都要一起改**，
 * 这一行的高度只由这一个数说了算。
 */
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  min-width: 0;
}

/* 两个标签都是两个字，宽度天然一样；这里只保证它不被压窄（值那一列因此左边对齐） */
.row__label {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 22px;
}

.row__secret {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  /* 值紧挨着图标那一组：gap 给大了这两截就断成两块 */
  gap: 2px;
  margin: 0;
  min-width: 0;
  min-height: 22px;
}

.row__value {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  line-height: 22px;
  /* 亮着时**换行而不是截断**：查看密码就是为了读全，截断等于白看；
     遮着时是八颗点，本来也占不满一行 */
  overflow-wrap: anywhere;
  user-select: text;
}

.row__ops {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  /* 两颗图标压暗一档：它们常显，不该比卡片上的内容还抢眼 */
  color: var(--ink-3);
}

.row__ops :deep(.el-button + .el-button) {
  margin-left: 0;
}

/*
 * 图标按钮在这一页压到 22px（全局 `.el-button--small` 是 28px），横向内边距也从 10px 收到 4px：
 * 28px 的按钮比文字行高一截，是上面那条「三条中线」的来路；而 10px 的内边距把两颗图标
 * 的**字距**拉到 30px，看着像两个各管各的按钮，而不是「复制 / 查看」这一对。
 */
.row__ops :deep(.el-button) {
  height: 22px;
  padding: 0 4px;
  color: inherit;
}

.row__ops:hover {
  color: var(--ink);
}

/* 包住按钮的那一层：只为让禁用状态下 tooltip 也收得到事件（见模板里的说明） */
.row__op {
  display: inline-flex;
}

/* 备注最多两行：写长了截断，悬停看全文（与「今日完成」那张卡同一条口径） */
.row__notes {
  display: -webkit-box;
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  /* 与上面那条带子同高：备注的首行因此和「备注」两个字对齐 */
  line-height: 22px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* ---------- 空态 ---------- */

.nomatch {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  min-height: 156px;
  padding: var(--sp-6);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg);
  text-align: center;
}

.nomatch__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
  font-weight: 600;
}

.nomatch__desc {
  margin: 0 0 var(--sp-1);
  color: var(--ink-3);
  font-size: var(--fs-body);
}
</style>
