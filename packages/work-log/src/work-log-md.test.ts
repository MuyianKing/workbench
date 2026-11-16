import type { WorkLogEntry, WorkLogStatus } from './work-log'
import { describe, expect, it } from 'vitest'
import { workLogEmailFragment, workLogEmailHtml, workLogToMarkdown } from './work-log-md'

/** 2026-09-15 是周二，本周 = 09-14（周一）~ 09-20（周日），上周 = 09-07 ~ 09-13 */
const NOW = new Date(2026, 8, 15, 10, 30).getTime()

const PROJECTS = [
  { id: 'p1', name: 'anes-page' },
  { id: 'p2', name: 'workbench' },
]

function entry(
  date: string,
  createdAt: number,
  content = '内容',
  projectId?: string,
  status: WorkLogStatus = 'done',
): WorkLogEntry {
  return {
    id: `e-${date}-${createdAt}`,
    date,
    content,
    status,
    createdAt,
    updatedAt: createdAt,
    ...(projectId ? { projectId } : {}),
  }
}

describe('workLogToMarkdown', () => {
  it('主题带档名，预置周月档补上实际覆盖的日期', () => {
    expect(workLogToMarkdown({ range: 'week', now: NOW, custom: null, sort: 'project', entries: [], projects: PROJECTS }).title)
      .toBe('工作日志 · 本周（9月14日 ~ 9月20日）')
    expect(workLogToMarkdown({ range: 'lastWeek', now: NOW, custom: null, sort: 'project', entries: [], projects: PROJECTS }).title)
      .toBe('工作日志 · 上周（9月7日 ~ 9月13日）')
    expect(workLogToMarkdown({ range: 'today', now: NOW, custom: null, sort: 'project', entries: [], projects: PROJECTS }).title)
      .toBe('工作日志 · 今天')
    expect(workLogToMarkdown({ range: 'todo', now: NOW, custom: null, sort: 'project', entries: [], projects: PROJECTS }).title)
      .toBe('工作日志 · 待办')
  })

  it('自定义档按界面上选的那段说：单日说相对说法，跨天报区间', () => {
    expect(workLogToMarkdown({ range: 'custom', now: NOW, custom: { from: '2026-09-15', to: '2026-09-15' }, sort: 'time', entries: [], projects: PROJECTS }).title)
      .toBe('工作日志 · 今天')
    expect(workLogToMarkdown({ range: 'custom', now: NOW, custom: { from: '2026-09-01', to: '2026-09-15' }, sort: 'time', entries: [], projects: PROJECTS }).title)
      .toBe('工作日志 · 9月1日 – 9月15日')
  })

  it('按项目分组：一个项目一节，日期单独一行加粗；只收已完成，待办不进正文', () => {
    const md = workLogToMarkdown({
      range: 'week',
      now: NOW,
      custom: null,
      sort: 'project',
      entries: [
        entry('2026-09-14', NOW - 100, '优化导出逻辑', 'p1'),
        entry('2026-09-15', NOW - 200, '修复核算按钮字段不一致', 'p2'),
        entry('2026-09-15', NOW - 300, '补一版回归', 'p2', 'todo'),
      ],
      projects: PROJECTS,
    })

    expect(md.body).toBe([
      '# 工作日志 · 本周（9月14日 ~ 9月20日）',
      '',
      '## anes-page',
      '',
      '**9月14日**',
      '',
      '- 优化导出逻辑',
      '',
      '## workbench',
      '',
      '**9月15日**',
      '',
      '- 修复核算按钮字段不一致',
    ].join('\n'))
  })

  it('按时间分组：一天一节，栏头带星期，行里不再重复日期', () => {
    const md = workLogToMarkdown({
      range: 'week',
      now: NOW,
      custom: null,
      sort: 'time',
      entries: [
        entry('2026-09-15', NOW - 100, '今天的活'),
        entry('2026-09-14', NOW - 200, '昨天的活'),
      ],
      projects: PROJECTS,
    })

    expect(md.body).toBe([
      '# 工作日志 · 本周（9月14日 ~ 9月20日）',
      '',
      '## 9月15日（周二）',
      '',
      '- 今天的活',
      '',
      '## 9月14日（周一）',
      '',
      '- 昨天的活',
    ].join('\n'))
  })

  it('多行正文原样接上：续行的列表项与第一行平级（与卡片同一套排法）', () => {
    const md = workLogToMarkdown({
      range: 'today',
      now: NOW,
      custom: null,
      sort: 'time',
      entries: [entry('2026-09-15', NOW, '第一行\n第二行\n- 第三行')],
      projects: PROJECTS,
    })

    expect(md.body).toBe([
      '# 工作日志 · 今天',
      '',
      '## 9月15日（周二）',
      '',
      '- 第一行',
      '第二行',
      '- 第三行',
    ].join('\n'))

    // 续行的列表项不缩进：渲染出来是两条平级 <li>，不会变成子列表
    const html = workLogEmailFragment(md.body)
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).not.toContain('<ul>\n<ul>')
  })

  it('未关联与已删除各占一节，说法与界面一致；范围外的条目不进正文', () => {
    const md = workLogToMarkdown({
      range: 'week',
      now: NOW,
      custom: null,
      sort: 'project',
      entries: [
        entry('2026-09-15', NOW - 100, '没选项目'),
        entry('2026-08-31', NOW - 400, '上个月的不收'),
        entry('2026-09-15', NOW - 200, '项目没了', '#deleted'),
      ],
      projects: PROJECTS,
    })

    expect(md.body).toBe([
      '# 工作日志 · 本周（9月14日 ~ 9月20日）',
      '',
      '## 未关联项目',
      '',
      '**9月15日**',
      '',
      '- 没选项目',
      '',
      '## 项目已删除',
      '',
      '**9月15日**',
      '',
      '- 项目没了',
    ].join('\n'))
  })
})

describe('工作日志邮件的 HTML 档', () => {
  const body = [
    '# 工作日志 · 上周（9月7日 ~ 9月13日）',
    '',
    '## ICU',
    '',
    '- 11月9日 - 修复按钮字段不一致',
    '- 11月10日 - 补一版回归',
  ].join('\n')

  it('片段：标题与列表排成 HTML，行首没有任务标记', () => {
    const html = workLogEmailFragment(body)
    expect(html).toContain('<h1>工作日志 · 上周（9月7日 ~ 9月13日）</h1>')
    expect(html).toContain('<h2>ICU</h2>')
    expect(html).toContain('<li>11月9日 - 修复按钮字段不一致</li>')
    expect(html).not.toContain('☑')
    expect(html).not.toContain('☐')
    expect(html).not.toContain('[x]')
  })

  it('完整文档：一页带内联样式的白纸，不引用任何外部资源', () => {
    const html = workLogEmailHtml(body)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('.mail h2')
    expect(html).toContain('修复按钮字段不一致')
    // 邮件里只这一份文档：没有外链样式 / 脚本 / 图片
    expect(html).not.toMatch(/<link|<script|<img/i)
  })

  it('原文里的标签按文字显示（html: false）', () => {
    const html = workLogEmailFragment('# 标题\n\n<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
