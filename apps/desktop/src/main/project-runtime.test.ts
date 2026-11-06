import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectEventLog,
  ProjectStore,
  videoIdFor,
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
  let analyzeImpl: (job: AnalysisJob, onStage?: (stage: 0 | 1) => void) => Promise<ProposedTopic[]> = async () => [];
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
    setAnalyze(fn: (job: AnalysisJob, onStage?: (stage: 0 | 1) => void) => Promise<ProposedTopic[]>) {
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
