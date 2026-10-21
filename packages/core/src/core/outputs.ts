import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256, sweepNoteCache } from "./cache";
import { writeJsonAtomic } from "./paths";
export const OUTPUT_MANIFEST = ".vnote-manifest.json";

/** 一条所有权记录：本工具写过的主题目录名 + 写出时 topic.md 内容的 sha256（manifest v2）。 */
export type OutputManifestEntry = { name: string; topicMdHash: string };
export type OutputManifest = { topicDirs: OutputManifestEntry[] };

export function readManifest(outputDir: string): OutputManifest | undefined {
  const path = join(outputDir, OUTPUT_MANIFEST);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path}: 不是合法 JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path}: 不是对象`);
  const rawEntries = (parsed as Record<string, unknown>).topicDirs;
  if (!Array.isArray(rawEntries)) {
    throw new Error(`${path}: topicDirs 不是数组`);
  }
  for (const e of rawEntries) {
    const eObj = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : undefined;
    if (eObj === undefined || typeof eObj.name !== "string" || typeof eObj.topicMdHash !== "string") {
      throw new Error(`${path}: 条目不是 {name: string, topicMdHash: string}`);
    }
  }
  return { topicDirs: rawEntries as OutputManifestEntry[] };
}

/** 去重（同 name 取最后一条）并按 name 排序后原子写出。 */
export function writeManifest(outputDir: string, topicDirs: readonly OutputManifestEntry[]): void {
  const byName = new Map<string, string>();
  for (const e of topicDirs) byName.set(e.name, e.topicMdHash);
  const sorted = [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, topicMdHash]) => ({ name, topicMdHash }));
  writeJsonAtomic(join(outputDir, OUTPUT_MANIFEST), { topicDirs: sorted });
}

/** 目录名安全：非空、不含路径分隔符、不是 `.` 或 `..`。不安全的条目不参与候选与删除，也不抛错。 */
export function isSafeDirName(name: string): boolean {
  return name !== "" && !name.includes("/") && !name.includes("\\") && !name.includes("\0") && name !== "." && name !== "..";
}

/** 工具写出的切片文件名，如 `01-00-13-53-00-16-24.mp4`。 */
const SLICE_RE = /^\d{2}(-\d{2}){6}\.mp4$/;

/**
 * 纯工具目录：所有条目都是普通文件（用 lstat：符号链接与子目录一律 false），
 * 名字只能是 `topic.md`（必须存在）、`.DS_Store` 或切片命名 mp4，且至少一个切片 mp4。
 */
export function isToolTopicDir(outputDir: string, name: string): boolean {
  let dirStat;
  try {
    dirStat = lstatSync(join(outputDir, name));
  } catch {
    return false;
  }
  if (!dirStat.isDirectory()) return false;
  let entries: string[];
  try {
    entries = readdirSync(join(outputDir, name));
  } catch {
    return false;
  }
  let hasTopicMd = false;
  let hasSlice = false;
  for (const entry of entries) {
    let entryStat;
    try {
      entryStat = lstatSync(join(outputDir, name, entry));
    } catch {
      return false;
    }
    if (!entryStat.isFile()) return false;
    if (entry === "topic.md") {
      hasTopicMd = true;
    } else if (entry === ".DS_Store") {
      // 允许存在
    } else if (SLICE_RE.test(entry)) {
      hasSlice = true;
    } else {
      return false;
    }
  }
  return hasTopicMd && hasSlice;
}

export type SweepResult = { removed: string[]; kept: string[] };

/** 读目录里 topic.md 的 sha256；目录不存在、topic.md 不存在或不是普通文件时返回 undefined。 */
function topicMdHash(outputDir: string, name: string): string | undefined {
  try {
    const st = lstatSync(join(outputDir, name, "topic.md"));
    if (!st.isFile()) return undefined;
    return sha256(readFileSync(join(outputDir, name, "topic.md")));
  } catch {
    return undefined;
  }
}

export function sweepStaleTopicDirs(input: { outputDir: string; keep: readonly string[] }): SweepResult {
  const { outputDir, keep } = input;
  // 保留集与 manifest 记录按大小写忽略比较：大小写不敏感卷（macOS APFS 默认）上，
  // 用户把 foo 改名成 Foo 只是同一条目换了名字，本轮刚写出的目录不能因此被当旧目录删掉。
  const keepSet = new Set(keep.filter(isSafeDirName).map((n) => n.toLowerCase()));
  const removed: string[] = [];
  const kept: string[] = [];

  // manifest 之外再认指纹：上次写了主题目录但崩在 manifest 之前时，manifest 里没有这些目录
  const manifest = readManifest(outputDir);
  const manifestHash = new Map<string, string>(); // key 为 name.toLowerCase()
  if (manifest !== undefined) {
    for (const e of manifest.topicDirs) if (isSafeDirName(e.name)) manifestHash.set(e.name.toLowerCase(), e.topicMdHash);
  }
  // 候选用磁盘上真实的大小写形态（lstat/rm 都要按它解析）；大小写不敏感卷上用户改名
  // 成 Foo 后，manifest 里的 foo 对应的目录是 Foo，删掉的是 Foo 本身
  const candidates = new Set<string>();
  if (manifest !== undefined) {
    for (const e of manifest.topicDirs) if (isSafeDirName(e.name)) candidates.add(e.name);
  }
  let allEntries: string[];
  try {
    allEntries = readdirSync(outputDir);
  } catch {
    allEntries = [];
  }
  for (const name of allEntries) {
    if (isToolTopicDir(outputDir, name)) candidates.add(name);
  }

  for (const name of candidates) {
    if (keepSet.has(name.toLowerCase())) continue;
    let dirStat;
    try {
      dirStat = lstatSync(join(outputDir, name));
    } catch {
      // 不存在的候选忽略：上次运行可能已删，保证同一操作重复执行不再删东西
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    if (!isToolTopicDir(outputDir, name)) {
      // 用户放了文件，绝不删
      kept.push(name);
      continue;
    }
    const recorded = manifestHash.get(name.toLowerCase());
    if (recorded !== undefined) {
      const current = topicMdHash(outputDir, name);
      if (current === undefined || current !== recorded) {
        // 用户改过 topic.md（或读不到了）：指纹与记录不符，不授权删除
        kept.push(name);
        continue;
      }
    }
    // 无所有权记录（历史目录或崩溃残留）或指纹相符：按指纹删除
    try {
      rmSync(join(outputDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 删不掉的留在 kept，下次再试
      kept.push(name);
    }
  }

  // manifest 只写仍然存在的目录：
  // - keep 里的目录登记本轮 topic.md 的当前 hash（内容若被重新生成，旧 hash 不挡删除）
  // - kept 的目录沿用原记录：原本有记录的原样保留（topic.md 暂时读不到也不能丢记录，
  //   否则下一轮它变成「无记录」会被指纹删除，用户批注丢失）；原本没记录的写当前 hash，读不到则跳过
  const seen = new Set<string>();
  const entries: OutputManifestEntry[] = [];
  for (const name of [...keep, ...kept]) {
    if (!isSafeDirName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let isDir = false;
    try {
      isDir = lstatSync(join(outputDir, name)).isDirectory();
    } catch {
      // 目录已消失，不写进 manifest
    }
    if (!isDir) continue;
    const prior = manifestHash.get(key);
    const current = topicMdHash(outputDir, name);
    const chosen = keepSet.has(key) ? current : (prior ?? current);
    if (chosen === undefined) continue;
    entries.push({ name, topicMdHash: chosen });
  }
  try {
    writeManifest(outputDir, entries);
  } catch {
    // manifest 写失败只吞掉这一写，已经删掉的目录仍然通过 removed 返回
  }
  return { removed, kept };
}

/**
 * 完整运行末尾的清理：删不再引用的主题目录，再回收本次没用的笔记缓存。
 * 清理失败只回退清理本身，不抛出。
 */
export function cleanupStaleOutputs(input: {
  outputDir: string;
  keep: readonly string[];
  cacheDir: string;
  noteCacheKeys: Iterable<string>;
}): string[] {
  try {
    const { removed } = sweepStaleTopicDirs({ outputDir: input.outputDir, keep: input.keep });
    sweepNoteCache(input.cacheDir, new Set(input.noteCacheKeys));
    return removed;
  } catch (err) {
    console.warn(`清理旧主题失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
