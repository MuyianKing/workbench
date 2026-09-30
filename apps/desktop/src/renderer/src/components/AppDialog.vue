<script setup lang="ts">
/**
 * 弹层外壳：应用里的 `el-dialog` 一律走它，跨弹层的规矩只写在这一处。
 *
 * 收拢的是这两条 —— 它们以前在每个弹层里各写一遍，改一条要翻遍所有弹层：
 *
 *  1. **`append-to-body`**：弹层必须离开 `.app` 子树，否则会被顶部毛玻璃的 backdrop-filter 连累
 *     （见 global.css 弹层一节，实测弹层会整块画不出来或只画出一截）。谁都不该漏，所以硬写在里面。
 *  2. **挡不挡背后**：默认挡（遮罩接住点击，与直接用 el-dialog 一样）；`penetrable` 则不挡 ——
 *     填内容的弹层（密码 / 工作记录 / 命令 / 常用软件 / 添加项目 / 起名字 / 素材管理）常常要切到
 *     别的页面抄一段再粘回来，遮罩只围住弹框自己（`:modal="false"` + `modal-penetrable`，
 *     是 Element Plus 自带的一对）。
 *     这一档顺带没有「点外面关掉」——遮罩不接点击，也就没有那一下，所以 `close-on-click-modal`
 *     一并按 false 给；反过来，需要「点外面关掉」的弹层就别用 penetrable。
 *
 * 另外两条也归它管：
 *
 *  - **弹窗可以拖**（`draggable`，抓手是标题栏）：拖开一点，好让被它压住的正文露出来。
 *    不用逐个弹层开 —— 这是所有弹窗都要的。
 *  - **关掉之后把位置复位**（`resetPosition`）：拖动是这一次会话里的事，下次打开还回居中那一份，
 *    否则一个「居中」的弹窗下次从斜下方冒出来，看着像出了毛病。
 *    头部被 CSS 藏掉的弹层（技能详情那种自绘头部的）拖不了 —— 抓手就是 EP 的标题栏。
 *
 * 其余一概透传：`v-model` / `title` / `width` / `class` / `body-class` / `before-close` /
 * `@opened` / `@closed` 与全部插槽，写法和直接用 el-dialog 没有区别。
 */
import { computed, ref, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /**
   * 不挡背后：填内容的弹层用 true，见 AGENTS.md 第 4 节。
   * 这些弹层本来就是「点外面关掉」关着的那几个，所以不会因此丢掉什么。
   */
  penetrable?: boolean
}>()

const attrs = useAttrs()

/** penetrable 时补上「不挡背后」那一组，其余照调用方给的透传 */
const forwarded = computed(() =>
  props.penetrable
    ? { ...attrs, modal: false, modalPenetrable: true, closeOnClickModal: false }
    : attrs
)

/** el-dialog 实例上只用到这一个方法（见上面「关掉之后把位置复位」） */
const dialogRef = ref<{ resetPosition: () => void } | null>(null)

/** 关闭动画走完再复位，下一次打开就是居中的那一份 */
function resetDrag(): void {
  dialogRef.value?.resetPosition()
}
</script>

<template>
  <el-dialog ref="dialogRef" v-bind="forwarded" append-to-body draggable @closed="resetDrag">
    <!-- 插槽按调用方给的转出去：没给的不占位（给了空的 header 反而会多出一行头部） -->
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </el-dialog>
</template>
