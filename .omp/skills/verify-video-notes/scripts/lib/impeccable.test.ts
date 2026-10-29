import { describe, expect, test } from "bun:test";
import { classifyFindings, dedupeFindings, parseFindings } from "./impeccable";

describe("parseFindings", () => {
  test("空串/空白 → []", () => {
    expect(parseFindings("")).toEqual([]);
    expect(parseFindings("  \n ")).toEqual([]);
  });

  test("非数组 → 抛错", () => {
    expect(() => parseFindings('{"a":1}')).toThrow("impeccable detect --json did not print a JSON array");
  });

  test("合法数组解析", () => {
    const out = parseFindings('[{"antipattern":"overused-font","severity":"error","file":"a.tsx","line":3}]');
    expect(out).toHaveLength(1);
    expect(out[0]!.antipattern).toBe("overused-font");
    expect(out[0]!.severity).toBe("error");
  });
});

describe("classifyFindings", () => {
  test("advisory 标记与 severity=advisory 归 advisory", () => {
    const { primary, advisory } = classifyFindings([
      { advisory: true },
      { severity: "advisory" },
      { severity: "error" },
      { severity: "warning" },
      { severity: "high" },
    ]);
    expect(advisory).toHaveLength(2);
    expect(primary).toHaveLength(3);
  });

  test("全部 advisory → primary 为 0", () => {
    const { primary, advisory } = classifyFindings([{ severity: "advisory" }, { advisory: true }]);
    expect(primary).toHaveLength(0);
    expect(advisory).toHaveLength(2);
  });

  test("空输入", () => {
    const { primary, advisory } = classifyFindings([]);
    expect(primary).toHaveLength(0);
    expect(advisory).toHaveLength(0);
  });
});

describe("dedupeFindings", () => {
  test("同 file+line+rule 去重、顺序保持", () => {
    const f = (n: string, line: number) => ({ antipattern: "overused-font", file: "a.tsx", line, severity: "error" });
    const out = dedupeFindings([f("1", 3), f("1", 3), f("2", 9), f("1", 3)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.line).toBe(3);
    expect(out[1]!.line).toBe(9);
  });

  test("不同字段不去重", () => {
    const a = { name: "x", file: "a.tsx", line: 1, severity: "error" };
    const b = { name: "x", file: "a.tsx", line: 2, severity: "error" };
    const c = { name: "y", file: "a.tsx", line: 1, severity: "error" };
    expect(dedupeFindings([a, b, c])).toHaveLength(3);
  });

  test("空输入 → []", () => {
    expect(dedupeFindings([])).toEqual([]);
  });
});
