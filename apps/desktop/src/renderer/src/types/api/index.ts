/**
 * 渲染层认的那一份宿主契约：`window.workbench` 的全部通道。
 *
 * 按域拆在 `api/` 下的各个 `*Channel`（一个域一份，实现见 `workbench/` 的对应适配文件）；
 * 这里只把它们的并集立成调用方看到的那一个名字 —— 测试可以只实现自己那一个域。
 * 通道的覆盖由装配处那道编译期检查保证（见 workbench/index.ts 的 MissingChannels）——
 * 新增或改名时这里与实现要一起改，漏一处就是编译错误。
 */

import type { AiChannel } from './ai'
import type { AppearanceChannel } from './appearance'
import type { AuthChannel } from './auth'
import type { BallChannel } from './ball'
import type { CaptureChannel } from './capture'
import type { EnvironmentChannel } from './environment'
import type { GatewayChannel } from './gateway'
import type { GitChannel } from './git'
import type { KbChannel } from './kb'
import type { MailChannel } from './mail'
import type { MarkdownWindowChannel } from './markdown-window'
import type { NotesChannel } from './notes'
import type { ProcessChannel } from './process'
import type { ProjectChannel } from './project'
import type { QoderChannel } from './qoder'
import type { SkillsChannel } from './skills'
import type { StatsChannel } from './stats'
import type { SystemChannel } from './system'
import type { VaultChannel } from './vault'
import type { VideoChannel } from './video'
import type { WorkLogChannel } from './work-log'
import type { ZentaoChannel } from './zentao'

export interface WorkbenchApi
  extends AiChannel,
  AppearanceChannel,
  AuthChannel,
  BallChannel,
  CaptureChannel,
  EnvironmentChannel,
  GatewayChannel,
  GitChannel,
  KbChannel,
  MailChannel,
  MarkdownWindowChannel,
  NotesChannel,
  ProcessChannel,
  ProjectChannel,
  QoderChannel,
  SkillsChannel,
  StatsChannel,
  SystemChannel,
  VaultChannel,
  VideoChannel,
  WorkLogChannel,
  ZentaoChannel {}
