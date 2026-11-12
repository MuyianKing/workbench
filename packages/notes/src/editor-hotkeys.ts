/**
 * 笔记编辑器的自定义快捷键：哪些动作允许用户配键、表怎么收敛、撞键怎么腾位。
 *
 * 编辑器（NoteEditor / Vditor）自带一套固定的内置键位（Ctrl+B 加粗、Ctrl+Alt+3 三级标题…），
 * 这一套不动 —— 用户配的自定义键**叠加**在内置之上：表里配了的动作按用户的键触发，
 * 没配的继续走 Vditor 内置。表**只存用户改过的项**，值是组合键串
 * （`Control+3` 这种写法，与全局快捷键同口径）；显式存**空串 = 禁用**这个动作的自定义键
 * （也是「把一个配错的键撤掉」的写法）。
 *
 * 两个不可配的动作（撤销 / 重做 / 大纲 / 全屏）不在这里：它们被 Vditor 内部键绑定与
 * 视图状态管着，拦下来自己 `runAction` 一遍会跟内部状态分叉。
 *
 * 全是纯函数：设置项住在数据文件（本机性质，不参与外观同步，与 `hotkey` / `captureHotkey`
 * 同类），收敛在 `persisted-data.ts` 编排，运行时匹配在 NoteEditor 的 onKeyCapture。
 */

/** 一个可配快捷键的编辑器动作（name 与 NoteContextMenu / NoteEditor 的 TOOLBAR 一致） */
export interface EditorHotkeyAction {
  name: string
  label: string
}

/**
 * 可配的动作清单：写东西用得上的 18 项，与右键菜单那一组一致。
 * **别往里加 undo / redo / outline / fullscreen**（见文件头的说明）。
 */
export const EDITOR_HOTKEY_ACTIONS: readonly EditorHotkeyAction[] = [
  { name: 'heading1', label: '一级标题' },
  { name: 'heading2', label: '二级标题' },
  { name: 'heading3', label: '三级标题' },
  { name: 'heading4', label: '四级标题' },
  { name: 'heading5', label: '五级标题' },
  { name: 'heading6', label: '六级标题' },
  { name: 'bold', label: '粗体' },
  { name: 'italic', label: '斜体' },
  { name: 'strike', label: '删除线' },
  { name: 'inline-code', label: '行内代码' },
  { name: 'code', label: '代码块' },
  { name: 'link', label: '链接' },
  { name: 'quote', label: '引用' },
  { name: 'list', label: '无序列表' },
  { name: 'ordered-list', label: '有序列表' },
  { name: 'check', label: '任务列表' },
  { name: 'line', label: '分隔线' },
  { name: 'table', label: '表格' },
] as const

/** 动作名 → 界面上的叫法（设置里与冲突提示共用） */
export const EDITOR_HOTKEY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  EDITOR_HOTKEY_ACTIONS.map(action => [action.name, action.label]),
)

/**
 * **生效的默认键位表**：用户没配（或「恢复默认」删掉）的那个动作，按这里的键触发。
 *
 * 与 Vditor 原厂键位只差一处 —— 标题六档取 `Control+1` ~ `Control+6`（原厂是
 * `Ctrl+Alt+N`，数字位离手近、与编辑器常用档位贴身），其余 12 项照原厂
 * （粗体 Ctrl+B、斜体 Ctrl+I、删除线 Ctrl+D、行内代码 Ctrl+G、代码块 Ctrl+U、
 * 链接 Ctrl+K、引用 Ctrl+;、无序 Ctrl+L、有序 Ctrl+O、任务 Ctrl+J、
 * 分隔线 Ctrl+Shift+H、表格 Ctrl+M）。
 *
 * **与原厂并行的关系**：默认键位由 NoteEditor 的拦截层触发（命中 → 去点工具带按钮）；
 * Vditor 原厂键位它自己还在监听，两边同时有效 —— 按 Ctrl+Alt+3 与按 Ctrl+3 都是三级标题。
 * 界面显示取这张表；用户配了自定义键后显示与触发都换用户的（空串 = 禁用该动作的拦截，
 * 只剩原厂键位）。
 */
