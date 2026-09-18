<script setup lang="ts">
/**
 * 首页「最近使用」卡片：按 lastUsedAt 排出的最近几个项目，一个项目就是项目页上那张项目卡
 * （启动 / 停止 / 打包 / 检测 / 安装 / 「⋯」菜单都在这儿，不用先跳去项目页）。
 *
 * 排布跟着面板宽度走：放得下一列就一列、放得下两列就两列（网格下限与项目页同一个 302px，
 * 所以每张卡都不会被压得跟项目页长得不一样）；再窄下去卡片自己会换行（见 ProjectCard）。
 *
 * 项目一个都没有时给一句空状态，免得卡片里是一片空白。
 */
import { computed } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import ProjectCard from '@/components/ProjectCard.vue'

const store = useProjectsStore()

/** 卡片高度有限，列表截断到一屏左右 */
const RECENT_LIMIT = 5

const recent = computed(() =>
  store.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, RECENT_LIMIT)
)
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">最近使用</span>
      <span class="panel__count mono">{{ recent.length }}</span>
    </header>

    <div v-if="recent.length" class="recent panel__scroll">
      <ProjectCard v-for="project in recent" :key="project.id" :project="project" />
    </div>

    <p v-else class="panel__empty">还没有项目<br />添加一个项目后，最近用过的会排在这里。</p>
  </article>
</template>

<style scoped>
/**
 * 排得下几张就几列：auto-fill 按面板实际宽度算列数，卡片宽度跟着摊开（拖栏宽、把这张卡
 * 拖到中栏，都会重新算）。下限取项目页网格那个 302px —— 它同时也是项目卡的设计宽度，
 * 低于它卡片内部就要开始换行了；min(302px, 100%) 是为了栏宽被拖到 302 以下时不横向溢出。
 */
.recent {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(302px, 100%), 1fr));
  /* 与项目页网格、首页各卡片同一个间距配置 */
  gap: var(--card-gap, 10px);
  align-content: start;
  /* 卡片各自按内容定高：同排里某张换行了，别让旁边那张被拉高、底下空出一截 */
  align-items: start;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 给卡片悬停时那 1px 的上浮留出位置：滚动容器会在自己的 padding 盒上把外溢裁掉 */
  padding-top: 1px;
}
</style>
