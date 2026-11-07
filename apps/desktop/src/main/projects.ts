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
  ProjectClipInfo,
  ProjectDetail,
  ProjectDirectoryFile,
  ProjectEventPayload,
  ProjectQueueState,
  ProjectSettingsPatch,
  ProjectSummary,
  ProjectTopicLines,
} from "../shared/ipc";
import { describeProjectClips } from "./project-clip-details";
import type { DirectoryStatus } from "./project-directory";

/**
 * 项目业务层（#125）：持久化清单 + 运行日志 + 每项目状态机。
 * 队列详情来自 `ClipProject`；执行器（ASR/LLM/ffmpeg）由 #126 通过 `attachRuntime`
 * 接入，未接入时 `queue` 为 null，界面按「队列空闲」显示，不伪造任务。
 */
export type ProjectServiceDeps = {
  store: ProjectStore;
  events: ProjectEventLog;
  /**
   * 切片引用 → 产出卡片展示字段（#130）。main 注入带视频库解析的实现；
   * 缺省只拼项目内的路径与文件名标题，不读视频库。
   */
  describeClips?: (record: ProjectRecord) => ProjectClipInfo[];
  /**
   * 监控目录快照（#128）。main 注入：读目录并按视频库补时长；
   * 缺省时 `detail.directory` 为空，界面只显示监控状态。
   */
  scanDirectory?: (
    watchDir: string,
    statuses: ReadonlyMap<string, DirectoryStatus>,
  ) => ProjectDirectoryFile[];
  /**
   * 「开始监控」前校验目录（#128）。main 注入：目录不存在 / 不是目录直接抛可读错误；
   * 监控开关一旦打开界面就锁住输入框，所以拼错的路径必须在落盘前拒绝。
   */
  checkDirectory?: (directory: string) => void;
  /** 监控开始后立刻记目录基线（#132），之后出现的文件才算「新文件」。 */
  onMonitorStarted?: (projectId: string, watchDir: string) => void;
  /**
   * 删除项目时通知（#154）：清单已经落盘删除之后才回调，运行时与监控在这里停掉该项目的任务与跟踪。
   * 清单写失败时不会回调——项目还在，控制器不能已经被 dispose。
   */
  onProjectRemoved?: (projectId: string) => void;
};

type ChangeListener = (payload: ProjectEventPayload) => void;