export const EDITOR_HOTKEY_DEFAULTS: Readonly<Record<string, string>> = {
  'heading1': 'Control+1',
  'heading2': 'Control+2',
  'heading3': 'Control+3',
  'heading4': 'Control+4',
  'heading5': 'Control+5',
  'heading6': 'Control+6',
  'bold': 'Control+B',
  'italic': 'Control+I',
  'strike': 'Control+D',
  'inline-code': 'Control+G',
  'code': 'Control+U',
  'link': 'Control+K',
  'quote': 'Control+;',
  'list': 'Control+L',
  'ordered-list': 'Control+O',
  'check': 'Control+J',
  'line': 'Control+Shift+H',
  'table': 'Control+M',
}

/** 自定义快捷键表：动作名 → 组合键串（空串 = 禁用） */
export type EditorHotkeyMap = Record<string, string>

/**
 * 收敛用户（或手改过的数据文件）递上来的表：
 * 非对象回空表；动作名不在清单里的丢掉；值去空白，空串保留（= 禁用，是合法取值）；
 * 同名后项覆盖先项；**输出按清单顺序**排好，落盘的文件里顺序稳定。
 * 键串本身认不认得（修饰键齐不齐、主键存不存在）不在这一层判断 —— 匹配层查不到就当作没配，
 * 与 `sanitizeCaptureHotkey`「只收敛形态、解析交给用的人」是同一条口径。
 */
export function sanitizeEditorHotkeys(raw: unknown): EditorHotkeyMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return {}

  const known = new Set(EDITOR_HOTKEY_ACTIONS.map(action => action.name))
  const out: EditorHotkeyMap = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(name) || typeof value !== 'string')
      continue
    out[name] = value.trim()
  }
  const ordered: EditorHotkeyMap = {}
  for (const action of EDITOR_HOTKEY_ACTIONS) {
    if (action.name in out)
      ordered[action.name] = out[action.name]
  }
  return ordered
}

/** 撞键解析的结果：腾完位之后的表 + 被腾的动作名（给设置界面提示用） */
export interface EditorHotkeyConflict {
  next: EditorHotkeyMap
  cleared: string[]
}

/**
 * 把一个动作配到某个组合键上：撞了别的动作的键就把**那些**动作腾成空串（禁用），
 * 后配的保留。只比对非空串（禁用的项不占键位）；自己原来的键位不受影响。
 *
 * `accelerator` 传空串 = 只是想清掉这一个动作的键（比如「恢复默认」），
 * 那时不涉及其它动作，`cleared` 恒为空。
 */
export function resolveEditorHotkeyConflict(
  current: EditorHotkeyMap,
  action: string,
  accelerator: string,
): EditorHotkeyConflict {
  const next: EditorHotkeyMap = { ...current }

  if (accelerator) {
    const key = accelerator.trim().toLowerCase()
    const cleared: string[] = []
    for (const [name, bound] of Object.entries(next)) {
      if (name === action || !bound || bound.trim().toLowerCase() !== key)
        continue
      next[name] = ''
      cleared.push(name)
    }
    next[action] = accelerator.trim()
    return { next, cleared }
  }

  delete next[action]
  return { next, cleared: [] }
}

/**
 * 「默认 + 用户覆盖」合成一张**生效表**：NoteEditor 的拦截层与设置界面的显示都用它。
 *
 * - 用户没碰过的动作（不在表里）取 `EDITOR_HOTKEY_DEFAULTS`；
 * - 用户配了非空串 = 覆盖默认；
 * - 用户存了**空串 = 禁用**：该动作没有自定义键、也不吃默认键（想回到默认用「恢复默认」删项）。
 *
 * 返回的新表不含空串项 —— 消费方拿去查表就行，不用再判「这是禁用还是没配」。
 */
export function mergeEditorHotkeys(
  custom: EditorHotkeyMap | undefined,
  defaults: Readonly<Record<string, string>> = EDITOR_HOTKEY_DEFAULTS,
): EditorHotkeyMap {
  const merged: EditorHotkeyMap = { ...defaults }
  if (!custom)
    return merged
  for (const [name, value] of Object.entries(custom)) {
    if (value)
      merged[name] = value
    else
      delete merged[name]
  }
  return merged
}
