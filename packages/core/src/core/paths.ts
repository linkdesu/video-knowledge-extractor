import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Topic, TopicId, Video, VideoId, VideoIndex, VideoIndexEntry } from "./types";
import { sha256 } from "./cache";
import { CACHE_DIRNAME, notesRoot } from "./config";

const MAX_SLUG_CHARS = 60;

export function slugify(text: string, fallback = "untitled"): string {
  const slug = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, "");
  return slug === "" ? fallback : slug;
}

export function videoIdFor(sourcePath: string): VideoId {
  return sha256(resolve(sourcePath)).slice(0, 8) as VideoId;
}

export function videoDirName(sourcePath: string): string {
  const slug = slugify(basename(sourcePath, extname(sourcePath)), "video");
  return `${slug}-${videoIdFor(sourcePath)}`;
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** 覆盖整个文件：先写临时文件再 rename，磁盘上不留半截文件（ADR-0002）。 */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 与 `writeJsonAtomic` 相同的临时文件+rename 写法，原样写文本。 */
export function writeFileAtomic(path: string, text: string): void {
  writeAtomic(path, text);
}

export function readVideoIndex(root: string = notesRoot()): VideoIndex {
  const parsed = readJsonFile<VideoIndex>(resolve(root, "index.json"));
  if (parsed === undefined) return { videos: [] };
  if (!Array.isArray(parsed.videos)) throw new Error(`${root}/index.json: videos 不是数组`);
  return parsed;
}

export function writeVideoIndex(index: VideoIndex, root: string = notesRoot()): void {
  writeJsonAtomic(resolve(root, "index.json"), { videos: [...index.videos].sort((a, b) => a.id.localeCompare(b.id)) });
}

/** 日志目录：跟随 notes 根目录，落在 `<notesRoot>/logs`（ADR-0028，r35）。 */
export function logDirFor(root: string): string {
  return resolve(root, "logs");
}

// 启动时把旧隐藏目录 .logs 里的日志搬到 logs/；目标已存在同名文件则跳过，搬完删空目录
export function migrateLegacyLogDir(root: string): void {
  try {
    const legacy = resolve(root, ".logs");
    const target = resolve(root, "logs");
    if (!statSync(legacy).isDirectory()) return;
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(legacy)) {
      try {
        let targetHasIt = true;
        try {
          targetHasIt = statSync(join(target, name)).isFile();
        } catch {
          targetHasIt = false;
        }
        if (targetHasIt) continue;
        renameSync(join(legacy, name), join(target, name));
      } catch {
        // 单个文件失败不阻塞启动
      }
    }
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    // 旧目录不存在或不可读：直接跳过
  }
}

export function openVideo(sourcePath: string, durationSeconds: number, root: string = notesRoot()): Video {
  const resolved = resolve(sourcePath);
  const id = videoIdFor(resolved);
  const index = readVideoIndex(root);
  const existing = index.videos.find((v) => v.id === id);
  if (existing !== undefined) {
    if (existing.sourcePath !== resolved) {
      writeVideoIndex({ videos: index.videos.map((v) => (v.id === id ? { ...v, sourcePath: resolved } : v)) }, root);
    }
    return { id, title: existing.title, sourcePath: resolved, durationSeconds, outputDir: resolve(root, existing.outputDir) };
  }
  const title = basename(resolved, extname(resolved));
  const outputDir = videoDirName(resolved);
  mkdirSync(resolve(root, outputDir), { recursive: true });
  const entry: VideoIndexEntry = { id, title, outputDir, sourcePath: resolved };
  writeVideoIndex({ videos: [...index.videos, entry] }, root);
  return { id, title, sourcePath: resolved, durationSeconds, outputDir: resolve(root, outputDir) };
}

export function videoCacheDir(outputDir: string): string {
  return resolve(outputDir, CACHE_DIRNAME);
}

/** 新缓存位置 `<cacheRoot>/<videoId>/`（ADR-0014）。 */
export function cacheDirFor(cacheRoot: string, videoId: VideoId): string {
  return resolve(cacheRoot, videoId);
}

export function topicDirNames(topics: Pick<Topic, "id" | "title">[]): Map<TopicId, string> {
  const used = new Set<string>();
  const names = new Map<TopicId, string>();
  for (const topic of topics) {
    const base = slugify(topic.title, "topic");
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    names.set(topic.id, name);
  }
  return names;
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
