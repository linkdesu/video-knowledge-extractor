import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import type { Topic, TopicId, Video, VideoId, VideoIndex, VideoIndexEntry } from "./types";
import { sha256 } from "./cache";
import { CACHE_DIRNAME, NOTES_ROOT } from "./config";

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

/** 覆盖整个文件：先写临时文件再 rename，磁盘上不留半截 JSON（ADR-0002）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readVideoIndex(root: string = NOTES_ROOT): VideoIndex {
  const parsed = readJsonFile<VideoIndex>(resolve(root, "index.json"));
  if (parsed === undefined) return { videos: [] };
  if (!Array.isArray(parsed.videos)) throw new Error(`${root}/index.json: videos 不是数组`);
  return parsed;
}

export function writeVideoIndex(index: VideoIndex, root: string = NOTES_ROOT): void {
  writeJsonAtomic(resolve(root, "index.json"), { videos: [...index.videos].sort((a, b) => a.id.localeCompare(b.id)) });
}

export function openVideo(sourcePath: string, durationSeconds: number, root: string = NOTES_ROOT): Video {
  const resolved = resolve(sourcePath);
  const id = videoIdFor(resolved);
  const index = readVideoIndex(root);
  const existing = index.videos.find((v) => v.id === id);
  if (existing !== undefined) {
    return { id, title: existing.title, sourcePath: resolved, durationSeconds, outputDir: resolve(root, existing.outputDir) };
  }
  const title = basename(resolved, extname(resolved));
  const outputDir = videoDirName(resolved);
  mkdirSync(resolve(root, outputDir), { recursive: true });
  const entry: VideoIndexEntry = { id, title, outputDir };
  writeVideoIndex({ videos: [...index.videos, entry] }, root);
  return { id, title, sourcePath: resolved, durationSeconds, outputDir: resolve(root, outputDir) };
}

export function videoCacheDir(outputDir: string): string {
  return resolve(outputDir, CACHE_DIRNAME);
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
