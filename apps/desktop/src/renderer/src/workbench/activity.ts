import type { ActivityKind } from '@workbench/core'
import { emit } from './events'
import * as state from './state'

/**
 * 记一次活跃度：写进当天的分项，并通知渲染层重拉。
 *
 * **两件事必须成对**：只记不广播，首页那张图要等到下次回首页、或下一次项目推送才会变色 ——
 * 用户明明刚写完一篇笔记，图上却什么动静都没有。凑在一起的地方只有这一处，
 * 所以单开一个模块：调用点分散在笔记 / 工作日志 / 知识库 / 会话四处，
 * 各写一遍迟早漏掉 `emit` 那一半。
 *
 * 调用点都在**真正做那件事、且知道成了**的地方（写盘 / 建索引成功之后）：
 * 「界面以为成了、其实失败了，格子里却多了一笔」这种账不许出现。
 * 适配层内部直接调它；AI 助手那一轮跑完在渲染层的 store 里才知道（见 stores/ai.ts 的 settle），
 * 走的是暴露出去的同名通道，最终也落到这里。
 */
export function recordActivity(kind: ActivityKind): void {
  state.recordActivity(kind)
  emit('activityChanged', null)
}
