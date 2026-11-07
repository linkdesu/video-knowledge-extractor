import { describe, expect, test } from "bun:test";
import {
  ClipProject,
  GROWTH_IDLE_SECONDS,
  type AnalysisJob,
  type ProjectExecutor,
  type SliceJob,
  slicedSecondsFrom,
  topicKey,
  type SubtitleLine,
} from "./project-controller";

type Manual = {
  executor: ProjectExecutor;
  runningAnalysis(): AnalysisJob[];
  runningSlice(): SliceJob[];
};

function manualExecutor(): Manual {
  const analyses: AnalysisJob[] = [];
  const slices: SliceJob[] = [];
  return {
    executor: {
      analyze(job) {
        analyses.push(job);
      },
      slice(job) {
        slices.push(job);
      },
    },
    runningAnalysis: () => analyses,
    runningSlice: () => slices,
  };
}

function project(
  executor: ProjectExecutor,
  options: { autoSlice?: boolean; transcript?: SubtitleLine[]; semanticChunking?: boolean } = {},
): ClipProject {
  return new ClipProject({
    executor,
    autoSlice: options.autoSlice ?? true,
    ...(options.semanticChunking !== undefined ? { semanticChunking: options.semanticChunking } : {}),
    transcriptOf: () => options.transcript ?? [],
  });
}

describe("整理分块入队", () => {
  test("增长中的文件凑满一块才入分析队列", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue).toHaveLength(0);

    p.reportGrowth("f1", 599);
    p.tick(1);
    expect(p.analysisQueue).toHaveLength(0);

    p.reportGrowth("f1", 600);
    p.tick(1);
    expect(p.analysisQueue).toHaveLength(1);
    expect(p.analysisQueue[0]).toMatchObject({ fileId: "f1", start: 0, end: 600 });
  });

  test("停止增长恰好 30 秒不补尾段，严格超过才补", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.setGrowing("f1", false);

    p.tick(30);
    expect(p.analysisQueue).toHaveLength(0);

    p.tick(1);
    expect(p.analysisQueue).toHaveLength(1);
    expect(p.analysisQueue[0]).toMatchObject({ start: 0, end: 420 });
  });

  test("重新增长后尾段不会再补一次", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.setGrowing("f1", false);
    p.tick(31);
    expect(p.analysisQueue).toHaveLength(1);

    p.setGrowing("f1", true);
    p.reportGrowth("f1", 900);
    p.tick(1);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([[0, 420]]);
  });

  test("未加入整理的文件不产生分块", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 1200, growing: false, modifiedSeconds: 0 });
    p.tick(60);
    expect(p.analysisQueue).toHaveLength(0);
    // 即使文件继续增长，未加入整理也保持「未整理」
    p.reportGrowth("f1", 1800);
    p.tick(60);
    expect(p.statusOf("f1")).toBe("unorganized");
    expect(p.analysisQueue).toHaveLength(0);
  });

  test("修改分块时长只影响以后产生的分块", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 900, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.reportGrowth("f1", 600);
    p.tick(1);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([[0, 600]]);

    p.setChunkMinutes(5);
    p.reportGrowth("f1", 900);
    p.tick(1);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 900],
    ]);
  });

  test("分块时长夹到 1–30 分钟", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    expect(p.chunkMinutes).toBe(10);
    p.setChunkMinutes(0);
    expect(p.chunkMinutes).toBe(1);
    p.setChunkMinutes(31);
    expect(p.chunkMinutes).toBe(30);
  });
});

describe("两条串行队列", () => {
  test("分析队列同时最多一个 running，完成后再取下一个", () => {
    const m = manualExecutor();
    const p = project(m.executor);
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 1800, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue).toHaveLength(3);
    expect(m.runningAnalysis().map((j) => j.id)).toEqual([1]);

    p.completeAnalysis(1, []);
    expect(m.runningAnalysis().map((j) => j.id)).toEqual([1, 2]);
    expect(p.analysisQueue.filter((j) => j.status === "running")).toHaveLength(1);
  });

  test("两条队列可以同时各跑一个", () => {
    const m = manualExecutor();
    const lines: SubtitleLine[] = [
      { id: "l1", start: 0, end: 10, speaker: "主播", text: "一" },
      { id: "l2", start: 10, end: 20, speaker: "主播", text: "二" },
    ];
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 1200, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] }]);
    p.confirmTopic("1:t1", ["l1"]);

    expect(m.runningAnalysis().map((j) => j.id)).toEqual([1, 2]);
    expect(m.runningSlice()).toHaveLength(1);
    expect(p.analysisQueue.filter((j) => j.status === "running").map((j) => j.id)).toEqual([2]);
    expect(p.sliceQueue.filter((j) => j.status === "running")).toHaveLength(1);
  });

  test("一个项目的队列不影响另一个项目", () => {
    const a = manualExecutor();
    const b = manualExecutor();
    const pa = project(a.executor);
    const pb = project(b.executor);
    pa.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    pb.addFile({ id: "f1", name: "b.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    pa.startOrganize(["f1"]);

    expect(pa.analysisQueue).toHaveLength(1);
    expect(pb.analysisQueue).toHaveLength(0);
    expect(b.runningAnalysis()).toHaveLength(0);
  });
});

