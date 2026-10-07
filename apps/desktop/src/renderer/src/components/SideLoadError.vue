<!--
  左栏读不出文件夹时的内联错误块：原因 + 重试 + 换一个文件夹。
  笔记页与视频页左栏共用一份(原先各写一遍,连样式都逐行相同)。
  故意是两个根元素:它直接落在侧栏的 flex 流里,不再包一层免得间距变了。
-->
<script setup lang="ts">
defineProps<{
  /** 读不出来的原因(后端原话) */
  error: string
}>()

const emit = defineEmits<{
  /** 用同一个文件夹再读一次 */
  retry: []
  /** 换一个文件夹 */
  relocate: []
}>()
</script>

<template>
  <p class="side-error__text">
    {{ error }}
  </p>
  <div class="side-error__actions">
    <el-button size="small" @click="emit('retry')">
      重试
    </el-button>
    <el-button size="small" @click="emit('relocate')">
      换一个文件夹
    </el-button>
  </div>
</template>

<style scoped>
.side-error__text {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.side-error__actions {
  display: flex;
  gap: var(--sp-2);
}
</style>
