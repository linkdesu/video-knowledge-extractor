import { describe, expect, test } from "bun:test";
import type {
  ProjectAnalysisTaskInfo,
  ProjectFileInfo,
  ProjectQueueState,
  ProjectSliceTaskInfo,
} from "../../../shared/ipc";
import {
  ANALYSIS_STAGES,
  analysisRangeLabel,
  analysisStages,
  analysisTopicProgress,
  pendingTopics,
  proposedTopicMeta,
  proposedTopicSource,
  queueCountLabel,
  queueFootline,
  sliceTaskMeta,
  taskStatusLabel,
} from "./project-queue";

function job(overrides: Partial<ProjectAnalysisTaskInfo> = {}): ProjectAnalysisTaskInfo {
  return {
    id: 1,
    fileId: "v1",
    name: "晚场.mp4",
    startSeconds: 0,
    endSeconds: 600,
    status: "waiting",
    stage: 0,
    ...overrides,
  };
}

function slice(overrides: Partial<ProjectSliceTaskInfo> = {}): ProjectSliceTaskInfo {
  return {
    id: 1,
    topicKey: "1:t1",
    fileId: "v1",
    title: "直播开场的 3 个留人方法",
    status: "waiting",
    lineCount: 3,
    segmentCount: 2,
    durationSeconds: 45,
    ...overrides,
  };
}

function file(overrides: Partial<ProjectFileInfo> = {}): ProjectFileInfo {
  return {
    id: "v1",
    name: "晚场.mp4",
    added: true,
    organizeStatus: "organizing",
    unslicedSeconds: 590,
    ...overrides,
  };
}

function queue(overrides: Partial<ProjectQueueState> = {}): ProjectQueueState {
  return { analysis: [], slices: [], proposed: [], files: [], ...overrides };
}

describe("队列计数与状态文案", () => {
  test("「分析 N · 切片 N」只数未完成任务", () => {
    const state = queue({
      analysis: [
        job({ id: 1, status: "done" }),
        job({ id: 2, status: "running" }),
        job({ id: 3, status: "waiting" }),
      ],
      slices: [slice({ id: 1, status: "done" }), slice({ id: 2, status: "running" })],
    });
    expect(queueCountLabel(state)).toBe("分析 2 · 切片 1");
  });

  test("没有任何未完成任务（含队列未接入）时显示「队列空闲」", () => {
    expect(
      queueCountLabel(
        queue({ analysis: [job({ id: 1, status: "done" })], slices: [slice({ status: "done" })] }),
      ),
    ).toBe("队列空闲");
    expect(queueCountLabel(queue())).toBe("队列空闲");
    expect(queueCountLabel(null)).toBe("队列空闲");
  });

  test("失败是终态，不再算待执行；只有失败任务时仍是「队列空闲」", () => {
    expect(
      queueCountLabel(
        queue({ analysis: [job({ status: "failed" })], slices: [slice({ status: "done" })] }),
      ),
    ).toBe("队列空闲");
    expect(
      queueCountLabel(
        queue({
          analysis: [job({ id: 1, status: "failed" }), job({ id: 2, status: "waiting" })],
          slices: [slice({ status: "running" }), slice({ id: 2, status: "failed" })],
        }),
      ),
    ).toBe("分析 1 · 切片 1");
  });

  test("三条任务状态文案；失败是真实终态，不伪装成等待中", () => {
    expect(taskStatusLabel("waiting")).toBe("等待中");
    expect(taskStatusLabel("running")).toBe("进行中");
    expect(taskStatusLabel("done")).toBe("已完成");
    expect(taskStatusLabel("failed")).toBe("失败");
  });

  test("每块两步：等待 / 进行中 / 已完成逐阶段推进", () => {
    expect(ANALYSIS_STAGES).toEqual(["字幕解析", "主题分析"]);
    expect(analysisStages(job({ status: "waiting", stage: 0 }))).toEqual([
      { name: "字幕解析", state: "waiting" },
      { name: "主题分析", state: "waiting" },
    ]);
    expect(analysisStages(job({ status: "running", stage: 0 }))).toEqual([
      { name: "字幕解析", state: "running" },
      { name: "主题分析", state: "waiting" },
    ]);
    expect(analysisStages(job({ status: "running", stage: 1 }))).toEqual([
      { name: "字幕解析", state: "done" },
      { name: "主题分析", state: "running" },
    ]);
    expect(analysisStages(job({ status: "done", stage: 1 }))).toEqual([
      { name: "字幕解析", state: "done" },
      { name: "主题分析", state: "done" },
    ]);
    expect(analysisStages(job({ status: "failed", stage: 0 }))).toEqual([
      { name: "字幕解析", state: "failed" },
      { name: "主题分析", state: "waiting" },
    ]);
  });

  test("主题分析窗口进度：只在跑且数字有效时显示", () => {
    expect(analysisTopicProgress(job({ status: "running", stage: 1, progress: { done: 3, total: 12 } }))).toBe("3/12");
    // 尚未开始、已完成、失败都不给数字
    expect(analysisTopicProgress(job({ status: "running", stage: 1 }))).toBeNull();
    expect(analysisTopicProgress(job({ status: "waiting", progress: { done: 0, total: 12 } }))).toBeNull();
    expect(analysisTopicProgress(job({ status: "done", stage: 1, progress: { done: 12, total: 12 } }))).toBeNull();
    expect(analysisTopicProgress(job({ status: "failed", progress: { done: 2, total: 12 } }))).toBeNull();
    // 非法值不编造进度
    expect(analysisTopicProgress(job({ status: "running", progress: { done: 0, total: 0 } }))).toBeNull();
    expect(analysisTopicProgress(job({ status: "running", progress: { done: 20, total: 12 } }))).toBe("12/12");
  });

  test("分析区间按源时间轴 HH:MM:SS", () => {
    expect(analysisRangeLabel(job({ startSeconds: 65, endSeconds: 725 }))).toBe(
      "00:01:05–00:12:05",
    );
  });

  test("确认弹窗副标题是「文件名 · 分析区间」，与待确认列表行不是同一段文案", () => {
    expect(
      proposedTopicSource(job({ id: 3, name: "晚场.mp4", startSeconds: 0, endSeconds: 600 })),
    ).toBe("晚场.mp4 · 分析区间 00:00:00–00:10:00");
  });
});