describe("三种整理状态", () => {
  const lines: SubtitleLine[] = [
    { id: "l1", start: 0, end: 10, speaker: "主播", text: "一" },
    { id: "l2", start: 10, end: 20, speaker: "主播", text: "二" },
  ];

  function finishedProject() {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] }]);
    p.completeSlice(1);
    return p;
  }

  test("未加入为未整理；加入后为持续整理中", () => {
    const m = manualExecutor();
    const p = project(m.executor);
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    expect(p.statusOf("f1")).toBe("unorganized");
    p.startOrganize(["f1"]);
    expect(p.statusOf("f1")).toBe("organizing");
  });

  test("最后增长恰好 30 秒仍未结束，严格超过且全部切片完成才结束", () => {
    const p = finishedProject();
    p.tick(30);
    expect(p.statusOf("f1")).toBe("organizing");
    p.tick(1);
    expect(p.statusOf("f1")).toBe("finished");
  });

  test("待确认主题让视频保持持续整理中", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] }]);
    p.tick(31);
    expect(p.statusOf("f1")).toBe("organizing");
  });

  test("停止增长后又恢复增长，回到持续整理中", () => {
    const p = finishedProject();
    p.tick(31);
    expect(p.statusOf("f1")).toBe("finished");
    p.setGrowing("f1", true);
    expect(p.statusOf("f1")).toBe("organizing");
  });
});

describe("自动切片开关", () => {
  const lines: SubtitleLine[] = [
    { id: "l1", start: 0, end: 10, speaker: "主播", text: "一" },
    { id: "l2", start: 10, end: 20, speaker: "主播", text: "二" },
  ];
  const twoTopics = [
    { id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] },
    { id: "t2", title: "主题二", category: "分类", lineIds: ["l2"] },
  ];

  test("默认开启：分析完成后全部主题自动入切片队列", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    expect(p.autoSlice).toBe(true);
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, twoTopics);
    expect(p.proposedTopics()).toHaveLength(0);
    expect(p.sliceQueue).toHaveLength(2);
    expect(m.runningSlice()).toHaveLength(1);
    expect(p.sliceQueue.filter((j) => j.status === "running")).toHaveLength(1);
  });

  test("关闭时主题停在待确认，已入队任务继续", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, twoTopics);
    expect(p.sliceQueue).toHaveLength(0);
    expect(p.proposedTopics()).toHaveLength(2);

    p.confirmTopic(topicKey(1, "t1"), ["l1"]);
    expect(p.sliceQueue).toHaveLength(1);
    const before = p.sliceQueue.map((j) => [j.id, j.status]);
    p.setAutoSlice(false);
    expect(p.sliceQueue.map((j) => [j.id, j.status])).toEqual(before);
    expect(p.proposedTopics().map((t) => t.id)).toEqual(["t2"]);
  });

  test("再打开时既有待确认全部入队，且不重复", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, twoTopics);
    p.confirmTopic(topicKey(1, "t1"), ["l1"]);

    p.setAutoSlice(true);
    expect(p.proposedTopics()).toHaveLength(0);
    expect(p.sliceQueue.map((j) => j.topicKey)).toEqual([topicKey(1, "t1"), topicKey(1, "t2")]);
    p.setAutoSlice(true);
    expect(p.sliceQueue).toHaveLength(2);
  });
});

describe("单主题确认", () => {
  const lines: SubtitleLine[] = Array.from({ length: 6 }, (_, i) => ({
    id: `l${i + 1}`,
    start: i * 15,
    end: (i + 1) * 15,
    speaker: "主播",
    text: `第 ${i + 1} 行`,
  }));

  function pendingProject() {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l2", "l3", "l4"] }]);
    return { m, p };
  }

  test("删 1 行补 1 行：行 id、片段、累计时长精确", () => {
    const { p } = pendingProject();
    expect(p.confirmTopic(topicKey(1, "t1"), ["l1", "l2", "l4"])).toBe(true);

    const job = p.sliceQueue[0]!;
    expect(job.lines.map((l) => l.id)).toEqual(["l1", "l2", "l4"]);
    expect(job.segments).toEqual([
      { start: 0, end: 30 },
      { start: 45, end: 60 },
    ]);
    expect(job.durationSeconds).toBe(45);
    expect(p.proposedTopics()).toHaveLength(0);
  });

  test("空选拒绝，不改变主题与队列", () => {
    const { p } = pendingProject();
    expect(p.confirmTopic(topicKey(1, "t1"), [])).toBe(false);
    expect(p.proposedTopics().map((t) => t.id)).toEqual(["t1"]);
    expect(p.sliceQueue).toHaveLength(0);
  });

  test("同一个主题不会重复入队", () => {
    const { p } = pendingProject();
    expect(p.confirmTopic(topicKey(1, "t1"), ["l2"])).toBe(true);
    expect(p.confirmTopic(topicKey(1, "t1"), ["l3"])).toBe(false);
    expect(p.sliceQueue).toHaveLength(1);
    expect(p.sliceQueue[0]!.lines.map((l) => l.id)).toEqual(["l2"]);
  });

  test("稍后确认前再次读取待确认区没有副作用", () => {
    const { p } = pendingProject();
    const before = p.proposedTopics().map((t) => [t.id, [...t.lineIds], t.status]);
    expect(p.proposedTopics()).toHaveLength(1);
    expect(p.proposedTopics().map((t) => [t.id, [...t.lineIds], t.status])).toEqual(before);
    expect(p.sliceQueue).toHaveLength(0);
  });

  test("确认弹窗读完整字幕：不是 AI 建议的三行摘要，且是副本", () => {
    const { p } = pendingProject();
    const all = p.linesOf(topicKey(1, "t1"));
    expect(all.map((line) => line.id)).toEqual(["l1", "l2", "l3", "l4", "l5", "l6"]);
    expect(all[1]).toMatchObject({ speaker: "主播", text: "第 2 行" });
    all.pop();
    expect(p.linesOf(topicKey(1, "t1"))).toHaveLength(6);
  });

  test("未知主题读不到字幕，不抛异常", () => {
    const { p } = pendingProject();
    expect(p.linesOf(topicKey(9, "t1"))).toEqual([]);
    expect(p.linesOf("bad")).toEqual([]);
  });

  test("确认后再补入新增长的字幕行会进入切片", () => {
    const { p } = pendingProject();
    p.confirmTopic(topicKey(1, "t1"), ["l2"]);
    p.completeSlice(1);
    expect(p.clips[0]!.lines.map((l) => l.id)).toEqual(["l2"]);
    expect(p.clips[0]!.durationSeconds).toBe(15);
  });
});

