<script setup lang="ts">
/**
 * 版本历史的弹层：一个技能在笔记仓库里的提交记录，可以看清差异再恢复。
 *
 * 历史是打开弹窗时现问 git 的（没有缓存的中间态）：弹窗开着的时候别人同步进来一版，
 * 关掉再开就能看到。
 *
 * 每一版有两条路：**「对比」**打开差异弹窗（那一版 vs 现在这一份，逐文件逐行看，
 * 底下那颗才是「恢复到这个版本」—— 恢复之前能看清会改掉什么），**「恢复」**是直接回去的
 * 快捷方式。两条路都会先确认，且恢复本身也是一次提交，现在的内容不会丢。
 */
import { computed, ref, watch } from 'vue'
import { SKILL_FILE, type SkillCommit, type SkillCompareFile } from '@shared/skills'
import { formatTimestamp } from '@/format'
import { confirmAction } from '@/notify'
import { useSkillsStore } from '@/stores/skills'
import SkillCompareDialog from '@/components/SkillCompareDialog.vue'

const props = defineProps<{ open: boolean; skillId: string; skillName: string }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const store = useSkillsStore()

const commits = ref<SkillCommit[]>([])
const loading = ref(false)
const error = ref('')
/** 正在恢复的那一版：按钮各自转圈，互不影响 */
const restoring = ref('')
/** 正在取哪一版的内容（对比要先把两侧的文件取回来，取回来才开弹窗） */
const comparing = ref('')

const compareOpen = ref(false)
const compareHash = ref('')
const compareRel = ref(SKILL_FILE)
const compareFiles = ref<SkillCompareFile[]>([])

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

watch(
  () => props.open,
  async (value) => {
    if (!value) return
    commits.value = []
    error.value = ''
    if (!props.skillId) return

    loading.value = true
    const result = await store.history(props.skillId)
    loading.value = false
    if (!result.ok || !result.data) {
      error.value = result.error ?? '读取版本历史失败'
      return
    }
    commits.value = result.data
  }
)

/**
 * 打开某一版的对比：先把「那一版 + 现在这一份」的全部文件取回来，取到了才开弹窗
 * （空壳弹窗比不打开更让人困惑）。默认停在 SKILL.md 上 —— 那一版改了什么，多半看它就够。
 */
async function openCompare(commit: SkillCommit): Promise<void> {
  comparing.value = commit.hash
  const files = await store.versionCompare(props.skillId, commit.hash)
  comparing.value = ''
  if (!files) return

  compareFiles.value = files
  compareRel.value = files.some((file) => file.rel === SKILL_FILE)
    ? SKILL_FILE
    : files[0]?.rel ?? SKILL_FILE
  compareHash.value = commit.hash
  compareOpen.value = true
}

/** 对比弹窗里恢复成功：技能内容已经变了，这一层（历史列表）也跟着收掉 */
function onRestored(): void {
  compareOpen.value = false
  visible.value = false
}

async function restoreTo(hash: string): Promise<void> {
  const confirmed = await confirmAction(
    '这个技能的文件会变回所选版本的样子。恢复本身也是一次提交，现在的内容留在历史里，随时能再恢复回来。',
    '恢复到这个版本？',
    { confirmButtonText: '恢复' }
  )
  if (!confirmed) return

  restoring.value = hash
  const restored = await store.restore(props.skillId, hash)
  restoring.value = ''
  if (restored) visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" :title="`版本历史 · ${skillName}`" width="560px" append-to-body>
    <div v-if="loading" class="state">正在读取版本历史…</div>
    <div v-else-if="error" class="state state--error">{{ error }}</div>
    <div v-else-if="!commits.length" class="state">
      还没有版本。保存过的每一版都会记在这里（前提是笔记文件夹是个 git 仓库 ——
      在设置里配好笔记仓库并同步一次就有了）。
    </div>
    <ul v-else class="commits">
      <li v-for="commit in commits" :key="commit.hash" class="commits__item">
        <div class="commits__main">
          <span class="commits__subject">{{ commit.subject }}</span>
          <span class="commits__time">{{ formatTimestamp(commit.time) }}</span>
        </div>
        <div class="commits__side">
          <span class="commits__hash mono" :title="commit.hash">{{ commit.hash.slice(0, 7) }}</span>
          <!-- 「对比」是恢复前那一步：先看清这一版到底会改掉什么，那颗按钮就在差异底下 -->
          <el-button
            size="small"
            text
            :loading="comparing === commit.hash"
            :disabled="Boolean(comparing) && comparing !== commit.hash"
            @click="openCompare(commit)"
          >
            对比
          </el-button>
          <el-button
            size="small"
            text
            :loading="restoring === commit.hash"
            :disabled="Boolean(restoring) && restoring !== commit.hash"
            @click="restoreTo(commit.hash)"
          >
            恢复
          </el-button>
        </div>
      </li>
    </ul>

    <!--
      某一版的对比弹窗：数据从 git 取（那一版的文件 + 工作区现在这份），
      底下那颗按钮是「恢复到这个版本」—— 恢复完两层弹窗一起收掉。
    -->
    <SkillCompareDialog
      v-model:open="compareOpen"
      mode="version"
      :skill-id="skillId"
      :skill-name="skillName"
      :version-hash="compareHash"
      :files="compareFiles"
      :initial-rel="compareRel"
      @restored="onRestored"
    />
  </el-dialog>
</template>

<style scoped>
.state {
  padding: var(--sp-5) 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.6;
}

.state--error {
  color: var(--st-fail);
}

.commits {
  margin: 0;
  padding: 0;
  max-height: 380px;
  overflow-y: auto;
  list-style: none;
}

.commits__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--border);
}

.commits__item:last-child {
  border-bottom: 0;
}

.commits__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.commits__subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-meta);
}

.commits__time {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.commits__side {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.commits__hash {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
