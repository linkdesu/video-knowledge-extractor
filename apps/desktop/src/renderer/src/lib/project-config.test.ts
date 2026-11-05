import { describe, expect, test } from "bun:test";
import type { ProjectDirectoryFile } from "../../../shared/ipc";
import {
  ORGANIZE_STATUS_LABEL,
  clampChunkMinutes,
  directoryCountLabel,
  directoryEmptyHint,
  exampleDirectory,
  fileMeta,
  hms,
  monitorStatusLabel,
  processedLabel,
  selectAllState,
  selectionSummary,
  sortDirectoryFiles,
  startButtonState,
} from "./project-config";

function file(overrides: Partial<ProjectDirectoryFile> = {}): ProjectDirectoryFile {
  return {
    videoId: "v1",
    name: "晚场直播.mp4",
    path: "/recordings/晚场直播.mp4",
    sizeBytes: 2.4 * 1024 * 1024,
    modifiedAt: "2026-11-05T12:00:00.000Z",
    durationSeconds: 600,
    added: false,
    organizeStatus: "unorganized",
    ...overrides,
  };
}

describe("分块时长夹值（原型 L150 / configure）", () => {
  test("默认 10，范围 1–30，四舍五入", () => {
    expect(clampChunkMinutes("10")).toBe(10);
    expect(clampChunkMinutes(7.6)).toBe(8);
    expect(clampChunkMinutes(0)).toBe(1);
    expect(clampChunkMinutes(-5)).toBe(1);
    expect(clampChunkMinutes(30)).toBe(30);
    expect(clampChunkMinutes(31)).toBe(30);
    expect(clampChunkMinutes(999)).toBe(30);
  });

  test("读不出数字时回到默认 10", () => {
    expect(clampChunkMinutes("")).toBe(10);
    expect(clampChunkMinutes("abc")).toBe(10);
    expect(clampChunkMinutes(Number.NaN)).toBe(10);
  });
});

describe("填入示例目录（原型 L148）", () => {
  test("项目目录 + /recordings", () => {
    expect(exampleDirectory("/Users/link/Movies/切片项目/晚场")).toBe(
      "/Users/link/Movies/切片项目/晚场/recordings",
    );
  });

  test("尾部斜杠不重复，Windows 路径用反斜杠", () => {
    expect(exampleDirectory("/Users/link/切片项目/")).toBe("/Users/link/切片项目/recordings");
    expect(exampleDirectory("D:\\code\\video-notes\\")).toBe("D:\\code\\video-notes\\recordings");
  });
});

describe("监控状态与计数（原型 L53-L64 / L130）", () => {
  test("尚未监控 / 监控中", () => {
    expect(monitorStatusLabel(false)).toBe("尚未监控");
    expect(monitorStatusLabel(true)).toBe("监控中");
  });

  test("目录视频计数", () => {
    expect(directoryCountLabel(0)).toBe("0 个文件");
    expect(directoryCountLabel(3)).toBe("3 个文件");
  });
});

describe("三种整理状态（#121 第 26 条，无录制状态）", () => {
  test("只有三个中文标签", () => {
    expect(ORGANIZE_STATUS_LABEL).toEqual({
      unorganized: "未整理",
      organizing: "持续整理中",
      finished: "整理已结束",
    });
  });
});

describe("大小 / 时长（原型 L130 第 4 列）", () => {
  test("HH:MM:SS 与文件大小", () => {
    expect(hms(0)).toBe("00:00:00");
    expect(hms(59)).toBe("00:00:59");
    expect(hms(600)).toBe("00:10:00");
    expect(hms(3725)).toBe("01:02:05");
    expect(fileMeta(file())).toEqual({ size: "2.4 MB", duration: "00:10:00" });
    expect(processedLabel(125)).toBe("已处理 00:02:05");
  });

  test("未导入 / 读不出时长时显示 —", () => {
    expect(fileMeta(file({ durationSeconds: null })).duration).toBe("—");
  });
});

describe("修改时间倒序 + 同时间保持原顺序（#121 第 20 条）", () => {
  test("新的在前；相同修改时间沿用上一轮顺序", () => {
    const a = file({ videoId: "a", modifiedAt: "2026-11-05T12:00:00.000Z" });
    const b = file({ videoId: "b", modifiedAt: "2026-11-05T13:00:00.000Z" });
    const c = file({ videoId: "c", modifiedAt: "2026-11-05T12:00:00.000Z" });
    expect(sortDirectoryFiles([a, b, c], []).map((f) => f.videoId)).toEqual(["b", "a", "c"]);
    // 上一轮里 c 在 a 前面：同修改时间不跳动
    expect(sortDirectoryFiles([a, b, c], ["c", "b", "a"]).map((f) => f.videoId)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  test("新出现的文件排在已有同时间文件之后", () => {
    const old = file({ videoId: "old", modifiedAt: "2026-11-05T12:00:00.000Z" });
    const fresh = file({ videoId: "fresh", modifiedAt: "2026-11-05T12:00:00.000Z" });
    expect(sortDirectoryFiles([fresh, old], ["old"]).map((f) => f.videoId)).toEqual([
      "old",
      "fresh",
    ]);
  });
});

describe("表头全选（原型 L130）", () => {
  test("没有文件时禁用", () => {
    expect(selectAllState([], new Set())).toEqual({
      checked: false,
      indeterminate: false,
      disabled: true,
    });
  });

  test("部分选中是 indeterminate，全选是 checked", () => {
    const files = [file({ videoId: "a" }), file({ videoId: "b" })];
    expect(selectAllState(files, new Set(["a"]))).toEqual({
      checked: false,
      indeterminate: true,
      disabled: false,
    });
    expect(selectAllState(files, new Set(["a", "b"]))).toEqual({
      checked: true,
      indeterminate: false,
      disabled: false,
    });
  });
});

describe("开始整理按钮与选择提示（原型 L130）", () => {
  test("没有新勾选时不可点；文案带数量", () => {
    const files = [file({ videoId: "a" }), file({ videoId: "b" })];
    expect(startButtonState(files, new Set())).toEqual({ disabled: true, label: "开始整理" });
    expect(startButtonState(files, new Set(["a"]))).toEqual({ disabled: false, label: "开始整理 (1)" });
    expect(startButtonState(files, new Set(["a", "b"]))).toEqual({
      disabled: false,
      label: "开始整理 (2)",
    });
  });

  test("已加入的项目用「加入整理」，已加入的勾选不再算新任务", () => {
    const files = [file({ videoId: "a", added: true }), file({ videoId: "b" })];
    expect(startButtonState(files, new Set(["a"]))).toEqual({ disabled: true, label: "加入整理" });
    expect(startButtonState(files, new Set(["a", "b"]))).toEqual({
      disabled: false,
      label: "加入整理 (1)",
    });
  });

  test("已选 N 个 · 已加入 M 个", () => {
    const files = [
      file({ videoId: "a", added: true }),
      file({ videoId: "b" }),
      file({ videoId: "c" }),
    ];
    expect(selectionSummary(files, new Set(["b"]))).toBe("已选 1 个 · 已加入 1 个");
    expect(selectionSummary(files, new Set())).toBe("已选 0 个 · 已加入 1 个");
  });
});

describe("空表提示（原型 L130）", () => {
  test("沿用原型文案", () => {
    expect(directoryEmptyHint()).toBe("开始监控后显示视频，勾选后点击开始整理。");
  });
});
