import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findSecretFiles, isInside, isSecretFile, winPathInside } from "./secrets-gate";

describe("isSecretFile", () => {
  test("认得出密钥库、凭据事务残留与旧格式备份", () => {
    expect(isSecretFile("secrets.bin")).toBe(true);
    expect(isSecretFile("secrets.pending")).toBe(true);
    expect(isSecretFile("secrets.bin.legacy-1750000000")).toBe(true);
    expect(isSecretFile("secrets.bin.tmp-1234-5678")).toBe(true);
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

  test("借目录符号链接指回证据树的 userData 也算在内", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-link-"));
    try {
      const evidence = join(root, "tmp/verify");
      mkdirSync(join(evidence, "probe"), { recursive: true });
      // 证据树之外的入口，链接指回证据树内部
      const shortcut = join(root, "shortcut");
      symlinkSync(join(evidence, "probe"), shortcut);

      expect(isInside(evidence, join(shortcut, "user-data"))).toBe(true);
      // 不存在的尾巴也要能判（--user-data 常常还不存在）
      expect(isInside(evidence, join(shortcut, "user-data", "deeper"))).toBe(true);
      expect(isInside(evidence, join(root, "elsewhere", "user-data"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("winPathInside", () => {
  const runs = "D:\\code\\video-notes\\verify";

  test("标准子路径、根自身、盘符与大小写都算在内", () => {
    expect(winPathInside(runs, "D:\\code\\video-notes\\verify\\probe\\user-data")).toBe(true);
    expect(winPathInside(runs, "D:\\code\\video-notes\\verify\\")).toBe(true);
    expect(winPathInside(runs, "d:\\CODE\\video-notes\\Verify\\probe")).toBe(true);
  });

  test("正斜杠与 `..` 不能绕过", () => {
    expect(winPathInside(runs, "D:/code/video-notes/verify/probe/user-data")).toBe(true);
    expect(winPathInside(runs, "D:\\code\\video-notes\\verify-state\\..\\verify\\probe\\user-data")).toBe(true);
  });

  test("兄弟目录与父目录不算", () => {
    expect(winPathInside(runs, "D:\\code\\video-notes\\verify-state\\r50\\user-data")).toBe(false);
    expect(winPathInside(runs, "D:\\code\\video-notes")).toBe(false);
    expect(winPathInside(runs, "D:\\code\\video-notes\\verify-other\\x")).toBe(false);
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
      // 断言相对路径段而不是分隔符：CI 在 Windows 上跑同一份测试
      const found = findSecretFiles(root).map((path) => relative(root, path));
      expect(found.sort()).toEqual([join("r47-final", "user-data", "secrets.bin"), join("r48", "win", "user-data", "secrets.pending")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("指向密钥的符号链接本身算命中", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-link-file-"));
    try {
      const outside = join(root, "real-secrets.bin");
      writeFileSync(outside, "{}");
      const evidence = join(root, "verify");
      mkdirSync(join(evidence, "r49"), { recursive: true });
      symlinkSync(outside, join(evidence, "r49", "secrets.bin"));

      expect(findSecretFiles(evidence).map((path) => relative(evidence, path))).toEqual([join("r49", "secrets.bin")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("目录符号链接继续下钻，且成环不死循环", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-link-dir-"));
    try {
      const evidence = join(root, "verify");
      const elsewhere = join(root, "elsewhere");
      mkdirSync(join(elsewhere, "user-data"), { recursive: true });
      writeFileSync(join(elsewhere, "user-data", "secrets.bin"), "{}");
      mkdirSync(join(evidence, "r49"), { recursive: true });
      symlinkSync(elsewhere, join(evidence, "r49", "profile"));
      symlinkSync(evidence, join(evidence, "r49", "loop"));

      const found = findSecretFiles(evidence).map((path) => relative(evidence, path));
      expect(found).toEqual([join("r49", "profile", "user-data", "secrets.bin")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("断链的密钥链接仍算命中，不存在的根返回空数组", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-broken-"));
    try {
      symlinkSync(join(root, "gone"), join(root, "secrets.bin"));
      expect(findSecretFiles(root).map((path) => relative(root, path))).toEqual(["secrets.bin"]);
      expect(findSecretFiles(join(tmpdir(), "secrets-gate-does-not-exist-12345"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
