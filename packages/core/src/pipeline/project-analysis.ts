import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createAsrEngine, type AsrConfig, type AsrEngine } from "../asr/engine";
import { dedupeOverlappingLines, dropCoveredDuplicates } from "../asr/overlap-dedup";
import { alignRangeSpeakers, applySpeakerAlignment } from "../asr/speaker-align";
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
  /** 本次区间新增的字幕行数；区间已分析过（复用 `chunks`）时为 0。 */
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
 * 同一区间再次进来（项目重启重建队列、另一个项目引用同一视频）时按 `chunks` 记录复用，
 * 不重复转写，也不重复追加字幕与主题。
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
    const ownsLock = input.lock === undefined;
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

      // 增量保护：同一区间已经分析过（同一项目重启、另一个项目引用同一视频）就直接复用，
      // 不再转写/划主题，也不重复追加字幕与主题
      const existing = data.chunks.find((c) => Math.abs(c.start - start) < 1e-6 && Math.abs(c.end - end) < 1e-6);
      if (existing !== undefined) {
        const reusedTopics = data.topics
          .filter((topic) => topic.segments.some((s) => s.start >= start - 1e-6 && s.end <= end + 1e-6))
          .map((topic) => ({
            id: topic.id,
            title: topic.title,
            category: "",
            lineIds: lineIdsFor(topic, data.transcript.utterances),
          }));
        logger().info("project", "区间已分析，复用已有结果", { videoId: video.id, start, end, topics: reusedTopics.length });
        return { videoId: video.id, outputDir: video.outputDir, topics: reusedTopics, addedLines: 0 };
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
      /**
       * 区间 ASR 的 `speaker-N` 按**本区间**说话时长排名（`assignSpeakers`），不是跨次稳定身份：
       * 整段里排第二的人只切到他的大段发言时会在区间里排第一。判重前先按「同时间 + 同文本」
       * 的既有行把局部编号映射回来源视频的稳定身份（#145），映射不了的编号不参与身份判断。
       */
      const alignment = alignRangeSpeakers(previous, filler.rows);
      // 复用视频库字幕时这段区间可能已经整段转写过：只追加真正新增的行，已有行与 line id 保持不变
      const appended = applySpeakerAlignment(dropCoveredDuplicates(previous, filler.rows, undefined, alignment), alignment);
      const utterances = [...previous, ...appended].sort((a, b) => a.start - b.start || a.end - b.end);
      // 只在剩下的行里还出现的说话人才登记：整段被映射走的局部编号（先前的 speaker-1）不该留个空壳
      const usedSpeakers = new Set(appended.map((u) => u.speakerId));
      const speakers = mergeSpeakers(
        data.transcript.speakers,
        run.transcript.speakers.filter((s) => usedSpeakers.has(s.id)),
      );
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
      // 转写已结束、主题分析（划段 + 合并）开始：先推一次，界面不必等首个分块模型返回才看到第二步
      input.onProgress?.({ step: "segment-topics", done: 0, total: 1 });
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
      const records: TopicRecord[] = [];
      for (const topic of topics) {
        // 一次任务只对这一段负责：模型若给出区间外的时间段（含误用相对时间），夹回区间；
        // 夹不出一段有效区间就丢弃，避免把别的区间的字幕算进本主题
        const segments = topic.segments
          .map((s) => ({ start: Math.max(start, s.start), end: Math.min(end, s.end) }))
          .filter((s) => s.end > s.start + 1e-6);
        if (segments.length === 0) continue;
        const id = freshTopicId(`${rangeKey}-${records.length + 1}`, usedIds) as TopicId;
        records.push({
          id,
          title: topic.title,
          summary: topic.summary,
          segments,
          dirName: freshDirName(topic.title, usedDirs),
          status: "proposed",
          selected: true,
          keyPoints: [],
          clips: [],
          startedAt: null,
          elapsedSeconds: null,
          error: null,
        });
      }
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
        lines: appended.length,
        topics: analyzed.length,
      });
      return { videoId: video.id, outputDir: video.outputDir, topics: analyzed, addedLines: appended.length };
    } finally {
      if (wavPath !== null) rmSync(wavPath, { force: true });
      // 调用方传进来的锁由调用方释放：这里提前释放会让同视频的另一个槽插进来
      if (ownsLock) lock.release();
    }
  });
}

type LineSource = { start: number; end: number; speakerId: string; text: string };

/**
 * 字幕行 id：时间（毫秒）+ 说话人 + 文本指纹，与数组下标无关。
 * 区间分析会把新区间的字幕按时间插进已有字幕里，下标型 id 会让弹窗里的已选行
 * 在后台分析插队后解析到别的字幕；时间、说话人、文本在一行字幕被改写前都不会变，
 * 所以「弹窗快照 → 提交」在同一次改动里始终指向同一行（#129）。
 * 说话人必须进指纹：抢话时两个说话人可能在**同一毫秒区间说出同一句话**，去重只删
 * 严格更短的一行，两行都会留在字幕里；只按时间+文本生成 id 时这两行共用一个 id，
 * 弹窗里勾一个就勾上两行，提交也只解析得出一行。
 */
function lineIdOf(utterance: LineSource, occurrence = 0): string {
  let hash = 0x811c9dc5;
  for (const code of `${utterance.speakerId}\u0000${utterance.text}`) {
    hash ^= code.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  const base = `line-${Math.round(utterance.start * 1000)}-${Math.round(utterance.end * 1000)}-${(hash >>> 0).toString(36)}`;
  /**
   * 同一内容的第 2、3…次出现带 `-2`、`-3` 后缀：旧版无条件追加的区间重跑会把时间、说话人、
   * 文本完全相同的两行都留在 `video.json` 里，只按字段生成 id 会让它们共用一个 id——
   * 弹窗里勾一行联动两行，提交也只解析得出一行。两个调用方都按数组顺序数出现次数，id 必然一致。
   */
  return occurrence === 0 ? base : `${base}-${occurrence + 1}`;
}

/** 按数组顺序给每行分配 id（同内容行第 n 次出现带后缀）；主题与弹窗共用这一套，不许各算各的。 */
function lineIdsOf(utterances: readonly LineSource[]): string[] {
  const seen = new Map<string, number>();
  return utterances.map((u) => {
    const key = `${Math.round(u.start * 1000)}\u0000${Math.round(u.end * 1000)}\u0000${u.speakerId}\u0000${u.text}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return lineIdOf(u, occurrence);
  });
}

/** 主题覆盖到的字幕行 id：与对话层读 `video.json` 的顺序无关，只认行自己的时间、说话人与文本。 */
function lineIdsFor(topic: TopicRecord, utterances: VideoData["transcript"]["utterances"]): string[] {
  const ids = lineIdsOf(utterances);
  return ids.filter((_, index) => {
    const u = utterances[index]!;
    return topic.segments.some((s) => u.end > s.start && u.start < s.end);
  });
}

/** 控制器确认弹窗用：按行 id 解析字幕快照（与区间分析写入的 `lineIdOf` 同口径）。 */
export function subtitleLinesFrom(data: VideoData): SubtitleLine[] {
  const ids = lineIdsOf(data.transcript.utterances);
  return data.transcript.utterances.map((u, index) => ({
    id: ids[index]!,
    start: u.start,
    end: u.end,
    speaker: data.transcript.speakers.find((s) => s.id === u.speakerId)?.name ?? "",
    text: u.text,
  }));
}
