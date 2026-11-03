import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneStaleTestTmpDirs, testTmpRunDir, tmpRegistry } from "./temp-dirs-preload";
import { makeSuiteTmpDir, makeTmpDir } from "./temp-dirs";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

describe("测试进程 TMPDIR 隔离", () => {
  test("bun test 进程的 TMPDIR 指向仓库 tmp/test-<pid>", () => {
    expect(tmpdir()).toBe(testTmpRunDir(repoRoot));
    expect(tmpdir()).toEndWith(join("tmp", `test-${process.pid}`));
    expect(existsSync(tmpdir())).toBe(true);
  });
});

describe("makeTmpDir", () => {
  let previous: string | undefined;

  test("用例结束后删除本次创建的目录（下一条用例验证）", () => {
    const dir = makeTmpDir("r71-probe-");
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
    previous = dir;
  });

  test("上一条用例的目录已被 helper 删除", () => {
    expect(previous).toBeDefined();
    expect(existsSync(previous!)).toBe(false);
  });

  test("可以指定 base：用例级目录套在套件目录里", () => {
    const suiteDir = makeSuiteTmpDir("r71-suite-");
    const nested = makeTmpDir("r71-nested-", suiteDir);
    expect(nested.startsWith(suiteDir)).toBe(true);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(suiteDir)).toBe(true);
  });

  test("同前缀连续创建不会撞名", () => {
    const a = makeTmpDir("r71-same-");
    const b = makeTmpDir("r71-same-");
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});

describe("makeSuiteTmpDir", () => {
  let suite: string | undefined;

  test("套件目录在用例之间保留", () => {
    const dir = makeSuiteTmpDir("r71-alive-");
    suite = dir;
    expect(existsSync(dir)).toBe(true);
  });

  test("第二个用例仍能看到上一个用例建的套件目录", () => {
    expect(suite).toBeDefined();
    expect(existsSync(suite!)).toBe(true);
  });
});

describe("未安装 preload", () => {
  test("makeTmpDir 立刻报错，而不是静默写系统 $TMPDIR", () => {
    const registry = tmpRegistry();
    const saved = registry.runDir;
    registry.runDir = undefined;
    try {
      expect(() => makeTmpDir("r71-unisolated-")).toThrow(/未隔离/);
      expect(() => makeSuiteTmpDir("r71-unisolated-suite-")).toThrow(/未隔离/);
    } finally {
      registry.runDir = saved;
    }
  });
});

describe("pruneStaleTestTmpDirs", () => {
  test("删除死进程目录与超龄目录，保留活进程目录和其他条目", () => {
    const parent = makeSuiteTmpDir("r71-prune-");
    const deadPid = process.pid + 100_000;
    const livePid = process.pid + 100_001;
    const ancientPid = process.pid + 100_002;
    const dead = join(parent, `test-${deadPid}`);
    const live = join(parent, `test-${livePid}`);
    const ancient = join(parent, `test-${ancientPid}`);
    const foreign = join(parent, "keep-me");
    const nested = join(parent, "notes");
    for (const dir of [dead, live, ancient, foreign, nested]) mkdirSync(dir);

    // pid 被复用：进程还活着但目录超过年龄上限。
    const old = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(ancient, old, old);

    const removed = pruneStaleTestTmpDirs(parent, {
      isAlive: (pid: number) => pid === livePid || pid === ancientPid,
      maxAgeMs: 60 * 1000,
    });

    expect(removed.sort()).toEqual([ancient, dead].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  test("目录不存在时静默返回空", () => {
    expect(pruneStaleTestTmpDirs(join(tmpdir(), "r71-absent-parent"))).toEqual([]);
  });
});
