import { describe, expect, test } from "bun:test";
import { JobQueue, type JobHandle, type JobRequest } from "./jobs";
import type { JobSnapshot } from "../shared/ipc";

/** 可控假 handle：记录 cancel/kill 调用，测试手动驱动终态。 */
function fakeHandle(): { handle: JobHandle; cancelCalled: () => boolean } {
  let cancelCount = 0;
  const handle: JobHandle = {
    cancel: () => {
      cancelCount += 1;
    },
    kill: () => {
      /* 测试不关心强杀 */
    },
  };
  return { handle, cancelCalled: () => cancelCount > 0 };
}

const config = { notesRoot: "/notes", cacheRoot: "/cache", modelDir: "/models" };

const job = {
  runToken: "tok-1",
  endpoint: { baseUrl: "https://llm.test", apiKey: "k", model: "m" },
  asr: { provider: "local", modelDir: "/models" },
} as const;

function makeQueue(handles: JobHandle[]) {
  const snapshots: JobSnapshot[] = [];
  const launched: JobRequest[] = [];
  const queue = new JobQueue({
    launch: (_jobId, job) => {
      launched.push(job);
      return handles.shift() ?? fakeHandle().handle;
    },
    onChange: (s) => {
      snapshots.push(s);
    },
  });
  return { queue, snapshots, launched };
}

function statesOf(snapshots: JobSnapshot[]): Map<string, string> {
  const states = new Map<string, string>();
  for (const s of snapshots) states.set(s.jobId, s.state);
  return states;
}

const doneResult = {
  videoId: "v1",
  outputDir: "/out/1",
  topicCount: 1,
  noteCount: 1,
  cacheHits: [],
  timings: { total: 1 },
} satisfies Parameters<JobQueue["finish"]>[0];

describe("JobQueue 串行", () => {
  test("第二个任务在第一个 finish 前保持 queued，finish 后才启动", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ kind: "extract", videoId: "v1", sourcePath: "/s/1.mp4", outputDir: null, config, ...job });
    const id2 = queue.enqueue({ kind: "notes", videoId: "v2", sourcePath: "", outputDir: "/out/2", config, topicIds: ["t1"], ...job });

    expect(statesOf(snapshots).get(id1)).toBe("running");
    expect(statesOf(snapshots).get(id2)).toBe("queued");
    expect(h2.cancelCalled()).toBe(false);

    queue.finish(doneResult);
    expect(statesOf(snapshots).get(id1)).toBe("succeeded");
    expect(statesOf(snapshots).get(id2)).toBe("running");
  });

  test("kind 在每个快照上都带着，launch 收到冻结的完整请求", () => {
    const h1 = fakeHandle();
    const { queue, snapshots, launched } = makeQueue([h1.handle]);
    const id = queue.enqueue({ kind: "topics", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, ...job });

    expect(snapshots.map((s) => s.kind)).toEqual(["topics", "topics"]);
    expect(launched[0]).toEqual({ kind: "topics", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, ...job });
    expect(snapshots.at(-1)?.state).toBe("running");
    expect(queue.active()?.state).toBe("running");

    queue.fail("炸了");
    expect(snapshots.at(-1)?.state).toBe("failed");
    // 终态后 active 不再复活已完成任务
    expect(queue.active()).toBeUndefined();
  });

  test("notes 与 topics 共用同一条串行槽位", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ kind: "notes", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, topicIds: ["t1"], ...job });
    const id2 = queue.enqueue({ kind: "topics", videoId: "v2", sourcePath: "", outputDir: "/out/2", config, ...job });

    expect(statesOf(snapshots).get(id1)).toBe("running");
    expect(statesOf(snapshots).get(id2)).toBe("queued");

    queue.finish(doneResult);
    expect(statesOf(snapshots).get(id1)).toBe("succeeded");
    expect(statesOf(snapshots).get(id2)).toBe("running");
    expect(queue.busy()).toBe(true);
  });

  test("运行中取消调 handle.cancel，exit 到达后落 cancelled 并释放槽位", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ kind: "extract", videoId: "v1", sourcePath: "/s/1.mp4", outputDir: null, config, ...job });
    const id2 = queue.enqueue({ kind: "extract", videoId: "v2", sourcePath: "/s/2.mp4", outputDir: null, config, ...job });

    queue.cancel(id1);
    // 运行中取消不立即落终态：等 worker exit
    expect(statesOf(snapshots).get(id1)).toBe("running");
    expect(h1.cancelCalled()).toBe(true);
    expect(queue.busy()).toBe(true);

    // 模拟 worker exit 事件到达
    queue.cancelled(id1);
    expect(statesOf(snapshots).get(id1)).toBe("cancelled");
    expect(statesOf(snapshots).get(id2)).toBe("running");
  });

  test("排队取消直接落 cancelled，且不调 handle", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    queue.enqueue({ kind: "extract", videoId: "v1", sourcePath: "/s/1.mp4", outputDir: null, config, ...job });
    const id2 = queue.enqueue({ kind: "notes", videoId: "v2", sourcePath: "", outputDir: "/out/2", config, ...job });

    queue.cancel(id2);
    const cancelled = snapshots.filter((s) => s.jobId === id2);
    expect(cancelled.at(-1)?.state).toBe("cancelled");
    expect(cancelled.at(-1)?.kind).toBe("notes");
    expect(h2.cancelCalled()).toBe(false);
    // v1 仍占着槽位
    expect(queue.busy()).toBe(true);

    queue.finish(doneResult);
    expect(queue.busy()).toBe(false);
  });

  test("失败落 failed 并释放槽位启动下一个", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ kind: "extract", videoId: "v1", sourcePath: "/s/1.mp4", outputDir: null, config, ...job });
    const id2 = queue.enqueue({ kind: "extract", videoId: "v2", sourcePath: "/s/2.mp4", outputDir: null, config, ...job });

    queue.fail("炸了");
    expect(statesOf(snapshots).get(id1)).toBe("failed");
    expect(statesOf(snapshots).get(id2)).toBe("running");
    expect(queue.busy()).toBe(true);
  });

  test("终态只能落一次：终态后的 done/error/cancel 不再改变状态", () => {
    const h1 = fakeHandle();
    const { queue } = makeQueue([h1.handle]);
    const id1 = queue.enqueue({ kind: "extract", videoId: "v1", sourcePath: "/s/1.mp4", outputDir: null, config, ...job });

    queue.fail("先失败");
    queue.finish(doneResult);
    queue.cancel(id1);
    queue.cancelled(id1);
    expect(queue.active()).toBeUndefined();
  });

  test("progress 的 topicId/topicPercent 透传到 running 快照", () => {
    const h1 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle]);
    queue.enqueue({ kind: "notes", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, topicIds: ["t1"], ...job });

    queue.progress({ step: "generate-notes", done: 2, total: 5, detail: "主题A", topicId: "t1", topicPercent: 40 });
    const running = snapshots.filter((s) => s.state === "running").at(-1);
    expect(running).toBeDefined();
    if (running?.state !== "running") throw new Error("expecting running snapshot");
    expect(running.topicId).toBe("t1");
    expect(running.topicPercent).toBe(40);
  });
});

