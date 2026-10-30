import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAB_CACHE_LIMITS,
  evictLabCache,
  labCacheLimits,
  planLabEviction,
  removeDuplicateSources,
  type LabCacheLimits,
} from "./cache-maintenance";

const DAY = 24 * 60 * 60 * 1000;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vn-lab-evict-"));
}

/**
 * 造一个条目：`<root>/<key>/sample.json` + 一个指定大小的 payload.bin。
 * createdAt 由 sample.json 决定（与真实条目一致），mtime 由 utimes 兜底路径使用。
 */
function writeEntry(root: string, key: string, input: { createdAt: string; bytes: number; sourceHash?: string }): void {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sample.json"),
    JSON.stringify({
      version: 1,
      id: key,
      name: key,
      sourcePath: `/tmp/${key}.m4a`,
      duration: 1,
      createdAt: input.createdAt,
      mode: "computed",
      timings: {},
      segments: 0,
      anchors: null,
      anchorsFile: "",
      labelsFile: "",
      ...(input.sourceHash === undefined ? {} : { analysis: { key, schema: 1, sourceHash: input.sourceHash, params: {} } }),
    }),
  );
  writeFileSync(join(dir, "payload.bin"), Buffer.alloc(input.bytes));
}

function ids(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name !== ".tmp")
    .sort();
}

const NOW = Date.parse("2026-10-31T00:00:00.000Z");

function limits(patch: Partial<LabCacheLimits>): LabCacheLimits {
  return { ...LAB_CACHE_LIMITS, maxEntries: 0, maxBytes: 0, maxAgeMs: 0, ...patch };
}

describe("Lab 缓存上限配置", () => {
  test("没有环境变量时用默认值", () => {
    expect(labCacheLimits({})).toEqual(LAB_CACHE_LIMITS);
  });

  test("环境变量覆盖条数 / 字节 / 天数", () => {
    const parsed = labCacheLimits({
      VNOTE_LAB_CACHE_MAX_ENTRIES: "12",
      VNOTE_LAB_CACHE_MAX_BYTES: "1024",
      VNOTE_LAB_CACHE_MAX_AGE_DAYS: "7",
    });
    expect(parsed).toEqual({ maxEntries: 12, maxBytes: 1024, maxAgeMs: 7 * DAY });
  });

  test("0 表示该项不限制", () => {
    expect(labCacheLimits({ VNOTE_LAB_CACHE_MAX_ENTRIES: "0" }).maxEntries).toBe(0);
  });

  test("非法取值直接抛错，不静默回退默认值", () => {
    expect(() => labCacheLimits({ VNOTE_LAB_CACHE_MAX_ENTRIES: "-1" })).toThrow(/VNOTE_LAB_CACHE_MAX_ENTRIES/);
    expect(() => labCacheLimits({ VNOTE_LAB_CACHE_MAX_BYTES: "1.5" })).toThrow(/VNOTE_LAB_CACHE_MAX_BYTES/);
    expect(() => labCacheLimits({ VNOTE_LAB_CACHE_MAX_AGE_DAYS: "many" })).toThrow(/VNOTE_LAB_CACHE_MAX_AGE_DAYS/);
  });
});

