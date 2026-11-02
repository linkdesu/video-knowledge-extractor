import { describe, expect, test } from "bun:test";
import type { DiarizationSegment } from "@video-notes/core";
import { assembleLines } from "./lines";
import type { LabTextRow } from "./lines";

function assemble(segments: DiarizationSegment[], texts: LabTextRow[], silences: { start: number; end: number }[] = []) {
  return assembleLines({ labels: segments.map((s) => s.speaker), segments, texts, silences });
}

describe("assembleLines 文本归属（#97）", () => {
  test("真重复：一段文本同时落在两行的时间范围里，只进重叠最多的一行", () => {
    // 访客 3s 整段落在主播 8s 话轮内：旧版把两段文本都拼进两行，同一句话出现两次。
    const segments: DiarizationSegment[] = [
      { start: 0, end: 8, speaker: 0 },
      { start: 2, end: 5, speaker: 1 },
    ];
    const texts: LabTextRow[] = [
      { start: 0.2, end: 7.8, text: "主播讲国富论" },
      { start: 2, end: 5, text: "可以看到" },
    ];
    const { lines } = assemble(segments, texts);
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.text.includes("可以看到"))).toHaveLength(1);
    expect(lines.filter((line) => line.text.includes("主播讲国富论"))).toHaveLength(1);
  });

  test("等长重叠按说话人归属：重叠一样多时，文本回它自己的说话人那行（声音证据）", () => {
    const segments: DiarizationSegment[] = [
      { start: 0, end: 8, speaker: 0 },
      { start: 2, end: 5, speaker: 1 },
    ];
    const texts: LabTextRow[] = [
      { start: 0.2, end: 7.8, text: "主播讲国富论" },
      { start: 2, end: 5, text: "可以看到" },
    ];
    const { lines } = assemble(segments, texts);
    expect(lines.find((line) => line.text.includes("主播讲国富论"))?.text).toBe("主播讲国富论");
    expect(lines.find((line) => line.text.includes("可以看到"))?.text).toBe("可以看到");
  });

  test("长段被静音切开时，横跨切口的那段文本只留一次", () => {
    const segments: DiarizationSegment[] = [
      { start: 0, end: 25, speaker: 0 },
      { start: 25.5, end: 40, speaker: 0 },
    ];
    const texts: LabTextRow[] = [
      { start: 0, end: 20.5, text: "前半段话" },
      { start: 20.5, end: 39.5, text: "后半段话" },
    ];
    const { lines } = assemble(segments, texts, [{ start: 19.5, end: 20.5 }]);
    expect(lines.map((line) => line.text)).toEqual(["前半段话", "后半段话"]);
  });

  test("文字相近但内容不同：两行各留各的文本，不因文字相似被判成重复", () => {
    const segments: DiarizationSegment[] = [
      { start: 0, end: 6, speaker: 0 },
      { start: 6, end: 12, speaker: 1 },
    ];
    const texts: LabTextRow[] = [
      { start: 0.5, end: 5.5, text: "今天讲国富论" },
      { start: 6.5, end: 11.5, text: "今天讲国富论的核心" },
    ];
    const { lines } = assemble(segments, texts);
    expect(lines.map((line) => line.text)).toEqual(["今天讲国富论", "今天讲国富论的核心"]);
  });

  test("文字完全相同但时间不重叠：两行都保留（时间证据说明是两次发言）", () => {
    const segments: DiarizationSegment[] = [
      { start: 0, end: 3, speaker: 0 },
      { start: 4.5, end: 7.5, speaker: 0 },
    ];
    const texts: LabTextRow[] = [
      { start: 0.1, end: 2.9, text: "对。" },
      { start: 4.6, end: 7.4, text: "对。" },
    ];
    const { lines } = assemble(segments, texts);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.text === "对。")).toBe(true);
  });

  test("部分重叠归重叠更多的一行，不按文字相似判重", () => {
    const segments: DiarizationSegment[] = [
      { start: 0, end: 8, speaker: 0 },
      { start: 7, end: 15, speaker: 1 },
    ];
    const texts: LabTextRow[] = [
      { start: 0.5, end: 7.5, text: "甲的行" },
      { start: 7.5, end: 14.5, text: "乙的行" },
    ];
    const { lines } = assemble(segments, texts);
    expect(lines.map((line) => line.text)).toEqual(["甲的行", "乙的行"]);
  });

  test("空文本行仍丢弃，说话人统计跟随可见行", () => {
    const segments: DiarizationSegment[] = [
      { start: 0, end: 6, speaker: 0 },
      { start: 7, end: 13, speaker: 1 },
    ];
    const texts: LabTextRow[] = [
      { start: 0.5, end: 5.5, text: "有字" },
      { start: 7.5, end: 12.5, text: "   " },
    ];
    const { lines, speakers } = assemble(segments, texts);
    expect(lines).toHaveLength(1);
    expect(speakers.find((s) => s.id === "speaker-1")?.lines).toBe(1);
  });
});
