/** renderer 与 main 之间的线上契约。core 内部类型不直接穿过 IPC。 */

export type VideoId = string;

export type CoreStep = "transcribe" | "segment-topics" | "generate-notes";
export type JobStep = CoreStep | "prepare" | "cleanup";

export type CorrectionEntry = { wrong: string; right: string };

export type ClipInfo = {
  file: string;
  /** 自定义协议地址，main 负责生成与校验。 */
  mediaUrl: string;
  startSeconds: number;
  endSeconds: number;
};

export type LibraryVideo = {
  id: VideoId;
  title: string;
  outputDir: string;
  /** 已知的源视频绝对路径；旧目录没有记录时为 null，重跑前要让用户重新选择。 */
  sourcePath: string | null;
  topicCount: number;
  clipCount: number;
  updatedAt: string | null;
};

export type VideoTopic = {
  dirName: string;
  title: string;
  markdown: string;
  clips: ClipInfo[];
};

export type VideoDetail = {
  video: LibraryVideo;
  indexMarkdown: string;
  topics: VideoTopic[];
  corrections: CorrectionEntry[];
};

export type SettingsStatus = {
  configured: boolean;
  /** 显式配置的模型名（VNOTE_LLM_MODEL / IDEALSOFT_API_MODEL）。 */
  model: string | null;
  /** 启动时 GET /models 发现并选中的模型名；显式配置或发现失败时为 null。 */
  discoveredModel: string | null;
  /** 模型发现失败的脱敏消息；成功或未尝试时为 null。 */
  modelError: string | null;
  notesRoot: string;
  modelDir: string;
  dotenvFiles: string[];
  ffmpeg: boolean;
};

export type ExtractTarget =
  | { kind: "new"; sourcePath: string }
  | { kind: "existing"; videoId: VideoId; sourcePath?: string };

export type JobSnapshot =
  | { state: "queued"; jobId: string; videoId: VideoId; sourcePath: string }
  | {
      state: "running";
      jobId: string;
      videoId: VideoId;
      step: JobStep;
      done: number;
      total: number;
      detail: string | null;
      startedAt: string;
    }
  | {
      state: "succeeded";
      jobId: string;
      videoId: VideoId;
      topicCount: number;
      noteCount: number;
      cacheHits: string[];
      timings: Record<string, number>;
      outputDir: string | null;
    }
  | { state: "failed"; jobId: string; videoId: VideoId; message: string }
  | { state: "cancelled"; jobId: string; videoId: VideoId };

export type VnoteApi = {
  listLibrary(): Promise<LibraryVideo[]>;
  getVideo(videoId: VideoId): Promise<VideoDetail>;
  saveCorrections(videoId: VideoId, entries: CorrectionEntry[]): Promise<CorrectionEntry[]>;
  pickVideo(): Promise<string | null>;
  pickSource(videoId: VideoId): Promise<string | null>;
  /** 拖拽进来的 File 只有 renderer 侧引用，绝对路径要靠 preload 的 webUtils 取。 */
  pathForFile(file: File): string;
  startExtract(target: ExtractTarget): Promise<{ jobId: string }>;
  cancelExtract(jobId: string): Promise<void>;
  activeJob(): Promise<JobSnapshot | null>;
  onJob(listener: (job: JobSnapshot) => void): () => void;
  settings(): Promise<SettingsStatus>;
  reveal(outputDir: string): Promise<void>;
};

export const IPC = {
  listLibrary: "library:list",
  getVideo: "video:detail",
  saveCorrections: "video:save-corrections",
  pickVideo: "dialog:pick-video",
  pickSource: "dialog:pick-source",
  startExtract: "extract:start",
  cancelExtract: "extract:cancel",
  activeJob: "extract:active",
  jobEvent: "extract:event",
  settings: "settings:status",
  reveal: "shell:reveal",
} as const;