describe("未切片内容时长", () => {
  const lines: SubtitleLine[] = [
    { id: "l1", start: 0, end: 10, speaker: "主播", text: "一" },
    { id: "l2", start: 10, end: 20, speaker: "主播", text: "二" },
  ];

  test("只扣从开头起连续、全部主题都已切片的分块", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 1800, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    expect(p.unslicedSeconds("f1")).toBe(1800);

    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "分类", lineIds: ["l1"] }]);
    expect(p.unslicedSeconds("f1")).toBe(1800);
    p.completeSlice(1);
    expect(p.unslicedSeconds("f1")).toBe(1200);

    p.completeAnalysis(2, [{ id: "t2", title: "主题二", category: "分类", lineIds: ["l2"] }]);
    p.completeSlice(2);
    expect(p.unslicedSeconds("f1")).toBe(600);

    p.completeAnalysis(3, [{ id: "t3", title: "主题三", category: "分类", lineIds: ["l1"] }]);
    p.completeSlice(3);
    expect(p.unslicedSeconds("f1")).toBe(0);
  });
});

describe("README 三个场景", () => {
  const lines: SubtitleLine[] = Array.from({ length: 120 }, (_, i) => ({
    id: `l${i}`,
    start: i * 15,
    end: (i + 1) * 15,
    speaker: "主播",
    text: `第 ${i} 行`,
  }));

  function twoTopics() {
    return [
      { id: "a", title: "主题 A", category: "分类", lineIds: ["l1"] },
      { id: "b", title: "主题 B", category: "分类", lineIds: ["l2"] },
    ];
  }

  function grow(p: ClipProject, fileId: string, seconds: number) {
    const file = p.files.get(fileId)!;
    let duration = file.durationSeconds;
    for (let elapsed = 0; elapsed < seconds; elapsed += 15) {
      duration += 15;
      p.reportGrowth(fileId, duration);
      p.tick(15);
    }
  }

  function drain(p: ClipProject) {
    for (let guard = 0; guard < 100; guard += 1) {
      const analysis = p.analysisQueue.find((j) => j.status === "running");
      const slice = p.sliceQueue.find((j) => j.status === "running");
      if (!analysis && !slice) return;
      if (analysis) p.completeAnalysis(analysis.id, twoTopics());
      else if (slice) p.completeSlice(slice.id);
    }
    throw new Error("队列没有排空");
  }

  test("持续录制：从 7 分钟开始，推进两段后产出 4 条", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "f1", name: "直播_晚场.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    grow(p, "f1", 180);
    grow(p, "f1", 600);
    drain(p);

    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 1200],
    ]);
    expect(p.clips).toHaveLength(4);
    expect(p.sliceQueue.filter((j) => j.status !== "done")).toHaveLength(0);
  });

  test("多个视频：完整录像处理到末尾，与增长录像共产出 8 条", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "full", name: "创作复盘_完整版.mp4", durationSeconds: 1080, growing: false, modifiedSeconds: 0 });
    p.addFile({ id: "live", name: "直播_晚场.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["full", "live"]);

    grow(p, "live", 600);
    grow(p, "live", 600);
    drain(p);

    expect(p.analysisQueue.filter((j) => j.fileId === "full").map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 1080],
    ]);
    expect(p.clips).toHaveLength(8);
    expect(p.statusOf("full")).toBe("finished");
    expect(p.unslicedSeconds("full")).toBe(0);
  });

  test("尾段恰好 30 秒无任务，超过后补 2 条且整理已结束", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "f1", name: "直播_晚场.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.setGrowing("f1", false);

    p.tick(30);
    expect(p.analysisQueue).toHaveLength(0);
    expect(p.clips).toHaveLength(0);

    p.tick(1);
    drain(p);
    expect(p.analysisQueue).toHaveLength(1);
    expect(p.clips).toHaveLength(2);
    expect(p.statusOf("f1")).toBe("finished");
    expect(p.unslicedSeconds("f1")).toBe(0);
  });
});