describe("JobQueue.cancelVideo", () => {
  test("只取消指定视频的任务：排队直接落 cancelled，运行中等 exit 落，别的视频不动", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const h3 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle, h3.handle]);
    const idA1 = queue.enqueue({ kind: "extract", videoId: "va", sourcePath: "/a.mp4", outputDir: null, config, ...job });
    const idB = queue.enqueue({ kind: "notes", videoId: "vb", sourcePath: "", outputDir: "/b", config, topicIds: ["t"], ...job });
    const idA2 = queue.enqueue({ kind: "topics", videoId: "va", sourcePath: "", outputDir: "/a", config, ...job });

    expect(queue.busy()).toBe(true);
    expect(queue.cancelVideo("va")).toBe(true);
    expect(statesOf(snapshots).get(idA1)).toBe("running"); // 运行中取消等 exit
    expect(statesOf(snapshots).get(idA2)).toBe("cancelled"); // 排队直接落
    expect(h1.cancelCalled()).toBe(true);
    expect(h3.cancelCalled()).toBe(false);
    expect(queue.cancelVideo("va")).toBe(false); // 都取消过之后没有新任务

    queue.cancelled(idA1); // 模拟 worker exit
    expect(statesOf(snapshots).get(idA1)).toBe("cancelled");
    expect(statesOf(snapshots).get(idB)).toBe("running"); // 别的视频接着跑
  });

  test("没有该视频任务时返回 false 且不改状态", () => {
    const h1 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle]);
    queue.enqueue({ kind: "extract", videoId: "va", sourcePath: "/a.mp4", outputDir: null, config, ...job });
    expect(queue.cancelVideo("vx")).toBe(false);
    expect(h1.cancelCalled()).toBe(false);
    expect(snapshots.at(-1)?.state).toBe("running");
  });
});

