import { mkdirSync } from "node:fs";
import {
  acquireVideoLock,
  analyzeVideoRange,
  ClipProject,
  videoIdFor,
  generateProjectClip,
  isVideoLockBusy,
  loadVideoData,
  logger,
  mediaAbsolutePath,
  probeVideo,
  readVideoData,
  setTopicProgress,
  slicedSecondsFrom,
  subtitleLinesFrom,
  splitTopicKey,
} from "@video-notes/core";
import type {
  AsrConfig,
  AnalysisJob,
  LlmEndpoint,
  ProjectExecutor,
  ProposedTopic,
  PromptOverrides,
  SliceJob,
  SubtitleLine,
  VideoId,
  VideoLock,
} from "@video-notes/core";
import type { ProjectDetail } from "../shared/ipc";
import type { ProjectService } from "./projects";

/** 项目里一个来源视频的运行时元数据（来自视频库；分析/切片都读同一份文档）。 */
export type ProjectVideo = {
  id: string;
  name: string;
  durationSeconds: number;
  outputDir: string;
  sourcePath: string;
  hasVideo: boolean;
};

/** 真正跑一轮分析/切片需要的配置；由 main 在任务启动时解析（不冻结入队时的旧值之外的东西）。 */
export type ProjectJobContext = {
  endpoint: LlmEndpoint;
  asr: AsrConfig;
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
  prompts: PromptOverrides;
};

export type ClipAllocation = { seq: number; file: string; clipsDir: string };

export type ProjectRuntimeDeps = {
  service: ProjectService;
  /** 同一个视频的运行锁：默认轮询 core 的 `.vnote-run.lock`，测试注入内存锁。 */
  acquireLock?: (outputDir: string) => Promise<VideoLock>;
  /** 默认读 `video.json` 生成确认弹窗的字幕行；测试注入。 */
  transcriptOf?: (videoId: string) => SubtitleLine[];
  /** 默认用 core 的区间分析管线；测试注入。 */
  analyzeRange?: (
    job: AnalysisJob,
    video: ProjectVideo,
    lock: VideoLock,
    onStage?: (stage: 0 | 1) => void,
  ) => Promise<ProposedTopic[]>;
  /** 默认用 `generateProjectClip` 并把切片记录写回 `video.json`；测试注入。 */
  generateClip?: (job: SliceJob, video: ProjectVideo, alloc: ClipAllocation) => Promise<{ file: string }>;
  /** 真实执行器的配置来源；只有未注入 analyzeRange/generateClip 时才调用。 */
  context?: () => Promise<ProjectJobContext>;
  /** 按视频 id 解析视频库元数据；main 注入 listLibrary。 */
  resolveVideo?: (videoId: string) => ProjectVideo | undefined;
  /**
   * 监控目录里还没导入视频库的文件（#128）：按路径读元数据，时长走 ffprobe。
   * 缺省时不接受目录里的新文件（测试与未接监控的调用方）。
   * `durationHint`：监控刚读到的时长；再次探测失败时用它建元数据，避免入队后跑不起来（#132）。
   */
  describeSource?: (path: string, durationHint?: number) => Promise<ProjectVideo | undefined>;
};

/**
 * 所有项目共用的两槽执行器（ADR-0055）：analysis 槽串行跑「一个字幕解析 + 主题分析」，
 * slice 槽串行跑「一个主题」。两条槽可以同时各跑一个；同一个视频的两个槽通过运行锁互斥。
 * 控制器只负责排队与状态，本类把任务翻成真实操作并回填终态。
 */
