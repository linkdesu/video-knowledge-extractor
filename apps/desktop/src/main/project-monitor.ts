import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { videoIdFor, type ClipProject } from "@video-notes/core";
import { DIRECTORY_MEDIA_EXTENSIONS } from "./project-directory";

/**
 * 阶段 2：轮询监控增长中文件（#132，规格 #121 实现决策 7）。
 * 用轮询而不是系统文件变化通知：每次读目录里每个文件的大小 / 修改时间，
 * 大小或修改时间变了就记为一次增长。控制器只做状态，本层负责文件系统与探针。
 */
export type MonitoredFile = {
  videoId: string;
  name: string;
  path: string;
  sizeBytes: number;
  modifiedMs: number;
};

export type WatchedProject = { projectId: string; watchDir: string };

export type GrowthMonitorOptions = {
  /** 当前处于监控中的项目；每次轮询重新读取，项目开关变化无需重启监控。 */
  watchProjects: () => readonly WatchedProject[];
  /** 已接入执行器的项目控制器；未接入的项目跳过这一轮。 */
  controllerOf: (projectId: string) => ClipProject | undefined;
  /** ffprobe；读不出（录制中的 mp4 常见）返回 null，文件按还在增长处理，不入队。 */
  probeDuration: (path: string) => Promise<number | null>;
  /** 追加运行日志（「发现新文件」等）。 */
  event: (projectId: string, text: string) => void;
  /**
   * 把运行时元数据（源路径 / 输出目录）登记好：
   * - 已加入整理、时长刚刚才读到的文件：随后报告的涨长才能入队（#132 评审 P1）；
   * - 首次看到的文件（含重启后的首轮）：运行时借这次登记找回 `video.json`，
   *   恢复「已处理」与分块终点，不会把整段重排一遍（#132 D2）。
   */
  ensureSource?: (projectId: string, file: MonitoredFile, durationSeconds: number) => Promise<void>;
  /** 一轮里该项目的控制器状态变过：由调用方推送详情。 */
  changed: (projectId: string) => void;
  /** 轮询间隔，默认 2 秒。 */
  intervalMs?: number;
  /** 墙钟毫秒，测试注入。 */
  now?: () => number;
  /** 目录快照，测试注入；默认读一层目录里的媒体文件。 */
  statDirectory?: (watchDir: string) => MonitoredFile[];
};

type StatSnapshot = Map<string, { sizeBytes: number; modifiedMs: number }>;

const DEFAULT_INTERVAL_MS = 2_000;

