import { describe, expect, test } from "bun:test";
import { jobPaddingProblems, viewportProblems } from "./layout";

describe("viewportProblems", () => {
  test("相等 / ±2px 内通过", () => {
    expect(viewportProblems({ innerHeight: 1000, shellHeight: 1000, asideHeight: 1000 })).toEqual([]);
    expect(viewportProblems({ innerHeight: 1000, shellHeight: 998, asideHeight: 1002 })).toEqual([]);
  });

  test("-188px 失败且消息含实测值", () => {
    const problems = viewportProblems({ innerHeight: 1000, shellHeight: 812, asideHeight: 1000 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(".vn-shell height 812 != innerHeight 1000 (Δ188)");
  });

  test("+3px 失败（超出 ±2px 容差）", () => {
    const problems = viewportProblems({ innerHeight: 1000, shellHeight: 1003, asideHeight: 1000 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(".vn-shell height 1003 != innerHeight 1000 (Δ3)");
  });

  test("元素缺失（-1）报告 not found", () => {
    const problems = viewportProblems({ innerHeight: 1000, shellHeight: -1, asideHeight: -1 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(".vn-shell not found");
  });
});

describe("jobPaddingProblems", () => {
  test("hasJob 且 360 通过", () => {
    expect(jobPaddingProblems({ hasJob: true, contentPaddingBottom: 360 })).toEqual([]);
  });

  test("hasJob 且 40 失败", () => {
    const problems = jobPaddingProblems({ hasJob: true, contentPaddingBottom: 40 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("40");
  });

  test("无 job 且 40 通过", () => {
    expect(jobPaddingProblems({ hasJob: false, contentPaddingBottom: 40 })).toEqual([]);
  });
});
