import { extractAudio, probeVideoDurations } from "../core/audio";
import { modelDir as defaultModelDir, notesRoot as defaultNotesRoot } from "../core/config";
import { applyCorrections } from "../core/corrections";
import { loadCorrections } from "../core/corrections-io";
import { ensureDir, openVideo, videoCacheDir } from "../core/paths";
import type { LlmClient, LlmEndpoint, LlmUsage, Progress } from "../core/steps";
import type { Note, Topic, Video } from "../core/types";
import { createLlmClient, emptyUsage } from "../llm/openai";
import { generateNotes } from "./generate-notes";
import { segmentTopics } from "./segment-topics";
import { transcribeVideo } from "./transcribe";
import { cleanupStaleOutputs } from "../core/outputs";
import { acquireVideoLock } from "../core/lock";

export type ExtractInput = {
  videoPath: string;
  /** 必填：由 CLI 边界（env + .env + 模型发现）解析好传入。 */
  endpoint: LlmEndpoint;
  /** 只处理视频前 N 秒。 */
  limitSeconds?: number;
  notesRoot?: string;
  modelDir?: string;
  client?: LlmClient;
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

  const { duration } = await probeVideoDurations(input.videoPath);
  const video = openVideo(input.videoPath, duration, notesRoot);
  const cacheDir = ensureDir(videoCacheDir(video.outputDir));
  // 锁在 cacheDir 创建后获取，获取失败原样抛给调用方；整条流水线都在锁内跑
  const lock = acquireVideoLock(video.outputDir);
  try {
    const wavPath = `${cacheDir}/audio.wav`;
    await extractAudio(video.sourcePath, wavPath, input.limitSeconds);
    timings.audio = t();

    const transcription = await transcribeVideo({
      video,
      wavPath,
      cacheDir,
      modelDir,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    });
    timings.transcribe = t();

    const corrections = loadCorrections(notesRoot, video.outputDir);
    const transcript = {
      speakers: transcription.transcript.speakers,
      utterances: applyCorrections(corrections, transcription.transcript.utterances),
    };

    const topicsStarted = performance.now();
    const { topics } = await segmentTopics({
      transcript,
      chunks: transcription.chunks,
      endpoint: input.endpoint,
      cacheDir,
      client,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    });
    timings["segment-topics"] = Math.round((performance.now() - topicsStarted) / 10) / 100;

    const notesStarted = performance.now();
    const generated = await generateNotes({
      video,
      transcript,
      topics,
      selectedTopicIds: [],
      corrections,
      endpoint: input.endpoint,
      cacheDir,
      client,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    });
    timings.notes = Math.round((performance.now() - notesStarted) / 10) / 100;
    // index.md 与全部主题目录都落盘后才清：删目录不会碰掉本次刚写的笔记
    // 清理失败只记耗时，不影响已生成的笔记与返回值
    const cleanupStarted = performance.now();
    const staleRemoved = cleanupStaleOutputs({
      outputDir: video.outputDir,
      keep: generated.topicDirs,
      cacheDir,
      noteCacheKeys: generated.noteCacheKeys,
    });
    timings.cleanup = Math.round((performance.now() - cleanupStarted) / 10) / 100;
    timings.total = Math.round((performance.now() - startedAt) / 10) / 100;

    const after = client.usage?.() ?? before;
    return {
      video,
      topics,
      notes: generated.notes,
      indexMarkdown: generated.indexMarkdown,
      timings,
      cacheHits: transcription.cacheHits,
      usage: {
        calls: after.calls - before.calls,
        promptTokens: after.promptTokens - before.promptTokens,
        completionTokens: after.completionTokens - before.completionTokens,
        totalTokens: after.totalTokens - before.totalTokens,
      },
      staleRemoved,
    };
  } finally {
    lock.release();
  }
}
