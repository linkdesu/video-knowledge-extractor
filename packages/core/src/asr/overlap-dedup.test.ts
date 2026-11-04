import { describe, expect, test } from "bun:test";
import { dedupeOverlappingLines } from "./overlap-dedup";

const row = (start: number, end: number, text: string) => ({ start, end, text });

describe("dedupeOverlappingLines", () => {
  test("重叠 ≥50% 且短句被长句包住：只留长句", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(4, 6, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。"]);
  });

  test("重叠正好 50% 也算重复（阈值是比例，不是绝对秒数）", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(9, 11, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。"]);
  });

  test("重叠不足 50%：文字被包住也两行都留", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(9.5, 11.5, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。", "怎么整理素材。"]);
  });

  test("时间重叠但文字不同：两行都留", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(4, 6, "我不同意这个说法。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。", "我不同意这个说法。"]);
  });

  test("文字只有一小段相同、够不上「基本包含」：两行都留", () => {
    // 短句 4 字里只有「整理素」3 字连续命中 = 0.75，够不上 0.8
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(4, 6, "整理素吧。")];
    expect(dedupeOverlappingLines(rows).length).toBe(2);
  });

  test("等长的两行不判长短，都留", () => {
    const rows = [row(0, 2, "好的好的。"), row(1, 3, "好的好的。")];
    expect(dedupeOverlappingLines(rows).length).toBe(2);
  });

  test("链式包含：最长的行留下，中间与最短的都被去掉", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材并补上时间戳。"), row(0, 5, "怎么整理素材并补上"), row(1, 3, "整理素材")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材并补上时间戳。"]);
  });

  test("输出保持输入顺序", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(20, 21, "另一句"), row(4, 6, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。", "另一句"]);
  });
});