describe("执行器接线契约（#126）", () => {
  const lines: SubtitleLine[] = [
    { id: "l1", start: 0, end: 10, speaker: "主播", text: "一" },
    { id: "l2", start: 10, end: 20, speaker: "主播", text: "二" },
  ];

  test("主题 id 含冒号时仍能定位：topicKey 只按第一个冒号拆分", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "topic:1", title: "主题一", category: "", lineIds: ["l1"] }]);

    const key = topicKey(1, "topic:1");
    expect(p.proposedTopics().map((t) => t.id)).toEqual(["topic:1"]);
    expect(p.confirmTopic(key, ["l1"])).toBe(true);
    expect(p.sliceQueue[0]?.topicKey).toBe(key);
    expect(p.confirmTopic(topicKey(1, "topic:1:x"), ["l2"])).toBe(false);
  });

  test("切片开始时主题进入 generating，完成后才是 done", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "", lineIds: ["l1"] }]);

    const job = m.runningSlice()[0];
    expect(job).toBeDefined();
    expect(p.analysisQueue[0]?.topics[0]?.status).toBe("generating");

    p.completeSlice(job!.id);
    expect(p.analysisQueue[0]?.topics[0]?.status).toBe("done");
  });

  test("切片失败：任务标 failed、主题标 failed，不产出切片", () => {
    const m = manualExecutor();
    const p = project(m.executor, { transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "主题一", category: "", lineIds: ["l1"] }]);

    const job = m.runningSlice()[0]!;
    expect(p.failSlice(job.id, "ffmpeg 退出码 1")).toBe(true);
    expect(p.sliceQueue[0]?.status).toBe("failed");
    expect(p.analysisQueue[0]?.topics[0]?.status).toBe("failed");
    expect(p.clips).toHaveLength(0);
    expect(p.failSlice(job.id, "重复结算")).toBe(false);
  });

  test("分析失败：任务标 failed，不会自动补尾段重跑同一区间", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: lines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);

    expect(p.failAnalysis(1, "ASR 失败")).toBe(true);
    expect(p.analysisQueue[0]?.status).toBe("failed");
    expect(p.failAnalysis(1, "重复结算")).toBe(false);
    // 失败的分块不进入「已处理」，视频保持持续整理中
    expect(p.unslicedSeconds("f1")).toBe(600);
    expect(p.statusOf("f1")).toBe("organizing");
  });
});

describe("分析阶段推进", () => {
  const stageLines: SubtitleLine[] = [
    { id: "l1", start: 0, end: 10, speaker: "主播", text: "一" },
    { id: "l2", start: 10, end: 20, speaker: "主播", text: "二" },
  ];

  function runningProject() {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, transcript: stageLines });
    p.addFile({ id: "f1", name: "a.mp4", durationSeconds: 600, growing: false, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    return { m, p };
  }

  test("运行中的任务推进到第二阶段：只前进、不回退、不重复生效", () => {
    const { p } = runningProject();
    expect(p.analysisQueue[0]).toMatchObject({ status: "running", stage: 0 });

    expect(p.advanceAnalysisStage(1, 1)).toBe(true);
    expect(p.analysisQueue[0]?.stage).toBe(1);
    expect(p.advanceAnalysisStage(1, 1)).toBe(false);
    expect(p.advanceAnalysisStage(1, 0)).toBe(false);
    expect(p.analysisQueue[0]?.stage).toBe(1);
  });

  test("未知任务与终态任务不接受推进", () => {
    const { p } = runningProject();
    expect(p.advanceAnalysisStage(9, 1)).toBe(false);
    expect(p.completeAnalysis(1, [])).toBeUndefined();
    expect(p.analysisQueue[0]?.status).toBe("done");
    expect(p.advanceAnalysisStage(1, 1)).toBe(false);
  });
});

describe("重启恢复已处理进度（#142 QA）", () => {
  /** 只取恢复口径要用的字段；其余文档字段与本函数无关。 */
  function doc(
    chunks: Array<{ start: number; end: number }>,
    topics: Array<{ id: string; status: string; segments: Array<{ start: number; end: number }> }>,
  ) {
    return {
      chunks: chunks.map((chunk, index) => ({ index: index + 1, ...chunk })),
      topics,
    } as unknown as Parameters<typeof slicedSecondsFrom>[0];
  }

  test("只累计从 0 连续、且块内主题已落盘切片的块", () => {
    const data = doc(
      [
        { start: 0, end: 30 },
        { start: 30, end: 60 },
        { start: 60, end: 90 },
      ],
      [
        { id: "t0-1", status: "done", segments: [{ start: 0, end: 29 }] },
        { id: "t30-1", status: "proposed", segments: [{ start: 30, end: 59 }] },
        { id: "t60-1", status: "done", segments: [{ start: 60, end: 89 }] },
      ],
    );
    expect(slicedSecondsFrom(data, new Set(["t0-1", "t60-1"]))).toBe(30);
  });

  test("主题 done 但没有项目切片记录时不计入（避免把只生成过笔记的主题算成已处理）", () => {
    const data = doc(
      [{ start: 0, end: 30 }],
      [{ id: "t0-1", status: "done", segments: [{ start: 0, end: 29 }] }],
    );
    expect(slicedSecondsFrom(data, new Set())).toBe(0);
  });

  test("分块不连续时停在前一块末尾", () => {
    const data = doc(
      [
        { start: 0, end: 30 },
        { start: 40, end: 70 },
      ],
      [
        { id: "t0-1", status: "done", segments: [{ start: 0, end: 29 }] },
        { id: "t40-1", status: "done", segments: [{ start: 40, end: 69 }] },
      ],
    );
    expect(slicedSecondsFrom(data, new Set(["t0-1", "t40-1"]))).toBe(30);
  });
});

