<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Close, Plus } from '@element-plus/icons-vue'
import { moveToPosition } from '@shared/reorder'
import { DRAG_MIME } from '@/drag-mime'
import { useProjectsStore } from '@/stores/projects'
import type { ProjectGroup } from '@/types'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const store = useProjectsStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const newName = ref('')
/** 正在改名的分组 id 与草稿：双击标签进入，回车/失焦提交，Esc 取消 */
const editingId = ref<string | null>(null)
const editingName = ref('')
/** 正在拖动的分组、以及当前悬停的落点；和筛选栏一样，拖动 = 调整顺序 */
const draggingId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    newName.value = ''
    editingId.value = null
    editingName.value = ''
    draggingId.value = null
    dragOverId.value = null
  },
  { immediate: true }
)

function countOf(groupId: string): number {
  return store.projects.filter((p) => p.groupId === groupId).length
}

/** 双击进入编辑后把焦点落到输入框（el-input 暴露 focus()） */
function focusEdit(el: unknown): void {
  if (!el) return
  const instance = el as { focus?: () => void; input?: HTMLInputElement }
  if (typeof instance.focus === 'function') instance.focus()
  else instance.input?.focus()
}

/** 焦点由模板上的 :ref="focusEdit" 回调负责，这里只需要进入编辑态 */
function startEdit(group: ProjectGroup): void {
  editingId.value = group.id
  editingName.value = group.name
}

function cancelEdit(): void {
  editingId.value = null
  editingName.value = ''
}

async function commitEdit(group: ProjectGroup): Promise<void> {
  if (editingId.value !== group.id) return // 已被 Esc 取消

  const next = editingName.value.trim()
  editingId.value = null
  editingName.value = ''
  if (!next || next === group.name) return

  await store.renameGroup(group.id, next)
}

async function create(): Promise<void> {
  const name = newName.value.trim()
  if (!name) {
    ElMessage.warning('请输入分组名称')
    return
  }
  if (await store.createGroup(name)) newName.value = ''
}

