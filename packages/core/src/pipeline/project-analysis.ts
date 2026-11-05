import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createAsrEngine, type AsrConfig, type AsrEngine } from "../asr/engine";
import { dedupeOverlappingLines } from "../asr/overlap-dedup";
import { extractAudioRange, probeVideo } from "../core/audio";
import { cacheDirFor, ensureDir, openVideo, slugify } from "../core/paths";
import { modelDir as defaultModelDir, notesRoot as defaultNotesRoot } from "../core/config";
import { applyCorrections } from "../core/corrections";
import { ensureCoverFrame } from "../core/cover";
import { acquireVideoLock, type VideoLock } from "../core/lock";
import { logger, runWithTask } from "../core/logger";
import { decideNormalization, normalizeMedia, targetFileName } from "../core/media-normalize";
import type { PromptOverrides } from "../core/prompts";
import type { LlmClient, LlmEndpoint, Progress } from "../core/steps";
import type { Speaker, TopicId, Video } from "../core/types";
import type { SubtitleLine } from "../core/project-controller";
import {
  emptyVideoData,
  mediaAbsolutePath,
  readVideoData,
  writeVideoData,
  type TopicRecord,
  type VideoData,
} from "../core/video-data";
import { createLlmClient } from "../llm/openai";
import { correctionsFor } from "./notes-run";
import { filterFillerUtterances } from "./filler-filter";
import { segmentTopics } from "./segment-topics";

export type RangeAnalysisInput = {
  /** 源文件绝对路径；已导入过的视频必须与文档里的 originalPath 一致。 */
  videoPath: string;
  /** 已导入视频的输出目录；新视频缺省时按 notesRoot 注册。 */
  outputDir?: string;
  notesRoot?: string;
  cacheRoot: string;
  modelDir?: string;
  /** 闭合区间的起点与终点（秒）；终点会夹到真实时长。 */
  startSeconds: number;
  endSeconds: number;
  endpoint: LlmEndpoint;
  client?: LlmClient;
  asr?: AsrConfig;
  /** 测试注入 ASR 引擎；真实调用方不传。 */
  asrEngine?: AsrEngine;
  runToken?: string;
  prompts?: PromptOverrides;
  /** 调用方已持有的运行锁（执行器先取锁，避免同进程二次取锁）；缺省自己取。 */
  lock?: VideoLock;
  onProgress?: (p: Progress) => void;
};

export type RangeAnalysisTopic = { id: string; title: string; category: string; lineIds: string[] };

export type RangeAnalysisResult = {
  videoId: string;
  outputDir: string;
  topics: RangeAnalysisTopic[];
  /** 本次区间新增的字幕行数。 */
  addedLines: number;
};

function mergeSpeakers(existing: Speaker[], incoming: Speaker[]): Speaker[] {
  const merged = [...existing];
  for (const speaker of incoming) {
    if (merged.some((s) => s.id === speaker.id)) continue;
    merged.push({ ...speaker, color: speaker.color ?? "#6aa9ff" });
  }
  return merged;
}

function freshTopicId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function freshDirName(title: string, used: Set<string>): string {
  const base = slugify(title, "topic");
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
  used.add(name);
  return name;
}

/**
 * 整理切片的分块分析（#126）：一个来源视频的一个区间，走现有导入的注册与格式规范化，
 * 只转写这一段、只划这一段的主题，字幕与主题追加进共享的 `video.json` 与缓存目录。
 * 已分析过的区间由控制器 cursor 挡住，不会被重复调用；本函数不判断增量。
 */
