import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseClipFileName } from "./clips";
import { isVideoLocked } from "./lock";
import { writeJsonAtomic } from "./paths";
import type { NormalizeMode } from "./media-normalize";
import type { AsrProvider } from "./settings";
import type { Chunk, Segment, Speaker, SpeakerId, TopicId, Transcript, Utterance, Video, VideoId } from "./types";

export const VIDEO_DATA_FILE = "video.json";
export const VIDEO_DATA_VERSION = 1;

export type TopicStatus = "queued" | "generating" | "done" | "failed" | "needs-rerun" | "proposed";

/** 主播的来源：自动识别 / 人工修正 / 未识别（旧文档、还没跑识别、或已被用户清空）。 */
export type HostSource = "auto" | "manual" | null;

export type TopicClip = { file: string; start: number; end: number; segmentIndexes: number[]; segmentOffsets: number[] };

export type TopicRecord = {
  id: TopicId;
  title: string;
  summary: string;
  /** 已排序，可多段、可不连续 */
  segments: Segment[];
  /** 主题目录名；合并后沿用被保留主题的目录 */
  dirName: string;
  status: TopicStatus;
  /** 主题页勾选框 */
  selected: boolean;
  keyPoints: string[];
  clips: TopicClip[];
  /** 本主题开始生成的 ISO 时间 */
  startedAt: string | null;
  elapsedSeconds: number | null;
  error: string | null;
};

export type VideoData = {
  version: 1;
  video: Video;
  transcript: Transcript;
  /** 分析分块；仅主题重跑要复用它，不能依赖可清除的缓存 */
  chunks: Chunk[];
  topics: TopicRecord[];
  /** 首次生成的 ISO 时间；卡片「导入时间」 */
  importedAt: string | null;
  /** 源文件字节数；卡片文件大小 */
  sourceBytes: number | null;
  /** 这次转写用的 ASR 模型；字幕页照实显示 */
  asrModel: string | null;
  /** 源视频分辨率；旧文档缺失为 null，卡片省略 */
  resolution: { width: number; height: number } | null;
  /** 源文件有无独立视频轨（r42）；null 为旧文档，按有视频处理 */
  hasVideo: boolean | null;
  /** ASR 引擎（ADR-0016 §9 与 `AsrProvider` 同值）；旧文档缺失为 null，字幕页按本地显示 */
  asrEngine: AsrProvider | null;
  /** 写这批主题的那次运行的 token；结算后 null（ADR-0015 §7） */
  runToken: string | null;
  /** 说话人合并/拆分后盖的 ISO 时间；存在 `done` 主题时提示可重新生成（r35），重新生成成功后清空 */
  speakerChangedAt: string | null;
  /** 上一次运行的失败（短原因，r35）；界面卡片据此显示「失败 + 原因」，重跑启动时清空 */
  failure: { message: string; at: string } | null;
  /** 导入时的源文件绝对路径（r45b，ADR-0033）；旧文档缺失为 null，回退 `video.sourcePath` */
  originalPath: string | null;
  /** 规范化产物相对数据目录的文件名（`media.mp4` / `media.mp3`）；null 表示直接用原文件 */
  mediaPath: string | null;
  /** 规范化方式：none（原文件直读）/ remux（换封装）/ transcode（转码）；旧文档缺失为 null */
  normalized: NormalizeMode | null;
  /** 主播，可以多个，按识别/用户顺序；空数组表示未识别或已清空 */
  hosts: SpeakerId[];
  /** 主播的来源：自动识别 / 人工修正 / 未识别 */
  hostSource: HostSource;
  updatedAt: string;
};

/** 界面侧的调用方身份：文档缺失时从这里做旧目录迁移。 */
export type VideoRef = {
  id: VideoId;
  title: string;
  sourcePath?: string;
  durationSeconds?: number;
};

function videoPath(outputDir: string): string {
  return resolve(outputDir, VIDEO_DATA_FILE);
}

