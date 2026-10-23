/** renderer 与 main 之间的线上契约。core 内部类型不直接穿过 IPC（ADR-0012、ADR-0014、ADR-0015）。 */

export type VideoId = string;

export type CoreStep = "transcribe" | "segment-topics" | "generate-notes";
export type JobStep = CoreStep | "prepare" | "cleanup";

/** 三类任务共用一条串行队列；界面按 kind 决定刷新什么。 */
export type JobKind = "extract" | "notes" | "topics";

/** 库卡片状态：完成、部分完成、待确认主题、生成中、需重跑、失败。 */
export type VideoStatus = "done" | "pending-confirm" | "partial" | "in-progress" | "needs-rerun" | "failed";

export type TopicStatus = "proposed" | "queued" | "generating" | "done" | "failed" | "needs-rerun";

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
  /** 每个主题段在拼接文件里的起点偏移（秒，含前移与合并）；旧文档没有时为 []。 */
  segmentOffsets: number[];
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

export type VideoResolution = { width: number; height: number };

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
  /** 源视频分辨率；旧文档没有记录时为 null，卡片省略该项（ADR-0015 §6）。 */
  resolution: VideoResolution | null;
  topicCount: number;
  clipCount: number;
  updatedAt: string | null;
  /** 封面 media url；`cover.jpg` 不存在或为空时为 null。 */
  coverUrl: string | null;
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
  /** 生成这份字幕时用的引擎；旧目录为 null，旧 `remote` 在读取时映射为 `openai`（ADR-0016 §9）。 */
  asrEngine: "local" | "openai" | "volcengine" | null;
  topics: TopicInfo[];
  corrections: CorrectionEntry[];
};

/** 密钥来源：环境变量/种子（仅 dev 模式的 ASR 字段与 LLM 种子）、系统密钥库、没有。 */
export type KeySource = "env" | "stored" | "none";

export type AsrProvider = "local" | "openai" | "volcengine";
export type VolcengineMode = "flash" | "standard";
export type VolcengineAuthMode = "apiKey" | "appAccessKey";

export type LlmStatus = {
  configured: boolean;
  /** 只回显 origin+pathname；userinfo/query/fragment 在设置层被拒绝。 */
  baseUrl: string | null;
  /** 显式配置的模型名；留空为 null。 */
  model: string | null;
  /** GET /models 发现并选中的模型名；显式配置或发现失败时为 null。 */
  discoveredModel: string | null;
  /** 生效中的 key 明文（密钥库或 dev 种子）；设置页输入框回显它，没有 key 时为 null（ADR-0024）。 */
  apiKey: string | null;
  hasKey: boolean;
  /** "env" 只可能来自 dev 模式的 .env 种子；打包版只有 "stored" 或 "none"。 */
  keySource: KeySource;
  keyStorageAvailable: boolean;
  error: string | null;
};

export type AsrCredentialStatus = {
  hasKey: boolean;
  /** "env" 同时表示该字段由环境变量提供，界面据此显示「由环境变量控制」。 */
  keySource: KeySource;
  keyStorageAvailable: boolean;
};

export type AsrStatus = {
  provider: AsrProvider;
  providerLocked: boolean;
  local: { modelId: string; ready: boolean; missing: string[] };
  openai: {
    baseUrl: string;
    model: string;
    hasKey: boolean;
    keySource: KeySource;
    keyStorageAvailable: boolean;
    locked: { baseUrl: boolean; model: boolean };
    error: string | null;
  };
  volcengine: {
    mode: VolcengineMode;
    modeLocked: boolean;
    authMode: VolcengineAuthMode;
    authModeLocked: boolean;
    apiKey: AsrCredentialStatus;
    appKey: AsrCredentialStatus;
    accessKey: AsrCredentialStatus;
    error: string | null;
  };
};

export type ModelFileStatus = {
  path: string;
  present: boolean;
  bytes: number | null;
  expectedBytes: number;
  sha256: string;
  /** null = 未校验；true/false = 本进程内校验过。 */
  verified: boolean | null;
};

export type ModelBundleStatus = {
  id: "asr" | "diarization" | "speaker-embedding" | "punctuation";
  title: string;
  /** unverified = 文件齐、字节数对，但本进程还没算过 sha256。 */
  state: "ready" | "unverified" | "missing" | "invalid";
  files: ModelFileStatus[];
};

export type DownloadSnapshot = {
  state: "idle" | "downloading" | "verifying" | "installing" | "done" | "failed" | "cancelled";
  bundleId: string | null;
  /** 当前包；总长未知时 totalBytes=0、percent=null。 */
  receivedBytes: number;
  totalBytes: number;
  percent: number | null;
  message: string | null;
};

export type ModelsStatus = {
  modelDir: string;
  locked: boolean;
  ready: boolean;
  bundles: ModelBundleStatus[];
  totalBytes: number;
  presentBytes: number;
  download: DownloadSnapshot;
};

/** 下载日志一行；at 是 main 收到 core 输出时的时间戳（ISO）。 */
export type ModelLogEntry = { at: string; level: "info" | "warn" | "error"; text: string };

/** 下载事件：进度快照 + 截至此刻的全部日志（有上限，旧行被裁掉）。 */
export type ModelDownloadEvent = { snapshot: DownloadSnapshot; log: ModelLogEntry[] };

