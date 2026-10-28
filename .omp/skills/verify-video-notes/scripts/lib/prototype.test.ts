import { describe, expect, test } from "bun:test";
import { countOpenQuestions, listed, parseRound, renderCard } from "./prototype";

describe("parseRound", () => {
  test('"2" → 2', () => {
    expect(parseRound("2")).toBe(2);
  });
  test('"0" 抛错', () => {
    expect(() => parseRound("0")).toThrow();
  });
  test('"x" 抛错', () => {
    expect(() => parseRound("x")).toThrow();
  });
});

describe("listed", () => {
  test("逗号分隔 trim", () => {
    expect(listed("a, b ,c")).toEqual(["a", "b", "c"]);
  });
  test("undefined / 空串 → []", () => {
    expect(listed(undefined)).toEqual([]);
    expect(listed("")).toEqual([]);
  });
});

describe("countOpenQuestions", () => {
  test("- None → 0", () => {
    expect(countOpenQuestions("## Open Questions (待决分歧)\n\n- None\n")).toBe(0);
  });
  test("两条 bullet → 2", () => {
    expect(countOpenQuestions("## Open Questions (待决分歧)\n\n- 编辑权限怎么表达？\n- 手机优先还是桌面优先？\n")).toBe(2);
  });
  test("- 无 → 0", () => {
    expect(countOpenQuestions("## Open Questions (待决分歧)\n\n- 无\n")).toBe(0);
  });
  test("缺节 → 抛错", () => {
    expect(() => countOpenQuestions("# card\n")).toThrow();
  });
});

describe("renderCard", () => {
  const header = ["# Round 1 — Decision Card (video-notes)", "", "- run: `r1`", "- round: 1", "- updated: 2026-10-29T00:00:00Z", "- PRODUCT.md: created this round", ""];
  const card =
    "# Round 1 — Decision Card (video-notes)\n\n## Confirmed (本轮确认)\n\n- 旧确认项\n\n## Rejected (本轮否决)\n\n- None\n\n## Open Questions (待决分歧)\n\n- 编辑权限怎么表达？\n- 手机优先还是桌面优先？\n\n## Key Selectors (data-testid)\n\n- 已有选择器\n\n## Notes (自定义小节)\n\n- 保留我\n";

  test("新增 confirmed 追加、重复项不重复", () => {
    const out = renderCard(card, header, { confirmed: ["新确认项", "新确认项"], rejected: [], open: [] }, false);
    const matches = out.split("\n").filter((l) => l.trim() === "- 新确认项");
    expect(matches).toHaveLength(1);
    expect(out).toContain("- 旧确认项");
  });

  test("clearOpen 把待决项重置为 - None", () => {
    const out = renderCard(card, header, { confirmed: [], rejected: [], open: ["不该出现"] }, true);
    const openLines = out.split("\n").filter((l) => l.trim().startsWith("- ") && l.trim() !== "- None");
    // 待决项全部消失，只剩占位符；未决 bullet 不再保留
    expect(openLines.map((l) => l.trim())).toEqual(expect.arrayContaining(["- 保留我", "- 已有选择器", "- 旧确认项"]));
    expect(out).not.toContain("- 编辑权限怎么表达？");
    expect(out).not.toContain("- 手机优先还是桌面优先？");
    expect(out).not.toContain("- 不该出现");
    const section = out.split("## Open Questions (待决分歧)")[1]!.split("##")[0];
    expect(section).toContain("- None");
  });

  test("保留未知小节", () => {
    const out = renderCard(card, header, { confirmed: [], rejected: [], open: [] }, false);
    expect(out).toContain("## Notes (自定义小节)");
    expect(out).toContain("- 保留我");
  });
});
