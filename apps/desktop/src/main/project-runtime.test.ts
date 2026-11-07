import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectEventLog,
  ProjectStore,
  configureLogging,
  emptyVideoData,
  topicKey,
  videoIdFor,
  writeVideoData,
  type AnalysisJob,
  type ProposedTopic,
  type SliceJob,
} from "@video-notes/core";
import { makeTmpDir } from "@video-notes/core/testing";
import { ProjectService } from "./projects";
import { ProjectRuntime, type ProjectVideo } from "./project-runtime";

/** 可注入的互斥锁：同一个输出目录同时只允许一个任务。 */
function fakeLocks() {
  const held = new Set<string>();
  const waiters: Array<{ dir: string; resolve: () => void }> = [];
  const acquire = async (dir: string): Promise<{ release(): void }> => {
    while (held.has(dir)) {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ dir, resolve });
      await promise;
    }
    held.add(dir);
    return {
      release() {
        held.delete(dir);
        const index = waiters.findIndex((w) => w.dir === dir);
        if (index >= 0) {
          const [next] = waiters.splice(index, 1);
          next?.resolve();
        }
      },
    };
  };
  return { acquire, held };
}

async function flush(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  throw new Error(`等待超时：${label}`);
}

function setup() {
  const root = makeTmpDir("project-runtime-");
  const service = new ProjectService({ store: ProjectStore.atRoot(root), events: new ProjectEventLog() });
  const locks = fakeLocks();
  const started: string[] = [];
  const sliced: SliceJob[] = [];
  let analyzeImpl: (
    job: AnalysisJob,
    onStage?: (stage: 0 | 1, progress?: { done: number; total: number }) => void,
  ) => Promise<ProposedTopic[]> = async () => [];
  let generateImpl: ((job: SliceJob) => Promise<{ file: string }>) | undefined;

  const runtime = new ProjectRuntime({
    service,
    acquireLock: locks.acquire,
    transcriptOf: () =>
      Array.from({ length: 6 }, (_, i) => ({ id: `line-${i}`, start: i * 10, end: (i + 1) * 10, text: `第 ${i} 行` })),
    analyzeRange: async (job, _video, _lock, onStage) => {
      started.push(`analyze:${job.id}:${job.fileId}`);
      return analyzeImpl(job, onStage);
    },
    generateClip: async (job) => {
      started.push(`slice:${job.id}:${job.fileId}`);
      sliced.push(job);
      return generateImpl !== undefined ? generateImpl(job) : { file: `${String(job.id).padStart(3, "0")}-${job.title}.mp4` };
    },
  });

  return {
    root,
    service,
    runtime,
    locks,
    started,
    sliced,
    setAnalyze(fn: (job: AnalysisJob, onStage?: (stage: 0 | 1, progress?: { done: number; total: number }) => void) => Promise<ProposedTopic[]>) {
      analyzeImpl = fn;
    },
    setGenerate(fn: (job: SliceJob) => Promise<{ file: string }>) {
      generateImpl = fn;
    },
  };
}

const V1: ProjectVideo = { id: "v1", name: "晚场.mp4", durationSeconds: 1200, outputDir: "/out/v1", sourcePath: "/v1.mp4", hasVideo: true };
const V2: ProjectVideo = { id: "v2", name: "复盘.mp4", durationSeconds: 600, outputDir: "/out/v2", sourcePath: "/v2.mp4", hasVideo: true };

describe("ProjectRuntime：全局两槽执行器", () => {
  test("不同视频的切片与分析可以同时在跑", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "并发", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 600 });
    ctx.runtime.registerVideo(project.id, V2);
    ctx.runtime.attachProject(project.id);

    const gate = Promise.withResolvers<void>();
    const sliceGate = Promise.withResolvers<void>();
    ctx.setAnalyze(async (job) => {
      if (job.fileId === "v2") await gate.promise;
      return [{ id: "t1", title: "主题一", category: "", lineIds: ["line-0"] }];
    });
    ctx.setGenerate(async () => {
      await sliceGate.promise;
      return { file: "001-主题一.mp4" };
    });
    ctx.service.startOrganize(project.id, ["v1", "v2"]);
    await waitUntil(() => ctx.started.includes("analyze:2:v2"), "v2 分析启动");

    // 分析槽跑 v2（被闸门挡着），切片槽跑 v1 的切片：两条队列同时在跑
    expect(ctx.started).toContain("analyze:2:v2");
    expect(ctx.started).toContain("slice:1:v1");
    expect(ctx.service.get(project.id).queue?.analysis.filter((task) => task.status === "running")).toHaveLength(1);
    expect(ctx.service.get(project.id).queue?.slices.filter((task) => task.status === "running")).toHaveLength(1);

    gate.resolve();
    sliceGate.resolve();
    await flush();
  });

  test("同一个视频：分析持锁时切片等待，不会并行写同一个视频", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "互斥", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, V1);
    ctx.runtime.attachProject(project.id);
    // 需要两个分块来制造锁竞争：关闭智能语义分块（#155），1200 秒按 10 分钟拆两块
    ctx.service.updateSettings(project.id, { semanticChunking: false });

    const secondRun = Promise.withResolvers<void>();
    const sliceGate = Promise.withResolvers<void>();
    let analysisActive = 0;
    let sliceActive = 0;
    let overlapped = false;
    let first = true;
    ctx.setAnalyze(async () => {
      if (first) {
        first = false;
        return [{ id: "t1", title: "主题一", category: "", lineIds: ["line-0"] }];
      }
      analysisActive += 1;
      if (sliceActive > 0) overlapped = true;
      await secondRun.promise;
      analysisActive -= 1;
      return [];
    });
    ctx.setGenerate(async () => {
      sliceActive += 1;
      if (analysisActive > 0) overlapped = true;
      await sliceGate.promise;
      sliceActive -= 1;
      return { file: "001-主题一.mp4" };
    });
    // 两个分块：第一个完成后切片入队；第二个分析与切片都想要 v1 的锁
    ctx.service.startOrganize(project.id, ["v1"]);
    await waitUntil(() => ctx.started.includes("analyze:2:v1") || ctx.sliced.length === 1, "第二个任务启动");
    // 无论谁先拿到锁，另一个都必须等它释放：不能同时写同一个视频
    const analysisWon = ctx.started.includes("analyze:2:v1");
    if (analysisWon) {
      expect(ctx.sliced).toHaveLength(0);
      secondRun.resolve();
      await waitUntil(() => ctx.sliced.length === 1, "切片启动");
    } else {
      sliceGate.resolve();
      await waitUntil(() => ctx.started.includes("analyze:2:v1"), "第二个分块启动");
    }
    sliceGate.resolve();
    secondRun.resolve();
    await flush(30);
    expect(overlapped).toBe(false);
    expect(ctx.service.get(project.id).clips.map((clip) => clip.seq)).toEqual([1]);
  });
});

