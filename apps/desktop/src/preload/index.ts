import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  CorrectionEntry,
  DirectoryKind,
  ExtractTarget,
  JobSnapshot,
  SettingsPatch,
  SettingsStatus,
  TestLlmResult,
  VnoteApi,
} from "../shared/ipc";
import { IPC } from "../shared/ipc";

/**
 * sandbox: true 下 preload 只能 import electron 与 Node 内建。
 * 这里只做逐方法映射，不 import core，不持有凭据。
 */
const api: VnoteApi = {
  listLibrary: () => ipcRenderer.invoke(IPC.listLibrary) as Promise<VnoteApi["listLibrary"] extends () => Promise<infer R> ? R : never>,
  getVideo: (videoId: string) => ipcRenderer.invoke(IPC.getVideo, videoId) as Promise<VnoteApi["getVideo"] extends (id: string) => Promise<infer R> ? R : never>,
  renameSpeaker: (videoId, speakerId, name) => ipcRenderer.invoke(IPC.renameSpeaker, videoId, speakerId, name) as Promise<VnoteApi["renameSpeaker"] extends (a: string, b: string, c: string) => Promise<infer R> ? R : never>,
  deleteUtterance: (videoId, index) => ipcRenderer.invoke(IPC.deleteUtterance, videoId, index) as Promise<VnoteApi["deleteUtterance"] extends (a: string, b: number) => Promise<infer R> ? R : never>,
  deleteTopicSegment: (videoId, topicId, segmentIndex) => ipcRenderer.invoke(IPC.deleteTopicSegment, videoId, topicId, segmentIndex) as Promise<VnoteApi["deleteTopicSegment"] extends (a: string, b: string, c: number) => Promise<infer R> ? R : never>,
  mergeTopics: (videoId, topicIds) => ipcRenderer.invoke(IPC.mergeTopics, videoId, topicIds) as Promise<VnoteApi["mergeTopics"] extends (a: string, b: string[]) => Promise<infer R> ? R : never>,
  setTopicSelected: (videoId, topicId, selected) => ipcRenderer.invoke(IPC.setTopicSelected, videoId, topicId, selected) as Promise<VnoteApi["setTopicSelected"] extends (a: string, b: string, c: boolean) => Promise<infer R> ? R : never>,
  saveCorrections: (videoId, entries) => ipcRenderer.invoke(IPC.saveCorrections, videoId, entries) as Promise<VnoteApi["saveCorrections"] extends (a: string, b: CorrectionEntry[]) => Promise<infer R> ? R : never>,
  listGlossary: () => ipcRenderer.invoke(IPC.listGlossary) as Promise<VnoteApi["listGlossary"] extends () => Promise<infer R> ? R : never>,
  saveGlossary: (entries) => ipcRenderer.invoke(IPC.saveGlossary, entries) as Promise<VnoteApi["saveGlossary"] extends (a: CorrectionEntry[]) => Promise<infer R> ? R : never>,
  pickVideo: () => ipcRenderer.invoke(IPC.pickVideo) as Promise<string | null>,
  pickSource: (videoId) => ipcRenderer.invoke(IPC.pickSource, videoId) as Promise<string | null>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  startExtract: (target: ExtractTarget) => ipcRenderer.invoke(IPC.startExtract, target) as Promise<{ jobId: string }>,
  startNotes: (videoId, topicIds) => ipcRenderer.invoke(IPC.startNotes, videoId, topicIds) as Promise<{ jobId: string }>,
  rebuildTopics: (videoId) => ipcRenderer.invoke(IPC.rebuildTopics, videoId) as Promise<{ jobId: string }>,
  cancelExtract: (jobId) => ipcRenderer.invoke(IPC.cancelExtract, jobId) as Promise<void>,
  activeJob: () => ipcRenderer.invoke(IPC.activeJob) as Promise<JobSnapshot | null>,
  onJob: (listener: (job: JobSnapshot) => void) => {
    const listenerWrapper = (_event: Electron.IpcRendererEvent, job: JobSnapshot): void => listener(job);
    ipcRenderer.on(IPC.jobEvent, listenerWrapper);
    return () => {
      ipcRenderer.removeListener(IPC.jobEvent, listenerWrapper);
    };
  },
  settings: () => ipcRenderer.invoke(IPC.settings) as Promise<SettingsStatus>,
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.updateSettings, patch) as Promise<SettingsStatus>,
  pickDirectory: (kind: DirectoryKind) => ipcRenderer.invoke(IPC.pickDirectory, kind) as Promise<string | null>,
  clearCache: () => ipcRenderer.invoke(IPC.clearCache) as Promise<{ freedBytes: number }>,
  testLlm: () => ipcRenderer.invoke(IPC.testLlm) as Promise<TestLlmResult>,
  reveal: (outputDir) => ipcRenderer.invoke(IPC.reveal, outputDir) as Promise<void>,
};

contextBridge.exposeInMainWorld("vnote", api);
