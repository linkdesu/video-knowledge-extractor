/** renderer 与 main 之间的线上契约。core 内部类型不直接穿过 IPC（ADR-0012、ADR-0014）。 */

export type VideoId = string;

export type CoreStep = "transcribe" | "segment-topics" | "generate-notes";
export type JobStep = CoreStep | "prepare" | "cleanup";

/** 三类任务共用一条串行队列；界面按 kind 决定刷新什么。 */
export type JobKind = "extract" | "notes" | "topics";

/** 库卡片状态：完成、生成中、需重跑、失败。 */
export type VideoStatus = "done" | "in-progress" | "needs-rerun" | "failed";

export type TopicStatus = "queued" | "generating" | "done" | "failed" | "needs-rerun";

export type CorrectionSource = "manual" | "from-subtitle";

export type CorrectionEntry = {
  wrong: string;
  right: string;
  /** 旧词表没有来源；界面显示「手工」。 */
  source: CorrectionSource | null;
  updatedAt: string | null;
};

export type ClipInfo = {
  file: string;
  /** 自定义协议地址，main 负责生成与校验。 */
  mediaUrl: string;
  startSeconds: number;
  endSeconds: number;
  /** 这个切片覆盖的主题段下标；一个切片可以覆盖多段（前移后重叠合一）。 */
  segmentIndexes: number[];
};

export type SegmentInfo = { start: number; end: number };

export type SpeakerInfo = { id: string; name: string; color: string };

export type UtteranceInfo = {
  /** 在原始转写里的下标；删除接口用它，界面只展示应用纠错后的文本。 */
  index: number;
  start: number;
  end: number;
  speakerId: string;
  text: string;
};

export type TranscriptInfo = { speakers: SpeakerInfo[]; utterances: UtteranceInfo[] };

export type TopicInfo = {
  id: string;
  title: string;
  summary: string;
  segments: SegmentInfo[];
  /** 主题目录名；未生成时为 null。 */
  dirName: string | null;
  status: TopicStatus;
  selected: boolean;
  keyPoints: string[];
  clips: ClipInfo[];
  /** 生成中的开始时间与上次耗时，供「已用 00:42」显示。 */
  startedAt: string | null;
  elapsedSeconds: number | null;
  error: string | null;
};

export type LibraryVideo = {
  id: VideoId;
  title: string;
  outputDir: string;
  /** 已知的源视频绝对路径；旧目录没有记录时为 null，重跑前要让用户重新选择。 */
  sourcePath: string | null;
  durationSeconds: number | null;
  /** 首次生成的 ISO 时间；旧目录没有记录时为 null。 */
  importedAt: string | null;
  /** 源文件字节数；旧目录没有记录时为 null。 */
  sizeBytes: number | null;
  topicCount: number;
  clipCount: number;
  updatedAt: string | null;
  status: VideoStatus;
};

export type VideoDetail = {
  video: LibraryVideo;
  /** 源视频的 media url；没有源文件记录时为 null。 */
  mediaUrl: string | null;
  /** 旧目录没有结构化字幕时为 null。 */
  transcript: TranscriptInfo | null;
  /** 生成这份字幕时用的 ASR 模型；旧目录为 null。 */
  asrModel: string | null;
  topics: TopicInfo[];
  corrections: CorrectionEntry[];
};

export type LlmStatus = {
  configured: boolean;
  baseUrl: string | null;
  /** 显式配置的模型名（VNOTE_LLM_MODEL / IDEALSOFT_API_MODEL）。 */
  model: string | null;
  /** 启动时 GET /models 发现并选中的模型名；显式配置或发现失败时为 null。 */
  discoveredModel: string | null;
  /** 模型发现失败的脱敏消息；成功或未尝试时为 null。 */
  error: string | null;
};

export type AsrStatus = {
  /** 固定为本地 sherpa-onnx；桌面端不支持在界面切换远端 ASR。 */
  provider: "sherpa-onnx";
  modelId: string;
  modelPresent: boolean;
};

export type SettingsStatus = {
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
  cacheBytes: number;
  llm: LlmStatus;
  asr: AsrStatus;
  ffmpeg: boolean;
  /** `ffmpeg -version` 第一行的版本号；未安装时为 null。 */
  ffmpegVersion: string | null;
  /** 被环境变量覆盖（因此设置页不可改）的字段。 */
  locked: { notesRoot: boolean; cacheRoot: boolean; modelDir: boolean };
  appVersion: string;
};

export type SettingsPatch = {
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
};

export type DirectoryKind = "notes" | "cache" | "model";

