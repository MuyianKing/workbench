import type { AiSkillLevel, AiSkillRow } from '@workbench/ai'
import { aiSkillRows, enabledAiSkills, projectSkillsRoot } from '@workbench/ai'
import { ok } from '@workbench/core'
import { defineStore } from 'pinia'
/**
 * AI 助手页那颗「技能」按钮的状态：两条 `.agents/skills`（全局 / 项目）的扫描结果、
 * 每个技能的开关、装 / 卸 / 换目录的编排。
 *
 * 与技能页那个 store（[skills.ts](./skills.ts)）**不是一回事**：那个管「技能库 + 版本历史 +
 * 装到项目」，这个只管 AI 助手页那两条根 —— 一个技能 = 一个带 `SKILL.md` 的子目录，
 * 没有 git、没有版本。口径与判定都在 [shared/pi-skills.ts](../../../shared/pi-skills.ts)（有单测），
 * 这里只编排、只落状态。
 *
 * 三件事值得记在这儿：
 *
 *  - **开关住在设置里**（`aiSkillsOff`，键是「根 + 技能名」），形状是「被关掉的那些」；
 *    新装进来、别处放进来的技能默认就是开着的，不需要应用替它们登记一遍。
 *  - **装 / 卸 / 开关对活着的会话进程不生效**：`--skill` 只在起进程时给（见 ai.rs 的 run）；
 *    界面上不说这件事（constraints/ai.md「不摆提示行」那条），要新表生效就结束这段会话的
 *    进程再续聊。
 *  - **两条根都是用户自己的目录**（全局那份还与别的 agent 共用、项目那份多半在用户的仓库里）：
 *    这一层不替他在仓库里提交任何东西（Rust 侧也不碰 git），要提交他自己来。
 */
import { computed, ref, watch } from 'vue'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useAiStore } from '@/stores/ai'
import { useSettingsStore } from '@/stores/settings'
import { piSkillInstallDir, piSkillInstallUrl, piSkillInstallZip, piSkillList, piSkillRemove } from '@/workbench/pi-skill'

/** 装进来的东西从哪来：用户挑的 zip / 用户挑的文件夹 / 用户粘的地址 */
export type PiSkillSource
  = | { kind: 'zip', value: string }
    | { kind: 'dir', value: string }
    | { kind: 'url', value: string }

