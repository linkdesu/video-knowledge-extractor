import {
  allocateProjectClip,
  ClipProject,
  logger,
  projectClipsDir,
  ProjectEventLog,
  ProjectStore,
  splitTopicKey,
  topicKey,
  type ProjectClipAllocation,
  type ProjectClipRef,
  type ProjectRecord,
} from "@video-notes/core";
import type {
  CreateProjectInput,
  ProjectDetail,
  ProjectEventPayload,
  ProjectQueueState,
  ProjectSettingsPatch,
  ProjectSummary,
} from "../shared/ipc";

/**
 * 项目业务层（#125）：持久化清单 + 运行日志 + 每项目状态机。
 * 队列详情来自 `ClipProject`；执行器（ASR/LLM/ffmpeg）由 #126 通过 `attachRuntime`
 * 接入，未接入时 `queue` 为 null，界面按「队列空闲」显示，不伪造任务。
 */
export type ProjectServiceDeps = {
  store: ProjectStore;
  events: ProjectEventLog;
};

type ChangeListener = (payload: ProjectEventPayload) => void;

export class ProjectService {
  private readonly store: ProjectStore;
  private readonly events: ProjectEventLog;
  private readonly runtimes = new Map<string, ClipProject>();
  private readonly listeners = new Set<ChangeListener>();
  /** 已分配、尚未落盘的切片序号：并行任务不会拿到同一个号（#126）。 */
  private readonly inflightClips = new Map<string, Set<number>>();

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.events = deps.events;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** #126 接入执行器后的项目状态机；同一个项目重复接入以最后一次为准。 */
  attachRuntime(projectId: string, controller: ClipProject): void {
    const record = this.requireRecord(projectId);
    // 清单是配置的单一真相源：接入时把已保存的设置重新作用到控制器上
    controller.setChunkMinutes(record.chunkMinutes);
    controller.setAutoSlice(record.autoSlice);
    this.runtimes.set(projectId, controller);
    this.publish(projectId);
  }

  detachRuntime(projectId: string): void {
    this.runtimes.delete(projectId);
    this.publish(projectId);
  }

  list(): ProjectSummary[] {
    return this.store.list().map((record) => this.summaryOf(record, this.runtimes.get(record.id) ?? null));
  }

  get(projectId: string): ProjectDetail {
    return this.detailOf(this.requireRecord(projectId));
  }

  create(input: CreateProjectInput): ProjectDetail {
    const record = this.store.create({ name: input.name, rootDir: input.rootDir });
    return this.publish(record.id, `创建项目：${record.name}`);
  }

  remove(projectId: string): void {
    const record = this.requireRecord(projectId);
    if (!this.store.remove(projectId)) throw new Error(`未知项目：${projectId}`);
    this.runtimes.delete(projectId);
    this.events.clear(projectId);
    logger().info("project", "已删除项目", { projectId, name: record.name });
  }

  startMonitor(projectId: string, directory: string): ProjectDetail {
    const record = this.store.startMonitor(projectId, directory);
    return this.publish(projectId, `监控已启动：${record.watchDir ?? directory}`);
  }

  /** 已加入的视频不会重复计数；控制器已接入时同时把新增视频推进分析队列。 */
  startOrganize(projectId: string, videoIds: readonly string[]): ProjectDetail {
    const before = this.requireRecord(projectId).videoIds;
    const added = [...new Set(videoIds)].filter((id) => id !== "" && !before.includes(id));
    const record = this.store.addVideos(projectId, added);
    const controller = this.runtimes.get(projectId);
    if (controller !== null && controller !== undefined) {
      const known = added.filter((id) => controller.files.has(id));
      if (known.length > 0) controller.startOrganize(known);
    }
    return this.publish(
      projectId,
      added.length > 0
        ? `开始整理：${added.length} 个视频`
        : `开始整理：没有新视频（已加入 ${record.videoIds.length} 个）`,
    );
  }

  updateSettings(projectId: string, patch: ProjectSettingsPatch): ProjectDetail {
    const record = this.store.updateSettings(projectId, patch);
    const controller = this.runtimes.get(projectId);
    if (controller !== null && controller !== undefined) {
      if (patch.chunkMinutes !== undefined) controller.setChunkMinutes(record.chunkMinutes);
      if (patch.autoSlice !== undefined) controller.setAutoSlice(record.autoSlice);
    }
    const text =
      patch.chunkMinutes !== undefined || patch.autoSlice !== undefined
        ? `项目设置：${record.chunkMinutes} 分钟 / 自动切片${record.autoSlice ? "开启" : "关闭"}；已入队任务继续处理`
        : `项目已重命名：${record.name}`;
    return this.publish(projectId, text);
  }

  /** 确认单个主题（只带行 id）：按当前字幕生成切片任务，重复确认与空选择都拒绝。 */
  confirmTopic(projectId: string, topicKeyValue: string, lineIds: readonly string[]): ProjectDetail {
    this.requireRecord(projectId);
    const controller = this.runtimes.get(projectId);
    if (controller === undefined) throw new Error("项目执行器尚未接入");
    const parsed = splitTopicKey(topicKeyValue);
    const topic =
      parsed === undefined
        ? undefined
        : controller.analysisQueue
            .find((job) => job.id === parsed.jobId)
            ?.topics.find((item) => item.id === parsed.topicId);
    if (topic === undefined || topic.status !== "proposed") throw new Error("主题不存在或已确认");
    if (!controller.confirmTopic(topicKeyValue, [...lineIds])) throw new Error("所选字幕为空");
    const slice = controller.sliceQueue.filter((job) => job.topicKey === topicKeyValue).at(-1);
    return this.publish(projectId, `切片入队：${topic.title} · ${slice?.lines.length ?? 0} 行字幕`);
  }