async function remove(group: ProjectGroup): Promise<void> {
  const count = countOf(group.id)
  try {
    await ElMessageBox.confirm(
      count
        ? `「${group.name}」下有 ${count} 个项目，删除分组后它们会变为未分组，项目本身不受影响。`
        : `确定删除分组「${group.name}」？`,
      '删除分组',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return // 用户取消
  }

  if (editingId.value === group.id) cancelEdit()
  await store.removeGroup(group.id)
}

// ---------- 拖动排序：与筛选栏同一套交互，落盘也走同一个 store 方法 ----------

function onDragStart(group: ProjectGroup, event: DragEvent): void {
  if (!event.dataTransfer) return
  draggingId.value = group.id
  dragOverId.value = null
  event.dataTransfer.setData(DRAG_MIME.group, group.id)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(group: ProjectGroup, event: DragEvent): void {
  // 只认自己发起的拖动：别的东西（文件、项目卡片）拖进来不该被当成排序落点
  if (!draggingId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverId.value = group.id
}

function onDragLeave(group: ProjectGroup): void {
  if (dragOverId.value === group.id) dragOverId.value = null
}

function onDragEnd(): void {
  draggingId.value = null
  dragOverId.value = null
}

async function onDrop(group: ProjectGroup, event: DragEvent): Promise<void> {
  const fromId =
    draggingId.value ?? event.dataTransfer?.getData(DRAG_MIME.group) ?? ''
  draggingId.value = null
  dragOverId.value = null
  if (!fromId) return

  const next = moveToPosition(
    store.sortedGroups.map((g) => g.id),
    fromId,
    group.id
  )
  if (next) await store.reorderGroups(next)
}
</script>

<template>
  <!-- append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节） -->
  <el-dialog v-model="visible" title="管理分组" width="480" align-center append-to-body>
    <div class="groups">
      <div v-if="store.sortedGroups.length" class="tags">
        <template v-for="group in store.sortedGroups" :key="group.id">
          <el-input
            v-if="editingId === group.id"
            :ref="focusEdit"
            v-model="editingName"
            class="tag-edit"
            maxlength="30"
            spellcheck="false"
            @blur="commitEdit(group)"
            @keydown.enter.prevent="commitEdit(group)"
            @keydown.esc="cancelEdit"
          />

          <el-tag
            v-else
            class="tag"
            :class="{
              'is-drop': dragOverId === group.id && draggingId !== group.id,
              'is-dragging': draggingId === group.id
            }"
            size="large"
            disable-transitions
            draggable="true"
            title="拖动可调整顺序"
            @dragstart="onDragStart(group, $event)"
            @dragover="onDragOver(group, $event)"
            @dragleave="onDragLeave(group)"
            @drop="onDrop(group, $event)"
            @dragend="onDragEnd"
          >
            <span class="tag__name" title="双击改名" @dblclick="startEdit(group)">
              {{ group.name }}
            </span>
            <span class="tag__count mono">{{ countOf(group.id) }}</span>
            <el-icon class="tag__del" title="删除分组" @click.stop="remove(group)">
              <Close />
            </el-icon>
          </el-tag>
        </template>
      </div>

      <p v-if="!store.sortedGroups.length" class="empty">
        还没有分组。分组用于把项目归类，并在顶部筛选栏按组过滤。
      </p>
      <p v-else class="hint">双击分组改名，悬停标签可删除；拖动标签可调整顺序。</p>

      <div class="create">
        <el-input
          v-model="newName"
          placeholder="新分组名称"
          maxlength="30"
          spellcheck="false"
          @keydown.enter="create"
        />
        <el-button type="primary" :icon="Plus" @click="create">添加</el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/* ---------- 分组标签：黑底白字，与筛选栏选中态同一套视觉语言 ---------- */
.tag.tag {
  height: 32px;
  padding: 0 10px;
  border-color: var(--ink);
  background: var(--ink);
  color: var(--ink-inverse);
}

/* 不加 gap：间距由各元素自己控制，删除键隐藏时才不会留下空档 */
.tag.tag :deep(.el-tag__content) {
  display: inline-flex;
  align-items: center;
}

.tag__name {
  font-size: var(--fs-body);
  font-weight: 500;
  /* 双击改名时不要连带选中文字 */
  user-select: none;
  /* 继承标签的 grab / grabbing，让整块都能拖 */
  cursor: inherit;
}

/* 拖动排序：整块标签可拖，指针要给出「能拖动」的暗示 */
.tag.tag[draggable='true'] {
  cursor: grab;
}

/* 正在被拖动的标签：压暗一点，明确「我在移动它」 */
.tag.tag.is-dragging {
  opacity: 0.45;
  cursor: grabbing;
}

/* 落点：虚线描边画在标签外面，黑底标签上也能看清 */
.tag.tag.is-drop {
  outline: 2px dashed var(--ink);
  outline-offset: 2px;
}

/* 项目数：白底黑字小胶囊，在黑标签上足够跳 */
.tag__count {
  margin-left: 7px;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: var(--ink-inverse);
  color: var(--ink);
  font-size: var(--fs-micro);
  font-weight: 600;
  line-height: 1.55;
}

/* 删除键平时宽 0 不占位，悬停标签时才向左长出来 */
.tag__del {
  width: 0;
  margin-left: 0;
  overflow: hidden;
  flex-shrink: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
  cursor: pointer;
  opacity: 0;
  transition: width 0.16s ease, margin-left 0.16s ease, opacity 0.16s ease,
    color 0.16s ease;
}

.tag:hover .tag__del {
  width: 13px;
  margin-left: 7px;
  opacity: 1;
}

.tag__del:hover {
  color: #ff8f8f;
}

.tag-edit {
  width: 152px;
}

/* ---------- 说明与新建 ---------- */
.hint,
.empty {
  font-size: var(--fs-meta);
  line-height: 1.7;
  color: var(--ink-3);
}

.empty {
  padding: var(--sp-2) 0;
}

.create {
  display: flex;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

.create :deep(.el-input) {
  flex: 1;
  min-width: 0;
}
</style>
