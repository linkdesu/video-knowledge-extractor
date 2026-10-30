import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSecretFiles, isInside, isSecretFile } from "./secrets-gate";

describe("isSecretFile", () => {
  test("认得出密钥库、凭据事务残留与旧格式备份", () => {
    expect(isSecretFile("secrets.bin")).toBe(true);
    expect(isSecretFile("secrets.pending")).toBe(true);
    expect(isSecretFile("secrets.bin.legacy-1750000000")).toBe(true);
  });

  test("不误伤设置与产物", () => {
    expect(isSecretFile("settings.json")).toBe(false);
    expect(isSecretFile("secrets.json")).toBe(false);
    expect(isSecretFile("secrets")).toBe(false);
    expect(isSecretFile("status.json")).toBe(false);
  });
});

describe("isInside", () => {
  test("证据根自身与子路径都算在内", () => {
    expect(isInside("/repo/tmp/verify", "/repo/tmp/verify/r49/user-data")).toBe(true);
    expect(isInside("/repo/tmp/verify", "/repo/tmp/verify")).toBe(true);
  });

  test("兄弟目录与 `..` 逃逸都不算", () => {
    expect(isInside("/repo/tmp/verify", "/repo/tmp/verify-state/r49/user-data")).toBe(false);
    expect(isInside("/repo/tmp/verify", "/repo/tmp/verify/../verify-state/x")).toBe(false);
    expect(isInside("/repo/tmp/verify", "/repo/tmp")).toBe(false);
  });
});

describe("findSecretFiles", () => {
  test("递归找到嵌套的密钥文件，忽略普通产物", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-"));
    try {
      mkdirSync(join(root, "r47-final/user-data"), { recursive: true });
      mkdirSync(join(root, "r48/win/user-data"), { recursive: true });
      writeFileSync(join(root, "r47-final/user-data/secrets.bin"), "{}");
      writeFileSync(join(root, "r48/win/user-data/secrets.pending"), "{}");
      writeFileSync(join(root, "r48/win/user-data/settings.json"), "{}");
      writeFileSync(join(root, "r48/summary.json"), "{}");
      const found = findSecretFiles(root).map((path) => path.slice(root.length + 1)).sort();
      expect(found).toEqual(["r47-final/user-data/secrets.bin", "r48/win/user-data/secrets.pending"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("根目录不存在时返回空数组", () => {
    expect(findSecretFiles(join(tmpdir(), "secrets-gate-does-not-exist-12345"))).toEqual([]);
  });
});