export type TestLlmResult = { ok: boolean; model: string | null; message: string };

export type ExtractTarget =
  | { kind: "new"; sourcePath: string }
  | { kind: "existing"; videoId: VideoId; sourcePath?: string };

export type JobSnapshot =
  | { state: "queued"; jobId: string; kind: JobKind; videoId: VideoId; sourcePath: string }
  | {
      state: "running";
      jobId: string;
      kind: JobKind;
      videoId: VideoId;
      step: JobStep;
      done: number;
      total: number;
      detail: string | null;
      startedAt: string;
      /** 正在生成的主题；只对 kind=notes 与 generate-notes 步骤有意义。 */
      topicId: string | null;
      /** 该主题已完成的切片比例（0–100）；LLM 阶段为 0，切片阶段才前进。 */
      topicPercent: number | null;
    }
  | {
      state: "succeeded";
      jobId: string;
      kind: JobKind;
      videoId: VideoId;
      topicCount: number;
      noteCount: number;
      cacheHits: string[];
      timings: Record<string, number>;
      outputDir: string | null;
    }
  | { state: "failed"; jobId: string; kind: JobKind; videoId: VideoId; message: string }
  | { state: "cancelled"; jobId: string; kind: JobKind; videoId: VideoId };

export type VnoteApi = {
  listLibrary(): Promise<LibraryVideo[]>;
  getVideo(videoId: VideoId): Promise<VideoDetail>;
  renameSpeaker(videoId: VideoId, speakerId: string, name: string): Promise<VideoDetail>;
  deleteUtterance(videoId: VideoId, index: number): Promise<VideoDetail>;
  deleteTopicSegment(videoId: VideoId, topicId: string, segmentIndex: number): Promise<VideoDetail>;
  mergeTopics(videoId: VideoId, topicIds: string[]): Promise<VideoDetail>;
  setTopicSelected(videoId: VideoId, topicId: string, selected: boolean): Promise<VideoDetail>;
  saveCorrections(videoId: VideoId, entries: CorrectionEntry[]): Promise<CorrectionEntry[]>;
  listGlossary(): Promise<CorrectionEntry[]>;
  saveGlossary(entries: CorrectionEntry[]): Promise<CorrectionEntry[]>;
  pickVideo(): Promise<string | null>;
  /** 旧目录没有源文件记录时，重跑前先让用户选回原文件。 */
  pickSource(videoId: VideoId): Promise<string | null>;
  /** 拖拽进来的 File 只有 renderer 侧引用，绝对路径要靠 preload 的 webUtils 取。 */
  pathForFile(file: File): string;
  startExtract(target: ExtractTarget): Promise<{ jobId: string }>;
  /** 只为这些主题生成笔记；必须非空，空数组会被拒绝。 */
  startNotes(videoId: VideoId, topicIds: string[]): Promise<{ jobId: string }>;
  /** 用已存字幕重新划主题并生成全部笔记。 */
  rebuildTopics(videoId: VideoId): Promise<{ jobId: string }>;
  cancelExtract(jobId: string): Promise<void>;
  activeJob(): Promise<JobSnapshot | null>;
  onJob(listener: (job: JobSnapshot) => void): () => void;
  settings(): Promise<SettingsStatus>;
  updateSettings(patch: SettingsPatch): Promise<SettingsStatus>;
  pickDirectory(kind: DirectoryKind): Promise<string | null>;
  clearCache(): Promise<{ freedBytes: number }>;
  testLlm(): Promise<TestLlmResult>;
  reveal(outputDir: string): Promise<void>;
};

export const IPC = {
  listLibrary: "library:list",
  getVideo: "video:detail",
  renameSpeaker: "video:rename-speaker",
  deleteUtterance: "video:delete-utterance",
  deleteTopicSegment: "video:delete-segment",
  mergeTopics: "video:merge-topics",
  setTopicSelected: "video:set-topic-selected",
  saveCorrections: "video:save-corrections",
  listGlossary: "glossary:list",
  saveGlossary: "glossary:save",
  pickVideo: "dialog:pick-video",
  pickSource: "dialog:pick-source",
  startExtract: "extract:start",
  startNotes: "notes:start",
  rebuildTopics: "topics:rebuild",
  cancelExtract: "extract:cancel",
  activeJob: "extract:active",
  jobEvent: "extract:event",
  settings: "settings:status",
  updateSettings: "settings:update",
  pickDirectory: "settings:pick-dir",
  clearCache: "settings:clear-cache",
  testLlm: "settings:test-llm",
  reveal: "shell:reveal",
} as const;