describe("增长监控（#132）", () => {
  test("30 秒阈值写死，不可配置", () => {
    expect(GROWTH_IDLE_SECONDS).toBe(30);
  });

  test("读不出时长视为还在增长：不入队，也不判定整理结束", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "录制中.mp4", durationSeconds: null, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);

    p.tick(120);
    expect(p.analysisQueue).toHaveLength(0);
    expect(p.statusOf("f1")).toBe("organizing");
    expect(p.files.get("f1")).toMatchObject({ durationSeconds: 0, durationKnown: false, growing: true });
  });

  test("读不出时长的文件后来能读出：按完整块入队", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "录制中.mp4", durationSeconds: null, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.tick(10);
    expect(p.analysisQueue).toHaveLength(0);

    p.reportGrowth("f1", 600);
    p.tick(1);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 600]]);
    expect(p.files.get("f1")).toMatchObject({ durationSeconds: 600, durationKnown: true });
  });

  test("大小 / 修改时间变了但时长没变也算一次增长：推迟尾段", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 900, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 600]]);

    p.tick(20);
    // 文件系统报告了变化，但 ffprobe 读到的时长与上次相同
    p.reportGrowth("f1", 900);
    p.tick(11);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 600]]);

    p.tick(20);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [0, 600],
      [600, 900],
    ]);
  });

  test("重复登记同一文件只更新元数据，不重置队列进度与已加入状态", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 420, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.tick(31);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 420]]);
    expect(p.files.get("f1")?.cursorSeconds).toBe(420);

    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 420, growing: false, modifiedSeconds: -31 });
    expect(p.files.get("f1")).toMatchObject({ added: true, cursorSeconds: 420, durationSeconds: 420 });
    expect(p.analysisQueue).toHaveLength(1);
  });

  test("增长中的文件再次打开确认弹窗能看到新增字幕", () => {
    const lines: SubtitleLine[] = [{ id: "l1", start: 0, end: 5, speaker: "主播", text: "开场" }];
    const p = new ClipProject({
      executor: manualExecutor().executor,
      autoSlice: false,
      chunkMinutes: 1,
      transcriptOf: () => lines.map((line) => ({ ...line })),
    });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 60, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.completeAnalysis(1, [{ id: "t1", title: "开场", category: "直播", lineIds: ["l1"] }]);
    expect(p.linesOf(topicKey(1, "t1")).map((line) => line.id)).toEqual(["l1"]);

    // 文件继续增长：来源字幕多了一行，重开弹窗按当前字幕读取
    lines.push({ id: "l2", start: 60, end: 65, speaker: "主播", text: "新增内容" });
    expect(p.linesOf(topicKey(1, "t1")).map((line) => line.id)).toEqual(["l1", "l2"]);
  });
});

describe("开始整理早于监控登记（#132 D3）", () => {
  test("未知文件的加入请求在元数据到达后生效并正常入队", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.setChunkMinutes(1);

    // 开始监控后首轮轮询（≤2 秒）之前点了「开始整理」：控制器里还没有这个文件
    p.startOrganize(["f1"]);
    expect(p.analysisQueue).toHaveLength(0);
    expect(p.files.has("f1")).toBe(false);

    // 首次轮询登记：0 字节读不出时长，先按还在增长处理
    p.addFile({ id: "f1", name: "弹窗增长.ts", durationSeconds: null, growing: true, modifiedSeconds: 0 });
    expect(p.files.get("f1")?.added).toBe(true);
    expect(p.statusOf("f1")).toBe("organizing");
    expect(p.analysisQueue).toHaveLength(0);

    // 追加到 80 秒：凑满一块立即入队，不需要任何人工操作
    p.reportGrowth("f1", 80);
    p.tick(1);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([[0, 60]]);
  });

  test("加入请求不会把之后才登记的文件漏掉，重复登记也不重复计入", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.setChunkMinutes(1);
    p.startOrganize(["f1"]);
    p.startOrganize(["f1"]);

    p.addFile({ id: "f1", name: "a.ts", durationSeconds: 120, growing: false, modifiedSeconds: 0 });
    p.tick(1);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [0, 60],
      [60, 120],
    ]);
  });
});

describe("重启恢复已加入状态与分块终点（#132 D2）", () => {
  test("恢复后只排新增长的部分，已分块的区间不再重排", () => {
    const { executor } = manualExecutor();
    const p = project(executor, { semanticChunking: false });
    p.setChunkMinutes(1);
    p.addFile({ id: "f1", name: "直播.ts", durationSeconds: 190, growing: false, modifiedSeconds: -31 });
    p.restoreCursor("f1", 120);
    expect(p.files.get("f1")?.cursorSeconds).toBe(120);
    p.startOrganize(["f1"]);
    p.tick(1);

    // 只排恢复点之后的：已分块的 0–120 不再重排，剩下的整块与尾段照常入队
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [120, 180],
      [180, 190],
    ]);
  });

  test("重启后新分块完成：已处理从恢复点继续推进，不被队列缺口清零", () => {
    const { executor } = manualExecutor();
    const p = project(executor, { semanticChunking: false });
    p.setChunkMinutes(1);
    p.addFile({ id: "f1", name: "直播.ts", durationSeconds: 190, growing: false, modifiedSeconds: -31 });
    // 重启：磁盘上 0–120 已处理，队列从 120 继续
    p.restoreProcessed("f1", 120);
    p.restoreCursor("f1", 120);
    p.startOrganize(["f1"]);
    p.tick(1);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [120, 180],
      [180, 190],
    ]);

    p.completeAnalysis(p.analysisQueue[0]!.id, []);
    // 队列里没有 0–120 的分块，但那一段已经恢复过：已处理要走到 180，不是掉回 0
    expect(p.files.get("f1")?.processedSeconds).toBe(180);
    expect(p.unslicedSeconds("f1")).toBe(10);
  });

  test("分块记录比库里的时长长：按磁盘证据抬升时长，不把进度压回去", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.setChunkMinutes(1);
    // 视频库里的时长停在导入那一刻（80 秒），磁盘上已经分析到 400 秒
    p.addFile({ id: "f1", name: "直播.ts", durationSeconds: 190, growing: false, modifiedSeconds: -31 });
    p.restoreCursor("f1", 400);
    p.restoreProcessed("f1", 400);
    expect(p.files.get("f1")).toMatchObject({ durationSeconds: 400, cursorSeconds: 400, processedSeconds: 400 });
    expect(p.unslicedSeconds("f1")).toBe(0);
    p.startOrganize(["f1"]);
    p.tick(1);
    // 没有新内容要排；整理状态也不会被旧时长误判成「未处理完」
    expect(p.analysisQueue).toHaveLength(0);
    expect(p.statusOf("f1")).toBe("finished");
  });
});