export async function analyzeVideoRange(input: RangeAnalysisInput): Promise<RangeAnalysisResult> {
  const taskId = input.runToken ?? randomUUID();
  return runWithTask(taskId, async () => {
    const notesRoot = input.notesRoot ?? defaultNotesRoot();
    const modelDir = input.modelDir ?? defaultModelDir();
    const client = input.client ?? createLlmClient(input.endpoint);
    const probe = await logger().step("ffmpeg", "ffprobe", () => probeVideo(input.videoPath));
    const start = Math.max(0, input.startSeconds);
    const end = Math.min(input.endSeconds, probe.duration);
    if (!(end - start > 0.05)) throw new Error("分析区间为空或超出视频时长");

    const video = openVideo(input.videoPath, probe.duration, notesRoot);
    if (input.outputDir !== undefined && resolve(input.outputDir) !== resolve(video.outputDir)) {
      throw new Error("sourcePath 与视频输出目录不匹配");
    }
    const cacheDir = ensureDir(cacheDirFor(input.cacheRoot, video.id));
    const asr = input.asr ?? { provider: "local", modelDir };
    const engine = input.asrEngine ?? createAsrEngine(asr);
    const runToken = taskId;
    const lock = input.lock ?? acquireVideoLock(video.outputDir);
    let wavPath: string | null = null;
    try {
      let data = readVideoData(video.outputDir);
      if (data === undefined) {
        data = { ...emptyVideoData(video), runToken, importedAt: new Date().toISOString() };
      }
      data.runToken = runToken;
      data.hasVideo = probe.hasVideo;
      data.originalPath = video.sourcePath;
      data.sourceBytes = statSync(input.videoPath).size;
      data.resolution = probe.width !== null && probe.height !== null ? { width: probe.width, height: probe.height } : null;
      writeVideoData(video.outputDir, data);

      // 格式规范化（ADR-0033）：与 runExtract 同一判定；已有产物直接复用
      const decision = decideNormalization({
        extension: extname(video.sourcePath).toLowerCase(),
        formatName: probe.formatName,
        hasVideo: probe.hasVideo,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
      });
      const reused =
        data.mediaPath !== null && data.normalized !== null && data.normalized !== "none" && existsSync(resolve(video.outputDir, data.mediaPath));
      if (reused) {
        logger().info("ffmpeg", "格式转换复用已有产物", { mediaPath: data.mediaPath, normalized: data.normalized });
      } else if (decision.mode === "none") {
        data.mediaPath = null;
        data.normalized = "none";
      } else {
        input.onProgress?.({ step: "normalize", done: 0, total: 100, detail: "0%" });
        const normalized = await logger().step("ffmpeg", "格式转换", () =>
          normalizeMedia({
            sourcePath: video.sourcePath,
            outputDir: video.outputDir,
            decision,
            durationSeconds: probe.duration,
            onProgress: (percent: number) => input.onProgress?.({ step: "normalize", done: percent, total: 100, detail: `${percent}%` }),
          }),
        );
        data.mediaPath = targetFileName(decision);
        data.normalized = normalized.mode;
      }
      writeVideoData(video.outputDir, data);
      const mediaPath = mediaAbsolutePath(data);
      try {
        await ensureCoverFrame({ outputDir: video.outputDir, sourcePath: mediaPath, durationSeconds: probe.duration, hasVideo: probe.hasVideo });
      } catch {
        logger().warn("ffmpeg", "封面抽帧失败");
      }

      // 只抽这一段；wav 名带随机后缀，同一视频的两个区间不会互相删除
      wavPath = resolve(cacheDir, `range-${Math.round(start)}-${Math.round(end)}-${randomUUID().slice(0, 8)}.wav`);
      await logger().step("ffmpeg", "抽取音频区间", () => extractAudioRange(mediaPath, wavPath!, { start, end }));
      input.onProgress?.({ step: "transcribe", done: 0, total: 0 });
      const rangeVideo: Video = { ...video, durationSeconds: end - start };
      const run = await logger().step("asr", "区间转写", () => engine.run({ video: rangeVideo, wavPath: wavPath!, cacheDir }));

      // ASR 时间戳相对区间起点：整体平移回源时间轴
      const shifted = run.transcript.utterances.map((u) => ({
        ...u,
        start: Math.min(u.start + start, end),
        end: Math.min(u.end + start, end),
      }));
      const deduped = dedupeOverlappingLines(shifted);
      const filler = await filterFillerUtterances({
        rows: deduped,
        endpoint: input.endpoint,
        client,
        ...(input.prompts !== undefined ? { prompts: input.prompts } : {}),
      });

      const previous = data.transcript.utterances;
      const utterances = [...previous, ...filler.rows].sort((a, b) => a.start - b.start || a.end - b.end);
      const speakers = mergeSpeakers(data.transcript.speakers, run.transcript.speakers);
      const chunk = { index: data.chunks.length + 1, start, end };
      data.chunks = [...data.chunks.filter((c) => !(Math.abs(c.start - start) < 1e-6 && Math.abs(c.end - end) < 1e-6)), chunk].sort(
        (a, b) => a.start - b.start,
      );
      data.asrModel = run.modelId;
      data.asrEngine = run.engine;

      // 主题只针对本区间：用本区间的字幕作为提示词上下文，段坐标已经是绝对时间
      const corrections = correctionsFor(video.outputDir, "project-analysis");
      const rangeLines = utterances.filter((u) => u.end > start && u.start < end);
      const rangeTranscript = { speakers, utterances: applyCorrections(corrections, rangeLines) };
      const { topics } = await logger().step("llm", "区间主题分析", () =>
        segmentTopics({
          transcript: rangeTranscript,
          chunks: [{ index: 1, start, end }],
          endpoint: input.endpoint,
          cacheDir,
          client,
          corrections,
          hosts: data.hosts ?? [],
          ...(input.prompts !== undefined ? { prompts: input.prompts } : {}),
          ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
        }),
      );

      const usedIds = new Set(data.topics.map((t) => t.id as string));
      const usedDirs = new Set(data.topics.map((t) => t.dirName));
      const rangeKey = `t${Math.round(start)}`;
      const records: TopicRecord[] = topics.map((topic, index) => {
        const id = freshTopicId(`${rangeKey}-${index + 1}`, usedIds) as TopicId;
        return {
          id,
          title: topic.title,
          summary: topic.summary,
          segments: topic.segments.map((s) => ({ ...s })),
          dirName: freshDirName(topic.title, usedDirs),
          status: "proposed",
          selected: true,
          keyPoints: [],
          clips: [],
          startedAt: null,
          elapsedSeconds: null,
          error: null,
        };
      });
      data.transcript = { speakers, utterances };
      data.topics = [...data.topics, ...records];
      if (data.importedAt === null) data.importedAt = new Date().toISOString();
      writeVideoData(video.outputDir, data);

      const analyzed: RangeAnalysisTopic[] = records.map((record) => ({
        id: record.id,
        title: record.title,
        category: "",
        lineIds: lineIdsFor(record, utterances),
      }));
      logger().info("project", "区间分析完成", {
        videoId: video.id,
        start,
        end,
        lines: filler.rows.length,
        topics: analyzed.length,
      });
      return { videoId: video.id, outputDir: video.outputDir, topics: analyzed, addedLines: filler.rows.length };
    } finally {
      if (wavPath !== null) rmSync(wavPath, { force: true });
      lock.release();
    }
  });
}

/** 主题覆盖到的字幕行 id：`line-<合并后下标>`，与对话层读 `video.json` 的顺序一致（追加区间只往后排）。 */
function lineIdsFor(topic: TopicRecord, utterances: VideoData["transcript"]["utterances"]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < utterances.length; i += 1) {
    const u = utterances[i]!;
    if (topic.segments.some((s) => u.end > s.start && u.start < s.end)) ids.push(`line-${i}`);
  }
  return ids;
}

/** 控制器确认弹窗用：按行 id 解析字幕快照（`line-<下标>`，与区间分析写入的一致）。 */
export function subtitleLinesFrom(data: VideoData): SubtitleLine[] {
  return data.transcript.utterances.map((u, i) => ({
    id: `line-${i}`,
    start: u.start,
    end: u.end,
    speaker: data.transcript.speakers.find((s) => s.id === u.speakerId)?.name ?? "",
    text: u.text,
  }));
}
