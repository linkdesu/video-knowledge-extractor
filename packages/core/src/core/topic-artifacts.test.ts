import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectTopicArtifacts } from "./topic-artifacts";
import { emptyVideoData } from "./video-data";
import type { VideoId } from "./types";

function makeData(topics: Array<Record<string, unknown>>): { outputDir: string; data: Parameters<typeof projectTopicArtifacts>[0] } {
  const outputDir = mkdtempSync(join(tmpdir(), "vnote-artifacts-"));
  const data = emptyVideoData({ id: "v1" as VideoId, title: "v", sourcePath: "/s.mp4", durationSeconds: 60, outputDir });
  data.topics = topics as never;
  return { outputDir, data };
}

function topic(o: { id: string; status: string; dirName?: string; error?: string | null; clips?: unknown[] }): Record<string, unknown> {
  return {
    id: o.id,
    title: "t",
    summary: "s",
    segments: [{ start: 1, end: 2 }],
    dirName: o.dirName ?? o.id,
    status: o.status,
    selected: false,
    keyPoints: [],
    clips: o.clips ?? [],
    startedAt: null,
    elapsedSeconds: null,
    error: o.error ?? null,
  };
}

describe("projectTopicArtifacts", () => {
  test("topic.mp4 存在且非空 → 同一对象返回，状态不动", () => {
    const { outputDir, data } = makeData([
      topic({ id: "t1" as string, status: "done" }),
    ]);
    mkdirSync(join(outputDir, "t1"), { recursive: true });
    writeFileSync(join(outputDir, "t1", "topic.mp4"), "clip");
    expect(projectTopicArtifacts(data, outputDir)).toBe(data);
  });

  test("topic.mp4 缺失 → needs-rerun + 切片文件缺失，其余字段不动", () => {
    const { outputDir, data } = makeData([
      topic({ id: "t1" as string, status: "done", clips: [{ topicId: "t1", file: "topic.mp4", start: 1, end: 2, segmentIndexes: [0], segmentOffsets: [0] }] }),
      topic({ id: "t2" as string, status: "generating" }),
    ]);
    mkdirSync(join(outputDir, "t2"), { recursive: true });
    writeFileSync(join(outputDir, "t2", "topic.mp4"), "clip");
    const out = projectTopicArtifacts(data, outputDir);
    expect(out).not.toBe(data);
    const t1 = out.topics.find((t) => t.id === "t1")!;
    expect(t1.status).toBe("needs-rerun");
    expect(t1.error).toBe("切片文件缺失");
    // 其余字段不动：selected、startedAt 保留；失效 clips 清空
    expect(t1.clips).toEqual([]);
    expect(t1.selected).toBe(false);
    // 非 done 主题原样（同一对象）
    expect(out.topics.find((t) => t.id === "t2")).toBe(data.topics.find((t) => t.id === "t2"));
    // 入参不被改
    expect(data.topics.find((t) => t.id === "t1")!.status).toBe("done");
    expect(data.topics.find((t) => t.id === "t1")!.error).toBeNull();
  });

  test("0 字节 topic.mp4 → needs-rerun", () => {
    const { outputDir, data } = makeData([topic({ id: "t1" as string, status: "done" })]);
    mkdirSync(join(outputDir, "t1"), { recursive: true });
    writeFileSync(join(outputDir, "t1", "topic.mp4"), "");
    const out = projectTopicArtifacts(data, outputDir);
    expect(out.topics.find((t) => t.id === "t1")!.status).toBe("needs-rerun");
    expect(out.topics.find((t) => t.id === "t1")!.error).toBe("切片文件缺失");
  });

  test("名为 topic.mp4 的目录 → needs-rerun", () => {
    const { outputDir, data } = makeData([topic({ id: "t1" as string, status: "done" })]);
    mkdirSync(join(outputDir, "t1", "topic.mp4"), { recursive: true });
    const out = projectTopicArtifacts(data, outputDir);
    expect(out.topics.find((t) => t.id === "t1")!.status).toBe("needs-rerun");
  });

  test("generating/queued/proposed 不受投影影响", () => {
    const { outputDir, data } = makeData([
      topic({ id: "g" as string, status: "generating" }),
      topic({ id: "q" as string, status: "queued" }),
      topic({ id: "p" as string, status: "proposed" }),
    ]);
    expect(projectTopicArtifacts(data, outputDir)).toBe(data);
  });

  test("多个 done 主题各自独立判定，只有缺切片的那个被投影", () => {
    const { outputDir, data } = makeData([
      topic({ id: "ok" as string, status: "done" }),
      topic({ id: "bad" as string, status: "done" }),
    ]);
    mkdirSync(join(outputDir, "ok"), { recursive: true });
    writeFileSync(join(outputDir, "ok", "topic.mp4"), "clip");
    const out = projectTopicArtifacts(data, outputDir);
    expect(out.topics.find((t) => t.id === "ok")).toBe(data.topics.find((t) => t.id === "ok"));
    expect(out.topics.find((t) => t.id === "bad")!.status).toBe("needs-rerun");
  });

  test("已 needs-rerun 的主题保持原 error，不被覆盖", () => {
    const { outputDir, data } = makeData([topic({ id: "t1" as string, status: "needs-rerun", error: "结构改过" })]);
    expect(projectTopicArtifacts(data, outputDir)).toBe(data);
  });
});
