<script setup lang="ts">
import { FolderOpened } from '@element-plus/icons-vue'
import { accountLabel } from '@workbench/auth'
import { ElMessage } from 'element-plus'
/**
 * 设置 · 关于：这个应用是什么、数据住在哪、什么时候才会联网。
 *
 * 全是「如实说明」那一套 —— 没有宣传语，也没有一个数字是编出来的。
 * 这里不做第二份可编辑入口：账号与同步仓库都在「通用」那一屏，这一屏只读地摆出当前值。
 *
 * 版本号在第一次切到这一屏时向后端要一次（它不会变，取到就不再问）；
 * 数据目录那一行显示的是环境探测的结果。
 */
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useEnvironmentStore } from '@/stores/environment'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{ open: boolean, active: boolean }>()

const settings = useSettingsStore()
const environment = useEnvironmentStore()
const auth = useAuthStore()

const account = computed(() => auth.status?.account ?? null)

/** 版本号的占位：取不到时如实显示，而不是编一个号出来 */
const APP_VERSION_PENDING = '读取中…'

const appVersion = ref(APP_VERSION_PENDING)

async function loadAppVersion(): Promise<void> {
  try {
    appVersion.value = await window.workbench.getAppVersion()
  }
  catch {
    // 拿不到版本不该让这一屏打不开，如实说明即可
    appVersion.value = '未知'
  }
}

// 第一次切到这一屏时取版本号；取到一次就够（它不会变），之后不再问
watch(
  () => props.open && props.active,
  (current) => {
    if (current && appVersion.value === APP_VERSION_PENDING)
      void loadAppVersion()
  },
)

/** 打开数据目录：与项目卡那颗「打开目录」同一条通道，失败时把原因说出来 */
async function openDataDir(): Promise<void> {
  const dir = environment.dataDir
  if (!dir)
    return

  const result = await window.workbench.reveal(dir)
  if (!result.ok)
    ElMessage.error(result.error ?? '打开目录失败')
}

/**
 * 联网边界：**这个应用默认不联网**，出口只有这几处，且都由用户自己开出来
 * （与架构文档「数据与隐私」那一节同源 —— 改了一边就要改另一边）。
 */
const networkBounds: Array<{ title: string, detail: string }> = [
  {
    title: '同步仓库（Token 用量 / 外观 / 密码保险库）',
    detail:
      '默认关闭：要在设置里登录账号并填一个你自己的 git 仓库，才会推拉那个仓库。密码保险库也走它（vault/vault.json），推上去的只有密文。',
  },
  {
    title: '账号登录',
    detail: '点登录时才会去 GitHub / Gitee 的授权接口；登录之后不会在后台反复打请求。',
  },
  {
    title: '笔记里的图片',
    detail: '只有填了图片仓库、并且你真的往正文里粘贴了图片（或删图），才会碰那个仓库。',
  },
  {
    title: '笔记本身的同步',
    detail: '只有填了笔记仓库、并且你点了那颗同步按钮，才会走一次 git。',
  },
  {
    title: '命令执行',
    detail: 'npm install、dev server 这些是你自己那条命令在上网，不属于应用的行为。',
  },
  {
    title: 'AI 热点',
    detail:
      '首页画着「AI 热点」卡片时才会去 GET 它，且要到了那个源自己的刷新间隔（地址是内置白名单，只放中文源），只读不传任何数据。',
  },
  {
    title: '实时天气',
    detail:
      '只有设置里填了天气城市才会去取（每半小时一次），地址是内置白名单里的两台主机 —— 城市名检索走 OpenStreetMap 的公开接口、实况走 Open-Meteo，都免费且只读；城市名会出现在请求里。',
  },
  {
    title: '邮箱',
    detail:
      '只有邮箱页里配置了邮箱账户才会连你填的收发服务器（IMAP 收信、SMTP 发信，隐式 TLS，主机不设白名单）；授权码在 Windows 凭据管理器里，不落明文；邮件正文里的外链资源一概不加载 —— 不做后台收信，进页面、点刷新或发信才联网。',
  },
]
</script>

