/**
 * Lab 缓存维护（r55）：容量/时间淘汰 + 相同内容指纹去重。
 *
 * 条目 = `<root>/<键>/`（含 audio.wav，几十 MB 起）。共享缓存被所有 worktree 共用，
 * 不设上限就会一直变大，所以启动时和每次发布后都按「条数 / 总字节 / 存活时间」淘汰旧条目。
 *
 * 三条不变量：
 * 1. 计划阶段不碰 `.tmp`、`marks-*.json` 与非条目文件（`.tmp` 的清理归 sweepTempEntries）；
 *    执行阶段删条目时连它的 `marks-<id>.json` 一起删（r57），不留孤儿文件。
 * 2. 刚发布的键（protect）永不淘汰 —— 否则自己算完立刻被自己删掉。
 * 3. 同一份内容（`analysis.sourceHash`）只留一份：发布后删掉旧键的重复条目；
 *    没有 `analysis` 戳的 r53 之前条目无法判定指纹，原样保留。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLabSampleId, marksPath } from "./sample-store";

const DAY_MS = 24 * 60 * 60 * 1000;

export type LabCacheLimits = {
  /** 最多保留的条目数；0 = 不限制。 */
  maxEntries: number;
  /** 所有条目总字节上限；0 = 不限制。 */
  maxBytes: number;
  /** 条目存活上限（毫秒，按 sample.json 的 createdAt）；0 = 不限制。 */
  maxAgeMs: number;
};

/** 默认上限：200 条 / 20 GiB / 30 天。够放几十个长样本，也不会把用户磁盘吃光。 */
export const LAB_CACHE_LIMITS: LabCacheLimits = {
  maxEntries: 200,
  maxBytes: 20 * 1024 * 1024 * 1024,
  maxAgeMs: 30 * DAY_MS,
};

const ENV_ENTRIES = "VNOTE_LAB_CACHE_MAX_ENTRIES";
const ENV_BYTES = "VNOTE_LAB_CACHE_MAX_BYTES";
const ENV_DAYS = "VNOTE_LAB_CACHE_MAX_AGE_DAYS";

