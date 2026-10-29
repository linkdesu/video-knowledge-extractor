import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importExperimentDir } from "./experiment";

describe("实验目录零计算加载", () => {
  test("读 segtext + T1.0 标签 + 锚点，音频挂进样本目录", () => {
    const root = mkdtempSync(join(tmpdir(), "vn-lab-exp-"));
    try {
      const src = join(root, "r2");
      mkdirSync(src);
      const wav = join(root, "audio.wav");
      writeFileSync(wav, "RIFF");
      writeFileSync(
        join(src, "segtext-a.json"),
        JSON.stringify({
          audio: wav,
          duration: 12.5,
          rows: [
            { start: 0, end: 1, speaker: 3, text: "你好" },
            { start: 1.2, end: 2, speaker: 3, text: "嗯" },
          ],
        }),
      );
      writeFileSync(join(src, "labels-a-T1.0.json"), JSON.stringify({ configs: { baseline: { labels: [3, 3] }, refine: { labels: [0, 0] } } }));
      writeFileSync(join(src, "labels-a-T1.5.json"), JSON.stringify({ configs: { baseline: { labels: [9, 9] }, refine: { labels: [1, 1] } } }));
      writeFileSync(join(src, "gt-anchors.json"), JSON.stringify({ anchors: [{ speaker: "H", ranges: [[0, 2]] }] }));
      const out = join(root, "sample");
      const file = importExperimentDir(src, out, "abcdef0123456789", "样本 A");
      expect(file.mode).toBe("experiment");
      expect(file.segments).toBe(2);
      expect(file.duration).toBe(12.5);
      expect(file.anchors).toBe(1);
      expect(existsSync(join(out, "audio.wav"))).toBe(true);
      expect(existsSync(join(out, "labels.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(out, "labels.json"), "utf8"))).toEqual({
        baseline: [3, 3],
        refine: [0, 0],
        refine_filter: [0, 0],
      });
      expect(JSON.parse(readFileSync(join(out, "segtext.json"), "utf8")).rows[1].text).toBe("嗯");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("没有 segtext 的目录拒绝加载", () => {
    const root = mkdtempSync(join(tmpdir(), "vn-lab-exp-"));
    try {
      expect(() => importExperimentDir(root, join(root, "out"), "abcdef0123456789", "x")).toThrow(/segtext/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
