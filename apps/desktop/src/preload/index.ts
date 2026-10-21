import { contextBridge, ipcRenderer } from "electron";
import type {
  CorrectionEntry,
  ExtractTarget,
  JobSnapshot,
  LibraryVideo,
  SettingsStatus,
  VideoDetail,
} from "../shared/ipc";
import { IPC } from "../shared/ipc";

/**
 * sandbox: true 下 preload 只能 import electron 与 Node 内建。
 * 这里只做逐方法映射，不 import core，不持有凭据。
 */
const api = {
  listLibrary: () => ipcRenderer.invoke(IPC.listLibrary) as Promise<LibraryVideo[]>,
  getVideo: (videoId: string) => ipcRenderer.invoke(IPC.getVideo, videoId) as Promise<VideoDetail>,
  saveCorrections: (videoId: string, entries: CorrectionEntry[]) =>
    ipcRenderer.invoke(IPC.saveCorrections, videoId, entries) as Promise<CorrectionEntry[]>,
  pickVideo: () => ipcRenderer.invoke(IPC.pickVideo) as Promise<string | null>,
  pickSource: (videoId: string) => ipcRenderer.invoke(IPC.pickSource, videoId) as Promise<string | null>,
  startExtract: (target: ExtractTarget) => ipcRenderer.invoke(IPC.startExtract, target) as Promise<{ jobId: string }>,
  cancelExtract: (jobId: string) => ipcRenderer.invoke(IPC.cancelExtract, jobId) as Promise<void>,
  activeJob: () => ipcRenderer.invoke(IPC.activeJob) as Promise<JobSnapshot | null>,
  settings: () => ipcRenderer.invoke(IPC.settings) as Promise<SettingsStatus>,
  reveal: (outputDir: string) => ipcRenderer.invoke(IPC.reveal, outputDir) as Promise<void>,
  onJob: (listener: (job: JobSnapshot) => void) => {
    const listenerWrapper = (_event: Electron.IpcRendererEvent, job: JobSnapshot): void => listener(job);
    ipcRenderer.on(IPC.jobEvent, listenerWrapper);
    return () => {
      ipcRenderer.removeListener(IPC.jobEvent, listenerWrapper);
    };
  },
};

contextBridge.exposeInMainWorld("vnote", api);
