/**
 * 存储侧入口：`@video-notes/core/storage`。
 * 只导出存储与配置相关 API（库、词表、端点解析、路径/配置），
 * 不导出 `runExtract` 流水线——桌面端按这个契约取数，流水线走 `@video-notes/core` 主入口。
 */
export { notesRoot, modelDir, llmCredentialsFromEnv } from "./core/config";
export { loadDotenvFiles } from "./core/env";
export { videoIdFor } from "./core/paths";
export { listLibrary, readLibraryVideo } from "./core/library";
export type { LibraryClip, LibraryTopic, LibraryVideo, LibraryDetail } from "./core/library";
export {
  loadCorrections,
  parseCorrections,
  readVideoCorrections,
  saveVideoCorrections,
} from "./core/corrections-io";
export type { CorrectionFileEntry } from "./core/corrections-io";
export { resolveEndpointFromEnv } from "./llm/endpoint";
export type { VideoId } from "./core/types";