export class ProjectRuntime {
  private readonly service: ProjectService;
  private readonly deps: ProjectRuntimeDeps;
  private readonly controllers = new Map<string, ClipProject>();
  private readonly videos = new Map<string, Map<string, ProjectVideo>>();
  private analysisTail: Promise<void> = Promise.resolve();
  private sliceTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: ProjectRuntimeDeps) {
    this.service = deps.service;
    this.deps = deps;
  }

  /** 登记视频元数据；控制器已存在时同步加进文件表。 */
  registerVideo(projectId: string, video: ProjectVideo): void {
    const map = this.videos.get(projectId) ?? new Map<string, ProjectVideo>();
    map.set(video.id, video);
    this.videos.set(projectId, map);
    this.controllers.get(projectId)?.addFile(this.fileInput(video));
  }

  /** 监控轮询要拿已接入的控制器；未接入返回 undefined（#132）。 */
  controller(projectId: string): ClipProject | undefined {
    return this.controllers.get(projectId);
  }

  /** 懒建控制器并接入 ProjectService；清单是配置的单一真相源。 */
  attachProject(projectId: string): ClipProject {
    const existing = this.controllers.get(projectId);
    if (existing !== undefined) return existing;
    const controller = new ClipProject({
      executor: this.executor(projectId),
      transcriptOf: (videoId) => this.subtitleLines(projectId, videoId),
      autoSlice: false,
    });
    this.controllers.set(projectId, controller);
    const record = this.service.get(projectId);
    const ids = new Set<string>(record.videoIds);
    for (const id of this.videos.get(projectId)?.keys() ?? []) ids.add(id);
    for (const videoId of ids) {
      const video = this.video(projectId, videoId, false);
      if (video !== undefined) controller.addFile(this.fileInput(video));
    }
    this.restoreProcessed(projectId, controller, ids, record.clips);
    this.service.attachRuntime(projectId, controller);
    return controller;
  }

  /**
   * 重启后控制器是全新的：用项目清单里已落盘的切片 + `video.json` 的分块/主题状态恢复
   * 「已处理」进度，否则队列底部的「未切片内容时长」会退回整段时长（#142 QA）。
   * 没有切片的视频也要走一遍：零主题的已完成分块同样算已处理。
   */
  private restoreProcessed(
    projectId: string,
    controller: ClipProject,
    videoIds: Iterable<string>,
    clips: ProjectDetail["clips"],
  ): void {
    const sliced = new Map<string, Set<string>>();
    for (const clip of clips) {
      const ids = sliced.get(clip.videoId) ?? new Set<string>();
      ids.add(clip.topicId);
      sliced.set(clip.videoId, ids);
    }
    for (const videoId of videoIds) {
      if (!controller.files.has(videoId)) continue;
      const video = this.video(projectId, videoId, false);
      if (video === undefined) continue;
      // 单个视频文档坏掉不能拖垮整个项目接入：跳过它的恢复，控制器照常挂上
      let data;
      try {
        data = readVideoData(video.outputDir);
      } catch (err) {
        logger().error("project", "恢复未切片时长失败", {
          projectId,
          videoId,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (data === undefined) continue;
      controller.restoreProcessed(videoId, slicedSecondsFrom(data, sliced.get(videoId) ?? new Set()));
    }
  }

  /**
   * 把监控目录里还没进视频库的文件（#128「开始整理」）注册成运行时元数据，
   * 返回真正注册成功的 videoId。已注册或解析不出的路径跳过，不写清单。
   * 传入对象 + `durationSeconds` 时用于「监控已读到时长、运行时还没登记」的补齐（#132）。
   */
  async registerSources(
    projectId: string,
    sources: readonly (string | { path: string; durationSeconds: number })[],
  ): Promise<string[]> {
    if (sources.length === 0) return [];
    this.attachProject(projectId);
    const registered: string[] = [];
    for (const source of sources) {
      const path = typeof source === "string" ? source : source.path;
      const hint = typeof source === "string" ? undefined : source.durationSeconds;
      const videoId = videoIdFor(path);
      if (this.videos.get(projectId)?.has(videoId) === true) continue;
      // 先看视频库：已导入的文件不用再探测，也不该被目录描述覆盖
      const known = this.deps.resolveVideo?.(videoId);
      if (known !== undefined) {
        this.registerVideo(projectId, known);
        registered.push(videoId);
        continue;
      }
      const described = await this.deps.describeSource?.(path, hint);
      if (described === undefined || described.id !== videoId) continue;
      this.registerVideo(projectId, described);
      registered.push(videoId);
    }
    return registered;
  }

  /**
   * 加入整理：先补齐视频库元数据（现有导入的产物），再交给控制器排分析队列。
   * 监控目录里时长还读不出的文件也允许先加入：控制器 `durationKnown=false` 不会入队，
   * 等监控读到时长并补齐源元数据后再排（#132 评审 P1）。
   */
  startOrganize(projectId: string, videoIds: readonly string[]): ProjectDetail {
    this.attachProject(projectId);
    for (const videoId of videoIds) {
      const video = this.video(projectId, videoId, false);
      if (video !== undefined) this.registerVideo(projectId, video);
    }
    return this.service.startOrganize(projectId, videoIds);
  }

  dispose(): void {
    this.disposed = true;
  }

  private executor(projectId: string): ProjectExecutor {
    return {
      analyze: (job) => {
        this.analysisTail = this.analysisTail
          .then(() => this.runAnalysis(projectId, job))
          .catch((err: unknown) => logger().error("project", "分析槽异常", { message: err instanceof Error ? err.message : String(err) }));
      },
      slice: (job) => {
        this.sliceTail = this.sliceTail
          .then(() => this.runSlice(projectId, job))
          .catch((err: unknown) => logger().error("project", "切片槽异常", { message: err instanceof Error ? err.message : String(err) }));
      },
    };
  }

  private async runAnalysis(projectId: string, job: AnalysisJob): Promise<void> {
    const controller = this.controllers.get(projectId);
    const video = this.video(projectId, job.fileId, true);
    if (controller === undefined || video === undefined) return;
    let lock: VideoLock | undefined;
    try {
      lock = await this.lock(video);
      // 两步进度只由执行器回报：控制器管状态，本类负责把真实阶段立刻推给界面
      const onStage = (stage: 0 | 1): void => {
        if (!controller.advanceAnalysisStage(job.id, stage)) return;
        this.service.refresh(projectId);
      };
      const topics = await this.analyze(job, video, lock, onStage);
      controller.completeAnalysis(job.id, topics);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger().error("project", "区间分析失败", { projectId, videoId: video.id, jobId: job.id, message });
      controller.failAnalysis(job.id, message);
    } finally {
      // 终态（含队列推进到下一个任务）已经写进控制器，这里推一次详情就够
      this.service.refresh(projectId);
      lock?.release();
    }
  }

  private async runSlice(projectId: string, job: SliceJob): Promise<void> {
    const controller = this.controllers.get(projectId);
    const video = this.video(projectId, job.fileId, true);
    if (controller === undefined || video === undefined) return;
    const parsed = splitTopicKey(job.topicKey);
    const allocation = this.service.beginClip(projectId, job.title);
    let lock: VideoLock | undefined;
    try {
      lock = await this.lock(video);
      const alloc = { ...allocation, clipsDir: this.service.clipsDir(projectId) };
      const { file } = await this.generate(job, video, alloc);
      if (parsed !== undefined) {
        this.service.endClip(projectId, allocation.seq, { seq: allocation.seq, videoId: video.id, topicId: parsed.topicId, file });
      } else {
        this.service.abortClip(projectId, allocation.seq);
        throw new Error(`主题 key 无法解析：${job.topicKey}`);
      }
      controller.completeSlice(job.id);
    } catch (err) {
      this.service.abortClip(projectId, allocation.seq);
      const message = err instanceof Error ? err.message : String(err);
      logger().error("project", "切片失败", { projectId, videoId: video.id, jobId: job.id, message });
      controller.failSlice(job.id, message);
    } finally {
      this.service.refresh(projectId);
      lock?.release();
    }
  }

  private analyze(
    job: AnalysisJob,
    video: ProjectVideo,
    lock: VideoLock,
    onStage: (stage: 0 | 1) => void,
  ): Promise<ProposedTopic[]> {
    if (this.deps.analyzeRange !== undefined) return this.deps.analyzeRange(job, video, lock, onStage);
    return this.defaultAnalyze(job, video, lock, onStage);
  }

  /** 确认弹窗的字幕行：读共享的 `video.json`，行 id 与区间分析写入的 `subtitleLinesFrom` 同口径。 */
  private subtitleLines(projectId: string, videoId: string): SubtitleLine[] {
    if (this.deps.transcriptOf !== undefined) return this.deps.transcriptOf(videoId);
    const video = this.video(projectId, videoId, false);
    if (video === undefined) return [];
    const data = readVideoData(video.outputDir);
    return data === undefined ? [] : subtitleLinesFrom(data);
  }

  private generate(job: SliceJob, video: ProjectVideo, alloc: ClipAllocation): Promise<{ file: string }> {
    if (this.deps.generateClip !== undefined) return this.deps.generateClip(job, video, alloc);
    return this.defaultGenerate(job, video, alloc);
  }

  /**
   * 真实分析：区间分析管线已自己处理导入注册与格式规范化；运行锁由本类先拿到，
   * 通过 `lock` 参数传入，避免同一进程内二次取锁。
   */
  private async defaultAnalyze(
    job: AnalysisJob,
    video: ProjectVideo,
    lock: VideoLock,
    onStage: (stage: 0 | 1) => void,
  ): Promise<ProposedTopic[]> {
    if (this.deps.context === undefined) throw new Error("项目执行器缺少 LLM/ASR 配置");
    const context = await this.deps.context();
    const result = await analyzeVideoRange({
      videoPath: video.sourcePath,
      outputDir: video.outputDir,
      notesRoot: context.notesRoot,
      cacheRoot: context.cacheRoot,
      modelDir: context.modelDir,
      startSeconds: job.start,
      endSeconds: job.end,
      endpoint: context.endpoint,
      asr: context.asr,
      prompts: context.prompts,
      lock,
      /**
       * 阶段只由管线真实进度驱动：转写一直是第 0 步，主题分析（segment-topics）开始推进到第 1 步。
       * 百分比留在管线里，界面只拿到 0 / 1 两步。
       */
      onProgress: (progress) => {
        if (progress.step === "segment-topics") onStage(1);
      },
    });
    return result.topics.map((topic) => ({ ...topic }));
  }

  /** 真实切片：复用 ADR-0026 的切割/拼接，写 `<项目目录>/clips` 与主题切片记录。 */
  private async defaultGenerate(job: SliceJob, video: ProjectVideo, alloc: ClipAllocation): Promise<{ file: string }> {
    if (this.deps.context === undefined) throw new Error("项目执行器缺少 LLM/ASR 配置");
    const context = await this.deps.context();
    const data = loadVideoData(video.outputDir, { id: video.id as VideoId, title: video.name, sourcePath: video.sourcePath, durationSeconds: video.durationSeconds });
    /**
     * 增长中的录制：规范化产物只覆盖旧长度，末尾的切片会切出空文件（#132 D1）。
     * 需要的时间点超出产物实测时长就从源文件切；产物够用时照旧用它。
     */
    const needsUntil = job.segments.reduce((end, segment) => Math.max(end, segment.end), 0);
    const artifactPath = mediaAbsolutePath(data);
    const sourcePath =
      data.mediaPath === null
        ? artifactPath
        : (await this.artifactDuration(artifactPath)) + 0.5 >= needsUntil
          ? artifactPath
          : video.sourcePath;
    const topicId = splitTopicKey(job.topicKey)?.topicId ?? "";
    const startedAt = new Date().toISOString();
    setTopicProgress(video.outputDir, topicId, { status: "generating", startedAt, error: null });
    const { clip } = await generateProjectClip({
      sourcePath,
      hasVideo: data.hasVideo ?? video.hasVideo,
      clipsDir: alloc.clipsDir,
      nextSeq: alloc.seq,
      title: job.title,
      subtitles: job.lines,
    });
    if (!clip.file.startsWith(`${String(alloc.seq).padStart(3, "0")}-`)) {
      throw new Error(`切片序号不一致：分配 ${alloc.seq}，落盘 ${clip.file}`);
    }
    setTopicProgress(video.outputDir, topicId, {
      status: "done",
      error: null,
      clips: [clip],
      elapsedSeconds: Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 100) / 10),
    });
    logger().info("project", "项目切片完成", { videoId: video.id, topicId, file: clip.file, model: context.endpoint.model });
    return { file: clip.file };
  }

  /** 规范化产物的实测时长；读不出按 0 处理（切片会退回源文件）。 */
  private async artifactDuration(path: string): Promise<number> {
    try {
      return (await probeVideo(path)).duration;
    } catch {
      return 0;
    }
  }

  /**
   * 同一个视频的运行锁：轮询 core 的锁文件，任务之间自然排队。
   * 锁文件建在输出目录里，而目录由第一次分析才创建（新导入的视频还没有），
   * 所以先建目录：否则 openSync 报 ENOENT，旧实现会把它当成「忙」无限重试。
   * 只有「视频正在运行」是可重试的占用；其它文件系统错误直接抛出，避免永久错误变成空转。
   */
  private async lock(video: ProjectVideo): Promise<VideoLock> {
    if (this.deps.acquireLock !== undefined) return this.deps.acquireLock(video.outputDir);
    mkdirSync(video.outputDir, { recursive: true });
    for (;;) {
      if (this.disposed) throw new Error("项目执行器已停止");
      try {
        return acquireVideoLock(video.outputDir);
      } catch (err) {
        if (!isVideoLockBusy(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private fileInput(video: ProjectVideo) {
    return {
      id: video.id,
      name: video.name,
      durationSeconds: video.durationSeconds,
      growing: false,
      // 已存在的完整文件：直接按「停止增长超过 30 秒」入尾段；监控增长归 #132
      modifiedSeconds: -31,
    };
  }

  private video(projectId: string, videoId: string, required: true): ProjectVideo;
  private video(projectId: string, videoId: string, required: false): ProjectVideo | undefined;
  private video(projectId: string, videoId: string, required: boolean): ProjectVideo | undefined {
    const known = this.videos.get(projectId)?.get(videoId);
    if (known !== undefined) return known;
    const resolved = this.deps.resolveVideo?.(videoId);
    if (resolved !== undefined) this.registerVideo(projectId, resolved);
    if (resolved === undefined && required) throw new Error(`未知视频：${videoId}`);
    return resolved;
  }
}