describe("ProjectRuntime：切片落盘与计数", () => {
  test("主题分析开始时推进到第二阶段并立即推送详情", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "阶段", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    ctx.runtime.attachProject(project.id);
    ctx.service.updateSettings(project.id, { autoSlice: false });

    const pushed: Array<{ status: string; stage: number }> = [];
    ctx.service.onChange(({ detail }) => {
      const task = detail.queue?.analysis[0];
      if (task !== undefined) pushed.push({ status: task.status, stage: task.stage });
    });
    ctx.setAnalyze(async (_job, onStage) => {
      onStage?.(1);
      await flush(5);
      return [];
    });

    ctx.service.startOrganize(project.id, ["v1"]);
    await flush(60);

    // 真实进度的第二阶段必须被推出去，界面才不会一直停在「字幕解析进行中」
    expect(pushed.some((item) => item.status === "running" && item.stage === 1)).toBe(true);
    expect(pushed.at(-1)).toEqual({ status: "done", stage: 1 });
  });

  test("队列每次推进都推送详情：界面不用等下一次操作才看到完成", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "推送", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    ctx.runtime.attachProject(project.id);
    ctx.service.updateSettings(project.id, { autoSlice: false });
    ctx.setAnalyze(async () => [{ id: "t1", title: "主题一", category: "", lineIds: ["line-0"] }]);

    const pushed: Array<{ analysis: string; slices: string; proposed: number }> = [];
    ctx.service.onChange(({ detail }) => {
      pushed.push({
        analysis: detail.queue?.analysis.map((task) => task.status).join(",") ?? "",
        slices: detail.queue?.slices.map((task) => task.status).join(",") ?? "",
        proposed: detail.queue?.proposed.length ?? 0,
      });
    });

    ctx.service.startOrganize(project.id, ["v1"]);
    await flush(40);

    // 分析完成的那一次推送必须已经带上待确认主题，而不是等到下一次用户操作才补
    expect(pushed.at(-1)).toEqual({ analysis: "done", slices: "", proposed: 1 });
  });

  test("切片完成后写项目清单与计数，序号单调", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "落盘", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, V1);
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [{ id: "t:1", title: "冒号主题", category: "", lineIds: ["line-1"] }]);

    ctx.service.startOrganize(project.id, ["v1"]);
    await flush(20);

    const detail = ctx.service.get(project.id);
    expect(detail.clipCount).toBe(1);
    expect(detail.clips[0]?.seq).toBe(1);
    expect(detail.clips[0]?.topicId).toBe("t:1");
    expect(detail.clips[0]?.file).toBe("001-冒号主题.mp4");
    expect(detail.queue?.slices[0]?.status).toBe("done");
  });

  test("自动切片开启：全部主题产出切片，视频整理已结束、未切片 0", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "全自动", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [
      { id: "a", title: "主题甲", category: "", lineIds: ["line-0"] },
      { id: "b", title: "主题乙", category: "", lineIds: ["line-1"] },
    ]);

    ctx.service.startOrganize(project.id, ["v1"]);
    await waitUntil(() => {
      const slices = ctx.service.get(project.id).queue?.slices ?? [];
      return slices.length === 2 && slices.every((task) => task.status === "done");
    }, "全部切片完成");

    const detail = ctx.service.get(project.id);
    expect(detail.clips.map((clip) => clip.file)).toEqual(["001-主题甲.mp4", "002-主题乙.mp4"]);
    expect(detail.queue?.proposed).toEqual([]);
    expect(detail.queue?.files[0]?.organizeStatus).toBe("finished");
    expect(detail.queue?.files[0]?.unslicedSeconds).toBe(0);
  });

  test("自动切片关闭：分析完成、切片 0、主题全部待确认；再打开自动切片入队且不重复", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "手工", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { autoSlice: false });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [
      { id: "a", title: "主题甲", category: "", lineIds: ["line-0"] },
      { id: "b", title: "主题乙", category: "", lineIds: ["line-1"] },
    ]);

    ctx.service.startOrganize(project.id, ["v1"]);
    await waitUntil(() => ctx.service.get(project.id).queue?.analysis.every((task) => task.status === "done") === true, "分析完成");
    const manual = ctx.service.get(project.id);
    expect(manual.clips).toEqual([]);
    expect(manual.queue?.slices).toEqual([]);
    expect(manual.queue?.proposed.map((topic) => topic.title)).toEqual(["主题甲", "主题乙"]);

    ctx.service.updateSettings(project.id, { autoSlice: true });
    await waitUntil(() => ctx.service.get(project.id).clips.length === 2, "打开后补齐切片");
    expect(ctx.service.get(project.id).queue?.slices.map((task) => task.topicKey)).toEqual(
      expect.arrayContaining(["1:a", "1:b"]),
    );
  });
});

