import type { Segment } from "./types";
import type { TopicStatus } from "./video-data";

/** 停止增长多久后补尾段；必须严格超过，恰好等于不补（#121 第 28、26 条）。 */
export const GROWTH_IDLE_SECONDS = 30;
const EPS = 1e-6;

export type TaskStatus = "waiting" | "running" | "done" | "failed";
export type OrganizeStatus = "unorganized" | "organizing" | "finished";

/** 来源字幕行；确认弹窗按它勾选，切片记录按快照保存。 */
export type SubtitleLine = {
  id: string;
  start: number;
  end: number;
  speaker?: string;
  text: string;
};

/** 分析结果里 AI 建议的一个主题；`lineIds` 是 AI 建议的字幕行。 */
export type ProposedTopic = {
  id: string;
  title: string;
  category: string;
  lineIds: string[];
};

export type TopicState = ProposedTopic & { status: TopicStatus };

/** 一个来源文件的一个整理分块；一次「字幕解析 + 主题分析」。 */
export type AnalysisJob = {
  id: number;
  fileId: string;
  name: string;
  start: number;
  end: number;
  status: TaskStatus;
  stage: 0 | 1;
  topics: TopicState[];
  /** 失败终态的短原因；真实执行器结算时写入。 */
  error?: string;
};

/** 一个主题一个切片任务。 */
export type SliceJob = {
  id: number;
  topicKey: string;
  fileId: string;
  title: string;
  lines: SubtitleLine[];
  segments: Segment[];
  durationSeconds: number;
  status: TaskStatus;
  error?: string;
};

export type ClipRecord = {
  id: number;
  topicKey: string;
  fileId: string;
  title: string;
  category: string;
  lines: SubtitleLine[];
  segments: Segment[];
  durationSeconds: number;
};

export type ProjectFile = {
  id: string;
  name: string;
  durationSeconds: number;
  growing: boolean;
  /** 最近一次增长（或加入）时的项目时钟秒数。 */
  lastGrowthSeconds: number;
  added: boolean;
  /** 已经划分成分块的时间轴位置。 */
  cursorSeconds: number;
  /** 从开头起连续、所有主题都已切片的分块终点。 */
  processedSeconds: number;
};

/** 执行器可注入：真正的 ASR/LLM 与 ffmpeg 由调用方接；控制器只负责排队与状态。 */
export type ProjectExecutor = {
  analyze(job: AnalysisJob): void;
  slice(job: SliceJob): void;
};

export type ClipProjectOptions = {
  executor: ProjectExecutor;
  autoSlice?: boolean;
  chunkMinutes?: number;
  /** 来源视频当前已知的全部字幕；确认弹窗与切片快照都按它解析行 id。 */
  transcriptOf: (fileId: string) => SubtitleLine[];
  /** 项目时钟，单位秒；默认从 0 开始。 */
  now?: number;
};

export type AddFileInput = {
  id: string;
  name: string;
  durationSeconds: number;
  growing: boolean;
  modifiedSeconds: number;
};

function clampChunkMinutes(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(30, Math.max(1, Math.round(value)));
}

/**
 * 整理切片项目控制器（纯状态机）：分块入队、两条串行队列、三种整理状态、
 * 自动切片开关、单主题确认、未切片内容时长。时间与执行器都由外部注入，
 * 不碰文件系统、不读时钟、不启动进程。
 */
export class ClipProject {
  readonly files = new Map<string, ProjectFile>();
  analysisQueue: AnalysisJob[] = [];
  sliceQueue: SliceJob[] = [];
  clips: ClipRecord[] = [];
  autoSlice: boolean;
  clock: number;

  private readonly executor: ProjectExecutor;
  private readonly transcriptOf: (fileId: string) => SubtitleLine[];
  private chunkSeconds: number;
  private jobSerial = 0;
  private sliceSerial = 0;
  private clipSerial = 0;

  constructor(options: ClipProjectOptions) {
    this.executor = options.executor;
    this.transcriptOf = options.transcriptOf;
    this.autoSlice = options.autoSlice ?? true;
    this.chunkSeconds = clampChunkMinutes(options.chunkMinutes ?? 10) * 60;
    this.clock = options.now ?? 0;
  }

  get chunkMinutes(): number {
    return Math.round(this.chunkSeconds / 60);
  }

  addFile(input: AddFileInput): ProjectFile {
    const file: ProjectFile = {
      id: input.id,
      name: input.name,
      durationSeconds: input.durationSeconds,
      growing: input.growing,
      lastGrowthSeconds: input.modifiedSeconds,
      added: false,
      cursorSeconds: 0,
      processedSeconds: 0,
    };
    this.files.set(file.id, file);
    return file;
  }

