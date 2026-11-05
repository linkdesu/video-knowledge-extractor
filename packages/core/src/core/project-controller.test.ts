import { describe, expect, test } from "bun:test";
import {
  ClipProject,
  type AnalysisJob,
  type ProjectExecutor,
  type SliceJob,
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

function project(executor: ProjectExecutor, options: { autoSlice?: boolean; transcript?: SubtitleLine[] } = {}): ClipProject {
  return new ClipProject({
    executor,
    autoSlice: options.autoSlice ?? true,
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