describe("ProjectRuntime：真实运行锁", () => {
  test("输出目录还不存在时先建目录再取锁，分析不会因为锁文件 ENOENT 卡住", async () => {
    const root = makeTmpDir("project-runtime-lock-");
    const service = new ProjectService({ store: ProjectStore.atRoot(root), events: new ProjectEventLog() });
    const project = service.create({ name: "首次整理", rootDir: join(root, "p") });
    service.updateSettings(project.id, { autoSlice: false });
    const outputDir = join(root, "notes", "还没导入的视频");
    expect(existsSync(outputDir)).toBe(false);

    const runtime = new ProjectRuntime({
      service,
      transcriptOf: () => [],
      analyzeRange: async () => [{ id: "t1", title: "主题一", category: "", lineIds: [] }],
    });
    runtime.registerVideo(project.id, {
      id: "v1",
      name: "a.mp4",
      durationSeconds: 30,
      outputDir,
      sourcePath: join(root, "a.mp4"),
      hasVideo: true,
    });
    runtime.attachProject(project.id);

    runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(() => service.get(project.id).queue?.analysis.every((task) => task.status === "done") === true, "分析完成");

    expect(readdirSync(outputDir)).toEqual([]);
    expect(service.get(project.id).queue?.proposed.map((topic) => topic.title)).toEqual(["主题一"]);
  });
});

describe("ProjectRuntime：监控目录里未导入的文件（#128）", () => {
  test("按路径注册元数据后加入整理，文件进入分析队列", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "目录整理", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { autoSlice: false });
    const sourcePath = join(ctx.root, "recordings", "新录制.mp4");
    const analyzed: string[] = [];

    const runtime = new ProjectRuntime({
      service: ctx.service,
      transcriptOf: () => [],
      analyzeRange: async (job) => {
        analyzed.push(job.fileId);
        return [];
      },
      describeSource: async (path) => {
        if (path !== sourcePath) return undefined;
        return {
          id: videoIdFor(path),
          name: "新录制.mp4",
          durationSeconds: 30,
          outputDir: join(ctx.root, "out", "新录制"),
          sourcePath: path,
          hasVideo: true,
        };
      },
    });

    const registered = await runtime.registerSources(project.id, [sourcePath, "/not/in/watch.mp4"]);
    expect(registered).toEqual([videoIdFor(sourcePath)]);
    expect(runtime.attachProject(project.id).files.has(videoIdFor(sourcePath))).toBe(true);

    runtime.startOrganize(project.id, [videoIdFor(sourcePath)]);
    await waitUntil(() => ctx.service.get(project.id).queue?.analysis.some((task) => task.status === "done") === true, "目录文件分析完成");

    expect(analyzed).toEqual([videoIdFor(sourcePath)]);
    expect(ctx.service.get(project.id).videoIds).toEqual([videoIdFor(sourcePath)]);
  });

  test("已导入过的路径不重复注册；没有 describeSource 时静默跳过", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "重复", rootDir: join(ctx.root, "p") });
    let calls = 0;

    const runtime = new ProjectRuntime({
      service: ctx.service,
      transcriptOf: () => [],
      analyzeRange: async () => [],
      describeSource: async () => {
        calls += 1;
        return undefined;
      },
    });

    expect(await runtime.registerSources(project.id, [])).toEqual([]);
    expect(await runtime.registerSources(project.id, ["/x.mp4"])).toEqual([]);
    expect(calls).toBe(1);
  });

  test("时长读不出的监控文件可以先加入整理，可读后补齐元数据再入队", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "录制中", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { autoSlice: false });
    const sourcePath = join(ctx.root, "recordings", "录制中.mp4");
    const videoId = videoIdFor(sourcePath);
    const analyzed: string[] = [];

    const runtime = new ProjectRuntime({
      service: ctx.service,
      transcriptOf: () => [],
      analyzeRange: async (job) => {
        analyzed.push(job.fileId);
        return [];
      },
      // 录制中的 mp4 读不出时长；监控给出 durationHint 时才建元数据
      describeSource: async (path, durationHint) => {
        if (path !== sourcePath || durationHint === undefined) return undefined;
        return {
          id: videoId,
          name: "录制中.mp4",
          durationSeconds: durationHint,
          outputDir: join(ctx.root, "out", "录制中"),
          sourcePath: path,
          hasVideo: true,
        };
      },
    });

    const controller = runtime.attachProject(project.id);
    controller.addFile({ id: videoId, name: "录制中.mp4", durationSeconds: null, growing: true, modifiedSeconds: 0 });
    controller.setChunkMinutes(1);

    // 监控已登记该文件：加入整理不抛、也不入队
    expect(() => runtime.startOrganize(project.id, [videoId])).not.toThrow();
    expect(controller.files.get(videoId)?.added).toBe(true);
    expect(controller.analysisQueue).toHaveLength(0);

    // 监控读到 60 秒（正好一块）：补齐源元数据 → 报告增长 → 分析任务能真的跑起来
    await runtime.registerSources(project.id, [{ path: sourcePath, durationSeconds: 60 }]);
    controller.reportGrowth(videoId, 60);
    controller.tick(1);
    await waitUntil(() => ctx.service.get(project.id).queue?.analysis.some((task) => task.status === "done") === true, "录制中文件分析完成");
    expect(analyzed).toEqual([videoId]);
  });
});

