import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLabEntry } from "./analysis-cache";
import { migrateLegacyEntries } from "./legacy-migrate";

function sandbox(): { legacy: string; shared: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "vn-lab-migrate-"));
  return {
    legacy: join(root, "branch-a", "lab"),
    shared: join(root, "shared"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 一个能被 probeLabEntry 认的条目（r53 带 analysis；r48 旧条目只有 id）。 */
function writeEntry(root: string, key: string, options: { createdAt: string; analysis: boolean }): void {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  const sample: Record<string, unknown> = {
    version: 1,
    id: key,
    name: key,
    sourcePath: "/tmp/src.m4a",
    duration: 3,
    createdAt: options.createdAt,
    mode: "computed",
    timings: {},
    segments: 1,
    anchors: null,
    anchorsFile: "",
    labelsFile: "",
  };
  if (options.analysis) sample.analysis = { key, schema: 1, sourceHash: "h", params: {} };
  writeFileSync(join(dir, "sample.json"), JSON.stringify(sample));
  writeFileSync(join(dir, "segments.json"), JSON.stringify({ segments: [{ start: 0, end: 3, speaker: 0 }] }));
  writeFileSync(join(dir, "segtext.json"), JSON.stringify({ rows: [{ start: 0, end: 3, text: "甲" }] }));
  writeFileSync(join(dir, "silences.json"), JSON.stringify({ silences: [] }));
  writeFileSync(join(dir, "embeddings.json"), JSON.stringify({ dim: 1, rows: [{ start: 0, end: 3, v: [1] }] }));
  const wav = Buffer.alloc(4096);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  writeFileSync(join(dir, "audio.wav"), wav);
}

describe("旧分支目录 → 共享目录的搬运", () => {
  test("只复制共享目录缺失的条目；已有条目不覆盖；旧目录一字节不动", () => {
    const box = sandbox();
    const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const legacyOnly = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const r48 = "e176147c87495347";
    try {
      writeEntry(box.legacy, key, { createdAt: "branch", analysis: true });
      writeEntry(box.legacy, legacyOnly, { createdAt: "only-here", analysis: true });
      writeEntry(box.legacy, r48, { createdAt: "r48", analysis: false });
      writeEntry(box.shared, key, { createdAt: "shared", analysis: true });
      writeFileSync(join(box.legacy, `marks-${legacyOnly}.json`), JSON.stringify({ "1": "B" }));
      writeFileSync(join(box.legacy, `marks-${key}.json`), JSON.stringify({ "2": "A" }));
      // 半截目录：没有 sample.json，不能搬。
      mkdirSync(join(box.legacy, "cccccccccccccccccccccccccccccccc"), { recursive: true });

      const summary = migrateLegacyEntries({ legacyRoot: box.legacy, root: box.shared });
      expect(summary.copied.sort()).toEqual([legacyOnly, r48].sort());
      expect(summary.skipped).toBe(1);
      expect(summary.marks).toBe(1);
      expect(summary.failed).toEqual([]);

      // 共享里已有的条目仍是共享那份
      expect(probeLabEntry(box.shared, key, "file").hit?.createdAt).toBe("shared");
      expect(probeLabEntry(box.shared, legacyOnly, "file").hit?.createdAt).toBe("only-here");
      // r48 旧条目也搬过来了（没有 analysis 但它自己有 id，列表与加载都还能用）
      expect(existsSync(join(box.shared, r48, "sample.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(box.shared, `marks-${legacyOnly}.json`), "utf8"))).toEqual({ "1": "B" });
      // 已有条目的 marks 不覆盖
      expect(existsSync(join(box.shared, `marks-${key}.json`))).toBe(false);

      // 旧目录原样保留
      expect(existsSync(join(box.legacy, key, "sample.json"))).toBe(true);
      expect(existsSync(join(box.legacy, legacyOnly, "sample.json"))).toBe(true);

      // 幂等：第二次全部跳过
      const again = migrateLegacyEntries({ legacyRoot: box.legacy, root: box.shared });
      expect(again.copied).toEqual([]);
      expect(again.skipped).toBe(3);
    } finally {
      box.cleanup();
    }
  });

  test("两个目录指到同一处时什么都不做", () => {
    const box = sandbox();
    try {
      writeEntry(box.shared, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { createdAt: "x", analysis: true });
      const summary = migrateLegacyEntries({ legacyRoot: box.shared, root: box.shared });
      expect(summary).toEqual({ copied: [], skipped: 0, marks: 0, failed: [] });
    } finally {
      box.cleanup();
    }
  });
});