export type SettingsStatus = {
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
  cacheBytes: number;
  llm: LlmStatus;
  asr: AsrStatus;
  /** 模型摘要；完整状态走 models:status。 */
  models: { ready: boolean; totalBytes: number; presentBytes: number };
  /** 坏配置已被隔离时的可读原因（ADR-0015 §3）。 */
  settingsFileError: string | null;
  /** 版本功能开关（r26）：云端 ASR 默认关闭，界面据此隐藏提供方切换。 */
  features: { cloudAsr: boolean };
  ffmpeg: boolean;
  /** `ffmpeg -version` 第一行的版本号；未安装时为 null。 */
  ffmpegVersion: string | null;
  /** 被环境变量覆盖（因此设置页不可改）的字段。 */
  locked: {
    notesRoot: boolean;
    cacheRoot: boolean;
    modelDir: boolean;
    asrProvider: boolean;
    asrBaseUrl: boolean;
    asrModel: boolean;
    volcMode: boolean;
    volcAuthMode: boolean;
  };
  appVersion: string;
};

export type SettingsPatch = {
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  asr?: {
    provider?: AsrProvider;
    openai?: { baseUrl?: string; model?: string };
    volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
  };
};

/** 密钥补丁：只上行，永不下行；两者同传会被拒绝。 */
export type SecretPatch = { apiKey?: string; clearApiKey?: boolean };

/** LLM 表单草稿：测试连接与拉取模型都用它，不需要先保存。apiKey 为空时 main 依次回退已存密钥、dev 模式 .env 种子。 */
export type LlmDraft = { baseUrl: string; apiKey: string };

/** 一次保存整个 LLM 表单：baseUrl/model 写 settings.json，apiKey 非空时写密钥库，同一事务。 */
export type LlmUpdatePatch = { baseUrl: string; model: string; apiKey?: string };

export type AsrSecretField = "openaiKey" | "volcApiKey" | "volcAppKey" | "volcAccessKey";

export type AsrUpdatePatch = {
  provider?: AsrProvider;
  openai?: { baseUrl?: string; model?: string };
  volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
  /** 一次只改一个密钥；value 与 clear 同传拒绝。 */
  secret?: { field: AsrSecretField; value?: string; clear?: boolean };
};

export type DirectoryKind = "notes" | "cache" | "model";

export type TestLlmResult = { ok: boolean; model: string | null; message: string };

/** 「拉取模型」结果：成功时 models 为全部可选 id（未筛选），失败时 message 是可读原因。 */
export type LlmModelListResult = { ok: boolean; models: string[]; message: string };

export type TestAsrResult = { ok: boolean; modelsFound: number | null; message: string };

export type ImportModelsResult = {
  canceled: boolean;
  installed: string[];
  rejected: { bundleId: string; reason: string }[];
  status: ModelsStatus;
};

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

/** `library:covers` 事件 payload：本轮后台封面补齐成功补齐的 videoId 列表。 */
export type LibraryCovers = string[];

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
  /** 封面后台补齐完成后广播；payload 是成功补齐的 videoId。 */
  onLibraryCovers(listener: (videoIds: LibraryCovers) => void): () => void;
  settings(): Promise<SettingsStatus>;
  updateSettings(patch: SettingsPatch): Promise<SettingsStatus>;
  updateLlm(patch: LlmUpdatePatch): Promise<SettingsStatus>;
  updateAsr(patch: AsrUpdatePatch): Promise<SettingsStatus>;
  pickDirectory(kind: DirectoryKind): Promise<string | null>;
  clearCache(): Promise<{ freedBytes: number }>;
  testLlm(draft: LlmDraft): Promise<TestLlmResult>;
  /** 用草稿里的 base url + key 拉取 <base>/models，结果交给用户选择。 */
  listLlmModels(draft: LlmDraft): Promise<LlmModelListResult>;
  testAsr(): Promise<TestAsrResult>;
  models(): Promise<ModelsStatus>;
  downloadModels(): Promise<ModelsStatus>;
  cancelModelDownload(): Promise<ModelsStatus>;
  importModels(): Promise<ImportModelsResult>;
  verifyModels(): Promise<ModelsStatus>;
  /** 端点发现落定（成功或失败）：重新拉一次 settings 即可拿到 discoveredModel。 */
  onLlmChanged(listener: () => void): () => void;
  onModelDownload(listener: (event: ModelDownloadEvent) => void): () => void;
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
  libraryCovers: "library:covers",
  settings: "settings:status",
  updateSettings: "settings:update",
  updateLlm: "settings:llm-update",
  llmEvent: "settings:llm-event",
  updateAsr: "settings:asr-update",
  pickDirectory: "settings:pick-dir",
  clearCache: "settings:clear-cache",
  testLlm: "settings:test-llm",
  listLlmModels: "settings:list-llm-models",
  testAsr: "settings:test-asr",
  models: "models:status",
  downloadModels: "models:download",
  cancelModelDownload: "models:cancel",
  importModels: "models:import",
  verifyModels: "models:verify",
  modelEvent: "models:event",
  reveal: "shell:reveal",
} as const;