function readNumber(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where} 的秒数不是有效数字`);
  return v;
}

function readString(v: unknown, where: string): string {
  if (typeof v !== "string") throw new Error(`${where} 不是字符串`);
  return v;
}

function readStringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${where} 不是字符串数组`);
  return v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTopics(raw: unknown, where: string): TopicRecord[] {
  if (!Array.isArray(raw)) throw new Error(`${where} 不是数组`);
  const out: TopicRecord[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const t = `topics[${i}]`;
    if (!isObject(r)) throw new Error(`${t} 不是对象`);
    out.push({
      id: readString(r.id, `${t}.id`) as TopicId,
      title: readString(r.title, `${t}.title`),
      summary: readString(r.summary, `${t}.summary`),
      segments: parseSegments(r.segments, `${t}.segments`),
      dirName: readString(r.dirName, `${t}.dirName`),
      status: readString(r.status, `${t}.status`) as TopicStatus,
      selected: parseSelected(r.selected, `${t}.selected`),
      keyPoints: readStringArray(r.keyPoints, `${t}.keyPoints`),
      clips: parseClips(r.clips, `${t}.clips`),
      startedAt: parseNullableString(r.startedAt, `${t}.startedAt`),
      elapsedSeconds: parseNullableNumber(r.elapsedSeconds, `${t}.elapsedSeconds`),
      error: parseNullableString(r.error, `${t}.error`),
    });
  }
  return out;
}


function requireArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${where} 不是数组`);
  return v;
}
function parseNumberArray(v: unknown, where: string): number[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "number")) throw new Error(`${where} 不是数字数组`);
  return v as number[];
}
function parseOptionalNumberArray(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}
function parseClips(v: unknown, where: string): TopicClip[] {
  return requireArray(v, where).map((c, i) => {
    if (!isObject(c)) throw new Error(`${where}[${i}] 不是对象`);
    return {
      file: readString(c.file, `${where}[${i}].file`),
      start: readNumber(c.start, `${where}[${i}].start`),
      end: readNumber(c.end, `${where}[${i}].end`),
      segmentIndexes: parseNumberArray(c.segmentIndexes, `${where}[${i}].segmentIndexes`),
      segmentOffsets: parseOptionalNumberArray(c.segmentOffsets),
    };
  });
}
function parseSegments(v: unknown, where: string): Segment[] {
  return requireArray(v, where).map((s, i) => {
    if (!isObject(s)) throw new Error(`${where}[${i}] 不是对象`);
    return { start: readNumber(s.start, `${where}[${i}].start`), end: readNumber(s.end, `${where}[${i}].end`) };
  });
}

function parseChunks(v: unknown, where: string): Chunk[] {
  return requireArray(v, where).map((c, i) => {
    if (!isObject(c)) throw new Error(`${where}[${i}] 不是对象`);
    return { index: readNumber(c.index, `${where}[${i}].index`), start: readNumber(c.start, `${where}[${i}].start`), end: readNumber(c.end, `${where}[${i}].end`) };
  });
}

function parseSelected(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${where} 不是布尔值`);
  return v;
}

function parseNullableString(v: unknown, where: string): string | null {
  if (v !== null && typeof v !== "string") throw new Error(`${where} 非法`);
  return (v as string | null) ?? null;
}

function parseNullableNumber(v: unknown, where: string): number | null {
  if (v !== null && typeof v !== "number") throw new Error(`${where} 非法`);
  return (v as number | null) ?? null;
}

function parseResolution(v: unknown, where: string): { width: number; height: number } | null {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) throw new Error(`${where} 非法`);
  const width = readNumber(v.width, `${where}.width`);
  const height = readNumber(v.height, `${where}.height`);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error(`${where} 的宽高必须是正的整数`);
  return { width, height };
}
function parseHasVideo(v: unknown, where: string): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") throw new Error(`${where} 不是布尔值`);
  return v;
}

/** ADR-0016 §9：运行时值只有三个；旧文档的 `remote` 在读取边界映射为 `openai`。 */
const ASR_ENGINE_VALUES = ["local", "openai", "volcengine"] as const;

function parseAsrEngine(v: unknown, where: string): AsrProvider | null {
  if (v === null || v === undefined) return null;
  if (v === "remote") return "openai";
  for (const value of ASR_ENGINE_VALUES) if (v === value) return value;
  throw new Error(`${where} 只能是 ${ASR_ENGINE_VALUES.join(" 或 ")}`);
}

/** 失败记录：缺失或形状不对一律按 null，不让一个坏字段挡住整个文档。 */
function parseFailure(v: unknown): { message: string; at: string } | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) return null;
  if (typeof v.message !== "string" || typeof v.at !== "string") return null;
  return { message: v.message, at: v.at };
}

/**
 * 规范化产物文件名（r45b）：只收数据目录里的单段 mp4/mp3，防止坏文档把播放路径指到目录外。
 */
function parseMediaPath(v: unknown, where: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v === "") throw new Error(`${where} 不是非空字符串`);
  if (v.includes("/") || v.includes("\\") || v === "." || v === "..") throw new Error(`${where} 必须是数据目录内的文件名`);
  if (!v.endsWith(".mp4") && !v.endsWith(".mp3")) throw new Error(`${where} 只支持 .mp4 或 .mp3`);
  return v;
}

