<script setup lang="ts">
import type { SkillEntry } from '@workbench/skills'
import { FolderOpened, Position } from '@element-plus/icons-vue'
/**
 * 技能卡片：网格里的一块（与项目卡同一副外壳 —— 同样的圆角、投影与不透明度跟随）。
 *
 * 结构上分三段：头部徽章 + 名字 / 版本 / 状态，一条细分隔线下的描述，
 * 底栏放操作与文件数。左缘一根竖条是状态锚点：默认绿（--st-ok，就绪），
 * 有项目副本要处理时换成 --st-run；状态色不靠文字去抢注意力。徽章取名字首字符，
 *
 * 卡片本身点开详情弹窗。底栏两个图标按钮（安装到项目 / 打开文件夹）**常驻弱化**、
 * 整卡悬停或键盘聚焦时提亮（不再像从前那样完全隐藏，藏起来时总要先悬停才找得到按钮）；
 * 点击要 stopPropagation，不该顺带把详情弹窗也拉开。没有 SKILL.md 的卡片挂着常显的
 * 警示徽标，安装按钮置灰。
 *
 * 版本号旁还有一颗「N 个项目有更新」徽标（`updatedCopies`，后台扫描填的）：卡片上的
 * `v0.0.2` 是**库里那份**的版本，项目副本更新到 `v0.0.3` 时库不会自己动 —— 没有这颗徽标，
 * 那件事只有点开详情才看得见。数字是「有几份副本比库新 / 不一样」，只提示、不替用户挑边。
 */
import { computed } from 'vue'

const props = defineProps<{ skill: SkillEntry, updatedCopies: number }>()
const emit = defineEmits<{
  (event: 'open'): void
  (event: 'install'): void
  (event: 'folder'): void
}>()

/** 没有清单文件的目录还不是技能：警示常显，安装置灰 */
const metaWarn = !props.skill.hasSkillMd
/** 有项目副本需要看：竖条点亮、徽标出现 */
const hasUpdate = props.updatedCopies > 0
/** 徽章取名字首字符（中文名直接取汉字）；名字回落目录名，不会是空串 */
const initial = computed(() => props.skill.name.charAt(0).toUpperCase())
</script>

<template>
  <article
    class="card"
    :class="{ 'card--update': hasUpdate }"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <div class="card__main">
      <div class="card__head">
        <span class="card__badge" aria-hidden="true">{{ initial }}</span>
        <div class="card__title">
          <div class="card__name-row">
            <h3 class="card__name truncate" :title="skill.name">
              {{ skill.name }}
            </h3>
          </div>
          <div v-if="hasUpdate || metaWarn" class="card__status-row">
            <!-- 项目里的副本比库新 / 不一样：只提示有几份，点开详情看逐项差异，不在这里替用户挑边 -->
            <el-tooltip
              v-if="hasUpdate"
              content="有项目里的副本与库中这份不一样，点开看详情"
              placement="top-start"
              teleported
            >
              <span class="card__outdated">
                {{ updatedCopies }} 个项目有更新
              </span>
            </el-tooltip>
            <span v-if="metaWarn" class="card__warn">没有 SKILL.md</span>
          </div>
        </div>
        <!-- 版本号：从 frontmatter 的 version 解析（保存必填）；历史 / 导入数据没有就不显示。贴卡片右上角 -->
        <el-tag v-if="skill.version" size="small" type="info" effect="plain" class="card__version mono">
          v{{ skill.version }}
        </el-tag>
      </div>
      <div class="card__rule" />
      <p class="card__desc" :class="{ 'card__desc--empty': !skill.description }">
        {{ skill.description || '未写描述' }}
      </p>
    </div>
    <div class="card__bar">
      <div class="card__ops">
        <el-tooltip content="安装到项目的 .agents/skills 目录下" placement="top-start" teleported>
          <el-button
            text
            size="small"
            :icon="Position"
            :disabled="metaWarn"
            aria-label="安装到项目"
            @click.stop="emit('install')"
          />
        </el-tooltip>
        <el-tooltip content="在资源管理器里显示这个技能" placement="top-start" teleported>
          <el-button
            text
            size="small"
            :icon="FolderOpened"
            aria-label="打开文件夹"
            @click.stop="emit('folder')"
          />
        </el-tooltip>
      </div>
      <span class="card__files mono">{{ skill.fileCount }} 个文件</span>
    </div>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 88px;
  /* 与项目卡 / .panel 同一条规则：底色浓度跟着设置里的「卡片不透明度」走，磨砂取 tokens 那套玻璃 */
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
  /* 四周那条线归设置里的「毛玻璃描边」（默认不画） */
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  overflow: hidden;
  transition: box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out), transform 0.18s var(--ease-out);
}

/* 左缘状态锚点：默认绿（就绪），有项目副本要处理才换成状态橙 */
.card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--st-ok);
  transition: background 0.18s var(--ease-out);
}

.card.card--update::before {
  background: var(--st-run);
}

.card:hover {
  border-color: var(--glass-border-color-hover);
  box-shadow: var(--shadow-hover);
  transform: translateY(-2px);
}

.card:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.card__main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex: 1;
  padding: var(--sp-3) var(--sp-4);
}

.card__head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.card__badge {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
}

.card__title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.card__name-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.card__name {
  margin: 0;
  min-width: 0;
  color: var(--ink);
  font-size: var(--fs-title);
}

.card__version {
  flex-shrink: 0;
  align-self: flex-start;
  /* 版本用主题色：覆盖 el-tag 的三件套变量（--ink-accent 是「这段话用主题色」的令牌，
     对比度已按主题调好）；描边与底色从主色混淡，不硬编码颜色 */
  --el-tag-text-color: var(--ink-accent);
  --el-tag-border-color: color-mix(in srgb, var(--el-color-primary) 32%, transparent);
  --el-tag-bg-color: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  --el-tag-hover-color: color-mix(in srgb, var(--el-color-primary) 16%, transparent);
}

.card__version :deep(.el-tag__content) {
  color: inherit;
}

.card__status-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 状态色表达「这里要处理」，不新增颜色；不换行、不挤掉标题 */
.card__outdated,
.card__warn {
  color: var(--st-run);
  font-size: var(--fs-micro);
  white-space: nowrap;
}

.card__rule {
  height: 1px;
  background: var(--border);
}

.card__desc {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.6;
  /* 固定占满 3 行：描述长短不一时内容区等高，底栏才不会被长短不一的文字顶出参差留白 */
  min-height: calc(var(--fs-meta) * 1.6 * 3);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.card__desc--empty {
  color: var(--ink-3);
}

/* 底栏：常驻的操作 + 文件数，悬停整卡提亮（不靠藏按钮腾空间） */
.card__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: auto;
  border-top: 1px solid var(--border);
  background: var(--bg-subtle);
  padding: var(--sp-2) var(--sp-4);
  transition: background 0.18s var(--ease-out);
}

.card:hover .card__bar {
  background: var(--bg-inset);
}

.card__ops {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  opacity: 0.55;
  transition: opacity 0.15s var(--ease-out);
}

.card:hover .card__ops,
.card:focus-within .card__ops {
  opacity: 1;
}

.card__files {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  white-space: nowrap;
}
</style>
