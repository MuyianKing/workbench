<script setup lang="ts">
/**
 * 首字头像：名字的第一个字，按名字稳定散到八档柔和色里 —— 邮件清单行与通讯录名单共用。
 *
 * 色相只有这八档，别在别处再调一套；亮色浅底深字、暗色深底浅字（暗色那条在下面的
 * :global 里，跟着 :root[data-theme='dark'] 走）。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 显示名：首字与散色都按它算，同一个人恒定同色；拆不出名字（空 / 括号开头）时给 ? */
  name: string
}>()

/** 头像上的那个字：展示名的首字（中文原字 / 英文大写） */
const initial = computed(() => {
  const text = props.name.trim()
  if (!text || text.startsWith('('))
    return '?'
  return (Array.from(text)[0] ?? '?').toUpperCase()
})

/** 头像底色按展示名散到八档柔和色里：恒定，不表达状态 */
const tone = computed(() => {
  let hash = 0
  for (const char of props.name)
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % 8
})
</script>

<template>
  <span class="mail-avatar" :class="`is-tone-${tone}`" aria-hidden="true">{{ initial }}</span>
</template>

<style scoped>
/*
 * 28px 圆片，按展示名稳定散到八档柔和色（红 / 橙 / 黄 / 绿 / 青 / 蓝 / 靛 / 紫）。
 * 亮色浅底深字、暗色深底浅字。
 */
.mail-avatar {
  --avatar-h: 212;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-pill);
  background: hsl(var(--avatar-h), 75%, 84%);
  color: hsl(var(--avatar-h), 60%, 30%);
  font-size: var(--fs-meta);
  font-weight: 600;
  line-height: 1;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.mail-avatar.is-tone-0 {
  --avatar-h: 4;
}

.mail-avatar.is-tone-1 {
  --avatar-h: 28;
}

.mail-avatar.is-tone-2 {
  --avatar-h: 48;
}

.mail-avatar.is-tone-3 {
  --avatar-h: 150;
}

.mail-avatar.is-tone-4 {
  --avatar-h: 182;
}

.mail-avatar.is-tone-5 {
  --avatar-h: 212;
}

.mail-avatar.is-tone-6 {
  --avatar-h: 252;
}

.mail-avatar.is-tone-7 {
  --avatar-h: 292;
}

/* 暗色下同色相换深底浅字。整条选择器一起放进 :global()：只包 `:root[...]`
   那一截的话，scoped 编译会把后面的 `.mail-avatar` 丢掉，规则落到根元素上 */
:global(:root[data-theme='dark'] .mail-avatar) {
  background: hsl(var(--avatar-h), 40%, 30%);
  color: hsl(var(--avatar-h), 65%, 82%);
}
</style>
