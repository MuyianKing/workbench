<script setup lang="ts">
/**
 * 技能卡片：网格里的一块（与项目卡同一副外壳 —— 同样的圆角、投影与不透明度跟随）。
 *
 * 卡片本身点开详情弹窗。右上角那两个图标按钮（安装到项目 / 打开文件夹）**悬停才显形**
 * （与工作记录卡的动作同一交互 —— 平时常显就是每张卡片都顶着两个按钮，太吵），
 * 键盘聚焦到按钮上时同样显形（focus-within）；点击要 stopPropagation，
 * 不该顺带把详情弹窗也拉开。没有 SKILL.md 的卡片挂着常显的警示徽标，安装按钮置灰。
 */
import { FolderOpened, Position } from '@element-plus/icons-vue'
import type { SkillEntry } from '@shared/skills'

const props = defineProps<{ skill: SkillEntry }>()
const emit = defineEmits<{
  (event: 'open'): void
  (event: 'install'): void
  (event: 'folder'): void
}>()

/** 没有清单文件的目录还不是技能：警示常显，安装置灰 */
const metaWarn = !props.skill.hasSkillMd
</script>

<template>
  <article
    class="card"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <div class="card__head">
      <div class="card__title">
        <h3 class="card__name" :title="skill.name">{{ skill.name }}</h3>
        <!-- 版本号：从 frontmatter 的 version 里解析的（保存时必填）；历史数据 / 导入的没有就不显示 -->
        <el-tag v-if="skill.version" size="small" type="info" effect="plain" class="card__version mono">
          v{{ skill.version }}
        </el-tag>
      </div>
      <div class="card__side">
        <span v-if="metaWarn" class="card__warn">没有 SKILL.md</span>
        <div class="card__ops">
          <el-tooltip content="安装到项目的 .agents/skills 目录下" placement="top">
            <el-button
              text
              size="small"
              :icon="Position"
              :disabled="metaWarn"
              aria-label="安装到项目"
              @click.stop="emit('install')"
            />
          </el-tooltip>
          <el-tooltip content="在资源管理器里显示这个技能" placement="top">
            <el-button
              text
              size="small"
              :icon="FolderOpened"
              aria-label="打开文件夹"
              @click.stop="emit('folder')"
            />
          </el-tooltip>
        </div>
      </div>
    </div>
    <p class="card__desc" :class="{ 'card__desc--empty': !skill.description }">
      {{ skill.description || '未写描述' }}
    </p>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-height: 88px;
  padding: var(--sp-3) var(--sp-4);
  /* 与 .panel（global.css）同一条规则：底色浓度跟着设置里的「卡片不透明度」走 */
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  overflow: hidden;
  transition: box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-hover);
  transform: translateY(-1px);
}

.card:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.card__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.card__name {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-title);
}

.card__version {
  flex-shrink: 0;
}

.card__side {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.card__warn {
  color: var(--st-run);
  font-size: var(--fs-micro);
  white-space: nowrap;
}

/* 右上角的操作：悬停 / 键盘聚焦时显形（平时藏起来，不遮描述也不添噪） */
.card__ops {
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.card:hover .card__ops,
.card:focus-within .card__ops {
  opacity: 1;
}

.card__ops :deep(.el-button + .el-button) {
  margin-left: 0;
}

.card__desc {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.card__desc--empty {
  color: var(--ink-3);
}
</style>