/** 目录里的一层媒体文件快照；目录不存在 / 无权限时返回空数组（与 #128 一致）。 */
export function statMediaDirectory(watchDir: string): MonitoredFile[] {
  let names: string[];
  try {
    names = readdirSync(watchDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: MonitoredFile[] = [];
  for (const name of names) {
    if (!DIRECTORY_MEDIA_EXTENSIONS.includes(extname(name).toLowerCase())) continue;
    const path = join(watchDir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({ videoId: videoIdFor(path), name, path, sizeBytes: stat.size, modifiedMs: stat.mtimeMs });
  }
  // 同一修改时间保持 readdir 顺序（Array.prototype.sort 自 ES2019 起稳定）
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export class GrowthMonitor {
  private readonly options: GrowthMonitorOptions;
  private readonly snapshots = new Map<string, StatSnapshot>();
  private readonly lastPollMs = new Map<string, number>();
  private readonly durations = new Map<string, number>();
  /** 已删除的项目：一轮轮询跨过 `await` 之后不能再为它们登记、推送或写事件（#154 评审 P2）。 */
  private readonly removed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(options: GrowthMonitorOptions) {
    this.options = options;
  }

  /** 目录里读到的时长（表格「大小 / 时长」列）；没读到过返回 undefined。 */
  durationOf(videoId: string): number | undefined {
    return this.durations.get(videoId);
  }

  /**
   * 「开始监控」时立刻记下目录基线：之后出现的文件才算新文件。
   * 不依赖第一次轮询，避免点击监控到首轮之间出现的文件被静默当成基线（#132）。
   */
  seed(projectId: string, watchDir: string): void {
    const statDirectory = this.options.statDirectory ?? statMediaDirectory;
    const snapshot: StatSnapshot = new Map();
    for (const entry of statDirectory(watchDir)) {
      snapshot.set(entry.videoId, { sizeBytes: entry.sizeBytes, modifiedMs: entry.modifiedMs });
    }
    this.snapshots.set(projectId, snapshot);
    this.lastPollMs.set(projectId, this.options.now?.() ?? Date.now());
  }

  /** 项目删除（#154）：丢掉该项目的目录基线与轮询时间；`durations` 是全局共享的，不动。 */
  forget(projectId: string): void {
    this.removed.add(projectId);
    this.snapshots.delete(projectId);
    this.lastPollMs.delete(projectId);
  }

  start(): void {
    if (this.timer !== undefined) return;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.poll();
    }, interval);
    // 轮询定时器不能阻止应用退出
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 跑一轮轮询。首次轮询只建立基线：目录里已有的文件不记「发现新文件」，
   * 之后的轮询才对新增文件记日志。时间戳与增长判定都走注入的墙钟。
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const statDirectory = this.options.statDirectory ?? statMediaDirectory;
      const nowMs = this.options.now?.() ?? Date.now();
      for (const project of this.options.watchProjects()) {
        // 本轮开始时已删除：不再为它登记或推送（#154 评审 P2）
        if (this.removed.has(project.projectId)) continue;
        const controller = this.options.controllerOf(project.projectId);
        if (controller === undefined) continue;

        const previousPoll = this.lastPollMs.get(project.projectId);
        this.lastPollMs.set(project.projectId, nowMs);
        const beforePoll = stateSignature(controller);
        // 先把时钟推到当前时刻，但先不结算：让本轮观察到的增长落在正确的时间点
        if (previousPoll !== undefined && nowMs > previousPoll) {
          controller.advanceClock((nowMs - previousPoll) / 1_000);
        }

        const previous = this.snapshots.get(project.projectId);
        const current: StatSnapshot = new Map();
        let changed = false;

        for (const entry of statDirectory(project.watchDir)) {
          current.set(entry.videoId, { sizeBytes: entry.sizeBytes, modifiedMs: entry.modifiedMs });
          const before = previous?.get(entry.videoId);
          const known = controller.files.get(entry.videoId);
          const discovered = before === undefined;

          if (discovered && previous !== undefined) {
            // 基线之后出现的文件才记日志；首次基线里的文件不算新文件
            this.options.event(project.projectId, `发现新文件：${entry.name}，默认未勾选`);
            changed = true;
          }

          if (known === undefined) {
            // 首次看到（首轮基线 / seed 基线 / 新文件）：探一次时长并登记，未加入整理不会入队
            const duration = await this.probe(entry.path);
            // 探针跨过 await：项目在这期间被删掉就从本轮退出，后面的登记与推送都会撞「未知项目」
            if (this.removed.has(project.projectId)) return;
            if (duration !== null) this.durations.set(entry.videoId, duration);
            controller.addFile({
              id: entry.videoId,
              name: entry.name,
              durationSeconds: duration,
              // 刚出现 / 首次看到的文件按还在增长处理：停止增长严格超过 30 秒才补尾段
              growing: true,
              modifiedSeconds: controller.clock,
            });
            /**
             * 运行时的源元数据（源路径 / 输出目录）也要补上：重启后监控目录里的文件不在视频库，
             * 只有这次登记能拿到 `video.json`，借此恢复已处理进度与分块终点（#132 D2）。
             */
            if (duration !== null && !this.removed.has(project.projectId)) {
              await this.options.ensureSource?.(project.projectId, entry, duration);
            }
            changed = true;
            continue;
          }
          if (discovered && previous === undefined) {
            /**
             * 重启首轮：基线是重启那一刻的目录状态，应用关闭期间的增长不会表现为「变化」。
             * 已登记的文件探一次当前时长，比控制器已知的长就补一次增长；没长就什么都不做，
             * 免得把已经「整理已结束」的文件重新翻回整理中（#132 D2）。
             */
            const duration = await this.probe(entry.path);
            if (this.removed.has(project.projectId)) return;
            if (duration === null) continue;
            this.durations.set(entry.videoId, duration);
            if (!known.durationKnown || duration > known.durationSeconds + 1e-6) {
              if (!this.removed.has(project.projectId)) await this.options.ensureSource?.(project.projectId, entry, duration);
              controller.reportGrowth(entry.videoId, duration);
              changed = true;
            }
            continue;
          }
          if (discovered) continue;

          const grew =
            before.sizeBytes !== entry.sizeBytes || before.modifiedMs !== entry.modifiedMs;
          if (grew) {
            const duration = await this.probe(entry.path);
            if (this.removed.has(project.projectId)) return;
            if (duration !== null) this.durations.set(entry.videoId, duration);
            if (duration !== null && known.added && !known.durationKnown) {
              await this.options.ensureSource?.(project.projectId, entry, duration);
            }
            controller.reportGrowth(entry.videoId, duration);
            changed = true;
            continue;
          }
          // 已经加入整理、但上次读不出时长：每轮再探一次，读到后按完整块 / 尾段入队
          if (known.added && !known.durationKnown) {
            const duration = await this.probe(entry.path);
            if (this.removed.has(project.projectId)) return;
            if (duration === null) continue;
            this.durations.set(entry.videoId, duration);
            await this.options.ensureSource?.(project.projectId, entry, duration);
            controller.reportGrowth(entry.videoId, duration);
            changed = true;
          }
        }

        this.snapshots.set(project.projectId, current);

        if (previous !== undefined) {
          for (const videoId of previous.keys()) {
            if (current.has(videoId)) continue;
            this.durations.delete(videoId);
            const file = controller.files.get(videoId);
            if (file === undefined || !file.present) continue;
            controller.markMissing(videoId);
            this.options.event(project.projectId, `文件已移除：${file.name}，停止整理`);
            changed = true;
          }
        }

        // 增长已按当前时钟结算，再统一入队：不会拿旧的 lastGrowth 提前补尾段（#132 评审 P1）
        controller.settle();
        // 仅由时间流逝产生的可观察变化（整理已结束、补尾段）也要推送
        if (stateSignature(controller) !== beforePoll) changed = true;

        // settle 与推送之间可能刚被删除：别对已删项目发「已变化」通知（#154 评审 P2）
        if (changed && !this.removed.has(project.projectId)) this.options.changed(project.projectId);
      }
    } finally {
      this.polling = false;
    }
  }

  private async probe(path: string): Promise<number | null> {
    try {
      const duration = await this.options.probeDuration(path);
      return duration !== null && Number.isFinite(duration) && duration >= 0 ? duration : null;
    } catch {
      return null;
    }
  }
}

/** 控制器对外可见的状态签名：整理三态、未切片时长、两条队列长度。 */
function stateSignature(controller: ClipProject): string {
  const files = [...controller.files.values()]
    .map((file) => `${file.id}:${controller.statusOf(file.id)}:${controller.unslicedSeconds(file.id)}`)
    .join("|");
  return `${files}#${controller.analysisQueue.length}/${controller.sliceQueue.length}`;
}