describe("短尾巴跳过后的终态（#132 QA B2）", () => {
  test("尾巴分块按完成结算（0 主题）：已处理推到文件末尾，未切片 0、整理已结束", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.setChunkMinutes(1);
    // 真机形态：增长到 120.138 秒停止，最后 0.138 秒解不出稳定采样，分析管线跳过并返回 0 主题
    p.addFile({ id: "f1", name: "直播.ts", durationSeconds: 120.138, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    p.tick(1);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [0, 60],
      [60, 120],
    ]);

    p.completeAnalysis(p.analysisQueue[0]!.id, []);
    p.completeAnalysis(p.analysisQueue[1]!.id, []);
    p.setGrowing("f1", false);
    p.tick(31);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [0, 60],
      [60, 120],
      [120, 120.138],
    ]);

    p.completeAnalysis(p.analysisQueue[2]!.id, []);
    expect(p.analysisQueue[2]!.status).toBe("done");
    expect(p.unslicedSeconds("f1")).toBe(0);
    expect(p.statusOf("f1")).toBe("finished");
  });
});

describe("失败任务重试（#154）", () => {
  test("分析失败任务原地回 waiting：清 error、stage 归 0、位置不变、不新增任务", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, semanticChunking: false });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 180, growing: false, modifiedSeconds: -31 });
    p.setChunkMinutes(1);
    p.startOrganize(["f1"]);
    p.tick(31);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 60],
      [60, 120],
      [120, 180],
    ]);
    // 任务 1 在飞、2/3 排队
    const first = p.analysisQueue[0]!;
    expect(first.status).toBe("running");
    p.failAnalysis(first.id, "LLM 请求失败 401");
    expect(p.analysisQueue[1]!.status).toBe("running");
    expect(p.analysisQueue[0]).toMatchObject({ status: "failed", error: "LLM 请求失败 401", stage: 0 });
    p.completeAnalysis(p.analysisQueue[1]!.id, []);
    expect(p.analysisQueue[2]!.status).toBe("running");

    expect(p.retryAnalysis(first.id)).toBe(true);
    expect(p.analysisQueue).toHaveLength(3);
    expect(p.analysisQueue[0]).toMatchObject({ status: "waiting", stage: 0 });
    expect(p.analysisQueue[0]!.error).toBeUndefined();
    // 队列顺序不变：重试的任务还在最前
    expect(p.analysisQueue.map((j) => j.start)).toEqual([0, 60, 120]);
    // 任务 3 在飞时不抢占：任务 3 完成后下一个跑的是重试的任务 1
    const analyzedBefore = m.runningAnalysis().length;
    p.completeAnalysis(p.analysisQueue[2]!.id, []);
    expect(m.runningAnalysis()).toHaveLength(analyzedBefore + 1);
    expect(m.runningAnalysis()[analyzedBefore]!.id).toBe(first.id);
  });

  test("非 failed 的分析任务重试被拒：waiting/running/done 与未知 id 都是 false", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, semanticChunking: false });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 120, growing: false, modifiedSeconds: -31 });
    p.setChunkMinutes(1);
    p.startOrganize(["f1"]);
    p.tick(31);
    expect(p.retryAnalysis(p.analysisQueue[0]!.id)).toBe(false); // running
    expect(p.retryAnalysis(p.analysisQueue[1]!.id)).toBe(false); // waiting
    p.completeAnalysis(p.analysisQueue[0]!.id, []);
    expect(p.retryAnalysis(p.analysisQueue[0]!.id)).toBe(false); // done
    expect(p.retryAnalysis(999)).toBe(false);
  });

  test("切片重试：任务回 waiting、主题从 failed 回 queued，pump 把它推到 generating", () => {
    const m = manualExecutor();
    const p = project(m.executor, {
      autoSlice: false,
      transcript: [
        { id: "l1", start: 0, end: 4, text: "开场" },
        { id: "l2", start: 4, end: 9, text: "方法" },
      ],
    });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 120, growing: false, modifiedSeconds: -31 });
    p.setChunkMinutes(2);
    p.startOrganize(["f1"]);
    p.tick(31);
    const jobId = p.analysisQueue[0]!.id;
    p.completeAnalysis(jobId, [{ id: "t1", title: "主题一", category: "", lineIds: ["l1"] }]);
    expect(p.confirmTopic(topicKey(jobId, "t1"), ["l1"])).toBe(true);
    const sliceId = p.sliceQueue[0]!.id;
    expect(p.sliceQueue[0]!.status).toBe("running");
    p.failSlice(sliceId, "ffmpeg exit 234");
    expect(p.sliceQueue[0]).toMatchObject({ status: "failed", error: "ffmpeg exit 234" });
    expect(p.analysisQueue[0]!.topics[0]).toMatchObject({ status: "failed" });

    expect(p.retrySlice(sliceId)).toBe(true);
    expect(p.sliceQueue).toHaveLength(1);
    expect(p.sliceQueue[0]!.error).toBeUndefined();
    // 切片槽空着：retrySlice 末尾的 pump 直接把任务推到 running、主题 queued → generating
    expect(p.sliceQueue[0]!.status).toBe("running");
    expect(p.analysisQueue[0]!.topics[0]!.status).toBe("generating");
  });

  test("非 failed 的切片任务重试被拒", () => {
    const m = manualExecutor();
    const p = project(m.executor, {
      autoSlice: false,
      transcript: [{ id: "l1", start: 0, end: 4, text: "开场" }],
    });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 120, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    p.setChunkMinutes(2);
    p.tick(31);
    const jobId = p.analysisQueue[0]!.id;
    p.completeAnalysis(jobId, [{ id: "t1", title: "主题一", category: "", lineIds: ["l1"] }]);
    p.confirmTopic(topicKey(jobId, "t1"), ["l1"]);
    expect(p.retrySlice(p.sliceQueue[0]!.id)).toBe(false); // running
    p.completeSlice(p.sliceQueue[0]!.id);
    expect(p.retrySlice(p.sliceQueue[0]!.id)).toBe(false); // done
    expect(p.retrySlice(999)).toBe(false);
  });
});

