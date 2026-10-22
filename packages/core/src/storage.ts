/**
 * 存储侧入口：`@video-notes/core/storage`。
 * 只导出存储与配置相关 API（库、词表、端点解析、路径/配置），
 * 不导出 `runExtract` 流水线——桌面端按这个契约取数，流水线走 `@video-notes/core` 主入口。
 */
export { cacheRoot, notesRoot, modelDir, llmCredentialsFromEnv, ASR_MODEL_ID } from "./core/config";
export { cacheDirFor } from "./core/paths";
export {
  SETTINGS_FILE_NAME,
  SETTINGS_VERSION,
  defaultSettings,
  loadSettings,
  readSettingsFile,
  readSettingsFileSafe,
  resolveSettings,
  saveSettings,
  markAutoDownloadAttempted,
  settingsLockedByEnv,
} from "./core/settings";
export type {
  AppSettings,
  SettingsFile,
  SettingsPatch,
  LlmSettings,
  AsrSettings,
  AsrProvider,
  VolcengineMode,
  VolcengineAuthMode,
  LockedSettings,
} from "./core/settings";
export { resolveLlm, resolveAsr, resolveAsrFor } from "./core/credentials";
export type { KeySource, Resolution, ResolvedLlm, ResolvedAsr, AsrSecrets, VolcengineAuth } from "./core/credentials";
export { cacheUsage, clearCache } from "./core/cache-usage";
export { loadDotenvFiles } from "./core/env";
export { videoIdFor } from "./core/paths";
export { listLibrary, readLibraryVideo } from "./core/library";
export type { LibraryVideo, LibraryVideoStatus, LibraryDetail } from "./core/library";
export {
  VIDEO_DATA_FILE,
  VIDEO_DATA_VERSION,
  readVideoData,
  writeVideoData,
  emptyVideoData,
  migrateVideoData,
  loadVideoData,
  projectRunState,
} from "./core/video-data";
export type { TopicStatus, TopicClip, TopicRecord, VideoData, VideoRef } from "./core/video-data";
export {
  videoNeedsRerun,
  renameSpeaker,
  deleteUtterance,
  deleteTopicSegment,
  mergeTopics,
  setTopicSelected,
  setTopicProgress,
  settleRunWhileLocked,
  recoverInterruptedRun,
} from "./core/edits";
export type { TopicProgressPatch } from "./core/edits";
export { renderTopicMarkdown, renderIndexMarkdown } from "./core/render";
export { isVideoLocked, isVideoLockHeldByForeign } from "./core/lock";
export {
  loadCorrections,
  parseCorrections,
  readGlobalCorrections,
  readVideoCorrections,
  saveGlobalCorrections,
  saveVideoCorrections,
} from "./core/corrections-io";
export type { CorrectionFileEntry } from "./core/corrections-io";
export { resolveEndpointFromEnv } from "./llm/endpoint";
export type { VideoId } from "./core/types";
