/**
 * 「草稿字段」：边打边存会把半截内容写进设置 / 配置（设置项落盘还会触发一轮
 * 收敛与回推，把光标顶走），所以本地先存着，失焦 / 回车时调用方再提交。
 *
 * 这份样板在 SettingsDialog（程序名 / 同步仓库 / 笔记图片仓库 / 天气城市）与
 * ProjectDrawer（项目名 / 监听端口）里各抄过一遍，收在这里。两个参数把两种用法
 * 统一成一条：**source 变化时（以及初始化时）把 read() 的结果抄进草稿** ——
 *   - 外部值本身就是字符串时（设置项），只给 source，read 缺省原样抄；
 *   - 草稿随「选中对象」重置时（抽屉里的项目），source 给对象的 id（它变了才算换对象），
 *     read 从当前对象里取要展示的值。
 *
 * 提交（相等即跳过、失败回退）留在调用方：各字段的收敛规则与后处理本来就不同。
 */
import { ref, watch, type Ref } from 'vue'

export function useDraftField(
  source: () => string,
  read: (value: string) => string = (value) => value
): Ref<string> {
  const draft = ref('')
  watch(
    source,
    (value) => {
      draft.value = read(value)
    },
    { immediate: true }
  )
  return draft
}
