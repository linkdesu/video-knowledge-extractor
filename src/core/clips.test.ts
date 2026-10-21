import { describe, expect, test } from "bun:test";
import { clipFileName, planClips } from "./clips";
import type { Segment } from "./types";

describe("planClips", () => {
  test("起点前移 3 秒并钳到 0", () => {
    const clips = planClips([{ start: 2, end: 10 }]);
    expect(clips).toEqual([{ start: 0, end: 10 }]);
  });

  test("前移后重叠的时间段合成一个切片", () => {
    const clips = planClips([{ start: 100, end: 120 }, { start: 118, end: 140 }]);
    expect(clips).toEqual([{ start: 97, end: 140 }]);
  });

  test("前移后相接（边界相接）的时间段合成一个切片", () => {
    const clips = planClips([{ start: 100, end: 120 }, { start: 123, end: 140 }]);
    expect(clips).toEqual([{ start: 97, end: 140 }]);
  });

  test("不相交的时间段各自保留，并按起点排序", () => {
    const clips = planClips(
      [
        { start: 300, end: 310 },
        { start: 100, end: 120 },
        { start: 200, end: 210 },
      ],
      3,
    );
    expect(clips).toEqual([
      { start: 97, end: 120 },
      { start: 197, end: 210 },
      { start: 297, end: 310 },
    ]);
  });

  test("preRoll 为 0 时不前移", () => {
    const clips = planClips([{ start: 5, end: 8 }], 0);
    expect(clips).toEqual([{ start: 5, end: 8 }]);
  });
});

describe("clipFileName", () => {
  test("1 起始序号补零 2 位，起止按 HH-MM-SS 渲染", () => {
    expect(clipFileName({ start: 750, end: 1080 }, 1)).toBe("01-00-12-30-00-18-00.mp4");
  });

  test("秒数向下取整，序号两位数", () => {
    expect(clipFileName({ start: 3661.9, end: 3662.9 }, 12)).toBe("12-01-01-01-01-01-02.mp4");
  });

  test("起点钳到 0 的切片从 00-00-00 开始", () => {
    expect(clipFileName({ start: 0, end: 90 }, 2)).toBe("02-00-00-00-00-01-30.mp4");
  });
});