describe("待确认主题与切片任务", () => {
  test("待确认主题保持快照顺序平铺，行 id 原样保留", () => {
    const state = queue({
      analysis: [job({ id: 2, name: "复盘.mp4" })],
      proposed: [
        {
          topicKey: "2:t1",
          jobId: 2,
          fileId: "v1",
          title: "为什么你的选题没人看？",
          category: "内容创作",
          lineIds: ["line-1", "line-2"],
        },
      ],
    });
    expect(pendingTopics(state)).toEqual([
      {
        topicKey: "2:t1",
        jobId: 2,
        title: "为什么你的选题没人看？",
        lineIds: ["line-1", "line-2"],
        sourceLine: "分析 #2 · 复盘.mp4 · 等待人工确认",
      },
    ]);
  });

  test("分析任务缺失时来源行只写分析序号，不编造文件名", () => {
    expect(
      proposedTopicMeta(7, undefined),
    ).toBe("分析 #7 · 等待人工确认");
  });

  test("切片任务副行：行数 · 累计时长", () => {
    expect(sliceTaskMeta(slice({ lineCount: 3, durationSeconds: 45 }))).toBe("3 行字幕 · 00:00:45");
  });
});

describe("未切片内容时长", () => {
  test("只列已加入整理的视频，按加入顺序；格式与原型一致", () => {
    const state = queue({
      files: [
        file({ id: "v1", name: "晚场.mp4", unslicedSeconds: 590 }),
        file({ id: "v2", name: "复盘.mp4", added: false, unslicedSeconds: 100 }),
        file({ id: "v3", name: "选题.mp4", unslicedSeconds: 1080 }),
      ],
    });
    expect(queueFootline(state)).toBe(
      "晚场.mp4：未切片内容时长 00:09:50；选题.mp4：未切片内容时长 00:18:00",
    );
  });

  test("队列为空时给出可读的占位文案", () => {
    expect(queueFootline(queue({ files: [file({ added: false })] }))).toBe(
      "未切片内容时长：尚未加入视频。",
    );
    expect(queueFootline(null)).toBe("未切片内容时长：尚未加入视频。");
  });

  test("负数按 0 处理，不出现负时长", () => {
    expect(queueFootline(queue({ files: [file({ unslicedSeconds: -5 })] }))).toBe(
      "晚场.mp4：未切片内容时长 00:00:00",
    );
  });

  test("重启后快照 added=false，项目清单已加入的视频仍列在底部", () => {
    const state = queue({ files: [file({ id: "v1", added: false, unslicedSeconds: 590 })] });
    expect(queueFootline(state, ["v1"])).toBe("晚场.mp4：未切片内容时长 00:09:50");
    expect(queueFootline(state, ["other"])).toBe("未切片内容时长：尚未加入视频。");
    expect(queueFootline(state, [])).toBe("未切片内容时长：尚未加入视频。");
  });
});