  /** 外部探针报告文件变长：更新时长并把「最后一次增长」推到当前时钟。 */
  reportGrowth(fileId: string, durationSeconds: number): void {
    const file = this.requireFile(fileId);
    if (durationSeconds <= file.durationSeconds + EPS) return;
    file.durationSeconds = durationSeconds;
    file.growing = true;
    file.lastGrowthSeconds = this.clock;
    this.enqueueDue();
    this.pump();
  }

  /** 停止 / 恢复增长；恢复增长时从当前时钟重新计算 30 秒。 */
  setGrowing(fileId: string, growing: boolean): void {
    const file = this.requireFile(fileId);
    file.growing = growing;
    if (growing) file.lastGrowthSeconds = this.clock;
    this.enqueueDue();
    this.pump();
  }

  startOrganize(fileIds: string[]): void {
    for (const id of fileIds) this.requireFile(id).added = true;
    this.enqueueDue();
    this.pump();
  }

  /** 推进项目时钟；增长、凑块、尾段、状态都按它判断。 */
  tick(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.clock += seconds;
    this.enqueueDue();
    this.pump();
  }

  setChunkMinutes(minutes: number): void {
    this.chunkSeconds = clampChunkMinutes(minutes) * 60;
    this.enqueueDue();
    this.pump();
  }

  /** 打开时把已有的待确认主题全部入切片队列；关闭时已入队的任务继续。 */
  setAutoSlice(enabled: boolean): void {
    if (this.autoSlice === enabled) return;
    this.autoSlice = enabled;
    if (enabled) this.enqueueProposedTopics();
    this.pump();
  }

