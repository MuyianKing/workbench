import type { WorkLogEntry, WorkLogProjectRef, WorkRange, WorkRangeBounds, WorkSort } from './work-log'
import { renderMarkdown } from '@workbench/core'
import { dayMeta, defaultWorkRangeBounds, DELETED_PROJECT_ID, groupByProject, rangeBounds, sanitizeWorkRangeBounds, timelineOf, WORK_RANGE_LABELS } from './work-log'

/**
 * 把某一档的记录整理成一份 Markdown 文本 —— 工作页「发送到邮箱」那颗按钮的正文来源。
 *
 * **只发已完成的记录**：待办还在做、发给别人（或自己存档）没有意义，所以这里把
 * `status !== 'done'` 的条目滤掉，行首也不再挂 `[x]` / `[ ]` 这类任务标记 ——
 * 正文里就是一条条普通的列表项。
 *
 * 分组与排序直接复用时间轴的两个铺开函数（`timelineOf` / `groupByProject`）：
 * 发出去的就是屏幕上看到的那份 —— 同一台设备、同一档、同一个维度（调用方把
 * 设备先筛好再递进来）。邮件发两档正文：纯文本那份就是这份 Markdown 源码（兜底），
 * HTML 那份由 `workLogEmailHtml` 渲染（收件端看到的是排版后的内容，不是源码）。
 */

export interface WorkLogMarkdownInput {
  range: WorkRange
  /** 界面的「现在」：预置档的边界与日期说法都按它算 */
  now: number
  /** 「自定义」档的两端；其余档传 null */
  custom?: WorkRangeBounds | null
  /** 排序维度：跟屏幕同一个口径，按项目就一个项目一节，按时间就一天一节 */
  sort: WorkSort
  /** 已经按设备筛过的那批条目（与屏幕同一份） */
  entries: readonly WorkLogEntry[]
  /** 项目清单：按项目分节的栏头名字从这来 */
  projects: readonly WorkLogProjectRef[]
}

export interface WorkLogMarkdown {
  /** 邮件主题，也是正文的第一行 */
  title: string
  /** Markdown 正文（含 H1 那行主题） */
  body: string
}

/** 范围那段说法：「待办 / 今天 / 昨天」一个词就够；预置周月档补上实际日期；自定义按选的那段说 */
function rangeTitleOf(range: WorkRange, now: number, custom?: WorkRangeBounds | null): string {
  if (range === 'custom') {
    // 同 resolveWorkRangeBounds 那条口径：没选过或值坏了就按今天一天说
    const bounds = sanitizeWorkRangeBounds(custom?.from, custom?.to) ?? defaultWorkRangeBounds(now)
    if (bounds.from === bounds.to) {
      const meta = dayMeta(bounds.from, now)
      return meta.relative || meta.title || bounds.from
    }
    return `${dayMeta(bounds.from, now).title || bounds.from} – ${dayMeta(bounds.to, now).title || bounds.to}`
  }
  if (range === 'todo' || range === 'today' || range === 'yesterday')
    return WORK_RANGE_LABELS[range]
  // week / lastWeek / month：档名后面补上实际覆盖的日期，收件人不必换算「本周是哪几天」
  const bounds = rangeBounds(range, now)
  return `${WORK_RANGE_LABELS[range]}（${dayMeta(bounds.from, now).title} ~ ${dayMeta(bounds.to, now).title}）`
}

/** 时间维度的一节栏头：9月14日（周一）—— 星期恒有，相对说法（今天 / 昨天）在邮件里多余，不写 */
function dayHeading(day: string, now: number): string {
  const meta = dayMeta(day, now)
  return meta.weekday ? `${meta.title || day}（${meta.weekday}）` : meta.title || day
}

/** 正文首行已经带列表标记（`- ` / `* ` / `+ ` / `1. `）：带了就原样，别再补一个 */
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/

/**
 * 一节里的条目块。
 *
 * **项目维度：日期单独一行、加粗**（`**11月16日**`，下面空一行再接正文）—— 一节跨了
 * 好几天，日期是每条记录的抬头，不跟正文挤在同一行。**时间维度**栏头就是日期，块里
 * 不再重复。
 *
 * 正文是 markdown 原文、可能多行：原样接上，只在首行没有列表标记时补一个 `- `
 * （纯文本正文也排成一条一条）。**续行不额外缩进** —— 正文里自己的 `- 第二条` 与
 * 第一行平级（与屏幕上卡片同一套排法），缩进两格会被 markdown 当成子列表。
 */
