import { describe, expect, test } from "bun:test";
import { assembleLines } from "./lines";

const seg = (start: number, end: number, speaker: number) => ({ start, end, speaker });

describe("assembleLines 文本归属", () => {
  test("重叠的两个 span 各拿自己的文本，不互相复制", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(0, 5, 0), seg(4, 9, 1)],
      texts: [
        { start: 0, end: 5, text: "甲的整句" },
        { start: 4, end: 9, text: "乙的整句" },
      ],
      silences: [],
    });
    expect(lines.map((l) => l.text)).toEqual(["甲的整句", "乙的整句"]);
  });

  test("一段文本只算给重叠最多的行，另一行不重复", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(0, 5, 0), seg(4, 9, 1)],
      texts: [{ start: 0, end: 4.2, text: "甲的短句" }],
      silences: [],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]?.text).toBe("甲的短句");
  });

  test("两行重叠等量时归起点更贴近文本行的那一行", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(0, 4, 0), seg(2, 6, 1)],
      texts: [{ start: 2, end: 4, text: "两秒" }],
      silences: [],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]?.text).toBe("两秒");
    expect(lines[0]?.start).toBe(2);
  });
});

describe("assembleLines 抢话归属", () => {
  test("短插话不并进长句、文本不复制：插话单独成行，长句边界不变（#114）", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(10, 14, 0), seg(11, 11.3, 1)],
      texts: [
        { start: 10, end: 14, text: "主播讲完了一整句" },
        { start: 11, end: 11.3, text: "嗯" },
      ],
      silences: [],
    });
    expect(lines.map((l) => [l.start, l.end, l.text])).toEqual([
      [10, 14, "主播讲完了一整句"],
      [11, 11.3, "嗯"],
    ]);
  });

  test("有内容的短插话同样单独成行，归属与说话人判断都不受影响（#114）", () => {
    const { lines, speakers } = assembleLines({
      labels: [0, 1],
      segments: [seg(10, 14, 0), seg(11, 11.3, 1)],
      texts: [
        { start: 10, end: 14, text: "主播讲完了一整句" },
        { start: 11, end: 11.3, text: "放大" },
      ],
      silences: [],
    });
    expect(lines.map((l) => [l.start, l.end, l.text])).toEqual([
      [10, 14, "主播讲完了一整句"],
      [11, 11.3, "放大"],
    ]);
    // 0.3s 的插话说话人不成说话人：插话行归持话轮的一方。
    expect(speakers.length).toBe(1);
    expect(lines[1]?.speakerId).toBe(lines[0]?.speakerId);
  });
});

describe("assembleLines 重叠段去重（#97）", () => {
  test("时间重叠 ≥50% 且短句文字被长句包住：只留长句", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(0, 10, 0), seg(4, 6, 1)],
      texts: [
        { start: 0, end: 10, text: "今天我们聊聊怎么整理素材。" },
        { start: 4, end: 6, text: "怎么整理素材。" },
      ],
      silences: [],
    });
    expect(lines.map((l) => l.text)).toEqual(["今天我们聊聊怎么整理素材。"]);
    expect(lines.map((l) => l.start)).toEqual([0]);
  });

  test("时间重叠但两句文字不同：两行都保留", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(0, 10, 0), seg(4, 6, 1)],
      texts: [
        { start: 0, end: 10, text: "今天我们聊聊怎么整理素材。" },
        { start: 4, end: 6, text: "我不同意这个说法。" },
      ],
      silences: [],
    });
    expect(lines.map((l) => l.text)).toEqual(["今天我们聊聊怎么整理素材。", "我不同意这个说法。"]);
  });

  test("文字相同但时间重叠不足 50%：两行都保留", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(0, 10, 0), seg(9.5, 11.5, 1)],
      texts: [
        { start: 0, end: 10, text: "今天我们聊聊怎么整理素材。" },
        { start: 9.5, end: 11.5, text: "怎么整理素材。" },
      ],
      silences: [],
    });
    expect(lines.map((l) => l.text)).toEqual(["今天我们聊聊怎么整理素材。", "怎么整理素材。"]);
  });
});
