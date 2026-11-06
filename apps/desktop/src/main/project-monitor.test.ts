import { describe, expect, test } from "bun:test";
import { appendFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClipProject, GROWTH_IDLE_SECONDS, videoIdFor, type ProjectExecutor, type SubtitleLine } from "@video-notes/core";
import { makeTmpDir } from "@video-notes/core/testing";
import { GrowthMonitor } from "./project-monitor";

function controller(chunkMinutes = 10): ClipProject {
  const executor: ProjectExecutor = { analyze: () => {}, slice: () => {} };
  return new ClipProject({
    executor,
    autoSlice: false,
    chunkMinutes,
    transcriptOf: (): SubtitleLine[] => [],
  });
}

type Harness = {
  monitor: GrowthMonitor;
  events: string[];
  dir: string;
  advance(ms: number): void;
};

function harness(options: {
  probe?: (path: string) => number | null;
  controller?: ClipProject;
  dir?: string;
  onPoll?: () => void;
} = {}): Harness {
  const dir = options.dir ?? makeTmpDir("growth-monitor-");
  const project = options.controller ?? controller();
  const events: string[] = [];
  let now = 0;
  const monitor = new GrowthMonitor({
    watchProjects: () => [{ projectId: "p1", watchDir: dir }],
    controllerOf: (projectId) => (projectId === "p1" ? project : undefined),
    probeDuration: async (path) => {
      options.onPoll?.();
      return options.probe === undefined ? 120 : options.probe(path);
    },
    event: (_projectId, text) => events.push(text),
    changed: () => {},
    now: () => now,
  });
  return {
    monitor,
    events,
    dir,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe("目录轮询判定增长（#132）", () => {
  test("首次轮询只建立基线，不把已有文件记成新文件", async () => {
    const h = harness();
    writeFileSync(join(h.dir, "a.mp4"), "0123456789");
    await h.monitor.poll();
    expect(h.events).toEqual([]);
    expect(h.monitor.durationOf(videoIdFor(join(h.dir, "a.mp4")))).toBe(120);
  });

  test("开始监控时落基线：基线之后的文件才算新文件", async () => {
    const project = controller();
    const h = harness({ controller: project });
    writeFileSync(join(h.dir, "a.mp4"), "0123456789");
    h.monitor.seed("p1", h.dir);

    const fresh = join(h.dir, "b.mp4");
    writeFileSync(fresh, "abcdefghij");
    await h.monitor.poll();

    expect(h.events).toEqual(["发现新文件：b.mp4，默认未勾选"]);
    expect(project.files.get(videoIdFor(fresh))?.added).toBe(false);
    expect(project.files.get(videoIdFor(join(h.dir, "a.mp4")))).toBeDefined();
  });

  test("新出现的文件默认不勾选，并记一条发现日志", async () => {
    const project = controller();
    const h = harness({ controller: project });
    writeFileSync(join(h.dir, "a.mp4"), "0123456789");
    await h.monitor.poll();

    const fresh = join(h.dir, "b.mp4");
    writeFileSync(fresh, "abcdefghij");
    await h.monitor.poll();

    const file = project.files.get(videoIdFor(fresh));
    expect(file).toBeDefined();
    expect(file?.added).toBe(false);
    expect(h.events).toEqual(["发现新文件：b.mp4，默认未勾选"]);
    expect(project.analysisQueue).toHaveLength(0);
  });

  test("大小变化记为增长：读不出时长不入队，可读后凑满一块才入队", async () => {
    const project = controller();
    const dir = makeTmpDir("growth-monitor-growth-");
    const path = join(dir, "live.mp4");
    writeFileSync(path, "0123456789");
    let now = 0;
    let duration: number | null = null;
    const monitor = new GrowthMonitor({
      watchProjects: () => [{ projectId: "p1", watchDir: dir }],
      controllerOf: () => project,
      probeDuration: async () => duration,
      event: () => {},
      changed: () => {},
      now: () => now,
    });
    await monitor.poll();
    project.startOrganize([videoIdFor(path)]);

    // 读不出时长：文件在增长，不入队
    now += 2_000;
    appendFileSync(path, "more");
    await monitor.poll();
    expect(project.analysisQueue).toHaveLength(0);
    expect(project.statusOf(videoIdFor(path))).toBe("organizing");

    // 时长可读后达到一个完整块
    duration = 600;
    now += 2_000;
    await monitor.poll();
    expect(project.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 600]]);

    // 再增长但不足一块：仍不补尾段
    duration = 700;
    now += 2_000;
    appendFileSync(path, "grown");
    await monitor.poll();
    expect(project.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 600]]);
  });

  test("恰好 30 秒不补尾段，严格超过才补；恢复增长回到持续整理中", async () => {
    const project = controller();
    let now = 0;
    let duration: number | null = 420;
    const dir = makeTmpDir("growth-monitor-tail-");
    const path = join(dir, "tail.mp4");
    writeFileSync(path, "0123456789");
    const monitor = new GrowthMonitor({
      watchProjects: () => [{ projectId: "p1", watchDir: dir }],
      controllerOf: () => project,
      probeDuration: async () => duration,
      event: () => {},
      changed: () => {},
      now: () => now,
    });
    await monitor.poll();
    project.startOrganize([videoIdFor(path)]);
    expect(project.analysisQueue).toHaveLength(0);

    now += GROWTH_IDLE_SECONDS * 1000;
    await monitor.poll();
    expect(project.analysisQueue).toHaveLength(0);

    now += 1_000;
    await monitor.poll();
    expect(project.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 420]]);
    expect(project.statusOf(videoIdFor(path))).toBe("organizing");

    // 恢复增长：最后增长时间被推后，30 秒内不再补下一段
    duration = 900;
    appendFileSync(path, "grown");
    now += 2_000;
    await monitor.poll();
    const lastGrowth = project.files.get(videoIdFor(path))?.lastGrowthSeconds;
    now += GROWTH_IDLE_SECONDS * 1000;
    await monitor.poll();
    expect(project.files.get(videoIdFor(path))?.lastGrowthSeconds).toBe(lastGrowth);
    expect(project.analysisQueue).toHaveLength(1);
    expect(project.statusOf(videoIdFor(path))).toBe("organizing");
  });

  test("只改修改时间（大小不变）也算增长", async () => {
    const project = controller();
    let now = 0;
    const dir = makeTmpDir("growth-monitor-mtime-");
    const path = join(dir, "touch.mp4");
    writeFileSync(path, "0123456789");
    const monitor = new GrowthMonitor({
      watchProjects: () => [{ projectId: "p1", watchDir: dir }],
      controllerOf: () => project,
      probeDuration: async () => 420,
      event: () => {},
      changed: () => {},
      now: () => now,
    });
    await monitor.poll();
    project.startOrganize([videoIdFor(path)]);
    expect(project.files.get(videoIdFor(path))?.lastGrowthSeconds).toBe(0);

    now += 10_000;
    utimesSync(path, 10, 10);
    await monitor.poll();
    expect(project.files.get(videoIdFor(path))?.lastGrowthSeconds).toBe(10);
  });

  test("同一轮里先结算增长再推进时钟：不会按旧时长提前补尾段（评审 P1）", async () => {
    const project = controller();
    const dir = makeTmpDir("growth-monitor-order-");
    const path = join(dir, "grow.mp4");
    writeFileSync(path, "0123456789");
    const id = videoIdFor(path);
    let now = 0;
    let duration: number | null = 420;
    const monitor = new GrowthMonitor({
      watchProjects: () => [{ projectId: "p1", watchDir: dir }],
      controllerOf: () => project,
      probeDuration: async () => duration,
      event: () => {},
      changed: () => {},
      now: () => now,
    });
    await monitor.poll();
    project.startOrganize([id]);

    // 31 秒后才观察到这次增长，而且这一轮探测失败：不能补尾段
    duration = null;
    now += 31_000;
    appendFileSync(path, "more");
    await monitor.poll();
    expect(project.analysisQueue).toHaveLength(0);
    expect(project.files.get(id)).toMatchObject({ durationKnown: false });
    expect(project.statusOf(id)).toBe("organizing");

    // 下一轮读到时长：增长时间已结算，只差 2 秒，仍不补尾段
    duration = 420;
    now += 2_000;
    await monitor.poll();
    expect(project.files.get(id)).toMatchObject({ durationKnown: true, durationSeconds: 420 });
    expect(project.analysisQueue).toHaveLength(0);
  });

  test("文件被删除 / 改名后：不再补尾段，记一条移除日志（评审 P2）", async () => {
    const project = controller();
    const h = harness({ controller: project, probe: () => 420 });
    const path = join(h.dir, "gone.mp4");
    writeFileSync(path, "0123456789");
    await h.monitor.poll();
    project.startOrganize([videoIdFor(path)]);

    rmSync(path);
    h.advance(31_000);
    await h.monitor.poll();
    expect(project.analysisQueue).toHaveLength(0);
    expect(project.files.get(videoIdFor(path))?.present).toBe(false);
    expect(h.events).toContain("文件已移除：gone.mp4，停止整理");
  });

  test("仅时间流逝让整理结束时也会推送详情（评审 P2）", async () => {
    const dir = makeTmpDir("growth-monitor-finish-");
    const path = join(dir, "done.mp4");
    writeFileSync(path, "0123456789");
    const id = videoIdFor(path);
    let now = 0;
    let changes = 0;
    let controllerRef!: ClipProject;
    const immediate: ProjectExecutor = {
      analyze: (job) => controllerRef.completeAnalysis(job.id, []),
      slice: (job) => controllerRef.completeSlice(job.id),
    };
    controllerRef = new ClipProject({ executor: immediate, autoSlice: false, chunkMinutes: 1, transcriptOf: () => [] });
    const monitor = new GrowthMonitor({
      watchProjects: () => [{ projectId: "p1", watchDir: dir }],
      controllerOf: () => controllerRef,
      probeDuration: async () => 60,
      event: () => {},
      changed: () => {
        changes += 1;
      },
      now: () => now,
    });
    await monitor.poll();
    controllerRef.startOrganize([id]);
    expect(controllerRef.statusOf(id)).toBe("organizing");
    const before = changes;

    now += 31_000;
    await monitor.poll();
    expect(controllerRef.statusOf(id)).toBe("finished");
    expect(changes).toBeGreaterThan(before);
  });
});
