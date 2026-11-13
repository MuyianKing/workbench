import type { CardPlacement, ColumnId, HomeCardId, RowId, RowTarget, ThemeConfig, ViewId, WidthField } from '@workbench/appearance'
import type { Ref } from 'vue'
import type { AppSettings } from '@/types'
import { addColumn as addColumnTo, clampCardGap, clampColumnWidth, clampRowHeight, clampVideoFloatHeight, clampVideoFloatPercent, clampVideoFloatWidth, clampWidth, COLUMN_WIDTH_DEFAULT, DEFAULT_THEME, moveCard as placeCard, setColumnWidths as placeColumnWidths, removeColumn as removeColumnFrom, rowHeightMin, rowOf, sanitizeTheme, VIEW_LABELS } from '@workbench/appearance'
import { computed, ref } from 'vue'
import { bootstrapSnapshot } from '@/bootstrap'
import { notifyError } from '@/notify'

/**
 * 首页布局（theme.json）：卡片位置、栏与行、栏宽、间距，以及几个「这一页长什么样」的开关。
 *
 * 从 `settings.ts` 拆出来的一整块，只认整份设置（`viewLabelOf` 要用程序名）。
 * 与终端高度同一套做法：拖动时只改本地 ref 让布局跟手，松手才整份落盘。
 * 对外名字与行为完全不变。
 */
