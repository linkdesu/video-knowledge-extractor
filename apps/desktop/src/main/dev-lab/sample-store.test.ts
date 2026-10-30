import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSamples } from "./sample-store";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vn-lab-samples-"));
}

function writeSample(
  root: string,
  id: string,
  input: { createdAt: string; sourceHash?: string; name?: string },
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sample.json"),
    JSON.stringify({
      version: 1,
      id,
      name: input.name ?? id,
      sourcePath: `/tmp/${id}.m4a`,
      duration: 1,
      createdAt: input.createdAt,
      mode: "computed",
      timings: {},
      segments: 0,
      anchors: null,
      anchorsFile: "",
      labelsFile: "",
      ...(input.sourceHash === undefined ? {} : { analysis: { key: id, schema: 1, sourceHash: input.sourceHash, params: {} } }),
    }),
  );
}

describe("Lab 样本列表去重", () => {
  test("同一内容指纹只展示一份，保留最新的条目", () => {
    const root = tempRoot();
    writeSample(root, "old1", { createdAt: "2026-10-01T00:00:00.000Z", sourceHash: "hash-a" });
    writeSample(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", sourceHash: "hash-a" });
    writeSample(root, "other", { createdAt: "2026-10-20T00:00:00.000Z", sourceHash: "hash-b" });
    expect(listSamples(root).map((s) => s.id)).toEqual(["new2", "other"]);
  });

  test("没有 analysis 戳的旧样本照常展示（无法判定内容指纹）", () => {
    const root = tempRoot();
    writeSample(root, "legacy", { createdAt: "2026-10-01T00:00:00.000Z" });
    writeSample(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", sourceHash: "hash-a" });
    expect(listSamples(root).map((s) => s.id)).toEqual(["new2", "legacy"]);
  });
});
