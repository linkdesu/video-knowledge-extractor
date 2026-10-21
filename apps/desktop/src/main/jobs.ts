import { randomUUID } from "node:crypto";
import type { AsrConfig, LlmEndpoint } from "@video-notes/core";
import type { JobKind, JobSnapshot, JobStep } from "../shared/ipc";

/**
 * 三类任务共用一条串行队列（纯状态机）。并发度 1：同一时刻至多一个 running；
 * 每个任务只能落一次终态（succeeded / failed / cancelled），落完才释放槽位。
 * `launch` 由 main 注入，返回可取消的进程句柄；队列不关心进程细节。
 * 运行中取消只调 handle.cancel()，终态由调用方在进程 exit 后通过 `cancelled` 落。
 */

export type JobHandle = {
  cancel(): void;
  kill(): void;
};

export type JobProgress = { step: JobStep; done: number; total: number; detail: string | null; topicId: string | null; topicPercent: number | null };

/** 入队时冻结的完整任务描述：配置在入队时求值，worker 用冻结值跑，中途改设置不影响运行中任务。 */
export type JobRequest = {
  kind: JobKind;
  videoId: string;
  sourcePath: string;
  /** 可变：extract 在 prepared 回调里由 main 更新（新视频才有 outputDir）。 */
  outputDir: string | null;
  /** 本次运行的 token：写入文档、取消/失败时按它结算（ADR-0015 §7）。 */
  runToken: string;
  /** 冻结解析好的 LLM 端点；公开 DTO 不带它。 */
  endpoint: LlmEndpoint;
  /** 冻结解析好的 ASR 引擎配置；含 key，只在 main/worker 私有消息里。 */
  asr: AsrConfig;
  config: { notesRoot: string; cacheRoot: string; modelDir: string };
  topicIds?: string[];
};

type JobRecord = {
  state: "queued" | "running";
  request: JobRequest;
  handle: JobHandle | undefined;
  progress: JobProgress | undefined;
  startedAt: string | undefined;
  settled: boolean;
};

function runningSnapshot(jobId: string, record: JobRecord): JobSnapshot {
  const p = record.progress ?? { step: "prepare", done: 0, total: 0, detail: null, topicId: null, topicPercent: null };
  return {
    state: "running",
    jobId,
    kind: record.request.kind,
    videoId: record.request.videoId,
    step: p.step,
    done: p.done,
    total: p.total,
    detail: p.detail,
    startedAt: record.startedAt ?? new Date().toISOString(),
    topicId: p.topicId,
    topicPercent: p.topicPercent,
  };
}

export class JobQueue {
  private nextJobId = 1;
  private queue: { jobId: string; record: JobRecord }[] = [];
  private running: { jobId: string; record: JobRecord } | undefined;
  private lastSnapshot: JobSnapshot | undefined;
  private readonly launch: (jobId: string, job: JobRequest) => JobHandle;
  private readonly onChange: (snapshot: JobSnapshot) => void;
  private drainResolve: (() => void) | undefined;

  constructor(opts: {
    launch: (jobId: string, job: JobRequest) => JobHandle;
    onChange: (snapshot: JobSnapshot) => void;
  }) {
    this.launch = opts.launch;
    this.onChange = opts.onChange;
  }

  /** 入队并返回 jobId；立即发 queued 快照，槽位空就自动启动下一个。 */
  enqueue(job: JobRequest): string {
    const jobId = `${randomUUID()}:${this.nextJobId++}`;
    const record: JobRecord = { state: "queued", request: job, handle: undefined, progress: undefined, startedAt: undefined, settled: false };
    this.queue.push({ jobId, record });
    this.emit({ state: "queued", jobId, kind: job.kind, videoId: job.videoId, sourcePath: job.sourcePath });
    this.start();
    return jobId;
  }

