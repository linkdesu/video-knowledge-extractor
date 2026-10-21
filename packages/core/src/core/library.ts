import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { notesRoot } from "./config";
import { parseClipFileName } from "./clips";
import { readVideoIndex } from "./paths";
import { isSafeDirName } from "./outputs";
import type { CorrectionFileEntry } from "./corrections-io";
import type { VideoId } from "./types";

export type LibraryClip = { file: string; start: number; end: number };
export type LibraryTopic = { dirName: string; title: string; markdown: string; clips: LibraryClip[] };
export type LibraryVideo = {
  id: VideoId;
  title: string;
  outputDir: string;
  sourcePath?: string;
  topicCount: number;
  clipCount: number;
  updatedAt: string | null;
};
export type LibraryDetail = {
  video: LibraryVideo;
  indexMarkdown: string;
  topics: LibraryTopic[];
  corrections: CorrectionFileEntry[];
};

type Entry = { id: string; title: string; outputDir: string; sourcePath?: string };

function mtimeMs(path: string): number | undefined {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function readMarkdown(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 主题目录的 mp4 切片：非法命名的文件跳过，不阻断列表。 */
function listTopicClips(topicDir: string): LibraryClip[] {
  let names: string[];
  try {
    names = readdirSync(topicDir);
  } catch {
    return [];
  }
  const clips: LibraryClip[] = [];
  for (const name of names) {
    const parsed = parseClipFileName(name);
    if (parsed === undefined) continue;
    const full = resolve(topicDir, name);
    if (lstatSync(full).isFile()) clips.push({ file: name, start: parsed.start, end: parsed.end });
  }
  return clips;
}

/** `topic.md` 第一个 `# ` 标题；没有就用目录名。 */
function topicTitle(markdown: string, dirName: string): string {
  const line = markdown.split("\n").find((l) => l.startsWith("# "));
  return line !== undefined ? line.slice(2).trim() : dirName;
}

function dirIsDirectChild(root: string, dirName: string): boolean {
  if (!isSafeDirName(dirName)) return false;
  const rel = relative(root, resolve(root, dirName));
  return rel !== "" && !rel.startsWith("..") && !rel.includes("/");
}

function videoSummary(root: string, entry: Entry): LibraryVideo {
  const outputDir = resolve(root, entry.outputDir);
  let topicCount = 0;
  let clipCount = 0;
  let latest = mtimeMs(resolve(outputDir, "index.md"));
  let names: string[] = [];
  try {
    names = readdirSync(outputDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    names = [];
  }
  for (const name of names) {
    const md = readMarkdown(resolve(outputDir, name, "topic.md"));
    if (md === undefined) continue;
    topicCount += 1;
    clipCount += listTopicClips(resolve(outputDir, name)).length;
    const t = mtimeMs(resolve(outputDir, name, "topic.md"));
    if (t !== undefined && (latest === undefined || t > latest)) latest = t;
  }
  return {
    id: entry.id as VideoId,
    title: entry.title,
    outputDir,
    ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
    topicCount,
    clipCount,
    updatedAt: latest === undefined ? null : new Date(latest).toISOString(),
  };
}

export function listLibrary(root: string = notesRoot()): LibraryVideo[] {
  const index = readVideoIndex(root);
  const out: LibraryVideo[] = [];
  for (const entry of index.videos) {
    out.push(videoSummary(root, entry));
  }
  return out;
}

export function readLibraryVideo(root: string, id: string): LibraryDetail | undefined {
  const index = readVideoIndex(root);
  const entry = index.videos.find((v) => v.id === id);
  if (entry === undefined || typeof entry.outputDir !== "string") return undefined;
  if (!dirIsDirectChild(root, entry.outputDir)) return undefined;
  const outputDir = resolve(root, entry.outputDir);
  let names: string[] = [];
  try {
    names = readdirSync(outputDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    names = [];
  }
  const topics: LibraryTopic[] = [];
  for (const name of names) {
    const mdPath = resolve(outputDir, name, "topic.md");
    const markdown = readMarkdown(mdPath);
    if (markdown === undefined) continue;
    topics.push({ dirName: name, title: topicTitle(markdown, name), markdown, clips: listTopicClips(resolve(outputDir, name)) });
  }
  topics.sort((a, b) => a.dirName.localeCompare(b.dirName));
  let corrections: CorrectionFileEntry[] = [];
  const raw = readJsonFileShallow(resolve(outputDir, "corrections.json"));
  if (Array.isArray(raw)) {
    corrections = raw.filter(isCorrectionEntry);
  }
  return { video: videoSummary(root, entry), indexMarkdown: readMarkdown(resolve(outputDir, "index.md")) ?? "", topics, corrections };
}

function readJsonFileShallow(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** 展示读取只收形状正确的条目，坏数据留给 `parseCorrections` 在保存时报错。 */
function isCorrectionEntry(e: unknown): e is CorrectionFileEntry {
  if (typeof e !== "object" || e === null) return false;
  const row = e as Record<string, unknown>;
  return typeof row.wrong === "string" && typeof row.right === "string";
}
