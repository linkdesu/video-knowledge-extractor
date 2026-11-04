import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "@video-notes/core/testing";
import { assembleLines, hostClusterCount } from "./lines";
import { readMarks, writeMarks } from "./sample-store";
import { devLabEnabled } from "./gate";
import { buildRows, filterRows, summarize } from "../../shared/lab-view";
import type { LabConfig, LabMark, LabMarks } from "../../shared/lab";

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

describe("Lab 行标注落盘", () => {
  test("记录形状：标记与实际说话人分两个字段，非法字段单独丢弃", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    const saved = writeMarks(dir, "abc123", {
      "1000": { mark: "B", speaker: "speaker-1" },
      "2500": { mark: "both" },
      "3000": { speaker: "speaker-2" },
      "4000": {},
      bad: { mark: "A" },
      "5000": { mark: "x" as never, speaker: "bob" },
    });
    const expected: LabMarks = {
      "1000": { mark: "B", speaker: "speaker-1" },
      "2500": { mark: "both" },
      "3000": { speaker: "speaker-2" },
    };
    expect(saved).toEqual(expected);
    expect(readMarks(dir, "abc123")).toEqual(expected);
    // r77：记录写进 annotations-<id>.json，r48 的 marks-<id>.json 一个字节都不碰。
    expect(JSON.parse(readFileSync(join(dir, "annotations-abc123.json"), "utf8"))).toEqual(expected);
    expect(existsSync(join(dir, "marks-abc123.json"))).toBe(false);
    expect(readMarks(dir, "missing")).toEqual({});
  });

  test("旧格式（r48–r76 的 marks 单标记字符串）照常读成记录，读路径不写盘", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    const legacy: Record<string, string> = {};
    const values = ["A", "B", "both", "overlap_wrong_speaker", "backchannel_not_ignored"];
    for (let i = 0; i < 78; i++) legacy[String(1000 * (i + 1))] = values[i % values.length] ?? "A";
    const file = join(dir, "marks-abc123.json");
    const raw = JSON.stringify(legacy);
    writeFileSync(file, raw);

    const loaded = readMarks(dir, "abc123");
    expect(Object.keys(loaded)).toHaveLength(78);
    expect(loaded["1000"]).toEqual({ mark: "A" });
    expect(loaded["2000"]).toEqual({ mark: "B" });
    expect(loaded["5000"]).toEqual({ mark: "backchannel_not_ignored" });
    // 旧文件不用手工处理，也不会在读的时候被改写。
    expect(readFileSync(file, "utf8")).toBe(raw);
    expect(existsSync(join(dir, "annotations-abc123.json"))).toBe(false);
  });

  test("在旧标注上补记实际说话人：旧标记一条不丢，旧文件保持原字节", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    const legacy: Record<string, LabMark> = {};
    for (let i = 0; i < 78; i++) legacy[String(1000 * (i + 1))] = (["A", "B", "both"] as const)[i % 3] ?? "A";
    const file = join(dir, "marks-abc123.json");
    const raw = JSON.stringify(legacy);
    writeFileSync(file, raw);

    const merged: LabMarks = { ...readMarks(dir, "abc123"), "99000": { speaker: "speaker-3" } };
    const saved = writeMarks(dir, "abc123", merged);
    expect(Object.keys(saved)).toHaveLength(79);
    for (const [key, value] of Object.entries(legacy)) expect(saved[key]).toEqual({ mark: value });
    expect(saved["99000"]).toEqual({ speaker: "speaker-3" });
    expect(readMarks(dir, "abc123")).toEqual(saved);
    // 旧文件降级仍可读：新记录只落在 annotations，旧 marks 字节完全不变。
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  test("annotations 文件存在即权威快照：旧的 marks 内容不再叠加", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    writeFileSync(join(dir, "marks-abc123.json"), JSON.stringify({ "1000": "A", "2000": "B" }));
    writeMarks(dir, "abc123", { "1000": { mark: "both" } });
    // 2000 是在记录文件生成之后被清掉的那一条：旧 marks 不能把它复活。
    expect(readMarks(dir, "abc123")).toEqual({ "1000": { mark: "both" } });
  });

  test("annotations 文件损坏时读报错、写拒绝，绝不退回旧文件覆盖新记录", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    writeFileSync(join(dir, "marks-abc123.json"), JSON.stringify({ "1000": "A" }));
    const broken = "{ 这不是 JSON";
    writeFileSync(join(dir, "annotations-abc123.json"), broken);
    expect(() => readMarks(dir, "abc123")).toThrow();
    // 界面读失败时是空状态，此时保存等于把可修复的标注抹掉：必须拒绝。
    expect(() => writeMarks(dir, "abc123", { "2000": { mark: "B" } })).toThrow(/已损坏/);
    expect(readFileSync(join(dir, "annotations-abc123.json"), "utf8")).toBe(broken);
  });

  test("非法 marks 容器（null / 数组 / 字符串）直接拒绝，磁盘不动", () => {
    const dir = makeTmpDir("vn-lab-marks-");
    writeFileSync(join(dir, "marks-abc123.json"), JSON.stringify({ "1000": "B" }));
    writeMarks(dir, "abc123", { "1000": { mark: "both" }, "2000": { mark: "A" } });
    const marksBefore = readFileSync(join(dir, "marks-abc123.json"), "utf8");
    const annotationsBefore = readFileSync(join(dir, "annotations-abc123.json"), "utf8");

    for (const bad of [null, undefined, [], "A", 3] as unknown[]) {
      expect(() => writeMarks(dir, "abc123", bad as LabMarks)).toThrow();
    }
    expect(readFileSync(join(dir, "marks-abc123.json"), "utf8")).toBe(marksBefore);
    expect(readFileSync(join(dir, "annotations-abc123.json"), "utf8")).toBe(annotationsBefore);
  });
});

describe("Lab 开发模式门禁", () => {
  test("打包版关闭、开发态开启", () => {
    expect(devLabEnabled(true)).toBe(false);
    expect(devLabEnabled(false)).toBe(true);
  });
});