  clipsDir(projectId: string): string {
    return projectClipsDir(this.requireRecord(projectId));
  }

  /**
   * 分配一个项目切片序号，但先不写清单（ADR-0056 §3：失败不消耗序号）。
   * 在途序号登记在内存里，同项目并行任务不会拿到同一个号；落盘走 `endClip`。
   */
  beginClip(projectId: string, title: string): ProjectClipAllocation {
    const record = this.requireRecord(projectId);
    const inflight = this.inflightClips.get(projectId) ?? new Set<number>();
    let nextSeq = record.nextClipSeq;
    let allocation = allocateProjectClip({ clipsDir: projectClipsDir(record), nextSeq, title });
    while (inflight.has(allocation.seq)) {
      nextSeq = allocation.seq + 1;
      allocation = allocateProjectClip({ clipsDir: projectClipsDir(record), nextSeq, title });
    }
    inflight.add(allocation.seq);
    this.inflightClips.set(projectId, inflight);
    return allocation;
  }

  /** 切片文件写完：把引用写进项目清单（序号与计数器一起前进），再解除在途占位。 */
  endClip(projectId: string, seq: number, ref: ProjectClipRef): ProjectDetail {
    if (ref.seq !== seq) throw new Error(`切片序号不一致：${seq} ≠ ${ref.seq}`);
    const detail = this.recordClip(projectId, ref);
    this.inflightClips.get(projectId)?.delete(seq);
    return detail;
  }

  /** 生成失败：释放在途占位，不写记录、不推进计数器；同序号之后仍可复用。 */
  abortClip(projectId: string, seq: number): void {
    this.inflightClips.get(projectId)?.delete(seq);
  }

  /** 生产调用方：切片执行器在文件与 `video.json` 都落盘后登记项目计数（#126）。 */
  recordClip(projectId: string, ref: ProjectClipRef): ProjectDetail {
    this.store.recordClip(projectId, ref);
    return this.publish(projectId, `切片已记录：${ref.file}`);
  }

  private requireRecord(projectId: string): ProjectRecord {
    const record = this.store.get(projectId);
    if (record === undefined) throw new Error(`未知项目：${projectId}`);
    return record;
  }

  private summaryOf(record: ProjectRecord, controller: ClipProject | null): ProjectSummary {
    const queue = controller === null ? null : queueSnapshot(controller);
    return {
      id: record.id,
      name: record.name,
      rootDir: record.rootDir,
      clipsDir: projectClipsDir(record),
      watchDir: record.watchDir,
      monitoring: record.monitoring,
      chunkMinutes: record.chunkMinutes,
      autoSlice: record.autoSlice,
      videoCount: record.videoIds.length,
      pendingTaskCount: queue === null
        ? 0
        : queue.analysis.filter((task) => task.status !== "done").length +
          queue.slices.filter((task) => task.status !== "done").length,
      proposedTopicCount: queue?.proposed.length ?? 0,
      clipCount: record.clips.length,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private detailOf(record: ProjectRecord): ProjectDetail {
    const controller = this.runtimes.get(record.id) ?? null;
    return {
      ...this.summaryOf(record, controller),
      videoIds: [...record.videoIds],
      clips: record.clips.map((clip) => ({ ...clip })),
      queue: controller === null ? null : queueSnapshot(controller),
      events: this.events.list(record.id),
    };
  }

  /** 一次变更 = 一条运行日志 + 一条结构化日志（ADR-0028）+ 一次详情推送。 */
  private publish(projectId: string, text?: string): ProjectDetail {
    if (text !== undefined) {
      this.events.push(projectId, text);
      logger().info("project", text, { projectId });
    }
    const detail = this.detailOf(this.requireRecord(projectId));
    for (const listener of this.listeners) listener({ projectId, detail });
    return detail;
  }
}

function queueSnapshot(controller: ClipProject): ProjectQueueState {
  return {
    analysis: controller.analysisQueue.map((job) => ({
      id: job.id,
      fileId: job.fileId,
      name: job.name,
      startSeconds: job.start,
      endSeconds: job.end,
      status: job.status,
      stage: job.stage,
    })),
    slices: controller.sliceQueue.map((job) => ({
      id: job.id,
      topicKey: job.topicKey,
      fileId: job.fileId,
      title: job.title,
      status: job.status,
      lineCount: job.lines.length,
      segmentCount: job.segments.length,
      durationSeconds: job.durationSeconds,
    })),
    proposed: controller.analysisQueue.flatMap((job) =>
      job.topics
        .filter((topic) => topic.status === "proposed")
        .map((topic) => ({
          topicKey: topicKey(job.id, topic.id),
          jobId: job.id,
          fileId: job.fileId,
          title: topic.title,
          category: topic.category,
          lineIds: [...topic.lineIds],
        })),
    ),
    files: [...controller.files.values()].map((file) => ({
      id: file.id,
      name: file.name,
      added: file.added,
      organizeStatus: controller.statusOf(file.id),
      unslicedSeconds: controller.unslicedSeconds(file.id),
    })),
  };
}
