<script setup lang="ts">
/**
 * 首页「最近使用」卡片：按 lastUsedAt 排出的最近几个项目，一个项目就是项目页上那张项目卡
 * （启动 / 停止 / 打包 / 检测 / 安装 / 「⋯」菜单都在这儿，不用先跳去项目页）。
 *
 * 排布跟着面板宽度走：放得下一列就一列、放得下两列就两列（网格下限与项目页同一个 302px，
 * 所以每张卡都不会被压得跟项目页长得不一样）；再窄下去卡片自己会换行（见 ProjectCard）。
 *
 * **这张卡不画标题行，也不画面板壳**：里面装的就是项目卡本身，再套一层背景、边框与内边距，
 * 等于把「卡片」画了两遍，还把那几张项目卡往里挤。整块看上去就是三张项目卡直接摆在画布上；
 * 卡叫什么在编辑态的卡标签与设置里的卡片清单里都看得到（见 theme.ts 的 HOME_CARD_LABELS）。
 *
 * 项目一个都没有时给一句空状态，免得面板里是一片空白。
 */
import { computed } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import ProjectCard from '@/components/ProjectCard.vue'

const store = useProjectsStore()

/** 只排三张：这块没有壳，再长就成了一列没边界的卡片墙，把首页其余卡片挤没了 */
const RECENT_LIMIT = 3

const recent = computed(() =>
  store.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, RECENT_LIMIT)
)
</script>

<template>
  <article class="panel">
    <div v-if="recent.length" class="recent panel__scroll">
      <ProjectCard v-for="project in recent" :key="project.id" :project="project" />
    </div>

    <p v-else class="panel__empty">还没有项目<br />添加一个项目后，最近用过的会排在这里。</p>
  </article>
</template>

<style scoped>
/**
 * 不画面板壳。`.panel` 是 global.css 里所有面板共用的外壳，这里按本卡的用法覆盖掉：
 * 背景、边框、阴影、内边距一概不画，整块只剩那几张项目卡。
 */
.panel {
  padding: 0;
  gap: 0;
  border: 0;
  background: none;
  box-shadow: none;
  /* 外壳自己的裁切会把第一排卡片悬停时那 1px 上浮切掉 */
  overflow: visible;
}

/**
 * 出血（负 margin + 等宽右 padding）本来是为了把滚动条顶到面板边缘、抵掉面板那圈内边距；
 * 内边距没了，再出血只会把内容顶出格，这里一起取消。
 */
.panel__scroll {
  margin-right: 0;
  padding-right: 0;
}

/**
 * 排得下几张就几列：auto-fill 按面板实际宽度算列数，卡片宽度跟着摊开（拖栏宽、把这张卡
 * 拖到中栏，都会重新算）。下限取项目页网格那个 302px —— 它同时也是项目卡的设计宽度，
 * 低于它卡片内部就要开始换行了；min(302px, 100%) 是为了栏宽被拖到 302 以下时不横向溢出。
 */
.recent {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(302px, 100%), 1fr));
  /* 与项目页网格、首页各卡片同一个间距：设置里的「卡片间距」（--card-gap 由 App.vue 写在 .app 上） */
  gap: var(--card-gap, 10px);
  align-content: start;
  /* 卡片各自按内容定高：同排里某张换行了，别让旁边那张被拉高、底下空出一截 */
  align-items: start;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /*
   * 不占滚动条槽。全站滚动条是「槽宽照旧占位、轨道透明」的 10px（见 global.css），
   * 别的面板有底衬兜着看不出来，这张卡没有面板壳 —— 那一槽露出的就是底下的画布，
   * 卡片看着就没排到本栏右缘（右边多出一条留白）。滚轮与触控照旧能滚。
   */
  scrollbar-width: none;
  /* 给卡片悬停时那 1px 的上浮留出位置：滚动容器会在自己的 padding 盒上把外溢裁掉 */
  padding-top: 1px;
}
</style>
