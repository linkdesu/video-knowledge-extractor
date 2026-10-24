import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AsrUpdatePatch,
  CorrectionEntry,
  DirectoryKind,
  ExtractTarget,
  ImportModelsResult,
  JobSnapshot,
  LlmDraft,
  LlmUpdatePatch,
  LlmModelListResult,
  ModelsStatus,
  ModelDownloadEvent,
  SettingsPatch,
  SettingsStatus,
  TestAsrResult,
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
  mergeSpeakers: (videoId, speakerIds, targetName) => ipcRenderer.invoke(IPC.mergeSpeakers, videoId, speakerIds, targetName) as Promise<VnoteApi["mergeSpeakers"] extends (a: string, b: string[], c: string) => Promise<infer R> ? R : never>,
  unmergeSpeaker: (videoId, speakerId) => ipcRenderer.invoke(IPC.unmergeSpeaker, videoId, speakerId) as Promise<VnoteApi["unmergeSpeaker"] extends (a: string, b: string) => Promise<infer R> ? R : never>,
  setTopicSelected: (videoId, topicId, selected) => ipcRenderer.invoke(IPC.setTopicSelected, videoId, topicId, selected) as Promise<VnoteApi["setTopicSelected"] extends (a: string, b: string, c: boolean) => Promise<infer R> ? R : never>,
  saveCorrections: (videoId, entries) => ipcRenderer.invoke(IPC.saveCorrections, videoId, entries) as Promise<VnoteApi["saveCorrections"] extends (a: string, b: CorrectionEntry[]) => Promise<infer R> ? R : never>,
  listGlossary: () => ipcRenderer.invoke(IPC.listGlossary) as Promise<VnoteApi["listGlossary"] extends () => Promise<infer R> ? R : never>,
  saveGlossary: (entries) => ipcRenderer.invoke(IPC.saveGlossary, entries) as Promise<VnoteApi["saveGlossary"] extends (a: CorrectionEntry[]) => Promise<infer R> ? R : never>,
  pickVideo: () => ipcRenderer.invoke(IPC.pickVideo) as Promise<string | null>,
  pickSource: (videoId) => ipcRenderer.invoke(IPC.pickSource, videoId) as Promise<string | null>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  startExtract: (target: ExtractTarget) => ipcRenderer.invoke(IPC.startExtract, target) as Promise<{ jobId: string }>,
  startNotes: (videoId, topicIds, options) => ipcRenderer.invoke(IPC.startNotes, videoId, topicIds, options) as Promise<{ jobId: string }>,
  rebuildTopics: (videoId) => ipcRenderer.invoke(IPC.rebuildTopics, videoId) as Promise<{ jobId: string }>,
  cancelExtract: (jobId) => ipcRenderer.invoke(IPC.cancelExtract, jobId) as Promise<void>,
  deleteVideo: (videoId) => ipcRenderer.invoke(IPC.deleteVideo, videoId) as Promise<void>,
  activeJob: () => ipcRenderer.invoke(IPC.activeJob) as Promise<JobSnapshot | null>,
  onJob: (listener: (job: JobSnapshot) => void) => {
    const listenerWrapper = (_event: Electron.IpcRendererEvent, job: JobSnapshot): void => listener(job);
    ipcRenderer.on(IPC.jobEvent, listenerWrapper);
    return () => {
      ipcRenderer.removeListener(IPC.jobEvent, listenerWrapper);
    };
  },
  onLibraryCovers: (listener: (videoIds: string[]) => void) => {
    const listenerWrapper = (_event: Electron.IpcRendererEvent, videoIds: string[]): void => listener(videoIds);
    ipcRenderer.on(IPC.libraryCovers, listenerWrapper);
    return () => {
      ipcRenderer.removeListener(IPC.libraryCovers, listenerWrapper);
    };
  },
  settings: () => ipcRenderer.invoke(IPC.settings) as Promise<SettingsStatus>,
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.updateSettings, patch) as Promise<SettingsStatus>,
  pickDirectory: (kind: DirectoryKind) => ipcRenderer.invoke(IPC.pickDirectory, kind) as Promise<string | null>,
  clearCache: () => ipcRenderer.invoke(IPC.clearCache) as Promise<{ freedBytes: number }>,
  testLlm: (draft: LlmDraft) => ipcRenderer.invoke(IPC.testLlm, draft) as Promise<TestLlmResult>,
  listLlmModels: (draft: LlmDraft) => ipcRenderer.invoke(IPC.listLlmModels, draft) as Promise<LlmModelListResult>,
  updateLlm: (patch: LlmUpdatePatch) => ipcRenderer.invoke(IPC.updateLlm, patch) as Promise<SettingsStatus>,
  updateAsr: (patch: AsrUpdatePatch) => ipcRenderer.invoke(IPC.updateAsr, patch) as Promise<SettingsStatus>,
  testAsr: () => ipcRenderer.invoke(IPC.testAsr) as Promise<TestAsrResult>,
  models: () => ipcRenderer.invoke(IPC.models) as Promise<ModelsStatus>,
  downloadModels: () => ipcRenderer.invoke(IPC.downloadModels) as Promise<ModelsStatus>,
  cancelModelDownload: () => ipcRenderer.invoke(IPC.cancelModelDownload) as Promise<ModelsStatus>,
  importModels: () => ipcRenderer.invoke(IPC.importModels) as Promise<ImportModelsResult>,
  verifyModels: () => ipcRenderer.invoke(IPC.verifyModels) as Promise<ModelsStatus>,
  onLlmChanged: (listener: () => void) => {
    const listenerWrapper = (): void => listener();
    ipcRenderer.on(IPC.llmEvent, listenerWrapper);
    return () => {
      ipcRenderer.removeListener(IPC.llmEvent, listenerWrapper);
    };
  },
  onModelDownload: (listener: (event: ModelDownloadEvent) => void) => {
    const listenerWrapper = (_event: Electron.IpcRendererEvent, event: ModelDownloadEvent): void => listener(event);
    ipcRenderer.on(IPC.modelEvent, listenerWrapper);
    return () => {
      ipcRenderer.removeListener(IPC.modelEvent, listenerWrapper);
    };
  },
  reveal: (outputDir) => ipcRenderer.invoke(IPC.reveal, outputDir) as Promise<void>,
  openLogs: () => ipcRenderer.invoke(IPC.logsOpen) as Promise<void>,
  copyDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsCopy) as Promise<{ chars: number }>,
};

contextBridge.exposeInMainWorld("vnote", api);
