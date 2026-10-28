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
  test("浮层 288px、留白 320 通过（高度 + 32，高于下限）", () => {
    expect(jobPaddingProblems({ hasJob: true, contentPaddingBottom: 320, bannerHeight: 288 })).toEqual([]);
  });

  test("浮层收起 138px、矮窗口降到下限 240 通过", () => {
    expect(jobPaddingProblems({ hasJob: true, contentPaddingBottom: 240, bannerHeight: 138 })).toEqual([]);
  });

  test("浮层比留白还高时失败（480px 浮层 vs 固定 360px 留白）", () => {
    const problems = jobPaddingProblems({ hasJob: true, contentPaddingBottom: 360, bannerHeight: 480 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("512");
    expect(problems[0]).toContain("480");
  });

  test("留白低于 240 下限失败", () => {
    const problems = jobPaddingProblems({ hasJob: true, contentPaddingBottom: 40, bannerHeight: 138 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("240");
  });

  test("2px 容差内通过", () => {
    expect(jobPaddingProblems({ hasJob: true, contentPaddingBottom: 318, bannerHeight: 288 })).toEqual([]);
  });

  test("浮层节点缺失时失败", () => {
    const problems = jobPaddingProblems({ hasJob: true, contentPaddingBottom: 360, bannerHeight: -1 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not found");
  });

  test("无 job 且留白 40 通过", () => {
    expect(jobPaddingProblems({ hasJob: false, contentPaddingBottom: 40, bannerHeight: -1 })).toEqual([]);
  });
});
