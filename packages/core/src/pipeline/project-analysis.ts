import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createAsrEngine, type AsrConfig, type AsrEngine } from "../asr/engine";
import { dedupeOverlappingLines, dropCoveredDuplicates } from "../asr/overlap-dedup";
import { alignRangeSpeakers, assignStableSpeakerIds } from "../asr/speaker-align";
import { alignRangeByVoiceprint, voiceprintTable, type RangeVoiceprintDeps } from "./range-voiceprint";
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
import type { Segment, Speaker, TopicId, Video } from "../core/types";
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
  /** 测试注入：声纹映射用的段级嵌入（正式调用方不传，走 CAM++）。 */
  voiceprintDeps?: RangeVoiceprintDeps;
  /** 测试注入：跳过 ffmpeg 解码来源媒体，直接给整段参考音频。 */
  referenceAudio?: { samples: Float32Array; sampleRate: number };
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
  /** 本次区间新增的字幕行数；精确命中已有分块（直接复用、不重跑 ASR）时为 0。 */
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

/**
 * 已分析过的时段：`chunks` 的并集。视频库导入写的是 ASR 分块，区间分析写的是本次区间，
 * 两者都可能互相重叠（同一视频既被整段导入过、又被项目区间分析过），先合并再判断包含关系。
 */
