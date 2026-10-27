import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertVersionBumped,
  assertWorkspaceVersionsMatch,
  compareSemver,
  parseSemver,
} from "./release-version";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("release-version", () => {
  test("parseSemver 解析合法 X.Y.Z 并拒绝非法格式", () => {
    expect(parseSemver("0.1.1")).toEqual([0, 1, 1]);
    expect(parseSemver("1.12.30")).toEqual([1, 12, 30]);
    expect(() => parseSemver("0.1")).toThrow("非法版本号");
    expect(() => parseSemver("v0.1.1")).toThrow("非法版本号");
  });

  test("compareSemver 按主/次/修订号依序比较", () => {
    expect(compareSemver("0.1.1", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("0.1.1", "0.1.1")).toBe(0);
  });

  test("assertWorkspaceVersionsMatch 要求所有包版本一致", () => {
    expect(
      assertWorkspaceVersionsMatch({
        "package.json": "0.1.1",
        "apps/desktop/package.json": "0.1.1",
      }),
    ).toBe("0.1.1");
    expect(() =>
      assertWorkspaceVersionsMatch({
        "package.json": "0.1.1",
        "apps/desktop/package.json": "0.1.0",
      }),
    ).toThrow("工作区 package.json 版本号不一致");
  });

  test("assertVersionBumped 要求新版本严格大于旧版本", () => {
    expect(() => assertVersionBumped("0.1.0", "0.1.1")).not.toThrow();
    expect(() => assertVersionBumped("0.1.1", "0.1.1")).toThrow("版本号未递增");
    expect(() => assertVersionBumped("0.1.2", "0.1.1")).toThrow("版本号未递增");
  });

  test("当前仓库四个 package.json 版本号完全一致", () => {
    const files = [
      "package.json",
      "apps/desktop/package.json",
      "apps/cli/package.json",
      "packages/core/package.json",
    ];
    const map: Record<string, string> = {};
    for (const rel of files) {
      const pkg = JSON.parse(readFileSync(resolve(repoRoot, rel), "utf8")) as { version: string };
      map[rel] = pkg.version;
    }
    const ver = assertWorkspaceVersionsMatch(map);
    expect(compareSemver(ver, "0.1.1")).toBeGreaterThanOrEqual(0);
  });
});
