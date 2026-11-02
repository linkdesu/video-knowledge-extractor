import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleLines, hostClusterCount } from "./lines";
import { readMarks, writeMarks } from "./sample-store";
import { devLabEnabled } from "./gate";
import { buildRows, filterRows, summarize } from "../../shared/lab-view";
import type { LabConfig, LabMarks } from "../../shared/lab";

/** 测试临时目录落在工作树的 `tmp/`（已忽略），每个用例用完即删。 */
const TMP_ROOT = join(import.meta.dirname, "../../../../../tmp");

function marksDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, "vn-lab-marks-"));
}

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
    const dir = marksDir();
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

  test("旧格式（A/B/both）加载后原标记不变，读路径不写盘", () => {
    const dir = marksDir();
    try {
      const legacy: LabMarks = {};
      for (let i = 0; i < 78; i++) legacy[String(1000 * (i + 1))] = (["A", "B", "both"] as const)[i % 3] ?? "A";
      const file = join(dir, "marks-abc123.json");
      const raw = JSON.stringify(legacy);
      writeFileSync(file, raw);

      const loaded = readMarks(dir, "abc123");
      expect(Object.keys(loaded)).toHaveLength(78);
      expect(loaded).toEqual(legacy);
      // 旧文件不用手工处理，也不会在读的时候被改写。
      expect(readFileSync(file, "utf8")).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("新增的问题类型可保存并读回", () => {
    const dir = marksDir();
    try {
      const marks = { "1000": "overlap_wrong_speaker", "2000": "false_duplicate", "3000": "backchannel_not_ignored" } as const;
      expect(writeMarks(dir, "abc123", marks)).toEqual(marks);
      expect(readMarks(dir, "abc123")).toEqual(marks);
      expect(JSON.parse(readFileSync(join(dir, "marks-abc123.json"), "utf8"))).toEqual(marks);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("在旧标注上补记问题类型：旧标记一条不丢", () => {
    const dir = marksDir();
    try {
      const legacy: LabMarks = {};
      for (let i = 0; i < 78; i++) legacy[String(1000 * (i + 1))] = (["A", "B", "both"] as const)[i % 3] ?? "A";
      writeFileSync(join(dir, "marks-abc123.json"), JSON.stringify(legacy));

      const merged: LabMarks = { ...readMarks(dir, "abc123"), "99000": "false_duplicate" };
      const saved = writeMarks(dir, "abc123", merged);
      expect(saved).toEqual({ ...legacy, "99000": "false_duplicate" });
      expect(readMarks(dir, "abc123")).toEqual({ ...legacy, "99000": "false_duplicate" });
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
