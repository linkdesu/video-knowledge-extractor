import { describe, expect, test } from "bun:test";
import {
  projectLogSummary,
  projectStatsLine,
  breadcrumbParts,
  tabIndexAfterKey,
} from "./project-frame";

describe("breadcrumbParts", () => {
  test("整理笔记页只有自身一段", () => {
    expect(breadcrumbParts({ page: "notes" })).toEqual(["整理笔记"]);
  });

  test("项目列表页是「整理切片 / 项目管理」", () => {
    expect(breadcrumbParts({ page: "projects" })).toEqual([
      "整理切片",
      "项目管理",
    ]);
  });

  test("项目页第三段随 tab 变化", () => {
    const project = (tab: "config" | "queue" | "output") =>
      breadcrumbParts({ page: "project", name: "晚场直播精华", tab });
    expect(project("config")).toEqual(["整理切片", "晚场直播精华", "项目配置"]);
    expect(project("queue")).toEqual(["整理切片", "晚场直播精华", "切片队列"]);
    expect(project("output")).toEqual(["整理切片", "晚场直播精华", "切片产出"]);
  });
});

describe("tabIndexAfterKey", () => {
  test("左右方向键在三个 tab 间循环", () => {
    expect(tabIndexAfterKey(0, "ArrowRight", 3)).toBe(1);
    expect(tabIndexAfterKey(2, "ArrowRight", 3)).toBe(0);
    expect(tabIndexAfterKey(0, "ArrowLeft", 3)).toBe(2);
    expect(tabIndexAfterKey(1, "ArrowLeft", 3)).toBe(0);
  });

  test("Home / End 跳到两端", () => {
    expect(tabIndexAfterKey(2, "Home", 3)).toBe(0);
    expect(tabIndexAfterKey(0, "End", 3)).toBe(2);
  });

  test("其它按键与焦点不在 tab 上时不响应", () => {
    expect(tabIndexAfterKey(1, "Enter", 3)).toBeNull();
    expect(tabIndexAfterKey(-1, "ArrowRight", 3)).toBeNull();
  });
});

const task = (id: number, status: "waiting" | "running" | "done") => ({
  id,
  fileId: "v1",
  name: "直播_晚场.mp4",
  startSeconds: 0,
  endSeconds: 600,
  status,
  stage: 0 as const,
});

describe("projectLogSummary", () => {
  test("折叠摘要按原型字段：分析 / 切片进行中、待确认主题数、最新事件", () => {
    const summary = projectLogSummary({
      queue: {
        analysis: [task(1, "running"), task(2, "waiting"), task(3, "done")],
        slices: [task(7, "waiting"), task(8, "done")],
        proposed: [
          { topicKey: "1:0", jobId: 1, fileId: "v1", title: "主题一", category: "创作", lineIds: [] },
          { topicKey: "3:1", jobId: 3, fileId: "v1", title: "主题二", category: "创作", lineIds: [] },
        ],
        files: [],
      },
      events: [
        { id: 3, at: "2026-11-06T02:00:03.000Z", level: "info", text: "发现新文件：直播_续录_01.mp4" },
        { id: 2, at: "2026-11-06T02:00:02.000Z", level: "info", text: "旧事件" },
      ],
    });
    expect(summary).toBe(
      "分析 1 进行中 · 切片 0 进行中 · 2 主题待确认 · 发现新文件：直播_续录_01.mp4",
    );
  });

  test("执行器未接入（queue 为 null）且没有事件时显示尚未监控", () => {
    expect(projectLogSummary({ queue: null, events: [] })).toBe(
      "分析 0 进行中 · 切片 0 进行中 · 0 主题待确认 · 尚未监控",
    );
  });
});

describe("projectStatsLine", () => {
  test("项目列表每行统计与原型 L129 一致", () => {
    expect(
      projectStatsLine({
        videoCount: 3,
        pendingTaskCount: 4,
        proposedTopicCount: 2,
        clipCount: 5,
      }),
    ).toBe("3 个视频 · 4 个待处理任务 · 2 个待确认主题 · 5 条切片");
  });
});