const NORMALIZE_MODES: Record<string, true> = { none: true, remux: true, transcode: true };

function parseNormalized(v: unknown, where: string): NormalizeMode | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || NORMALIZE_MODES[v] !== true) throw new Error(`${where} 只能是 none / remux / transcode`);
  return v as NormalizeMode;
}

/**
 * 主播列表：缺失、形状不对、id 不在说话人表里的项一律丢弃（旧文档没有这个字段），
 * 去重并保持原顺序；宁可少一个主播，也不让一个坏字段挡住整个文档。
 */
function parseHosts(v: unknown, speakers: readonly Speaker[]): SpeakerId[] {
  if (!Array.isArray(v)) return [];
  const known = new Set<string>(speakers.map((s) => s.id));
  const out: SpeakerId[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !known.has(item) || out.includes(item as SpeakerId)) continue;
    out.push(item as SpeakerId);
  }
  return out;
}

const HOST_SOURCE_VALUES: Record<string, "auto" | "manual"> = { auto: "auto", manual: "manual" };

/** 主播来源：没有主播就是未识别；值不认识的也按未识别处理，不抛错。 */
function parseHostSource(v: unknown, hosts: readonly SpeakerId[]): HostSource {
  if (hosts.length === 0) return null;
  if (typeof v !== "string") return null;
  return HOST_SOURCE_VALUES[v] ?? null;
}

/** 播放、抽音、切片、封面用的绝对路径：有规范化产物用产物，否则原文件（旧数据兼容）。 */
export function mediaAbsolutePath(data: Pick<VideoData, "mediaPath" | "video">): string {
  return data.mediaPath === null ? data.video.sourcePath : resolve(data.video.outputDir, data.mediaPath);
}

