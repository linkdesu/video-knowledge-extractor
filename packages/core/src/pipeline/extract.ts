import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { probeVideo, extractAudio } from "../core/audio";
import { modelDir as defaultModelDir, notesRoot as defaultNotesRoot } from "../core/config";
import { applyCorrections } from "../core/corrections";
import { acquireVideoLock } from "../core/lock";
import { cacheDirFor, ensureDir, openVideo, slugify } from "../core/paths";
import { cleanupStaleOutputs } from "../core/outputs";
import { emptyVideoData, readVideoData, writeVideoData } from "../core/video-data";
import { settleRunWhileLocked } from "../core/edits";
import type { TopicRecord } from "../core/video-data";
import type { LlmClient, LlmEndpoint, LlmUsage, Progress } from "../core/steps";
import type { CorrectionList, Note, Topic, TopicId, Video } from "../core/types";
import { createLlmClient, emptyUsage } from "../llm/openai";
import { createAsrEngine, type AsrConfig } from "../asr/engine";
import { correctionsFor, generateAll, writeIndexFromDoc } from "./notes-run";
import { segmentTopics } from "./segment-topics";

export type ExtractInput = {
  videoPath: string;
  /** 必填：由 CLI 边界（env + .env + 模型发现）解析好传入。 */
  endpoint: LlmEndpoint;
  /** 只处理视频前 N 秒。 */
  limitSeconds?: number;
  notesRoot?: string;
  modelDir?: string;
  /** 缓存根目录；缓存落在 `<cacheRoot>/<videoId>/`（ADR-0014）。 */
  cacheRoot: string;
  client?: LlmClient;
  /** ASR 引擎配置；缺省用本地引擎（modelDir）。 */
  asr?: AsrConfig;
  /** 本次运行的 token；缺省 core 生成 randomUUID。 */
  runToken?: string;
  /** 新视频拿得到目录后的接收屏障：async，等 main 的 ACK 才继续。 */
  onPrepared?: (info: { videoId: Video["id"]; outputDir: string; runToken: string }) => Promise<void>;
  onProgress?: (p: Progress) => void;
};

export type ExtractResult = {
  video: Video;
  topics: Topic[];
  notes: Note[];
  indexMarkdown: string;
  timings: Record<string, number>;
  cacheHits: string[];
  usage: LlmUsage;
  /** 本次清掉的旧主题目录名。 */
  staleRemoved: string[];
};

