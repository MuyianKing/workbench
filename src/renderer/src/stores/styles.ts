/**
 * 样式：74 套设计语言（DESIGN.md 的解析结果）的清单与筛选状态。
 *
 * **数据是随包的静态资源，不是通道也不是用户数据**：它放在 `src/renderer/public/design-styles.json`，
 * 页面第一次打开时按相对基址读一次（`import.meta.env.BASE_URL`，与 Vditor 资源同一条路），
 * 之后缓存在这里。所以这个 store 没有落盘、没有同步、也不该有 —— 它是一份只读的参考清单，
 * 用户改不了它，重启也不会多出状态。读的是自己包里的文件，不出网。
 *
 * 674 个颜色键、221 个字阶键、829 个组件键的中文标签由 `@shared/design-styles` 的规则现算，
 * 所以这里只存原始数据与筛选条件，不预先翻译一遍（译完再存反而多一份可能不一致的副本）。
 *
 * 筛选条件放在 store 而不是组件里，与项目页 / 密码页同一条口径：切走再切回来，
 * 搜索词与选中的档位还在（KeepAlive 本来就保住了组件状态，但两处都存会多一个真源）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  categoryCounts as countCategories,
  designStyleHaystack,
  familyCounts as countFamilies,
  filterDesignStyles,
  sanitizeDesignStyles,
  sortDesignStyles,
  type ColorFamily,
  type DesignStyle,
  type DesignStyleSort,
  type FamilyFilter,
  type ThemeFilter
} from '@shared/design-styles'

/** 随包数据的地址：用相对基址，`http://` 与 `tauri://` 两种运行方式下落到同一处 */
const DATA_URL = `${import.meta.env.BASE_URL}design-styles.json`

export const useStylesStore = defineStore('styles', () => {
  const styles = ref<DesignStyle[]>([])

  const loading = ref(false)
  /** 读成功过一次就不必再读：这份数据在运行期不会变 */
  const loaded = ref(false)
  const loadError = ref('')

  const query = ref('')
  const theme = ref<ThemeFilter>('all')
  const family = ref<FamilyFilter>('all')
  const category = ref('all')
  const sort = ref<DesignStyleSort>('az')

  /**
   * 关键词索引：把每套的品牌名、分类、字体、中文描述、每个 token 的键名与中文标签、色值
   * 拼成一串。建一次缓存住 —— 74 套 × 几十个 token，每敲一个字重算一遍没必要。
   */
  const haystacks = computed(() => {
    const map = new Map<string, string>()
    for (const style of styles.value) map.set(style.brand, designStyleHaystack(style))
    return map
  })

  /** 当前这一屏要画的卡片 */
  const visible = computed(() =>
    sortDesignStyles(
      filterDesignStyles(
        styles.value,
        {
          query: query.value,
          theme: theme.value,
          family: family.value,
          category: category.value
        },
        (style) => haystacks.value.get(style.brand) ?? ''
      ),
      sort.value
    )
  )

  /** 工具带上的计数：筛过之后剩几套 / 一共几套 */
  const summary = computed(() => {
    if (!styles.value.length) return ''
    if (visible.value.length === styles.value.length) return `${styles.value.length} 套设计`
    return `${visible.value.length} / ${styles.value.length} 套`
  })

  /** 有没有在筛：空态里要靠它区分「筛没了」与「读不出来」 */
  const filtering = computed(
    () =>
      Boolean(query.value.trim()) ||
      theme.value !== 'all' ||
      family.value !== 'all' ||
      category.value !== 'all'
  )

  /** 色系与分类的候选由数据现算，不铺空档 —— 点了没有任何结果的档位不该出现在界面上 */
  const families = computed(() => countFamilies(styles.value))
  const categories = computed(() => countCategories(styles.value))

  function resetFilters(): void {
    query.value = ''
    theme.value = 'all'
    family.value = 'all'
    category.value = 'all'
  }

  /**
   * 读随包数据。并发调用只会真的读一次（KeepAlive 下换页回来也会再调一次 init）。
   *
   * 失败时不弹提示：这是一个整页的面板，页面自己会画出「读不出来 + 重试」，
   * 再叠一个 toast 是同一句话说两遍。
   */
  async function init(): Promise<void> {
    if (loaded.value || loading.value) return
    loading.value = true
    loadError.value = ''
    try {
      const response = await fetch(DATA_URL)
      if (!response.ok) throw new Error(String(response.status))
      styles.value = sanitizeDesignStyles(await response.json())
      if (!styles.value.length) throw new Error('empty')
      loaded.value = true
    } catch (error) {
      loadError.value = error instanceof Error && error.message !== 'empty' ? error.message : ''
    } finally {
      loading.value = false
    }
  }

  function setTheme(next: ThemeFilter): void {
    theme.value = next
  }

  function setFamily(next: FamilyFilter): void {
    family.value = next
  }

  function setCategory(next: string): void {
    category.value = next
  }

  function setSort(next: DesignStyleSort): void {
    sort.value = next
  }

  return {
    styles,
    loading,
    loaded,
    loadError,
    query,
    theme,
    family,
    category,
    sort,
    visible,
    summary,
    filtering,
    families,
    categories,
    init,
    resetFilters,
    setTheme,
    setFamily,
    setCategory,
    setSort
  }
})

export type { ColorFamily }