describe("ProjectRuntime：状态变化推送（#128 三态可见）", () => {
  test("分析完成与切片完成都会推送新快照，最后一个推送是整理已结束", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "推送", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 30 });
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [{ id: "t1", title: "主题", category: "", lineIds: ["line-0", "line-1"] }]);

    const statuses: string[] = [];
    ctx.service.onChange(({ detail }) => {
      const status = detail.queue?.files.find((file) => file.id === "v1")?.organizeStatus;
      if (status !== undefined) statuses.push(status);
    });

    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(
      () => ctx.service.get(project.id).queue?.files[0]?.organizeStatus === "finished",
      "整理已结束",
    );

    expect(statuses).toContain("organizing");
    expect(statuses.at(-1)).toBe("finished");
  });
});

describe("ProjectRuntime：重启后的未切片时长（#142 QA）", () => {
  test("重启后由已落盘切片恢复处理进度，未切片时长与重启前一致", async () => {
    const ctx = setup();
    const outputDir = join(ctx.root, "out");
    const project = ctx.service.create({ name: "重启恢复", rootDir: join(ctx.root, "p") });
    const video: ProjectVideo = {
      id: "v1",
      name: "short-30s.mp4",
      durationSeconds: 30,
      outputDir,
      sourcePath: join(ctx.root, "short-30s.mp4"),
      hasVideo: true,
    };
    ctx.runtime.registerVideo(project.id, video);
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [{ id: "t0-1", title: "主题", category: "", lineIds: ["line-0"] }]);

    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(
      () => (ctx.service.get(project.id).queue?.slices ?? []).some((task) => task.status === "done"),
      "切片落盘",
    );
    expect(ctx.service.get(project.id).clips).toHaveLength(1);
    expect(ctx.service.get(project.id).queue?.files[0]?.unslicedSeconds).toBe(0);

    // 切片执行器写回的 video.json：分块 0–30，区间主题已 done
    const data = emptyVideoData({
      id: video.id as never,
      title: video.name,
      sourcePath: video.sourcePath,
      durationSeconds: 30,
      outputDir,
    });
    data.chunks = [{ index: 1, start: 0, end: 30 }];
    data.topics = [
      {
        id: "t0-1" as never,
        title: "主题",
        summary: "",
        segments: [{ start: 0, end: 29.1 }],
        dirName: "主题",
        status: "done",
        selected: true,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(outputDir, data);

    // 同一个数据根目录重新起服务与执行器：projects.json 里有 clip，控制器是全新的
    const restarted = new ProjectService({
      store: ProjectStore.atRoot(ctx.root),
      events: new ProjectEventLog(),
    });
    const runtime = new ProjectRuntime({
      service: restarted,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [],
      analyzeRange: async () => [],
      resolveVideo: (videoId) => (videoId === video.id ? video : undefined),
    });
    runtime.attachProject(project.id);

    expect(restarted.get(project.id).clips).toHaveLength(1);
    expect(restarted.get(project.id).queue?.files[0]?.unslicedSeconds).toBe(0);
  });

  test("坏掉的 video.json 不拖垮项目接入：队列照常出现，进度保守回退", async () => {
    const ctx = setup();
    const outputDir = join(ctx.root, "broken-out");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "video.json"), "{不是 JSON");
    const project = ctx.service.create({ name: "坏文档", rootDir: join(ctx.root, "p") });
    const video: ProjectVideo = {
      id: "v1",
      name: "short-30s.mp4",
      durationSeconds: 30,
      outputDir,
      sourcePath: join(ctx.root, "short-30s.mp4"),
      hasVideo: true,
    };
    ctx.service.startOrganize(project.id, ["v1"]);
    ctx.service.recordClip(project.id, { seq: 1, videoId: "v1", topicId: "t0-1", file: "001-主题.mp4" });

    const restarted = new ProjectService({
      store: ProjectStore.atRoot(ctx.root),
      events: new ProjectEventLog(),
    });
    const runtime = new ProjectRuntime({
      service: restarted,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [],
      analyzeRange: async () => [],
      resolveVideo: (videoId) => (videoId === video.id ? video : undefined),
    });
    runtime.attachProject(project.id);

    expect(restarted.get(project.id).queue).not.toBeNull();
    expect(restarted.get(project.id).queue?.files[0]?.unslicedSeconds).toBe(30);
  });

  test("没有主题的已完成分块重启后仍算已处理", async () => {
    const ctx = setup();
    const outputDir = join(ctx.root, "empty-topics-out");
    const project = ctx.service.create({ name: "零主题", rootDir: join(ctx.root, "p") });
    const video: ProjectVideo = {
      id: "v1",
      name: "short-30s.mp4",
      durationSeconds: 30,
      outputDir,
      sourcePath: join(ctx.root, "short-30s.mp4"),
      hasVideo: true,
    };
    ctx.runtime.registerVideo(project.id, video);
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => []);

    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(
      () => ctx.service.get(project.id).queue?.analysis[0]?.status === "done",
      "分析完成",
    );
    expect(ctx.service.get(project.id).clips).toEqual([]);
    expect(ctx.service.get(project.id).queue?.files[0]?.unslicedSeconds).toBe(0);

    const data = emptyVideoData({
      id: video.id as never,
      title: video.name,
      sourcePath: video.sourcePath,
      durationSeconds: 30,
      outputDir,
    });
    data.chunks = [{ index: 1, start: 0, end: 30 }];
    writeVideoData(outputDir, data);

    const restarted = new ProjectService({
      store: ProjectStore.atRoot(ctx.root),
      events: new ProjectEventLog(),
    });
    const runtime = new ProjectRuntime({
      service: restarted,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [],
      analyzeRange: async () => [],
      resolveVideo: (videoId) => (videoId === video.id ? video : undefined),
    });
    runtime.attachProject(project.id);

    expect(restarted.get(project.id).queue?.files[0]?.unslicedSeconds).toBe(0);
  });
});

