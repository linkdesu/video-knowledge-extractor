import { describe, expect, test } from "bun:test";
import { assignSpeakers, buildSpans, splitSpan } from "./utterances";
import type { UtteranceSpan } from "./utterances";

describe("buildSpans", () => {
  test("gap 0.5s（<= 0.6）同说话人合并成一段", () => {
    const spans = buildSpans([
      { start: 0, end: 5, speaker: 0 },
      { start: 5.5, end: 10, speaker: 0 },
    ]);
    expect(spans).toEqual([{ start: 0, end: 10, speaker: 0 }]);
  });

  test("gap 1s（> 0.6）不合并；合并后超过 20s 也不合并", () => {
    const gaps = buildSpans([
      { start: 0, end: 5, speaker: 0 },
      { start: 6, end: 10, speaker: 0 },
    ]);
    expect(gaps).toEqual([
      { start: 0, end: 5, speaker: 0 },
      { start: 6, end: 10, speaker: 0 },
    ]);
    const long = buildSpans([
      { start: 0, end: 10, speaker: 0 },
      { start: 10.5, end: 25, speaker: 0 },
    ]);
    expect(long).toEqual([
      { start: 0, end: 10, speaker: 0 },
      { start: 10.5, end: 25, speaker: 0 },
    ]);
  });

  test("不同说话人即使 gap 很小也不合并", () => {
    const spans = buildSpans([
      { start: 0, end: 5, speaker: 0 },
      { start: 5.1, end: 10, speaker: 1 },
    ]);
    expect(spans).toEqual([
      { start: 0, end: 5, speaker: 0 },
      { start: 5.1, end: 10, speaker: 1 },
    ]);
  });

  test("过短（<0.2s）片段丢弃；乱序输入按 start 排序", () => {
    const spans = buildSpans([
      { start: 10, end: 11, speaker: 1 },
      { start: 0, end: 5, speaker: 0 },
      { start: 5.2, end: 5.3, speaker: 0 },
    ]);
    expect(spans).toEqual([
      { start: 0, end: 5, speaker: 0 },
      { start: 10, end: 11, speaker: 1 },
    ]);
  });
});

describe("splitSpan", () => {
  test("不超过上限的段原样返回", () => {
    const span = { start: 0, end: 10, speaker: 0 };
    expect(splitSpan(span, [], 20)).toEqual([span]);
  });

  test("在 [start+max/2, start+max] 窗口内离 start+max 最近的停顿中点切，窗口外停顿不选", () => {
    const span = { start: 0, end: 35, speaker: 0 };
    const silences = [
      { start: 40, end: 42 }, // 中点 41 在窗口 [10, 20] 之外
      { start: 18, end: 19 }, // 中点 18.5 在窗口内，离目标 20 最近
    ];
    const pieces = splitSpan(span, silences, 20);
    expect(pieces).toEqual([
      { start: 0, end: 18.5, speaker: 0 },
      { start: 18.5, end: 35, speaker: 0 },
    ]);
  });

  test("窗口内无停顿中点则在 start+max 硬切", () => {
    const span = { start: 0, end: 40, speaker: 0 };
    const pieces = splitSpan(span, [{ start: 1, end: 2 }], 20);
    expect(pieces).toEqual([
      { start: 0, end: 20, speaker: 0 },
      { start: 20, end: 40, speaker: 0 },
    ]);
  });

  test("超长段切出的各段首尾相接、无缝隙、每段 > 0s，说话人不变", () => {
    const span = { start: 0, end: 65, speaker: 1 };
    const pieces = splitSpan(span, [], 20);
    expect(pieces.length).toBe(4);
    expect(pieces[0]?.start).toBe(0);
    expect(pieces[pieces.length - 1]?.end).toBe(65);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]?.start).toBe(pieces[i - 1]?.end);
      expect((pieces[i]?.end ?? 0) - (pieces[i]?.start ?? 0)).toBeGreaterThan(0);
      expect(pieces[i]?.speaker).toBe(1);
    }
  });
});

describe("assignSpeakers", () => {
  const span = (start: number, end: number, speaker: number): UtteranceSpan => ({ start, end, speaker });

  test("总时长 < 3s 的说话人归并到时间最近的相邻说话人", () => {
    // 说话人 1 只有 2s（10–12）；前邻 0（0–5）gap 5s，后邻 2（20–40）gap 8s，归并到前一个。
    const spans = [span(0, 5, 0), span(10, 12, 1), span(20, 40, 2)];
    const { speakers, utterances } = assignSpeakers(spans);
    expect(speakers.length).toBe(2);
    expect(utterances.length).toBe(3);
    // 20s 的说话人 2 排第一；被归并后 7s 的说话人 0 排第二。
    expect(speakers.map((s) => s.name)).toEqual(["说话人1", "说话人2"]);
    expect(utterances[0]?.speakerId as string).toBe("speaker-2");
    expect(utterances[1]?.speakerId as string).toBe("speaker-2");
    expect(utterances[2]?.speakerId as string).toBe("speaker-1");
  });

  test("按总时长降序重排编号，颜色取 6 色调色板", () => {
    const spans = [span(0, 10, 0), span(10, 20, 1), span(20, 35, 2), span(35, 55, 3)];
    const { speakers } = assignSpeakers(spans);
    expect(speakers.map((s) => s.name)).toEqual(["说话人1", "说话人2", "说话人3", "说话人4"]);
    expect(speakers.map((s) => s.id as string)).toEqual(["speaker-1", "speaker-2", "speaker-3", "speaker-4"]);
    for (const s of speakers) expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test("字幕行按 start 排序，text 为空串", () => {
    const spans = [span(20, 35, 2), span(0, 10, 0)];
    const { utterances } = assignSpeakers(spans);
    expect(utterances.map((u) => u.start)).toEqual([0, 20]);
    for (const u of utterances) {
      expect(u.text).toBe("");
      expect(u.end - u.start).toBeGreaterThan(0);
    }
  });
  test("全部说话人都短于 minSeconds 时只保留一个，每行都有该编号", () => {
    const spans = [span(0, 2, 0), span(5, 7, 1), span(10, 11.5, 2)];
    const { speakers, utterances } = assignSpeakers(spans);
    expect(speakers.length).toBe(1);
    expect(utterances.length).toBe(3);
    const keptId = speakers[0]?.id;
    expect(keptId as string | undefined).toBe("speaker-1");
    for (const u of utterances) {
      expect(u.speakerId as string | undefined).toBe("speaker-1");
    }
  });
});
