<script setup lang="ts">
/**
 * 站内阅读弹层：把一条热点的原文正文抓下来，直接在应用里读。
 *
 * **为什么要有它**：热点源的 RSS 只给标题、作者与一句导语，
 * 正文得去原文页拿。以前点一条就跳系统浏览器 —— 读一条新闻要切出去再切回来，
 * 所以这里改成「应用内读」，把浏览器留给「要看原排版 / 图片」的情况。
 *
 * **取数归这个组件**：打开哪一条、什么时候抓，都由它自己负责（父组件只传 item 进来）。
 * 抓取与提取走适配层的 `loadAiNewsArticle`：Rust 按域名白名单抓原始 HTML，提取在 shared 里做。
 *
 * **抓不到就如实降级**：会员专属文、脚本动态渲染的页面都提不出正文。这时显示
 * 我们在 feed 里已有的东西（标题 / 来源 / 作者 / 时间 / 导语），并指路「在浏览器中打开」——
 * 而不是摆一个空白页或者转圈转到天荒地老。
 */
import { computed, ref, watch } from 'vue'
import { Refresh, TopRight } from '@element-plus/icons-vue'
import { formatTimestamp } from '@/format'
import type { AiNewsArticle, AiNewsItem } from '@/types'

const props = defineProps<{
  modelValue: boolean
  item: AiNewsItem | null
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const article = ref<AiNewsArticle | null>(null)
const loading = ref(false)
const error = ref('')

/** 打开时才抓：同一篇文章第二次打开就直接用上次的结果（列表里点来点去不该反复出网） */
const cachedUrl = ref('')

async function load(): Promise<void> {
  const item = props.item
  if (!item?.link) {
    error.value = '这条热点没有可打开的原文地址'
    return
  }
  if (cachedUrl.value === item.link && article.value) return

  loading.value = true
  error.value = ''
  article.value = null
  try {
    const result = await window.workbench.loadAiNewsArticle(item.link)
    if (result.ok && result.data) {
      article.value = result.data
      cachedUrl.value = item.link
    } else {
      error.value = result.error ?? '抓取原文失败'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '抓取原文失败'
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.item?.link] as const,
  ([open]) => {
    if (open) void load()
  },
  { immediate: true }
)

/** 关掉时把抓回来的正文丢掉：十篇文章留在内存里没意义，重开一次也不贵 */
function onClosed(): void {
  article.value = null
  error.value = ''
  cachedUrl.value = ''
  loading.value = false
}

/** 手动重试：清掉缓存再抓一次（上次可能是网络抖了一下） */
function retry(): void {
  cachedUrl.value = ''
  void load()
}

function openExternal(): void {
  if (props.item?.link) void window.workbench.openExternal(props.item.link)
}

/** 标题下面那行：来源 · 时间 · 原文域名 */
const meta = computed(() => {
  const item = props.item
  if (!item) return []
  const parts: string[] = []
  if (item.source) parts.push(item.source)
  if (item.pubDate) parts.push(formatTimestamp(item.pubDate))
  try {
    parts.push(new URL(item.link).hostname)
  } catch {
    // 地址解析不出来就不显示域名，没必要为它编一个
  }
  return parts
})

const paragraphs = computed(() => article.value?.paragraphs ?? [])
</script>

<template>
  <el-dialog
    v-model="visible"
    class="article-dialog"
    width="720"
    align-center
    append-to-body
    :title="item?.title ?? '热点详情'"
    @closed="onClosed"
  >
    <div class="article">
      <p v-if="meta.length" class="article__meta">
        <template v-for="(part, index) in meta" :key="part">
          <span v-if="index" class="article__dot" aria-hidden="true">·</span>{{ part }}
        </template>
      </p>

      <!-- 抓取中 -->
      <p v-if="loading" class="article__state">正在读取原文…</p>

      <!-- 抓不到：把我们已有的导语摆出来，并指路浏览器 -->
      <template v-else-if="error">
        <p v-if="item?.summary" class="article__lead">{{ item.summary }}</p>
        <p class="article__state article__state--warn">{{ error }}</p>
        <div class="article__actions">
          <el-button size="small" :icon="Refresh" @click="retry">重试</el-button>
          <el-button size="small" type="primary" :icon="TopRight" @click="openExternal">
            在浏览器中打开
          </el-button>
        </div>
      </template>

      <!-- 正文 -->
      <template v-else>
        <p v-for="(paragraph, index) in paragraphs" :key="index" class="article__para">
          {{ paragraph }}
        </p>
        <p v-if="article?.truncated" class="article__state article__state--warn">
          正文较长，这里只显示了一部分；完整内容请在浏览器中打开。
        </p>
      </template>
    </div>

    <template #footer>
      <div class="article__foot">
        <el-button size="small" :icon="TopRight" @click="openExternal">在浏览器中打开</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/*
 * 正文的行长：中文一行 35~40 字最好读，弹窗有 720 宽，直接铺满会拉到 60 字以上。
 * 所以给一个上限并居中 —— 两侧留白看着是有意为之，而不是内容没铺满。
 */
.article {
  max-width: 620px;
  margin: 0 auto;
}

.article__meta {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.article__dot {
  margin: 0 6px;
  color: var(--border-strong);
}

/* 导语：抓不到正文时它就是这段的全部内容，比正文稍大一点、颜色浅一档 */
.article__lead {
  margin: 0 0 var(--sp-3);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-body);
  line-height: 1.9;
  color: var(--ink-2);
}

.article__para {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-body);
  /* 中文长文行高给足：1.9 是读起来不累的那一档（与笔记正文同一口径） */
  line-height: 1.9;
  color: var(--ink-2);
}

.article__state {
  margin: var(--sp-4) 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.article__state--warn {
  color: var(--ink-2);
}

.article__actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.article__foot {
  display: flex;
  justify-content: flex-end;
}
</style>