export function useSettingsLayout({ settings }: { settings: Ref<AppSettings> }) {
  /**
   * 首页的分栏布局（theme.json：外观 + 布局都在这个文件里）。
   *
   * 只读它的布局字段（cards / 栏与行 / 间距）。改成外观那几项走的是 `settings`：
   * 适配层在那边把两份合起来，这里的 `themeConfig` 可能比适配层旧一拍 ——
   * 无妨，因为每次落盘都是把补丁交给适配层、由它并到自己那份权威值上（见 workbench/state.ts）。
   */
  const themeConfig = ref<ThemeConfig>(sanitizeTheme(bootstrapSnapshot()?.themeConfig ?? DEFAULT_THEME))

  const cardGap = computed(() => themeConfig.value.cardGap)

  function applyThemeConfig(value: ThemeConfig): void {
    themeConfig.value = sanitizeTheme(value)
  }

  async function saveThemeConfig(patch: Partial<ThemeConfig>): Promise<boolean> {
    const result = await window.workbench.updateThemeConfig(patch)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '保存首页布局失败')
      return false
    }
    applyThemeConfig(result.data)
    return true
  }

  /**
   * 把一块卡片挪到落点上（拖放收手时走它）：本地先跟手，随即落盘。
   *
   * 行清单也一起换 —— 「另起一行」会多出一行、卡片被搬空的那一行会跟着没了
   * （见 packages/appearance/src/theme.ts 的 moveCard），所以这两份必须同一次写下去。
   */
  async function moveCard(id: HomeCardId, target: RowTarget): Promise<void> {
    const moved = placeCard(themeConfig.value.cards, themeConfig.value.columns, id, target)
    themeConfig.value.cards = moved.cards
    themeConfig.value.columns = moved.columns
    await saveThemeConfig({ cards: moved.cards, columns: moved.columns })
  }

  /** 拖动行下边缘改高度：过程中只改本地，松手时由 commitColumns 落盘 */
  function setRowHeight(id: RowId, height: number): void {
    const row = rowOf(themeConfig.value.columns, id)
    if (!row)
      return
    row.height = clampRowHeight(height, rowHeightMin(themeConfig.value.cards, id))
  }

  /** 切换一行的高度模式（固定 / 自适应）；一次性动作，切完直接落盘 */
  async function toggleRowMode(id: RowId): Promise<void> {
    const row = rowOf(themeConfig.value.columns, id)
    if (!row)
      return
    row.mode = row.mode === 'flex' ? 'fixed' : 'flex'
    await commitColumns()
  }

  /**
   * 关掉 / 打开首页的某一块卡片。
   *
   * 关掉只是不画它：它那一行与行内的位置都留着，再打开时回到原来那一格（见 packages/appearance/src/theme.ts）。
   * 与拖动落盘走同一条路（commitCards）：整份送出去，免得别的卡片停在旧快照。
   */
  async function setCardVisible(id: HomeCardId, visible: boolean): Promise<void> {
    themeConfig.value.cards[id].hidden = !visible
    await commitCards()
  }

  /** 松手落盘：所有卡片一起送，避免只有被拖的那块更新、其余停留在旧快照 */
  async function commitCards(): Promise<void> {
    const cards = {} as Record<HomeCardId, CardPlacement>
    for (const id of Object.keys(themeConfig.value.cards) as HomeCardId[]) {
      cards[id] = { ...themeConfig.value.cards[id] }
    }
    await saveThemeConfig({ cards })
  }

  /**
   * 拖动某一栏的宽度：只改本地让界面跟手，**松手用 `commitThemeWidth` 整份落盘**
   * （它也在 theme.json 里）。档位（min / max / 默认）由 `@workbench/appearance` 的
   * `WIDTH_FIELDS` 一处定，这里不重复。
   */
  function setThemeWidth(field: WidthField, width: number): void {
    themeConfig.value[field] = clampWidth(field, width)
  }

  /** 松手落盘某一栏的宽度（整份 saveThemeConfig，与别处一致） */
  async function commitThemeWidth(field: WidthField): Promise<void> {
    const patch: Partial<ThemeConfig> = {}
    patch[field] = themeConfig.value[field]
    await saveThemeConfig(patch)
  }

  /**
   * 视频页左栏（目录树）收起 / 展开：收起只是不画那一列，播放器占满整行，
   * 入口在播放器头部那颗按钮上。落 theme.json（与笔记树宽度同属「这一页长什么样」）。
   */
  async function setVideoTreeCollapsed(collapsed: boolean): Promise<boolean> {
    if (themeConfig.value.videoTreeCollapsed === collapsed)
      return true
    return saveThemeConfig({ videoTreeCollapsed: collapsed })
  }

  /**
   * 导航上各页的名字：**AI 页跟程序名走** —— 用户在设置里把程序叫什么，这个智能体就叫什么
   * （导航栏与设置菜单两处都从这儿取）；其余页照 @workbench/appearance 的默认名。
   */
  function viewLabelOf(id: ViewId): string {
    return id === 'ai' ? settings.value.appName : VIEW_LABELS[id]
  }

  /**
   * AI 助手页左栏（项目 → 会话那棵树）收起 / 展开：收起后对话占满整行，
   * 入口在对话区左上角那颗按钮上。落 theme.json（与视频树收起同一套做法）。
   */
  async function setAiTreeCollapsed(collapsed: boolean): Promise<boolean> {
    if (themeConfig.value.aiTreeCollapsed === collapsed)
      return true
    return saveThemeConfig({ aiTreeCollapsed: collapsed })
  }

  /**
   * 画中画悬浮小窗的位置与尺寸：与视频树宽同一套做法 —— 拖动 / 缩放时只改本地让界面跟手，
   * 松手才整份落盘（四个字段一起送，theme.json 一份快照一次写完）。
   */
  function setVideoFloatGeometry(geometry: { x: number, y: number, w: number, h: number }): void {
    themeConfig.value.videoFloatX = clampVideoFloatPercent(geometry.x)
    themeConfig.value.videoFloatY = clampVideoFloatPercent(geometry.y)
    themeConfig.value.videoFloatW = clampVideoFloatWidth(geometry.w)
    themeConfig.value.videoFloatH = clampVideoFloatHeight(geometry.h)
  }

  async function commitVideoFloatGeometry(): Promise<void> {
    await saveThemeConfig({
      videoFloatX: themeConfig.value.videoFloatX,
      videoFloatY: themeConfig.value.videoFloatY,
      videoFloatW: themeConfig.value.videoFloatW,
      videoFloatH: themeConfig.value.videoFloatH,
    })
  }

  /** 拖动分栏边界：一次给出那一条缝上要改的栏与新宽度（两栏一起改），过程中只改本地 */
  function setColumnWidths(widths: Record<ColumnId, number>): void {
    themeConfig.value.columns = placeColumnWidths(themeConfig.value.columns, widths)
  }

  /**
   * 松手落盘栏（连行一起）：整份送出去 —— 拆栏 / 收栏 / 改栏宽 / 改行高都走它，
   * 免得只更新一栏。行是栏的一部分，所以行高与行的高度模式也落在这一份里。
   */
  async function commitColumns(): Promise<void> {
    await saveThemeConfig({
      columns: themeConfig.value.columns.map(column => ({
        ...column,
        rows: column.rows.map(row => ({ ...row })),
      })),
    })
  }

  /**
   * 切换某一栏的宽度模式：自适应 ↔ 固定。
   *
   * 固定时取它此刻的显示宽度（由画布量了传进来）：切换前后那一栏的宽度看起来不动，
   * 用户只是把「当前这个宽度」钉住了 —— 与行上那颗「固定 / 自适应」同一个做法。
   */
  async function toggleColumnMode(id: ColumnId, currentWidth: number): Promise<void> {
    const column = themeConfig.value.columns.find(item => item.id === id)
    if (!column)
      return

    column.width
      = column.width === null ? clampColumnWidth(currentWidth, COLUMN_WIDTH_DEFAULT) : null
    await commitColumns()
  }

  /** 在某一栏右边拆出一栏（宽度跟着它）；到栏数上限时不动 */
  async function addColumn(afterId: ColumnId): Promise<void> {
    const next = addColumnTo(themeConfig.value.columns, afterId)
    if (next === themeConfig.value.columns)
      return

    themeConfig.value.columns = next
    await commitColumns()
  }

  /** 收掉一栏：栏里的行整条并到相邻那一栏；只剩一栏时不动 */
  async function removeColumn(id: ColumnId): Promise<void> {
    const removed = removeColumnFrom(themeConfig.value.cards, themeConfig.value.columns, id)
    if (!removed)
      return

    themeConfig.value.columns = removed.columns
    themeConfig.value.cards = removed.cards
    await saveThemeConfig({ columns: removed.columns, cards: removed.cards })
  }

  /** 卡片间距是设置项，改完立即落盘（栏间、行间、行内卡片、项目卡网格同时生效） */
  async function setCardGap(value: number): Promise<void> {
    const next = clampCardGap(value)
    themeConfig.value.cardGap = next
    await saveThemeConfig({ cardGap: next })
  }

  /** 恢复默认布局；栏数 / 栏宽 / 行数与行高 / 卡片位置 / 间距 / 关掉的卡片全部回到默认 */
  async function resetLayout(): Promise<void> {
    const fallback = sanitizeTheme(DEFAULT_THEME)
    themeConfig.value = fallback
    await saveThemeConfig({
      cardGap: fallback.cardGap,
      columns: fallback.columns,
      cards: fallback.cards,
    })
  }

  return {
    themeConfig,
    cardGap,
    applyThemeConfig,
    saveThemeConfig,
    moveCard,
    setRowHeight,
    toggleRowMode,
    setCardVisible,
    commitCards,
    viewLabelOf,
    setColumnWidths,
    commitColumns,
    toggleColumnMode,
    addColumn,
    removeColumn,
    setThemeWidth,
    commitThemeWidth,
    setAiTreeCollapsed,
    setVideoTreeCollapsed,
    setVideoFloatGeometry,
    commitVideoFloatGeometry,
    setCardGap,
    resetLayout,
  }
}