describe("ProjectRuntime：重启后继续整理增长中的文件（#132 D2）", () => {
  test("重启后已加入的文件仍为已加入，新增整块自动入队分析", async () => {
    const ctx = setup();
    const outputDir = join(ctx.root, "out-restart-growth");
    const project = ctx.service.create({ name: "重启增长", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { chunkMinutes: 1 });
    const video: ProjectVideo = {
      id: "v1",
      name: "直播.ts",
      durationSeconds: 60,
      outputDir,
      sourcePath: join(ctx.root, "直播.ts"),
      hasVideo: true,
    };
    ctx.runtime.registerVideo(project.id, video);
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => []);
    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(
      () => ctx.service.get(project.id).queue?.analysis[0]?.status === "done",
      "首块分析完成",
    );

    // 区间分析落盘的分块（真机由 project-analysis 写）
    const data = emptyVideoData({
      id: video.id as never,
      title: video.name,
      sourcePath: video.sourcePath,
      durationSeconds: 60,
      outputDir,
    });
    data.chunks = [{ index: 1, start: 0, end: 60 }];
    writeVideoData(outputDir, data);

    // 重启：同一数据根目录、全新 service 与 runtime（控制器是全新的）
    const restarted = new ProjectService({ store: ProjectStore.atRoot(ctx.root), events: new ProjectEventLog() });
    const analyzed: AnalysisJob[] = [];
    const runtime = new ProjectRuntime({
      service: restarted,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [],
      analyzeRange: async (job) => {
        analyzed.push(job);
        return [];
      },
      resolveVideo: (videoId) => (videoId === video.id ? video : undefined),
    });
    const controller = runtime.attachProject(project.id);

    // 清单里已加入的文件必须恢复成「已加入」，不能回到未整理（QA 的按钮灰死就是这里）
    expect(restarted.get(project.id).queue?.files[0]).toMatchObject({ id: "v1", added: true });
    // 已落盘的分块不再重排：从分块终点续排
    expect(controller.files.get("v1")?.cursorSeconds).toBe(60);
    expect(analyzed).toHaveLength(0);

    // 录制继续增长到 120 秒：新整块自动入队、分析完成，不需要人工操作
    controller.reportGrowth("v1", 120);
    controller.tick(1);
    await waitUntil(() => analyzed.some((job) => job.start === 60 && job.end === 120), "新整块入队");
    await waitUntil(
      () =>
        restarted
          .get(project.id)
          .queue?.analysis.some((task) => task.startSeconds === 60 && task.status === "done") === true,
      "新整块分析完成",
    );
  });
});

describe("ProjectRuntime：首轮轮询前就开始整理（#132 D3）", () => {
  test("控制器还没有该文件时也记下加入请求，监控登记后自动入队", async () => {
    const root = makeTmpDir("project-runtime-race-");
    const service = new ProjectService({ store: ProjectStore.atRoot(root), events: new ProjectEventLog() });
    const project = service.create({ name: "竞态", rootDir: join(root, "p") });
    service.updateSettings(project.id, { chunkMinutes: 1 });
    const sourcePath = join(root, "recordings", "弹窗增长.ts");
    const videoId = videoIdFor(sourcePath);
    const analyzed: AnalysisJob[] = [];

    const runtime = new ProjectRuntime({
      service,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [],
      analyzeRange: async (job) => {
        analyzed.push(job);
        return [];
      },
      // 0 字节时 describeSource 读不出任何元数据（QA 的最短复现路径）
      describeSource: async (path, durationHint) => {
        if (path !== sourcePath || durationHint === undefined) return undefined;
        return {
          id: videoId,
          name: "弹窗增长.ts",
          durationSeconds: durationHint,
          outputDir: join(root, "out", "弹窗增长"),
          sourcePath: path,
          hasVideo: false,
        };
      },
    });

    // 开始监控后 ~0.7 秒点「开始整理」：控制器里还没有这个文件
    const controller = runtime.attachProject(project.id);
    expect(() => runtime.startOrganize(project.id, [videoId])).not.toThrow();
    expect(controller.files.has(videoId)).toBe(false);

    // 首次轮询登记：0 字节、读不出时长
    controller.addFile({ id: videoId, name: "弹窗增长.ts", durationSeconds: null, growing: true, modifiedSeconds: 0 });
    expect(service.get(project.id).queue?.files[0]).toMatchObject({ id: videoId, added: true });
    expect(analyzed).toHaveLength(0);

    // 追加到满块：监控补齐源元数据 → 自动入队分析
    await runtime.registerSources(project.id, [{ path: sourcePath, durationSeconds: 80 }]);
    controller.reportGrowth(videoId, 80);
    controller.tick(1);
    await waitUntil(() => analyzed.some((job) => job.start === 0 && job.end === 60), "满块入队");
  });
});