describe("Lab 缓存淘汰计划", () => {
  test("超过条数上限时淘汰最旧的条目，保留最新的 N 条", () => {
    const root = tempRoot();
    writeEntry(root, "aaa1", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "bbb2", { createdAt: "2026-10-20T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "ccc3", { createdAt: "2026-10-25T00:00:00.000Z", bytes: 10 });
    const plan = planLabEviction(root, limits({ maxEntries: 2 }), NOW);
    expect(plan.evict.map((e) => e.id)).toEqual(["aaa1"]);
    expect(plan.evict[0]?.reason).toBe("count");
    expect(plan.kept).toBe(2);
  });

  test("超过字节上限时按最旧优先淘汰，直到总量回到上限内", () => {
    const root = tempRoot();
    writeEntry(root, "aaa1", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 400 });
    writeEntry(root, "bbb2", { createdAt: "2026-10-10T00:00:00.000Z", bytes: 400 });
    writeEntry(root, "ccc3", { createdAt: "2026-10-20T00:00:00.000Z", bytes: 400 });
    // 每个条目 ≈ 400 字节 payload + sample.json；1000 字节只够留最新的一份。
    const plan = planLabEviction(root, limits({ maxBytes: 1000 }), NOW);
    expect(plan.evict.map((e) => e.id)).toEqual(["bbb2", "aaa1"]);
    expect(plan.evict.every((e) => e.reason === "bytes")).toBe(true);
    expect(plan.kept).toBe(1);
    expect(plan.keptBytes).toBeLessThanOrEqual(1000);
  });

  test("超过存活时间的条目先按时间淘汰，即使总量没超", () => {
    const root = tempRoot();
    writeEntry(root, "old1", { createdAt: "2026-08-01T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10 });
    const plan = planLabEviction(root, limits({ maxAgeMs: 30 * DAY }), NOW);
    expect(plan.evict.map((e) => e.id)).toEqual(["old1"]);
    expect(plan.evict[0]?.reason).toBe("age");
  });

  test("protect 里的条目（刚发布的键）永不淘汰", () => {
    const root = tempRoot();
    writeEntry(root, "keep", { createdAt: "2026-01-01T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "drop", { createdAt: "2026-02-01T00:00:00.000Z", bytes: 10 });
    const plan = planLabEviction(root, limits({ maxEntries: 1 }), NOW, ["keep"]);
    expect(plan.evict.map((e) => e.id)).toEqual(["drop"]);
  });

  test("`.tmp`、非条目目录与 marks 文件都不参与淘汰", () => {
    const root = tempRoot();
    writeEntry(root, "aaa1", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 10 });
    mkdirSync(join(root, ".tmp", "aaa1-xyz"), { recursive: true });
    writeFileSync(join(root, ".tmp", "aaa1-xyz", "payload.bin"), Buffer.alloc(4096));
    mkdirSync(join(root, "not-an-entry"));
    writeFileSync(join(root, "marks-aaa1.json"), "{}");
    const plan = planLabEviction(root, limits({ maxEntries: 1 }), NOW);
    expect(plan.evict).toEqual([]);
    // 统计只覆盖条目：.tmp 里那 4096 字节不算进总量。
    expect(plan.totalBytes).toBeLessThan(4096);
    expect(plan.kept).toBe(1);
  });

  test("上限全为 0 时一个都不淘汰", () => {
    const root = tempRoot();
    writeEntry(root, "aaa1", { createdAt: "2020-01-01T00:00:00.000Z", bytes: 10 });
    const plan = planLabEviction(root, limits({}), NOW);
    expect(plan.evict).toEqual([]);
    expect(plan.kept).toBe(1);
  });

  test("没有 createdAt 的旧条目按目录 mtime 计算年龄", () => {
    const root = tempRoot();
    const dir = join(root, "legacy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "payload.bin"), Buffer.alloc(4));
    const old = (NOW - 60 * DAY) / 1000;
    utimesSync(dir, old, old);
    const plan = planLabEviction(root, limits({ maxAgeMs: 30 * DAY }), NOW);
    expect(plan.evict.map((e) => e.id)).toEqual(["legacy"]);
  });
});

describe("Lab 缓存淘汰执行", () => {
  test("真的删掉被淘汰的目录与它的 marks，保留其余目录与 marks", () => {
    const root = tempRoot();
    writeEntry(root, "aaa1", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "bbb2", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10 });
    writeFileSync(join(root, "marks-aaa1.json"), JSON.stringify({ "1000": "B" }));
    writeFileSync(join(root, "marks-bbb2.json"), JSON.stringify({ "2000": "A" }));
    const result = evictLabCache(root, limits({ maxEntries: 1 }), NOW);
    expect(result.evict.map((e) => e.id)).toEqual(["aaa1"]);
    expect(result.failed).toEqual([]);
    expect(result.marks).toBe(1);
    expect(ids(root)).toEqual(["bbb2", "marks-bbb2.json"]);
  });

  test("淘汰后不留孤儿 marks：每个 marks-*.json 仍指向存在的条目", () => {
    const root = tempRoot();
    writeEntry(root, "old1", { createdAt: "2026-08-01T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10 });
    writeFileSync(join(root, "marks-old1.json"), JSON.stringify({ "1000": "both" }));
    writeFileSync(join(root, "marks-new2.json"), JSON.stringify({ "2000": "A" }));
    // 非条目文件不参与淘汰，也不该被顺手删掉。
    writeFileSync(join(root, "notes.txt"), "keep");
    const result = evictLabCache(root, limits({ maxAgeMs: 30 * DAY }), NOW);
    expect(result.evict.map((e) => e.id)).toEqual(["old1"]);
    expect(ids(root)).toEqual(["marks-new2.json", "new2", "notes.txt"]);
  });

  test("没有任何需要淘汰的条目时不碰磁盘", () => {
    const root = tempRoot();
    writeEntry(root, "aaa1", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10 });
    writeFileSync(join(root, "marks-aaa1.json"), "{}");
    const result = evictLabCache(root, limits({ maxEntries: 10 }), NOW);
    expect(result.evict).toEqual([]);
    expect(result.marks).toBe(0);
    expect(existsSync(join(root, "aaa1"))).toBe(true);
    expect(existsSync(join(root, "marks-aaa1.json"))).toBe(true);
  });
});

describe("相同内容指纹只存一份", () => {
  test("删掉同 sourceHash 的旧键条目，保留刚发布的键", () => {
    const root = tempRoot();
    writeEntry(root, "old1", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 10, sourceHash: "hash-a" });
    writeEntry(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10, sourceHash: "hash-a" });
    writeEntry(root, "other", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10, sourceHash: "hash-b" });
    const removed = removeDuplicateSources(root, "hash-a", "new2");
    expect(removed).toEqual(["old1"]);
    expect(ids(root)).toEqual(["new2", "other"]);
  });

  test("没有 analysis 戳的旧条目不动（无法判定内容指纹）", () => {
    const root = tempRoot();
    writeEntry(root, "legacy", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 10 });
    writeEntry(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10, sourceHash: "hash-a" });
    expect(removeDuplicateSources(root, "hash-a", "new2")).toEqual([]);
    expect(ids(root)).toEqual(["legacy", "new2"]);
  });

  test("删掉的旧键条目的 marks 一起删，保留键与其它条目的 marks 不动", () => {
    const root = tempRoot();
    writeEntry(root, "old1", { createdAt: "2026-10-01T00:00:00.000Z", bytes: 10, sourceHash: "hash-a" });
    writeEntry(root, "new2", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10, sourceHash: "hash-a" });
    writeEntry(root, "other", { createdAt: "2026-10-30T00:00:00.000Z", bytes: 10, sourceHash: "hash-b" });
    writeFileSync(join(root, "marks-old1.json"), JSON.stringify({ "1000": "A" }));
    writeFileSync(join(root, "marks-new2.json"), JSON.stringify({ "2000": "B" }));
    writeFileSync(join(root, "marks-other.json"), JSON.stringify({ "3000": "both" }));
    expect(removeDuplicateSources(root, "hash-a", "new2")).toEqual(["old1"]);
    expect(ids(root)).toEqual(["marks-new2.json", "marks-other.json", "new2", "other"]);
  });
});