export async function runExtract(input: ExtractInput): Promise<ExtractResult> {
  const notesRoot = input.notesRoot ?? defaultNotesRoot();
  const modelDir = input.modelDir ?? defaultModelDir();
  const client = input.client ?? createLlmClient(input.endpoint);
  const timings: Record<string, number> = {};
  const startedAt = performance.now();
  const t = () => Math.round((performance.now() - startedAt) / 10) / 100;
  const before = client.usage?.() ?? emptyUsage();

  const probe = await probeVideo(input.videoPath);
  const video = openVideo(input.videoPath, probe.duration, notesRoot);
  const cacheDir = ensureDir(cacheDirFor(input.cacheRoot, video.id));
  // 锁在 cacheDir 创建后获取，获取失败原样抛给调用方；整条流水线都在锁内跑
  const lock = acquireVideoLock(video.outputDir);
  // token 取锁后、写任何主题前先落盘（缺省 core 生成 randomUUID）
  const runToken = input.runToken ?? randomUUID();
  const asr = input.asr ?? { provider: "local", modelDir };
  const engine = createAsrEngine(asr);
  try {
    let data = readVideoData(video.outputDir);
    if (data === undefined) data = { ...emptyVideoData(video), runToken };
    else data.runToken = runToken;
    writeVideoData(video.outputDir, data);
    // 接收屏障：等 main 的 ACK 才继续（超时由调用方处理，不写主题）
    if (input.onPrepared !== undefined) {
      await input.onPrepared({ videoId: video.id, outputDir: video.outputDir, runToken });
    }
    const wavPath = `${cacheDir}/audio.wav`;
    await extractAudio(video.sourcePath, wavPath, input.limitSeconds);
    timings.audio = t();

    const run = await engine.run({
      video,
      wavPath,
      cacheDir,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    });
    for (const [k, v] of Object.entries(run.timings)) timings[k] = t();
    timings.transcribe = t();

    // 落 video.json：原始转写（纠错在生成/渲染时应用）+ chunks + asrModel/resolution/asrEngine（token 已在取锁后落盘）
    if (data.importedAt === null) data.importedAt = new Date().toISOString();
    data.asrModel = run.modelId;
    data.asrEngine = run.engine;
    data.resolution = probe.width !== null && probe.height !== null ? { width: probe.width, height: probe.height } : null;
    data.sourceBytes = statSync(input.videoPath).size;
    data.chunks = run.chunks;
    data.transcript = run.transcript;
    data.topics = [];
    writeVideoData(video.outputDir, data);

    const corrections: CorrectionList = correctionsFor(video.outputDir);
    const transcript = {
      speakers: run.transcript.speakers,
      utterances: applyCorrections(corrections, run.transcript.utterances),
    };

    const topicsStarted = performance.now();
    const { topics } = await segmentTopics({
      transcript,
      chunks: run.chunks,
      endpoint: input.endpoint,
      cacheDir,
      client,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    });
    timings["segment-topics"] = Math.round((performance.now() - topicsStarted) / 10) / 100;

    // 每个新主题：分配目录名，写回 video.json（queued/selected），再逐主题生成
    const used = new Set<string>();
    const records: TopicRecord[] = topics.map((x) => {
      const name = freshName(x.title, used);
      used.add(name);
      return {
        id: x.id,
        title: x.title,
        summary: x.summary,
        segments: x.segments,
        dirName: name,
        status: "queued",
        selected: true,
        keyPoints: [],
        clips: [],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      };
    });
    data.topics = records;
    writeVideoData(video.outputDir, data);

    const notesStarted = performance.now();
    const dirNameOf = (id: TopicId) => {
      const topic = data.topics.find((x) => x.id === id);
      if (topic === undefined) throw new Error(`主题 ${id} 不存在`);
      return topic.dirName;
    };
    const r = await generateAll(
      data,
      records.map((x) => x.id),
      dirNameOf,
      corrections,
      input.endpoint,
      cacheDir,
      client,
      input.onProgress,
    );
    timings.notes = Math.round((performance.now() - notesStarted) / 10) / 100;

    // index.md 与全部主题目录都落盘后才清：删目录不会碰掉本次刚写的笔记
    // 清理失败只记耗时，不影响已生成的笔记与返回值
    const cleanupStarted = performance.now();
    const staleRemoved = cleanupStaleOutputs({
      outputDir: video.outputDir,
      keep: records.map((x) => x.dirName),
      cacheDir,
      noteCacheKeys: r.cacheHits,
    });
    timings.cleanup = Math.round((performance.now() - cleanupStarted) / 10) / 100;
    timings.total = Math.round((performance.now() - startedAt) / 10) / 100;

    const after = client.usage?.() ?? before;
    return {
      video,
      topics,
      notes: r.notes,
      indexMarkdown: writeIndexFromDoc(video.outputDir),
      timings,
      cacheHits: run.cacheHits,
      usage: {
        calls: after.calls - before.calls,
        promptTokens: after.promptTokens - before.promptTokens,
        completionTokens: after.completionTokens - before.completionTokens,
        totalTokens: after.totalTokens - before.totalTokens,
      },
      staleRemoved,
    };
  } catch (err) {
    // 仍持锁时结算：只有该次运行写的主题变 failed，token 清 null，再把错误抛给调用方
    settleRunWhileLocked(video.outputDir, runToken, "本次生成未完成");
    throw err;
  } finally {
    lock.release();
  }
}

function freshName(title: string, used: Set<string>): string {
  const base = slugify(title, "topic");
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}
