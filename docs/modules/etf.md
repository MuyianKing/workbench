# ETF 资金流（etf）

导航「ETF」页：追踪 23 只「国家队」（中央汇金）重仓宽基 ETF 的**每日净申赎** —— KPI 窗口卡、近 21 交易日柱状图、
总规模曲线（**默认近一年**，下方概览条可拖：平移窗口 / 两侧把手改宽度，头部有近 1 年 / 近 3 年 / 全部快捷档）、
分品种表（**默认近一月降序、表头各列可点排序**）、按指数归集表与最近 10 日明细矩阵。图表悬停统一走
`composables/use-plot-hover` + `EtfPlotTip` 浮卡。数据来自沪深交易所的份额披露与天天基金的净值，缓存在本机；开了同步
另有一份副本在用户自己的仓库里，供别的机器复用。

## 约束

- **口径是「全体持有人净申赎」，不是汇金的实际买卖**：净买卖 =（当日份额 − 上一有数据日份额）× 当日单位净值，正 = 净申购、
  负 = 净赎回。份额变化混着所有投资者（汇金、保险、量化、散户）与做市商对冲盘，只有数百亿级的极端日才大概率是国家队行为。
  页头「23 只宽基 · 全体持有人净申赎」是全页唯一口径说明，原理性解释（折算置零、共同交易日这些）只写本文件，不上界面。
- **名单是静态锚**：23 只来自汇金 2025 年报披露的主要宽基持仓（沪 15 + 深 8），定义在
  [packages/etf/src/etf.ts](../../packages/etf/src/etf.ts) 的 `ETF_TARGETS`。汇金换战场（买名单外品种、或 2026 年 1 月
  那类大幅减持之后）不会自动跟，要换名单只改那一个常量；解析与收敛都按 `etfTargetOf` 过滤，名单外代码进不了缓存。
- **联网边界（第十三条出口，三个主机、全部只读 GET、不发用户内容）**：沪市份额 **上交所**（`query.sse.com.cn`，单日一份）、
  深市份额 **深交所**（`www.szse.cn`，按基金代码过滤、区间批量、分页）、单位净值 **天天基金**（`fund.eastmoney.com`，每只
  一份全历史脚本）。主机白名单钉死在 [etf.rs](../../apps/desktop/src-tauri/src/etf.rs) 的常量里，渲染层只给得出日期 / 基金
  代码 / 页码（形状入地址前逐一校验），拼不出任意 URL。
  **深市那一路有明文退路**（全项目唯一一处 http）：HTTPS 拿不到响应时只把协议换成 `http://`、主机与全部参数原样重发一次 ——
  深交所会对回填到几百个请求后的出口 IP 在 TLS 层直接断连（握手成功、不给 HTTP 响应，WinHTTP 报 12152，2026-11 实测同路径
  http 照常 200）。同一份公开只读 JSON、不带凭据、不发用户内容；沪市与净值两路仍只走 HTTPS，别把这条退路搬到别处。
  **进 ETF 页（或点「刷新」）才出网**，没有定时器、没有后台轮询。开同步时同一趟还连**你自己的同步仓库**（git 推拉，登记在
  用量同步那条出口里，不新增主机 / 出口），先拉别人的缓存再规划缺口。端点教训（2026-10 实测）：净值脚本路径**没有 `/js/`
  段**（`/pingzhongdata/js/{code}.js` 301 到 notfound）。
- **首次回填五年、断点续传**：沪市按交易日逐日拉（约 1250 个请求），进度记在缓存的 `sseDone`（推进到的日期，含）；深市按
  「区间 × 标的」拉 —— 报表的代码过滤 `txtDm` 只认单个代码，一页 20 个交易日，五年前后合计五六百个请求（不按代码过滤是翻
  全市场，一天 39 页、要几万个）；一个区间内八只全收齐才合并（半批合并会留洞）；净值是全历史一份，超过 5 天没更新才重拉，
  日常刷新零请求。中途关掉应用不丢已完成的部分（每阶段结束落一次盘，阶段内中断的话这段下次从头再拉）；页面在回填期间每秒
  重读一次缓存，阶段结束就换成新数据。
- **沪市空日只跳「早已过去的」**：工作日拉回是空、且已隔两天以上 → 法定节假日，推进；今天 / 昨天的空多半还没发布，停在原地
  等下次刷新。网络失败同样停在原地（带 2 次重试），断点续传靠这个「停在原地」。