describe("ProjectRuntime：重启后监控目录文件的磁盘进度（#132 D2）", () => {
  test("第一次登记时恢复已处理与分块终点，只排新增内容", async () => {
    const root = makeTmpDir("project-runtime-monitored-");
    const service = new ProjectService({ store: ProjectStore.atRoot(root), events: new ProjectEventLog() });
    const project = service.create({ name: "监控重启", rootDir: join(root, "p") });
    service.updateSettings(project.id, { chunkMinutes: 1 });
    const watchDir = join(root, "watch");
    mkdirSync(watchDir, { recursive: true });
    const sourcePath = join(watchDir, "直播.ts");
    const videoId = videoIdFor(sourcePath);
    const outputDir = join(root, "notes", `直播-${videoId}`);
    writeFileSync(sourcePath, "");

    // 上一次运行落盘的分块（0–60，无主题 ⇒ 算已处理）
    const data = emptyVideoData({
      id: videoId as never,
      title: "直播.ts",
      sourcePath,
      durationSeconds: 60,
      outputDir,
    });
    data.chunks = [{ index: 1, start: 0, end: 60 }];
    writeVideoData(outputDir, data);
    service.startOrganize(project.id, [videoId]);

    const analyzed: AnalysisJob[] = [];
    const runtime = new ProjectRuntime({
      service,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [],
      analyzeRange: async (job) => {
        analyzed.push(job);
        return [];
      },
      // 监控目录里的文件不在视频库：重启时没有任何元数据，只有首次登记能拿到输出目录
      describeSource: async (path, durationHint) =>
        path === sourcePath
          ? { id: videoId, name: "直播.ts", durationSeconds: durationHint ?? 0, outputDir, sourcePath: path, hasVideo: false }
          : undefined,
    });

    const controller = runtime.attachProject(project.id);
    expect(controller.files.has(videoId)).toBe(false);
    expect(service.get(project.id).queue?.files).toEqual([]);

    // 监控首轮登记：已加入 + 磁盘进度一起恢复，不重排已分块的 0–60
    await runtime.registerSources(project.id, [{ path: sourcePath, durationSeconds: 60 }]);
    expect(controller.files.get(videoId)).toMatchObject({
      added: true,
      cursorSeconds: 60,
      processedSeconds: 60,
    });
    expect(analyzed).toHaveLength(0);
    expect(service.get(project.id).queue?.files[0]?.unslicedSeconds).toBe(0);

    // 录制继续增长到 120 秒：只排新的整块
    controller.reportGrowth(videoId, 120);
    controller.tick(1);
    await waitUntil(() => analyzed.some((job) => job.start === 60 && job.end === 120), "新整块入队");
  });
});

describe("ProjectRuntime：重启后仍有待确认主题（#132 D2 / #150）", () => {
  test("恢复点退回该分块：主题重新提案，不因分块已存在而失去入口", async () => {
    const ctx = setup();
    const outputDir = join(ctx.root, "pending-out");
    const project = ctx.service.create({ name: "待确认重启", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { chunkMinutes: 1, autoSlice: false });
    const video: ProjectVideo = {
      id: "v1",
      name: "直播.ts",
      durationSeconds: 60,
      outputDir,
      sourcePath: join(ctx.root, "直播.ts"),
      hasVideo: false,
    };
    ctx.runtime.registerVideo(project.id, video);
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [{ id: "t0-1", title: "待确认主题", category: "", lineIds: ["line-0"] }]);
    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(() => ctx.service.get(project.id).queue?.analysis[0]?.status === "done", "首次分析完成");
    expect(ctx.service.get(project.id).queue?.proposed).toHaveLength(1);

    // 落盘：分块 0–60 已分析，主题仍是 proposed（用户还没确认就退出了）
    const data = emptyVideoData({
      id: video.id as never,
      title: video.name,
      sourcePath: video.sourcePath,
      durationSeconds: 60,
      outputDir,
    });
    data.chunks = [{ index: 1, start: 0, end: 60 }];
    data.topics = [
      {
        id: "t0-1" as never,
        title: "待确认主题",
        summary: "",
        segments: [{ start: 0, end: 59 }],
        dirName: "待确认主题",
        status: "proposed",
        selected: true,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(outputDir, data);

    const restarted = new ProjectService({ store: ProjectStore.atRoot(ctx.root), events: new ProjectEventLog() });
    const analyzed: AnalysisJob[] = [];
    const runtime = new ProjectRuntime({
      service: restarted,
      acquireLock: async () => ({ release() {} }),
      transcriptOf: () => [{ id: "line-0", start: 0, end: 5, text: "第一句" }],
      // 真机由 project-analysis 的 refreshableTopics 给出仍待确认的主题
      analyzeRange: async (job) => {
        analyzed.push(job);
        return [{ id: "t0-1", title: "待确认主题", category: "", lineIds: ["line-0"] }];
      },
      resolveVideo: (videoId) => (videoId === video.id ? video : undefined),
    });
    const controller = runtime.attachProject(project.id);

    // 分块都在，但主题没切片：续排点是已处理（0），该区间要重新排进来
    expect(controller.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 60]]);
    await waitUntil(() => analyzed.some((job) => job.start === 0), "待确认区间重新排入");
    await waitUntil(
      () => (restarted.get(project.id).queue?.proposed.length ?? 0) === 1,
      "待确认主题重新出现",
    );
  });
});

