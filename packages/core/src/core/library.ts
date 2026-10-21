import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { notesRoot } from "./config";
import { parseClipFileName } from "./clips";
import { readVideoIndex } from "./paths";
import { isSafeDirName } from "./outputs";
import type { CorrectionFileEntry } from "./corrections-io";
import type { VideoId } from "./types";
import { loadVideoData, readVideoData } from "./video-data";
import type { VideoData } from "./video-data";

/** 库卡片状态；规则见 ADR-0014 第 6 节。 */
export type LibraryVideoStatus = "done" | "in-progress" | "needs-rerun" | "failed";

export type LibraryVideo = {
  id: VideoId;
  title: string;
  outputDir: string;
  sourcePath?: string;
  durationSeconds: number | null;
  /** 首次生成的 ISO 时间；旧目录或未生成时为 null。 */
  importedAt: string | null;
  /** 源文件字节数；旧目录或未生成时为 null。 */
  sizeBytes: number | null;
  topicCount: number;
  clipCount: number;
  updatedAt: string | null;
  status: LibraryVideoStatus;
};

export type LibraryDetail = {
  video: LibraryVideo;
  data: VideoData;
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

/** 主题目录的 mp4 切片：非法命名的文件跳过，不阻断列表。 */
function listTopicClips(topicDir: string): { start: number; end: number }[] {
  let names: string[];
  try {
    names = readdirSync(topicDir);
  } catch {
    return [];
  }
  const clips: { start: number; end: number }[] = [];
  for (const name of names) {
    const parsed = parseClipFileName(name);
    if (parsed !== undefined) {
      const full = resolve(topicDir, name);
      if (lstatSync(full).isFile()) clips.push(parsed);
    }
  }
  return clips;
}

function dirIsDirectChild(root: string, dirName: string): boolean {
  if (!isSafeDirName(dirName)) return false;
  const rel = relative(root, resolve(root, dirName));
  return rel !== "" && !rel.startsWith("..") && !rel.includes("/");
}

function videoSummary(root: string, entry: Entry, propagateParseError: boolean): LibraryVideo {
  const outputDir = resolve(root, entry.outputDir);
  let data: VideoData | undefined;
  try {
    data = readVideoData(outputDir);
  } catch (err) {
    // 单个视频的 video.json 损坏不阻断列表：该卡按 failed、计数 0，标题/目录沿用 index.json
    if (propagateParseError) throw err;
    return {
      id: entry.id as VideoId,
      title: entry.title,
      outputDir,
      ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
      durationSeconds: null,
      importedAt: null,
      sizeBytes: null,
      topicCount: 0,
      clipCount: 0,
      updatedAt: null,
      status: "failed",
    };
  }
  if (data !== undefined) {
    return {
      id: entry.id as VideoId,
      title: entry.title,
      outputDir,
      ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
      durationSeconds: data.video.durationSeconds,
      importedAt: data.importedAt,
      sizeBytes: data.sourceBytes,
      topicCount: data.topics.length,
      clipCount: data.topics.reduce((n, t) => n + t.clips.length, 0),
      updatedAt: data.updatedAt,
      status: deriveStatus(data),
    };
  }
  // 没有 video.json：迁移口径的旧目录或空目录一律 in-progress，时长未知为 null
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
    try {
      lstatSync(resolve(outputDir, name, "topic.md"));
    } catch {
      continue;
    }
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
    durationSeconds: null,
    importedAt: null,
    sizeBytes: null,
    topicCount,
    clipCount,
    updatedAt: latest === undefined ? null : new Date(latest).toISOString(),
    // 旧目录有笔记但没有 video.json：结构化字幕缺失，界面要能提示重跑
    status: topicCount > 0 ? "needs-rerun" : "in-progress",
  };
}

/** 库卡片状态：没有 `video.json` 且没有旧主题目录 → `in-progress`，有旧主题目录 → `needs-rerun`；文档为空（无主题且无字幕）→ `in-progress`；有 `failed`/`needs-rerun` → `needs-rerun`；全部已勾选主题 `done` 且字幕非空 → `done`；其余 → `in-progress`。 */
function deriveStatus(data: VideoData): LibraryVideoStatus {
  if (data.topics.length === 0 && data.transcript.utterances.length === 0) return "in-progress";
  if (data.topics.some((t) => t.status === "failed" || t.status === "needs-rerun")) return "needs-rerun";
  const selectedDone = data.topics.filter((t) => t.selected).every((t) => t.status === "done");
  if (selectedDone && data.transcript.utterances.length > 0) return "done";
  return "in-progress";
}

export function listLibrary(root: string = notesRoot()): LibraryVideo[] {
  const index = readVideoIndex(root);
  const out: LibraryVideo[] = [];
  for (const entry of index.videos) {
    out.push(videoSummary(root, entry, false));
  }
  return out;
}

export function readLibraryVideo(root: string, id: string): LibraryDetail | undefined {
  const index = readVideoIndex(root);
  const entry = index.videos.find((v) => v.id === id);
  if (entry === undefined || typeof entry.outputDir !== "string") return undefined;
  if (!dirIsDirectChild(root, entry.outputDir)) return undefined;
  const outputDir = resolve(root, entry.outputDir);
  const data = loadVideoData(outputDir, { id: entry.id as VideoId, title: entry.title, sourcePath: entry.sourcePath });
  let corrections: CorrectionFileEntry[] = [];
  const raw = readJsonFileShallow(resolve(outputDir, "corrections.json"));
  if (Array.isArray(raw)) {
    corrections = raw.filter(isCorrectionEntry);
  }
  return { video: videoSummary(root, entry, true), data, corrections };
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