- **展示日 = 沪深两市都有份额数据的日期**：一边还在回填时，没覆盖到的日子不进序列（半截的「全表净买卖」比没有更误导），
  展示截止日因此总是两市的共同交易日。
- **份额折算 / 合并不算净买卖**：份额等比骤变（>30%）且净值反向联动（乘积≈1）时置 0，判定只在
  [packages/etf/src/etf.ts](../../packages/etf/src/etf.ts) 的 `buildOverview` 一处。
- **彩色例外（本页唯一）**：净买入红 / 净卖出绿，色相取 `--st-fail`（红）与 `--st-ok`（绿），A 股红涨绿跌惯例；总规模曲线
  走中性灰（`--ink-2` / `--ink-3`）。**主题色只进一处**：总规模概览条的可拖亮窗（主色浅纱 + 主色描边、悬停加深 —— 交互控件，
  「当前看哪段」的标记，与导航栏当前项同口径；没配主题色时主色是中性灰，整条照旧灰阶）。数字列等宽（`--font-mono`）。
- **本机缓存是权威，同步只是给别的机器复用的副本**：`data\etf.json`（JsonStore，约 1.5MB）仍是本机唯一读写落点；开同步
  （登录 + 设置里填了仓库地址，与用量同步同一个门禁）时另推 `etf/<设备id>.json` 进同一个 `token-sync` 克隆 —— 每台机器只写
  自己那份（单写者），读时跳过本机那份、把别的机器的并进本机。合并口径只在
  [etf.ts](../../packages/etf/src/etf.ts) 的 `mergeEtfCacheInto`：份额 / 净值逐日取并集（**本机已有的值不改**），`sseDone`
  取较晚的。于是**一台机器跑完五年回填，其他机器进页面直接复用**：合并完再规划缺口，这一轮不再向交易所要同一批日期。进页面 /
  点刷新时先拉后推各一次 git（同一个克隆、走 `sync::lock_workflow`），三个行情主机没有新增请求；没登录或没填地址时完全只读
  本机。磁盘读回收敛（`sanitizeEtfCache`）：坏日期、坏数值、名单外的代码一律丢 —— **远端那份也过同一道**，坏文件只是被跳过。
- **图表全手写，不引图表库**：柱状图一排 div（与网关用量页同一套画法，零线居中、正负各占半区）；折线是总规模曲线那张 SVG
  数据图（`preserveAspectRatio="none"` 拉通整宽 + `vector-effect="non-scaling-stroke"`，缺日断开成多段）。悬停只有柱子的
  原生 `title`。
- **取数编排在适配层、口径计算在域包**：[workbench/etf.ts](../../apps/desktop/src/renderer/src/workbench/etf.ts) 只做「读缓存
  → 规划缺口 → 拉取 → 合并 → 落盘 → 出视图」，一切解析 / 合并 / 窗口计算在 `@workbench/etf`（有单测、改口径走热更新）；
  Rust 侧（`etf.rs`）只取原文，JSON 一律不解析 —— 与天气 / AI 热点同一职责分界。

## 实现

**涉及文件**

- `packages/etf/src/etf.ts` —— 纯逻辑：`ETF_TARGETS` 名单、三个源解析（`parseSseShares` / `parseSzseShares` /
  `parseNavScript`）、缓存收敛与合并（本日增量 `mergeSharesInto` / `mergeNavInto`、跨机 `mergeEtfCacheInto`）、回填规划
  （`planSseDates` / `planSzseRanges` / `isStaleEmptyDate`）、净买卖与聚合（`buildOverview`）、展示格式（`formatYi` 一族）
- `packages/etf/src/etf.test.ts` —— 上列全部的单测
- `apps/desktop/src-tauri/src/etf.rs` —— 三个只读源的白名单与拉取命令（`etf_fetch_sse` / `etf_fetch_szse` /
  `etf_fetch_nav`）+ `etf_load` / `etf_save`（JsonStore）
- `apps/desktop/src-tauri/src/commands.rs` —— `etf_sync_pull`（刷新克隆 + 读别人的缓存）与 `etf_sync_publish`（写
  `etf/<设备id>.json` 并推送），转发给 `sync.rs`
