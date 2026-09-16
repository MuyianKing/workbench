<script setup lang="ts">
/**
 * 笔记正文的右键菜单。
 *
 * 编辑器那条工具带被藏起来了（见 NoteEditor），它那套动作搬到这里，
 * 形式是「分组图标按钮 + 带子菜单的行」：上面三排随手要用，底下两行是标题与插入。
 *
 * 这个组件**只管摆和收**：每一项只记一个**动作名**（就是 Vditor 工具带上的项名），
 * 点下去经 `act` 交回 NoteEditor，由它去点工具带上那颗按钮 ——
 * 所以这里不认编辑器实例，也不知道 markdown 是怎么往返的。
 *
 * 三处细节是「点了真的有用」的前提：
 *  1. `mousedown` 必须 preventDefault：不这样，按下去的一瞬间焦点就从正文挪到按钮上，
 *     **选区没了**，于是「粗体」没有可加粗的东西；
 *  2. 位置贴指针但要夹回窗口内，右边放不下子菜单时整份翻到左边（`.is-flip`）；
 *  3. 收起交给 `useFloatingDismiss`（左键点别处、右键别处、Esc、滚轮、窗口缩放 / 失焦）。
 *     **右键不关自己**：在正文里换个地方右击时，编辑器的 contextmenu 会紧接着在新位置重开，
 *     两件事在同一个事件里闭环，不会先消失再出现。
 */
import { onMounted, ref, watch } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'

/** 排成图标按钮的动作：名字给 NoteEditor 认，图标是 Vditor 那套 sprite 里的 id */
interface MenuAction {
  name: string
  label: string
  icon: string
}

/** 子菜单里的一项（标题与插入块都是一行字，与工具带上那两个下拉一致） */
interface MenuRow {
  name: string
  label: string
}

const props = defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
}>()

const emit = defineEmits<{
  /** 选中了一项；名字是工具带项名（标题是 heading1…heading6） */
  act: [name: string]
  close: []
}>()

/** 离窗口边缘留出的空当：贴着边看着像被裁掉了一角 */
const EDGE = 6
/** 子菜单的宽度（含中间那道「桥」），与样式里的 min-width 对齐；用来判断往右开还放不放得下 */
const SUBMENU_WIDTH = 158

/**
 * 图标按钮分三排：历史与视图 / 行内 / 块级。
 *
 * 图标 id 与 Vditor 工具带用的是同一套 sprite（随包的 `js/icons/ant.js` 把
 * `#vditor-icon-*` 注进 body），所以这里能直接引用 —— 大纲那一项借用的是 Vditor 自己的选法（align-center）。
 */
const GROUPS: MenuAction[][] = [
  [
    { name: 'undo', label: '撤销', icon: 'undo' },
    { name: 'redo', label: '重做', icon: 'redo' },
    { name: 'outline', label: '大纲', icon: 'align-center' },
    { name: 'fullscreen', label: '全屏切换', icon: 'fullscreen' }
  ],
  [
    { name: 'bold', label: '粗体', icon: 'bold' },
    { name: 'italic', label: '斜体', icon: 'italic' },
    { name: 'strike', label: '删除线', icon: 'strike' },
    { name: 'inline-code', label: '行内代码', icon: 'inline-code' },
    { name: 'link', label: '链接', icon: 'link' }
  ],
  [
    { name: 'quote', label: '引用', icon: 'quote' },
    { name: 'ordered-list', label: '有序列表', icon: 'ordered-list' },
    { name: 'list', label: '无序列表', icon: 'list' },
    { name: 'check', label: '任务列表', icon: 'check' },
    { name: 'line', label: '分隔线', icon: 'line' }
  ]
]

/** 两行带子菜单的：标题（Vditor 工具带上是一个下拉）与插入整块的东西 */
const SUBMENUS: { label: string; items: MenuRow[] }[] = [
  {
    label: '段落',
    items: [
      { name: 'heading1', label: '一级标题' },
      { name: 'heading2', label: '二级标题' },
      { name: 'heading3', label: '三级标题' },
      { name: 'heading4', label: '四级标题' },
      { name: 'heading5', label: '五级标题' },
      { name: 'heading6', label: '六级标题' }
    ]
  },
  {
    label: '插入',
    items: [
      { name: 'code', label: '代码块' },
      { name: 'table', label: '表格' }
    ]
  }
]

const panel = ref<HTMLDivElement | null>(null)
/** 夹回窗口之后的落点 */
const pos = ref({ left: props.x, top: props.y })
/** 子菜单往左开 */
const flip = ref(false)

