/**
 * 缓存键：步骤名 + 真实输入指纹，落盘为文件（ADR-0006）。
 *
 * | 步骤               | 必含输入                                                        |
 * | ------------------ | --------------------------------------------------------------- |
 * | transcribe         | 分块音频哈希、识别/分离/标点模型、单段上限                       |
 * | topic-candidates   | 分块纠错后字幕键、块提示词文本哈希、合并提示词文本哈希、端点模型名 |
 * | note               | 主题（标题/摘要/时间段）、该主题的纠错后字幕、系统提示词文本哈希、端点模型名、词表内容 |
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CacheStep = "transcribe" | "topic-candidates" | "note";

declare const cacheBrand: unique symbol;

/** 只能由 `cacheKey()` 生产，避免把任意字符串当键用。 */
export type CacheKey = {
  readonly step: CacheStep;
  readonly hash: string;
  readonly [cacheBrand]: true;
};

export type CacheInputs = Record<string, string | number | boolean>;

export function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value, stableKeys));
}

function stableKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
  return sorted;
}

export function cacheKey(step: CacheStep, inputs: CacheInputs): CacheKey {
  const canonical = Object.keys(inputs)
    .sort()
    .map((k) => [k, inputs[k]]);
  return { step, hash: sha256(JSON.stringify([step, canonical])) } as CacheKey;
}

/** 缓存文件路径：`<cacheDir>/<step>/<hash>.json`。 */
export function cachePath(cacheDir: string, key: CacheKey): string {
  return `${cacheDir}/${key.step}/${key.hash}.json`;
}

export function readCache<T>(cacheDir: string, key: CacheKey): T | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(cacheDir, key), "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** 先写临时文件再 rename，缓存文件不会半截落盘（ADR-0002）。 */
export function writeCache(cacheDir: string, key: CacheKey, value: unknown): void {
  const path = cachePath(cacheDir, key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

/** 删掉 note 缓存里本次没用到的条目；note 目录不存在返回空数组。 */
export function sweepNoteCache(cacheDir: string, keep: ReadonlySet<string>): string[] {
  const dir = `${cacheDir}/note`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    // 崩溃残留 `<hash>.json.<pid>.tmp`：writeCache 写临时文件后未 rename，没有复算价值，直接回收
    if (entry.endsWith(".tmp")) {
      if (entry.includes(".json.")) {
        try {
          unlinkSync(`${dir}/${entry}`);
          removed.push(entry);
        } catch {
          // 删不掉留到下次
        }
      }
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    const hash = entry.slice(0, -".json".length);
    if (keep.has(hash)) continue;
    try {
      unlinkSync(`${dir}/${entry}`);
      removed.push(entry);
    } catch {
      // 删不掉留到下次
    }
  }
  return removed;
}