- `apps/desktop/src-tauri/src/sync.rs` —— `publish_at` 的 ETF 一路（`etf/` 目录）、`read_etf_shards`
- `apps/desktop/src-tauri/src/paths.rs` —— `etf_file()`（`data\etf.json`）、`ETF_SYNC_DIR`（`etf/`）
- `apps/desktop/src/renderer/src/workbench/etf.ts` —— 适配层编排（`loadEtfOverview` 只读缓存、`refreshEtf` 增量刷新、
  `pullEtfCache` / `publishEtfCache` 跨机复用）、进度回调
- `components/etf/` —— `EtfView.vue`（页壳与编排：刷新前先拉别人的缓存、刷新后推本机那份，照网关页的 KeepAlive 进入模式）、
  `EtfSummaryCards` / `EtfFlowPanel` / `EtfScalePanel` / `EtfHoldingsPanel` / `EtfCategoryPanel` / `EtfMatrixPanel`
  （子组件一律 props 收数据）。面板标题与 KPI 卡标签配 `@element-plus/icons-vue` 小图标（面板标题那套外壳规则在 global.css 的
  `.panel__head h3`：14px、`--ink-3` 弱墨色，不抢数值的戏）。**分品种表是页里唯一的弹性块**（`.etf-grow`，`flex: 1 1 auto`）：
  窗口富余时吃掉剩余高度、表内滚动，窗口太矮时保 560px 下限（面板头 + 表头 + 十来行可见），再多由整页滚动兜
- `packages/appearance/src/views.ts` + `components/NavRail.vue` + `App.vue` —— 页面注册（`etf`）

**数据源端点**（钉死在 `etf.rs`，改参数先看那边有没有校验）

| 源 | 主机 | 形状 | 单位换算 |
| --- | --- | --- | --- |
| 沪市份额 | `query.sse.com.cn` | `commonQuery.do`，`sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`，`STAT_DATE` 单日 | `TOT_VOL`（万份）× 10000 = 份 |
| 深市份额 | `www.szse.cn` | `/api/report/ShowReport/data`，`CATALOGID=scsj_fund_jjgm`、`jjlb=ETF`、`txtDm` 单只代码、`PAGENO` 翻页 | 「基金规模(万份)」剥千分位 × 10000 = 份 |
| 单位净值 | `fund.eastmoney.com` | `/pingzhongdata/{code}.js`（**无 `/js/` 段**），摘 `Data_netWorthTrend`（`x` 毫秒 → 东八区折日期） | `y` 即元 |

两处交易所接口都要浏览器样子的 `Referer`（钉死在常量里）。深市 JSON 现在的行键是英文（`size_date` / `fund_code` /
`current_size`），解析中英文两套都认 —— 列名漂移不至于整页失明；`current_size` 的单位是**万份**（列名「基金规模(万份)」，
159919 一天是 `998,751.66`），带「份」字样的旧键不换算。分页数从 Sheet 顶层或 `metadata` 里认（现在是后者）；**一页里没有
目标代码不算空页**，只有回包 0 行才收尾（8 只深市标的都排在代码表末尾，按页数翻才能走到它们那一页）。

**缓存结构**（`data\etf.json`，`EtfCache`）

`shares`：交易日 → 代码 → 份额（份）；`nav`：代码 → 日期 → 净值；`sseDone`：沪市回填推进到的日期。日期一律 `YYYYMMDD`，
金额用元算、展示才折亿。旧版缓存里带过的中证全指 `index` 块（对照折线，已去掉）读回时直接丢、下次落盘自然清掉。

**刷新节奏**

进页面（`onActivated`，KeepAlive 首次 mounted+activated 用闸去重）→ 先读缓存上屏 → **开同步时先 `etf_sync_pull` 把别的机器
的缓存并进来**（这一下会 pull 一次克隆）→ 后台 `refreshEtf`：净值（过期才拉）→ 深市（区间 × 标的，逐页）→ 沪市（逐日），
两处交易所的请求之间都留 150ms → 同步可用时再 `etf_sync_publish` 把本机这份推回去。没有自动轮询：份额数据一天只发一次
（T 日晚间，深交所页面还写着「T 日晚间更新的 T 日规模仅供参考，以 T+1 日早间更新的 T 日规模为准」），净值也是盘后陆续披露，
**盘中刷新只会拿到上一交易日**，靠每次进页面 / 手动刷新补缺就够。同步失败只在该页那行提示里说一句（与取数失败同一种待遇），
已经上屏的数据不受影响。
