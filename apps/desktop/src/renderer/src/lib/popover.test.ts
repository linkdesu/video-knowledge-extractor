import { describe, expect, test } from "bun:test";
import {
  POPOVER_GAP,
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  computePopoverPlacement,
  listHeightFor,
  popoverStyle,
} from "./popover";

const band = { top: 0, bottom: 900 };

describe("listHeightFor", () => {
  test("空列表只有内边距", () => {
    expect(listHeightFor(0)).toBe(10);
  });

  test("行高按 32px 累加", () => {
    expect(listHeightFor(3)).toBe(3 * 32 + 10);
  });

  test("超过上限封顶", () => {
    expect(listHeightFor(20)).toBe(POPOVER_MAX_HEIGHT);
  });
});

describe("computePopoverPlacement", () => {
  test("下方空间充足时向下展开，锚点左边与宽度即触发器", () => {
    const p = computePopoverPlacement({
      anchor: { left: 24, width: 360, top: 100, bottom: 132 },
      band,
      viewportHeight: 900,
      listHeight: 132,
    });
    expect(p).toEqual({ left: 24, width: 360, top: 132 + POPOVER_GAP, bottom: null, maxHeight: null, up: false });
  });

  test("下方不够且上方更宽裕时向上翻转，底边距视口下沿", () => {
    const p = computePopoverPlacement({
      anchor: { left: 24, width: 360, top: 300, bottom: 330 },
      band: { top: 0, bottom: 400 },
      viewportHeight: 400,
      listHeight: 132,
    });
    expect(p.up).toBe(true);
    expect(p.top).toBeNull();
    expect(p.bottom).toBe(400 - 300 + POPOVER_GAP);
    expect(p.maxHeight).toBeNull();
  });

  test("下方略小于列表高度但上方更小：不翻转，原地压缩", () => {
    const p = computePopoverPlacement({
      anchor: { left: 0, width: 200, top: 240, bottom: 272 },
      band: { top: 200, bottom: 340 },
      viewportHeight: 340,
      listHeight: 264,
    });
    // 下方 68 < 274，上方 40 < 68 → 仍在下方；可用空间 = 68 - 10 = 58，压到下限 72
    expect(p.up).toBe(false);
    expect(p.maxHeight).toBe(POPOVER_MIN_HEIGHT);
  });

  test("上下都放不下时压缩到下限，不返回小于 72 的高度", () => {
    const p = computePopoverPlacement({
      anchor: { left: 0, width: 200, top: 30, bottom: 50 },
      band: { top: 0, bottom: 60 },
      viewportHeight: 60,
      listHeight: 264,
    });
    expect(p.maxHeight).toBe(POPOVER_MIN_HEIGHT);
  });

  test("下方够放列表时不因上方更宽裕而翻转", () => {
    const p = computePopoverPlacement({
      anchor: { left: 0, width: 200, top: 600, bottom: 630 },
      band: { top: 0, bottom: 900 },
      viewportHeight: 900,
      listHeight: 132,
    });
    expect(p.up).toBe(false);
    expect(p.top).toBe(630 + POPOVER_GAP);
  });

  test("portal 内联样式只带确定的边", () => {
    const down = popoverStyle({
      left: 10,
      width: 100,
      top: 50,
      bottom: null,
      maxHeight: null,
      up: false,
    });
    expect(down).toEqual({ position: "fixed", left: 10, width: 100, top: 50 });

    const up = popoverStyle({
      left: 10,
      width: 100,
      top: null,
      bottom: 70,
      maxHeight: 120,
      up: true,
    });
    expect(up).toEqual({ position: "fixed", left: 10, width: 100, bottom: 70, maxHeight: 120 });
  });
});