/** 贴指针摆好，并把整块夹进窗口；子菜单要往哪边开也在这里定 */
function place(): void {
  const element = panel.value
  if (!element) return

  const { width, height } = element.getBoundingClientRect()
  const left = Math.min(props.x, window.innerWidth - width - EDGE)
  const top = Math.min(props.y, window.innerHeight - height - EDGE)
  pos.value = { left: Math.max(EDGE, left), top: Math.max(EDGE, top) }
  flip.value = pos.value.left + width + SUBMENU_WIDTH > window.innerWidth
}

function pick(name: string): void {
  emit('act', name)
  emit('close')
}

// 点别处 / 右键别处 / Esc / 滚轮 / 窗口变化都收起（骨架在 composables 里，与目录树那份共用）
useFloatingDismiss({ panel: () => panel.value, onDismiss: () => emit('close') })

onMounted(place)

// 在正文里换个地方右击：面板沿用同一个实例，重算一次落点即可，不必重建
watch(() => [props.x, props.y], place)
</script>

<template>
  <Teleport to="body">
    <div
      ref="panel"
      class="menu"
      :class="{ 'is-flip': flip }"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      role="menu"
      @mousedown.prevent
      @contextmenu.prevent
    >
      <template v-for="(group, index) in GROUPS" :key="index">
        <div class="menu__grid">
          <el-tooltip
            v-for="action in group"
            :key="action.name"
            :content="action.label"
            placement="top"
            :show-after="250"
          >
            <button
              class="menu__btn"
              type="button"
              role="menuitem"
              :aria-label="action.label"
              @click="pick(action.name)"
            >
              <svg class="menu__icon" aria-hidden="true">
                <use :href="`#vditor-icon-${action.icon}`" />
              </svg>
            </button>
          </el-tooltip>
        </div>
        <span class="menu__sep" />
      </template>

      <!-- 子菜单挂在这一行里面：指针从行移到面板上时，它仍算悬停在这一行上 -->
      <div v-for="sub in SUBMENUS" :key="sub.label" class="sub">
        <div class="sub__row">
          <span class="sub__label">{{ sub.label }}</span>
          <!-- 箭头借图标集里的「下」，转 90° 就是「右」 -->
          <svg class="sub__arrow" aria-hidden="true">
            <use href="#vditor-icon-down" />
          </svg>
        </div>

        <div class="sub__panel">
          <div class="sub__card">
            <button
              v-for="item in sub.items"
              :key="item.name"
              class="sub__item"
              type="button"
              role="menuitem"
              @click="pick(item.name)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 浮层卡片：菜单本体与子菜单同一副外壳。
 * 底色用面底色而不是毛玻璃 —— 它压在正文的字上，透出底下的字就没法看了。
 */
.menu,
.sub__card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
}

.menu {
  position: fixed;
  /* 挂在 body 上（见模板里的 Teleport），比卡片与终端面板高，但仍在弹窗（EP 的 2000+）下面 */
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 196px;
  padding: var(--sp-2);
}

.menu__grid {
  display: grid;
  grid-template-columns: repeat(5, 30px);
  gap: var(--sp-1);
}

.menu__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--ink-2);
  cursor: pointer;
}

.menu__btn:hover {
  color: var(--ink);
  background: var(--bg-subtle);
  border-color: var(--border-strong);
}

.menu__icon {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.menu__sep {
  height: 1px;
  margin: var(--sp-1) 0;
  background: var(--border);
}

.sub {
  position: relative;
}

.sub__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 28px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-body);
  color: var(--ink-2);
  cursor: default;
}

.sub__label {
  flex: 1 1 auto;
}

.sub__arrow {
  width: 12px;
  height: 12px;
  fill: currentColor;
  /* 图标集里的「下」，转 90° 当「有子菜单」的箭头 */
  transform: rotate(-90deg);
}

.sub:hover > .sub__row {
  color: var(--ink);
  background: var(--bg-subtle);
}

/*
 * 子菜单：`sub__panel` 只负责位置与那块「桥」，
 * 卡片是里面的 `sub__card` —— 指针从这一行斜着移过去时才不会掉出悬停（掉出去就收，够不着了）。
 */
.sub__panel {
  display: none;
  position: absolute;
  top: calc(-1 * var(--sp-2));
  left: 100%;
  padding-left: var(--sp-1);
}

.sub:hover > .sub__panel {
  display: block;
}

.sub__card {
  min-width: 150px;
  padding: var(--sp-1);
}

/* 右边放不下就翻到左边（由 place() 判断） */
.menu.is-flip .sub__panel {
  left: auto;
  right: 100%;
  padding-right: var(--sp-1);
  padding-left: 0;
}

.sub__item {
  display: block;
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
}

.sub__item:hover {
  color: var(--ink);
  background: var(--bg-subtle);
}
</style>
