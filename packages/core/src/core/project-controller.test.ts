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
