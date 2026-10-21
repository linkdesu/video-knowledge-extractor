import { describe, expect, test } from "bun:test";
import { planChunks } from "./audio";
import type { Silence } from "./audio";

// 90 分钟视频，每 30s 一个 0.5s 停顿：中点在 0.25、30.25、…、5399.75。
const regular: Silence[] = [];
for (let s = 0; s < 5400; s += 30) regular.push({ start: s, end: s + 0.5 });

describe("planChunks", () => {
  test("90 分钟、每 30s 一个停顿：7 块，每块（含末块）都在 [600, 900] 秒", () => {
    const chunks = planChunks(5400, regular);
    expect(chunks.length).toBe(7);
    // 每块在窗口 [t+600, t+900] 内取最接近 t+780 的停顿中点，故切点落在 780.25 的整数倍附近。
    const cuts = chunks.slice(1).map((c) => c.start);
    expect(cuts).toEqual([780.25, 1560.25, 2340.25, 3120.25, 3900.25, 4680.25]);
    expect(chunks.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 每一块（含末块）长度都在 [600, 900] 秒内。
    expect(chunks.map((c) => c.end - c.start)).toEqual([780.25, 780, 780, 780, 780, 780, 719.75]);
    // 每个切点都落在某个停顿区间内。
    for (const cut of cuts) expect(regular.some((s) => cut >= s.start && cut <= s.end)).toBe(true);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[6]?.end).toBe(5400);
    // 块首尾相接：无重叠、无缝隙。
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.start).toBe(chunks[i - 1]?.end);
  });

  test("40 分钟、唯一停顿在 1200–1201：在停顿处切，之后无停顿才回退到 15 分钟硬切", () => {
    const chunks = planChunks(2400, [{ start: 1200, end: 1201 }]);
    // 第一块跨过 15 分钟不硬切，等到 1200.5 的停顿；之后整段无停顿，只能按 900 秒回退，末块 299.5 秒。
    expect(chunks).toEqual([
      { index: 1, start: 0, end: 1200.5 },
      { index: 2, start: 1200.5, end: 2100.5 },
      { index: 3, start: 2100.5, end: 2400 },
    ]);
  });

  test("无停顿的 90 分钟：6 块各 900 秒，起点 0/900/…/4500", () => {
    const chunks = planChunks(5400, []);
    expect(chunks.length).toBe(6);
    expect(chunks.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunks.map((c) => c.end - c.start)).toEqual([900, 900, 900, 900, 900, 900]);
    expect(chunks.map((c) => c.start)).toEqual([0, 900, 1800, 2700, 3600, 4500]);
    expect(chunks.map((c) => c.end)).toEqual([900, 1800, 2700, 3600, 4500, 5400]);
  });

  test("5 分钟：1 块，不切", () => {
    const chunks = planChunks(300, []);
    expect(chunks).toEqual([{ index: 1, start: 0, end: 300 }]);
  });

  test("正好 10 分钟：1 块（到上限不切）", () => {
    const chunks = planChunks(600, []);
    expect(chunks).toEqual([{ index: 1, start: 0, end: 600 }]);
  });
});