describe("ProjectRuntime：删除在飞项目的运行时清理（#154）", () => {
  function removalSetup() {
    const root = makeTmpDir("runtime-detach-");
    const store = ProjectStore.atRoot(root);
    const events = new ProjectEventLog();
    const locks = fakeLocks();
    let runtimeRef: ProjectRuntime | undefined;
    const service = new ProjectService({
      store,
      events,
      onProjectRemoved: (projectId) => runtimeRef?.detachProject(projectId),
    });
    let analyzeImpl: (job: AnalysisJob) => Promise<ProposedTopic[]> = async () => [
      { id: "t1", title: "主题一", category: "", lineIds: ["line-0"] },
    ];
    let generateImpl: (job: SliceJob) => Promise<{ file: string }> = async () => ({ file: "001-x.mp4" });
    const started: string[] = [];
    const runtime = new ProjectRuntime({
      service,
      acquireLock: locks.acquire,
      transcriptOf: () => [{ id: "line-0", start: 0, end: 5, text: "第一句" }],
      analyzeRange: async (job) => {
        started.push(`analyze:${job.id}`);
        return analyzeImpl(job);
      },
      generateClip: async (job) => {
        started.push(`slice:${job.id}`);
        return generateImpl(job);
      },
    });
    runtimeRef = runtime;
    const logLines: string[] = [];
    configureLogging({ sink: (line) => logLines.push(line) });
    return {
      root,
      service,
      runtime,
      started,
      logLines,
      setAnalyze(fn: (job: AnalysisJob) => Promise<ProposedTopic[]>) {
        analyzeImpl = fn;
      },
      setGenerate(fn: (job: SliceJob) => Promise<{ file: string }>) {
        generateImpl = fn;
      },
    };
  }

  test("在飞分析任务期间删除项目：控制器 dispose、不再产生「未知项目」", async () => {
    const ctx = removalSetup();
    try {
      const project = ctx.service.create({ name: "在飞删除", rootDir: join(ctx.root, "p") });
      ctx.runtime.registerVideo(project.id, V1);
      ctx.runtime.attachProject(project.id);
      const gate = Promise.withResolvers<ProposedTopic[]>();
      ctx.setAnalyze(() => gate.promise);
      ctx.service.startOrganize(project.id, ["v1"]);
      await waitUntil(() => ctx.started.length > 0, "分析启动");

      ctx.service.remove(project.id);
      expect(ctx.runtime.controller(project.id)).toBeUndefined();

      gate.resolve([{ id: "t1", title: "主题一", category: "", lineIds: ["line-0"] }]);
      await flush(30);
      expect(ctx.logLines.some((line) => line.includes("未知项目"))).toBe(false);
    } finally {
      configureLogging();
    }
  });

  test("在飞切片任务期间删除项目：成功路径不写清单、不抛「未知项目」", async () => {
    const ctx = removalSetup();
    try {
      const project = ctx.service.create({ name: "切片删除", rootDir: join(ctx.root, "p") });
      ctx.service.updateSettings(project.id, { autoSlice: false });
      ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
      ctx.runtime.attachProject(project.id);
      ctx.runtime.startOrganize(project.id, ["v1"]);
      await waitUntil(() => ctx.service.get(project.id).queue?.analysis[0]?.status === "done", "分析完成");
      const gate = Promise.withResolvers<{ file: string }>();
      ctx.setGenerate(() => gate.promise);
      ctx.service.confirmTopic(project.id, topicKey(1, "t1"), ["line-0"]);
      await waitUntil(() => ctx.started.some((s) => s.startsWith("slice:")), "切片启动");

      ctx.service.remove(project.id);
      gate.resolve({ file: "001-主题一.mp4" });
      await flush(30);
      expect(ctx.logLines.some((line) => line.includes("未知项目"))).toBe(false);
    } finally {
      configureLogging();
    }
  });

  test("在飞切片任务失败于删除之后：catch 路径也不抛「未知项目」", async () => {
    const ctx = removalSetup();
    try {
      const project = ctx.service.create({ name: "切片失败删除", rootDir: join(ctx.root, "p") });
      ctx.service.updateSettings(project.id, { autoSlice: false });
      ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
      ctx.runtime.attachProject(project.id);
      ctx.runtime.startOrganize(project.id, ["v1"]);
      await waitUntil(() => ctx.service.get(project.id).queue?.analysis[0]?.status === "done", "分析完成");
      const gate = Promise.withResolvers<{ file: string }>();
      ctx.setGenerate(() => gate.promise);
      ctx.service.confirmTopic(project.id, topicKey(1, "t1"), ["line-0"]);
      await waitUntil(() => ctx.started.some((s) => s.startsWith("slice:")), "切片启动");

      ctx.service.remove(project.id);
      gate.reject(new Error("ffmpeg exit 234"));
      await flush(30);
      expect(ctx.logLines.some((line) => line.includes("未知项目"))).toBe(false);
    } finally {
      configureLogging();
    }
  });

  test("删除后管线再报进度：立刻中止分析，不落 failed、不写失败事件", async () => {
    const root = makeTmpDir("runtime-cancel-");
    const store = ProjectStore.atRoot(root);
    const events = new ProjectEventLog();
    const locks = fakeLocks();
    let runtimeRef: ProjectRuntime | undefined;
    const service = new ProjectService({
      store,
      events,
      onProjectRemoved: (projectId) => runtimeRef?.detachProject(projectId),
    });
    const opened = Promise.withResolvers<void>();
    const started: string[] = [];
    const runtime = new ProjectRuntime({
      service,
      acquireLock: locks.acquire,
      transcriptOf: () => [{ id: "line-0", start: 0, end: 5, text: "第一句" }],
      /**
       * 真实管线在每个窗口结束后回报进度；删除发生后这次回报必须抛出，
       * 后面的窗口、切片与结构化日志都不再发生（#154 评审 P1）。
       */
      analyzeRange: async (job, _video, _lock, onStage) => {
        started.push(`analyze:${job.id}`);
        await opened.promise;
        onStage?.(1, { done: 1, total: 3 });
        return [{ id: "t1", title: "主题一", category: "", lineIds: ["line-0"] }];
      },
    });
    runtimeRef = runtime;
    const logLines: string[] = [];
    configureLogging({ sink: (line) => logLines.push(line) });
    try {
      const project = service.create({ name: "删除中止", rootDir: join(root, "p") });
      runtime.registerVideo(project.id, V1);
      runtime.attachProject(project.id);
      service.startOrganize(project.id, ["v1"]);
      await waitUntil(() => started.length > 0, "分析启动");

      service.remove(project.id);
      opened.resolve();
      await flush(30);

      expect(logLines.some((line) => line.includes("项目已删除，分析中止"))).toBe(true);
      // 中止不是失败：不写 error 事件、不落 failed 终态，管线那层的 step 也不留带堆栈的 ERROR
      expect(logLines.some((line) => line.includes("区间分析失败"))).toBe(false);
      expect(logLines.some((line) => line.includes("未知项目"))).toBe(false);
    } finally {
      configureLogging();
    }
  });
});

