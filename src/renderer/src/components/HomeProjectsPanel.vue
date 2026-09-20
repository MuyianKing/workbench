<script setup lang="ts">
/**
 * 首页「我的项目」卡片：只画**勾了「在首页展示」**的那些项目（见 Project.home），
 * 一个项目就是项目页上那张项目卡（启动 / 停止 / 打包 / 检测 / 安装 / 「⋯」菜单都在卡上，
 * 不用先跳去项目页）。
 *
 * 顺序取自项目页的展示顺序（store 的 `homeProjects`）—— 这是一份挑出来的名单，
 * 用户按什么顺序摆的项目页，首页就照着来。原先这里按 `lastUsedAt` 排最近三个：
 * 一是「最近用过」由用户挑、不用猜，二是按时间排意味着每启动一次卡片就换个位置。
 *
 * 排布跟着面板宽度走：放得下一列就一列、放得下两列就两列（网格下限与项目页同一个 302px，
 * 所以每张卡都不会被压得跟项目页长得不一样）；再窄下去卡片自己会换行（见 ProjectCard）。
 *
 * **这张卡不画标题行，也不画面板壳**：里面装的就是项目卡本身，再套一层背景、边框与内边距，
 * 等于把「卡片」画了两遍，还把那几张项目卡往里挤。整块看上去就是几张项目卡直接摆在画布上；
 * 卡叫什么在编辑态的卡标签与设置里的卡片清单里都看得到（见 theme.ts 的 HOME_CARD_LABELS）。
 *
 * 空状态分两种：一个项目都还没有，和有项目但一个都没勾 —— 后者要说清楚去哪儿勾，
 * 否则用户对着这张卡只会以为它坏了。
 */
import { computed } from 'vue'
import { Collection } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import ProjectCard from '@/components/ProjectCard.vue'

const store = useProjectsStore()

const projects = computed(() => store.homeProjects)
</script>

<template>
  <article class="panel">
    <div v-if="projects.length" class="projects panel__scroll">
      <ProjectCard v-for="project in projects" :key="project.id" :project="project" />
    </div>

    <p v-else class="panel__empty">
      <el-icon class="empty__icon"><Collection /></el-icon>
      <template v-if="store.projects.length">
        还没有放到首页的项目<br />
        在项目卡的「⋯」菜单或项目详情里打开「在首页展示」。
      </template>
      <template v-else>
        还没有项目<br />
        添加项目时勾上「在首页展示」，它就会出现在这里。
      </template>
    </p>
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
.projects {
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
