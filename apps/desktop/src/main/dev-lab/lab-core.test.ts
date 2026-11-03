import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "@video-notes/core/testing";
import { assembleLines, hostClusterCount } from "./lines";
import { readMarks, writeMarks } from "./sample-store";
import { devLabEnabled } from "./gate";
import { buildRows, filterRows, summarize } from "../../shared/lab-view";
import type { LabConfig } from "../../shared/lab";

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

  test("空文本行被丢弃：不进字幕行，也不计入说话人统计", () => {
    const assembled = assembleLines({
      labels: [0, 1],
      segments: [
        { start: 0, end: 6, speaker: 0 },
        { start: 7, end: 10.5, speaker: 1 },
      ],
      // 第一段没有任何段级文本（ASR 没解出字），组装时应当整行丢弃。
      texts: [{ start: 7, end: 10.5, text: "第二句" }],
      silences: [],
    });
    expect(assembled.lines.map((l) => l.text)).toEqual(["第二句"]);
    expect(assembled.lines.every((l) => l.text.trim() !== "")).toBe(true);
    const withLines = assembled.speakers.filter((s) => s.lines > 0);
    expect(withLines).toHaveLength(1);
    expect(withLines[0]?.seconds).toBe(3.5);
    expect(withLines[0]?.sampleStarts).toEqual([7]);
  });

  test("组装后的方案：摘要「过滤 N 行」与「仅已过滤」行数相等", () => {
    const assembled = assembleLines({
      labels: [0, 0, 1, 1],
      segments: [
        { start: 0, end: 4, speaker: 0 },
        { start: 5, end: 5.4, speaker: 0 },
        { start: 6, end: 10, speaker: 1 },
        // 这一段没有任何段级文本：组装时应整行丢弃，不能出现在 rows 或摘要里。
        { start: 11, end: 14, speaker: 1 },
      ],
      texts: [
        { start: 0, end: 4, text: "第一句" },
        { start: 5, end: 5.4, text: "嗯" },
        { start: 6, end: 10, text: "第二句" },
      ],
      silences: [],
    });
    const meta = {
      speakers: assembled.speakers.length,
      k: 2,
      picked: "sil" as const,
      silhouette: null,
      bicK: null,
      seeds: null,
      hostClusters: null,
    };
    const configA: LabConfig = { name: "baseline", meta, speakers: assembled.speakers, lines: assembled.lines };
    const configB: LabConfig = { name: "refine_filter", meta, speakers: assembled.speakers, lines: assembled.lines };
    const rows = buildRows(configA, configB, 1);
    const summary = summarize(configA, configB, 1);
    expect(rows.map((r) => r.line.text)).toEqual(["第一句", "嗯", "第二句"]);
    expect(summary.filteredLines).toBe(1);
    expect(filterRows(rows, "filtered", null)).toHaveLength(summary.filteredLines);
  });
});

describe("Lab 标记落盘", () => {
  test("只保留合法键与值，读回一致", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    const saved = writeMarks(dir, "abc123", { "1000": "B", "2500": "both", bad: "A", "3000": "x" as never });
    expect(saved).toEqual({ "1000": "B", "2500": "both" });
    expect(readMarks(dir, "abc123")).toEqual({ "1000": "B", "2500": "both" });
    expect(JSON.parse(readFileSync(join(dir, "marks-abc123.json"), "utf8"))).toEqual({ "1000": "B", "2500": "both" });
    expect(readMarks(dir, "missing")).toEqual({});
  });
});

describe("Lab 开发模式门禁", () => {
  test("打包版关闭、开发态开启", () => {
    expect(devLabEnabled(true)).toBe(false);
    expect(devLabEnabled(false)).toBe(true);
  });
});
