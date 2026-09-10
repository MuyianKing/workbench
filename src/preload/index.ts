import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type ActivityCounts,
  type AddProjectInput,
  type AppSettings,
  type EffectiveTheme,
  type ProcessLogEvent,
  type ProcessStatusEvent,
  type Project,
  type ProjectPatch,
  type TerminalOpenEvent,
  type WorkbenchApi
} from '../shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** 暴露给渲染进程的白名单 API，渲染进程无法直接访问 Node 能力 */
const api: WorkbenchApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },

  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  scanProject: (dirPath: string) => ipcRenderer.invoke(IPC.scanProject, dirPath),

  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  addProject: (input: AddProjectInput) => ipcRenderer.invoke(IPC.addProject, input),
  updateProject: (id: string, patch: ProjectPatch) =>
    ipcRenderer.invoke(IPC.updateProject, id, patch),
  removeProject: (id: string) => ipcRenderer.invoke(IPC.removeProject, id),
  relocateProject: (id: string, newPath: string) =>
    ipcRenderer.invoke(IPC.relocateProject, id, newPath),
  checkProjectPaths: () => ipcRenderer.invoke(IPC.checkProjectPaths),
  getActivity: (): Promise<ActivityCounts> => ipcRenderer.invoke(IPC.activity),

  createGroup: (name: string) => ipcRenderer.invoke(IPC.createGroup, name),
  renameGroup: (id: string, name: string) => ipcRenderer.invoke(IPC.renameGroup, id, name),
  removeGroup: (id: string) => ipcRenderer.invoke(IPC.removeGroup, id),
  reorderGroups: (ids: string[]) => ipcRenderer.invoke(IPC.reorderGroups, ids),

  reveal: (targetPath: string) => ipcRenderer.invoke(IPC.reveal, targetPath),
  checkPackageManagers: () => ipcRenderer.invoke(IPC.checkPackageManagers),
  checkPort: (port: number) => ipcRenderer.invoke(IPC.checkPort, port),
  killPortProcess: (port: number) => ipcRenderer.invoke(IPC.killPortProcess, port),
  checkNodeVersion: (id: string) => ipcRenderer.invoke(IPC.checkNodeVersion, id),
  getNvmStatus: () => ipcRenderer.invoke(IPC.nvmStatus),

  install: (id: string) => ipcRenderer.invoke(IPC.install, id),
  start: (id: string) => ipcRenderer.invoke(IPC.start, id),
  build: (id: string, script: string) => ipcRenderer.invoke(IPC.build, id, script),
  runCustom: (id: string, index: number) => ipcRenderer.invoke(IPC.runCustom, id, index),
  stop: (id: string) => ipcRenderer.invoke(IPC.stop, id),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.updateSettings, patch),

  getDataLocation: () => ipcRenderer.invoke(IPC.getDataLocation),
  pickDataDir: () => ipcRenderer.invoke(IPC.pickDataDir),
  migrateDataDir: (dir: string) => ipcRenderer.invoke(IPC.migrateDataDir, dir),

  onLog: (handler: (event: ProcessLogEvent) => void) => subscribe(IPC.eventLog, handler),
  onStatus: (handler: (event: ProcessStatusEvent) => void) => subscribe(IPC.eventStatus, handler),
  onTerminalOpen: (handler: (event: TerminalOpenEvent) => void) =>
    subscribe(IPC.eventTerminalOpen, handler),
  onClear: (handler: (event: { terminal: string }) => void) => subscribe(IPC.eventClear, handler),
  onProjectChanged: (handler: (project: Project) => void) =>
    subscribe(IPC.eventProjectChanged, handler),
  onSettingsChanged: (handler: (settings: AppSettings) => void) =>
    subscribe(IPC.eventSettings, handler),
  onTheme: (handler: (theme: EffectiveTheme) => void) => subscribe(IPC.eventTheme, handler),
  onDataReload: (handler: () => void) => subscribe(IPC.eventDataReload, handler)
}

contextBridge.exposeInMainWorld('workbench', api)
