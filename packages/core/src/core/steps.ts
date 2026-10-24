import type { Chunk, CorrectionList, Note, Topic, TopicId, Transcript, Video } from "./types";

export type StepName = "transcribe" | "segment-topics" | "generate-notes";

export type Progress = {
  step: StepName;
  done: number;
  total: number;
  detail?: string;
  /** 当前正在处理的主题(逐主题进度,ADR-0014 桌面端进度条)。 */
  topicId?: string;
  /** 当前主题内部进度 0-100(切片段时按已完成段数计)。 */
  topicPercent?: number;
};

/** 本次运行的触发原因：首次生成、强制重生成、说话人合并后重生成。 */
export type TrajectoryTrigger = "initial" | "regenerate" | "speaker-changed";
export type LlmEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ChatMessage = { role: "system" | "user"; content: string };

/** 端点的一次补全调用；实现见 `llm/openai.ts`。 */
export type LlmClient = {
  model: string;
  chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<string>;
  /** 本客户端自创建以来的累计用量；测试假客户端可以不实现。 */
  usage?: () => LlmUsage;
};

/** token 计数快照；一次运行的用量取运行前后两次快照的差值（ADR-0009）。从未收到 usage 时各计数为 0。 */
export type LlmUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** 第一步：把视频语音变成字幕行，并给出说话人和每行的起止时间。 */
export type TranscribeInput = {
  video: Video;
  /** 已抽出的单声道 16k 采样率 wav。 */
  audioPath: string;
  chunks: Chunk[];
  onProgress?: (p: Progress) => void;
};

export type TranscribeResult = Transcript;

export type Transcribe = (input: TranscribeInput) => Promise<TranscribeResult>;

/** 第二步：在字幕行上划出主题与各主题的时间段，给每个主题起标题、写摘要。 */
export type SegmentTopicsInput = {
  /** 已按纠错词表做字面替换的字幕。 */
  transcript: Transcript;
  chunks: Chunk[];
  endpoint: LlmEndpoint;
  /** 缓存根目录；每块候选与全局合并各存一份（ADR-0006）。 */
  cacheDir: string;
  /** 合并后的术语表（全局 + 本视频），随提示词注入正确写法；不传视为空表。 */
  corrections?: CorrectionList;
  /** 测试注入的假端点；不传就按 endpoint 建真实客户端。 */
  client?: LlmClient;
  onProgress?: (p: Progress) => void;
};

export type SegmentTopicsResult = {
  topics: Topic[];
};

export type SegmentTopics = (input: SegmentTopicsInput) => Promise<SegmentTopicsResult>;

/** 第三步：按选定的主题产出笔记与该主题的切片。 */
export type GenerateNotesInput = {
  video: Video;
  transcript: Transcript;
  topics: Topic[];
  /** 用户选定要生成笔记的主题的目录名,由调用方分配(重新分块/编辑时保持旧名,ADR-0014);不在 map 里的主题跳过。 */
  dirNames: Map<TopicId, string>;
  /** 生成笔记时随请求传给模型的正确写法。 */
  corrections: CorrectionList;
  endpoint: LlmEndpoint;
  /** 缓存根目录；每主题的笔记与切片各自落盘（ADR-0006）。 */
  cacheDir: string;
  /** 测试注入的假端点；不传就按 endpoint 建真实客户端。 */
  client?: LlmClient;
  onProgress?: (p: Progress) => void;
  /** 单主题内部进度(开始/切完片段),供调用方记回 `video.json` 的 startedAt 等字段。 */
  onTopicProgress?: (p: { topicId: TopicId; percent: number; phase: "start" | "clips-done" }) => void;
  /** 本次运行的触发原因（缺省按首次生成），写进主题目录的 trajectory.json。 */
  trigger?: TrajectoryTrigger;
};

export type GenerateNotesResult = {
  notes: Note[];
  /** 本次实际写出的主题目录名（相对视频输出目录），顺序与写入一致。 */
  topicDirs: string[];
  /** 本次要点缓存命中的 cacheKey.hash 集合，命中与未命中都算「用过」。 */
  noteCacheKeys: string[];
};

export type GenerateNotes = (input: GenerateNotesInput) => Promise<GenerateNotesResult>;
