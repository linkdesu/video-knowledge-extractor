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
  test("短插话并入持话轮的一方：不单独成行，文本也不复制进那一行", () => {
    const { lines } = assembleLines({
      labels: [0, 1],
      segments: [seg(10, 14, 0), seg(11, 11.3, 1)],
      texts: [
        { start: 10, end: 14, text: "主播讲完了一整句" },
        { start: 11, end: 11.3, text: "嗯" },
      ],
      silences: [],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]?.text).toBe("主播讲完了一整句");
    expect(lines[0]?.start).toBe(10);
    expect(lines[0]?.end).toBe(14);
  });
});
