import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleLines, hostClusterCount } from "./lines";
import { readMarks, writeMarks } from "./sample-store";
import { devLabEnabled } from "./gate";

describe("Lab 字幕行组装", () => {
  test("同簇 gap<=0.6s 合并；不足 3s 的说话人并入邻居", () => {
    const assembled = assembleLines({
      labels: [0, 0, 1],
      segments: [
        { start: 0, end: 2, speaker: 0 },
        { start: 2.5, end: 4, speaker: 0 },
        { start: 5, end: 6, speaker: 1 },
      ],
      texts: [
        { start: 0, end: 2, text: "第一句" },
        { start: 2.5, end: 4, text: "第二句" },
        { start: 5, end: 6, text: "嗯" },
      ],
      silences: [],
    });
    expect(assembled.speakers).toHaveLength(1);
    expect(assembled.lines.map((l) => l.speakerId)).toEqual(["speaker-1", "speaker-1"]);
    expect(assembled.lines[0]?.text).toBe("第一句第二句");
    expect(assembled.speakers[0]?.lines).toBe(2);
    expect(assembled.speakers[0]?.sampleStarts).toEqual([0, 5]);
  });

  test("两个 >=3s 的说话人各自成簇并按总时长编号", () => {
    const assembled = assembleLines({
      labels: [0, 1],
      segments: [
        { start: 0, end: 5, speaker: 0 },
        { start: 6, end: 9, speaker: 1 },
      ],
      texts: [
        { start: 0, end: 5, text: "长句" },
        { start: 6, end: 9, text: "短句" },
      ],
      silences: [],
    });
    expect(assembled.speakers.map((s) => s.id)).toEqual(["speaker-1", "speaker-2"]);
    expect(assembled.speakers[0]?.seconds).toBe(5);
    expect(assembled.lines[0]?.text).toBe("长句");
  });

  test("主播锚点覆盖的簇数", () => {
    const segments = [
      { start: 0, end: 2, speaker: 0 },
      { start: 2, end: 4, speaker: 0 },
      { start: 10, end: 12, speaker: 0 },
    ];
    expect(hostClusterCount([{ start: 0, end: 4 }], segments, [0, 0, 0])).toBe(1);
    expect(hostClusterCount([{ start: 0, end: 4 }], segments, [3, 7, 0])).toBe(2);
    expect(hostClusterCount([], segments, [0, 0, 0])).toBeNull();
  });
});

describe("Lab 标记落盘", () => {
  test("只保留合法键与值，读回一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "vn-lab-marks-"));
    try {
      const saved = writeMarks(dir, "abc123", { "1000": "B", "2500": "both", bad: "A", "3000": "x" as never });
      expect(saved).toEqual({ "1000": "B", "2500": "both" });
      expect(readMarks(dir, "abc123")).toEqual({ "1000": "B", "2500": "both" });
      expect(JSON.parse(readFileSync(join(dir, "marks-abc123.json"), "utf8"))).toEqual({ "1000": "B", "2500": "both" });
      expect(readMarks(dir, "missing")).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Lab 开发模式门禁", () => {
  test("打包版关闭、开发态开启", () => {
    expect(devLabEnabled(true)).toBe(false);
    expect(devLabEnabled(false)).toBe(true);
  });
});