export class ProjectService {
  private readonly store: ProjectStore;
  private readonly events: ProjectEventLog;
  private readonly describeClips: (record: ProjectRecord) => ProjectClipInfo[];
  private readonly scanDirectory:
    | ((watchDir: string, statuses: ReadonlyMap<string, DirectoryStatus>) => ProjectDirectoryFile[])
    | undefined;
  private readonly checkDirectory: ((directory: string) => void) | undefined;
  private readonly onMonitorStarted: ((projectId: string, watchDir: string) => void) | undefined;
  private readonly onProjectRemoved: ((projectId: string) => void) | undefined;
  private readonly runtimes = new Map<string, ClipProject>();
  private readonly listeners = new Set<ChangeListener>();
  /** 已分配、尚未落盘的切片序号：并行任务不会拿到同一个号（#126）。 */
  private readonly inflightClips = new Map<string, Set<number>>();
  /** 执行器按需接入：界面第一次读项目时懒建控制器（#126）。 */
  private ensureRuntime: ((projectId: string) => void) | undefined;
  private readonly ensuring = new Set<string>();

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.scanDirectory = deps.scanDirectory;
    this.checkDirectory = deps.checkDirectory;
    this.onMonitorStarted = deps.onMonitorStarted;
    this.onProjectRemoved = deps.onProjectRemoved;
    this.describeClips =
      deps.describeClips ??
      ((record) =>
        describeProjectClips({
          projectId: record.id,
          clipsDir: projectClipsDir(record),
          refs: record.clips,
        }));
  }

  /** main 注入：项目第一次被读取/操作时调用，让执行器把控制器接进来。 */
  setRuntimeProvider(provider: (projectId: string) => void): void {
    this.ensureRuntime = provider;
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
    controller.setSemanticChunking(record.semanticChunking);
    this.runtimes.set(projectId, controller);
    this.publish(projectId);
  }

  detachRuntime(projectId: string): void {
    this.runtimes.delete(projectId);
    this.publish(projectId);
  }

  list(): ProjectSummary[] {
    const records = this.store.list();
    for (const record of records) this.ensure(record.id);
    return records.map((record) => this.summaryOf(record, this.runtimes.get(record.id) ?? null));
  }

  get(projectId: string): ProjectDetail {
    this.requireRecord(projectId);
    this.ensure(projectId);
    return this.detailOf(this.requireRecord(projectId));
  }

  private ensure(projectId: string): void {
    if (this.runtimes.has(projectId) || this.ensureRuntime === undefined || this.ensuring.has(projectId)) return;
    this.ensuring.add(projectId);
    try {
      this.ensureRuntime(projectId);
    } finally {
      this.ensuring.delete(projectId);
    }
  }

  create(input: CreateProjectInput): ProjectDetail {
    const record = this.store.create({ name: input.name, rootDir: input.rootDir });
    return this.publish(record.id, `创建项目：${record.name}`);
  }

  remove(projectId: string): void {
    const record = this.requireRecord(projectId);
    /**
     * 先落盘删除，成功后才停运行时与监控（#154 评审 P2）：清单写失败时项目仍在，
     * 控制器不能已经被永久 dispose。这两步之间没有 `await`，在飞任务观察不到中间态；
     * 之后 `alive()` 判据会把它们一律短路，不会对已删项目调服务层。
     */
    if (!this.store.remove(projectId)) throw new Error(`未知项目：${projectId}`);
    this.onProjectRemoved?.(projectId);
    this.runtimes.delete(projectId);
    this.inflightClips.delete(projectId);
    this.events.clear(projectId);
    logger().info("project", "已删除项目", { projectId, name: record.name });
  }

  startMonitor(projectId: string, directory: string): ProjectDetail {
    this.checkDirectory?.(directory);
    const record = this.store.startMonitor(projectId, directory);
    if (record.watchDir !== null) this.onMonitorStarted?.(projectId, record.watchDir);
    return this.publish(projectId, `监控已启动：${record.watchDir ?? directory}`);
  }

  /** 已加入的视频不会重复计数；控制器已接入时同时把新增视频推进分析队列。 */
  startOrganize(projectId: string, videoIds: readonly string[]): ProjectDetail {
    this.requireRecord(projectId);
    this.ensure(projectId);
    const before = this.requireRecord(projectId).videoIds;
    const added = [...new Set(videoIds)].filter((id) => id !== "" && !before.includes(id));
    const record = this.store.addVideos(projectId, added);
    const controller = this.runtimes.get(projectId);
    if (controller !== null && controller !== undefined) {
      // 不只传「新加入」的：首轮轮询之前点整理、或旧版本卡住的记录，
      // 控制器里可能还没有这个文件，加入意图必须在这次补上（#132 D2/D3）
      controller.startOrganize([...new Set(videoIds)].filter((id) => id !== ""));
    }
    return this.publish(
      projectId,
      added.length > 0
        ? `开始整理：${added.length} 个视频`
        : `开始整理：没有新视频（已加入 ${record.videoIds.length} 个）`,
    );
  }

  updateSettings(projectId: string, patch: ProjectSettingsPatch): ProjectDetail {
    this.ensure(projectId);
    const record = this.store.updateSettings(projectId, patch);
    const controller = this.runtimes.get(projectId);
    if (controller !== null && controller !== undefined) {
      if (patch.chunkMinutes !== undefined) controller.setChunkMinutes(record.chunkMinutes);
      if (patch.semanticChunking !== undefined) controller.setSemanticChunking(record.semanticChunking);
      if (patch.autoSlice !== undefined) controller.setAutoSlice(record.autoSlice);
    }
    const text =
      patch.chunkMinutes !== undefined || patch.autoSlice !== undefined || patch.semanticChunking !== undefined
        ? `项目设置：${record.chunkMinutes} 分钟 / 语义分块${record.semanticChunking ? "开启" : "关闭"} / 自动切片${record.autoSlice ? "开启" : "关闭"}；已入队任务继续处理`
        : `项目已重命名：${record.name}`;
    return this.publish(projectId, text);
  }

  /** 确认单个主题（只带行 id）：按当前字幕生成切片任务，重复确认与空选择都拒绝。 */
  confirmTopic(projectId: string, topicKeyValue: string, lineIds: readonly string[]): ProjectDetail {
    this.requireRecord(projectId);
    this.ensure(projectId);
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

  /**
   * 只写一条运行日志并推送详情（监控轮询「发现新文件」用，不改变控制器状态之外的东西）。
   */
  recordEvent(projectId: string, text: string): ProjectDetail {
    this.requireRecord(projectId);
    return this.publish(projectId, text);
  }

  /**
   * 只推一次最新快照，不写运行日志。执行器在控制器状态变化后调用：
   * 分析/切片完成的时刻没有业务写操作，否则界面要等下一次事件才看到新状态（#128 三态）。
   */
  refresh(projectId: string): ProjectDetail {
    return this.publish(projectId);
  }

  /**
   * 重试失败任务（#154）：分析/切片任务原地回队列，不新增任务、不改顺序。
   * 重试不成立（非 failed / 找不到）抛可读错误，界面据此提示。
   */
  retryTask(projectId: string, queue: "analysis" | "slice", taskId: number): ProjectDetail {
    this.requireRecord(projectId);
    this.ensure(projectId);
    const controller = this.runtimes.get(projectId);
    if (controller === undefined) throw new Error("项目执行器尚未接入");
    const jobs = queue === "analysis" ? controller.analysisQueue : controller.sliceQueue;
    const job = jobs.find((item) => item.id === taskId);
    if (job === undefined) throw new Error(`任务不存在：${taskId}`);
    if (job.status !== "failed") throw new Error("任务不在失败状态，无法重试");
    const retried = queue === "analysis" ? controller.retryAnalysis(taskId) : controller.retrySlice(taskId);
    if (!retried) throw new Error("任务不在失败状态，无法重试");
    const label = "name" in job ? job.name : job.title;
    return this.publish(projectId, `任务已重试：${label}`);
  }

  /**
   * 失败原因写进运行日志（#154）：error 级别事件 + 结构化错误日志 + 一次详情推送。
   * 不复用 `publish` 的 info 路径：界面「运行日志与状态」要按级别显示失败。
   */
  reportFailure(projectId: string, text: string): ProjectDetail {
    this.requireRecord(projectId);
    this.events.push(projectId, text, "error");
    logger().error("project", text, { projectId });
    return this.publish(projectId);
  }

  /**
   * 确认字幕弹窗：按 `topicKey` 找来源文件，返回当前已知的完整字幕。
   * 只读、不改主题状态；稍后确认与重开走同一条路径，所以前后状态必然相同。
   */
  topicLines(projectId: string, topicKeyValue: string): ProjectTopicLines {
    this.requireRecord(projectId);
    this.ensure(projectId);
    const controller = this.runtimes.get(projectId);
    if (controller === undefined) throw new Error("项目执行器尚未接入");
    const parsed = splitTopicKey(topicKeyValue);
    const job =
      parsed === undefined
        ? undefined
        : controller.analysisQueue.find((item) => item.id === parsed.jobId);
    // 任务在、主题不在也要报错：空字幕是「读到了但没有字幕」，不是「主题不存在」
    if (job === undefined || !job.topics.some((topic) => topic.id === parsed?.topicId)) {
      throw new Error("主题不存在");
    }
    return {
      topicKey: topicKeyValue,
      lines: controller.linesOf(topicKeyValue).map((line) => ({
        id: line.id,
        start: line.start,
        end: line.end,
        speaker: line.speaker ?? "",
        text: line.text,
      })),
    };
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
      semanticChunking: record.semanticChunking,
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
      clips: this.describeClips(record),
      queue: controller === null ? null : queueSnapshot(controller),
      directory: this.directoryOf(record, controller),
      events: this.events.list(record.id),
    };
  }

  /**
   * 监控目录快照：每行合并控制器里的整理状态。控制器没接入时，
   * 项目清单里已加入的 id 按「持续整理中」显示（生产路径总会懒建控制器）。
   */
  private directoryOf(record: ProjectRecord, controller: ClipProject | null): ProjectDirectoryFile[] {
    if (!record.monitoring || record.watchDir === null || this.scanDirectory === undefined) return [];
    // 清单是「已加入」的真相源：重启后控制器只知道文件、added 还没恢复（#126 队列尚未落盘），
    // 这时按「持续整理中」显示，不能让已加入的视频退回「未整理」。
    const joined = new Set(record.videoIds);
    const statuses = new Map<string, DirectoryStatus>();
    for (const videoId of joined) {
      statuses.set(videoId, { added: true, organizeStatus: "organizing", processedSeconds: 0 });
    }
    if (controller !== null) {
      for (const file of controller.files.values()) {
        const added = file.added || joined.has(file.id);
        statuses.set(file.id, {
          added,
          organizeStatus: !added
            ? "unorganized"
            : file.added
              ? controller.statusOf(file.id)
              : "organizing",
          processedSeconds: added ? file.processedSeconds : 0,
        });
      }
    }
    return this.scanDirectory(record.watchDir, statuses);
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
      ...(job.progress !== undefined ? { progress: { ...job.progress } } : {}),
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