export const useAiSkillsStore = defineStore('aiSkills', () => {
  const ai = useAiStore()
  const settings = useSettingsStore()

  /** 全局那份技能根（探测运行时带回来的；拿不到用户目录时是空串） */
  const globalRoot = computed(() => ai.skillRoot)
  /** 项目那份：跟着页面当前盯着的那个目录走（挑中会话就是会话那个目录） */
  const projectRoot = computed(() => projectSkillsRoot(ai.watchedDir))

  const globalRows = ref<AiSkillRow[]>([])
  const projectRows = ref<AiSkillRow[]>([])
  const loading = ref(false)
  const loadError = ref('')
  /** 上一次扫的是哪两条根（键）：换了目录、换了机器就重扫 */
  const loadedFor = ref('')

  /** 两栏的行（全局在前） */
  const rows = computed(() => [...globalRows.value, ...projectRows.value])
  /** 全局那一栏能不能用（拿不到用户目录就是不能） */
  const globalReady = computed(() => globalRoot.value !== '')
  /** 项目那一栏能不能用（还没挑目录就是不能） */
  const projectReady = computed(() => projectRoot.value !== '')

  /**
   * 这一轮要交给 Pi 的技能（根 + 技能名）：**关掉的、被卸掉的不在里面**。
   * 起进程时由 stores/ai.ts 带进 `ai_run`（见 shared/types.ts 的 AiRunInput）。
   */
  const enabledRefs = computed(() => enabledAiSkills(rows.value))
  /** 开着的那些（输入框里打 `/` 时那排候选：关掉的技能不该出现在那儿） */
  const pickable = computed(() => rows.value.filter(row => row.enabled))
  /**
   * 只有全局那几条（开着的）。给**不在 AI 助手页上跑**的那些 Pi 会话用 ——
   * 知识库清洗在自己的目录里干活，那里的「项目技能」不该是 AI 助手页当前挑的那个目录的
   * （全局技能到哪儿都算数，项目技能只在那个项目里算数）。
   */
  const globalRefs = computed(() => enabledAiSkills(globalRows.value))

  function keyOf(): string {
    return `${globalRoot.value}\u0000${projectRoot.value}`
  }

  function rootOf(level: AiSkillLevel): string {
    return level === 'global' ? globalRoot.value : projectRoot.value
  }

  /**
   * 重扫两栏。**两栏各自成败**：全局那份读不出来（用户目录拿不到）不该把项目那份也拖掉，
   * 反过来也一样 —— 每栏的空与错都自己说自己的。
   */
  async function refresh(): Promise<void> {
    const globalKey = globalRoot.value
    const projectKey = projectRoot.value
    const off = settings.settings.aiSkillsOff

    loading.value = true
    loadError.value = ''
    try {
      const [globalRaw, projectRaw] = await Promise.all([
        globalKey ? piSkillList(globalKey) : Promise.resolve(ok<unknown>([])),
        projectKey ? piSkillList(projectKey) : Promise.resolve(ok<unknown>([])),
      ])

      if (globalRaw.ok) {
        globalRows.value = aiSkillRows('global', globalKey, globalRaw.data, off)
      }
      else {
        globalRows.value = []
        loadError.value = globalRaw.error ?? '读取全局技能失败'
      }

      if (projectRaw.ok) {
        projectRows.value = aiSkillRows('project', projectKey, projectRaw.data, off)
      }
      else {
        projectRows.value = []
        loadError.value = projectRaw.error ?? '读取项目技能失败'
      }
      loadedFor.value = keyOf()
    }
    finally {
      loading.value = false
    }
  }

  /** 扫一次但别重复扫：没扫过、或者换过根（换目录 / 换机器）才真扫 */
  async function ensure(): Promise<void> {
    if (loadedFor.value === keyOf())
      return
    await refresh()
  }

  /** 开关一个技能：只动设置里那张表（Pi 那边下次起进程才看到） */
  async function toggle(row: AiSkillRow): Promise<void> {
    const off = settings.settings.aiSkillsOff
    const next = row.enabled
      ? [...off, row.key] // 关掉：记进表里
      : off.filter(key => key !== row.key)
    await settings.updateSettings({ aiSkillsOff: next })

    // 就地更新两栏（不必重扫：只有开关变了）
    const apply = (list: AiSkillRow[]): AiSkillRow[] =>
      list.map(item => (item.key === row.key ? { ...item, enabled: !row.enabled } : item))
    globalRows.value = apply(globalRows.value)
    projectRows.value = apply(projectRows.value)
  }

  /**
   * 装一个技能。同名已经在时先问一句（Rust 那边报「已经有同名的技能了」），
   * 确认后带 overwrite 重调 —— 与技能页装到项目那一条完全同款（见 SkillInstallDialog.vue）。
   *
   * 返回装上（或覆盖）的技能名；取消 / 失败回空串（失败已经报过了）。
   */
  async function install(level: AiSkillLevel, source: PiSkillSource): Promise<string> {
    const root = rootOf(level)
    if (!root) {
      notifyError(level === 'global' ? '拿不到用户目录，全局技能用不了' : '这个会话还没有工作目录')
      return ''
    }

    const call = (overwrite: boolean) =>
      source.kind === 'zip'
        ? piSkillInstallZip(root, source.value, null, overwrite)
        : source.kind === 'dir'
          ? piSkillInstallDir(root, source.value, null, overwrite)
          : piSkillInstallUrl(root, source.value, null, overwrite)

    const first = await call(false)
    const installed = first.data
    if (first.ok && installed) {
      await refresh()
      notifySuccess(`已装上「${installed.id}」（${installed.files} 个文件）`)
      return installed.id
    }

    const message = first.error ?? '装技能失败'
    // 只有「同名」这一种错值得追问一句；别的（没有 SKILL.md、下不动、路径不对）照实报
    if (!/同名/.test(message)) {
      notifyError(message)
      return ''
    }

    const id = /同名[^：:]*[：:]\s*([^\s（(]+)/.exec(message)?.[1] ?? '同名技能'
    const yes = await confirmAction(
      `技能根里已经有一个「${id}」了。覆盖会把它整个换成这一份（原来那份的内容不再保留）。`,
      '要覆盖吗？',
      { confirmButtonText: '覆盖' },
    )
    if (!yes)
      return ''

    const retry = await call(true)
    const replaced = retry.data
    if (!retry.ok || !replaced) {
      notifyError(retry.error ?? '装技能失败')
      return ''
    }
    await refresh()
    notifySuccess(`已覆盖「${replaced.id}」（${replaced.files} 个文件）`)
    return replaced.id
  }

  /**
   * 卸掉一个技能：删掉那个技能目录整棵。**先问一句** —— 删的是用户自己那份目录里的东西
   * （项目那份多半就在他的仓库里，删了他要自己提交才是真的删）。
   */
  async function remove(row: AiSkillRow): Promise<boolean> {
    const where = row.level === 'global' ? '全局技能' : '这个项目'
    const yes = await confirmAction(
      `「${row.name || row.id}」会从${where}里整个删掉（${row.fileCount} 个文件）。${
        row.level === 'project' ? '项目里那份删掉之后，技能库里的原件还在。' : ''}`,
      '要卸掉吗？',
      { confirmButtonText: '卸掉' },
    )
    if (!yes)
      return false

    const result = await piSkillRemove(row.root, row.id)
    if (!result.ok) {
      notifyError(result.error ?? '卸掉技能失败')
      return false
    }
    await refresh()
    notifySuccess(`已卸掉「${row.name || row.id}」`)
    return true
  }

  // 换了目录（切会话 / 换工作目录）就重扫项目那一栏；全局那份也跟着这条重扫，成本可忽略
  watch(
    () => keyOf(),
    () => {
      if (loadedFor.value && loadedFor.value !== keyOf())
        void refresh()
    },
  )

  return {
    globalRoot,
    projectRoot,
    globalReady,
    projectReady,
    globalRows,
    projectRows,
    rows,
    pickable,
    enabledRefs,
    globalRefs,
    loading,
    loadError,
    refresh,
    ensure,
    toggle,
    install,
    remove,
  }
})