describe("JobQueue.appendLog", () => {
  test("settle 前的日志行出现在 running 快照与终态快照里", () => {
    const { queue, snapshots } = makeQueue([fakeHandle().handle]);
    const id = queue.enqueue({ kind: "notes", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, ...job });

    queue.appendLog("tok-1", "[10:00:00] 第一行");
    queue.appendLog("tok-1", "[10:00:01] 第二行");
    const running = snapshots.filter((s) => s.state === "running" && s.jobId === id).at(-1);
    expect(running?.state).toBe("running");
    if (running?.state === "running") expect(running.logs).toEqual(["[10:00:00] 第一行", "[10:00:01] 第二行"]);

    queue.finish(doneResult);
    const terminal = snapshots.filter((s) => s.jobId === id).at(-1);
    expect(terminal?.state).toBe("succeeded");
    if (terminal?.state === "succeeded") expect(terminal.logs).toEqual(["[10:00:00] 第一行", "[10:00:01] 第二行"]);
  });

  test(`超过 ${200} 行只保留最新 200 条，最新的在最后`, () => {
    const { queue, snapshots } = makeQueue([fakeHandle().handle]);
    queue.enqueue({ kind: "notes", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, ...job });
    for (let i = 0; i < 250; i++) queue.appendLog("tok-1", `line-${i}`);

    const running = snapshots.filter((s) => s.state === "running").at(-1);
    expect(running?.state).toBe("running");
    if (running?.state === "running") {
      expect(running.logs.length).toBe(200);
      expect(running.logs[0]).toBe("line-50");
      expect(running.logs.at(-1)).toBe("line-249");
    }
    queue.finish(doneResult);
    const terminal = snapshots.filter((s) => s.state === "succeeded").at(-1);
    if (terminal?.state === "succeeded") {
      expect(terminal.logs.length).toBe(200);
      expect(terminal.logs.at(-1)).toBe("line-249");
    }
  });

  test("未知 runToken 的日志不改变任何快照", () => {
    const { queue, snapshots } = makeQueue([fakeHandle().handle]);
    const id = queue.enqueue({ kind: "notes", videoId: "v1", sourcePath: "", outputDir: "/out/1", config, ...job });
    const before = snapshots.length;

    queue.appendLog("tok-other", "[10:00:00] 别人的日志");

    expect(snapshots.length).toBe(before);
    queue.finish(doneResult);
    const terminal = snapshots.filter((s) => s.jobId === id).at(-1);
    expect(terminal?.state).toBe("succeeded");
    if (terminal?.state === "succeeded") expect(terminal.logs).toEqual([]);
  });

  test("日志行不会串到别的任务：排队任务与已结算任务都不收别人的 token", () => {
    const { queue, snapshots } = makeQueue([fakeHandle().handle, fakeHandle().handle]);
    const id1 = queue.enqueue({ ...job, kind: "extract", videoId: "v1", sourcePath: "/s/1.mp4", outputDir: null, config, runToken: "tok-a" });
    const id2 = queue.enqueue({ ...job, kind: "notes", videoId: "v2", sourcePath: "", outputDir: "/out/2", config, topicIds: ["t1"], runToken: "tok-b" });

    // 在途任务收到自己的行，tok-b 的行不进 id1
    queue.appendLog("tok-a", "[10:00:00] 任务A的行");
    queue.appendLog("tok-b", "[10:00:01] 任务B的行");
    const running = snapshots.filter((s) => s.jobId === id1).at(-1);
    expect(running?.state).toBe("running");
    if (running?.state === "running") expect(running.logs).toEqual(["[10:00:00] 任务A的行"]);
    const queued = snapshots.filter((s) => s.jobId === id2 && s.state === "queued").at(-1);
    expect(queued?.state).toBe("queued");
    if (queued?.state === "queued") expect(queued.logs).toEqual(["[10:00:01] 任务B的行"]);

    // id1 结算后 id2 自动启动；tok-a 的迟到行被丢弃
    queue.finish(doneResult);
    const before = snapshots.length;
    queue.appendLog("tok-a", "[10:00:02] 迟到行");
    expect(snapshots.length).toBe(before);

    // id2 运行中收自己的行；结算后不再收
    queue.appendLog("tok-b", "[10:00:03] 任务B的第二行");
    const second = snapshots.filter((s) => s.jobId === id2).at(-1);
    expect(second?.state).toBe("running");
    if (second?.state === "running") expect(second.logs).toEqual(["[10:00:01] 任务B的行", "[10:00:03] 任务B的第二行"]);
    queue.cancelled(id2);
    const settled = snapshots.length;
    queue.appendLog("tok-b", "[10:00:04] 结算后行");
    expect(snapshots.length).toBe(settled);
    const terminal = snapshots.filter((s) => s.jobId === id2).at(-1);
    expect(terminal?.state).toBe("cancelled");
    if (terminal?.state === "cancelled") expect(terminal.logs).toEqual(["[10:00:01] 任务B的行", "[10:00:03] 任务B的第二行"]);
  });
});
