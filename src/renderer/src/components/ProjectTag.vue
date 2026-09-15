<script setup lang="ts">
/**
 * 工作记录上的项目标签：「这块是哪个项目」的那一枚记号。
 *
 * 用 Element Plus 的 `el-tag effect="dark"`：实心色块 + 反白文字，颜色浓到一眼认得出，
 * 而不是浅底同色字那种「看着都差不多」的样子（这是这一处的设计要求，别改成自绘的浅色标签）。
 * 预设色直接交给 `type`（EP 自己按主题变量取色，明暗两套与用户自定义的主题色都由它兜着）；
 * 自定义色 EP 不认，就用它同一套 CSS 变量把底色 / 描边 / 字色换成算好的值 ——
 * 字色用 accent-color 里那个 `inkOnAccent`，白字读不清时自动改近黑字。
 *
 * 项目被删掉后退成一枚中性描边标签（`missing`），不冒充某个项目。
 * 宽度与行为（截断、是否参与收缩）由调用方在自己的样式里给，这里只管颜色与形态。
 */
import { computed } from 'vue'
import { inkOnAccent } from '@shared/accent-color'
import {
  isProjectColorPreset,
  type ProjectColor,
  type ProjectColorPreset
} from '@shared/project-color'

const props = defineProps<{
  /** 标签上显示的名字；项目已删除时由调用方写成「项目已删除」 */
  name: string
  /** 项目的标识色；没设过（或写坏）时为 undefined，退回中性的主题色 */
  color?: ProjectColor
  /** 关联的项目已经不在项目列表里了 */
  missing?: boolean
}>()

const tagType = computed<ProjectColorPreset>(() =>
  isProjectColorPreset(props.color) ? props.color : 'primary'
)

const tagStyle = computed(() => {
  const value = props.color
  if (!value || isProjectColorPreset(value)) return undefined
  return {
    '--el-tag-bg-color': value,
    '--el-tag-border-color': value,
    '--el-tag-text-color': inkOnAccent(value),
    // 悬停底色跟着底色走，免得鼠标划过时冒出 EP 默认的那个浅色
    '--el-tag-hover-color': value
  }
})
</script>

<template>
  <el-tag
    size="small"
    disable-transitions
    :type="missing ? 'info' : tagType"
    :effect="missing ? 'plain' : 'dark'"
    :style="missing ? undefined : tagStyle"
  >
    {{ name }}
  </el-tag>
</template>
