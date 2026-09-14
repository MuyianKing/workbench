<script setup lang="ts">
/**
 * 一个项目都还没有时的首页。
 *
 * 原来这里只有一个居中的「添加项目」按钮，整屏都是空的。现在左边是上手三步，
 * 右边是本机环境与快捷操作——第一次打开就能看清这个应用会替你做哪些事。
 */
import { computed } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { buildHints } from '@/hints'
import { PACKAGE_MANAGERS, VERSIONS_FALLBACK, type PackageManagerKey } from '@/managers'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

const versions = window.workbench?.versions ?? VERSIONS_FALLBACK

const managers = PACKAGE_MANAGERS

function available(key: PackageManagerKey): boolean {
  return store.packageManagers?.[key] ?? false
}

const steps = [
  {
    no: '01',
    title: '添加项目目录',
    desc: '选一个已有的前端工程，Workbench 只记住列表与配置，不动工程里任何文件。'
  },
  {
    no: '02',
    title: '自动识别',
    desc: '读取 package.json：框架、版本、全部 scripts，以及锁文件对应的包管理器。'
  },
  {
    no: '03',
    title: '一键执行',
    desc: '装依赖 / 启动 dev server / 打包，输出在底部终端面板里实时可见，随时可停。'
  }
]

const hints = computed(() => buildHints(store.settings))
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
          <h1 class="hero__title">把前端项目的日常收进一个窗口</h1>
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
            <h3 class="step__title">{{ step.title }}</h3>
            <p class="step__desc">{{ step.desc }}</p>
          </div>
        </li>
      </ol>
    </article>

    <div class="side">
      <article class="panel">
        <header class="panel__head">
          <span class="eyebrow">运行环境</span>
        </header>

        <dl class="facts">
          <div class="fact">
            <dt>node</dt>
            <dd class="mono">{{ store.packageManagers?.node || '未检测到' }}</dd>
          </div>
          <div class="fact">
            <dt>chromium</dt>
            <dd class="mono">{{ versions.chrome }}</dd>
          </div>
        </dl>

        <div class="panel__foot">
          <span class="eyebrow">包管理器</span>
          <span class="pms">
            <span
              v-for="m in managers"
              :key="m.key"
              class="pm"
              :title="available(m.key) ? `${m.label} 可用` : `${m.label} 未安装`"
            >
              <i class="pm__dot" :class="available(m.key) ? 'is-ok' : 'is-off'" aria-hidden="true" />
              {{ m.label }}
            </span>
          </span>
        </div>
      </article>

      <article class="panel">
        <header class="panel__head">
          <span class="eyebrow">快捷操作</span>
        </header>

        <ul class="tips">
          <li v-for="item in hints" :key="item.text" class="tip">
            <span class="tip__text truncate" :title="item.text">{{ item.text }}</span>
            <kbd class="tip__key mono">{{ item.hint }}</kbd>
          </li>
        </ul>

        <p class="side__note">主题、托盘、开机自启在右上角的设置里。</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.welcome {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(272px, 0.7fr);
  gap: 14px;
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

/* ---------- 右侧：环境 + 快捷操作 ---------- */
.side {
  display: grid;
  /* 两张面板都按内容高度，贴顶排列——原来第二行用 1fr 撑满，
     内容不够高时多出来的高度只能堆在面板里，显得上下不匀 */
  grid-template-rows: auto auto;
  align-content: start;
  gap: 14px;
  min-height: 0;
}

.panel__foot .pms {
  margin-left: auto;
}

.side__note {
  /* 说明是列表的补充；和「快捷操作」面板的 .tips__note 保持同一套层次处理：
     实线把它划到列表外面（行间是虚线），线上 4px 贴住最后一条提示，
     上内距 10px、下内距 0 */
  margin-top: calc(var(--sp-3) * -1 + 4px);
  padding: calc(var(--sp-2) + 2px) 0 0;
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 窗口窄到摆不下两栏时堆起来，不要让文字被挤成一条 */
@media (max-width: 960px) {
  .welcome {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
  }

  .side {
    grid-template-rows: auto auto;
  }
}
</style>
