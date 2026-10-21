import type { Chunk, CorrectionList, Note, Topic, TopicId, Transcript, Video } from "./types";

export type StepName = "transcribe" | "segment-topics" | "generate-notes";

export type Progress = {
  step: StepName;
  done: number;
  total: number;
  detail?: string;
};

/** 设置里只配一个 OpenAI 兼容端点，云端或本地由用户决定（ADR-0005）。 */
export type LlmEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
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
  /** 用户选定要生成笔记的主题；默认全部。 */
  selectedTopicIds: TopicId[];
  /** 生成笔记时随请求传给模型的正确写法。 */
  corrections: CorrectionList;
  endpoint: LlmEndpoint;
  onProgress?: (p: Progress) => void;
};

export type GenerateNotesResult = {
  notes: Note[];
};

export type GenerateNotes = (input: GenerateNotesInput) => Promise<GenerateNotesResult>;