/** 缺失返回 undefined；存在但损坏（版本不符、字段形状错）抛出指明文件与版本的错误。 */
export function readVideoData(outputDir: string): VideoData | undefined {
  let raw: string;
  try {
    raw = readFileSync(videoPath(outputDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${VIDEO_DATA_FILE}（version ${VIDEO_DATA_VERSION}）：不是合法 JSON`);
  }
  const p = videoPath(outputDir);
  if (!isObject(parsed)) throw new Error(`${p}：不是对象`);
  if (parsed.version !== VIDEO_DATA_VERSION) throw new Error(`${p}：version 应为 ${VIDEO_DATA_VERSION}，实际 ${String(parsed.version)}`);
  const video = parsed.video;
  if (!isObject(video)) throw new Error(`${p}：video 不是对象`);
  const v: Video = {
    id: readString(video.id, `${p}.video.id`) as VideoId,
    title: readString(video.title, `${p}.video.title`),
    sourcePath: readString(video.sourcePath, `${p}.video.sourcePath`),
    durationSeconds: readNumber(video.durationSeconds, `${p}.video.durationSeconds`),
    outputDir: readString(video.outputDir, `${p}.video.outputDir`),
  };
  const transcript = parsed.transcript;
  if (!isObject(transcript)) throw new Error(`${p}：transcript 不是对象`);
  const speakers = requireArray(transcript.speakers, `${p}.transcript.speakers`);
  const speakerList = speakers.map((s) => {
    if (!isObject(s)) throw new Error(`${p}.transcript.speakers 项不是对象`);
    return {
      id: readString(s.id, `${p}.transcript.speakers.id`) as SpeakerId,
      name: readString(s.name, `${p}.transcript.speakers.name`),
      color: readString(s.color, `${p}.transcript.speakers.color`),
      mergedInto: s.mergedInto === undefined ? undefined : (parseNullableString(s.mergedInto, `${p}.transcript.speakers.mergedInto`) as SpeakerId | null | undefined),
      customName: typeof s.customName === "boolean" ? s.customName : undefined,
    };
  });
  const utt = requireArray(transcript.utterances, `${p}.transcript.utterances`);
  const utterances: Utterance[] = utt.map((u, i) => {
    if (!isObject(u)) throw new Error(`${p}.transcript.utterances[${i}] 不是对象`);
    return {
      start: readNumber(u.start, `${p}.transcript.utterances[${i}].start`),
      end: readNumber(u.end, `${p}.transcript.utterances[${i}].end`),
      speakerId: readString(u.speakerId, `${p}.transcript.utterances[${i}].speakerId`) as SpeakerId,
      text: readString(u.text, `${p}.transcript.utterances[${i}].text`),
    };
  });
  const hosts = parseHosts(parsed.hosts, speakerList);
  return {
    version: VIDEO_DATA_VERSION,
    video: v,
    transcript: { speakers: speakerList, utterances },
    chunks: parseChunks(parsed.chunks, `${p}.chunks`),
    topics: parseTopics(parsed.topics, p),
    importedAt: parsed.importedAt === undefined ? null : parseNullableString(parsed.importedAt, `${p}.importedAt`),
    sourceBytes: parsed.sourceBytes === undefined ? null : parseNullableNumber(parsed.sourceBytes, `${p}.sourceBytes`),
    asrModel: parsed.asrModel === undefined ? null : parseNullableString(parsed.asrModel, `${p}.asrModel`),
    resolution: parseResolution(parsed.resolution, `${p}.resolution`),
    hasVideo: parseHasVideo(parsed.hasVideo, `${p}.hasVideo`),
    asrEngine: parseAsrEngine(parsed.asrEngine, `${p}.asrEngine`),
    runToken: parsed.runToken === undefined ? null : parseNullableString(parsed.runToken, `${p}.runToken`),
    speakerChangedAt: parsed.speakerChangedAt === undefined ? null : parseNullableString(parsed.speakerChangedAt, `${p}.speakerChangedAt`),
    failure: parseFailure(parsed.failure),
    originalPath: parsed.originalPath === undefined ? null : parseNullableString(parsed.originalPath, `${p}.originalPath`),
    mediaPath: parseMediaPath(parsed.mediaPath, `${p}.mediaPath`),
    normalized: parseNormalized(parsed.normalized, `${p}.normalized`),
    hosts,
    hostSource: parseHostSource(parsed.hostSource, hosts),
    updatedAt: readString(parsed.updatedAt, `${p}.updatedAt`),
  };
}
/** 盖 `updatedAt` ISO 时间（单调递增，同毫秒多次写也保证后写晚于先写）后原子写出，返回落盘文档。 */
let lastStampMs = 0;
function stampUpdatedAt(): string {
  const now = Date.now();
  const ms = Math.max(now, lastStampMs + 1);
  lastStampMs = ms;
  return new Date(ms).toISOString();
}
export function writeVideoData(outputDir: string, data: VideoData): VideoData {
  mkdirSync(outputDir, { recursive: true });
  const out = { ...data, updatedAt: stampUpdatedAt() };
  writeJsonAtomic(videoPath(outputDir), out);
  return out;
}

/** 失败记录落盘（r35）：读文档 → 盖时间 → 写回；文档缺失或解析失败时 no-op，不抛错。 */
export function recordVideoFailure(outputDir: string, message: string): void {
  const data = readVideoData(outputDir);
  if (data === undefined) return;
  writeVideoData(outputDir, { ...data, failure: { message, at: new Date().toISOString() } });
}

/** 清掉失败记录（r35）：已有记录才写回，没有记录不动磁盘。 */
export function clearVideoFailure(outputDir: string): void {
  const data = readVideoData(outputDir);
  if (data === undefined || data.failure === null) return;
  writeVideoData(outputDir, { ...data, failure: null });
}

/** 新文档：无字幕、无主题（`updatedAt` 占位，真正落盘时由 `writeVideoData` 盖时间戳）。 */
export function emptyVideoData(video: Video): VideoData {
  return {
    version: VIDEO_DATA_VERSION,
    video,
    transcript: { speakers: [], utterances: [] },
    chunks: [],
    topics: [],
    importedAt: null,
    sourceBytes: null,
    asrModel: null,
    resolution: null,
    hasVideo: null,
    asrEngine: null,
    runToken: null,
    speakerChangedAt: null,
    failure: null,
    originalPath: video.sourcePath,
    mediaPath: null,
    normalized: null,
    hosts: [],
    hostSource: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * 从旧目录（markdown + 切片文件名）重建文档：标题取 `topic.md` 的 `# `，时间段取
 * `### [HH:MM:SS - HH:MM:SS](file)` 标题（标题缺失时才用切片范围近似并记 error），
 * 要点取 `## 要点` 列表，切片取目录里的 mp4 文件名，
 * 字幕为空，状态 `done`（字幕缺失由库卡片按 `needs-rerun` 口径显示）。
 */
export function migrateVideoData(outputDir: string, video: Video): VideoData {
  let names: string[] = [];
  try {
    names = readdirSync(outputDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    names = [];
  }
  const topics: TopicRecord[] = [];
  for (const dirName of names) {
    const dir = join(outputDir, dirName);
    let md: string;
    try {
      md = readFileSync(join(dir, "topic.md"), "utf8");
    } catch {
      continue;
    }
    const titleLine = md.split("\n").find((l) => l.startsWith("# "));
    // 标题里的 [HH:MM:SS - HH:MM:SS] 是原始段边界；切片名带前移且重叠会合一，反推不出
    const lines = md.split("\n");
    const segments: Segment[] = [];
    const segRe = /^### \[(\d{2}):(\d{2}):(\d{2}) - (\d{2}):(\d{2}):(\d{2})\]/;
    for (const line of lines) {
      const m = segRe.exec(line);
      if (m === null) continue;
      const caps = m.slice(1);
      const n = (i: number): number => Number(caps[i] ?? "0");
      segments.push({ start: n(0) * 3600 + n(1) * 60 + n(2), end: n(3) * 3600 + n(4) * 60 + n(5) });
    }
    segments.sort((a, b) => a.start - b.start);
    let error: string | null = null;
    const keyPoints: string[] = [];
    let inPoints = false;
    for (const line of lines) {
      if (line.startsWith("## ")) inPoints = line === "## 要点";
      else if (inPoints && line.startsWith("- ")) keyPoints.push(line.slice(2));
    }
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      files = [];
    }
    const clipRanges: { file: string; start: number; end: number }[] = [];
    for (const name of files) {
      const parsed = parseClipFileName(name);
      if (parsed === undefined) continue;
      clipRanges.push({ file: name, start: parsed.start, end: parsed.end });
    }
    clipRanges.sort((a, b) => a.start - b.start || a.file.localeCompare(b.file));
    if (clipRanges.length > 0 && segments.length === 0) {
      // 没有标题：只能用切片范围近似时间段（切片带前移，起点偏早），给主题记 error
      for (const c of clipRanges) segments.push({ start: c.start, end: c.end });
      error = "时间段按切片近似恢复";
    }
    // 切片名只有向下取整后的起止；覆盖某段当 `clip.start <= seg.start && clip.end >= seg.end - 0.4`
    const clips: TopicClip[] = clipRanges.map((c) => {
      const covered: number[] = [];
      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s]!;
        if (c.start <= seg.start && c.end >= seg.end - 0.4) covered.push(s);
      }
      return { file: c.file, start: c.start, end: c.end, segmentIndexes: covered, segmentOffsets: [] };
    });
    topics.push({
      id: dirName as TopicId,
      title: titleLine !== undefined ? titleLine.slice(2).trim() : dirName,
      summary: "",
      segments,
      dirName,
      status: "done",
      selected: false,
      keyPoints,
      clips,
      startedAt: null,
      elapsedSeconds: null,
      error,
    });
  }
  return {
    version: VIDEO_DATA_VERSION,
    video,
    transcript: { speakers: [], utterances: [] },
    chunks: [],
    topics,
    importedAt: null,
    sourceBytes: null,
    asrModel: null,
    resolution: null,
    hasVideo: null,
    asrEngine: null,
    runToken: null,
    speakerChangedAt: null,
    failure: null,
    originalPath: video.sourcePath === "" ? null : video.sourcePath,
    mediaPath: null,
    normalized: null,
    hosts: [],
    hostSource: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 读侧状态投影（ADR-0015 §7）：无活锁时 `generating`/`queued` 是中断运行的残留，
 * 投影为 `failed("上次生成已中断")`（不动其余字段）；有活锁时原样返回。
 * 纯函数：不改入参、不回写磁盘，有变化时返回换掉 `topics` 的新对象。
 */
export function projectRunState(data: VideoData, opts: { locked: boolean }): VideoData {
  if (opts.locked) return data;
  let changed = false;
  const topics = data.topics.map((t) => {
    if (t.status !== "generating" && t.status !== "queued") return t;
    changed = true;
    return { ...t, status: "failed" as const, error: "上次生成已中断" };
  });
  if (!changed) return data;
  return { ...data, topics };
}

/** 读文档；缺失时从旧目录迁移（结果不回写，等下次生成或编辑再落盘）。状态走 `projectRunState`。 */
export function loadVideoData(outputDir: string, ref: VideoRef): VideoData {
  const data = readVideoData(outputDir);
  if (data !== undefined) {
    return projectRunState(data, { locked: isVideoLocked(outputDir) });
  }
  const video: Video = {
    id: ref.id,
    title: ref.title,
    sourcePath: ref.sourcePath ?? "",
    durationSeconds: ref.durationSeconds ?? 0,
    outputDir,
  };
  return migrateVideoData(outputDir, video);
}