<template>
  <section class="pane">
    <div class="block">
      <h3 class="block__title">
        程序
      </h3>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">{{ settings.settings.appName }}</span>
          <span class="row__hint">
            版本 <span class="mono">{{ appVersion }}</span> ·
            Windows 桌面应用（Tauri 2 + WebView2）
          </span>
        </div>
      </div>
    </div>

    <div class="block">
      <h3 class="block__title">
        这台机器上的数据
      </h3>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">数据目录</span>
          <span class="row__hint">
            项目列表、设置、用量快照、工作日志与密码保险库都在这里；位置固定，不跟着任何设置走。
            保险库那份 <span class="mono">vault.json</span> 里只有密文，密钥在 Windows 凭据管理器里。
          </span>
        </div>
        <div class="path__actions">
          <p class="path mono truncate" :title="environment.dataDir">
            {{ environment.dataDir || '读取中…' }}
          </p>
          <el-button
            size="small"
            :icon="FolderOpened"
            :disabled="!environment.dataDir"
            @click="openDataDir"
          >
            打开目录
          </el-button>
        </div>
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">登录状态</span>
          <span class="row__hint">
            登录只为授权同步私有仓库；access_token 存在 Windows 凭据管理器里，不落数据文件。
          </span>
        </div>
        <span v-if="account" class="about__account">
          <el-avatar :size="22" :src="account.avatar ?? undefined" />
          <span class="truncate">{{ accountLabel(account) }}</span>
        </span>
        <span v-else class="row__hint">未登录</span>
      </div>
    </div>

    <!--
      联网边界：把「默认不联网」这句承诺连出口一起摊开，用户不必翻文档就知道这个程序会往哪儿发东西。
      只有这五处，且都是显式开出来的 —— 这里写的与架构文档「数据与隐私」是同一份事实。
    -->
    <div class="block">
      <h3 class="block__title">
        联网
      </h3>

      <p class="about__lead">
        默认不联网、不上报任何数据。对外发请求的只有下面七处，且都由你自己开出来：
      </p>

      <ul class="bounds">
        <li v-for="item in networkBounds" :key="item.title" class="bounds__item">
          <span class="bounds__title">{{ item.title }}</span>
          <span class="bounds__detail">{{ item.detail }}</span>
        </li>
      </ul>

      <p class="about__lead">
        七处都没有自建服务端：三处 git 同步发往你自己填的那三个仓库，账号登录走两家平台官方的
        OAuth 接口，AI 热点只 GET 内置白名单里的那个公开源（源站自己的域名），天气只 GET
        两台白名单主机（城市名检索走 OpenStreetMap 的公开接口、实况走 Open-Meteo），
        发出去的只有你填的城市名。
        笔记页带文档级的 no-referrer，打开的笔记不会把自己的来源地址送给图片服务器。
      </p>
    </div>
  </section>
</template>

<style scoped>
/* ---------- 数据位置 ---------- */
/* 路径与旁边那颗按钮同一行：路径占满剩下的宽度并自己截断，min-width 是截断生效的前提 */
.path {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.path__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

/* ---------- 关于 ---------- */
/* 说明性段落：比 .row__hint 略大一点，因为它不是某一行的小字，而是这一块自己的正文 */
.about__lead {
  margin: 0;
  font-size: var(--fs-meta);
  line-height: 1.75;
  color: var(--ink-2);
}

/*
 * 「联网」那一块里是「说明 → 清单 → 说明」三段平级的内容，而 `.block` **不是** flex 容器
 * （只有 .pane 有 gap）—— 三段的 margin 又都被上面清成了 0，于是它们贴在一起：
 * 段与段之间没有任何空隙，清单的第一个出口像是上一句话的一部分（截图里一眼能看出来）。
 * 间距自己补，取 --sp-4：比标题下的 --sp-3 松一点，三段之间的呼吸才够。
 */
.about__lead + .bounds,
.bounds + .about__lead {
  margin-top: var(--sp-4);
}

/* 一个出口一条：上面是名字，下面一行说清它什么时候才会被走到 */
.bounds {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.bounds__item {
  padding-left: var(--sp-3);
  /* 左边一道细线代替项目符号：五条并排的圆点读起来像待办 */
  border-left: 2px solid var(--border);
}

.bounds__title {
  display: block;
  font-size: var(--fs-meta);
  color: var(--ink);
}

.bounds__detail {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--ink-3);
}

.about__account {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
  max-width: 180px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}
</style>
