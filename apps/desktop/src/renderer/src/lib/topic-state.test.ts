import { describe, expect, test } from "bun:test";
import type { JobSnapshot } from "../../shared/ipc";
import { hasReadyNote, topicGenerating, topicStateLabel, topicUiState } from "./topic-state";

function topic(overrides: Partial<{ status: string; error: string | null; startedAt: string | null }> = {}) {
  return { status: "done", error: null, startedAt: null, ...overrides };
}

/** 在途 notes 任务：running / generate-notes / 指定主题。 */
function notesJob(topicId: string, overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    state: "running",
    jobId: "job-1",
    kind: "notes",
    videoId: "vid-1",
    step: "generate-notes",
    done: 0,
    total: 3,
    detail: null,
    startedAt: "2026-10-20T10:00:00.000Z",
    topicId,
    topicPercent: null,
    ...overrides,
  };
}

describe("topicGenerating", () => {
  test("磁盘 status=generating 即生成中，无需任务", () => {
    expect(topicGenerating({ id: "t1", status: "generating" }, null)).toBe(true);
    expect(topicGenerating({ id: "t1", status: "done" }, null)).toBe(false);
  });

  test("在途 notes 任务正对该主题时生成中（磁盘还是 queued 也成立）", () => {
    expect(topicGenerating({ id: "t2", status: "queued" }, notesJob("t2"))).toBe(true);
    // 任务指向别的主题 → 按磁盘状态
    expect(topicGenerating({ id: "t2", status: "queued" }, notesJob("t3"))).toBe(false);
    // 非 notes 任务 / 非 generate-notes 步骤 / 非 running → 不覆盖
    expect(topicGenerating({ id: "t2", status: "queued" }, notesJob("t2", { kind: "extract" }))).toBe(false);
    expect(
      topicGenerating({ id: "t2", status: "queued" }, notesJob("t2", { step: "transcribe" })),
    ).toBe(false);
    expect(
      topicGenerating({ id: "t2", status: "queued" }, { ...notesJob("t2"), state: "queued" } as JobSnapshot),
    ).toBe(false);
  });
});

describe("topicUiState", () => {
  test("generating 优先于一切磁盘状态", () => {
    expect(topicUiState(topic({ status: "queued" }), true)).toEqual({ kind: "generating" });
    expect(topicUiState(topic({ status: "failed", error: "boom" }), true)).toEqual({ kind: "generating" });
  });

  test("非生成中时按磁盘状态一一映射", () => {
    expect(topicUiState(topic({ status: "queued" }), false)).toEqual({ kind: "queued" });
    expect(topicUiState(topic({ status: "done" }), false)).toEqual({ kind: "done" });
    expect(topicUiState(topic({ status: "failed", error: "LLM 调用超时" }), false)).toEqual({
      kind: "failed",
      reason: "LLM 调用超时",
    });
    expect(topicUiState(topic({ status: "needs-rerun" }), false)).toEqual({
      kind: "needs-rerun",
      reason: null,
    });
    expect(topicUiState(topic({ status: "proposed" }), false)).toEqual({ kind: "proposed" });
  });

  test("failed 缺省原因；needs-rerun 带原因", () => {
    expect(topicUiState(topic({ status: "failed" }), false)).toEqual({
      kind: "failed",
      reason: "未知原因",
    });
    expect(topicUiState(topic({ status: "needs-rerun", error: "topic.mp4 缺失" }), false)).toEqual({
      kind: "needs-rerun",
      reason: "topic.mp4 缺失",
    });
  });
});

describe("topicStateLabel", () => {
  test("generating：elapsed 秒的 fmtElapsed MM:SS（75 秒 = 01:15）", () => {
    expect(topicStateLabel({ kind: "generating" }, 75)).toBe("正在生成中… · 已用 01:15");
  });

  test("generating：42 秒 = 00:42", () => {
    expect(topicStateLabel({ kind: "generating" }, 42)).toBe("正在生成中… · 已用 00:42");
  });

  test("generating：刚起步 0 秒 = 00:00；超过 60 分钟也正常（3661 秒 = 61:01）", () => {
    expect(topicStateLabel({ kind: "generating" }, 0)).toBe("正在生成中… · 已用 00:00");
    expect(topicStateLabel({ kind: "generating" }, 3661)).toBe("正在生成中… · 已用 61:01");
  });

  test("queued / done / proposed 固定文案", () => {
    expect(topicStateLabel({ kind: "queued" }, 0)).toBe("排队等待中…");
    expect(topicStateLabel({ kind: "done" }, 0)).toBe("已完成");
    expect(topicStateLabel({ kind: "proposed" }, 0)).toBe("待确认");
  });

  test("failed 带原因，缺省用「未知原因」", () => {
    expect(topicStateLabel({ kind: "failed", reason: "LLM 调用超时" }, 0)).toBe("生成失败：LLM 调用超时");
    expect(topicStateLabel({ kind: "failed", reason: "未知原因" }, 0)).toBe("生成失败：未知原因");
  });

  test("needs-rerun 有原因带、无原因不带", () => {
    expect(topicStateLabel({ kind: "needs-rerun", reason: "topic.mp4 缺失" }, 0)).toBe("待重新生成：topic.mp4 缺失");
    expect(topicStateLabel({ kind: "needs-rerun", reason: null }, 0)).toBe("待重新生成");
  });
});

describe("hasReadyNote", () => {
  test("空列表 false", () => {
    expect(hasReadyNote([])).toBe(false);
  });

  test("只有 failed / needs-rerun 的列表 false", () => {
    expect(hasReadyNote([{ status: "failed" }, { status: "needs-rerun" }, { status: "queued" }])).toBe(false);
  });

  test("含一个 done 主题 true（其余任意状态）", () => {
    expect(
      hasReadyNote([{ status: "failed" }, { status: "done" }, { status: "needs-rerun" }, { status: "proposed" }]),
    ).toBe(true);
  });
});
