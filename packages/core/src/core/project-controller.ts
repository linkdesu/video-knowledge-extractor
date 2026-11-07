import type { Segment } from "./types";
import type { TopicStatus, VideoData } from "./video-data";

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
  /** 主题分析的窗口进度（#155）：只在 running 期间有值，终态清空。 */
  progress?: { done: number; total: number };
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
  /**
   * 时长是否可读（ffprobe）。读不出时按「仍在增长」处理：不入队、不判定整理结束（#132）。
   * 此时 `durationSeconds` 只是最后一次读到的值（没读到过就是 0）。
   */
  durationKnown: boolean;
  growing: boolean;
  /** 最近一次增长（或加入）时的项目时钟秒数。 */
  lastGrowthSeconds: number;
  added: boolean;
  /** 文件还在监控目录里；被删除 / 改名后为 false，不再入队（#132 评审 P2）。 */
  present: boolean;
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
  /** 智能语义分块（#155）：停止增长后剩余区间整段入队；默认开启。 */
  semanticChunking?: boolean;
  /** 来源视频当前已知的全部字幕；确认弹窗与切片快照都按它解析行 id。 */
  transcriptOf: (fileId: string) => SubtitleLine[];
  /** 项目时钟，单位秒；默认从 0 开始。 */
  now?: number;
};

