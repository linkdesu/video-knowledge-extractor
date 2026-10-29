import { describe, expect, test } from "bun:test";
import { buildRows, filterRows, formatTime, labLineKey, parseJump, rowIndexAt, searchRows, summarize } from "./lab-view";
import type { LabConfig, LabConfigName, LabLine } from "./lab";

function config(name: LabConfigName, speakers: string[], lines: LabLine[], hostClusters: number | null = null): LabConfig {
  return {
    name,
    meta: { speakers: speakers.length, k: speakers.length, picked: "sil", silhouette: 0.4, bicK: 3, seeds: 40, hostClusters },
    speakers: speakers.map((id) => ({ id, seconds: 10, lines: 1, sampleStarts: [lines[0]?.start ?? 0] })),
    lines,
  };
}

const A = config("baseline", ["speaker-1", "speaker-2"], [
  { start: 0, end: 4, speakerId: "speaker-1", text: "第一段" },
  { start: 4, end: 4.6, speakerId: "speaker-2", text: "嗯" },
  { start: 4.6, end: 14, speakerId: "speaker-1", text: "第三段" },
], 2);

const B = config("refine_filter", ["speaker-1"], [
  { start: 0, end: 4, speakerId: "speaker-1", text: "第一段" },
  { start: 4, end: 4.6, speakerId: "speaker-1", text: "嗯" },
  { start: 4.6, end: 14, speakerId: "speaker-1", text: "第三段" },
], 1);

describe("Lab 视图计算", () => {
  test("A/B 对齐取重叠最多的说话人", () => {
    const rows = buildRows(A, B, 1, {});
    expect(rows.map((r) => r.aSpeakerId)).toEqual(["speaker-1", "speaker-2", "speaker-1"]);
    expect(rows.map((r) => r.diff)).toEqual([false, true, false]);
  });

  test("差异行含「一侧被过滤」：refine_filter 下短语气行标差异", () => {
    const rows = buildRows(A, B, 1, {});
    expect(rows[1]?.filler).toBe(true);
    const wide = buildRows(A, B, 0.5, {});
    expect(wide[1]?.filler).toBe(false);
  });

  test("跨方案编号重排不算差异，合并/错分才算", () => {
    const a = config("baseline", ["speaker-1", "speaker-2"], [
      { start: 0, end: 4, speakerId: "speaker-1", text: "一" },
      { start: 4, end: 9, speakerId: "speaker-2", text: "二" },
    ]);
    const renamed = config("refine", ["speaker-9", "speaker-8"], [
      { start: 0, end: 4, speakerId: "speaker-9", text: "一" },
      { start: 4, end: 9, speakerId: "speaker-8", text: "二" },
    ]);
    expect(buildRows(a, renamed, 1).filter((r) => r.diff)).toHaveLength(0);

    const merged = config("refine", ["speaker-9"], [
      { start: 0, end: 4, speakerId: "speaker-9", text: "一" },
      { start: 4, end: 9, speakerId: "speaker-9", text: "二" },
    ]);
    expect(buildRows(a, merged, 1).filter((r) => r.diff)).toHaveLength(1);
  });

  test("阈值只影响过滤结果，摘要随之变化", () => {
    const at1 = summarize(A, B, 1);
    const at05 = summarize(A, B, 0.5);
    expect(at1.filteredLines).toBe(1);
    expect(at1.filteredSeconds).toBe(0.6);
    expect(at05.filteredLines).toBe(0);
    expect(at1.diffLines).toBe(1);
    expect(at1.hostA).toBe(2);
    expect(at1.hostB).toBe(1);
  });

  test("筛选与搜索", () => {
    const rows = buildRows(A, B, 1, {});
    expect(filterRows(rows, "diff", null)).toHaveLength(1);
    expect(filterRows(rows, "filtered", null)).toHaveLength(1);
    expect(filterRows(rows, "speaker", "speaker-1")).toHaveLength(3);
    expect(searchRows(rows, "第三")).toHaveLength(1);
    expect(searchRows(rows, "SPEAKER-1")).toHaveLength(3);
  });

  test("跳转：时间或行号，落在间隙取其后一行", () => {
    const rows = buildRows(A, B, 1, {});
    expect(parseJump("1", rows)).toBe(0);
    expect(parseJump("3", rows)).toBe(2);
    expect(parseJump("0", rows)).toBeNull();
    expect(parseJump("00:09", rows)).toBe(2);
    expect(parseJump("13:14", rows)).toBe(2);
    expect(parseJump("abc", rows)).toBeNull();
    expect(rowIndexAt(rows, 5)).toBe(2);
    expect(rowIndexAt(rows, -2)).toBe(0);
  });

  test("标记按行起点毫秒对齐", () => {
    const rows = buildRows(A, B, 1, { [labLineKey({ start: 4.6 })]: "B" });
    expect(rows[2]?.mark).toBe("B");
    expect(rows[0]?.mark).toBeNull();
  });

  test("时间格式", () => {
    expect(formatTime(5)).toBe("00:05");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});
