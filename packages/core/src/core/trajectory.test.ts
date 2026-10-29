import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTrajectory, readTrajectory, TRAJECTORY_FILE } from "./trajectory";
import type { TrajectoryEntry } from "./trajectory";

function entry(runId: string, n: number): TrajectoryEntry {
  const started = `2026-10-24T00:00:${String(n).padStart(2, "0")}.000Z`;
  return {
    runId,
    startedAt: started,
    finishedAt: `2026-10-24T00:01:${String(n).padStart(2, "0")}.000Z`,
    durationMs: 60000,
    trigger: n === 1 ? "initial" : "regenerate",
    request: {
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      prompt: { id: "note-key-points", source: "default", sha256: "0".repeat(64), hosts: [], chars: 42 },
      glossaryCount: 1,
    },
    response: { status: "succeeded", rawText: `raw${n}`, parsedSummary: [`要点${n}`], error: null },
    clip: { clipFile: "topic.mp4", segments: [{ start: 0, end: 30 }], status: "ready" },
  };
}

describe("trajectory", () => {
  test("干净目录第一次 append：history 一条，latest 指向它", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-traj-"));
    const e = entry("run-1", 1);
    const file = appendTrajectory(dir, { topicId: "t1", topicTitle: "主题A" }, e);
    expect(file.history.length).toBe(1);
    expect(file.latest).toBe(e);
    expect(file.topicId).toBe("t1");
    expect(file.topicTitle).toBe("主题A");
    expect(file.updatedAt).toBe(e.finishedAt);
    expect(readTrajectory(dir)).toEqual(file);
  });

  test("第二、三次 append：history 增到 3，最新在最后，latest 指向它", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-traj-"));
    const e1 = entry("run-1", 1);
    const e2 = entry("run-2", 2);
    const e3 = entry("run-3", 3);
    appendTrajectory(dir, { topicId: "t1", topicTitle: "主题A" }, e1);
    appendTrajectory(dir, { topicId: "t1", topicTitle: "主题A" }, e2);
    const file = appendTrajectory(dir, { topicId: "t1", topicTitle: "主题A" }, e3);
    expect(file.history.length).toBe(3);
    expect(file.history.map((e) => e.runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect(file.latest).toBe(e3);
    expect(file.updatedAt).toBe(e3.finishedAt);
    // 落盘后读回一致
    const reread = readTrajectory(dir)!;
    expect(reread.history.length).toBe(3);
    expect(reread.history[2]?.runId).toBe("run-3");
    expect(reread.latest.runId).toBe("run-3");
  });

  test("已有文件损坏：不抛错，从空历史重新开始", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-traj-"));
    writeFileSync(join(dir, TRAJECTORY_FILE), "{not-json");
    const e = entry("run-x", 1);
    const file = appendTrajectory(dir, { topicId: "t1", topicTitle: "主题A" }, e);
    expect(file.history.length).toBe(1);
    expect(file.latest).toBe(e);
    // 损坏内容被新记录覆盖
    expect(readTrajectory(dir)?.history[0]?.runId).toBe("run-x");
  });

  test("写盘内容不含 API 凭据字段名", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-traj-"));
    const e = entry("run-1", 1);
    appendTrajectory(dir, { topicId: "t1", topicTitle: "主题A" }, e);
    const text = readFileSync(join(dir, TRAJECTORY_FILE), "utf8");
    expect(text.includes("apiKey")).toBe(false);
    expect(text.includes("api_key")).toBe(false);
    expect(text.includes("Authorization")).toBe(false);
  });
});
