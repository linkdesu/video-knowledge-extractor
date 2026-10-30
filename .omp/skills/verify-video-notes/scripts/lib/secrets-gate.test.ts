import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  isInside,
  isSecretFile,
  parseRemoteSecretListing,
  scanSecretContent,
  scanSecretFiles,
  secretScanFailureMessage,
  winPathInside,
} from "./secrets-gate";

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

  test("状态根里的符号链接指向外部时，真实路径判定为越界（r60）", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-link-out-"));
    try {
      const stateRoot = join(root, "tmp/verify-state");
      mkdirSync(stateRoot, { recursive: true });
      const victim = join(root, "victim");
      mkdirSync(join(victim, "user-data"), { recursive: true });
      symlinkSync(victim, join(stateRoot, "r60"));

      expect(isInside(stateRoot, join(stateRoot, "r60", "user-data"))).toBe(false);
      expect(isInside(stateRoot, join(stateRoot, "r60"))).toBe(false);
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

describe("scanSecretFiles", () => {
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
      const found = scanSecretFiles(root).found.map((path) => relative(root, path));
      expect(found.sort()).toEqual([join("r47-final", "user-data", "secrets.bin"), join("r48", "win", "user-data", "secrets.pending")]);
      expect(scanSecretFiles(root).unreadable).toEqual([]);
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

      expect(scanSecretFiles(evidence).found.map((path) => relative(evidence, path))).toEqual([join("r49", "secrets.bin")]);
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

      const found = scanSecretFiles(evidence).found.map((path) => relative(evidence, path));
      expect(found).toEqual([join("r49", "profile", "user-data", "secrets.bin")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("断链的密钥链接仍算命中，不存在的根返回空数组", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-broken-"));
    try {
      symlinkSync(join(root, "gone"), join(root, "secrets.bin"));
      expect(scanSecretFiles(root).found.map((path) => relative(root, path))).toEqual(["secrets.bin"]);
      expect(scanSecretFiles(join(tmpdir(), "secrets-gate-does-not-exist-12345"))).toEqual({ found: [], unreadable: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // r60 漏洞 6：读不了的目录以前被静默跳过，于是门禁报告「干净」——一份读不到的密钥副本等于没查。
  test.skipIf(process.platform === "win32")("读不了的目录不会被当成干净：单独报成 unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-gate-unreadable-"));
    try {
      const locked = join(root, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "secrets.bin"), "{}");
      chmodSync(locked, 0o000);
      try {
        const scan = scanSecretFiles(root);
        expect(scan.found).toEqual([]);
        expect(scan.unreadable).toEqual([locked]);
      } finally {
        chmodSync(locked, 0o700);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scanSecretContent", () => {
  // r60 漏洞 2：改名/复制过的密钥文件骗得过文件名规则，内容仍然是密钥。
  test("改名后的密钥副本按内容命中", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-content-"));
    try {
      const needle = "sk-live-r60-sentinel-0123456789";
      mkdirSync(join(root, "r60/user-data"), { recursive: true });
      writeFileSync(join(root, "r60/user-data/backup.log"), `llm=${needle}\n`);
      writeFileSync(join(root, "r60/user-data/settings.json"), `{"llm":{"baseUrl":"https://x"}}\n`);
      const scan = scanSecretContent(root, [needle]);
      expect(scan.found.map((path) => relative(root, path))).toEqual([join("r60/user-data/backup.log")]);
      expect(scan.unreadable).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("没有 needle（没有私有配置）时不做内容判定，也不误报", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-content-empty-"));
    try {
      writeFileSync(join(root, "app.log"), "nothing secret here\n");
      expect(scanSecretContent(root, [])).toEqual({ found: [], unreadable: [] });
      // 空串 needle 会把每个文件都算命中，必须被忽略
      expect(scanSecretContent(root, [""])).toEqual({ found: [], unreadable: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("符号链接不跟随（不把证据树外的文件读成命中）", () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-content-link-"));
    try {
      const needle = "sk-live-r60-link-0123456789";
      const outside = join(root, "outside.log");
      writeFileSync(outside, needle);
      const evidence = join(root, "verify");
      mkdirSync(evidence, { recursive: true });
      symlinkSync(outside, join(evidence, "alias.log"));
      expect(scanSecretContent(evidence, [needle]).found).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("secretScanFailureMessage", () => {
  test("只报路径与数量，绝不回显密钥内容", () => {
    const needle = "sk-live-r60-must-not-print-987654";
    const message = secretScanFailureMessage("up", { found: ["tmp/verify/r60/x.log"], unreadable: ["tmp/verify/r60/locked"] });
    expect(message).toContain("tmp/verify/r60/x.log");
    expect(message).toContain("tmp/verify/r60/locked");
    expect(message).not.toContain(needle);
  });

  test("只有读不了的目录也要报失败", () => {
    const message = secretScanFailureMessage("up", { found: [], unreadable: ["tmp/verify/r60/locked"] });
    expect(message).toContain("读");
    expect(message).toContain("tmp/verify/r60/locked");
  });
});

describe("parseRemoteSecretListing", () => {
  // r60 漏洞 1：远端 verify 目录里的历史残留（pre-r50 的 user-data）从来没人查。
  test("从远端 Get-ChildItem 清单里挑出密钥文件，忽略普通证据", () => {
    const listing = [
      "12\tD:\\code\\video-notes\\verify\\r47\\user-data\\secrets.bin",
      "3\tD:\\code\\video-notes\\verify\\r48\\win\\topic.md",
      "44\tD:\\code\\video-notes\\verify\\r49\\home\\secrets.pending",
      "44\tD:\\code\\video-notes\\verify\\r49\\home\\settings.json",
      "",
    ].join("\r\n");
    expect(parseRemoteSecretListing(listing)).toEqual([
      "D:\\code\\video-notes\\verify\\r47\\user-data\\secrets.bin",
      "D:\\code\\video-notes\\verify\\r49\\home\\secrets.pending",
    ]);
  });

  test("空清单与坏行都不误报", () => {
    expect(parseRemoteSecretListing("")).toEqual([]);
    expect(parseRemoteSecretListing("\n\r\ngarbage\n")).toEqual([]);
  });
});
