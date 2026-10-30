import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { labCacheModeArg, resolveLabCache, sharedLabCacheRoot } from "./cache-mode";

function sandbox(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "vn-lab-mode-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Lab 缓存模式解析", () => {
  test("默认 shared；两种参数写法都认；参数优先于环境变量", () => {
    const box = sandbox();
    try {
      const env = { VNOTE_LAB_CACHE_DIR: join(box.root, "shared") };
      const base = resolveLabCache({ argv: ["electron", "apps/desktop"], env });
      expect(base.mode).toBe("shared");
      expect(base.reads).toBe(true);
      expect(base.root).toBe(join(box.root, "shared"));

      expect(resolveLabCache({ argv: ["--lab-cache=cold"], env }).mode).toBe("cold");
      expect(resolveLabCache({ argv: ["--lab-cache", "cold"], env }).mode).toBe("cold");
      expect(labCacheModeArg(["--lab-cache"])).toBe("");
      expect(resolveLabCache({ argv: ["--lab-cache=isolated"], env: { ...env, VNOTE_LAB_CACHE: "cold" } }).mode).toBe("isolated");
      expect(resolveLabCache({ argv: [], env: { ...env, VNOTE_LAB_CACHE: "cold" } }).mode).toBe("cold");
    } finally {
      box.cleanup();
    }
  });

  test("未知模式与缺值直接抛错，不静默回退共享缓存", () => {
    const box = sandbox();
    try {
      const env = { VNOTE_LAB_CACHE_DIR: join(box.root, "shared") };
      expect(() => resolveLabCache({ argv: ["--lab-cache=share"], env })).toThrow(/shared \/ isolated \/ cold/);
      expect(() => resolveLabCache({ argv: ["--lab-cache"], env })).toThrow(/缺值/);
      expect(() => resolveLabCache({ argv: [], env: { ...env, VNOTE_LAB_CACHE: "Cold" } })).toThrow(/Cold/);
    } finally {
      box.cleanup();
    }
  });

  test("cold 写回共享目录但不读；shared 读写共享目录", () => {
    const box = sandbox();
    try {
      const shared = join(box.root, "shared");
      const sharedRoot = sharedLabCacheRoot({ VNOTE_LAB_CACHE_DIR: shared });
      expect(sharedRoot).toBe(shared);
      mkdirSync(join(shared, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), { recursive: true });
      writeFileSync(join(shared, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sample.json"), "{}");

      const sharedPlan = resolveLabCache({ argv: [], env: { VNOTE_LAB_CACHE_DIR: shared } });
      expect(sharedPlan).toMatchObject({ mode: "shared", root: shared, sharedRoot: shared, reads: true });

      const cold = resolveLabCache({ argv: ["--lab-cache=cold"], env: { VNOTE_LAB_CACHE_DIR: shared } });
      expect(cold).toMatchObject({ mode: "cold", root: shared, sharedRoot: shared, reads: false });
    } finally {
      box.cleanup();
    }
  });

  test("isolated 每次都是新的空目录，且不暴露共享条目", () => {
    const box = sandbox();
    try {
      const shared = join(box.root, "shared");
      mkdirSync(join(shared, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), { recursive: true });
      const env = { VNOTE_LAB_CACHE_DIR: shared };
      const first = resolveLabCache({ argv: ["--lab-cache=isolated"], env });
      const second = resolveLabCache({ argv: ["--lab-cache=isolated"], env });
      try {
        expect(first.mode).toBe("isolated");
        expect(first.sharedRoot).toBeNull();
        expect(first.root).not.toBe(second.root);
        expect(readdirSync(first.root)).toEqual([]);
        expect(readdirSync(second.root)).toEqual([]);
        expect(first.root.startsWith(tmpdir())).toBe(true);
        // 共享目录没被 isolated 写脏
        expect(readdirSync(shared)).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
      } finally {
        rmSync(first.root, { recursive: true, force: true });
        rmSync(second.root, { recursive: true, force: true });
      }
    } finally {
      box.cleanup();
    }
  });

  test("共享根随 XDG_CACHE_HOME / HOME 变化", () => {
    // 期望值用 join/resolve 拼：Windows 上路径分隔符不同，写死 POSIX 字符串会在 CI 上挂。
    expect(sharedLabCacheRoot({ HOME: "/home/link" })).toBe(join("/home/link", ".cache", "video-notes", "lab-cache"));
    expect(sharedLabCacheRoot({ HOME: "/home/link", XDG_CACHE_HOME: "/cache" })).toBe(join("/cache", "video-notes", "lab-cache"));
    expect(sharedLabCacheRoot({ HOME: "/home/link", VNOTE_LAB_CACHE_DIR: "/explicit/lab" })).toBe(resolve("/explicit/lab"));
  });
});