  completeAnalysis(jobId: number, topics: ProposedTopic[]): void {
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "running");
    if (!job) return;
    job.status = "done";
    job.stage = 1;
    job.topics = topics.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      lineIds: [...t.lineIds],
      status: "proposed",
    }));
    if (this.autoSlice) this.enqueueProposedTopics();
    this.refreshProcessed(job.fileId);
    this.pump();
  }

  completeSlice(jobId: number): void {
    const job = this.sliceQueue.find((j) => j.id === jobId && j.status === "running");
    if (!job) return;
    job.status = "done";
    const topic = this.findTopic(job.topicKey)?.topic;
    if (topic) topic.status = "done";
    this.clipSerial += 1;
    this.clips.push({
      id: this.clipSerial,
      topicKey: job.topicKey,
      fileId: job.fileId,
      title: job.title,
      category: topic?.category ?? "",
      lines: [...job.lines],
      segments: job.segments.map((s) => ({ ...s })),
      durationSeconds: job.durationSeconds,
    });
    this.refreshProcessed(job.fileId);
    this.pump();
  }

  /** 分析失败：任务落 failed 终态并释放分析槽；分块不重排，视频保持未处理到这一段。 */
  failAnalysis(jobId: number, message: string): boolean {
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "running");
    if (job === undefined) return false;
    job.status = "failed";
    job.error = message;
    this.pump();
    return true;
  }

  /** 切片失败：任务与所属主题都落 failed，不产出切片、不写项目清单。 */
  failSlice(jobId: number, message: string): boolean {
    const job = this.sliceQueue.find((j) => j.id === jobId && j.status === "running");
    if (job === undefined) return false;
    job.status = "failed";
    job.error = message;
    const topic = this.findTopic(job.topicKey)?.topic;
    if (topic !== undefined) {
      topic.status = "failed";
      topic.lineIds = job.lines.map((line) => line.id);
    }
    this.pump();
    return true;
  }

  /**
   * 确认单个主题：按 `lineIds` 的字幕行快照建一个切片任务。
   * 空选、主题不存在、已经入队过都返回 false，不改变任何状态。
   */
  confirmTopic(topicKeyValue: string, lineIds: string[]): boolean {
    const located = this.findTopic(topicKeyValue);
    if (!located || located.topic.status !== "proposed") return false;
    const { job, topic } = located;
    const wanted = new Set(lineIds);
    const lines = this.transcriptOf(job.fileId)
      .filter((line) => wanted.has(line.id))
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map((line) => ({ ...line }));
    if (lines.length === 0) return false;
    topic.status = "queued";
    topic.lineIds = lines.map((line) => line.id);
    const segments = mergeLines(lines);
    this.sliceSerial += 1;
    this.sliceQueue.push({
      id: this.sliceSerial,
      topicKey: topicKeyValue,
      fileId: job.fileId,
      title: topic.title,
      lines,
      segments,
      durationSeconds: segments.reduce((sum, s) => sum + (s.end - s.start), 0),
      status: "waiting",
    });
    this.pump();
    return true;
  }

  statusOf(fileId: string): OrganizeStatus {
    const file = this.requireFile(fileId);
    if (!file.added) return "unorganized";
    const idle = this.clock - file.lastGrowthSeconds > GROWTH_IDLE_SECONDS;
    const allSliced = file.processedSeconds >= file.durationSeconds - EPS;
    return idle && allSliced ? "finished" : "organizing";
  }

  /** 视频时长 − 从开头起连续、全部主题都已切片的分块时长。 */
  unslicedSeconds(fileId: string): number {
    const file = this.requireFile(fileId);
    return Math.max(0, file.durationSeconds - file.processedSeconds);
  }

  proposedTopics(): TopicState[] {
    return this.analysisQueue.flatMap((job) => job.topics.filter((t) => t.status === "proposed"));
  }

  private requireFile(fileId: string): ProjectFile {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`未知文件：${fileId}`);
    return file;
  }

  private findTopic(key: string): { job: AnalysisJob; topic: TopicState } | undefined {
    // 主题 id 由模型给出，可能自带冒号：只按第一个冒号拆出分析任务序号
    const parsed = splitTopicKey(key);
    if (parsed === undefined) return undefined;
    const job = this.analysisQueue.find((j) => j.id === parsed.jobId);
    const topic = job?.topics.find((t) => t.id === parsed.topicId);
    return job && topic ? { job, topic } : undefined;
  }

  private enqueueDue(): void {
    for (const file of this.files.values()) {
      if (!file.added) continue;
      const idle = this.clock - file.lastGrowthSeconds > GROWTH_IDLE_SECONDS;
      for (;;) {
        const remaining = file.durationSeconds - file.cursorSeconds;
        const fullChunk = remaining >= this.chunkSeconds - EPS;
        const tail = idle && remaining > EPS;
        if (!fullChunk && !tail) break;
        const end = Math.min(file.cursorSeconds + this.chunkSeconds, file.durationSeconds);
        this.jobSerial += 1;
        this.analysisQueue.push({
          id: this.jobSerial,
          fileId: file.id,
          name: file.name,
          start: file.cursorSeconds,
          end,
          status: "waiting",
          stage: 0,
          topics: [],
        });
        file.cursorSeconds = end;
      }
    }
  }

  private pump(): void {
    if (!this.analysisQueue.some((j) => j.status === "running")) {
      const next = this.analysisQueue.find((j) => j.status === "waiting");
      if (next) {
        next.status = "running";
        this.executor.analyze(next);
      }
    }
    if (!this.sliceQueue.some((j) => j.status === "running")) {
      const next = this.sliceQueue.find((j) => j.status === "waiting");
      if (next) {
        next.status = "running";
        // 主题状态跟着切片任务走：queued → generating → done/failed（#126）
        const topic = this.findTopic(next.topicKey)?.topic;
        if (topic !== undefined && topic.status === "queued") topic.status = "generating";
        this.executor.slice(next);
      }
    }
  }

  private enqueueProposedTopics(): void {
    for (const job of this.analysisQueue) {
      for (const topic of job.topics) {
        if (topic.status === "proposed") this.confirmTopic(topicKey(job.id, topic.id), topic.lineIds);
      }
    }
  }

  private refreshProcessed(fileId: string): void {
    const file = this.requireFile(fileId);
    let end = 0;
    for (const job of this.analysisQueue) {
      if (job.fileId !== fileId) continue;
      if (job.start > end + EPS) break;
      if (job.status !== "done" || job.topics.some((t) => t.status !== "done")) break;
      end = job.end;
    }
    file.processedSeconds = end;
  }
}

export function topicKey(jobId: number, topicId: string): string {
  return `${jobId}:${topicId}`;
}

/** `topicKey` 的逆运算：只按第一个冒号拆，主题 id 自带的冒号原样保留（#126）。 */
export function splitTopicKey(key: string): { jobId: number; topicId: string } | undefined {
  const sep = key.indexOf(":");
  if (sep <= 0) return undefined;
  const jobId = Number(key.slice(0, sep));
  const topicId = key.slice(sep + 1);
  if (!Number.isInteger(jobId) || topicId === "") return undefined;
  return { jobId, topicId };
}

function mergeLines(lines: SubtitleLine[]): Segment[] {
  const segments: Segment[] = [];
  for (const line of lines) {
    const last = segments[segments.length - 1];
    if (last !== undefined && line.start <= last.end + EPS) {
      last.end = Math.max(last.end, line.end);
    } else {
      segments.push({ start: line.start, end: line.end });
    }
  }
  return segments;
}