function analyzedSpans(chunks: VideoData["chunks"]): Segment[] {
  const spans = chunks
    .map((chunk) => ({ start: chunk.start, end: chunk.end }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end + 1e-6) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * 已有主题的区间重跑只刷新字幕（#150）：返回该区间里**仍待确认**（`proposed`）的主题，
 * 建议行按当前字幕重新解析——新 ASR 补出来的行只要落在主题的时间范围里就自动进建议。
 * 已确认 / 生成中 / 已切片 / 失败的主题不返回、也不改动：它们自己的记录（含切片字幕快照
 * 与切片文件）在 `video.json` / 项目清单里，重跑不该让它们重新变成待确认、更不能重复切片。
 */
function refreshableTopics(data: VideoData, start: number, end: number): RangeAnalysisTopic[] {
  return data.topics
    .filter((topic) => topic.status === "proposed")
    .filter((topic) => topic.segments.some((s) => s.end > start + 1e-6 && s.start < end - 1e-6))
    .map((topic) => ({
      id: topic.id,
      title: topic.title,
      category: "",
      lineIds: lineIdsFor(topic, data.transcript.utterances),
    }));
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

      /**
       * 增量保护：同一区间已经分析过（同一项目重启、另一个项目引用同一视频）就直接复用，
       * 不再转写/划主题，也不重复追加字幕与主题。只把仍待确认的主题重新给出建议行；
       * 已确认 / 已切片的主题不再提案，避免重复切片（#150）。
       * `topics` 为空时不算「已分析过」：视频库导入先落 `chunks` 再划主题，主题分析失败会留下
       * 「有分块、没主题」的文档，那种区间必须照旧补一次主题分析（#150 评审 P2）。
       */
      const existing = data.chunks.find((c) => Math.abs(c.start - start) < 1e-6 && Math.abs(c.end - end) < 1e-6);
      if (existing !== undefined && data.topics.length > 0) {
        const reusedTopics = refreshableTopics(data, start, end);
        logger().info("project", "区间已分析，复用已有结果", { videoId: video.id, start, end, topics: reusedTopics.length });
        return { videoId: video.id, outputDir: video.outputDir, topics: reusedTopics, addedLines: 0 };
      }

      /**
       * 已有主题的区间重跑（#150）：区间整段落在已分析分块里时只刷新字幕，
       * 不再调主题分析 LLM、也不新建主题——大模型对同一段内容总能划出「新」主题，
       * 真机重跑把直播 7 个主题变成 13 个、访谈 3 个变成 9 个。
       * `topics` 为空时不走这条路：视频库可能只转写完成、主题分析失败，那种区间仍需正常分析。
       */
      const spans = analyzedSpans(data.chunks);
      const refreshOnly =
        data.topics.length > 0 && spans.some((span) => span.start <= start + 1e-6 && span.end >= end - 1e-6);
      if (refreshOnly) logger().info("project", "区间已有主题，只刷新字幕", { videoId: video.id, start, end });

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
      const textAlignment = alignRangeSpeakers(previous, filler.rows);
      /**
       * 文本/时间立不了身份的局部簇，用声纹对既有说话人质心做归属（#145 r91j）：
       * ASR 把相邻两行拼成一条、或端点漂移时会证不出身份，过去按 ADR-0052 直接铸新号，
       * 真机上 7→8、3→5 的「新人」经 CAM++ 复算全是既有说话人或拼接碎片。
       * 低余弦且种子不足的簇跟随最近质心，不单独建人；只有余弦不达标且种子够的才允许新人。
       */
      const voice = await alignRangeByVoiceprint({
        existing: previous,
        incoming: filler.rows,
        alignment: textAlignment,
        mediaPath,
        rangeWavPath: wavPath,
        rangeStart: start,
        cacheDir,
        modelDir,
        ...(input.voiceprintDeps !== undefined ? { deps: input.voiceprintDeps } : {}),
        ...(input.referenceAudio !== undefined ? { referenceAudio: input.referenceAudio } : {}),
      });
      const alignment = voice.alignment;
      logger().info("asr", "区间说话人对齐", {
        videoId: video.id,
        start,
        end,
        localSpeakers: new Set(filler.rows.map((u) => u.speakerId)).size,
        aligned: [...alignment].map(([local, stable]) => `${local}→${stable}`),
        textAligned: [...textAlignment].map(([local, stable]) => `${local}→${stable}`),
        references: voice.references,
        voiceprint: voiceprintTable(voice.decisions),
      });
      // 复用视频库字幕时这段区间可能已经整段转写过：只追加真正新增的行，已有行与 line id 保持不变
      const dedupedRange = dropCoveredDuplicates(previous, filler.rows, undefined, alignment);
      /**
       * 证明不了的局部编号不能直接落盘：它的 `speaker-1` 可能正是整段里的另一个人。
       * 与既有编号撞车时另铸新号，字幕与弹窗里才不会把两个人显示成同一个名字。
       */
      const taken = new Set<string>(data.transcript.speakers.map((s) => s.id));
      // 旧字幕行里出现过的编号同样占位：说话人表可能缺记录，铸号不能撞上它
      for (const u of previous) taken.add(u.speakerId);
      const { rows: appended, minted } = assignStableSpeakerIds(dedupedRange, alignment, taken);
      const utterances = [...previous, ...appended].sort((a, b) => a.start - b.start || a.end - b.end);
      // 只在剩下的行里还出现的说话人才登记：整段被映射走的局部编号（先前的 speaker-1）不该留个空壳
      const usedSpeakers = new Set(appended.map((u) => u.speakerId));
      const mintedSpeakers: Speaker[] = [...minted].map(([local, fresh]) => ({
        id: fresh as Speaker["id"],
        name: `说话人${fresh.slice("speaker-".length)}`,
        color: run.transcript.speakers.find((s) => s.id === local)?.color ?? "#6aa9ff",
      }));
      const speakers = mergeSpeakers(data.transcript.speakers, [
        ...run.transcript.speakers.filter((s) => usedSpeakers.has(s.id)),
        ...mintedSpeakers,
      ]);
      /**
       * 重跑也是这次区间的一次落盘记录：控制器按项目任务边界推进「已处理」时长，
       * 重启后 `slicedSecondsFrom` 只认 `chunks`，不记这一段就会退回上一个更大的分块起点（#150 评审 P2）。
       */
      const chunk = { index: data.chunks.length + 1, start, end };
      data.chunks = [...data.chunks.filter((c) => !(Math.abs(c.start - start) < 1e-6 && Math.abs(c.end - end) < 1e-6)), chunk].sort(
        (a, b) => a.start - b.start,
      );
      data.asrModel = run.modelId;
      data.asrEngine = run.engine;

      /**
       * 已有主题的区间重跑（#150）：只落字幕、不调主题分析。
       * 主题记录一个都不改：待确认的按当前字幕重算建议行返回，已确认 / 已切片的不返回也不再提案。
       */
      if (refreshOnly) {
        data.transcript = { speakers, utterances };
        if (data.importedAt === null) data.importedAt = new Date().toISOString();
        writeVideoData(video.outputDir, data);
        const refreshed = refreshableTopics(data, start, end);
        logger().info("project", "区间已有主题，字幕已刷新", {
          videoId: video.id,
          start,
          end,
          lines: appended.length,
          topics: refreshed.length,
          keptTopics: data.topics.length - refreshed.length,
        });
        return { videoId: video.id, outputDir: video.outputDir, topics: refreshed, addedLines: appended.length };
      }

      /**
       * 重跑没有带来任何新字幕（整段已转写过、这次转写只重复了已有内容）且视频已有主题：
       * 不再跑主题分析。否则同一段内容会多出一张近同主题卡——真机一次重跑把 7 个主题变成 15 个（#145 QA）。
       * 区间记录照常落盘，重启后按 `chunks` 复用，不会再次转写。
       * 视频还没有任何主题时**不**在这里停下：主题分析从来没成功过，必须照旧补跑（#150 评审 P2）。
       */
      if (appended.length === 0 && data.topics.length > 0) {
        data.transcript = { speakers, utterances };
        if (data.importedAt === null) data.importedAt = new Date().toISOString();
        writeVideoData(video.outputDir, data);
        const reused = refreshableTopics(data, start, end);
        logger().info("project", "区间没有新字幕，复用已有主题", {
          videoId: video.id,
          start,
          end,
          topics: reused.length,
        });
        return { videoId: video.id, outputDir: video.outputDir, topics: reused, addedLines: 0 };
      }

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