describe("ProjectRuntime：失败原因写进运行日志（#154）", () => {
  test("分析失败：事件里出现 error 级别短原因（视频名 + 区间 + 短原因）", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "失败事件", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 600 });
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => {
      throw new Error("LLM 请求失败 401 Unauthorized");
    });
    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(() => ctx.service.get(project.id).events[0]?.level === "error", "失败事件出现");
    const event = ctx.service.get(project.id).events[0]!;
    expect(event.level).toBe("error");
    expect(event.text).toContain("区间分析失败");
    expect(event.text).toContain("晚场.mp4");
    expect(event.text).toContain("00:00–10:00");
    expect(event.text).toContain("API key 无效");
    // 原始细节只进结构化日志，不进事件文案
    expect(event.text).not.toContain("401 Unauthorized");
    expect(ctx.service.get(project.id).queue?.analysis[0]?.status).toBe("failed");
  });

  test("切片失败：事件里出现 error 级别短原因（主题标题）", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "切片失败事件", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { autoSlice: false });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    ctx.runtime.attachProject(project.id);
    ctx.setAnalyze(async () => [{ id: "t1", title: "主题一", category: "", lineIds: ["line-0"] }]);
    ctx.runtime.startOrganize(project.id, ["v1"]);
    await waitUntil(() => ctx.service.get(project.id).queue?.analysis[0]?.status === "done", "分析完成");
    ctx.setGenerate(async () => {
      throw new Error("切主题切片 failed (exit 234) / Stream map '' matches no streams");
    });
    ctx.service.confirmTopic(project.id, topicKey(1, "t1"), ["line-0"]);
    await waitUntil(() => ctx.service.get(project.id).events[0]?.level === "error", "切片失败事件出现");
    const event = ctx.service.get(project.id).events[0]!;
    expect(event.level).toBe("error");
    expect(event.text).toContain("切片失败");
    expect(event.text).toContain("主题一");
    expect(event.text).toContain("该文件没有可用的音视频轨道");
    expect(event.text).not.toContain("exit 234");
  });
});

describe("ProjectRuntime：主题分析窗口进度回传（#155）", () => {
  test("onStage 带窗口进度时写入任务快照；完成时清空", async () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "窗口进度", rootDir: join(ctx.root, "p") });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    ctx.runtime.attachProject(project.id);
    ctx.service.updateSettings(project.id, { autoSlice: false });

    const pushed: Array<{ done: number; total: number } | undefined> = [];
    ctx.service.onChange(({ detail }) => {
      const task = detail.queue?.analysis[0];
      if (task !== undefined) pushed.push(task.progress);
    });
    ctx.setAnalyze(async (_job, onStage) => {
      onStage?.(1, { done: 0, total: 3 });
      onStage?.(1, { done: 2, total: 3 });
      await flush(5);
      return [];
    });

    ctx.service.startOrganize(project.id, ["v1"]);
    await flush(60);

    expect(pushed.some((progress) => progress?.done === 2 && progress.total === 3)).toBe(true);
    expect(ctx.service.get(project.id).queue?.analysis[0]?.progress).toBeUndefined();
  });

  test("attachProject 时把清单里的 semanticChunking 作用到新建控制器（#155）", () => {
    const ctx = setup();
    const project = ctx.service.create({ name: "开关", rootDir: join(ctx.root, "p") });
    ctx.service.updateSettings(project.id, { semanticChunking: false });
    ctx.runtime.registerVideo(project.id, { ...V1, durationSeconds: 60 });
    const controller = ctx.runtime.attachProject(project.id);
    expect(controller.semanticChunkingEnabled).toBe(false);
  });
});
