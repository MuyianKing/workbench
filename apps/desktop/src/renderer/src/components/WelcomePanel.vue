<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
/**
 * 一个项目都还没有时的项目页：上手三步 + 添加项目。
 *
 * 原来这里只有一个居中的「添加项目」按钮，整屏都是空的。
 */
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

const steps = [
  {
    no: '01',
    title: '添加项目目录',
    desc: '选一个已有的前端工程，Workbench 只记住列表与配置，不动工程里任何文件。',
  },
  {
    no: '02',
    title: '自动识别',
    desc: '读取 package.json：框架、版本、全部 scripts，以及锁文件对应的包管理器。',
  },
  {
    no: '03',
    title: '一键执行',
    desc: '装依赖 / 启动 dev server / 打包，输出在底部终端面板里实时可见，随时可停。',
  },
]
</script>

<template>
  <section class="welcome">
    <article class="panel hero">
      <span class="hero__deco" aria-hidden="true">
        <span class="hero__watermark mono">&rsaquo;_</span>
      </span>

      <div class="hero__head">
        <span class="hero__mark mono" aria-hidden="true">&rsaquo;_</span>
        <div class="hero__lead">
          <span class="eyebrow">开始使用</span>
          <h1 class="hero__title">
            把前端项目的日常收进一个窗口
          </h1>
          <p class="hero__desc">
            打开终端 → cd 到项目 → 选包管理器 → <span class="mono">npm run serve</span>，
            这套动作在这里就是一次点击。
          </p>
        </div>
      </div>

      <div class="hero__action">
        <el-button type="primary" :icon="Plus" @click="store.openAddDialog()">
          添加项目
        </el-button>
        <span class="hero__note">纯本地工具，不联网、不上报任何数据。</span>
      </div>

      <ol class="steps">
        <li v-for="step in steps" :key="step.no" class="step">
          <b class="step__no mono">{{ step.no }}</b>
          <div class="step__body">
            <h3 class="step__title">
              {{ step.title }}
            </h3>
            <p class="step__desc">
              {{ step.desc }}
            </p>
          </div>
        </li>
      </ol>
    </article>
  </section>
</template>

<style scoped>
.welcome {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 420px;
}

/* ---------- 左侧：上手三步 ---------- */
.hero {
  gap: var(--sp-5);
  /* 面板默认 overflow: hidden，这里内容可能超出，要能滚 */
  overflow-y: auto;
}

/**
 * 右下角那张几乎看不见的 `›_`：空状态也要有点体量，不然整块白板。
 * 外面套一层 inset:0 + overflow:hidden 是因为面板本身可滚动，
 * 让水印直接把 overflow 撑出来的话会平白多一条滚动条。
 */
.hero__deco {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.hero__watermark {
  position: absolute;
  right: -18px;
  bottom: -52px;
  font-size: 172px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.07em;
  color: var(--ink);
  opacity: 0.035;
  user-select: none;
}

.hero__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-4);
}

.hero__mark {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: var(--r-md);
  background: var(--ink);
  color: var(--ink-inverse);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.06em;
  padding-bottom: 2px;
}

.hero__lead {
  min-width: 0;
}

.hero__title {
  margin-top: 2px;
  font-size: var(--fs-display);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.hero__desc {
  margin-top: var(--sp-2);
  max-width: 46ch;
  font-size: var(--fs-body);
  line-height: 1.75;
  color: var(--ink-3);
}

.hero__action {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.hero__note {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.steps {
  display: flex;
  flex-direction: column;
  /* 面板高出来的一截平摊给三步，窗口越高越舒展 */
  flex: 1 1 auto;
  min-height: 0;
}

.step {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: 1 0 auto;
  padding: var(--sp-4) 0;
}

.step + .step {
  border-top: 1px dashed var(--border);
}

.step__no {
  flex-shrink: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-3);
}

.step__title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.step__desc {
  margin-top: 3px;
  font-size: var(--fs-meta);
  line-height: 1.7;
  color: var(--ink-3);
}
</style>