  /** 槽位空且队列有任务：取下一个，queued → running，调 launch。 */
  start(): void {
    if (this.running !== undefined) return;
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.drainResolve !== undefined) {
        this.drainResolve();
        this.drainResolve = undefined;
      }
      return;
    }
    if (next.record.settled) {
      this.start();
      return;
    }
    const r = next.record;
    r.state = "running";
    r.startedAt = new Date().toISOString();
    this.running = next;
    r.handle = this.launch(next.jobId, r.request);
    this.emit(runningSnapshot(next.jobId, r));
  }

  progress(p: JobProgress): void {
    const r = this.running;
    if (r === undefined || r.record.state !== "running" || r.record.settled) return;
    r.record.progress = p;
    this.emit(runningSnapshot(r.jobId, r.record));
  }

  finish(result: {
    videoId: string;
    outputDir: string | null;
    topicCount: number;
    noteCount: number;
    cacheHits: string[];
    timings: Record<string, number>;
  }): void {
    const r = this.running;
    if (r === undefined || r.record.state !== "running" || r.record.settled) return;
    this.settle(r, {
      state: "succeeded",
      jobId: r.jobId,
      kind: r.record.request.kind,
      videoId: r.record.request.videoId,
      topicCount: result.topicCount,
      noteCount: result.noteCount,
      cacheHits: result.cacheHits,
      timings: result.timings,
      outputDir: result.outputDir,
    });
  }

  fail(message: string): void {
    const r = this.running;
    if (r === undefined || r.record.state !== "running" || r.record.settled) return;
    this.settle(r, { state: "failed", jobId: r.jobId, kind: r.record.request.kind, videoId: r.record.request.videoId, message });
  }

  /**
   * 排队中：直接落 cancelled（没启动过进程），并尝试启动下一个。
   * 运行中：只调 handle.cancel()；终态必须等 exit 后调 `cancelled` 落。
   */
  cancel(jobId: string): void {
    const item = this.queue.find((i) => i.jobId === jobId);
    if (item !== undefined) {
      if (item.record.settled) return;
      item.record.settled = true;
      this.queue = this.queue.filter((i) => i.jobId !== jobId);
      this.emit({ state: "cancelled", jobId, kind: item.record.request.kind, videoId: item.record.request.videoId });
      this.start();
      return;
    }
    const r = this.running;
    if (r === undefined || r.jobId !== jobId) return;
    if (r.record.settled || r.record.state !== "running") return;
    r.record.handle?.cancel();
  }

  /** 运行中取消的最终落点：必须等进程 exit 后才调用，确保 ffmpeg 子进程收尸。 */
  cancelled(jobId: string): void {
    const r = this.running;
    if (r === undefined || r.jobId !== jobId) return;
    if (r.record.settled || r.record.state !== "running") return;
    this.settle(r, { state: "cancelled", jobId: r.jobId, kind: r.record.request.kind, videoId: r.record.request.videoId });
  }

  /** 应用退出用：排队任务直接 cancelled，运行中任务转取消（终态等 exit 落）。 */
  cancelAll(): void {
    for (const item of [...this.queue]) this.cancel(item.jobId);
    if (this.running !== undefined) this.cancel(this.running.jobId);
  }

  /** 有运行中任务时返回它的快照；否则仅在最近快照仍在途（queued）时返回，终态不复活。 */
  active(): JobSnapshot | undefined {
    if (this.running !== undefined) return runningSnapshot(this.running.jobId, this.running.record);
    if (this.lastSnapshot === undefined) return undefined;
    if (this.lastSnapshot.state !== "queued") return undefined;
    return this.lastSnapshot;
  }

  /** 有任务在途（queued 或 running）时为 true。 */
  busy(): boolean {
    return this.running !== undefined || this.queue.length > 0;
  }

  /** 队列彻底清空（无 queued 也无 running）后 resolve。 */
  drain(): Promise<void> {
    if (!this.busy()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.drainResolve = resolve;
    return promise;
  }

  private settle(r: { jobId: string; record: JobRecord }, snapshot: JobSnapshot): void {
    r.record.settled = true;
    this.emit(snapshot);
    this.running = undefined;
    this.start();
  }

  private emit(snapshot: JobSnapshot): void {
    this.lastSnapshot = snapshot;
    this.onChange(snapshot);
  }
}
