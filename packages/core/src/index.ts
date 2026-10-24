export { runExtract } from "./pipeline/extract";
export type { ExtractInput, ExtractResult } from "./pipeline/extract";
export { runNotes, runTopics } from "./pipeline/notes-run";
export { loadDotenvFiles } from "./core/env";
export {
  createLogger,
  configureLogging,
  logger,
  runWithTask,
  logFileName,
  LOG_FILE_RE,
  redactSecrets,
  pruneOldLogs,
  readTaskLog,
  tailLog,
} from "./core/logger";
export { buildDiagnostics, errorLines } from "./core/diagnostics";
export { prerequisiteProblems, formatPrerequisiteError } from "./core/preflight";
export { describeFailure } from "./core/failure-summary";
export type { PrerequisiteInput } from "./core/preflight";
export type { DiagnosticsInput } from "./core/diagnostics";
export type { LogLevel, LogModule, LogFields, Logger, LoggerOptions } from "./core/logger";
export {
  findExecutable,
  checkPath,
  collectEnvironment,
  formatEnvironment,
  logEnvironment,
} from "./core/environment";
export type { PathCheck, EnvironmentSnapshot } from "./core/environment";
export {
  cacheRoot,
  dataRoot,
  llmCredentialsFromEnv,
  modelDir,
  notesRoot,
  ASR_MODEL_ID,
  envValue,
  llmEnv,
  asrEnv,
  REMOTE_CHUNK_TARGET_SECONDS,
  REMOTE_CHUNK_MIN_SECONDS,
  REMOTE_CHUNK_MAX_SECONDS,
  REMOTE_ADAPTER_VERSION,
  VOLCENGINE_FLASH_URL,
  VOLCENGINE_FLASH_RESOURCE_ID,
  VOLCENGINE_FLASH_MODEL,
  VOLCENGINE_FLASH_MODEL_ID,
  VOLCENGINE_STANDARD_SUBMIT_URL,
  VOLCENGINE_STANDARD_QUERY_URL,
  VOLCENGINE_STANDARD_RESOURCE_ID,
  VOLCENGINE_STANDARD_MODEL_ID,
} from "./core/config";
export type { EnvRecord } from "./core/config";
export { cacheDirFor, logDirFor } from "./core/paths";
export {
  SETTINGS_FILE_NAME,
  SETTINGS_VERSION,
  applyLlmSeed,
  defaultSettings,
  loadSettings,
  readSettingsFile,
  readSettingsFileSafe,
  resolveSettings,
  saveSettings,
  prepareSettings,
  validateSettingsPatch,
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
export { migrateStorageLayout } from "./core/storage-layout";
export type { StorageMigrationResult } from "./core/storage-layout";
export { resolveEndpointFromEnv, resolveLlmEndpoint, fetchModelIds } from "./llm/endpoint";
export { displayUrl, isTimeoutError, llmHttpErrorMessage, llmNetworkErrorMessage } from "./llm/errors";
export type { Progress, StepName, LlmEndpoint } from "./core/steps";
export { videoIdFor } from "./core/paths";
export { listLibrary, readLibraryVideo, deleteVideo } from "./core/library";
export type { LibraryVideo, LibraryVideoStatus, LibraryDetail } from "./core/library";
export { acquireVideoLock, isVideoLocked, isVideoLockHeldByForeign } from "./core/lock";
export type { VideoLock } from "./core/lock";
export {
  VIDEO_DATA_FILE,
  VIDEO_DATA_VERSION,
  readVideoData,
  writeVideoData,
  emptyVideoData,
  migrateVideoData,
  loadVideoData,
  projectRunState,
  recordVideoFailure,
  clearVideoFailure,
} from "./core/video-data";
export type { TopicStatus, TopicClip, TopicRecord, VideoData, VideoRef } from "./core/video-data";
export {
  videoNeedsRerun,
  renameSpeaker,
  deleteUtterance,
  deleteTopicSegment,
  mergeTopics,
  mergeSpeakers,
  unmergeSpeaker,
  setTopicSelected,
  setTopicProgress,
  settleRunWhileLocked,
  recoverInterruptedRun,
} from "./core/edits";
export type { TopicProgressPatch } from "./core/edits";
export { renderTopicMarkdown, renderIndexMarkdown } from "./core/render";
export {
  loadCorrections,
  parseCorrections,
  readGlobalCorrections,
  readVideoCorrections,
  saveGlobalCorrections,
  saveVideoCorrections,
} from "./core/corrections-io";
export type { CorrectionFileEntry } from "./core/corrections-io";
export { probeVideo, parseProbeJson, planChunks } from "./core/audio";
export type { ProbeResult, ChunkLimits } from "./core/audio";
export { createAsrEngine } from "./asr/engine";
export type { AsrEngine, AsrEngineId, AsrConfig, AsrInput, AsrRun, AsrEngineOptions } from "./asr/engine";
export {
  MODEL_BUNDLES,
  MODEL_LOCK_FILE,
  modelLockPath,
  modelStatus,
  rememberVerified,
  cachedVerified,
} from "./models/catalog";
export type {
  ModelFileSpec,
  ModelBundle,
  ModelFileStatus,
  ModelBundleStatus,
  ModelsStatus,
  DownloadSnapshot,
  ImportResult,
} from "./models/catalog";
export { downloadBundle, downloadModels, recoverModelDir } from "./models/download";
export type { DownloadProgress, DownloadLogLine, FetchImpl } from "./models/download";
export { importModels } from "./models/import";
export { verifyModels, verifyBundle } from "./models/verify";
export { acquireModelLock } from "./models/oplock";
export type { ModelLock } from "./models/oplock";
export { extractArchive, streamSha256 } from "./models/extract";
export type { TarExec } from "./models/extract";
export { COVER_FILE, coverPath, ensureCoverFrame } from "./core/cover";
export { parseClipFileName } from "./core/clips";
export { killActiveChildren } from "./core/exec";
export type { VideoId } from "./core/types";
export type { Utterance, Correction, CorrectionList } from "./core/types";
export { applyCorrections, resolveCorrections } from "./core/corrections";
export { projectTopicArtifacts } from "./core/topic-artifacts";