export type AddFileInput = {
  id: string;
  name: string;
  /** null = 时长读不出；文件按「还在增长」处理，不产生分块（#132）。 */
  durationSeconds: number | null;
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
  /**
   * 已要求「开始整理」、但文件元数据还没登记（监控首轮轮询之前）的 id。
   * 登记到达时自动加入：否则界面显示已加入、控制器永远不知道，按钮也点不动（#132 D3）。
   */
  private readonly requested = new Set<string>();
  private chunkSeconds: number;
  /** 智能语义分块开关（#155）：见 `ClipProjectOptions.semanticChunking`。 */
  private semanticChunking: boolean;
  private jobSerial = 0;
  private sliceSerial = 0;
  private clipSerial = 0;
  /** 项目已删除：pump 不再启动任务，所有终态/重试写入一律忽略（#154）。 */
  private disposed = false;

  constructor(options: ClipProjectOptions) {
    this.executor = options.executor;
    this.transcriptOf = options.transcriptOf;
    this.autoSlice = options.autoSlice ?? true;
    this.chunkSeconds = clampChunkMinutes(options.chunkMinutes ?? 10) * 60;
    this.semanticChunking = options.semanticChunking !== false;
    this.clock = options.now ?? 0;
  }

  get chunkMinutes(): number {
    return Math.round(this.chunkSeconds / 60);
  }

  /** 智能语义分块开关的只读视图（#155）。 */
  get semanticChunkingEnabled(): boolean {
    return this.semanticChunking;
  }

  addFile(input: AddFileInput): ProjectFile {
    const existing = this.files.get(input.id);
    const known =
      input.durationSeconds !== null &&
      Number.isFinite(input.durationSeconds) &&
      input.durationSeconds >= 0;
    if (existing !== undefined) {
      // 监控轮询 / 视频库注册会反复登记同一文件：只补元数据，队列进度与已加入状态不重置（#132）
      existing.name = input.name;
      existing.present = true;
      if (this.requested.delete(input.id)) existing.added = true;
      if (known && input.durationSeconds !== null) {
        if (input.durationSeconds > existing.durationSeconds + EPS) existing.durationSeconds = input.durationSeconds;
        existing.durationKnown = true;
      }
      return existing;
    }
    const file: ProjectFile = {
      id: input.id,
      name: input.name,
      durationSeconds: known && input.durationSeconds !== null ? input.durationSeconds : 0,
      durationKnown: known,
      growing: input.growing,
      lastGrowthSeconds: input.modifiedSeconds,
      // 已经在「开始整理」里点过的文件，元数据一到达就算已加入（#132 D3）
      added: this.requested.delete(input.id),
      present: true,
      cursorSeconds: 0,
      processedSeconds: 0,
    };
    this.files.set(file.id, file);
    return file;
  }

  /**
   * 外部探针报告文件变了（大小或修改时间）：把「最后一次增长」推到当前时钟。
   * 时长读不出（null）或没变长时也要推进增长时间——文件还在写，不能算停止增长。
   * 读不出时长时同时标记 `durationKnown=false`，尾段不会入队（#132）。
   */
  reportGrowth(fileId: string, durationSeconds: number | null): void {
    const file = this.requireFile(fileId);
    if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      if (durationSeconds > file.durationSeconds + EPS) file.durationSeconds = durationSeconds;
      file.durationKnown = true;
    } else {
      file.durationKnown = false;
    }
    file.growing = true;
    file.lastGrowthSeconds = this.clock;
    this.enqueueDue();
    this.pump();
  }

  /** 监控目录里消失（删除 / 改名）的文件：停止增长与入队，已入队任务不受影响。 */
  markMissing(fileId: string): boolean {
    const file = this.files.get(fileId);
    if (file === undefined || !file.present) return false;
    file.present = false;
    file.growing = false;
    return true;
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
    for (const id of fileIds) {
      const file = this.files.get(id);
      if (file === undefined) {
        // 监控首轮轮询之前就点了「开始整理」：先记下意图，元数据登记到达时再生效（#132 D3）
        this.requested.add(id);
        continue;
      }
      file.added = true;
    }
    this.enqueueDue();
    this.pump();
  }

  /** 推进项目时钟；增长、凑块、尾段、状态都按它判断。 */
  tick(seconds: number): void {
    this.advanceClock(seconds);
    this.settle();
  }

  /**
   * 只推进时钟、不结算队列。监控一轮要在读取增长之前把时钟推到当前时刻，
   * 否则增长时间会落在上一轮，凭空多出一次轮询间隔的静默（#132 评审 P1）。
   */
  advanceClock(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.clock += seconds;
  }

  /** 按当前时钟结算：凑满一块 / 超过 30 秒的尾段入队，并启动等待中的任务。 */
  settle(): void {
    this.enqueueDue();
    this.pump();
  }

  setChunkMinutes(minutes: number): void {
    this.chunkSeconds = clampChunkMinutes(minutes) * 60;
    this.enqueueDue();
    this.pump();
  }

  /** 切智能语义分块开关并立即重排：已入队任务不动，只影响以后产生的分块（#155）。 */
  setSemanticChunking(enabled: boolean): void {
    this.semanticChunking = enabled;
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

  /**
   * 运行中的分析任务推进到第二阶段（转写完成 → 主题分析开始），由执行器在真实进度回调里调用。
   * 只前进不回退，终态不再改；返回是否真的变了，调用方据此决定要不要推送详情。
   */
  advanceAnalysisStage(jobId: number, stage: 0 | 1): boolean {
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "running");
    if (job === undefined || job.stage >= stage) return false;
    job.stage = stage;
    return true;
  }

  /**
   * 运行中的分析任务回报主题分析窗口进度（#155）：`done/total`，由执行器在真实进度回调里调用。
   * 只对 running 任务生效；total ≤ 0、非整数、负数等非法数值返回 false 且不改状态；返回是否真的变了。
   */
  advanceAnalysisProgress(jobId: number, done: number, total: number): boolean {
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "running");
    if (job === undefined) return false;
    if (!Number.isInteger(done) || !Number.isInteger(total) || done < 0 || total <= 0) return false;
    if (job.progress?.done === done && job.progress.total === total) return false;
    job.progress = { done, total };
    return true;
  }

  /**
   * 重启后从已落盘切片恢复「已处理」进度：只增不减。
   * 进度口径与 `refreshProcessed` 相同，来源换成磁盘上的分块与主题状态。
   * 磁盘记录是「文件至少这么长」的证据：视频库里的时长可能停在导入那一刻，增长中的录制
   * 重启后比它长，按旧时长夹会把已处理压回去、也判定不了整理结束（#132 D2）。
   */
  restoreProcessed(fileId: string, seconds: number): void {
    const file = this.files.get(fileId);
    if (file === undefined || !Number.isFinite(seconds) || seconds < 0) return;
    file.durationSeconds = Math.max(file.durationSeconds, seconds);
    file.processedSeconds = Math.max(file.processedSeconds, seconds);
  }

  /**
   * 重启后恢复「已经划分到哪」：用已落盘分块的最大终点续排，重启不会把整个文件重排一遍（#132 D2）。
   * 与 `restoreProcessed` 是两个口径：cursor 是划分位置，processed 是「已处理并落盘切片」。
   * 只增不减；时长按同一份磁盘证据抬升（见 `restoreProcessed`）。
   */
  restoreCursor(fileId: string, seconds: number): void {
    const file = this.files.get(fileId);
    if (file === undefined || !Number.isFinite(seconds) || seconds < 0) return;
    file.durationSeconds = Math.max(file.durationSeconds, seconds);
    file.cursorSeconds = Math.max(file.cursorSeconds, seconds);
  }

  completeAnalysis(jobId: number, topics: ProposedTopic[]): void {
    if (this.disposed) return;
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "running");
    if (!job) return;
    job.status = "done";
    job.stage = 1;
    job.progress = undefined;
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
    if (this.disposed) return;
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
    if (this.disposed) return false;
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "running");
    if (job === undefined) return false;
    job.status = "failed";
    job.error = message;
    job.progress = undefined;
    this.pump();
    return true;
  }

  /** 切片失败：任务与所属主题都落 failed，不产出切片、不写项目清单。 */
  failSlice(jobId: number, message: string): boolean {
    if (this.disposed) return false;
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
   * 重试失败的分析任务：原地回 waiting、清 error、stage 归 0，不新增任务、不改队列顺序。
   * 只有 failed 任务可重试； disposed / 非 failed / 找不到都返回 false。
   */
  retryAnalysis(jobId: number): boolean {
    if (this.disposed) return false;
    const job = this.analysisQueue.find((j) => j.id === jobId && j.status === "failed");
    if (job === undefined) return false;
    job.status = "waiting";
    job.error = undefined;
    job.stage = 0;
    job.progress = undefined;
    this.pump();
    return true;
  }

  /**
   * 重试失败的切片任务：任务回 waiting、所属主题从 failed 回 queued（pump 会推到 generating）。
   * 只有 failed 任务可重试；disposed / 非 failed / 找不到都返回 false。
   */
  retrySlice(jobId: number): boolean {
    if (this.disposed) return false;
    const job = this.sliceQueue.find((j) => j.id === jobId && j.status === "failed");
    if (job === undefined) return false;
    job.status = "waiting";
    job.error = undefined;
    const topic = this.findTopic(job.topicKey)?.topic;
    if (topic !== undefined && topic.status === "failed") topic.status = "queued";
    this.pump();
    return true;
  }

  /** 项目删除：控制器彻底停摆，pump 不再启动任务，终态/重试写入一律忽略（幂等）。 */
  dispose(): void {
    this.disposed = true;
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

  /** 确认弹窗读来源视频当前已知的完整字幕；未知主题返回空数组，不抛异常。 */
  linesOf(topicKeyValue: string): SubtitleLine[] {
    const located = this.findTopic(topicKeyValue);
    if (located === undefined) return [];
    return this.transcriptOf(located.job.fileId).map((line) => ({ ...line }));
  }

  statusOf(fileId: string): OrganizeStatus {
    const file = this.requireFile(fileId);
    if (!file.added) return "unorganized";
    // 时长读不出 = 还读不出结尾，按「持续整理中」处理，不能判为整理结束（#132）
    if (!file.durationKnown) return "organizing";
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
      if (!file.added || !file.durationKnown || !file.present) continue;
      const idle = this.clock - file.lastGrowthSeconds > GROWTH_IDLE_SECONDS;
      const remaining = file.durationSeconds - file.cursorSeconds;
      // 智能语义分块（#155）：停止增长后剩余区间整段入队一个任务，不再拆固定块。
      // 还在增长时沿用「满一块才入队」：增长期不空等整段，尾段只在停止增长后整段入队。
      if (idle && this.semanticChunking) {
        if (remaining > EPS) this.enqueueChunk(file, file.durationSeconds);
        continue;
      }
      for (;;) {
        const left = file.durationSeconds - file.cursorSeconds;
        const fullChunk = left >= this.chunkSeconds - EPS;
        const tail = idle && left > EPS;
        if (!fullChunk && !tail) break;
        this.enqueueChunk(file, Math.min(file.cursorSeconds + this.chunkSeconds, file.durationSeconds));
      }
    }
  }

  /** 入队一个 [cursor, end] 分析分块并把游标推到 end。 */
  private enqueueChunk(file: ProjectFile, end: number): void {
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

  private pump(): void {
    if (this.disposed) return;
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

  /**
   * 「已处理」= 从开头起连续、全部主题都已切片的分块终点。
   * 重启后队列只从恢复点继续，前面的旧分块不在队列里：缺口落在已恢复进度之内时
   * 不算断档，也不把进度往回压（#132 D2）。
   */
  private refreshProcessed(fileId: string): void {
    const file = this.requireFile(fileId);
    let end = 0;
    for (const job of this.analysisQueue) {
      if (job.fileId !== fileId) continue;
      const gap = job.start > end + EPS;
      if (gap && job.start > file.processedSeconds + EPS) break;
      if (job.status !== "done" || job.topics.some((t) => t.status !== "done")) break;
      end = Math.max(end, job.end);
    }
    file.processedSeconds = Math.max(file.processedSeconds, end);
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

/**
 * 重启恢复：由 `video.json` 的分块与主题状态算出「从开头起连续、全部主题都已切片」的秒数。
 * 口径与 `refreshProcessed` 相同：分块必须从 0 连续，块内主题全部 done 且有落盘切片才计入。
 * `slicedTopicIds` 来自项目清单的 clip 记录，避免把只生成过笔记、没切片的主题算成已处理。
 * 主题按时间段相交归入分块：同一视频若另有边界不同的视频库笔记主题，恢复可能偏保守（偏小）。
 */
export function slicedSecondsFrom(
  data: Pick<VideoData, "chunks" | "topics">,
  slicedTopicIds: ReadonlySet<string>,
): number {
  let end = 0;
  for (const chunk of [...data.chunks].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (chunk.start > end + EPS) break;
    const inChunk = data.topics.filter((topic) =>
      topic.segments.some((segment) => segment.start < chunk.end - EPS && segment.end > chunk.start + EPS),
    );
    if (!inChunk.every((topic) => topic.status === "done" && slicedTopicIds.has(topic.id))) break;
    end = Math.max(end, chunk.end);
  }
  return end;
}