describe("dispose：项目删除后控制器彻底停摆（#154）", () => {
  test("dispose 后终态与重试方法全部返回 false 且不改状态；重复 dispose 无害", () => {
    const m = manualExecutor();
    const p = project(m.executor, { autoSlice: false, semanticChunking: false });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 120, growing: false, modifiedSeconds: -31 });
    p.setChunkMinutes(1);
    p.startOrganize(["f1"]);
    p.tick(31);
    const running = p.analysisQueue[0]!;
    const waiting = p.analysisQueue[1]!;

    p.dispose();
    p.dispose();
    expect(p.failAnalysis(running.id, "boom")).toBe(false);
    p.completeAnalysis(running.id, []);
    expect(p.retryAnalysis(running.id)).toBe(false);
    p.failAnalysis(running.id, "boom");
    expect(p.retryAnalysis(waiting.id)).toBe(false);
    expect(p.failSlice(1, "boom")).toBe(false);
    expect(p.retrySlice(1)).toBe(false);
    expect(p.analysisQueue[0]!.status).toBe("running");
    expect(p.analysisQueue[0]!.error).toBeUndefined();
    expect(p.analysisQueue[1]).toMatchObject({ status: "waiting" });
    expect(p.clips).toHaveLength(0);
  });

  test("dispose 后 pump 不再启动新任务", () => {
    const m = manualExecutor();
    const p = project(m.executor, {
      autoSlice: false,
      transcript: [{ id: "l1", start: 0, end: 4, text: "开场" }],
    });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 120, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    p.setChunkMinutes(2);
    p.tick(31);
    const jobId = p.analysisQueue[0]!.id;
    // 分析槽空出来：没有 running、也没有 waiting 的分析任务
    p.completeAnalysis(jobId, [{ id: "t1", title: "主题一", category: "", lineIds: ["l1"] }]);
    expect(m.runningAnalysis()).toHaveLength(1);

    p.dispose();
    // 确认主题只入队；被 dispose 的 pump 不能把它推起来
    expect(p.confirmTopic(topicKey(jobId, "t1"), ["l1"])).toBe(true);
    expect(p.sliceQueue[0]!.status).toBe("waiting");
    expect(m.runningSlice()).toHaveLength(0);

    // 新增长入队的分析任务同样不启动
    p.addFile({ id: "f2", name: "晚场.mp4", durationSeconds: 60, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f2"]);
    p.settle();
    expect(p.analysisQueue.some((j) => j.fileId === "f2" && j.status === "waiting")).toBe(true);
    expect(m.runningAnalysis()).toHaveLength(1);
  });
});