/** 非负整数；缺省用默认值，`0` 表示该项不限制，其余非法取值直接抛错（不静默回退）。 */
function nonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} 只能是非负整数（收到：${raw}）`);
  return Number(raw.trim());
}

/** 环境变量覆盖上限：`VNOTE_LAB_CACHE_MAX_ENTRIES` / `_MAX_BYTES` / `_MAX_AGE_DAYS`。 */
export function labCacheLimits(env: Record<string, string | undefined>): LabCacheLimits {
  return {
    maxEntries: nonNegativeInt(env[ENV_ENTRIES], ENV_ENTRIES, LAB_CACHE_LIMITS.maxEntries),
    maxBytes: nonNegativeInt(env[ENV_BYTES], ENV_BYTES, LAB_CACHE_LIMITS.maxBytes),
    maxAgeMs: nonNegativeInt(env[ENV_DAYS], ENV_DAYS, LAB_CACHE_LIMITS.maxAgeMs / DAY_MS) * DAY_MS,
  };
}

export type LabEviction = { id: string; bytes: number; createdAt: number; reason: "age" | "count" | "bytes" };

export type LabEvictionPlan = {
  evict: LabEviction[];
  kept: number;
  keptBytes: number;
  totalBytes: number;
};

/** `marks` 是随淘汰一起删掉的 marks 文件数（r57：条目没了，标注就不可达）。 */
export type LabEvictionResult = LabEvictionPlan & { failed: string[]; marks: number };

/** 目录树总字节数；读不了的文件按 0 计（淘汰计划不该因为一个坏文件整轮失败）。 */
function dirBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try {
      total += entry.isDirectory() ? dirBytes(child) : statSync(child).size;
    } catch {
      // 读不到就当 0
    }
  }
  return total;
}

/** 条目年龄按 sample.json 的 createdAt；缺失或不可解析时退回目录 mtime。 */
function entryCreatedAt(dir: string, mtimeMs: number): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "sample.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && "createdAt" in parsed && typeof parsed.createdAt === "string") {
      const ms = Date.parse(parsed.createdAt);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // 没有 sample.json：退回 mtime
  }
  return mtimeMs;
}

type EntryStat = { id: string; bytes: number; createdAt: number };

/** 列出 root 下的条目（目录名满足样本 id 规则），按 createdAt 从新到旧。 */
function listEntryStats(root: string): EntryStat[] {
  if (!existsSync(root)) return [];
  const out: EntryStat[] = [];
  for (const name of readdirSync(root)) {
    if (!isLabSampleId(name)) continue;
    const dir = join(root, name);
    let mtimeMs: number;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    out.push({ id: name, bytes: dirBytes(dir), createdAt: entryCreatedAt(dir, mtimeMs) });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * 淘汰计划（只算不删）：先按存活时间淘汰，再按「条数 / 总字节」从最旧的开始淘汰。
 * `protect` 里的键（刚发布的键）先无条件计入已保留，再让其余条目竞争剩余额度 ——
 * 上限因此严格成立，且受保护的条目永远不会被自己这一轮删掉。
 */
export function planLabEviction(
  root: string,
  limits: LabCacheLimits,
  now: number,
  protect: readonly string[] = [],
): LabEvictionPlan {
  const entries = listEntryStats(root);
  const protectedIds = new Set(protect);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const evict: LabEviction[] = [];
  let kept = 0;
  let keptBytes = 0;
  for (const entry of entries) {
    if (!protectedIds.has(entry.id)) continue;
    kept++;
    keptBytes += entry.bytes;
  }
  for (const entry of entries) {
    if (protectedIds.has(entry.id)) continue;
    if (limits.maxAgeMs > 0 && now - entry.createdAt > limits.maxAgeMs) {
      evict.push({ ...entry, reason: "age" });
      continue;
    }
    const overCount = limits.maxEntries > 0 && kept >= limits.maxEntries;
    const overBytes = limits.maxBytes > 0 && keptBytes + entry.bytes > limits.maxBytes;
    if (overCount || overBytes) {
      evict.push({ ...entry, reason: overCount ? "count" : "bytes" });
      continue;
    }
    kept++;
    keptBytes += entry.bytes;
  }
  return { evict, kept, keptBytes, totalBytes };
}

/** 执行淘汰；删不掉的条目留在磁盘上、记进 `failed`，不能因为一次失败中断。 */
export function evictLabCache(
  root: string,
  limits: LabCacheLimits,
  now: number,
  protect: readonly string[] = [],
): LabEvictionResult {
  const plan = planLabEviction(root, limits, now, protect);
  const removed: LabEviction[] = [];
  const failed: string[] = [];
  let deadMarks = 0;
  for (const entry of plan.evict) {
    try {
      rmSync(join(root, entry.id), { recursive: true, force: true });
      // r57 / #74：条目删了，它的 `marks-<id>.json` 就是界面上永远读不到的孤儿文件，跟着删。
      const marks = marksPath(root, entry.id);
      if (existsSync(marks)) {
        rmSync(marks, { force: true });
        deadMarks++;
      }
      removed.push(entry);
    } catch {
      failed.push(entry.id);
    }
  }
  const removedBytes = removed.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    evict: removed,
    failed,
    marks: deadMarks,
    kept: plan.kept,
    keptBytes: plan.keptBytes,
    totalBytes: plan.totalBytes - removedBytes,
  };
}

/** 读一个条目的内容指纹；没有 `analysis` 戳（r53 之前）或读不了时返回 null。 */
function readSourceHash(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "sample.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("analysis" in parsed)) return null;
    const analysis = parsed.analysis;
    if (typeof analysis !== "object" || analysis === null || !("sourceHash" in analysis)) return null;
    return typeof analysis.sourceHash === "string" && analysis.sourceHash !== "" ? analysis.sourceHash : null;
  } catch {
    return null;
  }
}

/**
 * 同一份内容只留一份：删掉 `sourceHash` 相同、键不是 `keepKey` 的条目，返回删掉的 id。
 * 在发布成功后调用 —— 此刻 keepKey 已是完整条目，旧键（模型 mtime / schema 变了）只是重复存储。
 */
export function removeDuplicateSources(root: string, sourceHash: string, keepKey: string): string[] {
  if (sourceHash === "" || !existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name === keepKey || !isLabSampleId(name)) continue;
    if (readSourceHash(join(root, name)) !== sourceHash) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 删不掉留到下一轮
    }
  }
  return removed;
}