function sectionItemLines(entries: readonly WorkLogEntry[], dated: boolean, now: number): string[] {
  return entries.map((entry) => {
    const lines = entry.content.replace(/\r\n|\r/g, '\n').split('\n')
    const body = LIST_MARK.test(lines[0] ?? '')
      ? lines.join('\n')
      : [`- ${lines[0] ?? ''}`, ...lines.slice(1)].join('\n')
    if (!dated)
      return body
    return `**${dayMeta(entry.date, now).title || entry.date}**\n\n${body}`
  })
}

/** 未关联 / 已删除两栏的栏头与界面同一个说法（见 WorkView 的 projectTitleOf） */
function projectHeading(projectId: string | null, projects: readonly WorkLogProjectRef[]): string {
  if (!projectId)
    return '未关联项目'
  if (projectId === DELETED_PROJECT_ID)
    return '项目已删除'
  return projects.find(project => project.id === projectId)?.name ?? '未关联项目'
}

export function workLogToMarkdown(input: WorkLogMarkdownInput): WorkLogMarkdown {
  const { range, now, custom, sort, projects } = input
  const title = `工作日志 · ${rangeTitleOf(range, now, custom)}`
  // 只发已完成：待办还在做，不往外发（「待办」档整档都是待办，调用方应提前拦住）
  const entries = input.entries.filter(entry => entry.status === 'done')

  const chunks: string[] = [`# ${title}`]

  const sections = sort === 'time'
    ? timelineOf(entries, range, now, custom).map(group => ({
        heading: dayHeading(group.day, now),
        dated: false,
        list: group.entries,
      }))
    : groupByProject(entries, range, now, projects, custom).map(group => ({
        heading: projectHeading(group.projectId, projects),
        dated: true,
        list: group.entries,
      }))

  for (const section of sections) {
    // 项目维度每条记录是「加粗日期 + 正文」一块，块间空一行；时间维度一天一段连续列表
    chunks.push('', `## ${section.heading}`, '', sectionItemLines(section.list, section.dated, now).join(section.dated ? '\n\n' : '\n'))
  }

  return { title, body: chunks.join('\n') }
}

/**
 * 邮件正文的 HTML 片段：与界面同一套 markdown-it（`html: false` 转义原文标签，
 * 见 packages/core/src/markdown.ts），弹窗里的预览直接用它。正文里没有任务标记
 * （workLogToMarkdown 已经滤掉待办、行首不带 `[x]`），不用再换成方框。
 */
export function workLogEmailFragment(markdown: string): string {
  return renderMarkdown(markdown)
}

/**
 * 邮件里那张「白纸」的样式：多数客户端认 head 里的 <style>；被剥掉时 body / .mail
 * 上的内联样式还兜得住基本排版（字号、行高、白底、宽度）。
 */
const EMAIL_STYLE = [
  'body { margin: 0; padding: 24px 12px; background: #f4f5f7; }',
  '.mail { max-width: 720px; margin: 0 auto; padding: 28px 32px; background: #fff; border-radius: 8px; font: 14px/1.75 -apple-system, \'Segoe UI\', \'Microsoft YaHei\', sans-serif; color: #1f2328; }',
  '.mail h1 { margin: 0 0 4px; font-size: 20px; line-height: 1.4; }',
  '.mail h2 { margin: 24px 0 8px; padding-bottom: 6px; font-size: 15px; border-bottom: 1px solid #e6e8eb; }',
  '.mail p { margin: 8px 0; }',
  '.mail ul { margin: 0; padding-left: 22px; }',
  '.mail li { margin: 3px 0; }',
  '.mail code { padding: 1px 4px; border-radius: 3px; background: #f2f3f5; font-size: 12.5px; }',
  '.mail hr { margin: 16px 0; border: 0; border-top: 1px solid #e6e8eb; }',
  '.mail .md-table { overflow-x: auto; }',
  '.mail table { border-collapse: collapse; }',
  '.mail th, .mail td { padding: 6px 10px; border: 1px solid #e6e8eb; }',
  '.mail th { background: #f7f8fa; }',
].join('\n')

/**
 * 一封完整的工作日志邮件（HTML 档）：720px 居中一张白纸。
 * 正文是自己的工作日志 Markdown 经 `html: false` 渲染出来的片段 —— 没有外链样式、
 * 图片或脚本，发出去就这一份文档。
 */
export function workLogEmailHtml(markdown: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>工作日志</title>',
    '<style>',
    EMAIL_STYLE,
    '</style>',
    '</head>',
    '<body style="margin:0;padding:24px 12px;background:#f4f5f7;">',
    '<div class="mail" style="max-width:720px;margin:0 auto;padding:28px 32px;background:#ffffff;border-radius:8px;font:14px/1.75 -apple-system,\'Segoe UI\',\'Microsoft YaHei\',sans-serif;color:#1f2328;">',
    workLogEmailFragment(markdown),
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}