describe("智能语义分块入队策略（#155）", () => {
  test("默认开启：停止增长的 40 分钟文件一次性整段入队", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 2400, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue).toHaveLength(1);
    expect(p.analysisQueue[0]).toMatchObject({ start: 0, end: 2400 });
    expect(p.files.get("f1")!.cursorSeconds).toBe(2400);
  });

  test("监控式登记的录制文件：增长期只入满块，停止增长后剩余尾段整段入队", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    // 监控发现的新文件：growing=true、增长时间=当前时钟（ProjectRuntime 的 fileInput 是另一套：growing=false / -31，立刻满足 idle）
    p.addFile({ id: "f1", name: "录制.ts", durationSeconds: 2400, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);
    // 增长中的文件照旧「满一块入一块」：2400 秒 = 4 个满块，不等 30 秒
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1800],
      [1800, 2400],
    ]);

    // 继续增长：[2400,2900] 不足一块，非 idle 时不提前入队
    p.reportGrowth("f1", 2900);
    p.tick(1);
    expect(p.analysisQueue).toHaveLength(4);

    // 严格超过 30 秒才算停止增长：剩余尾段整段入队（不拆块），游标推到文件末尾
    p.tick(30);
    expect(p.analysisQueue.map((job) => [job.start, job.end])).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1800],
      [1800, 2400],
      [2400, 2900],
    ]);
    expect(p.files.get("f1")!.cursorSeconds).toBe(2900);
  });

  test("关闭开关：40 分钟文件仍按 chunkMinutes 拆块", () => {
    const { executor } = manualExecutor();
    const p = project(executor, { semanticChunking: false });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 2400, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1800],
      [1800, 2400],
    ]);
    expect(p.files.get("f1")!.cursorSeconds).toBe(2400);
  });

  test("开启但还在增长：只入满块，尾段不提前", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 1500, growing: true, modifiedSeconds: 0 });
    p.startOrganize(["f1"]);

    p.reportGrowth("f1", 1200);
    p.tick(1);
    // 增长期照旧「满一块入一块」：1200 秒里有两块
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 1200],
    ]);

    p.reportGrowth("f1", 1500);
    p.tick(30);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 1200],
    ]);

    // 严格超过 30 秒才算停止增长：剩余尾段整段入队
    p.tick(1);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1500],
    ]);
    expect(p.files.get("f1")!.cursorSeconds).toBe(1500);
  });

  test("开关持续开启：新增增长又停止后再次整段入队", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 1200, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([[0, 1200]]);

    p.reportGrowth("f1", 1500);
    p.tick(31);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 1200],
      [1200, 1500],
    ]);
    expect(p.files.get("f1")!.cursorSeconds).toBe(1500);
  });

  test("setSemanticChunking 落开关并重排：关闭后新增长按块，重新开启后尾段整段", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 1200, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    // 开启期已整段入队的任务不重排
    p.setSemanticChunking(false);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([[0, 1200]]);

    p.reportGrowth("f1", 1800);
    p.tick(31);
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 1200],
      [1200, 1800],
    ]);

    // 重新开启只影响以后产生的分块：新尾段整段入队
    p.setSemanticChunking(true);
    p.reportGrowth("f1", 2500);
    p.tick(31);
    // 增长期满块先入一块（与关闭开关一致），停止增长后剩余尾段整段入队
    expect(p.analysisQueue.map((j) => [j.start, j.end])).toEqual([
      [0, 1200],
      [1200, 1800],
      [1800, 2400],
      [2400, 2500],
    ]);
  });

  test("边界：剩余时长为 0 不整段入队", () => {
    const { executor } = manualExecutor();
    const p = project(executor);
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 600, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    expect(p.analysisQueue).toHaveLength(1);
    p.settle();
    p.tick(60);
    expect(p.analysisQueue).toHaveLength(1);
  });
});

describe("主题分析窗口进度（#155）", () => {
  function runningJobProject(): { p: ClipProject; jobId: number } {
    const { executor } = manualExecutor();
    const p = project(executor, { autoSlice: false });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 60, growing: false, modifiedSeconds: -31 });
    p.startOrganize(["f1"]);
    return { p, jobId: p.analysisQueue[0]!.id };
  }

  test("running 任务写入窗口进度；重复同值返回 false", () => {
    const { p, jobId } = runningJobProject();
    expect(p.advanceAnalysisProgress(jobId, 1, 4)).toBe(true);
    expect(p.analysisQueue[0]!.progress).toEqual({ done: 1, total: 4 });
    expect(p.advanceAnalysisProgress(jobId, 2, 4)).toBe(true);
    expect(p.advanceAnalysisProgress(jobId, 2, 4)).toBe(false);
  });

  test("非 running 任务与非法数值都不改状态", () => {
    const { executor } = manualExecutor();
    const p = project(executor, { autoSlice: false, semanticChunking: false });
    p.addFile({ id: "f1", name: "直播.mp4", durationSeconds: 180, growing: false, modifiedSeconds: -31 });
    p.setChunkMinutes(1);
    p.startOrganize(["f1"]);
    const [running, waiting] = p.analysisQueue;

    expect(p.advanceAnalysisProgress(waiting!.id, 1, 3)).toBe(false);
    expect(waiting!.progress).toBeUndefined();

    expect(p.advanceAnalysisProgress(running!.id, 0, 0)).toBe(false);
    expect(p.advanceAnalysisProgress(running!.id, 1, -2)).toBe(false);
    expect(p.advanceAnalysisProgress(running!.id, Number.NaN, 3)).toBe(false);
    expect(p.advanceAnalysisProgress(running!.id, 1.5, 3)).toBe(false);
    expect(p.advanceAnalysisProgress(running!.id, -1, 3)).toBe(false);
    expect(running!.progress).toBeUndefined();
    expect(p.advanceAnalysisProgress(999, 1, 2)).toBe(false);
  });

  test("完成 / 失败 / 重试都清掉进度", () => {
    const { p, jobId } = runningJobProject();
    p.advanceAnalysisProgress(jobId, 1, 2);
    p.failAnalysis(jobId, "boom");
    expect(p.analysisQueue[0]!.progress).toBeUndefined();

    p.retryAnalysis(jobId);
    p.advanceAnalysisProgress(jobId, 1, 2);
    p.completeAnalysis(jobId, []);
    expect(p.analysisQueue[0]!.progress).toBeUndefined();
  });
});
